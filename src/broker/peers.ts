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
import { WS_OPEN, type BrokerContext } from "./db.ts";
import { sendText, sendKey } from "../cmux/client.ts";
import { formatPeerPrompt } from "../shared/message-prompt.ts";

export function log(msg: string) {
  console.error(`[claude-hivemind broker] ${msg}`);
}

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
      INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
      VALUES (?, ?, ?, ?, ?)
    `),
    selectUndelivered: db.prepare(
      `SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC`
    ),
    markDelivered: db.prepare(
      `UPDATE messages SET delivered = 1 WHERE id = ?`
    ),
    deleteOldMessages: db.prepare(
      `DELETE FROM messages WHERE delivered = 1 AND sent_at < ?`
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
      SELECT id, from_id, to_id, text, sent_at FROM messages
      WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
      ORDER BY sent_at ASC
    `),
    selectPeerMessages: db.prepare(`
      SELECT id, from_id, to_id, text, sent_at FROM messages
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

export function getPeer(stmts: PeerStatements, id: string): Peer | null {
  return (stmts.selectPeerById.get(id) as Peer) ?? null;
}

export function getAllPeers(stmts: PeerStatements): Peer[] {
  return stmts.selectAllPeers.all() as Peer[];
}

export function generateId(
  stmts: PeerStatements,
  peerSockets: Map<string, unknown>,
  cwd: string,
): string {
  const base = cwd.split("/").pop() ?? "peer";
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

async function deliverViaOpenCodeHttp(
  target: Peer,
  fromId: string,
  fromSummary: string | null,
  text: string,
): Promise<boolean> {
  const baseUrl = target.opencode_url;
  if (!baseUrl) return false;

  let sessionId: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json() as { sessions?: { id: string; updatedAt?: string }[] } | { id: string }[];
    const sessions = Array.isArray(data) ? data : (data.sessions ?? []);
    if (sessions.length === 0) {
      log(`No active OpenCode session at ${baseUrl} for peer ${target.id}`);
      return false;
    }
    sessionId = sessions.slice().sort((a: any, b: any) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    )[0].id;
  } catch (e) {
    log(`Failed to resolve OpenCode session at ${baseUrl}: ${e}`);
    return false;
  }

  const prompt = `[hivemind from ${fromId}${fromSummary ? ` — ${fromSummary}` : ""}] ${text}`;
  try {
    const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 204) {
      log(`Delivered message to OpenCode peer ${target.id} via HTTP`);
      return true;
    }
    log(`OpenCode prompt_async returned ${res.status} for peer ${target.id}`);
    return false;
  } catch (e) {
    log(`Failed to deliver to OpenCode peer ${target.id}: ${e}`);
    return false;
  }
}

export function deliverOrQueue(
  ctx: BrokerContext,
  stmts: PeerStatements,
  msgStmts: MessageStatements,
  fromId: string,
  toId: string,
  text: string,
  now: string,
): void {
  const target = getPeer(stmts, toId);
  const sender = getPeer(stmts, fromId);
  const fromSummary = sender?.summary ?? null;

  // Async delivery for OpenCode peers: insert synchronously as undelivered,
  // then mark delivered when the async path resolves, so dashboard stats
  // reflect the send immediately.
  if (target?.agent_type === "opencode" && (target.surface_id || target.opencode_url)) {
    const result = msgStmts.insertMessage.run(fromId, toId, text, now, 0);
    const messageId = Number(result.lastInsertRowid);
    const delivery = target.surface_id
      ? deliverViaCmux(target, fromId, fromSummary, text)
      : deliverViaOpenCodeHttp(target, fromId, fromSummary, text);
    delivery
      .then((ok) => { if (ok) msgStmts.markDelivered.run(messageId); })
      .catch((e) => log(`Async delivery error for ${toId}: ${e}`));
    return;
  }

  // Synchronous delivery for Claude Code / Copilot via WebSocket
  const targetWs = ctx.peerSockets.get(toId);
  if (targetWs && targetWs.readyState === WS_OPEN) {
    targetWs.send(JSON.stringify({
      type: "message",
      from_id: fromId,
      from_summary: sender?.summary ?? "",
      from_cwd: sender?.cwd ?? "",
      text,
      sent_at: now,
    } satisfies BrokerMessage));
    msgStmts.insertMessage.run(fromId, toId, text, now, 1);
  } else {
    msgStmts.insertMessage.run(fromId, toId, text, now, 0);
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
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  msgStmts.deleteOldMessages.run(cutoff);
}
