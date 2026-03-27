import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type {
  Peer,
  ServiceInfo,
  LogLine,
  LogLevel,
  PeerMessageStats,
  PairMessageStats,
  StoredMessage,
} from "../shared/types.ts";
import "./dashboard.css";

const START_SERVICE_MESSAGE = `Please ensure your application is running and healthy, then register it:

1. **Build**: Run a clean build (e.g. \`mvn package -DskipTests\`) to ensure you have the latest version.
2. **Kill zombies**: Check if anything is already running on your application port (e.g. \`lsof -i :<port> -t\`). If a process is found, kill it before starting fresh.
3. **Start**: Start the application with the appropriate local profile.
4. **Health check**: Wait for the application to be ready, then verify the health endpoint returns a healthy status (e.g. curl the health URL and confirm \`"status":"UP"\`). Common health paths: \`/internal/health\`, \`/actuator/health\`, \`/health\`.
5. **Register**: Once healthy, call \`register_service\` with the correct port, health URL, log format, and **log_file** (absolute path to the application log file, e.g. \`target/app.log\` or check \`logging.file.name\` in application properties). The log_file is required for log viewing in the dashboard.`;

interface LogStats {
  ERROR: number;
  WARN: number;
  INFO: number;
  DEBUG: number;
  TRACE: number;
  total: number;
}

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

const LOG_LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
const MAX_LOG_LINES = 1000;

