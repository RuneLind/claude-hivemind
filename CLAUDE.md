# claude-hivemind

Peer discovery and messaging for Claude Code instances, with namespace isolation and a web dashboard.

## Architecture

- `src/broker.ts` — Singleton HTTP + WebSocket server on localhost:7899, backed by SQLite. Serves dashboard, routes messages, enforces namespace isolation. Also monitors Docker Compose containers and registered services.
- `src/server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker via WebSocket, pushes inbound messages via channel notifications.
- `src/cli.ts` — CLI utility for inspecting broker state and managing peers.
- `src/dashboard/` — Web dashboard (vanilla TypeScript, server-rendered HTML) showing peers grouped by namespace, Docker containers grouped by Compose project, service health, and log streaming.
- `src/shared/types.ts` — WebSocket protocol types (client/broker/dashboard message unions).
- `src/shared/namespace.ts` — Namespace resolution from CWD (auto-derives from ~/source/<group>/).

## Running

```bash
# Start broker in dev mode (auto-reload):
bun dev

# Start broker:
bun start

# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-hivemind

# CLI:
bun status
bun peers
bun src/cli.ts send <peer-id> <message>
bun dashboard
bun kill
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_HIVEMIND` | (unset) | Set to `1` to activate broker connection. Without it, MCP server stays dormant. |
| `CLAUDE_HIVEMIND_PORT` | `7899` | Broker port |
| `CLAUDE_HIVEMIND_DB` | `~/.claude-hivemind.db` | SQLite database path |

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` for HTTP + WebSocket. Don't use `express` or `ws`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.file` over `node:fs` readFile/writeFile.

## Frontend

Dashboard is server-rendered: TypeScript component modules in `src/dashboard/views/components/` export functions that return HTML/CSS/JS strings. These are composed into a single HTML page by `src/dashboard/views/page.ts` and served by the broker. Data flows via WebSocket from broker to dashboard.
