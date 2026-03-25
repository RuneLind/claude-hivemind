// --- Core types ---

export type PeerId = string;
export type Namespace = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  tty: string | null;
  summary: string;
  namespace: Namespace;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  connected: number; // 0 or 1 (SQLite boolean)
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: number; // 0 or 1
}

// --- WebSocket protocol: Client → Broker ---

export type ClientMessage =
  | {
      type: "register";
      pid: number;
      cwd: string;
      git_root: string | null;
      git_branch: string | null;
      tty: string | null;
      summary: string;
      namespace: Namespace;
    }
  | { type: "set_summary"; summary: string }
  | { type: "send_message"; to: PeerId; text: string }
  | { type: "list_peers"; scope: "namespace" | "machine" }
  | { type: "heartbeat" };

// --- WebSocket protocol: Broker → Client ---

export type BrokerMessage =
  | { type: "registered"; id: PeerId; namespace: Namespace }
  | {
      type: "message";
      from_id: PeerId;
      from_summary: string;
      from_cwd: string;
      text: string;
      sent_at: string;
    }
  | { type: "peers"; peers: Peer[] }
  | { type: "error"; error: string }
  | { type: "peer_joined"; peer: Peer }
  | { type: "peer_left"; peer_id: PeerId }
  | { type: "peer_updated"; peer: Peer };

// --- WebSocket protocol: Broker → Dashboard ---

export type DashboardMessage =
  | { type: "snapshot"; peers: Peer[]; namespaces: NamespaceInfo[]; peer_stats: PeerMessageStats[]; pair_stats: PairMessageStats[] }
  | { type: "peer_joined"; peer: Peer }
  | { type: "peer_left"; peer_id: PeerId; namespace: Namespace }
  | { type: "peer_updated"; peer: Peer }
  | {
      type: "message_sent";
      from_id: PeerId;
      to_id: PeerId;
      text: string;
      sent_at: string;
      peer_stats: PeerMessageStats[];
      pair_stats: PairMessageStats[];
    }
  | { type: "messages_cleared" };

export interface NamespaceInfo {
  name: Namespace;
  peer_count: number;
}

// --- Message statistics ---

export interface PeerMessageStats {
  peer_id: PeerId;
  sent: number;
  received: number;
}

export interface PairMessageStats {
  from_id: PeerId;
  to_id: PeerId;
  count: number;
}

export interface StoredMessage {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string;
}

// --- Namespace configuration ---

export interface NamespaceRule {
  name: string;
  path_prefix: string;
}

export interface NamespaceConfig {
  rules: NamespaceRule[];
  default_namespace: string;
}
