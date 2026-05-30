/**
 * M16: handleDashboardMessage profile + baseline branches.
 *
 * Profile branch is exercised at the statement level against an in-memory DB
 * (the handler just wraps createProfileStatements / getAllProfiles), covering
 * insert, upsert-by-name, delete, name ordering and the repos JSON round-trip.
 *
 * Baseline branch is driven end-to-end through a live test broker over the
 * dashboard WebSocket so the real handler (offset capture + publish) runs.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, writeFileSync } from "fs";
import type { DashboardMessage } from "../shared/types.ts";
import { initDatabase } from "./db.ts";
import { createProfileStatements, getAllProfiles } from "./handlers.ts";

// --- M16a: profile statements (direct, in-memory) ---

describe("launch profiles", () => {
  let db: Database;
  let stmts: ReturnType<typeof createProfileStatements>;

  function save(name: string, directory: string, repos: string[], prompt = "") {
    const now = new Date().toISOString();
    const id = crypto.randomUUID().slice(0, 8);
    return stmts.upsertProfile.get(id, name, directory, JSON.stringify(repos), prompt, now) as { id: string; created_at: string };
  }

  beforeEach(() => {
    db = initDatabase(":memory:");
    stmts = createProfileStatements(db);
  });

  afterEach(() => db.close());

  test("inserts a profile and round-trips repos JSON", () => {
    save("alpha", "/src/alpha", ["repo-a", "repo-b"], "do work");
    const profiles = getAllProfiles(stmts);
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe("alpha");
    expect(profiles[0].directory).toBe("/src/alpha");
    expect(profiles[0].repos).toEqual(["repo-a", "repo-b"]);
    expect(profiles[0].prompt).toBe("do work");
  });

  test("upsert by name updates in place instead of duplicating", () => {
    const first = save("dup", "/src/v1", ["x"]);
    const second = save("dup", "/src/v2", ["y", "z"], "updated");

    const profiles = getAllProfiles(stmts);
    expect(profiles.length).toBe(1);
    expect(profiles[0].directory).toBe("/src/v2");
    expect(profiles[0].repos).toEqual(["y", "z"]);
    expect(profiles[0].prompt).toBe("updated");
    // The ON CONFLICT(name) path keeps the original id.
    expect(second.id).toBe(first.id);
  });

  test("delete removes the row", () => {
    const row = save("gone", "/src/gone", ["r"]);
    stmts.deleteProfile.run(row.id);
    expect(getAllProfiles(stmts).length).toBe(0);
  });

  test("getAllProfiles orders by name", () => {
    save("charlie", "/c", []);
    save("alpha", "/a", []);
    save("bravo", "/b", []);
    const names = getAllProfiles(stmts).map((p) => p.name);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });
});

// --- M16b: baseline branch via a live broker over the dashboard WS ---

let brokerProcess: Subprocess;
let testPort: number;
let testDbPath: string;
const activeSockets: WebSocket[] = [];

async function findFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  return port;
}

async function startBroker(port: number, dbPath: string): Promise<Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "broker.ts")], {
    env: { ...process.env, CLAUDE_HIVEMIND_PORT: String(port), CLAUDE_HIVEMIND_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return proc;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error("Broker did not start within 10 seconds");
}

function connect(url: string): WebSocket {
  const ws = new WebSocket(url);
  activeSockets.push(ws);
  return ws;
}

function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const t = setTimeout(() => reject(new Error("WS open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(e as any); }, { once: true });
  });
}

function waitForMessage<T extends { type: string }>(ws: WebSocket, type: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === type) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(data as T);
        }
      } catch { /* keep waiting */ }
    };
    ws.addEventListener("message", handler);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return resolve();
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close();
  });
}

