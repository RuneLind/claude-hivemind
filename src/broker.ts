#!/usr/bin/env bun
/**
 * claude-hivemind broker daemon
 *
 * Singleton HTTP + WebSocket server on localhost:7899 backed by SQLite.
 * Tracks peers, routes messages with namespace isolation, serves dashboard.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import {
  DEFAULT_HEALTH_URL,
  DEFAULT_LOG_FORMAT,
  DASHBOARD_SENDER_ID,
} from "./shared/types.ts";
import type {
  ClientMessage,
  BrokerMessage,
  DashboardMessage,
  DashboardClientMessage,
  Peer,
  ServiceInfo,
  LogBaseline,
  LogLine,
  LogLevel,
  NamespaceInfo,
  PeerMessageStats,
  PairMessageStats,
  StoredMessage,
  DockerContainer,
  DockerContainerLogStats,
} from "./shared/types.ts";
import { renderDashboardPage } from "./dashboard/views/page.ts";

const dashboardHtml = renderDashboardPage();
const PORT = parseInt(process.env.CLAUDE_HIVEMIND_PORT ?? "7899", 10);
const DB_PATH =
  process.env.CLAUDE_HIVEMIND_DB ?? `${process.env.HOME}/.claude-hivemind.db`;
const GRACE_PERIOD_MS = 30_000;
const WS_OPEN = 1;

const db = new Database(DB_PATH);
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


const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, git_branch, tty, summary, namespace, registered_at, last_seen, connected)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(
  `UPDATE peers SET last_seen = ? WHERE id = ?`
);

const updateSummary = db.prepare(
  `UPDATE peers SET summary = ? WHERE id = ?`
);

const markConnected = db.prepare(
  `UPDATE peers SET connected = ? WHERE id = ?`
);

const deletePeerStmt = db.prepare(`DELETE FROM peers WHERE id = ?`);

const selectPeerById = db.prepare(`SELECT * FROM peers WHERE id = ?`);

const selectAllPeers = db.prepare(`SELECT * FROM peers`);

const selectPeersByNamespace = db.prepare(
  `SELECT * FROM peers WHERE namespace = ?`
);

const deleteByPid = db.prepare(`DELETE FROM peers WHERE pid = ?`);

const upsertSummary = db.prepare(`
  INSERT INTO saved_summaries (cwd, summary, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(cwd) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
`);

const selectSavedSummary = db.prepare(
  `SELECT summary FROM saved_summaries WHERE cwd = ?`
);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?)
`);

const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC`
);

const markDelivered = db.prepare(
  `UPDATE messages SET delivered = 1 WHERE id = ?`
);

const selectPeerIdPid = db.prepare(`SELECT id, pid FROM peers`);

const deleteOldMessages = db.prepare(
  `DELETE FROM messages WHERE delivered = 1 AND sent_at < ?`
);

const selectPeerStats = db.prepare(`
  SELECT peer_id, SUM(sent) as sent, SUM(received) as received FROM (
    SELECT from_id as peer_id, COUNT(*) as sent, 0 as received FROM messages GROUP BY from_id
    UNION ALL
    SELECT to_id as peer_id, 0 as sent, COUNT(*) as received FROM messages GROUP BY to_id
  ) GROUP BY peer_id
`);

const selectPairStats = db.prepare(`
  SELECT from_id, to_id, COUNT(*) as count FROM messages GROUP BY from_id, to_id
`);

const selectConversation = db.prepare(`
  SELECT id, from_id, to_id, text, sent_at FROM messages
  WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
  ORDER BY sent_at ASC
`);

const selectPeerMessages = db.prepare(`
  SELECT id, from_id, to_id, text, sent_at FROM messages
  WHERE from_id = ? OR to_id = ?
  ORDER BY sent_at ASC
`);

const deleteAllMessages = db.prepare(`DELETE FROM messages`);

const upsertService = db.prepare(`
  INSERT INTO services (peer_id, port, health_url, log_file, log_format, status, last_check)
  VALUES (?, ?, ?, ?, ?, 'unknown', NULL)
  ON CONFLICT(peer_id) DO UPDATE SET
    port = excluded.port, health_url = excluded.health_url,
    log_file = excluded.log_file, log_format = excluded.log_format
`);

const selectAllServices = db.prepare(`SELECT * FROM services`);

const selectServiceByPeer = db.prepare(`SELECT * FROM services WHERE peer_id = ?`);

const updateServiceStatus = db.prepare(
  `UPDATE services SET status = ?, last_check = ? WHERE peer_id = ?`
);

const deleteServiceByPeer = db.prepare(`DELETE FROM services WHERE peer_id = ?`);

const upsertBaseline = db.prepare(`
  INSERT INTO log_baselines (namespace, baseline_at) VALUES (?, ?)
  ON CONFLICT(namespace) DO UPDATE SET baseline_at = excluded.baseline_at
`);

const deleteBaseline = db.prepare(`DELETE FROM log_baselines WHERE namespace = ?`);

const selectAllBaselines = db.prepare(`SELECT * FROM log_baselines`);

const upsertBaselineOffset = db.prepare(`
  INSERT INTO log_baseline_offsets (namespace, peer_id, file_offset) VALUES (?, ?, ?)
  ON CONFLICT(namespace, peer_id) DO UPDATE SET file_offset = excluded.file_offset
`);

const deleteBaselineOffsets = db.prepare(`DELETE FROM log_baseline_offsets WHERE namespace = ?`);

const selectBaselineOffset = db.prepare(`SELECT file_offset FROM log_baseline_offsets WHERE namespace = ? AND peer_id = ?`);


function generateId(cwd: string): string {
  const base = cwd.split("/").pop() ?? "peer";
  const livePeers = getAllPeers().filter((p) => isProcessAlive(p.pid));
  const existing = livePeers.filter((p) => p.id === base || p.id.startsWith(base + "-"));
  if (existing.length === 0) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((p) => p.id === candidate)) return candidate;
  }
}

function getPeer(id: string): Peer | null {
  return (selectPeerById.get(id) as Peer) ?? null;
}

function getAllPeers(): Peer[] {
  return selectAllPeers.all() as Peer[];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


function log(msg: string) {
  console.error(`[claude-hivemind broker] ${msg}`);
}

function namespacesFromPeers(peers: Peer[]): NamespaceInfo[] {
  const nsMap = new Map<string, number>();
  for (const p of peers) {
    nsMap.set(p.namespace, (nsMap.get(p.namespace) ?? 0) + 1);
  }
  return Array.from(nsMap.entries()).map(([name, peer_count]) => ({
    name,
    peer_count,
  }));
}

function getMessageStats(): { peer_stats: PeerMessageStats[]; pair_stats: PairMessageStats[] } {
  return {
    peer_stats: selectPeerStats.all() as PeerMessageStats[],
    pair_stats: selectPairStats.all() as PairMessageStats[],
  };
}

function deliverOrQueue(fromId: string, toId: string, text: string, now: string): void {
  const targetWs = peerSockets.get(toId);
  if (targetWs && targetWs.readyState === WS_OPEN) {
    const sender = getPeer(fromId);
    targetWs.send(JSON.stringify({
      type: "message",
      from_id: fromId,
      from_summary: sender?.summary ?? "",
      from_cwd: sender?.cwd ?? "",
      text,
      sent_at: now,
    } satisfies BrokerMessage));
    insertMessage.run(fromId, toId, text, now, 1);
  } else {
    insertMessage.run(fromId, toId, text, now, 0);
  }
}


function cleanStalePeers() {
  const peers = selectPeerIdPid.all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      deleteServiceByPeer.run(peer.id);
      deletePeerStmt.run(peer.id);
    }
  }
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  deleteOldMessages.run(cutoff);
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

let polling = false;

async function pollServiceHealth() {
  if (polling) return;
  polling = true;
  try {
    const services = selectAllServices.all() as ServiceInfo[];
    if (services.length === 0) return;

    const peerIds = new Set(getAllPeers().map((p) => p.id));

    await Promise.all(
      services.map(async (svc) => {
        if (!peerIds.has(svc.peer_id)) {
          deleteServiceByPeer.run(svc.peer_id);
          return;
        }
        let newStatus: "up" | "down";
        try {
          const res = await fetch(`http://127.0.0.1:${svc.port}${svc.health_url}`, {
            signal: AbortSignal.timeout(3000),
          });
          newStatus = res.ok ? "up" : "down";
        } catch {
          newStatus = "down";
        }
        const now = new Date().toISOString();
        updateServiceStatus.run(newStatus, now, svc.peer_id);
        const updated: ServiceInfo = { ...svc, status: newStatus, last_check: now };
        server.publish(
          "dashboard",
          JSON.stringify({ type: "service_update", service: updated } satisfies DashboardMessage)
        );
      })
    );
  } finally {
    polling = false;
  }
}

setInterval(pollServiceHealth, 15_000);


// --- Docker container monitoring ---

const dockerContainers = new Map<string, DockerContainer>();
const dockerLogStats = new Map<string, DockerContainerLogStats>();
let dockerAvailable = false;
let dockerPolling = false;
let dockerEventProc: ReturnType<typeof Bun.spawn> | null = null;

async function runDockerCommand(args: string[], timeoutMs = 10_000, mergeStderr = false): Promise<string | null> {
  try {
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    await proc.exited;
    if (proc.exitCode !== 0 && !mergeStderr) return null;
    const combined = mergeStderr ? (stdout + "\n" + stderr).trim() : stdout.trim();
    return combined;
  } catch {
    return null;
  }
}

function parseDockerJsonLines<T>(text: string): T[] {
  if (!text) return [];
  // docker outputs one JSON object per line (not a JSON array)
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) as T; }
      catch { return null; }
    })
    .filter((x): x is T => x !== null);
}

interface DockerComposeProject {
  Name: string;
  Status: string;
  ConfigFiles: string;
}

interface DockerComposePsEntry {
  ID: string;
  Name: string;
  Service: string;
  State: string;
  Status: string;
  Health: string;
  Ports: string;
  Image: string;
  Project: string;
  ExitCode: number;
}

interface DockerStatsEntry {
  ID: string;
  Name: string;
  CPUPerc: string;
  MemPerc: string;
  MemUsage: string;
}

async function pollDockerContainers(): Promise<void> {
  if (!dockerAvailable || dockerPolling) return;
  dockerPolling = true;
  try {
    // Discover compose projects
    const lsOut = await runDockerCommand(["compose", "ls", "--format", "json"]);
    if (!lsOut) { dockerPolling = false; return; }

    let projects: DockerComposeProject[];
    try { projects = JSON.parse(lsOut); } catch { projects = []; }
    if (projects.length === 0) {
      if (dockerContainers.size > 0) {
        dockerContainers.clear();
        dockerLogStats.clear();
        server.publish("dashboard", JSON.stringify({
          type: "docker_update",
          containers: [],
        } satisfies DashboardMessage));
      }
      return;
    }

    // Get containers from all projects
    const allContainers: DockerComposePsEntry[] = [];
    await Promise.all(
      projects.map(async (proj) => {
        const psOut = await runDockerCommand([
          "compose", "-p", proj.Name, "ps", "-a", "--format", "json",
        ]);
        if (psOut) {
          const entries = parseDockerJsonLines<DockerComposePsEntry>(psOut);
          allContainers.push(...entries);
        }
      })
    );

    // Get resource stats for running containers
    const statsMap = new Map<string, DockerStatsEntry>();
    const statsOut = await runDockerCommand(["stats", "--no-stream", "--format", "json"]);
    if (statsOut) {
      for (const s of parseDockerJsonLines<DockerStatsEntry>(statsOut)) {
        statsMap.set(s.ID?.slice(0, 12), s);
        statsMap.set(s.Name, s);
      }
    }

    // Build container map
    const newIds = new Set<string>();
    for (const c of allContainers) {
      const shortId = c.ID?.slice(0, 12) ?? c.ID;
      const stats = statsMap.get(shortId) || statsMap.get(c.Name);
      const container: DockerContainer = {
        id: shortId,
        name: c.Name ?? c.Names,
        service: c.Service ?? "",
        project: c.Project ?? "",
        state: (c.State?.toLowerCase() ?? "unknown") as DockerContainer["state"],
        status: c.Status ?? "",
        health: c.Health ?? "",
        ports: c.Ports ?? "",
        image: c.Image ?? "",
        cpuPerc: stats?.CPUPerc ?? "",
        memPerc: stats?.MemPerc ?? "",
        memUsage: stats?.MemUsage ?? "",
      };
      dockerContainers.set(shortId, container);
      newIds.add(shortId);
    }

    // Remove containers that no longer exist
    for (const id of dockerContainers.keys()) {
      if (!newIds.has(id)) {
        dockerContainers.delete(id);
        dockerLogStats.delete(id);
      }
    }

    // Publish update
    server.publish("dashboard", JSON.stringify({
      type: "docker_update",
      containers: Array.from(dockerContainers.values()),
    } satisfies DashboardMessage));
  } catch (e) {
    log(`Docker poll error: ${e}`);
  } finally {
    dockerPolling = false;
  }
}

async function pollDockerLogStats(): Promise<void> {
  if (!dockerAvailable) return;
  const running = Array.from(dockerContainers.values()).filter((c) => c.state === "running");
  if (running.length === 0) return;

  const results: DockerContainerLogStats[] = [];

  await Promise.all(
    running.map(async (c) => {
      const out = await runDockerCommand(["logs", "--tail", "500", c.name], 15_000, true);
      if (out === null) return;
      const lines = out.split("\n").filter((l) => l.length > 0);
      let errorCount = 0;
      let warnCount = 0;
      for (const line of lines) {
        if (PLAIN_LEVEL_RE.test(line)) {
          const m = line.match(PLAIN_LEVEL_RE);
          if (m?.[1] === "ERROR") errorCount++;
          else if (m?.[1] === "WARN") warnCount++;
        }
      }
      const stat: DockerContainerLogStats = {
        containerId: c.id,
        errorCount,
        warnCount,
        totalLines: lines.length,
      };
      dockerLogStats.set(c.id, stat);
      results.push(stat);
    })
  );

  if (results.length > 0) {
    server.publish("dashboard", JSON.stringify({
      type: "docker_log_stats",
      logStats: results,
    } satisfies DashboardMessage));
  }
}

function startDockerEventStream(): void {
  if (!dockerAvailable || dockerEventProc) return;

  try {
    dockerEventProc = Bun.spawn(
      ["docker", "events", "--format", "json", "--filter", "type=container"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const reader = dockerEventProc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as {
                Action: string;
                Actor: { ID: string; Attributes: Record<string, string> };
              };
              const action = event.Action;
              const name = event.Actor?.Attributes?.name;
              const containerId = event.Actor?.ID?.slice(0, 12);

              // Re-poll on significant events
              if (["start", "stop", "die", "pause", "unpause", "kill", "destroy"].includes(action)) {
                log(`Docker event: ${name ?? containerId} ${action}`);
                // Quick re-poll to update state
                setTimeout(() => pollDockerContainers(), 500);

                // Publish immediate event
                server.publish("dashboard", JSON.stringify({
                  type: "docker_event",
                  containerId: containerId ?? "",
                  container: dockerContainers.get(containerId ?? "") ?? null,
                  event: action,
                } satisfies DashboardMessage));
              }
            } catch { /* skip unparseable event lines */ }
          }
        }
      } catch (e) {
        log(`Docker event stream error: ${e}`);
      } finally {
        dockerEventProc = null;
        // Restart after backoff
        if (dockerAvailable) {
          setTimeout(startDockerEventStream, 5000);
        }
      }
    })();
  } catch {
    dockerEventProc = null;
  }
}

