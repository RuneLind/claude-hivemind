import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type {
  Peer,
  PeerMessageStats,
  PairMessageStats,
  StoredMessage,
} from "../shared/types.ts";
import "./dashboard.css";

interface ActivityItem {
  time: string;
  text: string;
}


function namespaceColor(name: string): string {
  const colors = [
    "#58a6ff",
    "#7ee787",
    "#d2a8ff",
    "#f0883e",
    "#ff7b72",
    "#79c0ff",
    "#ffa657",
    "#a5d6ff",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function shortPath(cwd: string): string {
  return cwd.replace(/^\/Users\/\w+\//, "~/");
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ConversationModal({
  peer1,
  peer2,
  onClose,
}: {
  peer1: string;
  peer2: string | null;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const p2 = encodeURIComponent(peer2 ?? "*");
    fetch(`/api/messages?peer1=${encodeURIComponent(peer1)}&peer2=${p2}`)
      .then((r) => r.json() as Promise<{ messages?: StoredMessage[] }>)
      .then((data) => { setMessages(data.messages ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [peer1, peer2]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const title = peer2 ? `${peer1} \u2194 ${peer2}` : `Messages for ${peer1}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {loading && <div className="modal-loading">Loading...</div>}
          {!loading && messages.length === 0 && (
            <div className="modal-empty">No messages</div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`message-item ${m.from_id === peer1 ? "sent" : "received"}`}>
              <div className="message-meta">
                <span className="message-from">{m.from_id}</span>
                <span className="message-arrow">&rarr;</span>
                <span className="message-to">{m.to_id}</span>
                <span className="message-time">{formatTime(m.sent_at)}</span>
              </div>
              <div className="message-text">{m.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PeerCard({
  peer,
  stats,
  onClickMessages,
}: {
  peer: Peer;
  stats: PeerMessageStats | undefined;
  onClickMessages: () => void;
}) {
  const total = stats ? stats.sent + stats.received : 0;

  return (
    <div className={`peer-card ${peer.connected ? "" : "disconnected"}`}>
      <div className="peer-header">
        <span className="connection-dot" />
        <span className="peer-id">{peer.id}</span>
        {total > 0 && (
          <button className="message-count-badge" onClick={onClickMessages} title="View messages">
            {total} msg{total !== 1 ? "s" : ""}
          </button>
        )}
      </div>
      <div className="peer-cwd">{shortPath(peer.cwd)}</div>
      {peer.git_branch && (
        <div className="peer-branch">{peer.git_branch}</div>
      )}
      {peer.summary && <div className="peer-summary">{peer.summary}</div>}
      <div className="peer-meta">
        <span>PID {peer.pid}</span>
        <span>
          {peer.connected ? "Connected" : `Last seen ${timeAgo(peer.last_seen)}`}
        </span>
      </div>
    </div>
  );
}

function NamespaceGraph({
  peers,
  pairStats,
  onClickPair,
}: {
  peers: Peer[];
  pairStats: PairMessageStats[];
  onClickPair: (from: string, to: string) => void;
}) {
  const peerIds = new Set(peers.map((p) => p.id));
  const relevantPairs = pairStats.filter(
    (ps) => peerIds.has(ps.from_id) && peerIds.has(ps.to_id)
  );

  if (relevantPairs.length === 0) return null;

  const CHAR_W = 10;
  const NODE_PAD_X = 20;
  const NODE_H = 38;

  const nodeWidths = new Map<string, number>();
  for (const p of peers) {
    nodeWidths.set(p.id, p.id.length * CHAR_W + NODE_PAD_X * 2);
  }

  const maxNodeW = Math.max(...Array.from(nodeWidths.values()));
  const radius = Math.max(180, peers.length * (maxNodeW + 28) / (2 * Math.PI));
  const SIZE = radius * 2 + 80;
  const WIDTH = SIZE;
  const HEIGHT = SIZE;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  const positions = new Map<string, { x: number; y: number }>();
  peers.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / peers.length - Math.PI / 2;
    positions.set(p.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  // Aggregate bidirectional edges
  const edgeMap = new Map<string, { from: string; to: string; fwdCount: number; revCount: number }>();
  for (const ps of relevantPairs) {
    const key = [ps.from_id, ps.to_id].sort().join("|");
    const existing = edgeMap.get(key);
    if (existing) {
      if (ps.from_id === existing.from) {
        existing.fwdCount += ps.count;
      } else {
        existing.revCount += ps.count;
      }
    } else {
      const sorted = [ps.from_id, ps.to_id].sort();
      const a = sorted[0]!;
      const b = sorted[1]!;
      edgeMap.set(key, {
        from: a,
        to: b,
        fwdCount: a === ps.from_id ? ps.count : 0,
        revCount: a === ps.from_id ? 0 : ps.count,
      });
    }
  }

  return (
    <div className="graph-view">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="graph-svg">
        <defs>
          <marker id="arrow-fwd" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#58a6ff" />
          </marker>
          <marker id="arrow-rev" markerWidth="8" markerHeight="6" refX="0" refY="3" orient="auto">
            <polygon points="8 0, 0 3, 8 6" fill="#7ee787" />
          </marker>
        </defs>

        {/* Edges */}
        {Array.from(edgeMap.values()).map((edge) => {
          const fromPos = positions.get(edge.from);
          const toPos = positions.get(edge.to);
          if (!fromPos || !toPos) return null;

          const fromHalfW = (nodeWidths.get(edge.from) ?? 60) / 2;
          const toHalfW = (nodeWidths.get(edge.to) ?? 60) / 2;

          const dx = toPos.x - fromPos.x;
          const dy = toPos.y - fromPos.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len === 0) return null;

          const ux = dx / len;
          const uy = dy / len;

          // Offset start/end to clear the pill-shaped nodes
          const edgeGap = 6;
          const fromOffset = Math.max(fromHalfW * Math.abs(ux), (NODE_H / 2) * Math.abs(uy)) + edgeGap;
          const toOffset = Math.max(toHalfW * Math.abs(ux), (NODE_H / 2) * Math.abs(uy)) + edgeGap;

          const x1 = fromPos.x + ux * fromOffset;
          const y1 = fromPos.y + uy * fromOffset;
          const x2 = toPos.x - ux * toOffset;
          const y2 = toPos.y - uy * toOffset;

          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;

          const total = edge.fwdCount + edge.revCount;
          const key = `${edge.from}-${edge.to}`;

          const px = -uy * 10;
          const py = ux * 10;

          return (
            <g key={key}>
              {edge.fwdCount > 0 && (
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="#58a6ff" strokeWidth="1.5" opacity="0.6"
                  markerEnd="url(#arrow-fwd)"
                />
              )}
              {edge.revCount > 0 && (
                <line
                  x1={x2 + px * 0.3} y1={y2 + py * 0.3} x2={x1 + px * 0.3} y2={y1 + py * 0.3}
                  stroke="#7ee787" strokeWidth="1.5" opacity="0.6"
                  markerEnd="url(#arrow-rev)"
                />
              )}
              <g
                className="edge-label"
                onClick={() => onClickPair(edge.from, edge.to)}
              >
                <rect
                  x={midX - 18} y={midY - 12}
                  width={36} height={24}
                  rx={4}
                  fill="#21262d" stroke="#30363d" strokeWidth="1"
                />
                <text
                  x={midX} y={midY + 4}
                  textAnchor="middle"
                  fill="#c9d1d9"
                  fontSize="14"
                  fontFamily="monospace"
                >
                  {total}
                </text>
              </g>
            </g>
          );
        })}

        {/* Nodes — pill-shaped to fit full peer ID */}
        {peers.map((peer) => {
          const pos = positions.get(peer.id);
          if (!pos) return null;
          const w = nodeWidths.get(peer.id) ?? 60;
          return (
            <g key={peer.id}>
              <rect
                x={pos.x - w / 2} y={pos.y - NODE_H / 2}
                width={w} height={NODE_H}
                rx={NODE_H / 2}
                fill="#161b22"
                stroke={peer.connected ? "#3fb950" : "#484f58"}
                strokeWidth="2"
              />
              <text
                x={pos.x} y={pos.y + 4}
                textAnchor="middle"
                fill="#c9d1d9"
                fontSize="15"
                fontFamily="monospace"
              >
                {peer.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Dashboard() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [peerStats, setPeerStats] = useState<PeerMessageStats[]>([]);
  const [pairStats, setPairStats] = useState<PairMessageStats[]>([]);
  const [modal, setModal] = useState<{ peer1: string; peer2: string | null } | null>(null);
  const [graphView, setGraphView] = useState<Record<string, boolean>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addActivity = useCallback((text: string) => {
    setActivity((prev) => [
      { time: new Date().toISOString(), text },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const connect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    const ws = new WebSocket(`ws://${window.location.host}/ws/dashboard`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      addActivity("Connected to broker");
    };

    ws.onclose = () => {
      setConnected(false);
      addActivity("Disconnected from broker");
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "snapshot":
          setPeers(msg.peers);
          setPeerStats(msg.peer_stats ?? []);
          setPairStats(msg.pair_stats ?? []);
          addActivity(`Loaded ${msg.peers.length} peer(s)`);
          break;
        case "peer_joined":
          setPeers((prev) => [
            ...prev.filter((p) => p.id !== msg.peer.id),
            msg.peer,
          ]);
          addActivity(
            `${msg.peer.id} joined (${msg.peer.namespace})`
          );
          break;
        case "peer_left":
          setPeers((prev) =>
            prev.filter((p) => p.id !== msg.peer_id)
          );
          addActivity(`${msg.peer_id} left`);
          break;
        case "peer_updated":
          setPeers((prev) =>
            prev.map((p) => (p.id === msg.peer.id ? msg.peer : p))
          );
          break;
        case "message_sent":
          setPeerStats(msg.peer_stats ?? []);
          setPairStats(msg.pair_stats ?? []);
          addActivity(
            `${msg.from_id} \u2192 ${msg.to_id}: ${msg.text.slice(0, 60)}`
          );
          break;
        case "messages_cleared":
          setPeerStats([]);
          setPairStats([]);
          addActivity("Message history cleared");
          break;
      }
    };
  }, [addActivity]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const clearMessages = async () => {
    await fetch("/api/messages/clear", { method: "POST" });
  };

  const peerStatsMap = useMemo(() => new Map(peerStats.map((s) => [s.peer_id, s])), [peerStats]);

  const grouped = peers.reduce(
    (acc, peer) => {
      (acc[peer.namespace] ??= []).push(peer);
      return acc;
    },
    {} as Record<string, Peer[]>
  );

  const sortedNamespaces = Object.keys(grouped).sort();
  const totalMessages = useMemo(() => peerStats.reduce((sum, s) => sum + s.sent, 0), [peerStats]);

  return (
    <div className="dashboard">
      <header>
        <h1>claude-hivemind</h1>
        <span className={`status ${connected ? "connected" : "disconnected"}`}>
          {connected ? "Live" : "Disconnected"}
        </span>
        <span className="count">
          {peers.length} peer{peers.length !== 1 ? "s" : ""}
        </span>

        {totalMessages > 0 && (
          <button className="clear-btn" onClick={clearMessages}>
            Clear history ({totalMessages})
          </button>
        )}
      </header>

      {sortedNamespaces.map((ns) => {
        const nsPeerIds = new Set(grouped[ns].map((p) => p.id));
        const hasMessages = pairStats.some((ps) => nsPeerIds.has(ps.from_id) && nsPeerIds.has(ps.to_id));
        return (
        <section
          key={ns}
          className="namespace-group"
          style={{ "--ns-color": namespaceColor(ns) } as React.CSSProperties}
        >
          <h2>
            {ns}
            <span className="ns-count">{grouped[ns].length}</span>
            {hasMessages && (
              <button
                className="view-toggle"
                onClick={() => setGraphView((prev) => ({ ...prev, [ns]: !prev[ns] }))}
              >
                {graphView[ns] ? "Peers" : "Graph"}
              </button>
            )}
            <span className="ns-badge">Can message each other</span>
          </h2>
          {graphView[ns] ? (
            <NamespaceGraph
              peers={grouped[ns] ?? []}
              pairStats={pairStats}
              onClickPair={(from, to) => setModal({ peer1: from, peer2: to })}
            />
          ) : (
            <div className="peer-grid">
              {grouped[ns].map((peer) => (
                <PeerCard
                  key={peer.id}
                  peer={peer}
                  stats={peerStatsMap.get(peer.id)}
                  onClickMessages={() => setModal({ peer1: peer.id, peer2: null })}
                />
              ))}
            </div>
          )}
        </section>
      );
      })}

      {peers.length === 0 && (
        <div className="empty">
          No peers connected. Start a Claude Code session to see it here.
        </div>
      )}

      {activity.length > 0 && (
        <div className="activity-log">
          <h3>Activity</h3>
          {activity.map((item, i) => (
            <div key={i} className="activity-item">
              <span className="time">{formatTime(item.time)}</span>
              {item.text}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <ConversationModal
          peer1={modal.peer1}
          peer2={modal.peer2}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Dashboard />);
