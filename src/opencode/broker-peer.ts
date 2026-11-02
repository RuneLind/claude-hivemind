/**
 * Broker WebSocket client for an OpenCode peer (used by ./plugin.ts).
 *
 * Speaks the same peer protocol as the MCP server (src/server.ts): register,
 * heartbeat, set_summary, send_message, list_peers, register_service. Unlike
 * server.ts it holds its state in an instance and takes the WebSocket
 * constructor as a parameter, so tests can drive it against a fake broker.
 *
 * It registers WITHOUT surface_id: the broker then routes messages for this
 * peer over the WebSocket (peers.ts deliverOrQueue), and the plugin injects
 * them into the OpenCode session itself.
 */

import type { BrokerMessage, ClientMessage, Peer, PeerId } from "../shared/types.ts";

export type InboundMessage = Extract<BrokerMessage, { type: "message" }>;
export type SendStatus = "delivered" | "queued" | "failed" | "unknown";

export interface BrokerPeerOptions {
  port: number;
  namespace: string;
  /** Registration payload minus the protocol fields this class fills in. */
  register: Omit<Extract<ClientMessage, { type: "register" }>, "type" | "namespace" | "summary">;
  onMessage: (msg: InboundMessage) => void;
  log?: (msg: string) => void;
  WebSocketImpl?: typeof WebSocket;
  /** Timeouts for list_peers / send_result, overridable in tests. */
  requestTimeoutMs?: number;
}

const MAX_RECONNECT_DELAY = 30_000;
const HEARTBEAT_MS = 30_000;

export class BrokerPeer {
  id: PeerId | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSummary: string | null = null;
  private services = new Map<number, Extract<ClientMessage, { type: "register_service" }>>();
  private peerWaiters: { resolve: (p: Peer[]) => void; reject: (e: Error) => void }[] = [];
  private sendWaiters = new Map<string, (s: SendStatus) => void>();
  private readonly WS: typeof WebSocket;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private opts: BrokerPeerOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.timeoutMs = opts.requestTimeoutMs ?? 5000;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.id = null;
    try { ws?.close(); } catch {}
  }

  get connected(): boolean {
    return this.id !== null && this.ws?.readyState === this.WS.OPEN;
  }

  private connect(): void {
    const url = `ws://127.0.0.1:${this.opts.port}/ws/peer?namespace=${encodeURIComponent(this.opts.namespace)}`;
    const ws = new this.WS(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.raw({ type: "register", namespace: this.opts.namespace, summary: "", ...this.opts.register });
      // Replay state the broker lost with the previous socket.
      if (this.lastSummary !== null) this.raw({ type: "set_summary", summary: this.lastSummary });
      for (const svc of this.services.values()) this.raw(svc);
      this.startHeartbeat();
    });

    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      let msg: BrokerMessage;
      try {
        msg = JSON.parse(String((ev as MessageEvent).data)) as BrokerMessage;
      } catch (e) {
        this.log(`invalid broker message: ${e}`);
        return;
      }
      this.handle(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.id = null;
      this.stopHeartbeat();
      // Fail in-flight requests now instead of letting them hang to timeout.
      for (const w of this.peerWaiters.splice(0)) w.reject(new Error("broker connection closed"));
      for (const [sid, resolve] of this.sendWaiters) {
        this.sendWaiters.delete(sid);
        resolve("unknown");
      }
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = Math.min(1000 * 2 ** this.attempts, MAX_RECONNECT_DELAY);
    const delay = Math.round(base + Math.random() * base * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.raw({ type: "heartbeat" }), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handle(msg: BrokerMessage): void {
    switch (msg.type) {
      case "registered":
        this.id = msg.id;
        this.log(`registered as ${msg.id} (namespace ${msg.namespace})`);
        break;
      case "message":
        this.opts.onMessage(msg);
        break;
      case "peers":
        this.peerWaiters.shift()?.resolve(msg.peers);
        break;
      case "send_result": {
        const resolve = this.sendWaiters.get(msg.send_id);
        if (resolve) {
          this.sendWaiters.delete(msg.send_id);
          resolve(msg.status);
        }
        break;
      }
      case "error":
        // The broker sends "error" for a send_message to an unknown peer, never
        // for list_peers, and the send already resolves through send_result. A
        // list_peers waiter must not take it.
        this.log(`broker error: ${msg.error}`);
        break;
      default:
        break;
    }
  }

  private raw(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WS.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  listPeers(scope: "namespace" | "machine"): Promise<Peer[]> {
    if (!this.connected) return Promise.reject(new Error("not connected to the hivemind broker"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.peerWaiters.push(waiter);
      this.raw({ type: "list_peers", scope });
      setTimeout(() => {
        const i = this.peerWaiters.indexOf(waiter);
        if (i >= 0) {
          this.peerWaiters.splice(i, 1);
          reject(new Error("list_peers timed out"));
        }
      }, this.timeoutMs);
    });
  }

  /** Resolves "failed" without sending when the socket is down. */
  sendMessage(to: PeerId, text: string, correlationId?: string): Promise<SendStatus> {
    if (!this.connected) return Promise.resolve("failed");
    const send_id = crypto.randomUUID();
    return new Promise((resolve) => {
      this.sendWaiters.set(send_id, resolve);
      setTimeout(() => {
        if (this.sendWaiters.delete(send_id)) resolve("unknown");
      }, this.timeoutMs);
      this.raw({ type: "send_message", to, text, correlation_id: correlationId, send_id });
    });
  }

  setSummary(summary: string): boolean {
    if (!this.raw({ type: "set_summary", summary })) return false;
    this.lastSummary = summary;
    return true;
  }

  registerService(svc: Omit<Extract<ClientMessage, { type: "register_service" }>, "type">): boolean {
    const payload = { type: "register_service" as const, ...svc };
    if (!this.raw(payload)) return false;
    this.services.set(svc.port, payload);
    return true;
  }
}
