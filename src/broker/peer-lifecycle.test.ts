/**
 * Peer ids and queued messages across disconnects, reloads and broker
 * restarts, for one process holding peers for several directories (OpenCode
 * 2.x). Driven against a real broker subprocess with a short grace period.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

const GRACE_MS = 3000;
const sockets: WebSocket[] = [];

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function startBroker(port: number, dbPath: string): Promise<Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "broker.ts")], {
    env: {
      ...process.env,
      CLAUDE_HIVEMIND_PORT: String(port),
      CLAUDE_HIVEMIND_DB: dbPath,
      CLAUDE_HIVEMIND_GRACE_MS: String(GRACE_MS),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {}
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error("broker did not start");
}

async function stopBroker(proc: Subprocess) {
  proc.kill();
  await proc.exited;
}

function removeDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch {}
  }
}

/** A raw peer socket that records every broker message. */
async function peerSocket(port: number, ns: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/peer?namespace=${ns}`);
  sockets.push(ws);
  const inbox: any[] = [];
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(String((e as MessageEvent).data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await Bun.sleep(5);
  };
  return {
    ws,
    inbox,
    messages: () => inbox.filter((m) => m.type === "message"),
    async register(cwd: string, extra: Record<string, unknown> = {}, pid = process.pid) {
      ws.send(JSON.stringify({ type: "register", pid, cwd, git_root: null, git_branch: null, tty: null, summary: "", namespace: ns, ...extra }));
      await until(() => inbox.some((m) => m.type === "registered"));
      return inbox.find((m) => m.type === "registered").id as string;
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((r) => ws.addEventListener("close", () => r(), { once: true }));
      ws.close();
      await closed;
    },
    until,
  };
}

async function send(port: number, to: string, text: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_id: "test", to_id: to, text }),
  });
  return (await res.json()) as { ok: boolean };
}

function rows(dbPath: string, ns: string) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.query(`SELECT id, cwd, connected FROM peers WHERE namespace = ? ORDER BY cwd`).all(ns) as { id: string; cwd: string; connected: number }[];
  db.close();
  return r;
}

function delivered(dbPath: string, text: string) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.query(`SELECT delivered FROM messages WHERE text = ?`).get(text) as { delivered: number } | null;
  db.close();
  return r?.delivered;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try { ws.close(); } catch {}
  }
});

describe("peer lifecycle (live broker)", () => {
  let port: number;
  let dbPath: string;
  let broker: Subprocess;

  beforeAll(async () => {
    port = await freePort();
    dbPath = join(tmpdir(), `hivemind-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    broker = await startBroker(port, dbPath);
  });

  afterAll(async () => {
    await stopBroker(broker);
    removeDb(dbPath);
  });

  test("H6: two directories with one basename keep their ids across a reload in either order; queued messages reach their own directory", async () => {
    const ns = "h6";
    const a1 = await peerSocket(port, ns);
    const b1 = await peerSocket(port, ns);
    const idA = await a1.register("/tmp/hm-h6-x/app");
    const idB = await b1.register("/tmp/hm-h6-y/app");
    expect(idA).not.toBe(idB);

    await a1.close();
    await b1.close();
    await Bun.sleep(50);
    expect((await send(port, idA, "FOR-A")).ok).toBe(true);

    // A new directory in the same process does not take an id that is
    // expected back.
    const z = await peerSocket(port, ns);
    const idZ = await z.register("/tmp/hm-h6-z/app");
    expect([idA, idB]).not.toContain(idZ);

    // B comes back first.
    const b2 = await peerSocket(port, ns);
    const a2 = await peerSocket(port, ns);
    expect(await b2.register("/tmp/hm-h6-y/app")).toBe(idB);
    expect(await a2.register("/tmp/hm-h6-x/app")).toBe(idA);
    await a2.until(() => a2.messages().length > 0);
    await Bun.sleep(100);
    expect(a2.messages().map((m) => m.text)).toEqual(["FOR-A"]);
    expect(b2.messages()).toEqual([]);
  });

  test("H6: a directory re-registering while its old socket is still open keeps its id, and the old socket's close leaves the new row alone", async () => {
    const ns = "h6-overlap";
    const s1 = await peerSocket(port, ns);
    const id = await s1.register("/tmp/hm-h6-overlap/svc");
    const s2 = await peerSocket(port, ns);
    expect(await s2.register("/tmp/hm-h6-overlap/svc")).toBe(id);

    // The old socket closes after the new registration took the id.
    await s1.close();
    await Bun.sleep(GRACE_MS + 300);
    expect(rows(dbPath, ns)).toEqual([{ id, cwd: "/tmp/hm-h6-overlap/svc", connected: 1 }]);
    expect((await send(port, id, "to-new")).ok).toBe(true);
    await s2.until(() => s2.messages().length > 0);
    expect(s2.messages().map((m) => m.text)).toEqual(["to-new"]);
  });

  test("H2: an acking peer's message stays undelivered until acked and is resent on re-registration; other peers are marked delivered on send", async () => {
    const ns = "h2";
    const cwd = "/tmp/hm-h2/oc";
    const p1 = await peerSocket(port, ns);
    const id = await p1.register(cwd, { ack: true, agent_type: "opencode" });
    await send(port, id, "held-1");
    await p1.until(() => p1.messages().length > 0);
    const first = p1.messages()[0];
    expect(first.text).toBe("held-1");
    expect(delivered(dbPath, "held-1")).toBe(0);
    expect(typeof first.message_id).toBe("number");

    // Stopped without an ack: the next registration gets it again.
    await p1.close();
    const p2 = await peerSocket(port, ns);
    expect(await p2.register(cwd, { ack: true, agent_type: "opencode" })).toBe(id);
    await p2.until(() => p2.messages().length > 0);
    expect(p2.messages().map((m) => [m.text, m.message_id])).toEqual([["held-1", first.message_id]]);
    expect(delivered(dbPath, "held-1")).toBe(0);

    // Acked: delivered, and not resent.
    p2.ws.send(JSON.stringify({ type: "ack", message_id: first.message_id }));
    await p2.until(() => delivered(dbPath, "held-1") === 1);
    expect(delivered(dbPath, "held-1")).toBe(1);
    await p2.close();
    const p3 = await peerSocket(port, ns);
    await p3.register(cwd, { ack: true, agent_type: "opencode" });
    await Bun.sleep(150);
    expect(p3.messages()).toEqual([]);

    // A peer that does not ack (Claude Code's MCP server) is unchanged.
    const cc = await peerSocket(port, ns);
    const ccId = await cc.register("/tmp/hm-h2/cc");
    await send(port, ccId, "cc-1");
    await cc.until(() => cc.messages().length > 0);
    expect(cc.messages()[0].message_id).toBeUndefined();
    expect(delivered(dbPath, "cc-1")).toBe(1);

    // A peer cannot ack another peer's message.
    await send(port, id, "held-2");
    await p3.until(() => p3.messages().length > 0);
    cc.ws.send(JSON.stringify({ type: "ack", message_id: p3.messages()[0].message_id }));
    await Bun.sleep(100);
    expect(delivered(dbPath, "held-2")).toBe(0);
  });
});