// Docker log tailing for dashboard subscriptions
class DockerLogTailer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private containerId: string;
  private containerName: string;
  private onLines: (lines: LogLine[]) => void;
  private stopped = false;

  constructor(containerId: string, containerName: string, onLines: (lines: LogLine[]) => void) {
    this.containerId = containerId;
    this.containerName = containerName;
    this.onLines = onLines;
    this.start();
  }

  private async start() {
    try {
      this.proc = Bun.spawn(
        ["docker", "logs", "--follow", "--tail", "200", "--timestamps", this.containerName],
        { stdout: "pipe", stderr: "pipe" }
      );
      // Read both stdout and stderr (docker sends app stderr separately)
      this.readStream(this.proc.stdout);
      this.readStream(this.proc.stderr);
    } catch (e) {
      log(`DockerLogTailer start error for ${this.containerName}: ${e}`);
    }
  }

  private async readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop()!;

        const rawLines = parts.filter((l) => l.length > 0);
        if (rawLines.length > 0) {
          const parsed = rawLines.map((l) => this.parseDockerLine(l));
          this.onLines(parsed);
        }
      }
    } catch {
      // stream closed
    }
  }

  private parseDockerLine(raw: string): LogLine {
    const clean = raw.replace(ANSI_RE, "");
    // Docker --timestamps format: "2024-01-15T10:30:00.123456789Z <message>"
    const tsMatch = clean.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+(.*)/);
    const message = tsMatch ? tsMatch[2] : clean;
    const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();

    // Try spring format on the message part
    const springMatch = message.match(SPRING_LOG_RE);
    if (springMatch) {
      return { timestamp: springMatch[1] || timestamp, level: springMatch[2] as LogLevel, message: springMatch[3], raw: message };
    }

    // Try JSON format
    try {
      const obj = JSON.parse(message);
      if (obj && typeof obj === "object" && (obj.message || obj.msg)) {
        return {
          timestamp: obj.timestamp ?? obj["@timestamp"] ?? timestamp,
          level: ((obj.level ?? obj.severity ?? "INFO") as string).toUpperCase() as LogLevel,
          message: obj.message ?? obj.msg ?? message,
          raw: message,
        };
      }
    } catch { /* not JSON */ }

    // Plain: best-effort level detection
    const levelMatch = message.match(PLAIN_LEVEL_RE);
    return {
      timestamp,
      level: (levelMatch?.[1] ?? "INFO") as LogLevel,
      message,
      raw: message,
    };
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}

