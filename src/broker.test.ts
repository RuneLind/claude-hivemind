import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import type { BrokerMessage, DashboardMessage, ClientMessage } from "./shared/types.ts";

// --- Test infrastructure ---

let brokerProcess: Subprocess;
let testPort: number;
let testDbPath: string;
const activeSockets: WebSocket[] = [];
const sleepers: Subprocess[] = [];

/** Spawn a sleeping process and return its real PID. */
function spawnSleeper(): number {
  const proc = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  sleepers.push(proc);
  return proc.pid;
}

/** Find a free port by briefly listening on 0. */
async function findFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Start the broker subprocess with test-specific port and DB. */
async function startBroker(port: number, dbPath: string): Promise<Subprocess> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "broker.ts")], {
    env: {
      ...process.env,
      CLAUDE_HIVEMIND_PORT: String(port),
      CLAUDE_HIVEMIND_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the broker to be ready by polling /health
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return proc;
    } catch {
      // Not ready yet
    }
    await Bun.sleep(100);
  }

  proc.kill();
  throw new Error("Broker did not start within 10 seconds");
}

/** Connect a peer WebSocket and return it. */
function connectPeer(port: number, namespace = "default"): WebSocket {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/peer?namespace=${encodeURIComponent(namespace)}`
  );
  activeSockets.push(ws);
  return ws;
}

/** Connect a dashboard WebSocket and return it. */
function connectDashboard(port: number): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
  activeSockets.push(ws);
  return ws;
}

/** Wait for the WebSocket to open. */
function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("WS open timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

/** Wait for a specific message type from the WebSocket. */
function waitForMessage<T extends { type: string }>(
  ws: WebSocket,
  type: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for message type "${type}"`)),
      timeoutMs
    );
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === type) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(data as T);
        }
      } catch {
        // Ignore parse errors, keep waiting
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Register a peer and wait for the "registered" response. */
async function registerPeer(
  ws: WebSocket,
  opts: { cwd?: string; namespace?: string; summary?: string; pid?: number } = {}
): Promise<BrokerMessage & { type: "registered" }> {
  await waitForOpen(ws);
  const msg: ClientMessage = {
    type: "register",
    pid: opts.pid ?? process.pid,
    cwd: opts.cwd ?? "/test/peer",
    git_root: null,
    git_branch: null,
    tty: null,
    summary: opts.summary ?? "test peer",
    namespace: opts.namespace ?? "default",
  };
  ws.send(JSON.stringify(msg));
  return waitForMessage<BrokerMessage & { type: "registered" }>(ws, "registered");
}

/** Send a typed message on a WebSocket. */
function sendMessage(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Close a WebSocket and wait for it to fully close. */
function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve();
      return;
    }
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close();
  });
}

/** Remove a WebSocket from the activeSockets array. */
function removeFromActive(ws: WebSocket): void {
  const idx = activeSockets.indexOf(ws);
  if (idx >= 0) activeSockets.splice(idx, 1);
}

// --- Suite setup / teardown ---

