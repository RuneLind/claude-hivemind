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
  LaunchProfile,
} from "../shared/types.ts";
import {
  DEFAULT_HEALTH_URL,
  DEFAULT_LOG_FORMAT,
  DASHBOARD_SENDER_ID,
} from "../shared/types.ts";
import { isCmuxAvailable, listWorkspaces, launchClaudeInstance, launchOpenCodeInstance, renameWorkspace } from "../cmux/client.ts";
import { readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { WS_OPEN, type BrokerContext, type PeerWSData, type WSData } from "./db.ts";
import {
  generateId,
  getPeer,
  getAllPeers,
  isPeerLive,
  getMessageStats,
  deliverOrQueue,
  log,
  type PeerStatements,
  type MessageStatements,
} from "./peers.ts";
import type { ServiceStatements, ServicePollState } from "./services.ts";
import { pollServiceHealth } from "./services.ts";
import type { DockerState, DockerLogSubscriptionState } from "./docker.ts";
import { runDockerCommand, subscribeDockerLogs, unsubscribeDockerLogs } from "./docker.ts";
import type { LogSubscriptionState } from "./logs.ts";
import { subscribeLogs, unsubscribeLogs } from "./logs.ts";
const SOURCE_DIR = `${process.env.HOME}/source`;

// --- Boundary validation helpers ---
//
// Peer registrations and service registrations arrive over the WebSocket as
// untrusted input. The broker later reads back a registered log_file via the
// (unauthenticated) /api/logs route, so a peer that points log_file at an
// arbitrary readable file (~/.ssh/id_rsa, etc.) would turn that route into a
// local file disclosure. We constrain log_file to the peer's own project tree
// and bound the namespace to a safe charset/length.

const VALID_AGENT_TYPES = new Set(["claude-code", "opencode", "copilot"]);

/** Normalize an inbound agent_type to a known value; unknown/invalid -> claude-code. */
function normalizeAgentType(raw: unknown): string {
  return typeof raw === "string" && VALID_AGENT_TYPES.has(raw) ? raw : "claude-code";
}

/** Bound a namespace to a safe charset and length; invalid -> "default". */
function sanitizeNamespace(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return "default";
  return /^[A-Za-z0-9._\-/]+$/.test(trimmed) ? trimmed : "default";
}

/**
 * Returns true if `child` resolves to a path within (or equal to) `root`.
 * Both are resolved to canonical absolute paths first, defeating `..` escapes.
 */
function isWithin(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

/**
 * Validate a peer-supplied log_file: it must resolve to a path within the
 * peer's own git_root (or, failing that, its cwd). Returns the canonical path
 * if allowed, otherwise null (caller stores null = no log file).
 */
function validateLogFile(
  logFile: string | null | undefined,
  gitRoot: string | null | undefined,
  cwd: string,
): string | null {
  if (!logFile) return null;
  const roots = [gitRoot, cwd].filter((r): r is string => typeof r === "string" && r.length > 0);
  for (const root of roots) {
    if (isWithin(root, logFile)) return resolve(logFile);
  }
  return null;
}

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
  ctx.server.publish(
    "dashboard",
    JSON.stringify({
      type: "cmux_status",
      available: state.available,
      workspaces: state.workspaces,
    } satisfies DashboardMessage)
  );
}

// --- launch profiles ---

export function createProfileStatements(db: import("bun:sqlite").Database) {
  return {
    upsertProfile: db.prepare(
      `INSERT INTO launch_profiles (id, name, directory, repos, prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET directory = excluded.directory, repos = excluded.repos, prompt = excluded.prompt
       RETURNING id, created_at`
    ),
    deleteProfile: db.prepare(`DELETE FROM launch_profiles WHERE id = ?`),
    selectAllProfiles: db.prepare(`SELECT * FROM launch_profiles ORDER BY name`),
  };
}

export type ProfileStatements = ReturnType<typeof createProfileStatements>;

function rowToProfile(row: any): LaunchProfile {
  let repos: string[] = [];
  try {
    repos = JSON.parse(row.repos);
  } catch (e) {
    log(`Failed to parse repos for profile ${row.id}: ${e}`);
  }
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    repos,
    prompt: row.prompt,
    created_at: row.created_at,
  };
}

