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
import type {
  ClientMessage,
  BrokerMessage,
  DashboardMessage,
  Peer,
  NamespaceInfo,
  PeerMessageStats,
  PairMessageStats,
  StoredMessage,
} from "./shared/types.ts";
import dashboard from "./dashboard/index.html";

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
      deletePeerStmt.run(peer.id);
    }
  }
  // Purge delivered messages older than 1 hour
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  deleteOldMessages.run(cutoff);
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);


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
      if (peer) upsertSummary.run(peer.cwd, msg.summary, new Date().toISOString());
      if (peer) {
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
  }
}


const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "127.0.0.1",

  routes: {
    "/": dashboard,

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
        ws.send(
          JSON.stringify({
            type: "snapshot",
            peers,
            namespaces: namespacesFromPeers(peers),
            peer_stats: stats.peer_stats,
            pair_stats: stats.pair_stats,
          } satisfies DashboardMessage)
        );
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
      }
    },

    close(ws) {
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
            deletePeerStmt.run(peerId);
            log(`Peer ${peerId} cleaned up after grace period`);
          }
        }, GRACE_PERIOD_MS);
      }
    },
  },
});

log(`Listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
