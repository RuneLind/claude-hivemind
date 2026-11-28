/**
 * How every hivemind process reads CLAUDE_HIVEMIND_PORT: `parseInt(v, 10)`,
 * so "7950 ", " 7950", "+7950" and "7950abc" all mean 7950. The broker, CLI,
 * MCP server and OpenCode plugin share it so they never disagree on a port.
 */
export const DEFAULT_PORT = 7899;

export function parsePort(v: string): number {
  return parseInt(v, 10);
}

/** CLAUDE_HIVEMIND_PORT from the environment, else 7899 (unvalidated). */
export function envPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.CLAUDE_HIVEMIND_PORT ?? String(DEFAULT_PORT));
}
