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

import type {
  ClientMessage,
  DashboardClientMessage,
  DashboardMessage,
  Peer,
  ServiceInfo,
  LogBaseline,
  LogLevel,
  StoredMessage,
} from "./shared/types.ts";
import { renderDashboardPage } from "./dashboard/views/page.ts";

import { initDatabase, type BrokerContext, type PeerWSData, type DashboardWSData, type WSData } from "./broker/db.ts";
import {
  createPeerStatements,
  createMessageStatements,
  getAllPeers,
  getPeer,
  isProcessAlive,
  namespacesFromPeers,
  getMessageStats,
  deliverOrQueue,
  cleanStalePeers,
  log,
} from "./broker/peers.ts";
import { createServiceStatements, pollServiceHealth } from "./broker/services.ts";
import {
  createDockerState,
  createDockerLogSubscriptionState,
  initDockerMonitoring,
  runDockerCommand,
  unsubscribeAllDockerLogs,
} from "./broker/docker.ts";
import {
  createLogSubscriptionState,
  readTailLines,
  readLinesFromOffset,
  unsubscribeAllLogs,
} from "./broker/logs.ts";
import {
  handlePeerMessage,
  handleDashboardMessage,
  createCmuxState,
  pollCmuxStatus,
  scanReposInDirectory,
  type DashboardDeps,
} from "./broker/handlers.ts";

// --- Configuration ---

const dashboardHtml = renderDashboardPage();
const PORT = parseInt(process.env.CLAUDE_HIVEMIND_PORT ?? "7899", 10);
const DB_PATH =
  process.env.CLAUDE_HIVEMIND_DB ?? `${process.env.HOME}/.claude-hivemind.db`;
const GRACE_PERIOD_MS = 30_000;

// --- Database & statements ---

const db = initDatabase(DB_PATH);
const peerStmts = createPeerStatements(db);
const msgStmts = createMessageStatements(db);
const svcStmts = createServiceStatements(db);

// --- State ---

const peerSockets = new Map<string, import("bun").ServerWebSocket<WSData>>();
const dockerState = createDockerState();
const dockerLogSubs = createDockerLogSubscriptionState();
const logSubState = createLogSubscriptionState();
const cmuxState = createCmuxState();

