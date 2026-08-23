/**
 * Docker container monitoring: polling, event stream, log tailing, subscriptions.
 */

import type { DockerContainer, DockerContainerLogStats, LogLine, DashboardMessage } from "../shared/types.ts";
import { WS_OPEN, type BrokerContext, type WSData } from "./db.ts";
import { log } from "./peers.ts";
import { ANSI_RE, PLAIN_LEVEL_RE, parseLogLine } from "./logs.ts";

const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+(.*)/;

export interface DockerState {
  containers: Map<string, DockerContainer>;
  logStats: Map<string, DockerContainerLogStats>;
  available: boolean;
  polling: boolean;
  eventProc: ReturnType<typeof Bun.spawn> | null;
  eventReader: ReadableStreamDefaultReader<Uint8Array> | null;
  eventRestartTimer: ReturnType<typeof setTimeout> | null;
  initialized: boolean;
  shuttingDown: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  logStatsTimer: ReturnType<typeof setInterval> | null;
  reprobeTimer: ReturnType<typeof setInterval> | null;
  // Skip publish when unchanged
  lastContainersJson: string;
  lastLogStatsJson: string;
}

export function createDockerState(): DockerState {
  return {
    containers: new Map(),
    logStats: new Map(),
    available: false,
    polling: false,
    eventProc: null,
    eventReader: null,
    eventRestartTimer: null,
    initialized: false,
    shuttingDown: false,
    pollTimer: null,
    logStatsTimer: null,
    reprobeTimer: null,
    lastContainersJson: "",
    lastLogStatsJson: "",
  };
}

export async function runDockerCommand(args: string[], timeoutMs = 10_000, mergeStderr = false): Promise<string | null> {
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

async function pollDockerContainers(ctx: BrokerContext, state: DockerState): Promise<void> {
  if (!state.available || state.polling) return;
  state.polling = true;
  try {
    const lsOut = await runDockerCommand(["compose", "ls", "--format", "json"]);
    if (lsOut === null) {
      // docker command failed — treat the daemon as gone. The periodic
      // re-probe (docker version) will flip availability back on when it
      // returns, which also restarts the event stream.
      if (state.available) {
        state.available = false;
        log("Docker became unavailable — pausing container monitoring");
      }
      state.polling = false;
      return;
    }
    if (!lsOut) { state.polling = false; return; }

    let projects: DockerComposeProject[];
    try { projects = JSON.parse(lsOut); } catch { projects = []; }
    if (projects.length === 0) {
      if (state.containers.size > 0) {
        state.containers.clear();
        state.logStats.clear();
        ctx.server.publish("dashboard", JSON.stringify({
          type: "docker_update",
          containers: [],
        } satisfies DashboardMessage));
      }
      return;
    }

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

    const statsMap = new Map<string, DockerStatsEntry>();
    const statsOut = await runDockerCommand(["stats", "--no-stream", "--format", "json"]);
    if (statsOut) {
      for (const s of parseDockerJsonLines<DockerStatsEntry>(statsOut)) {
        statsMap.set(s.ID?.slice(0, 12), s);
        statsMap.set(s.Name, s);
      }
    }

    const newIds = new Set<string>();
    for (const c of allContainers) {
      const shortId = c.ID?.slice(0, 12) ?? c.ID;
      const stats = statsMap.get(shortId) || statsMap.get(c.Name);
      const container: DockerContainer = {
        id: shortId,
        name: c.Name,
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
      state.containers.set(shortId, container);
      newIds.add(shortId);
    }

    for (const id of state.containers.keys()) {
      if (!newIds.has(id)) {
        state.containers.delete(id);
        state.logStats.delete(id);
      }
    }

    const containers = Array.from(state.containers.values());
    const json = JSON.stringify(containers);
    if (json !== state.lastContainersJson) {
      state.lastContainersJson = json;
      ctx.server.publish("dashboard", JSON.stringify({
        type: "docker_update",
        containers,
      } satisfies DashboardMessage));
    }
  } catch (e) {
    log(`Docker poll error: ${e}`);
  } finally {
    state.polling = false;
  }
}

async function pollDockerLogStats(ctx: BrokerContext, state: DockerState): Promise<void> {
  if (!state.available) return;
  const running = Array.from(state.containers.values()).filter((c) => c.state === "running");
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
        const m = line.match(PLAIN_LEVEL_RE);
        if (m?.[1] === "ERROR") errorCount++;
        else if (m?.[1] === "WARN") warnCount++;
      }
      const stat: DockerContainerLogStats = {
        containerId: c.id,
        errorCount,
        warnCount,
        totalLines: lines.length,
      };
      state.logStats.set(c.id, stat);
      results.push(stat);
    })
  );

  if (results.length > 0) {
    const json = JSON.stringify(results);
    if (json !== state.lastLogStatsJson) {
      state.lastLogStatsJson = json;
      ctx.server.publish("dashboard", JSON.stringify({
        type: "docker_log_stats",
        logStats: results,
      } satisfies DashboardMessage));
    }
  }
}