export function getAllProfiles(stmts: ProfileStatements): LaunchProfile[] {
  return (stmts.selectAllProfiles.all() as any[]).map(rowToProfile);
}

// --- repo scanning ---

export async function scanReposInDirectory(dir: string): Promise<ScannedRepo[]> {
  // Resolve the requested directory (absolute or relative to SOURCE_DIR) and
  // require it to stay within SOURCE_DIR. This blocks `../` escapes and
  // out-of-scope absolute paths from being scanned/disclosed.
  const requested = dir.startsWith("/") ? dir : `${SOURCE_DIR}/${dir}`;
  if (!isWithin(SOURCE_DIR, requested)) {
    log(`scan_repos rejected out-of-scope dir: ${dir}`);
    return [];
  }
  const fullPath = resolve(requested);

  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(fullPath, { withFileTypes: true }); } catch { return []; }

  const results = await Promise.all(entries.map(async (entry): Promise<ScannedRepo | null> => {
    if (!entry.isDirectory()) return null;
    const entryPath = `${fullPath}/${entry.name}`;
    let gitDir = `${entryPath}/.git`;

    let gitStat;
    try { gitStat = await stat(gitDir); } catch { return null; }

    let branch: string | null = null;
    try {
      if (!gitStat.isDirectory()) {
        const m = (await Bun.file(gitDir).text()).trim().match(/^gitdir:\s*(.+)$/);
        if (m) gitDir = m[1]!;
      }
      const head = (await Bun.file(`${gitDir}/HEAD`).text()).trim();
      const match = head.match(/^ref: refs\/heads\/(.+)$/);
      branch = match ? match[1]! : head.slice(0, 8);
    } catch { /* no branch info */ }
    return { name: entry.name, path: entryPath, branch };
  }));

  return results
    .filter((r): r is ScannedRepo => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Registration collision detection (tier-1: audit only) ---
//
// Peer identity is self-asserted: generateId() derives a peer's id from the
// basename of the sender-claimed cwd. When the real holder of an id (e.g.
// "huginn") disconnects, its DB row persists (marked disconnected), and any
// local process that registers with a matching cwd basename inherits that
// established id — consumers' allowlists would then trust the impostor.
// Cryptographic registration (tier 2) is deferred, so we cannot block this yet;
// this only leaves a prominent broker-side audit trail.
//
// We warn ONLY when the registrant looks like a *different* identity than the
// previous holder — a different cwd. The overwhelmingly common case is the SAME
// agent reconnecting (broker restart, agent restart, fast re-exec): it keeps
// its cwd even though its pid changes, so keying the check on cwd (not pid)
// keeps legitimate reconnects quiet while still catching a foreign process that
// grabbed the vacated id from a different directory.
const REGISTRATION_COLLISION_WINDOW_MS = 15 * 60_000; // 15 minutes

export function detectRegistrationCollision(
  prior: Peer,
  registrant: { pid: number; cwd: string },
  nowMs: number,
): void {
  // A still-connected prior row isn't a vacated slot (and generateId wouldn't
  // have handed us its id anyway); only a disconnected holder is a collision.
  if (prior.connected) return;
  // Same working directory => same identity reclaiming its own id. No warning.
  if (prior.cwd === registrant.cwd) return;
  const ageMs = nowMs - Date.parse(prior.last_seen);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > REGISTRATION_COLLISION_WINDOW_MS) return;
  const ageMin = Math.round(ageMs / 60_000);
  log(
    `⚠ Peer registration collision: "${prior.id}" was held by a peer disconnected ${ageMin}m ago ` +
    `(pid ${prior.pid}, cwd ${prior.cwd}); new registrant pid ${registrant.pid}, cwd ${registrant.cwd}. ` +
    `Identity is unverified (tier-2 signing not yet implemented).`
  );
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
      const namespace = sanitizeNamespace(msg.namespace);
      peerStmts.deleteByPidNs.run(msg.pid, namespace);
      const id = generateId(peerStmts, ctx.peerSockets, msg.cwd);

      // generateId now ignores DB rows without an active WS, so the chosen ID
      // may still match a stale row whose close handler hasn't fired yet.
      // Clear it (and its service entry) so the upcoming INSERT doesn't
      // collide on the PRIMARY KEY.
      const prior = peerStmts.selectPeerById.get(id) as Peer | null;
      if (prior) {
        // Tier-1 audit: flag when a foreign process inherits a recently
        // vacated id (identity is self-asserted, tier-2 signing not yet built).
        detectRegistrationCollision(prior, { pid: msg.pid, cwd: msg.cwd }, Date.now());
        svcStmts.deleteServiceByPeer.run(id);
        peerStmts.deletePeerStmt.run(id);
      }

      const saved = peerStmts.selectSavedSummary.get(msg.cwd) as { summary: string } | null;
      const summary = msg.summary || saved?.summary || "";

      const agentType = normalizeAgentType(msg.agent_type);
      const opencodeUrl = msg.opencode_url ?? null;
      const surfaceId = msg.surface_id ?? null;

      peerStmts.insertPeer.run(
        id,
        msg.pid,
        msg.cwd,
        msg.git_root,
        msg.git_branch,
        msg.tty,
        summary,
        namespace,
        agentType,
        opencodeUrl,
        surfaceId,
        now,
        now,
        1
      );

      ws.data.peerId = id;
      ws.data.namespace = namespace;

      ws.subscribe(`ns:${namespace}`);
      ws.subscribe(`peer:${id}`);

      ctx.peerSockets.set(id, ws as import("bun").ServerWebSocket<WSData>);

      const reply: BrokerMessage = {
        type: "registered",
        id,
        namespace,
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
          correlation_id: m.correlation_id ?? undefined,
        };
        ws.send(JSON.stringify(deliverMsg));
        msgStmts.markDelivered.run(m.id);
      }

      const peer = getPeer(peerStmts, id)!;
      const joinMsg = JSON.stringify({ type: "peer_joined", peer });
      ctx.server.publish(`ns:${namespace}`, joinMsg);
      ctx.server.publish(
        "dashboard",
        JSON.stringify({
          type: "peer_joined",
          peer,
        } satisfies DashboardMessage)
      );

      log(`Peer ${id} registered (ns: ${namespace}, cwd: ${msg.cwd})`);

      // Rename cmux workspace to the peer's human-readable ID
      const workspaceId = msg.workspace_id;
      if (workspaceId) {
        const suffix = agentType !== "claude-code" ? ` (${agentType === "opencode" ? "OpenCode" : agentType})` : "";
        renameWorkspace(workspaceId, id + suffix).catch(() => {});
      }
      break;
    }

    case "set_summary": {
      if (!ws.data.peerId) return;
      peerStmts.updateSummary.run(msg.summary, ws.data.peerId);
      const peer = getPeer(peerStmts, ws.data.peerId);
      if (peer) {
        peerStmts.upsertSummary.run(peer.cwd, msg.summary, new Date().toISOString());
        const updateMsg = JSON.stringify({ type: "peer_updated", peer });
        ctx.server.publish(`ns:${ws.data.namespace}`, updateMsg);
        ctx.server.publish("dashboard", updateMsg);
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
        // Resolve the sender's pending send so the MCP tool reports a
        // failure instead of hanging until timeout.
        if (msg.send_id) {
          ws.send(JSON.stringify({
            type: "send_result",
            send_id: msg.send_id,
            status: "failed",
          } satisfies BrokerMessage));
        }
        return;
      }

      // Cross-namespace messaging is allowed — agents in different project groups can collaborate


      const now = new Date().toISOString();
      const status = deliverOrQueue(ctx, peerStmts, msgStmts, fromId, msg.to, msg.text, now, msg.correlation_id ?? null);

      // Echo the delivery outcome back to the sender when it tagged the send
      // with a send_id, so the MCP tool can report delivered/queued/failed.
      if (msg.send_id) {
        ws.send(JSON.stringify({
          type: "send_result",
          send_id: msg.send_id,
          status,
        } satisfies BrokerMessage));
      }

      const stats = getMessageStats(msgStmts);
      ctx.server.publish(
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
        .filter((p) => isPeerLive(p, ctx.peerSockets));

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

      // Constrain log_file to the peer's own project tree so the unauthenticated
      // /api/logs route can't be tricked into reading arbitrary local files.
      const owner = getPeer(peerStmts, ws.data.peerId);
      const safeLogFile = owner
        ? validateLogFile(msg.log_file, owner.git_root, owner.cwd)
        : null;
      if (msg.log_file && !safeLogFile) {
        log(`Rejected out-of-tree log_file from ${ws.data.peerId}: ${msg.log_file}`);
      }

      svcStmts.upsertService.run(
        ws.data.peerId,
        msg.port,
        healthUrl,
        safeLogFile,
        logFormat
      );
      const service: ServiceInfo = {
        peer_id: ws.data.peerId,
        port: msg.port,
        health_url: healthUrl,
        log_file: safeLogFile,
        log_format: logFormat,
        status: "unknown",
        last_check: null,
      };
      ctx.server.publish(
        "dashboard",
        JSON.stringify({ type: "service_update", service } satisfies DashboardMessage)
      );
      log(`Service registered for ${ws.data.peerId} on port ${msg.port}`);
      break;
    }
  }
}