describe("broker restart (live broker)", () => {
  test("H5: a directory that disconnected just before a broker restart leaves no ghost row, though its process lives on", async () => {
    const port = await freePort();
    const dbPath = join(tmpdir(), `hivemind-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    let broker = await startBroker(port, dbPath);
    try {
      const ns = "h5";
      const a = await peerSocket(port, ns);
      const b = await peerSocket(port, ns);
      await a.register("/tmp/hm-h5/dir-a");
      await b.register("/tmp/hm-h5/dir-b");
      // The grace period counts from the disconnect, not the registration.
      await Bun.sleep(GRACE_MS + 200);
      await a.close();
      await Bun.sleep(50);

      // Restart inside the grace period: its timer dies with the broker.
      await stopBroker(broker);
      broker = await startBroker(port, dbPath);
      const b2 = await peerSocket(port, ns);
      await b2.register("/tmp/hm-h5/dir-b");
      expect(rows(dbPath, ns).map((r) => r.cwd)).toEqual(["/tmp/hm-h5/dir-a", "/tmp/hm-h5/dir-b"]);

      await Bun.sleep(GRACE_MS * 2 + 500);
      expect(rows(dbPath, ns).map((r) => r.cwd)).toEqual(["/tmp/hm-h5/dir-b"]);
      b2.ws.send(JSON.stringify({ type: "list_peers", scope: "namespace" }));
      await b2.until(() => b2.inbox.some((m) => m.type === "peers"));
      expect(b2.inbox.find((m) => m.type === "peers").peers).toEqual([]);
    } finally {
      await stopBroker(broker);
      removeDb(dbPath);
    }
  }, 30_000);
});
