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
}

// Internal change-detection state (not part of public DockerState)
let lastDockerJson = "";
let lastDockerLogStatsJson = "";

export function createDockerState(): DockerState {
  return {
    containers: new Map(),
    logStats: new Map(),
    available: false,
    polling: false,
    eventProc: null,
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
    if (json !== lastDockerJson) {
      lastDockerJson = json;
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
    if (json !== lastDockerLogStatsJson) {
      lastDockerLogStatsJson = json;
      ctx.server.publish("dashboard", JSON.stringify({
        type: "docker_log_stats",
        logStats: results,
      } satisfies DashboardMessage));
    }
  }
}

function startDockerEventStream(ctx: BrokerContext, state: DockerState): void {
  if (!state.available || state.eventProc) return;

  try {
    state.eventProc = Bun.spawn(
      ["docker", "events", "--format", "json", "--filter", "type=container"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const reader = state.eventProc.stdout.getReader();
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
        state.eventProc = null;
        if (state.available) {
          setTimeout(() => startDockerEventStream(ctx, state), 5000);
        }
      }
    })();
  } catch {
    state.eventProc = null;
  }
}

// --- Docker log tailing for dashboard subscriptions ---

class DockerLogTailer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private containerName: string;
  private onLines: (lines: LogLine[]) => void;
  private stopped = false;

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
    const tsMatch = clean.match(DOCKER_TS_RE);
    const message = tsMatch ? tsMatch[2] : clean;
    const result = parseLogLine(message, "auto");
    if (tsMatch) result.timestamp = tsMatch[1];
    return result;
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
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

export async function initDockerMonitoring(ctx: BrokerContext, state: DockerState): Promise<void> {
  const versionOut = await runDockerCommand(["version", "--format", "json"]);
  if (!versionOut) {
    log("Docker not available — container monitoring disabled");
    return;
  }
  state.available = true;
  log("Docker detected — container monitoring enabled");

  await pollDockerContainers(ctx, state);
  await pollDockerLogStats(ctx, state);
  startDockerEventStream(ctx, state);

  setInterval(() => pollDockerContainers(ctx, state), 10_000);
  setInterval(() => pollDockerLogStats(ctx, state), 30_000);
}