const dockerLogSubscriptions = new Map<string, {
  tailer: DockerLogTailer;
  subscribers: Set<import("bun").ServerWebSocket<WSData>>;
}>();

function subscribeDockerLogs(containerId: string, ws: import("bun").ServerWebSocket<WSData>) {
  const container = dockerContainers.get(containerId);
  if (!container) return;

  const existing = dockerLogSubscriptions.get(containerId);
  if (existing) {
    existing.subscribers.add(ws);
    return;
  }

  const subscribers = new Set<import("bun").ServerWebSocket<WSData>>([ws]);
  const tailer = new DockerLogTailer(containerId, container.name, (lines) => {
    const msg = JSON.stringify({
      type: "docker_log_lines",
      containerId,
      lines,
    } satisfies DashboardMessage);
    for (const sub of subscribers) {
      if (sub.readyState === WS_OPEN) sub.send(msg);
    }
  });

  dockerLogSubscriptions.set(containerId, { tailer, subscribers });
}

function unsubscribeDockerLogs(containerId: string, ws: import("bun").ServerWebSocket<WSData>) {
  const sub = dockerLogSubscriptions.get(containerId);
  if (!sub) return;
  sub.subscribers.delete(ws);
  if (sub.subscribers.size === 0) {
    sub.tailer.stop();
    dockerLogSubscriptions.delete(containerId);
  }
}