function LogViewer({
  peerId,
  lines,
  onClose,
}: {
  peerId: string;
  lines: LogLine[];
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    () => new Set<LogLevel>(["ERROR", "WARN", "INFO", "DEBUG"])
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const toggleLevel = (level: LogLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };
    for (const l of lines) c[l.level]++;
    return c;
  }, [lines]);

  const filterLower = filter.toLowerCase();
  const filtered = lines.filter(
    (l) => activeLevels.has(l.level) && (!filterLower || l.raw.toLowerCase().includes(filterLower))
  );

  const handleScroll = () => {
    if (!bodyRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <div className="log-viewer-overlay" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "stretch", justifyContent: "center", zIndex: 100, padding: 40 }}>
      <div className="log-viewer" onClick={(e) => e.stopPropagation()}
        style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 10, width: "100%", maxWidth: 1100, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #21262d", background: "#161b22", flexShrink: 0, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 13, fontWeight: 500, color: "#e6edf3", whiteSpace: "nowrap", margin: 0 }}>Logs: {peerId}</h3>
          <div style={{ display: "flex", gap: 4 }}>
            {LOG_LEVELS.map((level) => {
              const active = activeLevels.has(level);
              const colorMap: Record<string, string> = { error: "#f85149", warn: "#d29922", info: "#58a6ff", debug: "#8b949e", trace: "#6e7681" };
              const c = colorMap[level.toLowerCase()] ?? "#8b949e";
              return (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  style={{
                    background: active ? "#21262d" : "transparent",
                    border: `1px solid ${active ? c : "#30363d"}`,
                    color: active ? c : "#484f58",
                    fontFamily: "inherit", fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                  }}
                >
                  {level} {counts[level] > 0 ? `(${counts[level]})` : ""}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ background: "#0d1117", border: "1px solid #30363d", color: "#c9d1d9", fontFamily: "inherit", fontSize: 12, padding: "4px 10px", borderRadius: 4, width: 160, marginLeft: "auto" }}
          />
          <span style={{ color: "#484f58", fontSize: 11 }}>{lines.length} lines</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#8b949e", fontSize: 20, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>&times;</button>
        </div>
        <div className="log-body" ref={bodyRef} onScroll={handleScroll}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 0", fontSize: 12, lineHeight: 1.6 }}>
          {filtered.length === 0 && (
            <div className="modal-empty">
              {lines.length === 0 ? "Waiting for log lines..." : "No lines match filters"}
            </div>
          )}
          {filtered.map((line, i) => (
            <div key={i} className={`log-line ${line.level.toLowerCase()}`}>
              <span className="log-level-tag">{line.level.padEnd(5)}</span>
              <span className="log-message">{line.raw}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ServiceBadge({ service }: { service: ServiceInfo }) {
  const color = service.status === "up" ? "#3fb950" : service.status === "down" ? "#f85149" : "#848d97";
  return (
    <span className="service-badge" style={{ borderColor: color }}>
      <span className="service-dot" style={{ background: color }} />
      :{service.port}
      {service.last_check && (
        <span className="service-check" title={`Last check: ${service.last_check}`}>
          {timeAgo(service.last_check)}
        </span>
      )}
    </span>
  );
}

function PeerCard({
  peer,
  stats,
  service,
  logStats,
  onClickMessages,
  onStartService,
  onViewLogs,
}: {
  peer: Peer;
  stats: PeerMessageStats | undefined;
  service: ServiceInfo | undefined;
  logStats: LogStats | undefined;
  onClickMessages: () => void;
  onStartService: () => void;
  onViewLogs: () => void;
}) {
  const total = stats ? stats.sent + stats.received : 0;

  return (
    <div className={`peer-card ${peer.connected ? "" : "disconnected"}`}>
      <div className="peer-header">
        <span className="connection-dot" />
        <span className="peer-id">{peer.id}</span>
        {peer.connected && (
          <button
            className={`service-play-btn ${service?.status === "up" ? "up" : ""}`}
            onClick={onStartService}
            title={service?.status === "up" ? `Running on :${service.port}` : "Start service"}
            disabled={service?.status === "up"}
          >
            &#9654;
          </button>
        )}
        {service && <ServiceBadge service={service} />}
        {service?.log_file && (
          <button className="message-count-badge" onClick={onViewLogs} title="View logs">
            Logs
          </button>
        )}
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
      {logStats && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, fontSize: 11, cursor: service?.log_file ? "pointer" : undefined }}
          onClick={service?.log_file ? onViewLogs : undefined}>
          {logStats.ERROR > 0 && <span style={{ color: "#f85149", fontWeight: 600 }}>{logStats.ERROR} errors</span>}
          {logStats.WARN > 0 && <span style={{ color: "#d29922", fontWeight: 500 }}>{logStats.WARN} warn</span>}
          <span style={{ color: "#484f58" }}>{logStats.INFO} info</span>
          <span style={{ color: "#484f58" }}>{logStats.total} lines</span>
        </div>
      )}
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
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [modal, setModal] = useState<{ peer1: string; peer2: string | null } | null>(null);
  const [logViewerPeer, setLogViewerPeer] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logStatsMap, setLogStatsMap] = useState<Map<string, LogStats>>(new Map());
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
          setServices(msg.services ?? []);
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
        case "service_update":
          setServices((prev) => {
            const old = prev.find((s) => s.peer_id === msg.service.peer_id);
            if (old?.status !== msg.service.status) {
              addActivity(`Service ${msg.service.peer_id} :${msg.service.port} → ${msg.service.status}`);
            }
            const filtered = prev.filter((s) => s.peer_id !== msg.service.peer_id);
            return [...filtered, msg.service];
          });
          break;
        case "log_lines":
          setLogLines((prev) => {
            const combined = [...prev, ...msg.lines];
            return combined.length > MAX_LOG_LINES
              ? combined.slice(-MAX_LOG_LINES)
              : combined;
          });
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

  const closeModal = useCallback(() => setModal(null), []);

  const openLogViewer = useCallback((peerId: string) => {
    setLogLines([]);
    setLogViewerPeer(peerId);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe_logs", peer_id: peerId }));
    }
  }, []);

  const closeLogViewer = useCallback(() => {
    if (logViewerPeer) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "unsubscribe_logs", peer_id: logViewerPeer }));
      }
    }
    setLogViewerPeer(null);
    setLogLines([]);
  }, [logViewerPeer]);

  const fetchLogStats = useCallback(async () => {
    const svcs = services.filter((s) => s.log_file);
    if (svcs.length === 0) return;
    const results = await Promise.all(
      svcs.map(async (svc) => {
        try {
          const res = await fetch(`/api/log-stats?peer_id=${encodeURIComponent(svc.peer_id)}`);
          if (res.ok) return [svc.peer_id, await res.json() as LogStats] as const;
        } catch {}
        return null;
      })
    );
    setLogStatsMap((prev) => {
      const next = new Map(prev);
      for (const r of results) {
        if (r) next.set(r[0], r[1]);
      }
      return next;
    });
  }, [services]);

  useEffect(() => {
    fetchLogStats();
    const timer = setInterval(fetchLogStats, 30_000);
    return () => clearInterval(timer);
  }, [fetchLogStats]);

  const clearMessages = async () => {
    await fetch("/api/messages/clear", { method: "POST" });
  };

  const sendToPeer = useCallback((peerId: string, message: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "send_to_peer", peer_id: peerId, message }));
      addActivity(`Sent to ${peerId}: ${message.slice(0, 60)}`);
    }
  }, [addActivity]);

  const peerStatsMap = useMemo(() => new Map(peerStats.map((s) => [s.peer_id, s])), [peerStats]);
  const serviceMap = useMemo(() => new Map(services.map((s) => [s.peer_id, s])), [services]);

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
                  service={serviceMap.get(peer.id)}
                  logStats={logStatsMap.get(peer.id)}
                  onClickMessages={() => setModal({ peer1: peer.id, peer2: null })}
                  onStartService={() => sendToPeer(peer.id, START_SERVICE_MESSAGE)}
                  onViewLogs={() => openLogViewer(peer.id)}
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
          onClose={closeModal}
        />
      )}

      {logViewerPeer && (
        <LogViewer
          peerId={logViewerPeer}
          lines={logLines}
          onClose={closeLogViewer}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Dashboard />);