describe("baseline branch (live broker)", () => {
  beforeAll(async () => {
    testPort = await findFreePort();
    testDbPath = join(tmpdir(), `hivemind-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    brokerProcess = await startBroker(testPort, testDbPath);
  });

  afterEach(async () => {
    await Promise.all(activeSockets.splice(0).map(closeSocket));
  });

  afterAll(async () => {
    if (brokerProcess) {
      brokerProcess.kill();
      await brokerProcess.exited;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(testDbPath + suffix); } catch {}
    }
  });

  test("set_baseline publishes baseline_set and captures a log offset for a registered service", async () => {
    const ns = "baseline-ns";

    // Write a log file so the handler can record a non-zero offset.
    const logPath = join(tmpdir(), `hivemind-baseline-log-${Date.now()}.log`);
    writeFileSync(logPath, "line one\nline two\n");

    // Register a peer with a service that points at the log file.
    const peer = connect(`ws://127.0.0.1:${testPort}/ws/peer?namespace=${ns}`);
    await waitForOpen(peer);
    peer.send(JSON.stringify({
      type: "register",
      pid: process.pid,
      cwd: "/test/baseline-peer",
      git_root: null,
      git_branch: null,
      tty: null,
      summary: "",
      namespace: ns,
    }));
    const reg = await waitForMessage<{ type: "registered"; id: string }>(peer, "registered");
    peer.send(JSON.stringify({ type: "register_service", port: 65530, health_url: "/health", log_file: logPath }));
    await Bun.sleep(150); // let the service row land

    // Dashboard drives set_baseline.
    const dash = connect(`ws://127.0.0.1:${testPort}/ws/dashboard`);
    await waitForOpen(dash);
    await waitForMessage<DashboardMessage & { type: "snapshot" }>(dash, "snapshot");

    const setPromise = waitForMessage<DashboardMessage & { type: "baseline_set" }>(dash, "baseline_set");
    dash.send(JSON.stringify({ type: "set_baseline", namespace: ns }));
    const setMsg = await setPromise;
    expect(setMsg.namespace).toBe(ns);
    expect(setMsg.baseline_at).toBeTruthy();

    await Bun.sleep(150); // allow the offset write to commit

    // Inspect the broker DB directly: the offset row was captured for the peer.
    const db = new Database(testDbPath, { readonly: true });
    const offset = db.query(
      `SELECT file_offset FROM log_baseline_offsets WHERE namespace = ? AND peer_id = ?`
    ).get(ns, reg.id) as { file_offset: number } | null;
    const baseline = db.query(`SELECT baseline_at FROM log_baselines WHERE namespace = ?`).get(ns) as { baseline_at: string } | null;
    db.close();

    expect(baseline).toBeTruthy();
    expect(offset).toBeTruthy();
    expect(offset!.file_offset).toBe(18); // "line one\nline two\n" = 18 bytes

    try { unlinkSync(logPath); } catch {}
  });

  test("clear_baseline publishes baseline_cleared and removes the rows", async () => {
    const ns = "baseline-clear-ns";

    const dash = connect(`ws://127.0.0.1:${testPort}/ws/dashboard`);
    await waitForOpen(dash);
    await waitForMessage<DashboardMessage & { type: "snapshot" }>(dash, "snapshot");

    // Set then clear.
    const setPromise = waitForMessage<DashboardMessage & { type: "baseline_set" }>(dash, "baseline_set");
    dash.send(JSON.stringify({ type: "set_baseline", namespace: ns }));
    await setPromise;

    const clearPromise = waitForMessage<DashboardMessage & { type: "baseline_cleared" }>(dash, "baseline_cleared");
    dash.send(JSON.stringify({ type: "clear_baseline", namespace: ns }));
    const clearMsg = await clearPromise;
    expect(clearMsg.namespace).toBe(ns);

    await Bun.sleep(150);

    const db = new Database(testDbPath, { readonly: true });
    const baseline = db.query(`SELECT baseline_at FROM log_baselines WHERE namespace = ?`).get(ns);
    const offsets = db.query(`SELECT * FROM log_baseline_offsets WHERE namespace = ?`).all(ns);
    db.close();

    expect(baseline).toBeNull();
    expect(offsets.length).toBe(0);
  });
});
