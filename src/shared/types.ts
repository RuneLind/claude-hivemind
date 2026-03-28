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

export const DEFAULT_HEALTH_URL = "/health";
export const DEFAULT_LOG_FORMAT = "plain" as const;
export const DASHBOARD_SENDER_ID = "__dashboard__";

export interface ServiceInfo {
  peer_id: PeerId;
  port: number;
  health_url: string;
  log_file: string | null;
  log_format: "spring" | "json" | "plain";
  status: "up" | "down" | "unknown";
  last_check: string | null; // ISO timestamp
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
  | { type: "heartbeat" }
  | {
      type: "register_service";
      port: number;
      health_url: string;
      log_file?: string;
      log_format?: "spring" | "json" | "plain";
    };

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

export interface LogBaseline {
  namespace: Namespace;
  baseline_at: string; // ISO timestamp
}

export type DashboardMessage =
  | { type: "snapshot"; peers: Peer[]; namespaces: NamespaceInfo[]; peer_stats: PeerMessageStats[]; pair_stats: PairMessageStats[]; services: ServiceInfo[]; baselines: LogBaseline[] }
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
  | { type: "messages_cleared" }
  | { type: "service_update"; service: ServiceInfo }
  | { type: "log_lines"; peer_id: PeerId; lines: LogLine[] }
  | { type: "baseline_set"; namespace: Namespace; baseline_at: string }
  | { type: "baseline_cleared"; namespace: Namespace }
  | { type: "docker_snapshot"; containers: DockerContainer[]; logStats: DockerContainerLogStats[] }
  | { type: "docker_update"; containers: DockerContainer[] }
  | { type: "docker_event"; containerId: string; container: DockerContainer | null; event: string }
  | { type: "docker_log_lines"; containerId: string; lines: LogLine[] }
  | { type: "docker_log_stats"; logStats: DockerContainerLogStats[] }
  | { type: "cmux_status"; available: boolean; workspaces: CmuxWorkspace[] }
  | { type: "cmux_launch_result"; ok: boolean; workspaceId?: string; error?: string };

// --- WebSocket protocol: Dashboard → Broker ---

export type DashboardClientMessage =
  | { type: "send_to_peer"; peer_id: PeerId; message: string }
  | { type: "subscribe_logs"; peer_id: PeerId }
  | { type: "unsubscribe_logs"; peer_id: PeerId }
  | { type: "set_baseline"; namespace: Namespace }
  | { type: "clear_baseline"; namespace: Namespace }
  | { type: "subscribe_docker_logs"; containerId: string }
  | { type: "unsubscribe_docker_logs"; containerId: string }
  | { type: "stop_docker_container"; containerId: string }
  | { type: "stop_service"; peer_id: PeerId }
  | { type: "launch_claude_instance"; directory: string; name?: string; prompt?: string };

// --- cmux integration ---

export interface CmuxStatus {
  available: boolean;
  workspaces: CmuxWorkspace[];
}

export interface CmuxWorkspace {
  id: string;
  name: string;
}

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

// --- Log types ---

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export interface LogLine {
  timestamp: string;
  level: LogLevel;
  message: string;
  raw: string;
}

// --- Docker container types ---

export interface DockerContainer {
  id: string;        // short container ID
  name: string;      // container name
  service: string;   // docker compose service name
  project: string;   // compose project name
  state: "running" | "exited" | "paused" | "restarting" | "dead" | "created";
  status: string;    // human-readable: "Up 2 hours"
  health: string;    // "healthy" | "unhealthy" | "starting" | ""
  ports: string;     // formatted port mappings
  image: string;     // image name
  cpuPerc: string;   // "0.25%"
  memPerc: string;   // "1.23%"
  memUsage: string;  // "45MiB / 8GiB"
}

export interface DockerContainerLogStats {
  containerId: string;
  errorCount: number;
  warnCount: number;
  totalLines: number;
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
