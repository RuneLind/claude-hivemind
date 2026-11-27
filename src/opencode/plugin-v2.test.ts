import { describe, test, expect, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./plugin.ts";

/** A fake broker: one socket per registered peer, each given an id from its cwd's basename. */
function fakeBroker(port = 0) {
  const registers: any[] = [];
  const sockets = new Map<string, any>();
  const unregistered: string[] = [];
  const acks: number[] = [];
  const srv = Bun.serve({
    port,
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
        } else if (msg.type === "ack") {
          acks.push(msg.message_id);
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
    acks,
    connected: () => [...sockets.keys()].sort(),
    async push(to: string, text: string, message_id?: number) {
      const deadline = Date.now() + 2000;
      while (!sockets.has(to) && Date.now() < deadline) await Bun.sleep(5);
      sockets.get(to).send(JSON.stringify({ type: "message", from_id: "huginn", from_summary: "", from_cwd: "", text, sent_at: "t", message_id }));
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
  const signals: AbortSignal[] = [];

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
        subscribe({ signal }: { types?: string[]; signal?: AbortSignal } = {}) {
          if (signal) signals.push(signal);
          const queue: any[] = [];
          let wake: (() => void) | null = null;
          const sub = (e: any) => {
            queue.push(e);
            wake?.();
          };
          subscribers.add(sub);
          return {
            async *[Symbol.asyncIterator]() {
              try {
                while (!signal?.aborted) {
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

/** The real broker in a subprocess, on a spare port with a temp DB. */
async function realBroker() {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  const dbPath = join(tmpdir(), `hm-v2-broker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const proc: Subprocess = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "broker.ts")], {
    env: { ...process.env, CLAUDE_HIVEMIND_PORT: String(port), CLAUDE_HIVEMIND_DB: dbPath },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("broker did not start");
    await Bun.sleep(50);
  }
  const query = <T>(sql: string, ...args: any[]) => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query(sql).all(...args) as T[];
    } finally {
      db.close();
    }
  };
  return {
    port,
    connectedIds: () => query<{ id: string }>(`SELECT id FROM peers WHERE connected = 1`).map((r) => r.id).sort(),
    delivered: (text: string) => query<{ delivered: number }>(`SELECT delivered FROM messages WHERE text = ?`, text)[0]?.delivered,
    send: (to: string, text: string) =>
      fetch(`http://127.0.0.1:${port}/api/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_id: "test", to_id: to, text }),
      }).then((r) => r.json() as Promise<{ ok: boolean }>),
    async stop() {
      proc.kill();
      await proc.exited;
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {}
      }
    },
  };
}

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

  test("H2: a message held before the first prompt survives an instance reload and arrives once (real broker)", async () => {
    const broker = await realBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    const server = fakeV2Server();
    const { a } = twoDirs();

    const first = await load(server, a);
    await until(() => broker.connectedIds().includes("repoa"), 5000);
    expect((await broker.send("repoa", "held-before-reload")).ok).toBe(true);
    await Bun.sleep(200);
    expect(server.prompts).toHaveLength(0);

    await first.cleanup!();
    const second = await load(server, a);
    await until(() => broker.connectedIds().includes("repoa"), 5000);
    await Bun.sleep(200);
    server.create("ses_a", a);
    await server.prompt("ses_a", "hello");
    await until(() => server.prompts.length > 0);
    await Bun.sleep(200);
    expect(server.prompts.filter((p) => p.text.includes("held-before-reload"))).toHaveLength(1);
    await until(() => broker.delivered("held-before-reload") === 1);
    expect(broker.delivered("held-before-reload")).toBe(1);

    // Handed on and acked: the next reload does not bring it back.
    await second.cleanup!();
    await load(server, a);
    await until(() => broker.connectedIds().includes("repoa"), 5000);
    await server.prompt("ses_a", "again");
    await Bun.sleep(300);
    expect(server.prompts.filter((p) => p.text.includes("held-before-reload"))).toHaveLength(1);
  }, 20_000);

  test("H2: an ack the broker could not take is handed to the next instance of the directory, and its resend is not delivered twice", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const first = await load(server, a);
    await until(() => broker.connected().length === 1);
    server.create("ses_a", a);
    await broker.push("repoa", "m7", 7);
    await Bun.sleep(30);

    // The broker goes away; the message is then put into the session.
    broker.stop();
    await Bun.sleep(30);
    await server.prompt("ses_a", "hello");
    await until(() => server.prompts.length > 0);
    expect(server.prompts.filter((p) => p.text.includes("\nm7\n"))).toHaveLength(1);
    await first.cleanup!();

    const broker2 = fakeBroker(broker.port);
    cleanups.push(broker2.stop);
    await load(server, a);
    await until(() => broker2.acks.length > 0);
    expect(broker2.acks).toEqual([7]);
    await broker2.push("repoa", "m7", 7);
    await until(() => broker2.acks.length > 1);
    expect(broker2.acks).toEqual([7, 7]);
    await server.prompt("ses_a", "again");
    await Bun.sleep(50);
    expect(server.prompts.filter((p) => p.text.includes("\nm7\n"))).toHaveLength(1);
  });

  test("H2: a message resent while its prompt is still in flight is not delivered twice", async () => {
    const broker = withBroker();
    const server = fakeV2Server();
    const { a } = twoDirs();
    const { ctx } = server.ctxFor(a);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const prompt = ctx.session.prompt;
    ctx.session.prompt = async (input: any) => {
      await gate;
      return prompt(input);
    };
    const cleanup = await plugin.setup(ctx);
    cleanups.push(() => cleanup?.());
    await until(() => broker.connected().length === 1);
    server.create("ses_a", a);
    await server.prompt("ses_a", "hello");
    await Bun.sleep(20);

    await broker.push("repoa", "m9", 9);
    await Bun.sleep(20);
    // The broker resends it (a re-registration) before the prompt returns.
    await broker.push("repoa", "m9", 9);
    await Bun.sleep(20);
    release();
    await until(() => broker.acks.length > 0);
    await Bun.sleep(50);
    expect(server.prompts.filter((p) => p.text.includes("\nm9\n"))).toHaveLength(1);
    expect(broker.acks).toEqual([9]);
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
});