// --- HTTP + WebSocket server ---

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "127.0.0.1",

  routes: {
    "/": () => new Response(dashboardHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),

    "/health": () => {
      const peers = getAllPeers(peerStmts);
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
          peers = peerStmts.selectPeersByNamespace.all(body.namespace) as Peer[];
        } else {
          peers = getAllPeers(peerStmts);
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
        const target = getPeer(peerStmts, body.to_id);
        if (!target) {
          return Response.json({
            ok: false,
            error: `Peer ${body.to_id} not found`,
          });
        }

        const now = new Date().toISOString();
        deliverOrQueue(ctx, peerStmts, msgStmts, body.from_id, body.to_id, body.text, now);
        return Response.json({ ok: true });
      },
    },

    "/api/status": () => {
      const peers = getAllPeers(peerStmts).filter((p) => isProcessAlive(p.pid));
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
          messages = msgStmts.selectPeerMessages.all(peer1, peer1) as StoredMessage[];
        } else {
          messages = msgStmts.selectConversation.all(peer1, peer2, peer2, peer1) as StoredMessage[];
        }
        return Response.json({ messages });
      },
    },

    "/api/logs": {
      async GET(req) {
        const url = new URL(req.url);
        const peerId = url.searchParams.get("peer_id");
        if (!peerId) return Response.json({ error: "peer_id required" }, { status: 400 });
        const svc = svcStmts.selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
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
        const svc = svcStmts.selectServiceByPeer.get(peerId) as ServiceInfo | undefined;
        if (!svc?.log_file) return Response.json({ error: "No log file" }, { status: 404 });
        const peer = getPeer(peerStmts, peerId);
        const ns = peer?.namespace;
        const baselineOffset = ns
          ? (svcStmts.selectBaselineOffset.get(ns, peerId) as { file_offset: number } | undefined)
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
      const services = svcStmts.selectAllServices.all() as ServiceInfo[];
      return Response.json({ services });
    },

    "/api/messages/clear": {
      POST() {
        msgStmts.deleteAllMessages.run();
        server.publish(
          "dashboard",
          JSON.stringify({ type: "messages_cleared" } satisfies DashboardMessage)
        );
        return Response.json({ ok: true });
      },
    },

    "/api/docker/containers": () => {
      return Response.json({
        containers: Array.from(dockerState.containers.values()),
      });
    },

    "/api/docker/log-stats": {
      GET(req) {
        const url = new URL(req.url);
        const containerId = url.searchParams.get("container_id");
        if (containerId) {
          const stats = dockerState.logStats.get(containerId);
          return stats
            ? Response.json(stats)
            : Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({
          logStats: Array.from(dockerState.logStats.values()),
        });
      },
    },

    "/api/docker/start": {
      async POST(req) {
        const url = new URL(req.url);
        const name = url.searchParams.get("name");
        if (!name) return Response.json({ error: "name required" }, { status: 400 });
        log(`Starting Docker container ${name}`);
        const out = await runDockerCommand(["start", name]);
        if (out !== null) {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "Failed to start" }, { status: 500 });
      },
    },

    "/api/cmux/status": () => {
      return Response.json({
        available: cmuxState.available,
        workspaces: cmuxState.workspaces,
      });
    },

    "/api/scan-repos": {
      GET(req) {
        const url = new URL(req.url);
        const dir = url.searchParams.get("dir");
        if (!dir) return Response.json({ error: "dir required" }, { status: 400 });
        const repos = scanReposInDirectory(dir);
        return Response.json({ repos });
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
        const peers = getAllPeers(peerStmts).filter((p) => isProcessAlive(p.pid));
        const stats = getMessageStats(msgStmts);
        const services = svcStmts.selectAllServices.all() as ServiceInfo[];
        const baselines = svcStmts.selectAllBaselines.all() as LogBaseline[];
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
        if (dockerState.available && dockerState.containers.size > 0) {
          ws.send(
            JSON.stringify({
              type: "docker_snapshot",
              containers: Array.from(dockerState.containers.values()),
              logStats: Array.from(dockerState.logStats.values()),
            } satisfies DashboardMessage)
          );
        }
        if (cmuxState.available) {
          ws.send(
            JSON.stringify({
              type: "cmux_status",
              available: cmuxState.available,
              workspaces: cmuxState.workspaces,
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
            ctx,
            peerStmts,
            msgStmts,
            svcStmts,
          );
        } catch (e) {
          log(`Invalid message: ${e}`);
        }
      } else if (ws.data.kind === "dashboard") {
        try {
          const data = JSON.parse(String(message)) as DashboardClientMessage;
          handleDashboardMessage(
            data,
            ws as import("bun").ServerWebSocket<WSData>,
            dashboardDeps,
          );
        } catch (e) {
          log(`Invalid dashboard message: ${e}`);
        }
      }
    },

    close(ws) {
      if (ws.data.kind === "dashboard") {
        unsubscribeAllLogs(logSubState, ws as import("bun").ServerWebSocket<WSData>);
        unsubscribeAllDockerLogs(dockerLogSubs, ws as import("bun").ServerWebSocket<WSData>);
      }

      if (ws.data.kind === "peer" && ws.data.peerId) {
        const peerId = ws.data.peerId;
        const namespace = ws.data.namespace;
        peerSockets.delete(peerId);
        peerStmts.markConnected.run(0, peerId);

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

        setTimeout(() => {
          const current = getPeer(peerStmts, peerId);
          if (current && !current.connected) {
            svcStmts.deleteServiceByPeer.run(peerId);
            peerStmts.deletePeerStmt.run(peerId);
            log(`Peer ${peerId} cleaned up after grace period`);
          }
        }, GRACE_PERIOD_MS);
      }
    },
  },
});

// --- Assemble context (after Bun.serve creates server) ---

const ctx: BrokerContext = { server, peerSockets };

const dashboardDeps: DashboardDeps = {
  ctx, peerStmts, msgStmts, svcStmts,
  dockerState, dockerLogSubs, logSubState, cmuxState,
};

// --- Start background tasks ---

cleanStalePeers(peerStmts, msgStmts, svcStmts);
setInterval(() => cleanStalePeers(peerStmts, msgStmts, svcStmts), 30_000);
setInterval(() => pollServiceHealth(ctx, peerStmts, svcStmts), 15_000);

initDockerMonitoring(ctx, dockerState);

pollCmuxStatus(ctx, cmuxState).then(() => {
  if (cmuxState.available) log("cmux detected — terminal orchestration enabled");
  else log("cmux not available — launch buttons disabled");
});
setInterval(() => pollCmuxStatus(ctx, cmuxState), 15_000);

log(`Listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
