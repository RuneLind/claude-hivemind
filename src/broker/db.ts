/**
 * Database initialization, schema creation, and shared broker types.
 */

import { Database } from "bun:sqlite";

export const WS_OPEN = 1;

export type PeerWSData = { kind: "peer"; peerId: string | null; namespace: string };
export type DashboardWSData = { kind: "dashboard" };
export type WSData = PeerWSData | DashboardWSData;

export interface BrokerContext {
  server: import("bun").Server;
  peerSockets: Map<string, import("bun").ServerWebSocket<WSData>>;
}

export function initDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");

  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
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

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_peers_namespace ON peers(namespace)`
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS saved_summaries (
      cwd TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      peer_id TEXT PRIMARY KEY REFERENCES peers(id),
      port INTEGER NOT NULL,
      health_url TEXT NOT NULL DEFAULT '/health',
      log_file TEXT,
      log_format TEXT NOT NULL DEFAULT 'plain',
      status TEXT NOT NULL DEFAULT 'unknown',
      last_check TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS log_baselines (
      namespace TEXT PRIMARY KEY,
      baseline_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS log_baseline_offsets (
      namespace TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      file_offset INTEGER NOT NULL,
      PRIMARY KEY (namespace, peer_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS launch_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      directory TEXT NOT NULL,
      repos TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  return db;
}