function unsubscribeAllDockerLogs(ws: import("bun").ServerWebSocket<WSData>) {
  for (const [containerId, sub] of dockerLogSubscriptions) {
    sub.subscribers.delete(ws);
    if (sub.subscribers.size === 0) {
      sub.tailer.stop();
      dockerLogSubscriptions.delete(containerId);
    }
  }
}

async function initDockerMonitoring() {
  const versionOut = await runDockerCommand(["version", "--format", "json"]);
  if (!versionOut) {
    log("Docker not available — container monitoring disabled");
    return;
  }
  dockerAvailable = true;
  log("Docker detected — container monitoring enabled");

  await pollDockerContainers();
  await pollDockerLogStats();
  startDockerEventStream();

  setInterval(pollDockerContainers, 10_000);
  setInterval(pollDockerLogStats, 30_000);
}

initDockerMonitoring();


type PeerWSData = { kind: "peer"; peerId: string | null; namespace: string };
type DashboardWSData = { kind: "dashboard" };
type WSData = PeerWSData | DashboardWSData;

const peerSockets = new Map<string, import("bun").ServerWebSocket<WSData>>();


function handlePeerMessage(
  ws: import("bun").ServerWebSocket<PeerWSData>,
  msg: ClientMessage,
  server: import("bun").Server
): void {
  switch (msg.type) {
    case "register": {
      const now = new Date().toISOString();
      deleteByPid.run(msg.pid);
      const id = generateId(msg.cwd);

      const saved = selectSavedSummary.get(msg.cwd) as { summary: string } | null;
      const summary = msg.summary || saved?.summary || "";

      insertPeer.run(
        id,
        msg.pid,
        msg.cwd,
        msg.git_root,
        msg.git_branch,
        msg.tty,
        summary,
        msg.namespace,
        now,
        now,
        1
      );

      ws.data.peerId = id;
      ws.data.namespace = msg.namespace;

      ws.subscribe(`ns:${msg.namespace}`);
      ws.subscribe(`peer:${id}`);

      peerSockets.set(id, ws as import("bun").ServerWebSocket<WSData>);

      const reply: BrokerMessage = {
        type: "registered",
        id,
        namespace: msg.namespace,
      };
      ws.send(JSON.stringify(reply));

      const queued = selectUndelivered.all(id) as import("./shared/types.ts").Message[];
      for (const m of queued) {
        const sender = getPeer(m.from_id);
        const deliverMsg: BrokerMessage = {
          type: "message",
          from_id: m.from_id,
          from_summary: sender?.summary ?? "",
          from_cwd: sender?.cwd ?? "",
          text: m.text,
          sent_at: m.sent_at,
        };
        ws.send(JSON.stringify(deliverMsg));
        markDelivered.run(m.id);
      }

      const peer = getPeer(id)!;
      const joinMsg = JSON.stringify({ type: "peer_joined", peer });
      server.publish(`ns:${msg.namespace}`, joinMsg);
      server.publish(
        "dashboard",
        JSON.stringify({
          type: "peer_joined",
          peer,
        } satisfies DashboardMessage)
      );

      log(`Peer ${id} registered (ns: ${msg.namespace}, cwd: ${msg.cwd})`);
      break;
    }

    case "set_summary": {
      if (!ws.data.peerId) return;
      updateSummary.run(msg.summary, ws.data.peerId);
      const peer = getPeer(ws.data.peerId);
      if (peer) {
        upsertSummary.run(peer.cwd, msg.summary, new Date().toISOString());
        const updateMsg = JSON.stringify({ type: "peer_updated", peer });
        server.publish(`ns:${ws.data.namespace}`, updateMsg);
        server.publish("dashboard", updateMsg);
      }
      break;
    }

    case "send_message": {
      if (!ws.data.peerId) return;
      const fromId = ws.data.peerId;

      const target = getPeer(msg.to);
      if (!target) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `Peer ${msg.to} not found`,
          } satisfies BrokerMessage)
        );
        return;
      }

      if (target.namespace !== ws.data.namespace) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `Cannot message peer ${msg.to}: different namespace (${target.namespace} vs ${ws.data.namespace})`,
          } satisfies BrokerMessage)
        );
        return;
      }

      const now = new Date().toISOString();
      deliverOrQueue(fromId, msg.to, msg.text, now);

      const stats = getMessageStats();
      server.publish(
        "dashboard",
        JSON.stringify({
          type: "message_sent",
          from_id: fromId,
          to_id: msg.to,
          text: msg.text,
          sent_at: now,
          peer_stats: stats.peer_stats,
          pair_stats: stats.pair_stats,
        } satisfies DashboardMessage)
      );
      break;
    }

    case "list_peers": {
      if (!ws.data.peerId) return;
      let peers: Peer[];
      if (msg.scope === "namespace") {
        peers = selectPeersByNamespace.all(ws.data.namespace) as Peer[];
      } else {
        peers = getAllPeers();
      }
      peers = peers
        .filter((p) => p.id !== ws.data.peerId)
        .filter((p) => isProcessAlive(p.pid));

      ws.send(JSON.stringify({ type: "peers", peers } satisfies BrokerMessage));
      break;
    }

    case "heartbeat": {
      if (!ws.data.peerId) {
        return;
      }
      updateLastSeen.run(new Date().toISOString(), ws.data.peerId);
      break;
    }

    case "register_service": {
      if (!ws.data.peerId) return;
      const healthUrl = msg.health_url || DEFAULT_HEALTH_URL;
      const logFormat = msg.log_format || DEFAULT_LOG_FORMAT;
      upsertService.run(
        ws.data.peerId,
        msg.port,
        healthUrl,
        msg.log_file ?? null,
        logFormat
      );
      const service: ServiceInfo = {
        peer_id: ws.data.peerId,
        port: msg.port,
        health_url: healthUrl,
        log_file: msg.log_file ?? null,
        log_format: logFormat,
        status: "unknown",
        last_check: null,
      };
      server.publish(
        "dashboard",
        JSON.stringify({ type: "service_update", service } satisfies DashboardMessage)
      );
      log(`Service registered for ${ws.data.peerId} on port ${msg.port}`);
      break;
    }
  }
}


