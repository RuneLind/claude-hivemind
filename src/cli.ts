#!/usr/bin/env bun
/**
 * claude-hivemind CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all peers
 *   bun cli.ts peers           — List all peers grouped by namespace
 *   bun cli.ts send <id> <msg> — Send a message to a peer
 *   bun cli.ts dashboard       — Open dashboard in browser
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

import type { Peer } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.CLAUDE_HIVEMIND_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function fetchAllPeers(): Promise<Peer[]> {
  return brokerFetch<Peer[]>("/api/list-peers", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });
}

function groupByNamespace(peers: Peer[]): Record<string, Peer[]> {
  const grouped: Record<string, Peer[]> = {};
  for (const p of peers) {
    (grouped[p.namespace] ??= []).push(p);
  }
  return grouped;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{
        status: string;
        peers: number;
        namespaces: string[];
      }>("/health");
      console.log(`Broker: ${health.status}`);
      console.log(`Peers: ${health.peers}`);
      console.log(`Namespaces: ${health.namespaces.join(", ") || "(none)"}`);
      console.log(`URL: ${BROKER_URL}`);
      console.log(`Dashboard: ${BROKER_URL}/`);

      if (health.peers > 0) {
        const peers = await fetchAllPeers();
        const grouped = groupByNamespace(peers);

        for (const [ns, nsPeers] of Object.entries(grouped).sort()) {
          console.log(`\n[${ns}] (${nsPeers.length} peer(s))`);
          for (const p of nsPeers) {
            const status = p.connected ? "●" : "○";
            console.log(`  ${status} ${p.id}  PID:${p.pid}  ${p.cwd}`);
            if (p.git_branch) console.log(`         Branch: ${p.git_branch}`);
            if (p.summary) console.log(`         ${p.summary}`);
            console.log(`         Last seen: ${p.last_seen}`);
          }
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await fetchAllPeers();

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        const grouped = groupByNamespace(peers);

        for (const [ns, nsPeers] of Object.entries(grouped).sort()) {
          console.log(`[${ns}]`);
          for (const p of nsPeers) {
            const status = p.connected ? "●" : "○";
            const parts = [`  ${status} ${p.id}  PID:${p.pid}  ${p.cwd}`];
            if (p.summary) parts.push(`    Summary: ${p.summary}`);
            console.log(parts.join("\n"));
          }
          console.log();
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>(
        "/api/send-message",
        {
          from_id: "cli",
          to_id: toId,
          text: msg,
        }
      );
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(
        `Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    break;
  }

  case "dashboard": {
    const url = `${BROKER_URL}/`;
    console.log(`Opening dashboard: ${url}`);
    Bun.spawn(["open", url]);
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{
        status: string;
        peers: number;
      }>("/health");
      console.log(
        `Broker has ${health.peers} peer(s). Shutting down...`
      );
      const proc = Bun.spawnSync(["lsof", "-ti", `tcp:${BROKER_PORT}`, "-sTCP:LISTEN"]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-hivemind CLI

Usage:
  bun cli.ts status          Show broker status and all peers
  bun cli.ts peers           List all peers grouped by namespace
  bun cli.ts send <id> <msg> Send a message to a peer
  bun cli.ts dashboard       Open dashboard in browser
  bun cli.ts kill-broker     Stop the broker daemon`);
}
