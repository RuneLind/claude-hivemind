/**
 * cmux client — JSON-RPC over Unix socket to control cmux terminal multiplexer.
 *
 * Socket path resolution: CMUX_SOCKET_PATH env wins; otherwise we read every
 * hint file and known default location and pick the first that is *currently a
 * live socket*. cmux writes its live socket path to hint files on startup, but
 * those files go stale across cmux upgrades (0.64.x moved the socket from
 * ~/Library/Application Support/cmux to ~/.local/state/cmux), so we never trust
 * a hint without verifying the socket actually exists. Resolution runs per RPC
 * call so a cmux restart/upgrade mid-session is picked up automatically.
 */

import { Socket } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { buildOpenCodeCommand, shellQuote } from "./opencode-command.ts";

function isLiveSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function readHint(hint: string): string | null {
  try {
    const path = readFileSync(hint, "utf-8").trim();
    return path || null;
  } catch {
    return null;
  }
}

function resolveCmuxSocket(): string {
  const override = process.env.CMUX_SOCKET_PATH || process.env.CMUX_SOCKET;
  if (override) return override;

  const home = homedir();
  // Candidate socket paths in priority order: hint files first (cmux writes its
  // live path there), then known default locations across cmux versions.
  const candidates: string[] = [];
  for (const hint of [
    `${home}/Library/Application Support/cmux/last-socket-path`,
    `${home}/.local/state/cmux/last-socket-path`,
    "/tmp/cmux-last-socket-path",
  ]) {
    const path = readHint(hint);
    if (path) candidates.push(path);
  }
  candidates.push(
    `${home}/.local/state/cmux/cmux.sock`,
    `${home}/Library/Application Support/cmux/cmux.sock`,
    "/tmp/cmux.sock",
  );

  // Skip stale hints: only return a path that is actually a live socket.
  for (const path of candidates) {
    if (isLiveSocket(path)) return path;
  }
  // Nothing validated — fall back to the first candidate so errors point somewhere.
  return candidates[0] ?? `${home}/.local/state/cmux/cmux.sock`;
}

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
    socket.connect(resolveCmuxSocket(), () => {
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
  // cmux 0.64.x renamed the workspace label field from `name` to `title`.
  const result = res.result as { workspaces?: { id: string; name?: string; title?: string }[] };
  return (result.workspaces ?? []).map((w) => ({ id: w.id, name: w.title ?? w.name ?? "" }));
}

export async function createWorkspace(name: string): Promise<{ workspaceId: string; surfaceId: string | null }> {
  const res = await rpc("workspace.create", { name });
  assertOk(res, "create workspace");
  // cmux API returns workspace_id or id depending on version; 0.64+ also
  // returns the new workspace's terminal as surface_id.
  const result = res.result as { workspace_id?: string; id?: string; surface_id?: string };
  return { workspaceId: result.workspace_id ?? result.id ?? "", surfaceId: result.surface_id ?? null };
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

export async function renameWorkspace(workspaceRef: string, title: string): Promise<void> {
  const res = await rpc("workspace.rename", { workspace_id: workspaceRef, title });
  assertOk(res, "rename workspace");
}

/**
 * The terminal a launcher types into: the surface workspace.create returned,
 * else the selected surface of that workspace. surface.list without a
 * workspace_id lists the CALLER's workspace (cmux 0.64+), which typed launch
 * commands into the broker's own terminal.
 */
async function targetSurface(created: { workspaceId: string; surfaceId: string | null }): Promise<string | undefined> {
  if (created.surfaceId) return created.surfaceId;
  const res = await rpc("surface.list", { workspace_id: created.workspaceId });
  if (!res.ok) return undefined;
  const result = res.result as { surfaces?: { id: string; focused?: boolean; selected_in_pane?: boolean }[] };
  const selected = result.surfaces?.find((s) => s.selected_in_pane || s.focused);
  return selected?.id ?? result.surfaces?.[0]?.id;
}

export interface LaunchOptions {
  directory: string;
  name?: string;
  prompt?: string;
  flags?: string[];
}

export async function readSurfaceText(surfaceId: string): Promise<string> {
  const res = await rpc("surface.read_text", { surface_id: surfaceId });
  assertOk(res, "read surface text");
  return (res.result as { text?: string }).text ?? "";
}

/**
 * Wait until a new terminal's shell has drawn something and stopped changing,
 * i.e. its prompt is up. Text typed before that can lose its Enter: the
 * command then sits unexecuted on the prompt line. Gives up after timeoutMs
 * and lets the caller type anyway.
 */
export async function waitForShellReady(
  surfaceId: string,
  { timeoutMs = 10_000, stableMs = 600, pollMs = 150 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = (await readSurfaceText(surfaceId)).trim();
    } catch {
      // surface not readable yet
    }
    if (text && text === last) {
      if (Date.now() - stableSince >= stableMs) return true;
    } else {
      last = text;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export async function launchOpenCodeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const baseName = opts.name ?? opts.directory.split("/").pop() ?? "opencode";
  const created = await createWorkspace(`${baseName} - OpenCode`);
  const workspaceId = created.workspaceId;
  await selectWorkspace(workspaceId);
  const surfaceId = await targetSurface(created);
  if (surfaceId) await waitForShellReady(surfaceId);

  // The initial prompt rides on --prompt rather than being typed later, so it
  // cannot land in the shell if OpenCode starts slowly.
  const command = `cd ${shellQuote(opts.directory)} && ${buildOpenCodeCommand(opts.prompt)}`;
  await sendText(command, surfaceId);
  await sendKey("enter", surfaceId);
  return { workspaceId };
}

export async function launchClaudeInstance(opts: LaunchOptions): Promise<{ workspaceId: string }> {
  const name = opts.name ?? opts.directory.split("/").pop() ?? "claude";
  const created = await createWorkspace(name);
  const workspaceId = created.workspaceId;
  await selectWorkspace(workspaceId);

  const flags = opts.flags ?? [];
  const claudeCmd = [
    `cd ${JSON.stringify(opts.directory)}`,
    "&&",
    "CLAUDE_HIVEMIND=1",
    `CMUX_WORKSPACE_ID=${workspaceId}`,
    "claude",
    `--name ${JSON.stringify(name)}`,
    "--dangerously-load-development-channels server:claude-hivemind",
    "--dangerously-skip-permissions",
    ...flags,
  ].join(" ");

  const surfaceId = await targetSurface(created);
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
