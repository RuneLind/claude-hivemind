export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command that starts a hivemind-connected OpenCode (run in the
 * project directory). The plugin comes in through OPENCODE_CONFIG_CONTENT, so
 * it loads whether or not it is installed globally (the plugin guards against
 * loading twice), and the project's own opencode.json is left alone.
 * `permission` mirrors the --dangerously-skip-permissions the Claude launcher
 * passes. cmux sets CMUX_WORKSPACE_ID in the new terminal itself.
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
