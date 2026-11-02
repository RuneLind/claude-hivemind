/**
 * Peer lifecycle: registration, lookup, ID generation, messaging, stale cleanup.
 */

import type { Database } from "bun:sqlite";
import type {
  Peer,
  BrokerMessage,
  NamespaceInfo,
  PeerMessageStats,
  PairMessageStats,
} from "../shared/types.ts";
import { DASHBOARD_SENDER_ID } from "../shared/types.ts";
import { WS_OPEN, type BrokerContext } from "./db.ts";
import { sendText, sendKey } from "../cmux/client.ts";
import { formatPeerPrompt } from "../shared/message-prompt.ts";

export function log(msg: string) {
  console.error(`[claude-hivemind broker] ${msg}`);
}

const DAY_MS = 24 * 3_600_000;
// Delivered messages are kept for inspection in the dashboard's conversation
// view; undelivered ones get a longer grace period so a peer that vanishes
// for a few weeks still gets its backlog when it reconnects.
const DELIVERED_RETENTION_MS = 7 * DAY_MS;
const UNDELIVERED_RETENTION_MS = 30 * DAY_MS;

export function createPeerStatements(db: Database) {
  return {
    insertPeer: db.prepare(`
      INSERT INTO peers (id, pid, cwd, git_root, git_branch, tty, summary, namespace, agent_type, opencode_url, surface_id, registered_at, last_seen, connected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateLastSeen: db.prepare(
      `UPDATE peers SET last_seen = ? WHERE id = ?`
    ),
    updateSummary: db.prepare(
      `UPDATE peers SET summary = ? WHERE id = ?`
    ),
    markConnected: db.prepare(
      `UPDATE peers SET connected = ? WHERE id = ?`
    ),
    deletePeerStmt: db.prepare(`DELETE FROM peers WHERE id = ?`),
    selectPeerById: db.prepare(`SELECT * FROM peers WHERE id = ?`),
    selectAllPeers: db.prepare(`SELECT * FROM peers`),
    selectPeersByNamespace: db.prepare(
      `SELECT * FROM peers WHERE namespace = ?`
    ),
    deleteByPidNs: db.prepare(`DELETE FROM peers WHERE pid = ? AND namespace = ?`),
    selectPeerIdPid: db.prepare(`SELECT id, pid FROM peers`),
    upsertSummary: db.prepare(`
      INSERT INTO saved_summaries (cwd, summary, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(cwd) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
    `),
    selectSavedSummary: db.prepare(
      `SELECT summary FROM saved_summaries WHERE cwd = ?`
    ),
  };
}

export function createMessageStatements(db: Database) {
  return {
    insertMessage: db.prepare(`
      INSERT INTO messages (from_id, to_id, text, sent_at, delivered, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    selectUndelivered: db.prepare(
      `SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC`
    ),
    markDelivered: db.prepare(
      `UPDATE messages SET delivered = 1 WHERE id = ?`
    ),
    // For acks: a peer may only mark its own messages delivered.
    markDeliveredTo: db.prepare(
      `UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?`
    ),
    deleteOldDeliveredMessages: db.prepare(
      `DELETE FROM messages WHERE delivered = 1 AND sent_at < ?`
    ),
    deleteOldUndeliveredMessages: db.prepare(
      `DELETE FROM messages WHERE delivered = 0 AND sent_at < ?`
    ),
    selectPeerStats: db.prepare(`
      SELECT peer_id, SUM(sent) as sent, SUM(received) as received FROM (
        SELECT from_id as peer_id, COUNT(*) as sent, 0 as received FROM messages GROUP BY from_id
        UNION ALL
        SELECT to_id as peer_id, 0 as sent, COUNT(*) as received FROM messages GROUP BY to_id
      ) GROUP BY peer_id
    `),
    selectPairStats: db.prepare(`
      SELECT from_id, to_id, COUNT(*) as count FROM messages GROUP BY from_id, to_id
    `),
    selectConversation: db.prepare(`
      SELECT id, from_id, to_id, text, sent_at, correlation_id FROM messages
      WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
      ORDER BY sent_at ASC
    `),
    selectPeerMessages: db.prepare(`
      SELECT id, from_id, to_id, text, sent_at, correlation_id FROM messages
      WHERE from_id = ? OR to_id = ?
      ORDER BY sent_at ASC
    `),
    deleteAllMessages: db.prepare(`DELETE FROM messages`),
  };
}

export type PeerStatements = ReturnType<typeof createPeerStatements>;
export type MessageStatements = ReturnType<typeof createMessageStatements>;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `connected=1` rows can be stale after broker restart or PID recycling;
// the WS-map check distinguishes a real connection from a leftover row.
export function isPeerLive(
  peer: Peer,
  peerSockets: Map<string, unknown>,
): boolean {
  return isProcessAlive(peer.pid) && (!peer.connected || peerSockets.has(peer.id));
}

export function getPeer(stmts: PeerStatements, id: string): Peer | null {
  return (stmts.selectPeerById.get(id) as Peer) ?? null;
}

export function getAllPeers(stmts: PeerStatements): Peer[] {
  return stmts.selectAllPeers.all() as Peer[];
}

// Peer ids that would collide with a broker-stamped origin. A stamped id must
// never be reachable from a cwd basename, or a registrant could impersonate
// that origin (HTTP sends stamp `http:<x>`; the dashboard stamps
// DASHBOARD_SENDER_ID). The `http:` family is excluded structurally by the
// sanitizer below (it strips `:`), so only the colon-free reserved ids need an
// explicit guard.
const RESERVED_PEER_IDS = new Set<string>([DASHBOARD_SENDER_ID]);

export function generateId(
  stmts: PeerStatements,
  peerSockets: Map<string, unknown>,
  cwd: string,
): string {
  // Derive the id from the cwd basename, but sanitize to [a-zA-Z0-9_-] first.
  // An unsanitized basename could contain a `:` (legal in unix dir names) and
  // land the peer id inside the reserved `http:` origin namespace stamped on
  // HTTP sends — making a registered id collide with the stamp. Stripping the
  // colon (and everything outside the safe class) makes that structurally
  // impossible; a reserved or emptied result falls back to a neutral base.
  let base = (cwd.split("/").pop() ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (base.length === 0 || RESERVED_PEER_IDS.has(base)) base = "peer";
  // peerSockets is authoritative for "actively connected" — PID checks lie
  // briefly during fast re-execs (zombie PID, or close handler not yet fired)
  // and would push us to <name>-2 even though the slot is effectively free.
  const livePeers = getAllPeers(stmts).filter((p) => peerSockets.has(p.id));
  // Only `<base>` and `<base>-<digits>` count as conflicts — hyphenated names
  // like `melosys-api-claude` share a prefix with `melosys` but are distinct
  // identities and must not push us to `melosys-2`.
  const existing = livePeers.filter((p) => {
    if (p.id === base) return true;
    if (!p.id.startsWith(base + "-")) return false;
    return /^\d+$/.test(p.id.slice(base.length + 1));
  });
  if (existing.length === 0) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((p) => p.id === candidate)) return candidate;
  }
}

export function namespacesFromPeers(peers: Peer[]): NamespaceInfo[] {
  const nsMap = new Map<string, number>();
  for (const p of peers) {
    nsMap.set(p.namespace, (nsMap.get(p.namespace) ?? 0) + 1);
  }
  return Array.from(nsMap.entries()).map(([name, peer_count]) => ({
    name,
    peer_count,
  }));
}

export function getMessageStats(msgStmts: MessageStatements): { peer_stats: PeerMessageStats[]; pair_stats: PairMessageStats[] } {
  return {
    peer_stats: msgStmts.selectPeerStats.all() as PeerMessageStats[],
    pair_stats: msgStmts.selectPairStats.all() as PairMessageStats[],
  };
}

async function deliverViaCmux(
  target: Peer,
  fromId: string,
  fromSummary: string | null,
  text: string,
): Promise<boolean> {
  const surfaceId = target.surface_id;
  if (!surfaceId) return false;

  const prompt = formatPeerPrompt(fromId, text, fromSummary);
  try {
    await sendText(prompt, surfaceId);
    await sendKey("enter", surfaceId);
    log(`Delivered message to ${target.agent_type} peer ${target.id} via cmux surface ${surfaceId}`);
    return true;
  } catch (e) {
    log(`Failed to deliver via cmux to peer ${target.id}: ${e}`);
    return false;
  }
}

// Outcome of a deliverOrQueue call, surfaced back to the sender:
// - "delivered": pushed to a live, open WebSocket (MCP server or the OpenCode
//               plugin).
// - "queued":   persisted for later delivery (peer offline), or handed to
//               cmux text injection, whose outcome is not known synchronously.
// - "failed":   neither delivery nor queueing succeeded.
export type DeliveryStatus = "delivered" | "queued" | "failed";

export function deliverOrQueue(
  ctx: BrokerContext,
  stmts: PeerStatements,
  msgStmts: MessageStatements,
  fromId: string,
  toId: string,
  text: string,
  now: string,
  // Opaque token the sender attached. The broker never interprets it; it's
  // persisted and round-tripped to the target so a reply can be correlated.
  correlationId: string | null = null,
): DeliveryStatus {
  const target = getPeer(stmts, toId);
  const sender = getPeer(stmts, fromId);
  const fromSummary = sender?.summary ?? null;

  // OpenCode peers on the legacy MCP route (launched with CMUX_SURFACE_ID) get
  // the message typed into their cmux terminal: insert as undelivered, mark
  // delivered when the async injection resolves. Text injection can't carry
  // the correlation token; it is still persisted for the conversation view.
  // OpenCode peers from the plugin (src/opencode/) register without a
  // surface_id and take the WebSocket path below, token included.
  if (target?.agent_type === "opencode" && target.surface_id) {
    try {
      const result = msgStmts.insertMessage.run(fromId, toId, text, now, 0, correlationId);
      const messageId = Number(result.lastInsertRowid);
      deliverViaCmux(target, fromId, fromSummary, text)
        .then((ok) => { if (ok) msgStmts.markDelivered.run(messageId); })
        .catch((e) => log(`Async delivery error for ${toId}: ${e}`));
      // Outcome is asynchronous; report as queued (accepted, not yet confirmed).
      return "queued";
    } catch (e) {
      log(`Failed to enqueue message for OpenCode peer ${toId}: ${e}`);
      return "failed";
    }
  }

  // Synchronous delivery via WebSocket (MCP server, or the OpenCode plugin)
  const targetWs = ctx.peerSockets.get(toId);
  // A peer that acks (the OpenCode plugin) holds a message in memory until it
  // can hand it to a session. The row stays undelivered until the ack, so a
  // message lost with the process is replayed when the peer registers again.
  if (targetWs && targetWs.readyState === WS_OPEN && (targetWs.data as { acks?: boolean } | undefined)?.acks) {
    try {
      const result = msgStmts.insertMessage.run(fromId, toId, text, now, 0, correlationId);
      targetWs.send(JSON.stringify({
        type: "message",
        from_id: fromId,
        from_summary: sender?.summary ?? "",
        from_cwd: sender?.cwd ?? "",
        text,
        sent_at: now,
        correlation_id: correlationId ?? undefined,
        message_id: Number(result.lastInsertRowid),
      } satisfies BrokerMessage));
      return target && isPeerLive(target, ctx.peerSockets) ? "delivered" : "queued";
    } catch (e) {
      log(`Failed to send to acking peer ${toId}: ${e}`);
      return "failed";
    }
  }
  if (targetWs && targetWs.readyState === WS_OPEN) {
    try {
      targetWs.send(JSON.stringify({
        type: "message",
        from_id: fromId,
        from_summary: sender?.summary ?? "",
        from_cwd: sender?.cwd ?? "",
        text,
        sent_at: now,
        correlation_id: correlationId ?? undefined,
      } satisfies BrokerMessage));
      // A WS_OPEN socket can still be half-open (peer process died without a
      // clean close, TCP not yet timed out): the fire-and-forget send above is
      // not proof of receipt. We gate "delivered" on isPeerLive, but on this
      // path the socket-presence clause is already satisfied (we got targetWs
      // from peerSockets), so isPeerLive reduces to a PID liveness check. That
      // catches a dead process, but NOT a half-open socket whose process is
      // still running — a true receipt check would need last_seen/heartbeat
      // tracking (follow-up). When the peer isn't live we persist as
      // undelivered so the reconnect redelivery queue (selectUndelivered)
      // re-sends it, and report "queued" rather than "delivered".
      const live = target ? isPeerLive(target, ctx.peerSockets) : false;
      msgStmts.insertMessage.run(fromId, toId, text, now, live ? 1 : 0, correlationId);
      return live ? "delivered" : "queued";
    } catch (e) {
      // Live send failed — fall through to persisting as undelivered.
      log(`Live send to ${toId} failed, queueing instead: ${e}`);
    }
  }
  try {
    msgStmts.insertMessage.run(fromId, toId, text, now, 0, correlationId);
    return "queued";
  } catch (e) {
    log(`Failed to queue message for ${toId}: ${e}`);
    return "failed";
  }
}

export function cleanStalePeers(
  stmts: PeerStatements,
  msgStmts: MessageStatements,
  serviceStmts: { deleteServiceByPeer: { run: (...args: any[]) => void } },
  peerSockets?: Map<string, unknown>,
): void {
  const peers = stmts.selectAllPeers.all() as Peer[];
  for (const peer of peers) {
    const pidDead = !isProcessAlive(peer.pid);
    // A peer marked connected in DB but missing from the WebSocket map is stale
    // (PID recycled by OS, or broker restarted while peer was connected)
    const orphanedConnection = peer.connected && peerSockets && !peerSockets.has(peer.id);
    if (pidDead || orphanedConnection) {
      serviceStmts.deleteServiceByPeer.run(peer.id);
      stmts.deletePeerStmt.run(peer.id);
      if (orphanedConnection && !pidDead) {
        log(`Cleaned orphaned peer ${peer.id} (PID ${peer.pid} recycled, no active WebSocket)`);
      }
    }
  }
  const now = Date.now();
  msgStmts.deleteOldDeliveredMessages.run(new Date(now - DELIVERED_RETENTION_MS).toISOString());
  msgStmts.deleteOldUndeliveredMessages.run(new Date(now - UNDELIVERED_RETENTION_MS).toISOString());
}