// --- Log tailing ---

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SPRING_LOG_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*|[\d]{2}:\d{2}:\d{2}[,.\d]*)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(.*)$/;
const PLAIN_LEVEL_RE = /\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/;

function parseLogLine(raw: string, format: ServiceInfo["log_format"]): LogLine {
  const clean = raw.replace(ANSI_RE, "");
  if (format === "json") {
    try {
      const obj = JSON.parse(clean);
      return {
        timestamp: obj.timestamp ?? obj["@timestamp"] ?? new Date().toISOString(),
        level: (obj.level ?? obj.severity ?? "INFO").toUpperCase() as LogLevel,
        message: obj.message ?? obj.msg ?? clean,
        raw: clean,
      };
    } catch { /* fall through to plain */ }
  }

  if (format === "spring") {
    const m = clean.match(SPRING_LOG_RE);
    if (m) {
      return { timestamp: m[1], level: m[2] as LogLevel, message: m[3], raw: clean };
    }
  }

  // plain: best-effort
  const levelMatch = clean.match(PLAIN_LEVEL_RE);
  return {
    timestamp: new Date().toISOString(),
    level: (levelMatch?.[1] ?? "INFO") as LogLevel,
    message: clean,
    raw: clean,
  };
}

const MAX_LOG_READ_BYTES = 65536;

