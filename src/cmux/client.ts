/**
 * cmux client — JSON-RPC over Unix socket to control cmux terminal multiplexer.
 *
 * Socket path resolution: CMUX_SOCKET_PATH env > /tmp/cmux-last-socket-path file > default.
 * cmux writes its actual socket path to /tmp/cmux-last-socket-path on startup.
 */

import { Socket } from "node:net";
import { readFileSync } from "node:fs";

function resolveCmuxSocket(): string {
  if (process.env.CMUX_SOCKET_PATH) return process.env.CMUX_SOCKET_PATH;
  try {
    return readFileSync("/tmp/cmux-last-socket-path", "utf-8").trim();
  } catch {
    return "/tmp/cmux.sock";
  }
}

const CMUX_SOCKET = resolveCmuxSocket();

let requestId = 0;

interface CmuxResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

function assertOk(res: CmuxResponse, action: string): void {
  if (res.ok) return;
  const msg = !res.error ? `Failed to ${action}`
    : typeof res.error === "string" ? res.error
    : JSON.stringify(res.error);
  throw new Error(msg);
}

function rpc(method: string, params: Record<string, unknown> = {}): Promise<CmuxResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const id = `req-${++requestId}`;
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        try {
          const response = JSON.parse(buffer.slice(0, newlineIdx)) as CmuxResponse;
          resolve(response);
        } catch (e) {
          reject(new Error(`Invalid cmux response: ${buffer.slice(0, newlineIdx)}`));
        }
        socket.destroy();
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`cmux socket error: ${err.message}`));
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("cmux socket timeout"));
    });

    socket.setTimeout(5000);
    socket.connect(CMUX_SOCKET, () => {
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  });
}

export async function isCmuxAvailable(): Promise<boolean> {
  try {
    const res = await rpc("system.ping");
    return res.ok === true;
  } catch {
    return false;
  }
}

export async function listWorkspaces(): Promise<{ id: string; name: string }[]> {
  const res = await rpc("workspace.list");
  assertOk(res, "list workspaces");
  const result = res.result as { workspaces: { id: string; name: string }[] };
  return result.workspaces ?? [];
}

export async function createWorkspace(name: string): Promise<string> {
  const res = await rpc("workspace.create", { name });
  assertOk(res, "create workspace");
  // cmux API returns workspace_id or id depending on version
  const result = res.result as { workspace_id?: string; id?: string };
  return result.workspace_id ?? result.id ?? "";
}

export async function sendText(text: string, surfaceId?: string): Promise<void> {
  const params: Record<string, unknown> = { text };
  if (surfaceId) params.surface_id = surfaceId;
  const res = await rpc("surface.send_text", params);
  assertOk(res, "send text");
}

export async function sendKey(key: string, surfaceId?: string): Promise<void> {
  const params: Record<string, unknown> = { key };
  if (surfaceId) params.surface_id = surfaceId;
  const res = await rpc("surface.send_key", params);
  assertOk(res, "send key");
}

export async function selectWorkspace(workspaceId: string): Promise<void> {
  const res = await rpc("workspace.select", { workspace_id: workspaceId });
  assertOk(res, "select workspace");
}

export async function getActiveSurface(): Promise<string | null> {
  const res = await rpc("surface.list", {});
  if (!res.ok) return null;
  const result = res.result as { surfaces?: { id: string; focused: boolean }[] };
  const focused = result.surfaces?.find(s => s.focused);
  return focused?.id ?? result.surfaces?.[0]?.id ?? null;
}

export interface LaunchOptions {
  directory: string;
  name?: string;
  prompt?: string;
  flags?: string[];
}

export async function launchOpenCodeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const name = opts.name ?? opts.directory.split("/").pop() ?? "opencode";
  const workspaceId = await createWorkspace(name);
  await selectWorkspace(workspaceId);

  // Capture surface ID before building config — this is the terminal we'll push messages to
  const surfaceId = await getActiveSurface() ?? undefined;

  // OpenCode MCP config with hivemind integration
  // OpenCode uses: opencode.json (no dot), "mcp" key, "type": "local", "environment", command as array
  const serverPath = new URL("../server.ts", import.meta.url).pathname;
  const mcpConfig = {
    mcp: {
      "claude-hivemind": {
        type: "local",
        command: ["bun", "run", serverPath],
        environment: {
          CLAUDE_HIVEMIND: "1",
          CLAUDE_HIVEMIND_AGENT_TYPE: "opencode",
          ...(surfaceId ? { CMUX_SURFACE_ID: surfaceId } : {}),
        },
      },
    },
  };

  const openCodeCmd = [
    `cd ${JSON.stringify(opts.directory)}`,
    "&&",
    // Write opencode.json with hivemind MCP config if not present
    `test -f opencode.json || echo ${JSON.stringify(JSON.stringify(mcpConfig))} > opencode.json`,
    "&&",
    process.env.OPENCODE_COMMAND || "opencode",
  ].join(" ");
  await sendText(openCodeCmd, surfaceId);
  await sendKey("enter", surfaceId);

  if (opts.prompt) {
    // OpenCode takes a few seconds to initialize
    setTimeout(async () => {
      try {
        await sendText(opts.prompt!, surfaceId);
        await sendKey("enter", surfaceId);
      } catch { /* user can type manually */ }
    }, 8000);
  }

  return { workspaceId };
}

export async function launchClaudeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const name = opts.name ?? opts.directory.split("/").pop() ?? "claude";
  const workspaceId = await createWorkspace(name);
  await selectWorkspace(workspaceId);

  const flags = opts.flags ?? [];
  const claudeCmd = [
    `cd ${JSON.stringify(opts.directory)}`,
    "&&",
    "CLAUDE_HIVEMIND=1",
    "claude",
    `--name ${JSON.stringify(name)}`,
    "--dangerously-load-development-channels server:claude-hivemind",
    "--dangerously-skip-permissions",
    ...flags,
  ].join(" ");

  const surfaceId = await getActiveSurface() ?? undefined;
  await sendText(claudeCmd, surfaceId);
  await sendKey("enter", surfaceId);

  // Auto-confirm the "Loading development channels" prompt.
  // Claude Code takes a few seconds to start — send Enter at 4s and 7s to cover
  // slow startups and multi-instance launches where CPU is contended.
  for (const delay of [4000, 7000]) {
    setTimeout(async () => {
      try { await sendKey("enter", surfaceId); } catch { /* ignore */ }
    }, delay);
  }

  if (opts.prompt) {
    // Delay so Claude Code has time to fully initialize
    setTimeout(async () => {
      try {
        await sendText(opts.prompt!, surfaceId);
        await sendKey("enter", surfaceId);
      } catch {
        // Not ready yet — user can type manually
      }
    }, 12000);
  }

  return { workspaceId };
}
