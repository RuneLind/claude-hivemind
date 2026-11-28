/**
 * Plugin settings for OpenCode 2.x, whose one shared server keeps the
 * environment of whatever process started it, so a variable set in the
 * launching shell may never reach the plugin.
 *
 * File: `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin-settings.json`, one
 * flat JSON object of environment-variable names to string values, shared
 * with other plugins (unknown keys are ignored). A key's value is the file's
 * when it is a non-empty string, else `process.env[key]`. A missing,
 * unreadable or malformed file counts as empty and never throws: a 2.x
 * `setup()` that rejects unloads the plugin silently.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Settings = (key: string) => string | undefined;

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "opencode", "plugin-settings.json");
}

/** Reads the file once; the returned lookup falls back to the environment per key. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed as Record<string, unknown>;
  } catch {}
  return (key) => {
    const v = Object.hasOwn(file, key) ? file[key] : undefined;
    return typeof v === "string" && v !== "" ? v : env[key];
  };
}
