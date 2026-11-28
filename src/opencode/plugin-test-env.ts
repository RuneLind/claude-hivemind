/**
 * Test helper (imported by *.test.ts only): isolates the environment the
 * OpenCode plugin reads. Each test gets its own XDG_CONFIG_HOME temp dir, so
 * a real ~/.config/opencode/plugin-settings.json never leaks in, and the
 * variables the plugin reads are saved, cleared and restored around it.
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = [
  "XDG_CONFIG_HOME",
  "CLAUDE_HIVEMIND",
  "CLAUDE_HIVEMIND_PORT",
  "CLAUDE_HIVEMIND_OPENCODE_LOG",
  "CMUX_WORKSPACE_ID",
] as const;

export function isolatePluginEnv() {
  let saved: Record<string, string | undefined> = {};
  let dirs: string[] = [];
  let xdg = "";

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    xdg = realpathSync(mkdtempSync(join(tmpdir(), "hm-xdg-")));
    dirs.push(xdg);
    process.env.XDG_CONFIG_HOME = xdg;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  return {
    /** This test's XDG_CONFIG_HOME. */
    get xdg() {
      return xdg;
    },
    /** A temp dir removed after the test. */
    tempDir(prefix = "hm-test-"): string {
      const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      dirs.push(d);
      return d;
    },
    /** Writes this test's plugin-settings.json (an object is JSON-encoded, a string written as is). */
    writeSettings(content: Record<string, unknown> | string): void {
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      writeFileSync(join(xdg, "opencode", "plugin-settings.json"), typeof content === "string" ? content : JSON.stringify(content));
    },
  };
}
