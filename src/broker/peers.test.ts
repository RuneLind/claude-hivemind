/**
 * Unit tests for peer ID generation (M15) and OpenCode delivery routing.
 *
 * These exercise pure-ish broker internals against an in-memory bun:sqlite DB,
 * with no broker subprocess. The cmux client is mocked so the surface_id
 * delivery branch is observable without a real socket.
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
    null,
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

  test("strips a colon so the id cannot invade the reserved http: namespace", () => {
    // A basename with a colon (legal on unix) must not yield an id like
    // "http:cli" that would collide with the `http:`-stamped HTTP-send origin.
    const peerSockets = new Map<string, unknown>();
    const id = generateId(stmts, peerSockets, "/tmp/http:cli");
    expect(id).toBe("httpcli");
    expect(id).not.toContain(":");
  });

  test("a basename equal to a reserved sender id falls back to a neutral base", () => {
    // A peer registering from a `.../__dashboard__` cwd must not be handed the
    // dashboard's reserved sender id.
    const peerSockets = new Map<string, unknown>();
    const id = generateId(stmts, peerSockets, "/tmp/__dashboard__");
    expect(id).toBe("peer");
  });

  test("a basename that sanitizes to empty falls back to a neutral base", () => {
    const peerSockets = new Map<string, unknown>();
    const id = generateId(stmts, peerSockets, "/tmp/:::");
    expect(id).toBe("peer");
  });
});

// --- OpenCode delivery routing via deliverOrQueue ---

describe("OpenCode delivery routing", () => {
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

  test("an opencode peer without surface_id (the plugin) gets the message on its WebSocket", () => {
    insertPeer(peerStmts, { id: "oc-plugin", agent_type: "opencode" });
    const sent: string[] = [];
    ctx.peerSockets.set("oc-plugin", { readyState: 1, send: (s: string) => sent.push(s) });
    globalThis.fetch = (async () => {
      throw new Error("no HTTP delivery expected");
    }) as any;

    try {
      const status = deliverOrQueue(ctx, peerStmts, msgStmts, "sender", "oc-plugin", "hi", new Date().toISOString(), "tok-9");

      expect(status).toBe("delivered");
      expect(cmuxCalls).toHaveLength(0);
      expect(sent).toHaveLength(1);
      const payload = JSON.parse(sent[0]!);
      expect(payload).toMatchObject({ type: "message", from_id: "sender", text: "hi", correlation_id: "tok-9" });
      expect(countDelivered("oc-plugin")).toBe(1);
    } finally {
      ctx.peerSockets.delete("oc-plugin");
    }
  });
});
