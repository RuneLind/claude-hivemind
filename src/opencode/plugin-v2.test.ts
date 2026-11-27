import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./plugin.ts";

/** A fake broker: one socket per registered peer, each given an id from its cwd's basename. */
function fakeBroker() {
  const registers: any[] = [];
  const sockets = new Map<string, any>();
  const unregistered: string[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req, { data: { id: "" } } as any)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws: any, data) {
        const msg = JSON.parse(String(data));
        if (msg.type === "register") {
          registers.push(msg);
          const id = String(msg.cwd).split("/").pop()!;
          ws.data.id = id;
          sockets.set(id, ws);
          ws.send(JSON.stringify({ type: "registered", id, namespace: "default" }));
        }
      },
      close(ws: any) {
        if (ws.data.id) {
          unregistered.push(ws.data.id);
          if (sockets.get(ws.data.id) === ws) sockets.delete(ws.data.id);
        }
      },
    },
  });
  return {
    port: srv.port,
    registers,
    unregistered,
    connected: () => [...sockets.keys()].sort(),
    async push(to: string, text: string) {
      const deadline = Date.now() + 2000;
      while (!sockets.has(to) && Date.now() < deadline) await Bun.sleep(5);
      sockets.get(to).send(JSON.stringify({ type: "message", from_id: "huginn", from_summary: "", from_cwd: "", text, sent_at: "t" }));
    },
    stop: () => srv.stop(true),
  };
}

type Hook = (e: any) => unknown;

/**
 * One OpenCode 2.x server holding several plugin instances (one per
 * directory). Worst case on purpose: the event bus and every hook reach every
 * instance, so an instance must filter by its own directory itself.
 */
