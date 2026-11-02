import { describe, test, expect, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { BrokerPeer, type InboundMessage } from "./broker-peer.ts";

/** A fake broker: records what the peer sends and lets the test reply. */
function fakeBroker(onClientMessage: (msg: any, ws: ServerWebSocket<unknown>) => void = () => {}) {
  const received: any[] = [];
  const sockets: ServerWebSocket<unknown>[] = [];
  let lastUrl = "";
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      lastUrl = req.url;
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(ws, data) {
        const msg = JSON.parse(String(data));
        received.push(msg);
        if (msg.type === "register") ws.send(JSON.stringify({ type: "registered", id: "oc-peer", namespace: msg.namespace }));
        onClientMessage(msg, ws);
      },
    },
  });
  return { server, received, sockets, url: () => lastUrl };
}

async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(5);
  if (!pred()) throw new Error("until() timed out");
}

const register = {
  pid: 4242,
  cwd: "/src/proj",
  git_root: "/src/proj",
  git_branch: "main",
  tty: null,
  agent_type: "opencode" as const,
};

describe("BrokerPeer", () => {
  let peer: BrokerPeer | null = null;
  let broker: ReturnType<typeof fakeBroker> | null = null;

  afterEach(() => {
    peer?.stop();
    broker?.server.stop(true);
    peer = null;
    broker = null;
  });

  test("registers as an opencode peer without surface_id and learns its id", async () => {
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "private", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);

    expect(peer.id).toBe("oc-peer");
    expect(broker.url()).toContain("/ws/peer?namespace=private");
    const reg = broker.received.find((m) => m.type === "register");
    expect(reg).toMatchObject({ type: "register", agent_type: "opencode", namespace: "private", cwd: "/src/proj", pid: 4242 });
    expect(reg.surface_id).toBeUndefined();
  });

  test("registers with acks and sends an ack for a message id", async () => {
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);
    expect(broker.received.find((m) => m.type === "register").acks).toBe(true);
    (peer as any).ack(42);
    await until(() => broker!.received.some((m) => m.type === "ack"));
    expect(broker.received.find((m) => m.type === "ack")).toEqual({ type: "ack", message_id: 42 });
  });

  test("passes inbound messages to onMessage", async () => {
    const got: InboundMessage[] = [];
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: (m) => got.push(m) });
    peer.start();
    await until(() => peer!.connected);
    broker.sockets[0]!.send(
      JSON.stringify({ type: "message", from_id: "huginn", from_summary: "", from_cwd: "/x", text: "ping", sent_at: "t", correlation_id: "tok" }),
    );
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ from_id: "huginn", text: "ping", correlation_id: "tok" });
  });

  test("sendMessage resolves with the broker's send_result for that send_id", async () => {
    broker = fakeBroker((msg, ws) => {
      if (msg.type === "send_message") ws.send(JSON.stringify({ type: "send_result", send_id: msg.send_id, status: "queued" }));
    });
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);

    const status = await peer.sendMessage("huginn", "hello", "tok-1");
    expect(status).toBe("queued");
    expect(broker.received.find((m) => m.type === "send_message")).toMatchObject({ to: "huginn", text: "hello", correlation_id: "tok-1" });
  });

  test("sendMessage reports failed when not connected, and unknown on timeout", async () => {
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {}, requestTimeoutMs: 50 });
    expect(await peer.sendMessage("x", "y")).toBe("failed");
    peer.start();
    await until(() => peer!.connected);
    expect(await peer.sendMessage("x", "y")).toBe("unknown");
  });

  test("listPeers resolves with the broker's peers reply", async () => {
    broker = fakeBroker((msg, ws) => {
      if (msg.type === "list_peers") ws.send(JSON.stringify({ type: "peers", peers: [{ id: "huginn" }] }));
    });
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);
    const peers = await peer.listPeers("machine");
    expect(peers.map((p) => p.id)).toEqual(["huginn"]);
    expect(broker.received.find((m) => m.type === "list_peers")).toEqual({ type: "list_peers", scope: "machine" });
  });

  test("a broker error reply (for a send) does not reject a pending listPeers", async () => {
    broker = fakeBroker((msg, ws) => {
      if (msg.type === "send_message") ws.send(JSON.stringify({ type: "error", error: `Peer ${msg.to} not found` }));
      if (msg.type === "list_peers") setTimeout(() => ws.send(JSON.stringify({ type: "peers", peers: [{ id: "huginn" }] })), 30);
    });
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {}, requestTimeoutMs: 500 });
    peer.start();
    await until(() => peer!.connected);
    const list = peer.listPeers("machine");
    void peer.sendMessage("nosuchpeer", "x");
    const peers = await list;
    expect(peers.map((p) => p.id)).toEqual(["huginn"]);
  });

  test("reconnects after the broker drops it and replays summary and services", async () => {
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);
    expect(peer.setSummary("working on X")).toBe(true);
    expect(peer.registerService({ port: 8080, health_url: "/health" })).toBe(true);
    await until(() => broker!.received.some((m) => m.type === "register_service"));

    broker.received.length = 0;
    broker.sockets[0]!.close();
    await until(() => !peer!.connected);
    // First reconnect is scheduled after 1-1.5s.
    await until(() => broker!.received.some((m) => m.type === "register_service"), 3000);

    const types = broker.received.map((m) => m.type);
    expect(types.slice(0, 3)).toEqual(["register", "set_summary", "register_service"]);
    expect(broker.received[1]).toEqual({ type: "set_summary", summary: "working on X" });
  });

  test("stop() does not reconnect", async () => {
    broker = fakeBroker();
    peer = new BrokerPeer({ port: broker.server.port!, namespace: "default", register, onMessage: () => {} });
    peer.start();
    await until(() => peer!.connected);
    peer.stop();
    broker.received.length = 0;
    await Bun.sleep(1600);
    expect(broker.received).toHaveLength(0);
  });
});
