/**
 * M17: schema migration test for initDatabase().
 *
 * Creates a temp file DB carrying an OLD schema (peers missing the newer
 * agent_type/opencode_url/surface_id columns; messages missing correlation_id),
 * inserts a row, then runs initDatabase() over it and asserts the ALTER-based
 * migration adds the columns with correct defaults without throwing and without
 * disturbing the pre-existing row.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { initDatabase } from "./db.ts";

const created: string[] = [];

function tempDbPath(): string {
  const p = join(tmpdir(), `hivemind-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(p + suffix); } catch {}
    }
  }
});

describe("initDatabase migration", () => {
  test("adds new columns to an old peers/messages schema and keeps existing rows", () => {
    const path = tempDbPath();

    // 1. Seed an OLD-schema database, predating the agent_type/opencode_url/
    //    surface_id and correlation_id additions.
    {
      const old = new Database(path);
      old.run(`
        CREATE TABLE peers (
          id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          git_root TEXT,
          git_branch TEXT,
          tty TEXT,
          summary TEXT NOT NULL DEFAULT '',
          namespace TEXT NOT NULL DEFAULT 'default',
          registered_at TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          connected INTEGER NOT NULL DEFAULT 0
        )
      `);
      old.run(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          text TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `);
      old.run(
        `INSERT INTO peers (id, pid, cwd, summary, namespace, registered_at, last_seen, connected)
         VALUES ('legacy', 4242, '/old/legacy', 'old summary', 'oldns', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 1)`
      );
      old.run(
        `INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
         VALUES ('a', 'b', 'old message', '2026-01-01T00:00:00Z', 1)`
      );
      old.close();
    }

    // 2. Run the migration. Must not throw.
    const db = initDatabase(path);

    // 3. New peers columns exist with the documented defaults.
    const peerCols = db.query(`PRAGMA table_info(peers)`).all() as { name: string; dflt_value: string | null }[];
    const colByName = new Map(peerCols.map((c) => [c.name, c]));
    expect(colByName.has("agent_type")).toBe(true);
    expect(colByName.has("opencode_url")).toBe(true);
    expect(colByName.has("surface_id")).toBe(true);
    // The added agent_type column carries the 'claude-code' default.
    expect(colByName.get("agent_type")!.dflt_value).toContain("claude-code");

    // 4. The new messages column exists.
    const msgCols = db.query(`PRAGMA table_info(messages)`).all() as { name: string }[];
    expect(msgCols.some((c) => c.name === "correlation_id")).toBe(true);

    // 5. The pre-existing peer row reads back intact, with the migrated column
    //    defaulted on the existing row.
    const peer = db.query(`SELECT * FROM peers WHERE id = 'legacy'`).get() as any;
    expect(peer).toBeTruthy();
    expect(peer.pid).toBe(4242);
    expect(peer.cwd).toBe("/old/legacy");
    expect(peer.summary).toBe("old summary");
    expect(peer.namespace).toBe("oldns");
    expect(peer.connected).toBe(1);
    expect(peer.agent_type).toBe("claude-code");
    expect(peer.opencode_url).toBeNull();
    expect(peer.surface_id).toBeNull();

    // 6. The pre-existing message row reads back intact, correlation_id null.
    const msg = db.query(`SELECT * FROM messages WHERE from_id = 'a'`).get() as any;
    expect(msg).toBeTruthy();
    expect(msg.text).toBe("old message");
    expect(msg.delivered).toBe(1);
    expect(msg.correlation_id).toBeNull();

    db.close();
  });

  test("is idempotent on an already-current schema (re-running does not throw)", () => {
    const path = tempDbPath();
    const db1 = initDatabase(path);
    db1.close();
    // Re-open: every ALTER is wrapped in try/catch, so a second run is a no-op.
    const db2 = initDatabase(path);
    const peerCols = db2.query(`PRAGMA table_info(peers)`).all() as { name: string }[];
    expect(peerCols.some((c) => c.name === "agent_type")).toBe(true);
    db2.close();
  });
});