function startDockerEventStream(ctx: BrokerContext, state: DockerState): void {
  if (!state.available || state.eventProc || state.shuttingDown) return;

  // Only one restart may be pending at a time.
  if (state.eventRestartTimer) {
    clearTimeout(state.eventRestartTimer);
    state.eventRestartTimer = null;
  }

  try {
    state.eventProc = Bun.spawn(
      ["docker", "events", "--format", "json", "--filter", "type=container"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const reader = (state.eventProc.stdout as ReadableStream<Uint8Array>).getReader() as any;
    state.eventReader = reader;
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

              if (["start", "stop", "die", "pause", "unpause", "kill", "destroy"].includes(action)) {
                log(`Docker event: ${name ?? containerId} ${action}`);
                setTimeout(() => pollDockerContainers(ctx, state), 500);

                ctx.server.publish("dashboard", JSON.stringify({
                  type: "docker_event",
                  containerId: containerId ?? "",
                  container: null,
                  event: action,
                } satisfies DashboardMessage));
              }
            } catch { /* skip unparseable event lines */ }
          }
        }
      } catch (e) {
        log(`Docker event stream error: ${e}`);
      } finally {
        state.eventReader = null;
        state.eventProc = null;
        // Only schedule a retry while docker is believed available and we
        // aren't shutting down; ensure at most one pending restart.
        if (state.available && !state.shuttingDown && !state.eventRestartTimer) {
          state.eventRestartTimer = setTimeout(() => {
            state.eventRestartTimer = null;
            startDockerEventStream(ctx, state);
          }, 5000);
        }
      }
    })();
  } catch {
    state.eventReader = null;
    state.eventProc = null;
  }
}

// --- Docker log tailing for dashboard subscriptions ---

class DockerLogTailer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private containerName: string;
  private onLines: (lines: LogLine[]) => void;
  private stopped = false;
  private readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  constructor(containerName: string, onLines: (lines: LogLine[]) => void) {
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
      this.readStream(this.proc.stdout as ReadableStream<Uint8Array>);
      this.readStream(this.proc.stderr as ReadableStream<Uint8Array>);
    } catch (e) {
      log(`DockerLogTailer start error for ${this.containerName}: ${e}`);
    }
  }

  private async readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader() as any;
    this.readers.add(reader);
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
    } finally {
      this.readers.delete(reader);
    }
  }

  private parseDockerLine(raw: string): LogLine {
    const clean = raw.replace(ANSI_RE, "");
    const tsMatch = clean.match(DOCKER_TS_RE);
    const message = tsMatch ? tsMatch[2]! : clean;
    const result = parseLogLine(message, "auto");
    if (tsMatch) result.timestamp = tsMatch[1]!;
    return result;
  }

  stop() {
    this.stopped = true;

    // Cancel the stdout/stderr readers so the underlying FDs are released even
    // if the process is slow to exit (prevents FD leaks across subscribe churn).
    for (const reader of this.readers) {
      try { reader.cancel(); } catch { /* already released */ }
    }
    this.readers.clear();

    const proc = this.proc;
    this.proc = null;
    if (!proc) return;

    // SIGTERM first, then SIGKILL fallback if it doesn't reap promptly.
    try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, 2000);
    proc.exited.then(() => clearTimeout(killTimer)).catch(() => clearTimeout(killTimer));
  }
}

export interface DockerLogSubscriptionState {
  subscriptions: Map<string, {
    tailer: DockerLogTailer;
    subscribers: Set<import("bun").ServerWebSocket<WSData>>;
  }>;
}

export function createDockerLogSubscriptionState(): DockerLogSubscriptionState {
  return { subscriptions: new Map() };
}