function fakeV2Server() {
  const sessions = new Map<string, { directory: string; parentID?: string }>();
  const instances: { directory: string; hooks: Record<string, Hook>; tools: any[]; disposed: string[] }[] = [];
  const prompts: any[] = [];
  const subscribers = new Set<(e: any) => void>();
  const enders = new Map<(e: any) => void, (how: "done" | "throw") => void>();
  const signals: AbortSignal[] = [];
  let getGate: Promise<void> | null = null;
  let gets = 0;

  function ctxFor(directory: string) {
    const inst = { directory, hooks: {} as Record<string, Hook>, tools: [] as any[], disposed: [] as string[] };
    instances.push(inst);
    const ctx = {
      app: { name: "opencode", version: "2.4.2", channel: "latest" },
      location: { directory },
      tool: {
        async transform(cb: (editor: any) => void) {
          cb({ add: (t: any) => inst.tools.push(t) });
          return { dispose: async () => void inst.disposed.push("tool") };
        },
      },
      session: {
        async hook(name: string, cb: Hook) {
          inst.hooks[name] = cb;
          return {
            dispose: async () => {
              delete inst.hooks[name];
              inst.disposed.push(name);
            },
          };
        },
        async get({ sessionID }: { sessionID: string }) {
          gets++;
          if (getGate) await getGate;
          const s = sessions.get(sessionID);
          if (!s) throw new Error(`no session ${sessionID}`);
          return { id: sessionID, ...(s.parentID ? { parentID: s.parentID } : {}), location: { directory: s.directory } };
        },
        async prompt(input: any) {
          prompts.push({ ...input, via: directory });
          // 2.x runs the prompt hook for prompts a plugin sends, too.
          await server.prompt(input.sessionID, input.text);
          return { id: "msg", sessionID: input.sessionID };
        },
      },
      event: {
        subscribe({ types, signal }: { types?: string[]; signal?: AbortSignal } = {}) {
          if (signal) signals.push(signal);
          const queue: any[] = [];
          let wake: (() => void) | null = null;
          let ended: "done" | "throw" | null = null;
          const sub = (e: any) => {
            if (types && !types.includes(e.type)) return;
            queue.push(e);
            wake?.();
          };
          enders.set(sub, (how) => {
            ended = how;
            wake?.();
          });
          subscribers.add(sub);
          return {
            async *[Symbol.asyncIterator]() {
              try {
                while (!signal?.aborted) {
                  // @opencode/client's shared stream ends every subscriber when its transport does.
                  if (ended === "throw") throw new Error("transport closed");
                  if (ended === "done") return;
                  if (queue.length === 0) {
                    await new Promise<void>((r) => {
                      wake = r;
                      signal?.addEventListener("abort", () => r(), { once: true });
                    });
                    wake = null;
                    continue;
                  }
                  yield queue.shift();
                }
              } finally {
                subscribers.delete(sub);
                enders.delete(sub);
              }
            },
          };
        },
      },
    };
    return { ctx: ctx as any, inst };
  }

  const server = {
    sessions,
    instances,
    prompts,
    ctxFor,
    get streamsAborted() {
      return signals.length > 0 && signals.every((s) => s.aborted);
    },
    create(sessionID: string, directory: string, parentID?: string) {
      sessions.set(sessionID, { directory, parentID });
      for (const s of subscribers) s({ type: "session.created", data: { sessionID, parentID, location: { directory } } });
    },
    /** v2's SessionDomain.move: the session's directory changes, and session.moved reports it. */
    move(sessionID: string, directory: string) {
      server.moveHeld(sessionID, directory)();
    },
    /**
     * The move is committed now; its session.moved reaches subscribers only when
     * the returned function runs (the event stream is a transport, the prompt
     * hook is in-process, so a prompt can overtake the event).
     */
    moveHeld(sessionID: string, directory: string) {
      const s = sessions.get(sessionID)!;
      s.directory = directory;
      return () => server.emit({ type: "session.moved", data: { sessionID, location: { directory }, projectID: "prj" } });
    },
    emit(e: any) {
      for (const sub of subscribers) sub(e);
    },
    get subscriberCount() {
      return subscribers.size;
    },
    get gets() {
      return gets;
    },
    /** session.get waits until the returned function runs. */
    holdGets() {
      let open = () => {};
      getGate = new Promise<void>((r) => (open = r));
      return () => {
        getGate = null;
        open();
      };
    },
    /** Every current subscription ends, normally or by throwing. */
    endStreams(how: "done" | "throw") {
      for (const end of enders.values()) end(how);
    },
    remove(sessionID: string) {
      sessions.delete(sessionID);
      for (const s of subscribers) s({ type: "session.deleted", data: { sessionID } });
    },
    async prompt(sessionID: string, text: string) {
      for (const i of instances) await i.hooks.prompt?.({ sessionID, prompt: { text }, delivery: "steer" });
    },
    /** The system parts every instance's context hook adds for one request. */
    async context(sessionID: string) {
      const event = { sessionID, system: [] as any[] };
      for (const i of instances) await i.hooks.context?.(event);
      return event.system;
    },
  };
  return server;
}

/** OpenCode 1.19 calls setup() with this context: no tool, session or event domain. */
const reducedV1Ctx = () =>
  ({
    options: {},
    agent: {},
    aisdk: {},
    catalog: {},
    command: {},
    integration: {},
    plugin: {},
    reference: {},
    skill: {},
  }) as any;

const until = async (cond: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(5);
};

/** Two directories whose basenames the fake broker turns into peer ids. */
function twoDirs() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hm-v2-")));
  return { a: join(root, "repoa"), b: join(root, "repob") };
}