// --- Dashboard message handler ---

export interface DashboardDeps {
  ctx: BrokerContext;
  peerStmts: PeerStatements;
  msgStmts: MessageStatements;
  svcStmts: ServiceStatements;
  profileStmts: ProfileStatements;
  dockerState: DockerState;
  dockerLogSubs: DockerLogSubscriptionState;
  logSubState: LogSubscriptionState;
  cmuxState: CmuxState;
  servicePollState: ServicePollState;
}

export function handleDashboardMessage(
  msg: DashboardClientMessage,
  ws: import("bun").ServerWebSocket<WSData>,
  deps: DashboardDeps,
): void {
  const { ctx, peerStmts, msgStmts, svcStmts, profileStmts, dockerState, dockerLogSubs, logSubState, cmuxState, servicePollState } = deps;
  switch (msg.type) {
    case "send_to_peer": {
      const peer = getPeer(peerStmts, msg.peer_id);
      if (!peer) return;
      const now = new Date().toISOString();
      deliverOrQueue(ctx, peerStmts, msgStmts, DASHBOARD_SENDER_ID, msg.peer_id, msg.message, now);
      log(`Dashboard sent message to ${msg.peer_id}`);
      break;
    }

    case "subscribe_logs": {
      subscribeLogs(logSubState, peerStmts, svcStmts, msg.peer_id, ws).catch((e) => log(`Log subscribe error: ${e}`));
      log(`Dashboard subscribed to logs for ${msg.peer_id}`);
      break;
    }

    case "unsubscribe_logs": {
      unsubscribeLogs(logSubState, msg.peer_id, ws);
      log(`Dashboard unsubscribed from logs for ${msg.peer_id}`);
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
      ctx.server.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_set", namespace: msg.namespace, baseline_at: now } satisfies DashboardMessage)
      );
      log(`Baseline set for namespace ${msg.namespace}`);
      break;
    }

    case "clear_baseline": {
      svcStmts.deleteBaseline.run(msg.namespace);
      svcStmts.deleteBaselineOffsets.run(msg.namespace);
      ctx.server.publish(
        "dashboard",
        JSON.stringify({ type: "baseline_cleared", namespace: msg.namespace } satisfies DashboardMessage)
      );
      log(`Baseline cleared for namespace ${msg.namespace}`);
      break;
    }

    case "subscribe_docker_logs": {
      subscribeDockerLogs(dockerState, dockerLogSubs, msg.containerId, ws);
      log(`Dashboard subscribed to Docker logs for ${msg.containerId}`);
      break;
    }

    case "unsubscribe_docker_logs": {
      unsubscribeDockerLogs(dockerLogSubs, msg.containerId, ws);
      log(`Dashboard unsubscribed from Docker logs for ${msg.containerId}`);
      break;
    }

    case "stop_docker_container": {
      const container = dockerState.containers.get(msg.containerId);
      const name = container?.name ?? msg.containerId;
      const containerId = msg.containerId;
      log(`Stopping Docker container ${name}`);
      runDockerCommand(["stop", name])
        .then((out) => {
          const ok = out !== null;
          if (ok) {
            log(`Docker container ${name} stopped`);
          } else {
            log(`Failed to stop Docker container ${name}`);
          }
          ctx.server.publish(
            "dashboard",
            JSON.stringify({
              type: "docker_action_result",
              action: "stop",
              containerId,
              name,
              ok,
              error: ok ? undefined : "docker stop failed",
            } satisfies DashboardMessage)
          );
        })
        .catch((e) => {
          log(`Error stopping Docker container ${name}: ${e}`);
          ctx.server.publish(
            "dashboard",
            JSON.stringify({
              type: "docker_action_result",
              action: "stop",
              containerId,
              name,
              ok: false,
              error: String(e),
            } satisfies DashboardMessage)
          );
        });
      break;
    }

    case "stop_service": {
      const svc = svcStmts.selectServiceByPeer.get(msg.peer_id) as ServiceInfo | undefined;
      if (!svc) break;
      log(`Stopping service on port ${svc.port} (peer: ${msg.peer_id})`);
      (async () => {
        try {
          const killProc = Bun.spawn(["sh", "-c", `lsof -i :${svc.port} -t | xargs kill -9 2>/dev/null`], {
            stdout: "pipe", stderr: "pipe",
          });
          await killProc.exited;
          log(`Killed processes on port ${svc.port}`);
          setTimeout(() => pollServiceHealth(ctx, peerStmts, svcStmts, servicePollState), 500);
        } catch (e) {
          log(`Error stopping service on port ${svc.port}: ${e}`);
        }
      })();
      break;
    }

    case "launch_claude_instance":
    case "launch_claude_instances": {
      if (!cmuxState.available) {
        ws.send(JSON.stringify({
          type: "cmux_launch_result",
          ok: false,
          error: "cmux is not running",
        } satisfies DashboardMessage));
        break;
      }
      const dirs = msg.type === "launch_claude_instances"
        ? msg.directories
        : [{ directory: msg.directory!, name: msg.name }];
      const sharedPrompt = msg.prompt;
      const agentType = msg.agent_type ?? "claude-code";
      const launcher = agentType === "opencode" ? launchOpenCodeInstance : launchClaudeInstance;
      log(`Launching ${dirs.length} ${agentType} instance(s) via cmux`);
      (async () => {
        for (let i = 0; i < dirs.length; i++) {
          const { directory, name } = dirs[i]!;
          // Stagger launches to reduce CPU/IO contention during startup
          if (i > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            const { workspaceId } = await launcher({ directory, name, prompt: sharedPrompt });
            log(`Launched cmux workspace ${workspaceId} for ${directory}`);
            ws.send(JSON.stringify({
              type: "cmux_launch_result",
              ok: true,
              workspaceId,
            } satisfies DashboardMessage));
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            log(`Failed to launch instance in ${directory}: ${error}`);
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
      scanReposInDirectory(msg.directory)
        .then((repos) => {
          ws.send(JSON.stringify({
            type: "scan_repos_result",
            repos,
          } satisfies DashboardMessage));
        })
        .catch((e) => log(`scan_repos error: ${e}`));
      break;
    }

    case "save_profile": {
      const now = new Date().toISOString();
      const id = crypto.randomUUID().slice(0, 8);
      const prompt = msg.prompt || "";
      const row = profileStmts.upsertProfile.get(id, msg.name, msg.directory, JSON.stringify(msg.repos), prompt, now) as { id: string; created_at: string };
      const profile: LaunchProfile = {
        id: row.id,
        name: msg.name,
        directory: msg.directory,
        repos: msg.repos,
        prompt,
        created_at: row.created_at,
      };
      ctx.server.publish(
        "dashboard",
        JSON.stringify({ type: "profile_saved", profile } satisfies DashboardMessage)
      );
      log(`Profile saved: ${msg.name}`);
      break;
    }

    case "delete_profile": {
      profileStmts.deleteProfile.run(msg.profileId);
      ctx.server.publish(
        "dashboard",
        JSON.stringify({ type: "profile_deleted", profileId: msg.profileId } satisfies DashboardMessage)
      );
      log(`Profile deleted: ${msg.profileId}`);
      break;
    }

    case "list_profiles": {
      const profiles = getAllProfiles(profileStmts);
      ws.send(JSON.stringify({
        type: "profiles_list",
        profiles,
      } satisfies DashboardMessage));
      break;
    }

  }
}
