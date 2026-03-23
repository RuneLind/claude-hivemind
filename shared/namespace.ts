import type { NamespaceConfig, Namespace } from "./types.ts";

const CONFIG_PATH = `${process.env.HOME}/.claude-hivemind-namespaces.json`;

/**
 * Load namespace config from ~/.claude-hivemind-namespaces.json.
 * Returns null if the file doesn't exist (use auto-derive mode).
 */
export async function loadNamespaceConfig(): Promise<NamespaceConfig | null> {
  try {
    const file = Bun.file(CONFIG_PATH);
    if (await file.exists()) {
      return (await file.json()) as NamespaceConfig;
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Resolve namespace for a given CWD.
 *
 * 1. Check explicit rules (longest prefix match)
 * 2. Auto-derive from ~/source/<group>/
 * 3. Fallback to "default"
 */
export function resolveNamespace(
  cwd: string,
  config: NamespaceConfig | null
): Namespace {
  // Check explicit rules (longest prefix match)
  if (config?.rules.length) {
    let bestMatch: { name: string; length: number } | null = null;
    for (const rule of config.rules) {
      const prefix = rule.path_prefix.endsWith("/")
        ? rule.path_prefix
        : rule.path_prefix + "/";
      if (cwd.startsWith(prefix) || cwd === rule.path_prefix) {
        if (!bestMatch || prefix.length > bestMatch.length) {
          bestMatch = { name: rule.name, length: prefix.length };
        }
      }
    }
    if (bestMatch) return bestMatch.name;
  }

  // Auto-derive: ~/source/<group>/...
  const home = process.env.HOME ?? "";
  const sourcePrefix = `${home}/source/`;
  if (cwd.startsWith(sourcePrefix)) {
    const rest = cwd.slice(sourcePrefix.length);
    const groupDir = rest.split("/")[0];
    if (groupDir) return groupDir;
  }

  return config?.default_namespace ?? "default";
}