export function subscribeDockerLogs(
  state: DockerState,
  logSubs: DockerLogSubscriptionState,
  containerId: string,
  ws: import("bun").ServerWebSocket<WSData>,
): void {
  const container = state.containers.get(containerId);
  if (!container) return;

  const existing = logSubs.subscriptions.get(containerId);
  if (existing) {
    existing.subscribers.add(ws);
    return;
  }

  const subscribers = new Set<import("bun").ServerWebSocket<WSData>>([ws]);
  const tailer = new DockerLogTailer(container.name, (lines) => {
    const msg = JSON.stringify({
      type: "docker_log_lines",
      containerId,
      lines,
    } satisfies DashboardMessage);
    for (const sub of subscribers) {
      if (sub.readyState === WS_OPEN) sub.send(msg);
    }
  });

  logSubs.subscriptions.set(containerId, { tailer, subscribers });
}

export function unsubscribeDockerLogs(
  logSubs: DockerLogSubscriptionState,
  containerId: string,
  ws: import("bun").ServerWebSocket<WSData>,
): void {
  const sub = logSubs.subscriptions.get(containerId);
  if (!sub) return;
  sub.subscribers.delete(ws);
  if (sub.subscribers.size === 0) {
    sub.tailer.stop();
    logSubs.subscriptions.delete(containerId);
  }
}

export function unsubscribeAllDockerLogs(
  logSubs: DockerLogSubscriptionState,
  ws: import("bun").ServerWebSocket<WSData>,
): void {
  for (const [containerId, sub] of logSubs.subscriptions) {
    sub.subscribers.delete(ws);
    if (sub.subscribers.size === 0) {
      sub.tailer.stop();
      logSubs.subscriptions.delete(containerId);
    }
  }
}

async function reprobeDockerAvailability(ctx: BrokerContext, state: DockerState): Promise<void> {
  if (state.available || state.shuttingDown) return;
  const versionOut = await runDockerCommand(["version", "--format", "json"]);
  if (!versionOut) return;
  state.available = true;
  log("Docker became available — resuming container monitoring");
  await pollDockerContainers(ctx, state);
  await pollDockerLogStats(ctx, state);
  startDockerEventStream(ctx, state);
}

export async function initDockerMonitoring(ctx: BrokerContext, state: DockerState): Promise<void> {
  // Guard against running twice: clear any existing timers/stream first so a
  // re-init never doubles the polling intervals or leaks the event process.
  if (state.initialized) {
    log("Docker monitoring already initialized — restarting");
    stopDockerMonitor(state);
  }
  state.initialized = true;
  state.shuttingDown = false;

  // Periodic re-probe so monitoring re-enables itself when docker returns
  // after having flapped. Runs regardless of current availability.
  state.reprobeTimer = setInterval(() => reprobeDockerAvailability(ctx, state), 15_000);

  const versionOut = await runDockerCommand(["version", "--format", "json"]);
  if (!versionOut) {
    log("Docker not available — container monitoring disabled (will re-probe)");
    return;
  }
  state.available = true;
  log("Docker detected — container monitoring enabled");

  await pollDockerContainers(ctx, state);
  await pollDockerLogStats(ctx, state);
  startDockerEventStream(ctx, state);

  state.pollTimer = setInterval(() => pollDockerContainers(ctx, state), 10_000);
  state.logStatsTimer = setInterval(() => pollDockerLogStats(ctx, state), 30_000);
}

/**
 * Stop all docker monitoring: clears polling/re-probe intervals, cancels the
 * event-stream reader, kills the event process, and clears the restart timer.
 * Safe to call multiple times.
 */
export function stopDockerMonitor(state: DockerState): void {
  state.shuttingDown = true;
  state.available = false;
  state.initialized = false;

  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.logStatsTimer) { clearInterval(state.logStatsTimer); state.logStatsTimer = null; }
  if (state.reprobeTimer) { clearInterval(state.reprobeTimer); state.reprobeTimer = null; }
  if (state.eventRestartTimer) { clearTimeout(state.eventRestartTimer); state.eventRestartTimer = null; }

  if (state.eventReader) {
    try { state.eventReader.cancel(); } catch { /* already closed */ }
    state.eventReader = null;
  }
  if (state.eventProc) {
    try { state.eventProc.kill(); } catch { /* already exited */ }
    state.eventProc = null;
  }
}
