import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { Peer, NamespaceInfo } from "../shared/types.ts";
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

function PeerCard({ peer }: { peer: Peer }) {
  return (
    <div className={`peer-card ${peer.connected ? "" : "disconnected"}`}>
      <div className="peer-header">
        <span className="connection-dot" />
        <span className="peer-id">{peer.id}</span>
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

function Dashboard() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
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
          addActivity(
            `${msg.from_id} → ${msg.to_id}: ${msg.text.slice(0, 60)}`
          );
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

  const grouped = peers.reduce(
    (acc, peer) => {
      (acc[peer.namespace] ??= []).push(peer);
      return acc;
    },
    {} as Record<string, Peer[]>
  );

  const sortedNamespaces = Object.keys(grouped).sort();

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
      </header>

      {sortedNamespaces.map((ns) => (
        <section
          key={ns}
          className="namespace-group"
          style={{ "--ns-color": namespaceColor(ns) } as React.CSSProperties}
        >
          <h2>
            {ns}
            <span className="ns-count">{grouped[ns].length}</span>
            <span className="ns-badge">Can message each other</span>
          </h2>
          <div className="peer-grid">
            {grouped[ns].map((peer) => (
              <PeerCard key={peer.id} peer={peer} />
            ))}
          </div>
        </section>
      ))}

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
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Dashboard />);
