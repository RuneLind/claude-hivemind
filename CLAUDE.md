# claude-hivemind

Peer discovery and messaging for Claude Code instances, with namespace isolation and a web dashboard.

## Architecture

- `src/broker.ts` — Entry point for the broker daemon (HTTP + WebSocket on localhost:7899). Wires together modules from `src/broker/`.
- `src/broker/` — Broker internals: database schema (`db.ts`), peer lifecycle (`peers.ts`), service health (`services.ts`), Docker monitoring (`docker.ts`), log tailing (`logs.ts`), WS message handlers (`handlers.ts`). See `src/broker/CLAUDE.md`.
- `src/server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker via WebSocket, pushes inbound messages via channel notifications.
- `src/cli.ts` — CLI utility for inspecting broker state and managing peers.
- `src/dashboard/` — Web dashboard (vanilla TypeScript, server-rendered HTML) showing peers grouped by namespace, Docker containers grouped by Compose project, service health, and log streaming.
- `src/cmux/` — JSON-RPC client for cmux terminal multiplexer. Creates workspaces and launches Claude Code instances from the dashboard. See `src/cmux/CLAUDE.md`.
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
| `CMUX_SOCKET_PATH` | `/tmp/cmux.sock` | cmux Unix socket path |

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
