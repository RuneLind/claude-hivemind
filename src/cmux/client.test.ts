/**
 * The launchers must type into the terminal of the workspace they just
 * created. Driven against a fake cmux socket that answers like cmux 0.65:
 * workspace.create returns the new surface_id, and surface.list without a
 * workspace_id lists the CALLER's workspace.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

const socketPath = `${tmpdir()}/hivemind-fake-cmux-${process.pid}.sock`;
const calls: { method: string; params: any }[] = [];
let server: ReturnType<typeof Bun.listen>;
let createReturnsSurface = true;
let newWorkspaceSurfaces: { id: string; focused: boolean; selected_in_pane: boolean }[] = [
  { id: "SURF-NEW", focused: true, selected_in_pane: true },
];

function answer(method: string, params: any): unknown {
  switch (method) {
    case "workspace.create":
      return createReturnsSurface ? { workspace_id: "WS-NEW", surface_id: "SURF-NEW" } : { workspace_id: "WS-NEW" };
    case "surface.read_text":
      return { text: "$ " };
    case "surface.list":
      return params.workspace_id === "WS-NEW"
        ? { surfaces: newWorkspaceSurfaces }
        : { surfaces: [{ id: "SURF-CALLER", focused: true, selected_in_pane: true }] };
    default:
      return {};
  }
}

beforeAll(() => {
  try { unlinkSync(socketPath); } catch {}
  server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        const req = JSON.parse(String(data).trim());
        calls.push({ method: req.method, params: req.params });
        socket.write(JSON.stringify({ id: req.id, ok: true, result: answer(req.method, req.params) }) + "\n");
      },
    },
  });
  process.env.CMUX_SOCKET_PATH = socketPath;
});

afterAll(() => {
  server.stop(true);
  try { unlinkSync(socketPath); } catch {}
});

// The query string gives a module instance that peers.test.ts's process-wide
// mock.module("../cmux/client.ts") does not replace.
const { launchOpenCodeInstance, launchClaudeInstance }: typeof import("./client.ts") = await import("./client.ts?real" as string);

function typedSurfaces(): string[] {
  return calls.filter((c) => c.method === "surface.send_text").map((c) => c.params.surface_id);
}

describe("cmux launchers target the new workspace's terminal", () => {
  test("launchOpenCodeInstance types into the surface workspace.create returned", async () => {
    calls.length = 0;
    await launchOpenCodeInstance({ directory: "/tmp", name: "t" });
    expect(typedSurfaces()).toEqual(["SURF-NEW"]);
    expect(calls.filter((c) => c.method === "surface.send_key").map((c) => c.params.surface_id)).toEqual(["SURF-NEW"]);
    expect(calls.some((c) => c.method === "surface.list")).toBe(false);
  });

  test("without a surface_id from workspace.create, the new workspace's selected surface is used", async () => {
    calls.length = 0;
    createReturnsSurface = false;
    try {
      await launchOpenCodeInstance({ directory: "/tmp", name: "t" });
    } finally {
      createReturnsSurface = true;
    }
    expect(typedSurfaces()).toEqual(["SURF-NEW"]);
  });

  test("the fallback picks the selected surface, not the first one", async () => {
    calls.length = 0;
    createReturnsSurface = false;
    const saved = newWorkspaceSurfaces;
    newWorkspaceSurfaces = [
      { id: "SURF-OTHER", focused: false, selected_in_pane: false },
      { id: "SURF-NEW", focused: true, selected_in_pane: true },
    ];
    try {
      await launchOpenCodeInstance({ directory: "/tmp", name: "t" });
    } finally {
      createReturnsSurface = true;
      newWorkspaceSurfaces = saved;
    }
    expect(typedSurfaces()).toEqual(["SURF-NEW"]);
  });

  test("with no surface for the new workspace the launch fails instead of typing untargeted", async () => {
    calls.length = 0;
    createReturnsSurface = false;
    const saved = newWorkspaceSurfaces;
    newWorkspaceSurfaces = [];
    let error: unknown;
    try {
      await launchOpenCodeInstance({ directory: "/tmp", name: "t" });
    } catch (e) {
      error = e;
    } finally {
      createReturnsSurface = true;
      newWorkspaceSurfaces = saved;
    }
    expect(String(error)).toContain("no terminal");
    expect(calls.some((c) => c.method === "surface.send_text" || c.method === "surface.send_key")).toBe(false);
  });

  test("launchClaudeInstance types into the surface workspace.create returned", async () => {
    calls.length = 0;
    await launchClaudeInstance({ directory: "/tmp", name: "t" });
    expect(typedSurfaces()).toEqual(["SURF-NEW"]);
  });
});
