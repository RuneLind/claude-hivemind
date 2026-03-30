/**
 * WebSocket message handlers for peer and dashboard connections.
 * Also contains repo scanning and cmux status polling.
 */

import type {
  ClientMessage,
  BrokerMessage,
  DashboardMessage,
  DashboardClientMessage,
  Peer,
  ServiceInfo,
  CmuxWorkspace,
  ScannedRepo,
} from "../shared/types.ts";
import {
  DEFAULT_HEALTH_URL,
  DEFAULT_LOG_FORMAT,
  DASHBOARD_SENDER_ID,
} from "../shared/types.ts";
import { isCmuxAvailable, listWorkspaces, launchClaudeInstance } from "../cmux/client.ts";
import { readdirSync, statSync, readFileSync } from "node:fs";
import type { BrokerContext, PeerWSData, WSData } from "./db.ts";
import {
  generateId,
  getPeer,
  getAllPeers,
  isProcessAlive,
  namespacesFromPeers,
  getMessageStats,
  deliverOrQueue,
  log,
  type PeerStatements,
  type MessageStatements,
} from "./peers.ts";
import type { ServiceStatements } from "./services.ts";
import { pollServiceHealth } from "./services.ts";
import type { DockerState, DockerLogSubscriptionState } from "./docker.ts";
import { runDockerCommand, subscribeDockerLogs, unsubscribeDockerLogs } from "./docker.ts";
import type { LogSubscriptionState } from "./logs.ts";
import { subscribeLogs, unsubscribeLogs } from "./logs.ts";

const WS_OPEN = 1;
const SOURCE_DIR = `${process.env.HOME}/source`;

// --- cmux state ---

export interface CmuxState {
  available: boolean;
  workspaces: CmuxWorkspace[];
}

export function createCmuxState(): CmuxState {
  return { available: false, workspaces: [] };
}

export async function pollCmuxStatus(ctx: BrokerContext, state: CmuxState): Promise<void> {
  try {
    const [available, workspaces] = await Promise.all([
      isCmuxAvailable(),
      listWorkspaces().catch(() => [] as { id: string; name: string }[]),
    ]);
    const effectiveWorkspaces = available ? workspaces : [];
    const changed = available !== state.available ||
      JSON.stringify(effectiveWorkspaces) !== JSON.stringify(state.workspaces);
    state.available = available;
    state.workspaces = effectiveWorkspaces;
    if (changed) publishCmuxStatus(ctx, state);
  } catch {
    if (state.available) {
      state.available = false;
      state.workspaces = [];
      publishCmuxStatus(ctx, state);
    }
  }
}

function publishCmuxStatus(ctx: BrokerContext, state: CmuxState): void {
  ctx.publish(
    "dashboard",
    JSON.stringify({
      type: "cmux_status",
      available: state.available,
      workspaces: state.workspaces,
    } satisfies DashboardMessage)
  );
}

// --- repo scanning ---

