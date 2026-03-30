/**
 * Log parsing, file-based log tailing, and log subscriptions.
 */

import type { ServiceInfo, LogLine, LogLevel, DashboardMessage } from "../shared/types.ts";
import { WS_OPEN, type WSData } from "./db.ts";
import type { ServiceStatements } from "./services.ts";
import { getPeer, log, type PeerStatements } from "./peers.ts";

export const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SPRING_LOG_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*|[\d]{2}:\d{2}:\d{2}[,.\d]*)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(.*)$/;
export const PLAIN_LEVEL_RE = /\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/;

export function parseLogLine(raw: string, format: ServiceInfo["log_format"] | "auto"): LogLine {
  const clean = raw.replace(ANSI_RE, "");

  if (format === "json" || format === "auto") {
    try {
      const obj = JSON.parse(clean);
      if (obj && typeof obj === "object" && (obj.message || obj.msg || format === "json")) {
        return {
          timestamp: obj.timestamp ?? obj["@timestamp"] ?? new Date().toISOString(),
          level: ((obj.level ?? obj.severity ?? "INFO") as string).toUpperCase() as LogLevel,
          message: obj.message ?? obj.msg ?? clean,
          raw: clean,
        };
      }
    } catch { /* fall through */ }
  }

  if (format === "spring" || format === "auto") {
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

export async function readLinesFromOffset(filePath: string, format: ServiceInfo["log_format"], fromOffset: number, maxBytes = MAX_LOG_READ_BYTES): Promise<LogLine[]> {
  const file = Bun.file(filePath);
  const size = file.size;
  if (fromOffset >= size) return [];
  const readFrom = Math.max(fromOffset, size - maxBytes);
  const text = await file.slice(readFrom, size).text();
  const rawLines = text.split("\n").filter((l) => l.length > 0);
  return rawLines.map((l) => parseLogLine(l, format));
}

export async function readTailLines(filePath: string, format: ServiceInfo["log_format"]): Promise<LogLine[]> {
  return readLinesFromOffset(filePath, format, 0);
}

const INITIAL_LOG_LINES = 200;

export class LogTailer {
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

export interface LogSubscriptionState {
  subscriptions: Map<string, {
    tailer: LogTailer;
    subscribers: Set<import("bun").ServerWebSocket<WSData>>;
  }>;
}

export function createLogSubscriptionState(): LogSubscriptionState {
  return { subscriptions: new Map() };
}

export async function subscribeLogs(
  state: LogSubscriptionState,
  peerStmts: PeerStatements,
  svcStmts: ServiceStatements,
  peerId: string,
  ws: import("bun").ServerWebSocket<WSData>,
): Promise<void> {
  const svc = svcStmts.selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
  if (!svc?.log_file) return;

  const peer = getPeer(peerStmts, peerId);
  const ns = peer?.namespace;
  const baselineOffset = ns
    ? (svcStmts.selectBaselineOffset.get(ns, peerId) as { file_offset: number } | undefined)
    : undefined;

  const existing = state.subscriptions.get(peerId);
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

  state.subscriptions.set(peerId, { tailer, subscribers });
}

export function unsubscribeLogs(state: LogSubscriptionState, peerId: string, ws: import("bun").ServerWebSocket<WSData>): void {
  const sub = state.subscriptions.get(peerId);
  if (!sub) return;
  sub.subscribers.delete(ws);
  if (sub.subscribers.size === 0) {
    sub.tailer.stop();
    state.subscriptions.delete(peerId);
  }
}

export function unsubscribeAllLogs(state: LogSubscriptionState, ws: import("bun").ServerWebSocket<WSData>): void {
  for (const [peerId, sub] of state.subscriptions) {
    sub.subscribers.delete(ws);
    if (sub.subscribers.size === 0) {
      sub.tailer.stop();
      state.subscriptions.delete(peerId);
    }
  }
}
