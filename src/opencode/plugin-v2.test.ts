import { describe, test, expect, afterEach } from "bun:test";
import plugin from "./plugin.ts";

/** A fake broker that records registrations and lets a test push messages to the peer. */
function fakeBroker() {
  const registers: any[] = [];
  let peerWs: any = null;
  const srv = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data));
        if (msg.type === "register") {
          registers.push(msg);
          peerWs = ws;
          ws.send(JSON.stringify({ type: "registered", id: "oc2", namespace: "default" }));
        }
      },
    },
  });
  return {
    port: srv.port,
    registers,
    async push(text: string) {
      const deadline = Date.now() + 2000;
      while (!peerWs && Date.now() < deadline) await Bun.sleep(5);
      peerWs.send(JSON.stringify({ type: "message", from_id: "huginn", from_summary: "", from_cwd: "", text, sent_at: "t" }));
    },
    stop: () => srv.stop(true),
  };
}

/** The slice of OpenCode 2.x's plugin context the plugin uses, recorded. */
function fakeV2Ctx(directory = "/tmp") {
  const hooks: Record<string, (e: any) => unknown> = {};
  const tools: any[] = [];
  const prompts: any[] = [];
  const disposed: string[] = [];
  const parents = new Map<string, string>();
  let emit: ((e: any) => void) | null = null;
  let streamSignal: AbortSignal | undefined;
  const ctx = {
    app: { name: "opencode", version: "2.4.2", channel: "latest" },
    location: { directory },
    tool: {
      async transform(cb: (editor: any) => void) {
        cb({ add: (t: any) => tools.push(t) });
        return { dispose: async () => void disposed.push("tool") };
      },
    },
    session: {
      async hook(name: string, cb: (e: any) => unknown) {
        hooks[name] = cb;
        return { dispose: async () => void disposed.push(name) };
      },
      async get({ sessionID }: { sessionID: string }) {
        const parentID = parents.get(sessionID);
        return { id: sessionID, ...(parentID ? { parentID } : {}), location: { directory } };
      },
      async prompt(input: any) {
        prompts.push(input);
        // 2.x runs the prompt hook for prompts a plugin sends, too.
        await hooks.prompt?.({ sessionID: input.sessionID, prompt: { text: input.text }, delivery: input.delivery });
        return { id: "msg", sessionID: input.sessionID };
      },
    },
    event: {
      subscribe({ signal }: { types?: string[]; signal?: AbortSignal } = {}) {
        streamSignal = signal;
        const queue: any[] = [];
        let wake: (() => void) | null = null;
        emit = (e) => {
          queue.push(e);
          wake?.();
        };
        return {
          async *[Symbol.asyncIterator]() {
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
          },
        };
      },
    },
  };
  return {
    ctx: ctx as any,
    hooks,
    tools,
    prompts,
    disposed,
    parents,
    emit: (e: any) => emit?.(e),
    get streamAborted() {
      return streamSignal?.aborted ?? false;
    },
  };
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

  test("is inert without CLAUDE_HIVEMIND", async () => {
    delete process.env.CLAUDE_HIVEMIND;
    const f = fakeV2Ctx();
    expect(await plugin.setup(f.ctx)).toBeUndefined();
    expect(f.tools).toHaveLength(0);
    expect(Object.keys(f.hooks)).toHaveLength(0);
  });

  test("1.19's reduced context: returns without throwing and registers no peer, so server() still can", async () => {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);

    expect(await plugin.setup(reducedV1Ctx())).toBeUndefined();
    await Bun.sleep(50);
    expect(broker.registers).toHaveLength(0);

    // 1.19 calls server() as well (in either order); that call owns the peer.
    const hooks = await plugin.server({ client: { app: { log: async () => ({}) }, session: {} }, directory: "/tmp" } as any);
    cleanups.push(() => hooks.dispose?.());
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(4);
    await until(() => broker.registers.length > 0);
    expect(broker.registers).toHaveLength(1);

    // And a setup() after server() is also inert.
    expect(await plugin.setup(reducedV1Ctx())).toBeUndefined();
    expect(await plugin.setup(fakeV2Ctx().ctx)).toBeUndefined();
    await Bun.sleep(50);
    expect(broker.registers).toHaveLength(1);
  });

  test("registers one peer with the plugin's location as cwd, the four tools as JSON Schema, and the hooks", async () => {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    const f = fakeV2Ctx("/tmp");
    const cleanup = await plugin.setup(f.ctx);
    cleanups.push(() => cleanup?.());
    expect(typeof cleanup).toBe("function");

    // A second load in the same process is inert.
    const g = fakeV2Ctx();
    expect(await plugin.setup(g.ctx)).toBeUndefined();
    expect(g.tools).toHaveLength(0);

    await until(() => broker.registers.length > 0);
    expect(broker.registers).toHaveLength(1);
    expect(broker.registers[0].cwd).toBe("/tmp");
    expect(broker.registers[0].agent_type).toBe("opencode");

    expect(f.tools.map((t) => t.name).sort()).toEqual([
      "hivemind_list_peers",
      "hivemind_register_service",
      "hivemind_send_message",
      "hivemind_set_summary",
    ]);
    const send = f.tools.find((t) => t.name === "hivemind_send_message");
    expect(send.input.type).toBe("object");
    expect(send.input.required.sort()).toEqual(["message", "to"]);
    expect(send.input.$schema).toBeUndefined();
    expect(Object.keys(f.hooks).sort()).toEqual(["context", "prompt"]);

    await until(() => f.tools.length > 0);
    const summary = f.tools.find((t) => t.name === "hivemind_set_summary");
    await Bun.sleep(20);
    expect((await summary.execute({ summary: "porting" }, {})).content).toBe('Summary updated: "porting"');
    expect((await summary.execute({}, {})).content).toContain("Invalid arguments for hivemind_set_summary");
  });

  test("the context hook adds the instructions to root sessions only", async () => {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    const f = fakeV2Ctx();
    const cleanup = await plugin.setup(f.ctx);
    cleanups.push(() => cleanup?.());

    f.emit({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_root" } });
    await Bun.sleep(10);
    const root = { sessionID: "ses_root", system: [] as any[] };
    const child = { sessionID: "ses_child", system: [] as any[] };
    await f.hooks.context!(root);
    await f.hooks.context!(child);
    expect(root.system).toHaveLength(1);
    expect(root.system[0].type).toBe("text");
    expect(root.system[0].text).toContain("claude-hivemind network");
    expect(child.system).toHaveLength(0);
  });

  test("a message held before any prompt is queued into the first prompted root session, the next follows", async () => {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    const f = fakeV2Ctx();
    const cleanup = await plugin.setup(f.ctx);
    cleanups.push(() => cleanup?.());

    await broker.push("early");
    await Bun.sleep(50);
    expect(f.prompts).toHaveLength(0); // no TUI calls on 2.x: it waits for a prompt

    // A subagent's prompt never becomes the target.
    f.parents.set("ses_child", "ses_root");
    await f.hooks.prompt!({ sessionID: "ses_child", prompt: { text: "sub task" }, delivery: "steer" });
    await Bun.sleep(30);
    expect(f.prompts).toHaveLength(0);

    await f.hooks.prompt!({ sessionID: "ses_root", prompt: { text: "hello" }, delivery: "steer" });
    await until(() => f.prompts.length > 0);
    await broker.push("late");
    await until(() => f.prompts.length > 1);

    expect(f.prompts.map((p) => [p.sessionID, p.delivery])).toEqual([
      ["ses_root", "queue"],
      ["ses_root", "queue"],
    ]);
    expect(f.prompts[0].text).toContain('<hivemind_message from_id="huginn">');
    expect(f.prompts[0].text).toContain("\nearly\n");
    expect(f.prompts[1].text).toContain("\nlate\n");
    expect(f.prompts[0].agent).toBeUndefined();
  });

  test("a deleted target stops receiving; cleanup disposes every hook, ends the stream and frees the slot", async () => {
    const broker = fakeBroker();
    cleanups.push(broker.stop);
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = String(broker.port);
    const f = fakeV2Ctx();
    const cleanup = await plugin.setup(f.ctx);

    await f.hooks.prompt!({ sessionID: "ses_root", prompt: { text: "hello" }, delivery: "steer" });
    await Bun.sleep(20);
    f.emit({ type: "session.deleted", data: { sessionID: "ses_root" } });
    await Bun.sleep(20);
    await broker.push("after delete");
    await Bun.sleep(50);
    expect(f.prompts).toHaveLength(0);

    await cleanup!();
    expect(f.disposed.sort()).toEqual(["context", "prompt", "tool"]);
    expect(f.streamAborted).toBe(true);

    // The slot is free again: a fresh load registers a new peer.
    const g = fakeV2Ctx();
    const again = await plugin.setup(g.ctx);
    cleanups.push(() => again?.());
    expect(g.tools).toHaveLength(4);
  });
});