export function scanReposInDirectory(dir: string): ScannedRepo[] {
  let fullPath = dir.startsWith("/") ? dir : `${SOURCE_DIR}/${dir}`;

  let entries: string[];
  try { entries = readdirSync(fullPath); } catch { return []; }

  const repos: ScannedRepo[] = [];
  for (const entry of entries) {
    const entryPath = `${fullPath}/${entry}`;
    try {
      if (!statSync(entryPath).isDirectory()) continue;
      statSync(`${entryPath}/.git`);
    } catch { continue; }

    let branch: string | null = null;
    try {
      let gitDir = `${entryPath}/.git`;
      if (!statSync(gitDir).isDirectory()) {
        const m = readFileSync(gitDir, "utf-8").trim().match(/^gitdir:\s*(.+)$/);
        if (m) gitDir = m[1];
      }
      const head = readFileSync(`${gitDir}/HEAD`, "utf-8").trim();
      const match = head.match(/^ref: refs\/heads\/(.+)$/);
      branch = match ? match[1] : head.slice(0, 8);
    } catch { /* no branch info */ }
    repos.push({ name: entry, path: entryPath, branch });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Peer message handler ---

export function handlePeerMessage(
  ws: import("bun").ServerWebSocket<PeerWSData>,
  msg: ClientMessage,
  ctx: BrokerContext,
  peerStmts: PeerStatements,
  msgStmts: MessageStatements,
  svcStmts: ServiceStatements,
): void {
  switch (msg.type) {
    case "register": {
      const now = new Date().toISOString();
      peerStmts.deleteByPid.run(msg.pid);
      const id = generateId(peerStmts, msg.cwd);

      const saved = peerStmts.selectSavedSummary.get(msg.cwd) as { summary: string } | null;
      const summary = msg.summary || saved?.summary || "";

      peerStmts.insertPeer.run(
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

      ctx.peerSockets.set(id, ws as import("bun").ServerWebSocket<WSData>);

      const reply: BrokerMessage = {
        type: "registered",
        id,
        namespace: msg.namespace,
      };
      ws.send(JSON.stringify(reply));

      const queued = msgStmts.selectUndelivered.all(id) as import("../shared/types.ts").Message[];
      for (const m of queued) {
        const sender = getPeer(peerStmts, m.from_id);
        const deliverMsg: BrokerMessage = {
          type: "message",
          from_id: m.from_id,
          from_summary: sender?.summary ?? "",
          from_cwd: sender?.cwd ?? "",
          text: m.text,
          sent_at: m.sent_at,
        };
        ws.send(JSON.stringify(deliverMsg));
        msgStmts.markDelivered.run(m.id);
      }

      const peer = getPeer(peerStmts, id)!;
      const joinMsg = JSON.stringify({ type: "peer_joined", peer });
      ctx.publish(`ns:${msg.namespace}`, joinMsg);
      ctx.publish(
        "dashboard",
        JSON.stringify({
          type: "peer_joined",
          peer,
        } satisfies DashboardMessage)
      );

      ctx.log(`Peer ${id} registered (ns: ${msg.namespace}, cwd: ${msg.cwd})`);
      break;
    }

    case "set_summary": {
      if (!ws.data.peerId) return;
      peerStmts.updateSummary.run(msg.summary, ws.data.peerId);
      const peer = getPeer(peerStmts, ws.data.peerId);
      if (peer) {
        peerStmts.upsertSummary.run(peer.cwd, msg.summary, new Date().toISOString());
        const updateMsg = JSON.stringify({ type: "peer_updated", peer });
        ctx.publish(`ns:${ws.data.namespace}`, updateMsg);
        ctx.publish("dashboard", updateMsg);
      }
      break;
    }

    case "send_message": {
      if (!ws.data.peerId) return;
      const fromId = ws.data.peerId;

      const target = getPeer(peerStmts, msg.to);
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
      deliverOrQueue(ctx, peerStmts, msgStmts, fromId, msg.to, msg.text, now);

      const stats = getMessageStats(msgStmts);
      ctx.publish(
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
        peers = peerStmts.selectPeersByNamespace.all(ws.data.namespace) as Peer[];
      } else {
        peers = getAllPeers(peerStmts);
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
      peerStmts.updateLastSeen.run(new Date().toISOString(), ws.data.peerId);
      break;
    }

    case "register_service": {
      if (!ws.data.peerId) return;
      const healthUrl = msg.health_url || DEFAULT_HEALTH_URL;
      const logFormat = msg.log_format || DEFAULT_LOG_FORMAT;
      svcStmts.upsertService.run(
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
      ctx.publish(
        "dashboard",
        JSON.stringify({ type: "service_update", service } satisfies DashboardMessage)
      );
      ctx.log(`Service registered for ${ws.data.peerId} on port ${msg.port}`);
      break;
    }
  }
}

// --- Dashboard message handler ---

export function handleDashboardMessage(
  msg: DashboardClientMessage,
  ws: import("bun").ServerWebSocket<WSData>,
  ctx: BrokerContext,
  peerStmts: PeerStatements,
  msgStmts: MessageStatements,
  svcStmts: ServiceStatements,
  dockerState: DockerState,
  dockerLogSubs: DockerLogSubscriptionState,
  logSubState: LogSubscriptionState,
  cmuxState: CmuxState,
): void {
  switch (msg.type) {
    case "send_to_peer": {
      const peer = getPeer(peerStmts, msg.peer_id);
      if (!peer) return;
      const targetWs = ctx.peerSockets.get(msg.peer_id);
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
        ctx.log(`Dashboard sent message to ${msg.peer_id}`);
      }
      break;
    }

    case "subscribe_logs": {
      subscribeLogs(logSubState, peerStmts, svcStmts, msg.peer_id, ws).catch((e) => ctx.log(`Log subscribe error: ${e}`));
      ctx.log(`Dashboard subscribed to logs for ${msg.peer_id}`);
      break;
    }

    case "unsubscribe_logs": {
      unsubscribeLogs(logSubState, msg.peer_id, ws);
      ctx.log(`Dashboard unsubscribed from logs for ${msg.peer_id}`);
      break;
    }

    case "set_baseline": {
      const now = new Date().toISOString();
      svcStmts.upsertBaseline.run(msg.namespace, now);
      svcStmts.deleteBaselineOffsets.run(msg.namespace);
      const nsPeers = peerStmts.selectPeersByNamespace.all(msg.namespace) as Peer[];
      for (const p of nsPeers) {
        const svc = svcStmts.selectServiceByPeer.get(p.id) as ServiceInfo | undefined;
        if (svc?.log_file) {
          try {
            const size = Bun.file(svc.log_file).size;
            svcStmts.upsertBaselineOffset.run(msg.namespace, p.id, size);
          } catch { /* file may not exist yet */ }
        }
      }
      ctx.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_set", namespace: msg.namespace, baseline_at: now } satisfies DashboardMessage)
      );
      ctx.log(`Baseline set for namespace ${msg.namespace}`);
      break;
    }

    case "clear_baseline": {
      svcStmts.deleteBaseline.run(msg.namespace);
      svcStmts.deleteBaselineOffsets.run(msg.namespace);
      ctx.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_cleared", namespace: msg.namespace } satisfies DashboardMessage)
      );
      ctx.log(`Baseline cleared for namespace ${msg.namespace}`);
      break;
    }

    case "subscribe_docker_logs": {
      subscribeDockerLogs(dockerState, dockerLogSubs, msg.containerId, ws);
      ctx.log(`Dashboard subscribed to Docker logs for ${msg.containerId}`);
      break;
    }

    case "unsubscribe_docker_logs": {
      unsubscribeDockerLogs(dockerLogSubs, msg.containerId, ws);
      ctx.log(`Dashboard unsubscribed from Docker logs for ${msg.containerId}`);
      break;
    }

    case "stop_docker_container": {
      const container = dockerState.containers.get(msg.containerId);
      const name = container?.name ?? msg.containerId;
      ctx.log(`Stopping Docker container ${name}`);
      runDockerCommand(["stop", name]).then(() => {
        ctx.log(`Docker container ${name} stopped`);
      });
      break;
    }

    case "stop_service": {
      const svc = svcStmts.selectServiceByPeer.get(msg.peer_id) as ServiceInfo | undefined;
      if (!svc) break;
      ctx.log(`Stopping service on port ${svc.port} (peer: ${msg.peer_id})`);
      (async () => {
        try {
          const killProc = Bun.spawn(["sh", "-c", `lsof -i :${svc.port} -t | xargs kill -9 2>/dev/null`], {
            stdout: "pipe", stderr: "pipe",
          });
          await killProc.exited;
          ctx.log(`Killed processes on port ${svc.port}`);
          setTimeout(() => pollServiceHealth(ctx, peerStmts, svcStmts), 500);
        } catch (e) {
          ctx.log(`Error stopping service on port ${svc.port}: ${e}`);
        }
      })();
      break;
    }

    case "launch_claude_instance": {
      if (!cmuxState.available) {
        ws.send(JSON.stringify({
          type: "cmux_launch_result",
          ok: false,
          error: "cmux is not running",
        } satisfies DashboardMessage));
        break;
      }
      ctx.log(`Launching Claude Code instance in ${msg.directory} via cmux`);
      (async () => {
        try {
          const { workspaceId } = await launchClaudeInstance({
            directory: msg.directory,
            name: msg.name,
            prompt: msg.prompt,
          });
          ctx.log(`Launched cmux workspace ${workspaceId} for ${msg.directory}`);
          ws.send(JSON.stringify({
            type: "cmux_launch_result",
            ok: true,
            workspaceId,
          } satisfies DashboardMessage));
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          ctx.log(`Failed to launch Claude instance: ${error}`);
          ws.send(JSON.stringify({
            type: "cmux_launch_result",
            ok: false,
            error,
          } satisfies DashboardMessage));
        }
      })();
      break;
    }

    case "launch_claude_instances": {
      if (!cmuxState.available) {
        ws.send(JSON.stringify({
          type: "cmux_launch_result",
          ok: false,
          error: "cmux is not running",
        } satisfies DashboardMessage));
        break;
      }
      const dirs = msg.directories;
      const sharedPrompt = msg.prompt;
      ctx.log(`Launching ${dirs.length} Claude Code instances via cmux`);
      (async () => {
        for (const { directory, name } of dirs) {
          try {
            const { workspaceId } = await launchClaudeInstance({ directory, name, prompt: sharedPrompt });
            ctx.log(`Launched cmux workspace ${workspaceId} for ${directory}`);
            ws.send(JSON.stringify({
              type: "cmux_launch_result",
              ok: true,
              workspaceId,
            } satisfies DashboardMessage));
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            ctx.log(`Failed to launch instance in ${directory}: ${error}`);
            ws.send(JSON.stringify({
              type: "cmux_launch_result",
              ok: false,
              error: `${name ?? directory}: ${error}`,
            } satisfies DashboardMessage));
          }
        }
      })();
      break;
    }

    case "scan_repos": {
      const repos = scanReposInDirectory(msg.directory);
      ws.send(JSON.stringify({
        type: "scan_repos_result",
        repos,
      } satisfies DashboardMessage));
      break;
    }

  }
}
