/**
 * Unit tests for peer ID generation (M15) and OpenCode HTTP delivery (M13).
 *
 * These exercise pure-ish broker internals against an in-memory bun:sqlite DB
 * and a stubbed globalThis.fetch, with no broker subprocess. The cmux client is
 * mocked so the surface_id delivery branch is observable without a real socket.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";

// Mock the cmux client BEFORE importing peers.ts so deliverViaCmux uses the stub.
const cmuxCalls: { kind: "text" | "key"; arg: string; surfaceId: string }[] = [];
let cmuxShouldThrow = false;
mock.module("../cmux/client.ts", () => ({
  sendText: async (text: string, surfaceId: string) => {
    if (cmuxShouldThrow) throw new Error("cmux down");
    cmuxCalls.push({ kind: "text", arg: text, surfaceId });
  },
  sendKey: async (key: string, surfaceId: string) => {
    if (cmuxShouldThrow) throw new Error("cmux down");
    cmuxCalls.push({ kind: "key", arg: key, surfaceId });
  },
}));

const {
  createPeerStatements,
  createMessageStatements,
  generateId,
  deliverOrQueue,
} = await import("./peers.ts");
const { initDatabase } = await import("./db.ts");

// --- helpers ---

function freshDb(): Database {
  // initDatabase uses a file path; an in-memory DB is created by ":memory:".
  return initDatabase(":memory:");
}

function insertPeer(
  stmts: ReturnType<typeof createPeerStatements>,
  opts: {
    id: string;
    pid?: number;
    cwd?: string;
    namespace?: string;
    agent_type?: string;
    opencode_url?: string | null;
    surface_id?: string | null;
  },
) {
  const now = new Date().toISOString();
  stmts.insertPeer.run(
    opts.id,
    opts.pid ?? process.pid,
    opts.cwd ?? `/test/${opts.id}`,
    null,
    null,
    null,
    "",
    opts.namespace ?? "default",
    opts.agent_type ?? "claude-code",
    opts.opencode_url ?? null,
    opts.surface_id ?? null,
    now,
    now,
    1,
  );
}

// --- M15: generateId ---

describe("generateId", () => {
  let db: Database;
  let stmts: ReturnType<typeof createPeerStatements>;

  beforeEach(() => {
    db = freshDb();
    stmts = createPeerStatements(db);
  });

  afterEach(() => db.close());

  test("a hyphenated name sharing a prefix does not force the base to bump", () => {
    // 'melosys-api-claude' shares the 'melosys' prefix but is a distinct
    // identity (suffix is not all-digits), so a new 'melosys' peer keeps 'melosys'.
    insertPeer(stmts, { id: "melosys-api-claude", cwd: "/src/melosys-api-claude" });
    const peerSockets = new Map<string, unknown>([["melosys-api-claude", {}]]);

    const id = generateId(stmts, peerSockets, "/src/melosys");
    expect(id).toBe("melosys");
  });

  test("a DB row absent from peerSockets is ignored", () => {
    // The 'melosys' row exists in the DB but has no live WebSocket, so the slot
    // is effectively free and the next 'melosys' peer reclaims the base id.
    insertPeer(stmts, { id: "melosys", cwd: "/src/melosys" });
    const peerSockets = new Map<string, unknown>(); // not connected

    const id = generateId(stmts, peerSockets, "/src/melosys");
    expect(id).toBe("melosys");
  });

  test("picks the lowest free numeric hole", () => {
    // 'melosys' and 'melosys-3' are live; 'melosys-2' is the lowest free slot.
    insertPeer(stmts, { id: "melosys", cwd: "/a/melosys" });
    insertPeer(stmts, { id: "melosys-3", cwd: "/b/melosys" });
    const peerSockets = new Map<string, unknown>([
      ["melosys", {}],
      ["melosys-3", {}],
    ]);

    const id = generateId(stmts, peerSockets, "/c/melosys");
    expect(id).toBe("melosys-2");
  });
});

// --- M13: OpenCode HTTP delivery via deliverOrQueue ---

describe("OpenCode HTTP delivery", () => {
  let db: Database;
  let peerStmts: ReturnType<typeof createPeerStatements>;
  let msgStmts: ReturnType<typeof createMessageStatements>;
  const realFetch = globalThis.fetch;

  // A minimal BrokerContext: no live WebSockets, so non-opencode peers queue.
  const ctx = {
    server: { publish() {} } as any,
    peerSockets: new Map<string, any>(),
  } as any;

  beforeEach(() => {
    db = freshDb();
    peerStmts = createPeerStatements(db);
    msgStmts = createMessageStatements(db);
    cmuxCalls.length = 0;
    cmuxShouldThrow = false;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    db.close();
  });

  /** Wait until a predicate holds (for the async delivery .then chain). */
  async function until(pred: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    if (!pred()) throw new Error("until() timed out");
  }

  function countDelivered(toId: string): number {
    const rows = db.query(`SELECT delivered FROM messages WHERE to_id = ?`).all(toId) as { delivered: number }[];
    return rows.filter((r) => r.delivered === 1).length;
  }

  test("selects the newest-updatedAt session and marks the row delivered", async () => {
    insertPeer(peerStmts, {
      id: "oc-1",
      agent_type: "opencode",
      opencode_url: "http://oc.test:9000",
    });

    const requested: string[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      requested.push(u);
      if (u.endsWith("/session")) {
        return new Response(
          JSON.stringify({
            sessions: [
              { id: "old", updatedAt: "2026-01-01T00:00:00Z" },
              { id: "newest", updatedAt: "2026-05-01T00:00:00Z" },
              { id: "mid", updatedAt: "2026-03-01T00:00:00Z" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // prompt_async
      return new Response("", { status: 200 });
    }) as any;

    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-1", "hello", new Date().toISOString());

    await until(() => countDelivered("oc-1") === 1);
    // The prompt was POSTed to the newest session id.
    expect(requested.some((u) => u.includes("/session/newest/prompt_async"))).toBe(true);
  });

  test("parses the bare-array session response shape", async () => {
    insertPeer(peerStmts, {
      id: "oc-arr",
      agent_type: "opencode",
      opencode_url: "http://oc-arr.test:9000",
    });

    const requested: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      requested.push(u);
      if (u.endsWith("/session")) {
        return new Response(
          JSON.stringify([
            { id: "a", updatedAt: "2026-01-01T00:00:00Z" },
            { id: "b", updatedAt: "2026-02-01T00:00:00Z" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 204 });
    }) as any;

    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-arr", "hi", new Date().toISOString());

    await until(() => countDelivered("oc-arr") === 1);
    expect(requested.some((u) => u.includes("/session/b/prompt_async"))).toBe(true);
  });

  test("a 204 from prompt_async still marks the row delivered", async () => {
    insertPeer(peerStmts, {
      id: "oc-204",
      agent_type: "opencode",
      opencode_url: "http://oc204.test:9000",
    });
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/session")) {
        return new Response(JSON.stringify([{ id: "s1", updatedAt: "2026-01-01T00:00:00Z" }]), { status: 200 });
      }
      return new Response("", { status: 204 });
    }) as any;

    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-204", "x", new Date().toISOString());
    await until(() => countDelivered("oc-204") === 1);
    expect(countDelivered("oc-204")).toBe(1);
  });

  test("the resolved session is cached within the 30s TTL", async () => {
    insertPeer(peerStmts, {
      id: "oc-cache",
      agent_type: "opencode",
      opencode_url: "http://oc-cache.test:9000",
    });

    let sessionFetches = 0;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/session")) {
        sessionFetches++;
        return new Response(JSON.stringify([{ id: "cached", updatedAt: "2026-01-01T00:00:00Z" }]), { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as any;

    const now = new Date().toISOString();
    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-cache", "m1", now);
    await until(() => countDelivered("oc-cache") === 1);

    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-cache", "m2", new Date().toISOString());
    await until(() => countDelivered("oc-cache") === 2);

    // Second send reused the cached session: /session was only fetched once.
    expect(sessionFetches).toBe(1);
  });

  test("a 404 from prompt_async evicts the cache so the next send re-resolves", async () => {
    insertPeer(peerStmts, {
      id: "oc-evict",
      agent_type: "opencode",
      opencode_url: "http://oc-evict.test:9000",
    });

    let sessionFetches = 0;
    let promptStatus = 404;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/session")) {
        sessionFetches++;
        return new Response(JSON.stringify([{ id: "s", updatedAt: "2026-01-01T00:00:00Z" }]), { status: 200 });
      }
      return new Response("", { status: promptStatus });
    }) as any;

    // First send: prompt_async 404s, so it is NOT delivered and the cache is evicted.
    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-evict", "first", new Date().toISOString());
    await until(() => sessionFetches === 1);
    await Bun.sleep(30); // let the .then chain settle (no markDelivered expected)
    expect(countDelivered("oc-evict")).toBe(0);

    // Second send: cache was evicted by the 404, so /session is fetched again.
    promptStatus = 200;
    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-evict", "second", new Date().toISOString());
    await until(() => countDelivered("oc-evict") === 1);
    expect(sessionFetches).toBe(2);
  });

  test("the surface_id branch delivers via cmux and marks delivered", async () => {
    insertPeer(peerStmts, {
      id: "oc-surface",
      agent_type: "opencode",
      surface_id: "surf-42",
    });
    // No fetch should be hit on the cmux path.
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called for cmux delivery");
    }) as any;

    deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-surface", "via cmux", new Date().toISOString());

    await until(() => countDelivered("oc-surface") === 1);
    expect(cmuxCalls.some((c) => c.kind === "text" && c.surfaceId === "surf-42")).toBe(true);
    expect(cmuxCalls.some((c) => c.kind === "key" && c.arg === "enter")).toBe(true);
  });
});
