import { describe, test, expect, afterEach } from "bun:test";
import * as pluginModule from "./plugin.ts";
import { buildOpenCodeCommand } from "../cmux/opencode-command.ts";

const fakeInput = (directory = "/tmp") =>
  ({
    client: { app: { log: async () => ({}) }, session: {} },
    directory,
    worktree: directory,
  }) as any;

describe("opencode plugin module", () => {
  const saved = process.env.CLAUDE_HIVEMIND;
  const savedPort = process.env.CLAUDE_HIVEMIND_PORT;
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    if (saved === undefined) delete process.env.CLAUDE_HIVEMIND;
    else process.env.CLAUDE_HIVEMIND = saved;
    if (savedPort === undefined) delete process.env.CLAUDE_HIVEMIND_PORT;
    else process.env.CLAUDE_HIVEMIND_PORT = savedPort;
  });

  test("exports only the plugin (OpenCode calls every export as a plugin)", () => {
    expect(Object.keys(pluginModule)).toEqual(["default"]);
    expect(typeof pluginModule.default).toBe("function");
  });

  test("is inert without CLAUDE_HIVEMIND", async () => {
    delete process.env.CLAUDE_HIVEMIND;
    expect(await pluginModule.default(fakeInput())).toEqual({});
  });

  test("with CLAUDE_HIVEMIND it registers the hivemind tools, and a second load is inert", async () => {
    process.env.CLAUDE_HIVEMIND = "1";
    process.env.CLAUDE_HIVEMIND_PORT = "1"; // nothing listens; the peer just retries
    const hooks = await pluginModule.default(fakeInput());
    dispose = hooks.dispose;
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "hivemind_list_peers",
      "hivemind_register_service",
      "hivemind_send_message",
      "hivemind_set_summary",
    ]);
    expect(await pluginModule.default(fakeInput())).toEqual({});
  });
});

describe("buildOpenCodeCommand", () => {
  const saved = process.env.OPENCODE_COMMAND;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCODE_COMMAND;
    else process.env.OPENCODE_COMMAND = saved;
  });

  test("starts opencode with the hivemind gate and the plugin via OPENCODE_CONFIG_CONTENT", () => {
    process.env.OPENCODE_COMMAND = "opencode";
    const cmd = buildOpenCodeCommand();
    expect(cmd.startsWith("CLAUDE_HIVEMIND=1 OPENCODE_CONFIG_CONTENT='")).toBe(true);
    expect(cmd.endsWith("' opencode")).toBe(true);
    const config = JSON.parse(cmd.match(/OPENCODE_CONFIG_CONTENT='([^']*)'/)![1]!);
    expect(config.plugin).toHaveLength(1);
    expect(config.plugin[0]).toMatch(/^file:\/\/.*\/src\/opencode\/plugin\.ts$/);
    expect(config.permission).toEqual({ "*": "allow" });
  });

  test("survives a real shell: the config and a quoted --prompt arrive intact", () => {
    process.env.OPENCODE_COMMAND = `sh -c 'printf "%s|%s|%s" "$CLAUDE_HIVEMIND" "$OPENCODE_CONFIG_CONTENT" "$2"' sh`;
    const out = Bun.spawnSync(["sh", "-c", buildOpenCodeCommand("it's a prompt")]).stdout.toString();
    const [gate, json, prompt] = out.split("|");
    expect(gate).toBe("1");
    expect(JSON.parse(json!).permission).toEqual({ "*": "allow" });
    expect(prompt).toBe("it's a prompt");
  });
});
