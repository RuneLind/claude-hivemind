/**
 * Settings for the OpenCode plugin, read by both entry points (1.x `server()`
 * and 2.x `setup()`). OpenCode 2.x runs every plugin in one shared background
 * server that keeps the environment of whatever process started it, so a
 * variable set in the launching shell may never reach the plugin.
 *
 * File: `${XDG_CONFIG_HOME}/opencode/plugin-settings.json`, where
 * XDG_CONFIG_HOME counts only as a non-empty absolute path (the XDG spec
 * ignores a relative one); otherwise `$HOME/.config`, or `os.homedir()` when
 * HOME is unset or empty. One flat JSON object of environment-variable names
 * to string values, shared with other plugins (unknown keys are ignored).
 * A key's value is the file's when it is a non-empty string, else
 * `process.env[key]`. A missing, unreadable, malformed or non-object file
 * counts as empty and never throws: a 2.x `setup()` that rejects marks the
 * plugin failed for every session.
 *
 * Keys: CLAUDE_HIVEMIND_PORT (both entry points) and
 * CLAUDE_HIVEMIND_OPENCODE_LOG (2.x only; 1.x logs through `client.app.log`).
 * Each plugin instance reads the file once, when it starts.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DEFAULT_PORT, parsePort } from "../shared/port.ts";

export { DEFAULT_PORT };

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "opencode", "plugin-settings.json");
}

export interface Settings {
  /** The file's value for `key` when it is a non-empty string. */
  file(key: string): string | undefined;
  /** The file's value, else the environment's. */
  get(key: string): string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** Reads the file once; lookups fall back to the environment per key. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as Record<string, unknown>;
  } catch {}
  const file = (key: string) => {
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return { file, get: (key) => file(key) ?? env[key], env };
}

function asPort(v: string): number | null {
  const n = parsePort(v);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * CLAUDE_HIVEMIND_PORT: the file's value, else the environment's, else 7899.
 * Parsed as the broker parses it (`parsePort`); a value that parses to NaN or
 * lands outside 1..65535 is skipped and logged: passed on, it made
 * `new WebSocket` throw and the 2.x plugin fail to load.
 */
export function brokerPort(settings: Settings, log: (m: string) => void): number {
  const key = "CLAUDE_HIVEMIND_PORT";
  const fromFile = settings.file(key);
  if (fromFile !== undefined) {
    const p = asPort(fromFile);
    if (p !== null) return p;
    log(`${key} ${JSON.stringify(fromFile)} in ${settingsPath(settings.env)} is not a port (1-65535); trying the environment`);
  }
  const fromEnv = settings.env[key];
  if (fromEnv !== undefined) {
    const p = asPort(fromEnv);
    if (p !== null) return p;
    log(`${key} ${JSON.stringify(fromEnv)} in the environment is not a port (1-65535); using ${DEFAULT_PORT}`);
  }
  return DEFAULT_PORT;
}
