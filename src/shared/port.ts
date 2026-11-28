/**
 * How every hivemind process reads CLAUDE_HIVEMIND_PORT: `parseInt(v, 10)`,
 * so "7950 ", " 7950", "+7950" and "7950abc" all mean 7950. The broker, CLI,
 * MCP server and OpenCode plugin share it so they agree on any value that parses
 * to 1..65535. They still disagree on one that does not ("", "abc", "0"): the
 * plugin skips it and falls back, the broker passes it to Bun.serve, which binds
 * a random port. They also disagree on a port set only in plugin-settings.json,
 * which the plugin alone reads.
 */
export const DEFAULT_PORT = 7899;

export function parsePort(v: string): number {
  return parseInt(v, 10);
}

/** CLAUDE_HIVEMIND_PORT from the environment, else 7899 (unvalidated). */
export function envPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.CLAUDE_HIVEMIND_PORT ?? String(DEFAULT_PORT));
}
