import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, settingsPath } from "./plugin-settings.ts";

/** An env whose XDG_CONFIG_HOME is a fresh temp dir, optionally holding a settings file with `content`. */
function envWith(content: string | null, extra: Record<string, string> = {}) {
  const xdg = mkdtempSync(join(tmpdir(), "hm-settings-"));
  if (content !== null) {
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(join(xdg, "opencode", "plugin-settings.json"), content);
  }
  return { XDG_CONFIG_HOME: xdg, ...extra } as NodeJS.ProcessEnv;
}

describe("plugin settings", () => {
  test("path: XDG_CONFIG_HOME, else $HOME/.config", () => {
    expect(settingsPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/opencode/plugin-settings.json");
    expect(settingsPath({ HOME: "/h" })).toBe("/h/.config/opencode/plugin-settings.json");
  });

  test("the file's value with the env unset", () => {
    expect(loadSettings(envWith('{"CLAUDE_HIVEMIND_PORT":"7951"}'))("CLAUDE_HIVEMIND_PORT")).toBe("7951");
  });

  test("the file beats the env; other plugins' keys are ignored", () => {
    const s = loadSettings(envWith('{"CLAUDE_HIVEMIND_PORT":"7951","WIKI_STAMP_BIN":"/bin/x"}', { CLAUDE_HIVEMIND_PORT: "7899" }));
    expect(s("CLAUDE_HIVEMIND_PORT")).toBe("7951");
  });

  test("an absent, empty or non-string value falls back to the env", () => {
    const env = envWith('{"CLAUDE_HIVEMIND_PORT":7951,"CLAUDE_HIVEMIND_OPENCODE_LOG":""}', {
      CLAUDE_HIVEMIND_PORT: "7899",
      CLAUDE_HIVEMIND_OPENCODE_LOG: "/tmp/env.log",
      CMUX_WORKSPACE_ID: "w1",
    });
    const s = loadSettings(env);
    expect(s("CLAUDE_HIVEMIND_PORT")).toBe("7899");
    expect(s("CLAUDE_HIVEMIND_OPENCODE_LOG")).toBe("/tmp/env.log");
    expect(s("CMUX_WORKSPACE_ID")).toBe("w1");
  });

  for (const [name, content] of [
    ["missing", null],
    ["malformed", "{ not json"],
    ["an array", '["CLAUDE_HIVEMIND_PORT"]'],
    ["null", "null"],
    ["a string", '"7951"'],
  ] as const) {
    test(`a ${name} file counts as empty, without throwing`, () => {
      const s = loadSettings(envWith(content, { CLAUDE_HIVEMIND_PORT: "7899" }));
      expect(s("CLAUDE_HIVEMIND_PORT")).toBe("7899");
    });
  }

  test("an unreadable file (a directory) counts as empty", () => {
    const env = envWith(null, { CLAUDE_HIVEMIND_PORT: "7899" });
    mkdirSync(join(env.XDG_CONFIG_HOME!, "opencode", "plugin-settings.json"), { recursive: true });
    expect(loadSettings(env)("CLAUDE_HIVEMIND_PORT")).toBe("7899");
  });
});