describe("opencode plugin setup() (OpenCode 2.x entry)", () => {
  const saved = process.env.CLAUDE_HIVEMIND;
  const savedPort = process.env.CLAUDE_HIVEMIND_PORT;
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    if (saved === undefined) delete process.env.CLAUDE_HIVEMIND;
    else process.env.CLAUDE_HIVEMIND = saved;
    if (savedPort === undefined) delete process.env.CLAUDE_HIVEMIND_PORT;
    else process.env.CLAUDE_HIVEMIND_PORT = savedPort;
  });

  function withBroker() {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    return broker;
  }

  async function load(server: ReturnType<typeof fakeV2Server>, directory: string) {
    const { ctx, inst } = server.ctxFor(directory);
    const cleanup = await plugin.setup(ctx);
    let done = false;
    const once = async () => {
      if (done) return;
      done = true;
      await cleanup?.();
    };
    cleanups.push(once);
    return { cleanup: cleanup ? once : undefined, inst };
  }

  test("is inert without CLAUDE_HIVEMIND", async () => {
    delete process.env.CLAUDE_HIVEMIND;
    const { ctx, inst } = fakeV2Server().ctxFor("/tmp");
    expect(await plugin.setup(ctx)).toBeUndefined();
    expect(inst.tools).toHaveLength(0);
    expect(Object.keys(inst.hooks)).toHaveLength(0);
  });

  test("1.19's reduced context registers nothing, before or after server(); server() keeps one peer per process", async () => {
    const broker = withBroker();

    expect(await plugin.setup(reducedV1Ctx())).toBeUndefined();
    await Bun.sleep(50);
    expect(broker.registers).toHaveLength(0);

    // 1.19 calls server() as well (in either order); that call owns the peer.
    const input = { client: { app: { log: async () => ({}) }, session: {} }, directory: "/tmp" } as any;
    const hooks = await plugin.server(input);
    cleanups.push(() => hooks.dispose?.());
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(4);
    await until(() => broker.registers.length > 0);

    // The 1.19 TUI with --port calls server() a second time: the guard absorbs it.
    expect(await plugin.server(input)).toEqual({});
    expect(await plugin.setup(reducedV1Ctx())).toBeUndefined();
    await Bun.sleep(50);
    expect(broker.registers).toHaveLength(1);
  });

  test("two instances with different directories each register their own peer, tools and hooks", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const ia = await load(server, a);
    const ib = await load(server, b);
    expect(typeof ia.cleanup).toBe("function");
    expect(typeof ib.cleanup).toBe("function");

    await until(() => broker.registers.length >= 2);
    expect(broker.registers.map((r) => r.cwd).sort()).toEqual([a, b]);
    expect(broker.registers.every((r) => r.agent_type === "opencode" && r.pid === process.pid)).toBe(true);

    for (const { inst } of [ia, ib]) {
      expect(inst.tools.map((t) => t.name).sort()).toEqual([
        "hivemind_list_peers",
        "hivemind_register_service",
        "hivemind_send_message",
        "hivemind_set_summary",
      ]);
      expect(Object.keys(inst.hooks).sort()).toEqual(["context", "prompt"]);
    }
    const send = ia.inst.tools.find((t) => t.name === "hivemind_send_message");
    expect(send.input.type).toBe("object");
    expect(send.input.required.sort()).toEqual(["message", "to"]);
    expect(send.input.$schema).toBeUndefined();
  });

  test("each instance routes only its own directory's sessions: target, inbox, instructions and tools", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const ia = await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);

    server.create("ses_a", a);
    server.create("ses_b", b);
    // A session created before the plugin loaded is resolved by session.get.
    server.sessions.set("ses_b_old", { directory: b });
    await Bun.sleep(10);

    // Messages held before any prompt wait in each instance's own inbox.
    await broker.push("repoa", "for a");
    await broker.push("repob", "for b");
    await Bun.sleep(50);
    expect(server.prompts).toHaveLength(0);

    // Every prompt reaches both instances' hooks; only the owner takes it.
    await server.prompt("ses_b_old", "hello b");
    await until(() => server.prompts.length >= 1);
    await server.prompt("ses_a", "hello a");
    await until(() => server.prompts.length >= 2);
    await Bun.sleep(30);
    expect(server.prompts.map((p) => [p.sessionID, p.via, p.delivery]).sort()).toEqual([
      ["ses_a", a, "queue"],
      ["ses_b_old", b, "queue"],
    ]);
    expect(server.prompts.find((p) => p.sessionID === "ses_a").text).toContain("\nfor a\n");
    expect(server.prompts.find((p) => p.sessionID === "ses_b_old").text).toContain("\nfor b\n");

    // A prompt in b's other session moves b's target, never a's.
    await server.prompt("ses_b", "switch");
    await Bun.sleep(30);
    server.prompts.length = 0;
    await broker.push("repoa", "a again");
    await broker.push("repob", "b again");
    await until(() => server.prompts.length >= 2);
    expect(server.prompts.map((p) => [p.sessionID, p.via]).sort()).toEqual([
      ["ses_a", a],
      ["ses_b", b],
    ]);

    // Instructions: one set per request, from the session's own instance.
    const sysA = await server.context("ses_a");
    const sysB = await server.context("ses_b_old");
    expect(sysA).toHaveLength(1);
    expect(sysB).toHaveLength(1);
    expect(sysA[0].text).toContain('as peer "repoa"');
    expect(sysB[0].text).toContain('as peer "repob"');

    // Tools refuse a session from another directory.
    const setA = ia.inst.tools.find((t) => t.name === "hivemind_set_summary");
    expect((await setA.execute({ summary: "x" }, { sessionID: "ses_b" })).content).toContain("not in this hivemind peer's directory");
    expect((await setA.execute({ summary: "porting" }, { sessionID: "ses_a" })).content).toBe('Summary updated: "porting"');
    expect((await setA.execute({}, { sessionID: "ses_a" })).content).toContain("Invalid arguments for hivemind_set_summary");

    // Deleting b's target does not touch a's.
    server.remove("ses_b");
    await Bun.sleep(20);
    server.prompts.length = 0;
    await broker.push("repoa", "a still");
    await broker.push("repob", "b held");
    await until(() => server.prompts.length >= 1);
    await Bun.sleep(50);
    expect(server.prompts.map((p) => p.sessionID)).toEqual(["ses_a"]);
  });

  test("the context hook adds the instructions to root sessions only", async () => {
    withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    await load(server, a);

    server.create("ses_root", a);
    server.create("ses_child", a, "ses_root");
    await Bun.sleep(10);
    const root = await server.context("ses_root");
    expect(root).toHaveLength(1);
    expect(root[0].type).toBe("text");
    expect(root[0].text).toContain("claude-hivemind network");
    expect(await server.context("ses_child")).toHaveLength(0);
  });

  test("H3: a child known only to session.get gets no instructions, even while the inbox's own lookup is in flight", async () => {
    withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const { ctx } = server.ctxFor(a);
    // The first lookup (ownership) answers at once; later ones (the inbox's
    // root check from the unawaited prompt hook) are still in flight.
    const get = ctx.session.get;
    let calls = 0;
    ctx.session.get = async (input: any) => {
      if (calls++ > 0) await Bun.sleep(300);
      return get(input);
    };
    const cleanup = await plugin.setup(ctx);
    cleanups.push(() => cleanup?.());

    server.sessions.set("ses_root", { directory: a });
    server.sessions.set("ses_child", { directory: a, parentID: "ses_root" });
    await server.prompt("ses_child", "sub task");
    expect(await server.context("ses_child")).toHaveLength(0);
    expect(await server.context("ses_root")).toHaveLength(1);
  });

  test("H1: a moved session is released by its old directory's instance and claimed by the new one", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);

    server.create("ses_x", a);
    await server.prompt("ses_x", "hello");
    await Bun.sleep(30);
    expect((await server.context("ses_x"))[0].text).toContain('as peer "repoa"');

    server.move("ses_x", b);
    await Bun.sleep(20);
    const sys = await server.context("ses_x");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('as peer "repob"');

    // a no longer targets the moved session: a's message waits for a's next root prompt.
    await broker.push("repoa", "for a");
    await Bun.sleep(50);
    expect(server.prompts).toHaveLength(0);

    // b claims the session on its next prompt; b's message reaches it.
    await server.prompt("ses_x", "now in b");
    await broker.push("repob", "for b");
    await until(() => server.prompts.length >= 1);
    await Bun.sleep(30);
    expect(server.prompts.map((p) => [p.sessionID, p.via])).toEqual([["ses_x", b]]);
    expect(server.prompts[0].text).toContain("\nfor b\n");

    // a's held message is not lost: it goes to a's next prompted root session.
    server.create("ses_a2", a);
    await server.prompt("ses_a2", "back in a");
    await until(() => server.prompts.length >= 2);
    expect(server.prompts[1].sessionID).toBe("ses_a2");
    expect(server.prompts[1].via).toBe(a);
    expect(server.prompts[1].text).toContain("\nfor a\n");
  });

  test("H1: a session moved away while its prompt's root lookup runs does not become the old instance's target", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const { ctx } = server.ctxFor(a);
    // The ownership lookup answers at once; the inbox's root check is slow.
    const get = ctx.session.get;
    let calls = 0;
    ctx.session.get = async (input: any) => {
      if (calls++ > 0) await Bun.sleep(150);
      return get(input);
    };
    const cleanup = await plugin.setup(ctx);
    cleanups.push(() => cleanup?.());
    await until(() => broker.connected().length === 1);

    server.sessions.set("ses_x", { directory: a });
    await server.prompt("ses_x", "hello");
    await Bun.sleep(20);
    server.move("ses_x", b);
    await Bun.sleep(250);

    await broker.push("repoa", "for a");
    await Bun.sleep(50);
    expect(server.prompts).toHaveLength(0);
  });

  test("a subagent's prompt never becomes the target; held messages go to the first prompted root", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    await load(server, a);

    await broker.push("repoa", "early");
    await Bun.sleep(50);
    server.sessions.set("ses_root", { directory: a });
    server.sessions.set("ses_child", { directory: a, parentID: "ses_root" });
    await server.prompt("ses_child", "sub task");
    await Bun.sleep(30);
    expect(server.prompts).toHaveLength(0);

    await server.prompt("ses_root", "hello");
    await until(() => server.prompts.length > 0);
    await broker.push("repoa", "late");
    await until(() => server.prompts.length > 1);
    expect(server.prompts.map((p) => p.sessionID)).toEqual(["ses_root", "ses_root"]);
    expect(server.prompts[0].text).toContain('<hivemind_message from_id="huginn">');
    expect(server.prompts[0].agent).toBeUndefined();
  });

  test("cleanup unregisters only its own peer and disposes only its own hooks", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const ia = await load(server, a);
    const ib = await load(server, b);
    await until(() => broker.connected().length === 2);

    await ia.cleanup!();
    expect(ia.inst.disposed.sort()).toEqual(["context", "prompt", "tool"]);
    expect(ib.inst.disposed).toEqual([]);
    await until(() => broker.unregistered.length > 0);
    await Bun.sleep(30);
    expect(broker.unregistered).toEqual(["repoa"]);
    expect(broker.connected()).toEqual(["repob"]);

    // b still works after a is gone.
    server.create("ses_b", b);
    await server.prompt("ses_b", "hi");
    await broker.push("repob", "still here");
    await until(() => server.prompts.length > 0);
    expect(server.prompts.map((p) => [p.sessionID, p.via])).toEqual([["ses_b", b]]);

    // A reload of a registers a fresh peer for a.
    const again = await load(server, a);
    expect(again.inst.tools).toHaveLength(4);
    await until(() => broker.connected().length === 2);
    expect(broker.connected()).toEqual(["repoa", "repob"]);

    await ib.cleanup!();
    await again.cleanup!();
    await Bun.sleep(20);
    expect(server.streamsAborted).toBe(true);
  });

  test("A1: a session.moved handled after the prompt hook's ownership check, before touch, never lets the old instance send to it", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const ia = await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);
    await broker.push("repoa", "for a");
    await Bun.sleep(30);

    // Sweep the gap between the move and A's prompt hook: the moved event
    // lands at a different point of the hook's await chain for each n.
    for (let n = 0; n <= 8; n++) {
      const id = `ses_x${n}`;
      server.create(id, a);
      await Bun.sleep(10);
      server.move(id, b);
      for (let k = 0; k < n; k++) await Promise.resolve();
      ia.inst.hooks.prompt!({ sessionID: id, prompt: { text: "late" }, delivery: "steer" });
      await Bun.sleep(30);
    }
    expect(server.prompts.map((p) => [p.sessionID, p.via === a])).toEqual([]);

    // The held message still reaches A's next prompted root session.
    server.create("ses_a2", a);
    await server.prompt("ses_a2", "back in a");
    await until(() => server.prompts.length >= 1);
    expect(server.prompts.map((p) => p.sessionID)).toEqual(["ses_a2"]);
    expect(server.prompts[0].text).toContain("\nfor a\n");
  });

  test("A1: a prompt that overtakes the session.moved event neither keeps nor makes the moved session the old instance's target", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);

    server.create("ses_x", a);
    await server.prompt("ses_x", "hello");
    await Bun.sleep(20);
    await broker.push("repoa", "first");
    await until(() => server.prompts.length >= 1);
    expect(server.prompts.map((p) => [p.sessionID, p.via])).toEqual([["ses_x", a]]);
    server.prompts.length = 0;

    // Moved on the server; the event has not reached either instance yet.
    const deliver = server.moveHeld("ses_x", b);
    // A message for the still-cached target is checked at send time.
    await broker.push("repoa", "for a");
    await Bun.sleep(60);
    expect(server.prompts.filter((p) => p.via === a)).toEqual([]);
    // A prompt in the moved session does not make it A's target again.
    await server.prompt("ses_x", "typed in b");
    await Bun.sleep(30);
    await broker.push("repoa", "for a again");
    await Bun.sleep(60);
    expect(server.prompts.filter((p) => p.via === a)).toEqual([]);

    // Once the event arrives, B claims the session on its next prompt.
    deliver();
    await Bun.sleep(20);
    await server.prompt("ses_x", "again in b");
    await broker.push("repob", "for b");
    await until(() => server.prompts.length >= 1);
    await Bun.sleep(30);
    expect(server.prompts.map((p) => [p.sessionID, p.via])).toEqual([["ses_x", b]]);
    expect(server.prompts[0].text).toContain("\nfor b\n");
  });

  test("A1: a prompt in a session moved away does not displace the old instance's own target", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);

    server.create("ses_x", a);
    server.create("ses_a", a);
    await Bun.sleep(10);
    await server.prompt("ses_x", "x first");
    await Bun.sleep(20);
    await server.prompt("ses_a", "a is the target");
    await Bun.sleep(20);

    server.moveHeld("ses_x", b);
    await server.prompt("ses_x", "typed in b");
    await Bun.sleep(30);
    await broker.push("repoa", "for a");
    await until(() => server.prompts.length >= 1);
    expect(server.prompts.map((p) => [p.sessionID, p.via])).toEqual([["ses_a", a]]);
  });

  for (const how of ["done", "throw"] as const) {
    test(`A2: after the event stream ends (${how}), the instance re-subscribes and still follows session.moved`, async () => {
      const broker = withBroker();
      const server = fakeV2Server();
      const { a, b } = twoDirs();
      await load(server, a);
      await load(server, b);
      await until(() => broker.connected().length === 2);
      await until(() => server.subscriberCount === 2);

      server.create("ses_x", a);
      await server.prompt("ses_x", "hello");
      await Bun.sleep(20);
      expect((await server.context("ses_x"))[0].text).toContain('as peer "repoa"');

      server.endStreams(how);
      await until(() => server.subscriberCount === 0, 500);
      await until(() => server.subscriberCount === 2, 3000);
      expect(server.subscriberCount).toBe(2);

      server.move("ses_x", b);
      await Bun.sleep(30);
      const sys = await server.context("ses_x");
      expect(sys).toHaveLength(1);
      expect(sys[0].text).toContain('as peer "repob"');
    });
  }

  test("A2: a move missed while the stream was down is not trusted from the cache after re-subscribing", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);
    await until(() => server.subscriberCount === 2);

    server.create("ses_x", a);
    server.create("ses_y", a);
    await server.prompt("ses_x", "hello");
    await Bun.sleep(20);
    expect((await server.context("ses_x"))[0].text).toContain('as peer "repoa"');
    expect((await server.context("ses_y"))[0].text).toContain('as peer "repoa"');

    server.endStreams("done");
    await until(() => server.subscriberCount === 0, 500);
    // Committed while nobody listens: the event is lost. Between streams the
    // cache is not trusted.
    server.move("ses_x", b);
    const gap = await server.context("ses_x");
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toContain('as peer "repob"');
    // An answer looked up between streams is not trusted after them either.
    expect((await server.context("ses_y"))[0].text).toContain('as peer "repoa"');
    server.move("ses_y", b);
    await until(() => server.subscriberCount === 2, 3000);
    server.emit({ type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } });
    await Bun.sleep(30);

    const sys = await server.context("ses_y");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('as peer "repob"');
  });

  test("R2-2: a tool call whose ownership lookup straddles a stream end is not refused as foreign", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const ia = await load(server, a);
    await until(() => broker.connected().length === 1);
    await until(() => server.subscriberCount === 1);
    // Known to the server, never announced: the tool hook has to look it up.
    server.sessions.set("ses_a", { directory: a });
    const setA = ia.inst.tools.find((t) => t.name === "hivemind_set_summary");

    const before = server.gets;
    const release = server.holdGets();
    const call = setA.execute({ summary: "porting" }, { sessionID: "ses_a" });
    await until(() => server.gets > before, 500);
    server.endStreams("done"); // the loop calls unconfirm() once the stream has ended
    await until(() => server.subscriberCount === 0, 500);
    await Bun.sleep(10);
    release();
    expect((await call).content).toBe('Summary updated: "porting"');
  });

  /**
   * Holds the current session.get and opens a new hold for the next one, in
   * one step: the lookup's next ask is made after this returns, so it waits on
   * the new hold.
   */
  async function reHold(server: ReturnType<typeof fakeV2Server>, release: () => void) {
    const before = server.gets;
    release();
    const next = server.holdGets();
    await until(() => server.gets > before, 500);
    return next;
  }

  test("K-plugin-2: a tool call in the backoff gap whose asks straddle the re-subscribe drop and the first-event drop is not refused", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const ia = await load(server, a);
    await until(() => broker.connected().length === 1);
    await until(() => server.subscriberCount === 1);
    server.sessions.set("ses_a", { directory: a });
    const setA = ia.inst.tools.find((t) => t.name === "hivemind_set_summary");

    server.endStreams("done");
    await until(() => server.subscriberCount === 0, 500);
    // In the backoff gap: the stream-end drop has already run.
    let release = server.holdGets();
    const before = server.gets;
    const call = setA.execute({ summary: "porting" }, { sessionID: "ses_a" });
    await until(() => server.gets > before, 500);
    await until(() => server.subscriberCount === 1, 3000); // re-subscribe drop
    release = await reHold(server, release);
    server.emit({ type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } }); // first-event drop
    await Bun.sleep(20);
    release();
    expect((await call).content).toBe('Summary updated: "porting"');
  });

  test("K-plugin-3: a tool call whose asks straddle the stream-end, re-subscribe and first-event drops in turn is not refused", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const ia = await load(server, a);
    await until(() => broker.connected().length === 1);
    await until(() => server.subscriberCount === 1);
    server.sessions.set("ses_a", { directory: a });
    const setA = ia.inst.tools.find((t) => t.name === "hivemind_set_summary");

    let release = server.holdGets();
    const before = server.gets;
    const call = setA.execute({ summary: "porting" }, { sessionID: "ses_a" });
    await until(() => server.gets > before, 500);
    server.endStreams("done"); // stream-end drop
    await until(() => server.subscriberCount === 0, 500);
    await Bun.sleep(10);
    release = await reHold(server, release);
    await until(() => server.subscriberCount === 1, 3000); // re-subscribe drop
    release = await reHold(server, release);
    server.emit({ type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } }); // first-event drop
    await Bun.sleep(20);
    release();
    expect((await call).content).toBe('Summary updated: "porting"');
  });

  test("K-plugin-first: an answer cached after the re-subscribe drop is dropped again at the new stream's first event", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);
    await until(() => server.subscriberCount === 2);

    server.create("ses_y", a);
    await Bun.sleep(20);
    server.endStreams("done");
    await until(() => server.subscriberCount === 0, 500);
    await until(() => server.subscriberCount === 2, 3000);
    // Looked up and cached after the re-subscribe drop, then moved before the
    // host's subscription was live, so its session.moved never arrives.
    expect((await server.context("ses_y"))[0].text).toContain('as peer "repoa"');
    server.sessions.get("ses_y")!.directory = b;
    server.emit({ type: "session.created", data: { sessionID: "ses_other", location: { directory: "/elsewhere" } } });
    await Bun.sleep(30);
    const sys = await server.context("ses_y");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('as peer "repob"');
  });

  test("R2-3: a move during the gap is not answered from the cache once the next stream is live, with no event after it", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    const ia = await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);
    await until(() => server.subscriberCount === 2);

    server.create("ses_y", a);
    await Bun.sleep(20);
    server.endStreams("done");
    await until(() => server.subscriberCount === 0, 500);
    // Looked up (and cached) between streams, then moved while nobody listens.
    expect((await server.context("ses_y"))[0].text).toContain('as peer "repoa"');
    server.move("ses_y", b);
    await until(() => server.subscriberCount === 2, 3000);
    expect(server.subscriberCount).toBe(2);
    // No event on the new streams.
    const sys = await server.context("ses_y");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('as peer "repob"');
    const setA = ia.inst.tools.find((t) => t.name === "hivemind_set_summary");
    expect((await setA.execute({ summary: "x" }, { sessionID: "ses_y" })).content).toContain("not in this hivemind peer's directory");
  });

  test("A2: an event the handler cannot read does not end the subscription", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a, b } = twoDirs();
    await load(server, a);
    await load(server, b);
    await until(() => broker.connected().length === 2);
    await until(() => server.subscriberCount === 2);

    server.create("ses_x", a);
    await Bun.sleep(20);
    server.emit({ type: "session.moved", data: null });
    await Bun.sleep(20);
    // Still the same subscriptions: none ended and re-subscribed.
    expect(server.subscriberCount).toBe(2);
    server.move("ses_x", b);
    await Bun.sleep(30);
    const sys = await server.context("ses_x");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain('as peer "repob"');
  });

  for (const where of ["ownership check", "touch"] as const) {
    test(`A7: an unload while a prompt's lookup is gated (${where}) sets no target and sends nothing`, async () => {
      const broker = withBroker();
      const server = fakeV2Server();
      const { a } = twoDirs();
      const { ctx } = server.ctxFor(a);
      const get = ctx.session.get;
      let gate = false;
      let open!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      ctx.session.get = async (input: any) => {
        if (gate) await opened;
        return get(input);
      };
      const cleanup = await plugin.setup(ctx);
      let done = false;
      const once = async () => {
        if (!done) {
          done = true;
          await cleanup?.();
        }
      };
      cleanups.push(once);
      await until(() => broker.connected().length === 1);
      await broker.push("repoa", "for a");
      await Bun.sleep(30);

      if (where === "ownership check") {
        // Unknown to the instance: the prompt hook's ownership lookup runs.
        server.sessions.set("ses_x", { directory: a });
      } else {
        // Moved here: ownership is cached, so the hook passes, but the inbox
        // has not seen the session and touch's own root lookup runs.
        server.sessions.set("ses_x", { directory: "/elsewhere" });
        server.move("ses_x", a);
        await Bun.sleep(10);
      }
      gate = true;
      await server.prompt("ses_x", "hello");
      await Bun.sleep(20);
      await once();
      open();
      await Bun.sleep(80);
      expect(server.prompts).toEqual([]);
    });
  }
});