async function readLinesFromOffset(filePath: string, format: ServiceInfo["log_format"], fromOffset: number, maxBytes = MAX_LOG_READ_BYTES): Promise<LogLine[]> {
  const file = Bun.file(filePath);
  const size = file.size;
  if (fromOffset >= size) return [];
  const readFrom = Math.max(fromOffset, size - maxBytes);
  const text = await file.slice(readFrom, size).text();
  const rawLines = text.split("\n").filter((l) => l.length > 0);
  return rawLines.map((l) => parseLogLine(l, format));
}

async function readTailLines(filePath: string, format: ServiceInfo["log_format"]): Promise<LogLine[]> {
  return readLinesFromOffset(filePath, format, 0);
}

const INITIAL_LOG_LINES = 200;

class LogTailer {
  private offset: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private format: ServiceInfo["log_format"];
  private filePath: string;
  private onLines: (lines: LogLine[]) => void;
  private stopped = false;

  constructor(filePath: string, format: ServiceInfo["log_format"], onLines: (lines: LogLine[]) => void, startOffset?: number) {
    this.filePath = filePath;
    this.format = format;
    this.onLines = onLines;
    this.start(startOffset);
  }

  private async start(startOffset?: number) {
    try {
      const lines = startOffset !== undefined
        ? await readLinesFromOffset(this.filePath, this.format, startOffset)
        : (await readTailLines(this.filePath, this.format)).slice(-INITIAL_LOG_LINES);
      if (lines.length > 0) this.onLines(lines);
      this.offset = Bun.file(this.filePath).size;
    } catch {
      this.offset = 0;
    }

    // Poll for new content — more reliable than fs.watch across platforms
    this.pollTimer = setInterval(() => this.readNew(), 1000);
  }