beforeAll(async () => {
  testPort = await findFreePort();
  testDbPath = join(tmpdir(), `hivemind-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  brokerProcess = await startBroker(testPort, testDbPath);
});

afterEach(async () => {
  // Close all WebSockets opened during a test
  const toClose = activeSockets.splice(0);
  await Promise.all(toClose.map((ws) => closeSocket(ws)));
});

afterAll(async () => {
  // Kill all sleeper processes
  for (const s of sleepers) {
    try { s.kill(); } catch {}
  }
  sleepers.length = 0;

  // Kill broker
  if (brokerProcess) {
    brokerProcess.kill();
    await brokerProcess.exited;
  }
  // Clean up temp DB files
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(testDbPath + suffix); } catch {}
  }
});

// --- Tests ---

describe("broker", () => {
  describe("peer registration", () => {
    test("peer registers and receives a registered message with an ID", async () => {
      const ws = connectPeer(testPort, "test-ns");
      const pid = spawnSleeper();
      const reg = await registerPeer(ws, {
        cwd: "/test/registration",
        namespace: "test-ns",
        pid,
      });

      expect(reg.type).toBe("registered");
      expect(reg.id).toBeTruthy();
      expect(typeof reg.id).toBe("string");
      expect(reg.namespace).toBe("test-ns");
    });

    test("peer ID is derived from the last path segment of cwd", async () => {
      const ws = connectPeer(testPort, "id-test");
      const pid = spawnSleeper();
      const reg = await registerPeer(ws, {
        cwd: "/some/path/my-project",
        namespace: "id-test",
        pid,
      });

      expect(reg.id).toBe("my-project");
    });

    test("duplicate cwd last segment gets a numeric suffix", async () => {
      const ws1 = connectPeer(testPort, "dup-test");
      const ws2 = connectPeer(testPort, "dup-test");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();

      const reg1 = await registerPeer(ws1, {
        cwd: "/path/dup-project",
        namespace: "dup-test",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/other/dup-project",
        namespace: "dup-test",
        pid: pid2,
      });

      expect(reg1.id).toBe("dup-project");
      expect(reg2.id).toBe("dup-project-2");
    });
  });

  describe("messaging", () => {
    test("two peers in the same namespace can exchange messages", async () => {
      const ws1 = connectPeer(testPort, "msg-ns");
      const ws2 = connectPeer(testPort, "msg-ns");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();

      const reg1 = await registerPeer(ws1, {
        cwd: "/test/sender",
        namespace: "msg-ns",
        summary: "sender peer",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/test/receiver",
        namespace: "msg-ns",
        summary: "receiver peer",
        pid: pid2,
      });

      // Send a message from peer1 to peer2
      const messagePromise = waitForMessage<BrokerMessage & { type: "message" }>(
        ws2,
        "message"
      );
      sendMessage(ws1, {
        type: "send_message",
        to: reg2.id,
        text: "hello from sender",
      });

      const received = await messagePromise;
      expect(received.type).toBe("message");
      expect(received.from_id).toBe(reg1.id);
      expect(received.text).toBe("hello from sender");
      expect(received.from_summary).toBe("sender peer");
      expect(received.sent_at).toBeTruthy();
    });

    test("cross-namespace message returns an error", async () => {
      const ws1 = connectPeer(testPort, "ns-a");
      const ws2 = connectPeer(testPort, "ns-b");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();

      await registerPeer(ws1, {
        cwd: "/test/cross-a",
        namespace: "ns-a",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/test/cross-b",
        namespace: "ns-b",
        pid: pid2,
      });

      // Try to send cross-namespace
      const errorPromise = waitForMessage<BrokerMessage & { type: "error" }>(
        ws1,
        "error"
      );
      sendMessage(ws1, {
        type: "send_message",
        to: reg2.id,
        text: "should fail",
      });

      const err = await errorPromise;
      expect(err.type).toBe("error");
      expect(err.error).toContain("different namespace");
    });

    test("message to non-existent peer returns an error", async () => {
      const ws = connectPeer(testPort, "err-ns");
      const pid = spawnSleeper();
      await registerPeer(ws, {
        cwd: "/test/err-sender",
        namespace: "err-ns",
        pid,
      });

      const errorPromise = waitForMessage<BrokerMessage & { type: "error" }>(
        ws,
        "error"
      );
      sendMessage(ws, {
        type: "send_message",
        to: "nonexistent-peer",
        text: "hello?",
      });

      const err = await errorPromise;
      expect(err.type).toBe("error");
      expect(err.error).toContain("not found");
    });
  });

  describe("list_peers", () => {
    test("scope 'namespace' only returns same-namespace peers", async () => {
      const ws1 = connectPeer(testPort, "list-ns-a");
      const ws2 = connectPeer(testPort, "list-ns-a");
      const ws3 = connectPeer(testPort, "list-ns-b");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();
      const pid3 = spawnSleeper();

      await registerPeer(ws1, {
        cwd: "/test/list-a1",
        namespace: "list-ns-a",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/test/list-a2",
        namespace: "list-ns-a",
        pid: pid2,
      });
      const reg3 = await registerPeer(ws3, {
        cwd: "/test/list-b1",
        namespace: "list-ns-b",
        pid: pid3,
      });

      // ws1 asks for namespace peers
      const peersPromise = waitForMessage<BrokerMessage & { type: "peers" }>(
        ws1,
        "peers"
      );
      sendMessage(ws1, { type: "list_peers", scope: "namespace" });

      const result = await peersPromise;
      expect(result.type).toBe("peers");
      // Should include ws2 (same namespace) but not ws3 (different namespace)
      const peerIds = result.peers.map((p) => p.id);
      expect(peerIds).toContain(reg2.id);
      expect(peerIds).not.toContain(reg3.id);
    });

    test("scope 'machine' returns all peers (except self)", async () => {
      const ws1 = connectPeer(testPort, "machine-a");
      const ws2 = connectPeer(testPort, "machine-b");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();

      const reg1 = await registerPeer(ws1, {
        cwd: "/test/machine-a1",
        namespace: "machine-a",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/test/machine-b1",
        namespace: "machine-b",
        pid: pid2,
      });

      const peersPromise = waitForMessage<BrokerMessage & { type: "peers" }>(
        ws1,
        "peers"
      );
      sendMessage(ws1, { type: "list_peers", scope: "machine" });

      const result = await peersPromise;
      expect(result.type).toBe("peers");
      const peerIds = result.peers.map((p) => p.id);
      // Self excluded, cross-namespace peer included
      expect(peerIds).not.toContain(reg1.id);
      expect(peerIds).toContain(reg2.id);
    });
  });

  describe("peer disconnect", () => {
    test("peer disconnect marks peer as disconnected", async () => {
      const ws = connectPeer(testPort, "dc-ns");
      const pid = spawnSleeper();
      const reg = await registerPeer(ws, {
        cwd: "/test/disconnect-peer",
        namespace: "dc-ns",
        pid,
      });

      // Verify peer is connected via API
      const beforeRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      const beforeData = (await beforeRes.json()) as { peers: Array<{ id: string; connected: number }> };
      const beforePeer = beforeData.peers.find((p) => p.id === reg.id);
      expect(beforePeer?.connected).toBe(1);

      // Close the socket
      await closeSocket(ws);
      removeFromActive(ws);

      // Give the broker a moment to process the disconnect
      await Bun.sleep(200);

      // Verify peer shows as disconnected (still in DB during grace period)
      const afterRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      const afterData = (await afterRes.json()) as { peers: Array<{ id: string; connected: number }> };
      const afterPeer = afterData.peers.find((p) => p.id === reg.id);
      if (afterPeer) {
        expect(afterPeer.connected).toBe(0);
      }
    });

    test("other peers in same namespace are notified of peer_left", async () => {
      const ws1 = connectPeer(testPort, "notify-ns");
      const ws2 = connectPeer(testPort, "notify-ns");

      const pid1 = spawnSleeper();
      const pid2 = spawnSleeper();

      await registerPeer(ws1, {
        cwd: "/test/notify-stayer",
        namespace: "notify-ns",
        pid: pid1,
      });
      const reg2 = await registerPeer(ws2, {
        cwd: "/test/notify-leaver",
        namespace: "notify-ns",
        pid: pid2,
      });

      // Listen for peer_left on ws1
      const leftPromise = waitForMessage<{ type: "peer_left"; peer_id: string }>(
        ws1,
        "peer_left"
      );

      // Disconnect ws2
      await closeSocket(ws2);
      removeFromActive(ws2);

      const leftMsg = await leftPromise;
      expect(leftMsg.type).toBe("peer_left");
      expect(leftMsg.peer_id).toBe(reg2.id);
    });
  });

  describe("dashboard WebSocket", () => {
    test("dashboard receives a snapshot on connect", async () => {
      // First register a peer so the snapshot has content
      const peerWs = connectPeer(testPort, "dash-ns");
      const pid = spawnSleeper();
      await registerPeer(peerWs, {
        cwd: "/test/dash-peer",
        namespace: "dash-ns",
        pid,
      });

      // Connect dashboard
      const dashWs = connectDashboard(testPort);
      const snapshot = await waitForMessage<DashboardMessage & { type: "snapshot" }>(
        dashWs,
        "snapshot"
      );

      expect(snapshot.type).toBe("snapshot");
      expect(Array.isArray(snapshot.peers)).toBe(true);
      expect(Array.isArray(snapshot.namespaces)).toBe(true);
      expect(Array.isArray(snapshot.peer_stats)).toBe(true);
      expect(Array.isArray(snapshot.pair_stats)).toBe(true);
      expect(Array.isArray(snapshot.services)).toBe(true);
      expect(Array.isArray(snapshot.baselines)).toBe(true);

      // Our peer should be in the snapshot
      const dashPeer = snapshot.peers.find((p) => p.namespace === "dash-ns");
      expect(dashPeer).toBeTruthy();
    });

    test("dashboard receives peer_joined when a new peer registers", async () => {
      const dashWs = connectDashboard(testPort);
      // Wait for initial snapshot first
      await waitForMessage<DashboardMessage & { type: "snapshot" }>(dashWs, "snapshot");

      // Now register a peer
      const peerWs = connectPeer(testPort, "dash-join-ns");
      const pid = spawnSleeper();
      const joinPromise = waitForMessage<DashboardMessage & { type: "peer_joined" }>(
        dashWs,
        "peer_joined"
      );

      await registerPeer(peerWs, {
        cwd: "/test/dash-join-peer",
        namespace: "dash-join-ns",
        pid,
      });

      const joinMsg = await joinPromise;
      expect(joinMsg.type).toBe("peer_joined");
      expect(joinMsg.peer).toBeTruthy();
      expect(joinMsg.peer.namespace).toBe("dash-join-ns");
    });

    test("dashboard receives peer_left when a peer disconnects", async () => {
      const peerWs = connectPeer(testPort, "dash-left-ns");
      const pid = spawnSleeper();
      const reg = await registerPeer(peerWs, {
        cwd: "/test/dash-left-peer",
        namespace: "dash-left-ns",
        pid,
      });

      const dashWs = connectDashboard(testPort);
      await waitForMessage<DashboardMessage & { type: "snapshot" }>(dashWs, "snapshot");

      const leftPromise = waitForMessage<DashboardMessage & { type: "peer_left" }>(
        dashWs,
        "peer_left"
      );

      // Disconnect the peer
      await closeSocket(peerWs);
      removeFromActive(peerWs);

      const leftMsg = await leftPromise;
      expect(leftMsg.type).toBe("peer_left");
      expect(leftMsg.peer_id).toBe(reg.id);
      expect(leftMsg.namespace).toBe("dash-left-ns");
    });
  });

  describe("HTTP API", () => {
    test("/health returns status ok with peer count", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      expect(res.ok).toBe(true);
      const data = (await res.json()) as { status: string; peers: number; namespaces: string[] };
      expect(data.status).toBe("ok");
      expect(typeof data.peers).toBe("number");
      expect(Array.isArray(data.namespaces)).toBe(true);
    });

    test("/api/status returns peers and namespaces", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      expect(res.ok).toBe(true);
      const data = (await res.json()) as { peers: unknown[]; namespaces: unknown[] };
      expect(Array.isArray(data.peers)).toBe(true);
      expect(Array.isArray(data.namespaces)).toBe(true);
    });

    test("/ returns HTML dashboard", async () => {
      const res = await fetch(`http://127.0.0.1:${testPort}/`);
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/html");
    });
  });

  describe("set_summary", () => {
    test("peer can update its summary", async () => {
      const ws = connectPeer(testPort, "summary-ns");
      const pid = spawnSleeper();
      const reg = await registerPeer(ws, {
        cwd: "/test/summary-peer",
        namespace: "summary-ns",
        summary: "initial summary",
        pid,
      });

      // Update summary
      sendMessage(ws, { type: "set_summary", summary: "updated summary" });

      // Give broker a moment to process
      await Bun.sleep(200);

      // Check via API
      const res = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      const data = (await res.json()) as { peers: Array<{ id: string; summary: string }> };
      const peer = data.peers.find((p) => p.id === reg.id);
      expect(peer?.summary).toBe("updated summary");
    });
  });

  describe("heartbeat", () => {
    test("heartbeat updates last_seen timestamp", async () => {
      const ws = connectPeer(testPort, "hb-ns");
      const pid = spawnSleeper();
      const reg = await registerPeer(ws, {
        cwd: "/test/heartbeat-peer",
        namespace: "hb-ns",
        pid,
      });

      // Get initial last_seen
      const res1 = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      const data1 = (await res1.json()) as { peers: Array<{ id: string; last_seen: string }> };
      const initialLastSeen = data1.peers.find((p) => p.id === reg.id)?.last_seen;

      // Wait a tiny bit and send heartbeat
      await Bun.sleep(50);
      sendMessage(ws, { type: "heartbeat" });
      await Bun.sleep(200);

      // Check updated last_seen
      const res2 = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      const data2 = (await res2.json()) as { peers: Array<{ id: string; last_seen: string }> };
      const updatedLastSeen = data2.peers.find((p) => p.id === reg.id)?.last_seen;

      expect(updatedLastSeen).toBeTruthy();
      expect(initialLastSeen).toBeTruthy();
      expect(new Date(updatedLastSeen!).getTime()).toBeGreaterThanOrEqual(
        new Date(initialLastSeen!).getTime()
      );
    });
  });
});
