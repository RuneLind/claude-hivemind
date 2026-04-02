#!/usr/bin/env bun
/**
 * claude-hivemind MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the broker via WebSocket for real-time peer messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-hivemind
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_HEALTH_URL } from "./shared/types.ts";
import type {
  PeerId,
  Peer,
  AgentType,
  ClientMessage,
  BrokerMessage,
} from "./shared/types.ts";
import {
  resolveNamespace,
  loadNamespaceConfig,
} from "./shared/namespace.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const BROKER_PORT = parseInt(process.env.CLAUDE_HIVEMIND_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_WS_URL = `ws://127.0.0.1:${BROKER_PORT}`;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const MAX_RECONNECT_DELAY = 30_000;

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myGitBranch: string | null = null;
let myNamespace = "default";
let ws: WebSocket | null = null;
let reconnectAttempts = 0;

const myAgentType: AgentType = (process.env.CLAUDE_HIVEMIND_AGENT_TYPE as AgentType) ?? "claude-code";
const myOpenCodeUrl: string | null = process.env.OPENCODE_URL ?? null;
const mySurfaceId: string | null = process.env.CMUX_SURFACE_ID ?? null;
const myWorkspaceId: string | null = process.env.CMUX_WORKSPACE_ID ?? null;

let pendingPeersResolve: ((peers: Peer[]) => void) | null = null;
let pendingPeersReject: ((err: Error) => void) | null = null;

function log(msg: string) {
  console.error(`[claude-hivemind] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {}
  return null;
}

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {}
  return null;
}

function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") return tty;
    }
  } catch {}
  return null;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

function connectToBroker(): void {
  const wsUrl = `${BROKER_WS_URL}/ws/peer?namespace=${encodeURIComponent(myNamespace)}`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    log("WebSocket connected to broker");
    reconnectAttempts = 0;

    const registerMsg: ClientMessage = {
      type: "register",
      pid: process.pid,
      cwd: myCwd,
      git_root: myGitRoot,
      git_branch: myGitBranch,
      tty: getTty(),
      summary: "",
      namespace: myNamespace,
      agent_type: myAgentType,
      opencode_url: myOpenCodeUrl ?? undefined,
      surface_id: mySurfaceId ?? undefined,
      workspace_id: myWorkspaceId ?? undefined,
    };
    ws!.send(JSON.stringify(registerMsg));
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as BrokerMessage;
      handleBrokerMessage(msg);
    } catch (e) {
      log(`Invalid broker message: ${e}`);
    }
  });

  ws.addEventListener("close", () => {
    log("WebSocket closed, scheduling reconnect...");
    myId = null;
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {});
}

function scheduleReconnect(): void {
  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);

  setTimeout(async () => {
    if (!(await isBrokerAlive())) {
      try {
        await ensureBroker();
      } catch (e) {
        log(`Failed to start broker: ${e}`);
        scheduleReconnect();
        return;
      }
    }
    connectToBroker();
  }, delay);
}

function handleBrokerMessage(msg: BrokerMessage): void {
  switch (msg.type) {
    case "registered":
      myId = msg.id;
      log(`Registered as peer ${myId} in namespace ${msg.namespace}`);

      // Send orientation prompt to non-Claude agents so they know about hivemind
      if (myAgentType !== "claude-code" && mySurfaceId) {
        const orientation = `You are "${myId}" on the claude-hivemind network (namespace: ${msg.namespace}). You have MCP tools: set_summary (describe your work), list_peers (find other agents), send_message (reply to agents by ID). Start by calling set_summary now.`;
        setTimeout(() => {
          import("./cmux/client.ts").then(({ sendText, sendKey }) => {
            sendText(orientation, mySurfaceId!).then(() => sendKey("enter", mySurfaceId!));
          }).catch(() => {});
        }, 3000);
      }
      break;

    case "message":
      if (myAgentType === "claude-code") {
        // Claude Code: push via MCP channel (interrupts mid-task)
        mcp
          .notification({
            method: "notifications/claude/channel",
            params: {
              content: msg.text,
              meta: {
                from_id: msg.from_id,
                from_summary: msg.from_summary,
                from_cwd: msg.from_cwd,
                sent_at: msg.sent_at,
              },
            },
          })
          .catch((e) =>
            log(`Failed to push channel notification: ${e}`)
          );
      } else if (mySurfaceId) {
        // OpenCode/Copilot with cmux: short messages typed directly, long ones via file
        const label = `hivemind message from ${msg.from_id}${msg.from_summary ? ` — ${msg.from_summary}` : ""}`;
        let prompt: string;
        if (msg.text.length <= 300) {
          prompt = `[${label}] ${msg.text} — Reply with send_message MCP tool, to="${msg.from_id}"`;
        } else {
          const msgDir = `${process.env.HOME}/.claude-hivemind/messages`;
          const msgFile = `${msgDir}/${msg.from_id}-${Date.now()}.md`;
          try {
            mkdirSync(msgDir, { recursive: true });
            writeFileSync(msgFile, `# ${label}\n\n${msg.text}\n`);
            prompt = `[${label}] Read the full message at ${msgFile} and reply with send_message MCP tool, to="${msg.from_id}"`;
          } catch {
            prompt = `[${label}] ${msg.text.slice(0, 250)}... (truncated) — Reply with send_message MCP tool, to="${msg.from_id}"`;
          }
        }
        import("./cmux/client.ts").then(({ sendText, sendKey }) => {
          sendText(prompt, mySurfaceId!).then(() => sendKey("enter", mySurfaceId!));
        }).catch((e) => log(`Failed to deliver via cmux: ${e}`));
      } else {
        // No delivery mechanism — log so the user at least sees it
        log(`INCOMING MESSAGE from ${msg.from_id}: ${msg.text}`);
      }
      log(`Message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      break;

    case "peers":
      pendingPeersResolve?.(msg.peers);
      pendingPeersResolve = null;
      pendingPeersReject = null;
      break;

    case "error":
      log(`Broker error: ${msg.error}`);
      pendingPeersReject?.(new Error(msg.error));
      pendingPeersResolve = null;
      pendingPeersReject = null;
      break;

    case "peer_joined":
    case "peer_left":
    case "peer_updated":
      break;
  }
}

function wsSend(msg: ClientMessage): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

async function requestPeerList(
  scope: "namespace" | "machine"
): Promise<Peer[]> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to broker");
  }
  return new Promise((resolve, reject) => {
    pendingPeersResolve = resolve;
    pendingPeersReject = reject;
    wsSend({ type: "list_peers", scope });
    setTimeout(() => {
      if (pendingPeersResolve === resolve) {
        pendingPeersResolve = null;
        pendingPeersReject = null;
        reject(new Error("list_peers timeout"));
      }
    }, 5000);
  });
}

const mcp = new Server(
  { name: "claude-hivemind", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-hivemind network. Other AI coding agents (Claude Code, OpenCode, Copilot) on this machine can see you and send you messages within your namespace (project group).

IMPORTANT: When you receive a <channel source="claude-hivemind" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other AI agents (scope: namespace or machine)
- send_message: Send a message to another agent by ID (same namespace only)
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)

When you start, proactively call set_summary to describe what you're working on. This helps other agents understand your context.`,
  }
);

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError && { isError: true }) };
}

const TOOLS = [
  {
    name: "list_peers",
    description:
      'List other AI coding agents (Claude Code, OpenCode, Copilot). Default scope "namespace" shows peers in your project group. Use "machine" to see all agents.',
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["namespace", "machine"],
          description:
            '"namespace" (default) = peers in your project group. "machine" = all agents on this computer.',
        },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another AI coding agent by peer ID. Only peers in the same namespace can message each other.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string" as const,
          description:
            "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. Visible to other peers in your namespace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "register_service",
    description:
      "Register the application service running in your project. This enables health monitoring from the hivemind dashboard.",
    inputSchema: {
      type: "object" as const,
      properties: {
        port: {
          type: "number" as const,
          description: "Port the service listens on (e.g. 8080)",
        },
        health_url: {
          type: "string" as const,
          description: 'Health endpoint path (default: "/health")',
        },
        log_file: {
          type: "string" as const,
          description: "Absolute path to log file for log viewing",
        },
        log_format: {
          type: "string" as const,
          enum: ["spring", "json", "plain"],
          description: 'Log format for parsing (default: "plain")',
        },
      },
      required: ["port"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (!ws) return textResult("Hivemind not active. Start with: CLAUDE_HIVEMIND=1 claude --dangerously-load-development-channels server:claude-hivemind", true);

  switch (name) {
    case "list_peers": {
      const scope =
        ((args as { scope?: string })?.scope as "namespace" | "machine") ??
        "namespace";
      try {
        const peers = await requestPeerList(scope);

        if (peers.length === 0) {
          return textResult(`No other agents found (scope: ${scope}, namespace: ${myNamespace}).`);
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.agent_type ?? "claude-code"}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
            `Namespace: ${p.namespace}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.git_branch) parts.push(`Branch: ${p.git_branch}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(
            `Status: ${p.connected ? "connected" : "disconnected"}`
          );
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return textResult(`Found ${peers.length} peer(s) (scope: ${scope}, namespace: ${myNamespace}):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return textResult(`Error listing peers: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }

    case "send_message": {
      const { to, message } = args as { to: string; message: string };
      if (!myId) return textResult("Not registered with broker yet", true);
      if (!to) return textResult("Missing target peer ID (to)", true);
      const sent = wsSend({ type: "send_message", to, text: message });
      if (!sent) return textResult("Not connected to broker. Message not sent.", true);
      return textResult(`Message sent to peer ${to}`);
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) return textResult("Not registered with broker yet", true);
      const sent = wsSend({ type: "set_summary", summary });
      if (!sent) return textResult("Not connected to broker. Summary not updated.", true);
      return textResult(`Summary updated: "${summary}"`);
    }

    case "register_service": {
      const { port, health_url, log_file, log_format } = args as {
        port: number;
        health_url?: string;
        log_file?: string;
        log_format?: "spring" | "json" | "plain";
      };
      if (!myId) return textResult("Not registered with broker yet", true);
      const resolvedHealthUrl = health_url || DEFAULT_HEALTH_URL;
      const sent = wsSend({
        type: "register_service",
        port,
        health_url: resolvedHealthUrl,
        log_file,
        log_format,
      });
      if (!sent) return textResult("Not connected to broker. Service not registered.", true);
      return textResult(`Service registered on port ${port} (health: ${resolvedHealthUrl})`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function startBrokerConnection() {
  myCwd = process.cwd();
  [myGitRoot, myGitBranch] = await Promise.all([
    getGitRoot(myCwd),
    getGitBranch(myCwd),
  ]);

  const namespaceConfig = await loadNamespaceConfig();
  myNamespace = resolveNamespace(myCwd, namespaceConfig);

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Git branch: ${myGitBranch ?? "(none)"}`);
  log(`Namespace: ${myNamespace}`);
  log(`Agent type: ${myAgentType}`);
  if (myOpenCodeUrl) log(`OpenCode URL: ${myOpenCodeUrl}`);
  if (mySurfaceId) log(`cmux surface: ${mySurfaceId}`);

  await ensureBroker();
  connectToBroker();

  setInterval(() => {
    wsSend({ type: "heartbeat" });
  }, 30_000);
}

async function main() {
  if (!process.env.CLAUDE_HIVEMIND) {
    log("CLAUDE_HIVEMIND not set, staying dormant");
    await mcp.connect(new StdioServerTransport());
    return;
  }

  await startBrokerConnection();

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  const cleanup = () => {
    if (ws) ws.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
