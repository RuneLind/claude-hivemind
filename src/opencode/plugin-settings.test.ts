import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { brokerPort, loadSettings, settingsPath } from "./plugin-settings.ts";
import { isolatePluginEnv } from "./plugin-test-env.ts";

const env = isolatePluginEnv();

describe("settingsPath", () => {
  test("an absolute XDG_CONFIG_HOME is used", () => {
    expect(settingsPath({ XDG_CONFIG_HOME: "/x/cfg", HOME: "/h" })).toBe("/x/cfg/opencode/plugin-settings.json");
  });

  test("an empty or relative XDG_CONFIG_HOME falls back to $HOME/.config", () => {
    expect(settingsPath({ XDG_CONFIG_HOME: "", HOME: "/h" })).toBe("/h/.config/opencode/plugin-settings.json");
    expect(settingsPath({ XDG_CONFIG_HOME: "rel/cfg", HOME: "/h" })).toBe("/h/.config/opencode/plugin-settings.json");
  });

  test("HOME unset or empty falls back to os.homedir()", () => {
    const want = join(homedir(), ".config", "opencode", "plugin-settings.json");
    expect(settingsPath({})).toBe(want);
    expect(settingsPath({ HOME: "" })).toBe(want);
  });
});

describe("loadSettings", () => {
  const K = "CLAUDE_HIVEMIND_PORT";

  test("the file's non-empty string beats the environment; a missing key falls back to it", () => {
    env.writeSettings({ [K]: "1111", OTHER_PLUGIN: "x" });
    const s = loadSettings({ ...process.env, [K]: "2222", CLAUDE_HIVEMIND_OPENCODE_LOG: "/env.log" });
    expect(s.get(K)).toBe("1111");
    expect(s.get("CLAUDE_HIVEMIND_OPENCODE_LOG")).toBe("/env.log");
  });

  test("an empty string or a non-string value in the file counts as absent", () => {
    env.writeSettings({ [K]: "", CLAUDE_HIVEMIND_OPENCODE_LOG: 7 });
    const s = loadSettings({ ...process.env, [K]: "2222", CLAUDE_HIVEMIND_OPENCODE_LOG: "/env.log" });
    expect(s.get(K)).toBe("2222");
    expect(s.get("CLAUDE_HIVEMIND_OPENCODE_LOG")).toBe("/env.log");
  });

  test("a malformed or missing file counts as empty and does not throw", () => {
    env.writeSettings('{"CLAUDE_HIVEMIND_PORT": "1111"');
    expect(loadSettings({ ...process.env, [K]: "2222" }).get(K)).toBe("2222");
    expect(loadSettings({ XDG_CONFIG_HOME: join(env.xdg, "none"), [K]: "2222" }).get(K)).toBe("2222");
  });

  // Key "0" is what an array or a string would answer through index access,
  // so dropping the plain-object check turns these red.
  test("a JSON array or string file counts as empty", () => {
    env.writeSettings('["9999"]');
    expect(loadSettings({ ...process.env, "0": "env" }).get("0")).toBe("env");
    env.writeSettings('"9999"');
    expect(loadSettings({ ...process.env, "0": "env" }).get("0")).toBe("env");
  });
});

describe("brokerPort", () => {
  const port = (file: Record<string, unknown> | null, envPort: string | undefined) => {
    env.writeSettings(file ?? {});
    const logs: string[] = [];
    const e: NodeJS.ProcessEnv = { ...process.env };
    if (envPort !== undefined) e.CLAUDE_HIVEMIND_PORT = envPort;
    return { port: brokerPort(loadSettings(e), (m) => logs.push(m)), logs };
  };

  test("a valid file port wins, a valid env port is next, 7899 last", () => {
    expect(port({ CLAUDE_HIVEMIND_PORT: "4242" }, "5353")).toEqual({ port: 4242, logs: [] });
    expect(port(null, "5353")).toEqual({ port: 5353, logs: [] });
    expect(port(null, undefined)).toEqual({ port: 7899, logs: [] });
  });

  for (const bad of ["abc", " ", "99999", "0", "65536", "12.5", "-1", " 80"]) {
    test(`file port ${JSON.stringify(bad)} is skipped and logged; the env port is used`, () => {
      const r = port({ CLAUDE_HIVEMIND_PORT: bad }, "5353");
      expect(r.port).toBe(5353);
      expect(r.logs).toHaveLength(1);
      expect(r.logs[0]).toContain(`CLAUDE_HIVEMIND_PORT ${JSON.stringify(bad)} in ${env.xdg}/opencode/plugin-settings.json`);
    });
  }

  test("an empty file port is absent (the env port is used, nothing logged)", () => {
    expect(port({ CLAUDE_HIVEMIND_PORT: "" }, "5353")).toEqual({ port: 5353, logs: [] });
  });

  test("the boundary ports 1 and 65535 are valid", () => {
    expect(port({ CLAUDE_HIVEMIND_PORT: "1" }, undefined).port).toBe(1);
    expect(port({ CLAUDE_HIVEMIND_PORT: "65535" }, undefined).port).toBe(65535);
  });

  for (const bad of ["", "abc", "70000"]) {
    test(`env port ${JSON.stringify(bad)} falls to 7899 and is logged`, () => {
      const r = port({ CLAUDE_HIVEMIND_PORT: "nope" }, bad);
      expect(r.port).toBe(7899);
      expect(r.logs).toHaveLength(2);
      expect(r.logs[1]).toContain(`CLAUDE_HIVEMIND_PORT ${JSON.stringify(bad)} in the environment`);
    });
  }
});
