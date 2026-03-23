# claude-hivemind

Peer discovery and messaging for Claude Code instances, with namespace isolation and a web dashboard.

## Architecture

- `broker.ts` — Singleton HTTP + WebSocket server on localhost:7899, backed by SQLite. Serves dashboard, routes messages, enforces namespace isolation.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker via WebSocket, pushes inbound messages via channel notifications.
- `cli.ts` — CLI utility for inspecting broker state and managing peers.
- `dashboard.html` + `dashboard.tsx` + `dashboard.css` — Read-only web dashboard showing peers grouped by namespace.
- `shared/types.ts` — WebSocket protocol types (client/broker/dashboard message unions).
- `shared/namespace.ts` — Namespace resolution from CWD (auto-derives from ~/source/<group>/).

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-hivemind

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts dashboard
bun cli.ts kill-broker
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
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

Uses Bun HTML imports. dashboard.html imports dashboard.tsx directly, bundled automatically by Bun.
