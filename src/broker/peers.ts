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
  AgentType,
} from "../shared/types.ts";
import { WS_OPEN, type BrokerContext } from "./db.ts";

export function log(msg: string) {
  console.error(`[claude-hivemind broker] ${msg}`);
}

export function createPeerStatements(db: Database) {
  return {
    insertPeer: db.prepare(`
      INSERT INTO peers (id, pid, cwd, git_root, git_branch, tty, summary, namespace, agent_type, opencode_url, registered_at, last_seen, connected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    deleteByPid: db.prepare(`DELETE FROM peers WHERE pid = ?`),
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

export function generateId(stmts: PeerStatements, cwd: string): string {
  const base = cwd.split("/").pop() ?? "peer";
  const livePeers = getAllPeers(stmts).filter((p) => isProcessAlive(p.pid));
  const existing = livePeers.filter((p) => p.id === base || p.id.startsWith(base + "-"));
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

// Cache OpenCode session IDs per base URL to avoid repeated lookups
const opencodeSessionCache = new Map<string, { sessionId: string; fetchedAt: number }>();

async function resolveOpenCodeSession(baseUrl: string): Promise<string | null> {
  const cached = opencodeSessionCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < 30_000) return cached.sessionId;

  try {
    const res = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json() as { sessions?: { id: string; updatedAt?: string }[] } | { id: string }[];
    // OpenCode returns sessions list — pick the most recently updated
    const sessions = Array.isArray(data) ? data : (data.sessions ?? []);
    if (sessions.length === 0) return null;
    const sorted = sessions.sort((a: any, b: any) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    );
    const sessionId = sorted[0].id;
    opencodeSessionCache.set(baseUrl, { sessionId, fetchedAt: Date.now() });
    return sessionId;
  } catch (e) {
    log(`Failed to resolve OpenCode session at ${baseUrl}: ${e}`);
    return null;
  }
}

async function deliverToOpenCode(
  target: Peer,
  fromId: string,
  text: string,
  stmts: PeerStatements,
): Promise<boolean> {
  const baseUrl = target.opencode_url;
  if (!baseUrl) return false;

  const sessionId = await resolveOpenCodeSession(baseUrl);
  if (!sessionId) {
    log(`No active OpenCode session found at ${baseUrl} for peer ${target.id}`);
    return false;
  }

  const sender = getPeer(stmts, fromId);
  const prompt = `[hivemind from ${fromId}${sender?.summary ? ` — ${sender.summary}` : ""}] ${text}`;

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
    // Clear cached session on failure — it may have expired
    opencodeSessionCache.delete(baseUrl);
    return false;
  } catch (e) {
    log(`Failed to deliver to OpenCode peer ${target.id}: ${e}`);
    opencodeSessionCache.delete(baseUrl);
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

  // OpenCode peers: deliver via HTTP prompt_async (fire-and-forget)
  if (target?.agent_type === "opencode" && target.opencode_url) {
    deliverToOpenCode(target, fromId, text, stmts).then((ok) => {
      msgStmts.insertMessage.run(fromId, toId, text, now, ok ? 1 : 0);
    }).catch(() => {
      msgStmts.insertMessage.run(fromId, toId, text, now, 0);
    });
    return;
  }

  // Default: deliver via WebSocket (Claude Code, Copilot, etc.)
  const targetWs = ctx.peerSockets.get(toId);
  if (targetWs && targetWs.readyState === WS_OPEN) {
    const sender = getPeer(stmts, fromId);
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
): void {
  const peers = stmts.selectPeerIdPid.all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (!isProcessAlive(peer.pid)) {
      serviceStmts.deleteServiceByPeer.run(peer.id);
      stmts.deletePeerStmt.run(peer.id);
    }
  }
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  msgStmts.deleteOldMessages.run(cutoff);
}
