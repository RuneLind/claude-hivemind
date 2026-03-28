/**
 * cmux client — JSON-RPC over Unix socket to control cmux terminal multiplexer.
 *
 * Connects to /tmp/cmux.sock (or CMUX_SOCKET_PATH) and exposes workspace/surface
 * management for launching Claude Code instances from the dashboard.
 */

import { Socket } from "node:net";

const CMUX_SOCKET = process.env.CMUX_SOCKET_PATH ?? "/tmp/cmux.sock";

let requestId = 0;

interface CmuxResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Send a JSON-RPC request to cmux and return the response.
 */
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

/** Check if cmux is reachable. */
export async function isCmuxAvailable(): Promise<boolean> {
  try {
    const res = await rpc("system.ping");
    return res.ok === true;
  } catch {
    return false;
  }
}

/** List all cmux workspaces. */
export async function listWorkspaces(): Promise<{ id: string; name: string }[]> {
  const res = await rpc("workspace.list");
  if (!res.ok) throw new Error(res.error ?? "Failed to list workspaces");
  const result = res.result as { workspaces: { id: string; name: string }[] };
  return result.workspaces ?? [];
}

/** Create a new cmux workspace and return its ID. */
export async function createWorkspace(name: string): Promise<string> {
  const res = await rpc("workspace.create", { name });
  if (!res.ok) throw new Error(res.error ?? "Failed to create workspace");
  const result = res.result as { workspace_id?: string; id?: string };
  return result.workspace_id ?? result.id ?? "";
}

/** Send text to the focused surface of a workspace. */
export async function sendText(text: string, surfaceId?: string): Promise<void> {
  const method = surfaceId ? "surface.send_text" : "surface.send_text";
  const params: Record<string, unknown> = { text };
  if (surfaceId) params.surface = surfaceId;
  const res = await rpc(method, params);
  if (!res.ok) throw new Error(res.error ?? "Failed to send text");
}

/** Send a keystroke (e.g. "enter") to cmux. */
export async function sendKey(key: string, surfaceId?: string): Promise<void> {
  const params: Record<string, unknown> = { key };
  if (surfaceId) params.surface = surfaceId;
  const res = await rpc("surface.send_key", params);
  if (!res.ok) throw new Error(res.error ?? "Failed to send key");
}

/** Select (focus) a workspace. */
export async function selectWorkspace(workspaceId: string): Promise<void> {
  const res = await rpc("workspace.select", { workspace: workspaceId });
  if (!res.ok) throw new Error(res.error ?? "Failed to select workspace");
}

export interface LaunchOptions {
  /** Working directory for the Claude Code instance */
  directory: string;
  /** Name for the cmux workspace */
  name?: string;
  /** Initial prompt to send to Claude Code (optional) */
  prompt?: string;
  /** Extra CLI flags for claude command */
  flags?: string[];
}

/**
 * Launch a new Claude Code instance in a cmux workspace.
 *
 * Creates a workspace, sends the cd + claude command, and optionally
 * sends an initial prompt once Claude starts.
 */
export async function launchClaudeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const name = opts.name ?? opts.directory.split("/").pop() ?? "claude";
  const workspaceId = await createWorkspace(name);

  // Focus the new workspace
  await selectWorkspace(workspaceId);

  // Build the claude command
  const flags = opts.flags ?? [];
  const claudeCmd = [
    `cd ${JSON.stringify(opts.directory)}`,
    "&&",
    "claude",
    "--dangerously-load-development-channels server:claude-hivemind",
    ...flags,
  ].join(" ");

  // Send the command to the terminal
  await sendText(claudeCmd);
  await sendKey("enter");

  // If there's an initial prompt, wait a bit for Claude to start, then send it
  if (opts.prompt) {
    // Give Claude Code ~3s to initialize before sending the prompt
    setTimeout(async () => {
      try {
        await sendText(opts.prompt!);
        await sendKey("enter");
      } catch {
        // Claude may not be ready yet — the user can type manually
      }
    }, 3000);
  }

  return { workspaceId };
}
