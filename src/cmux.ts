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
  if (!res.ok) throw new Error(res.error ?? "Failed to list workspaces");
  const result = res.result as { workspaces: { id: string; name: string }[] };
  return result.workspaces ?? [];
}

export async function createWorkspace(name: string): Promise<string> {
  const res = await rpc("workspace.create", { name });
  if (!res.ok) throw new Error(res.error ?? "Failed to create workspace");
  // cmux API returns workspace_id or id depending on version
  const result = res.result as { workspace_id?: string; id?: string };
  return result.workspace_id ?? result.id ?? "";
}

export async function sendText(text: string, surfaceId?: string): Promise<void> {
  const params: Record<string, unknown> = { text };
  if (surfaceId) params.surface = surfaceId;
  const res = await rpc("surface.send_text", params);
  if (!res.ok) throw new Error(res.error ?? "Failed to send text");
}

export async function sendKey(key: string, surfaceId?: string): Promise<void> {
  const params: Record<string, unknown> = { key };
  if (surfaceId) params.surface = surfaceId;
  const res = await rpc("surface.send_key", params);
  if (!res.ok) throw new Error(res.error ?? "Failed to send key");
}

export async function selectWorkspace(workspaceId: string): Promise<void> {
  const res = await rpc("workspace.select", { workspace: workspaceId });
  if (!res.ok) throw new Error(res.error ?? "Failed to select workspace");
}

export interface LaunchOptions {
  directory: string;
  name?: string;
  prompt?: string;
  flags?: string[];
}

export async function launchClaudeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const name = opts.name ?? opts.directory.split("/").pop() ?? "claude";
  const workspaceId = await createWorkspace(name);
  await selectWorkspace(workspaceId);

  const flags = opts.flags ?? [];
  const claudeCmd = [
    `cd ${JSON.stringify(opts.directory)}`,
    "&&",
    "claude",
    "--dangerously-load-development-channels server:claude-hivemind",
    ...flags,
  ].join(" ");

  await sendText(claudeCmd);
  await sendKey("enter");

  if (opts.prompt) {
    // Delay so Claude Code has time to initialize before receiving the prompt
    setTimeout(async () => {
      try {
        await sendText(opts.prompt!);
        await sendKey("enter");
      } catch {
        // Not ready yet — user can type manually
      }
    }, 3000);
  }

  return { workspaceId };
}
