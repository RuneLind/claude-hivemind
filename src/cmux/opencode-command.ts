export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command that starts a hivemind-connected OpenCode (run in the
 * project directory). On OpenCode 1.x the plugin comes in through
 * OPENCODE_CONFIG_CONTENT, so it loads whether or not it is installed globally
 * (the 1.x plugin guards against loading twice), and the project's own
 * opencode.json is left alone. OpenCode 2.x ignores this entry (measured on
 * 2.4.2) and loads only the global install, once per directory.
 * `permission` mirrors the --dangerously-skip-permissions the Claude launcher
 * passes, but only on 1.x is it per launch: a 2.x server this command starts
 * keeps it and applies it to every directory it serves. cmux sets CMUX_WORKSPACE_ID in the new terminal itself (sent by the
 * 1.x plugin only).
 */
export function buildOpenCodeCommand(prompt?: string): string {
  const pluginUrl = new URL("../opencode/plugin.ts", import.meta.url).href;
  const config = { plugin: [pluginUrl], permission: { "*": "allow" } };
  return [
    "CLAUDE_HIVEMIND=1",
    `OPENCODE_CONFIG_CONTENT=${shellQuote(JSON.stringify(config))}`,
    process.env.OPENCODE_COMMAND || "opencode",
    ...(prompt ? ["--prompt", shellQuote(prompt)] : []),
  ].join(" ");
}