  private async readNew() {
    if (this.stopped) return;
    try {
      const file = Bun.file(this.filePath);
      const size = file.size;
      if (size < this.offset) {
        this.offset = 0; // file was truncated
      }
      if (size <= this.offset) return;

      const chunk = file.slice(this.offset, size);
      const text = await chunk.text();
      this.offset = size;

      const rawLines = text.split("\n").filter((l) => l.length > 0);
      if (rawLines.length === 0) return;

      this.onLines(rawLines.map((l) => parseLogLine(l, this.format)));
    } catch (e) {
      log(`LogTailer error for ${this.filePath}: ${e}`);
    }
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// Track active log subscriptions: peerId -> { tailer, subscribers }
const logSubscriptions = new Map<string, {
  tailer: LogTailer;
  subscribers: Set<import("bun").ServerWebSocket<WSData>>;
}>();

async function subscribeLogs(peerId: string, ws: import("bun").ServerWebSocket<WSData>) {
  const svc = selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
  if (!svc?.log_file) return;

  // Check if baseline exists for this peer's namespace
  const peer = getPeer(peerId);
  const ns = peer?.namespace;
  const baselineOffset = ns
    ? (selectBaselineOffset.get(ns, peerId) as { file_offset: number } | undefined)
    : undefined;

  const existing = logSubscriptions.get(peerId);
  if (existing) {
    existing.subscribers.add(ws);
    if (baselineOffset) {
      try {
        const lines = await readLinesFromOffset(svc.log_file, svc.log_format, baselineOffset.file_offset);
        if (lines.length > 0) {
          ws.send(JSON.stringify({ type: "log_lines", peer_id: peerId, lines } satisfies DashboardMessage));
        }
      } catch { /* ignore */ }
    }
    return;
  }

  const subscribers = new Set<import("bun").ServerWebSocket<WSData>>([ws]);
  const startOffset = baselineOffset?.file_offset;
  const tailer = new LogTailer(svc.log_file, svc.log_format, (lines) => {
    const msg = JSON.stringify({
      type: "log_lines",
      peer_id: peerId,
      lines,
    } satisfies DashboardMessage);
    for (const sub of subscribers) {
      if (sub.readyState === WS_OPEN) {
        sub.send(msg);
      }
    }
  }, startOffset);

  logSubscriptions.set(peerId, { tailer, subscribers });
}

function unsubscribeLogs(peerId: string, ws: import("bun").ServerWebSocket<WSData>) {
  const sub = logSubscriptions.get(peerId);
  if (!sub) return;
  sub.subscribers.delete(ws);
  if (sub.subscribers.size === 0) {
    sub.tailer.stop();
    logSubscriptions.delete(peerId);
  }
}

function unsubscribeAllLogs(ws: import("bun").ServerWebSocket<WSData>) {
  for (const [peerId, sub] of logSubscriptions) {
    sub.subscribers.delete(ws);
    if (sub.subscribers.size === 0) {
      sub.tailer.stop();
      logSubscriptions.delete(peerId);
    }
  }
}

function handleDashboardMessage(msg: DashboardClientMessage, ws: import("bun").ServerWebSocket<WSData>): void {
  switch (msg.type) {
    case "send_to_peer": {
      const peer = getPeer(msg.peer_id);
      if (!peer) return;
      const targetWs = peerSockets.get(msg.peer_id);
      if (targetWs && targetWs.readyState === WS_OPEN) {
        targetWs.send(
          JSON.stringify({
            type: "message",
            from_id: DASHBOARD_SENDER_ID,
            from_summary: "Hivemind Dashboard",
            from_cwd: "",
            text: msg.message,
            sent_at: new Date().toISOString(),
          } satisfies BrokerMessage)
        );
        log(`Dashboard sent message to ${msg.peer_id}`);
      }
      break;
    }

    case "subscribe_logs": {
      subscribeLogs(msg.peer_id, ws).catch((e) => log(`Log subscribe error: ${e}`));
      log(`Dashboard subscribed to logs for ${msg.peer_id}`);
      break;
    }

    case "unsubscribe_logs": {
      unsubscribeLogs(msg.peer_id, ws);
      log(`Dashboard unsubscribed from logs for ${msg.peer_id}`);
      break;
    }

    case "set_baseline": {
      const now = new Date().toISOString();
      upsertBaseline.run(msg.namespace, now);
      deleteBaselineOffsets.run(msg.namespace);
      // Record current file sizes for all services in namespace
      const nsPeers = selectPeersByNamespace.all(msg.namespace) as Peer[];
      for (const p of nsPeers) {
        const svc = selectServiceByPeer.get(p.id) as ServiceInfo | undefined;
        if (svc?.log_file) {
          try {
            const size = Bun.file(svc.log_file).size;
            upsertBaselineOffset.run(msg.namespace, p.id, size);
          } catch { /* file may not exist yet */ }
        }
      }
      server.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_set", namespace: msg.namespace, baseline_at: now } satisfies DashboardMessage)
      );
      log(`Baseline set for namespace ${msg.namespace}`);
      break;
    }

    case "clear_baseline": {
      deleteBaseline.run(msg.namespace);
      deleteBaselineOffsets.run(msg.namespace);
      server.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_cleared", namespace: msg.namespace } satisfies DashboardMessage)
      );
      log(`Baseline cleared for namespace ${msg.namespace}`);
      break;
    }

    case "subscribe_docker_logs": {
      subscribeDockerLogs(msg.containerId, ws);
      log(`Dashboard subscribed to Docker logs for ${msg.containerId}`);
      break;
    }

    case "unsubscribe_docker_logs": {
      unsubscribeDockerLogs(msg.containerId, ws);
      log(`Dashboard unsubscribed from Docker logs for ${msg.containerId}`);
      break;
    }

    case "stop_docker_container": {
      const container = dockerContainers.get(msg.containerId);
      const name = container?.name ?? msg.containerId;
      log(`Stopping Docker container ${name}`);
      runDockerCommand(["stop", name]).then(() => {
        log(`Docker container ${name} stopped`);
        // Event stream will pick up the state change
      });
      break;
    }
  }
}

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "127.0.0.1",

  routes: {
    "/": () => new Response(dashboardHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),

    "/health": () => {
      const peers = getAllPeers();
      const namespaces = [...new Set(peers.map((p) => p.namespace))];
      return Response.json({
        status: "ok",
        peers: peers.length,
        namespaces,
      });
    },

    "/api/list-peers": {
      async POST(req) {
        const body = (await req.json()) as {
          scope: string;
          namespace?: string;
          cwd?: string;
          git_root?: string | null;
          exclude_id?: string;
        };
        let peers: Peer[];
        if (body.scope === "namespace" && body.namespace) {
          peers = selectPeersByNamespace.all(body.namespace) as Peer[];
        } else {
          peers = getAllPeers();
        }
        if (body.exclude_id) {
          peers = peers.filter((p) => p.id !== body.exclude_id);
        }
        peers = peers.filter((p) => isProcessAlive(p.pid));
        return Response.json(peers);
      },
    },

    "/api/send-message": {
      async POST(req) {
        const body = (await req.json()) as {
          from_id: string;
          to_id: string;
          text: string;
        };
        const target = getPeer(body.to_id);
        if (!target) {
          return Response.json({
            ok: false,
            error: `Peer ${body.to_id} not found`,
          });
        }

        const now = new Date().toISOString();
        deliverOrQueue(body.from_id, body.to_id, body.text, now);
        return Response.json({ ok: true });
      },
    },

    "/api/status": () => {
      const peers = getAllPeers().filter((p) => isProcessAlive(p.pid));
      return Response.json({ peers, namespaces: namespacesFromPeers(peers) });
    },

    "/api/messages": {
      GET(req) {
        const url = new URL(req.url);
        const peer1 = url.searchParams.get("peer1");
        const peer2 = url.searchParams.get("peer2");
        if (!peer1) {
          return Response.json({ error: "peer1 required" }, { status: 400 });
        }
        let messages: StoredMessage[];
        if (!peer2 || peer2 === "*") {
          messages = selectPeerMessages.all(peer1, peer1) as StoredMessage[];
        } else {
          messages = selectConversation.all(peer1, peer2, peer2, peer1) as StoredMessage[];
        }
        return Response.json({ messages });
      },
    },

    "/api/logs": {
      async GET(req) {
        const url = new URL(req.url);
        const peerId = url.searchParams.get("peer_id");
        if (!peerId) return Response.json({ error: "peer_id required" }, { status: 400 });
        const svc = selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
        if (!svc?.log_file) return Response.json({ error: "No log file registered" }, { status: 404 });
        const lines = parseInt(url.searchParams.get("lines") ?? "100", 10);
        const level = url.searchParams.get("level") as LogLevel | null;
        try {
          let parsed = await readTailLines(svc.log_file, svc.log_format);
          if (level) {
            const LOG_LEVEL_ORDER: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
            const maxIdx = LOG_LEVEL_ORDER.indexOf(level);
            if (maxIdx >= 0) parsed = parsed.filter((l) => LOG_LEVEL_ORDER.indexOf(l.level) <= maxIdx);
          }
          return Response.json({ lines: parsed.slice(-lines) });
        } catch {
          return Response.json({ error: "Could not read log file" }, { status: 500 });
        }
      },
    },

    "/api/log-stats": {
      async GET(req) {
        const url = new URL(req.url);
        const peerId = url.searchParams.get("peer_id");
        if (!peerId) return Response.json({ error: "peer_id required" }, { status: 400 });
        const svc = selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
        if (!svc?.log_file) return Response.json({ error: "No log file" }, { status: 404 });
        const peer = getPeer(peerId);
        const ns = peer?.namespace;
        const baselineOffset = ns
          ? (selectBaselineOffset.get(ns, peerId) as { file_offset: number } | undefined)
          : undefined;
        try {
          const lines = baselineOffset
            ? await readLinesFromOffset(svc.log_file, svc.log_format, baselineOffset.file_offset)
            : await readTailLines(svc.log_file, svc.log_format);
          const stats = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0, total: lines.length };
          for (const l of lines) stats[l.level]++;
          return Response.json(stats);
        } catch {
          return Response.json({ error: "Could not read log file" }, { status: 500 });
        }
      },
    },

    "/api/services": () => {
      const services = selectAllServices.all() as ServiceInfo[];
      return Response.json({ services });
    },

    "/api/messages/clear": {
      POST() {
        deleteAllMessages.run();
        server.publish(
          "dashboard",
          JSON.stringify({ type: "messages_cleared" } satisfies DashboardMessage)
        );
        return Response.json({ ok: true });
      },
    },

    "/api/docker/containers": () => {
      return Response.json({
        containers: Array.from(dockerContainers.values()),
      });
    },

    "/api/docker/log-stats": {
      GET(req) {
        const url = new URL(req.url);
        const containerId = url.searchParams.get("container_id");
        if (containerId) {
          const stats = dockerLogStats.get(containerId);
          return stats
            ? Response.json(stats)
            : Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({
          logStats: Array.from(dockerLogStats.values()),
        });
      },
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/peer") {
      const ns = url.searchParams.get("namespace") ?? "default";
      const success = server.upgrade(req, {
        data: { kind: "peer", peerId: null, namespace: ns } as PeerWSData,
      });
      return success
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 500 });
    }

    if (url.pathname === "/ws/dashboard") {
      const success = server.upgrade(req, {
        data: { kind: "dashboard" } as DashboardWSData,
      });
      return success
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    idleTimeout: 120,

    open(ws) {
      if (ws.data.kind === "dashboard") {
        ws.subscribe("dashboard");
        const peers = getAllPeers().filter((p) => isProcessAlive(p.pid));
        const stats = getMessageStats();
        const services = selectAllServices.all() as ServiceInfo[];
        const baselines = selectAllBaselines.all() as LogBaseline[];
        ws.send(
          JSON.stringify({
            type: "snapshot",
            peers,
            namespaces: namespacesFromPeers(peers),
            peer_stats: stats.peer_stats,
            pair_stats: stats.pair_stats,
            services,
            baselines,
          } satisfies DashboardMessage)
        );
        // Send Docker snapshot if available
        if (dockerAvailable && dockerContainers.size > 0) {
          ws.send(
            JSON.stringify({
              type: "docker_snapshot",
              containers: Array.from(dockerContainers.values()),
              logStats: Array.from(dockerLogStats.values()),
            } satisfies DashboardMessage)
          );
        }
      }
    },

    message(ws, message) {
      if (ws.data.kind === "peer") {
        try {
          const data = JSON.parse(String(message)) as ClientMessage;
          handlePeerMessage(
            ws as import("bun").ServerWebSocket<PeerWSData>,
            data,
            server
          );
        } catch (e) {
          log(`Invalid message: ${e}`);
        }
      } else if (ws.data.kind === "dashboard") {
        try {
          const data = JSON.parse(String(message)) as DashboardClientMessage;
          handleDashboardMessage(data, ws as import("bun").ServerWebSocket<WSData>);
        } catch (e) {
          log(`Invalid dashboard message: ${e}`);
        }
      }
    },

    close(ws) {
      if (ws.data.kind === "dashboard") {
        unsubscribeAllLogs(ws as import("bun").ServerWebSocket<WSData>);
        unsubscribeAllDockerLogs(ws as import("bun").ServerWebSocket<WSData>);
      }

      if (ws.data.kind === "peer" && ws.data.peerId) {
        const peerId = ws.data.peerId;
        const namespace = ws.data.namespace;
        peerSockets.delete(peerId);
        markConnected.run(0, peerId);

        server.publish(
          `ns:${namespace}`,
          JSON.stringify({ type: "peer_left", peer_id: peerId })
        );
        server.publish(
          "dashboard",
          JSON.stringify({
            type: "peer_left",
            peer_id: peerId,
            namespace,
          } satisfies DashboardMessage)
        );

        log(`Peer ${peerId} disconnected (ns: ${namespace})`);

        // Grace period: delete after 30s if still disconnected
        setTimeout(() => {
          const current = getPeer(peerId);
          if (current && !current.connected) {
            deleteServiceByPeer.run(peerId);
            deletePeerStmt.run(peerId);
            log(`Peer ${peerId} cleaned up after grace period`);
          }
        }, GRACE_PERIOD_MS);
      }
    },
  },
});

log(`Listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
