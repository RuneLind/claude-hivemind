# claude-hivemind

Let your Claude Code instances find each other and talk — with namespace isolation and a live dashboard.

Peers are automatically grouped by project directory (e.g., everything under `~/source/nav/` is one namespace, `~/source/private/` is another). Peers can only see and message others in the same namespace.

```
  Terminal 1 (nav/melosys-api)         Terminal 2 (nav/melosys-web)
  ┌───────────────────────┐            ┌──────────────────────┐
  │ Claude A   [ns: nav]  │            │ Claude B   [ns: nav] │
  │ "send a message to    │  ───WS──>  │                      │
  │  peer xyz: what API   │            │ <channel> arrives    │
  │  endpoint handles X?" │  <──WS───  │  instantly, Claude B │
  │                       │            │  responds            │
  └───────────────────────┘            └──────────────────────┘

  Terminal 3 (private/muninn)
  ┌───────────────────────┐
  │ Claude C [ns: private]│  ← Cannot see or message A or B
  └───────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone <repo-url> ~/claude-hivemind
cd ~/claude-hivemind
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-hivemind -- bun ~/claude-hivemind/src/server.ts
```

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-hivemind
```

The broker daemon starts automatically on first use.

### 4. Open the dashboard

```bash
bun src/cli.ts dashboard
# or open http://127.0.0.1:7899/
```

## Tools

| Tool | Description |
|------|-------------|
| `list_peers` | Find peers — scoped to `namespace` (default) or `machine` |
| `send_message` | Send a message to a peer by ID (same namespace only) |
| `set_summary` | Describe what you're working on (visible to other peers) |
| `check_messages` | No-op — messages arrive automatically via WebSocket |

## How it works

A **broker daemon** runs on `localhost:7899` with SQLite storage. Each Claude Code session connects via **WebSocket** for real-time messaging (no polling). Messages are pushed instantly via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol.

```
                    ┌──────────────────────────────┐
                    │  broker daemon               │
                    │  localhost:7899 + SQLite      │
                    │  + Web Dashboard              │
                    └──────┬──────────────┬─────────┘
                           │ WebSocket    │ WebSocket
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

## Namespaces

Namespaces are auto-derived from your directory structure:

- `~/source/nav/melosys-api` → namespace `nav`
- `~/source/private/muninn` → namespace `private`

Override with `~/.claude-hivemind-namespaces.json`:

```json
{
  "rules": [
    { "name": "nav", "path_prefix": "/Users/you/source/nav" },
    { "name": "private", "path_prefix": "/Users/you/source/private" }
  ],
  "default_namespace": "default"
}
```

## CLI

```bash
bun src/cli.ts status          # broker status + peers by namespace
bun src/cli.ts peers           # list peers
bun src/cli.ts send <id> <msg> # send a message
bun src/cli.ts dashboard       # open web dashboard
bun src/cli.ts kill-broker     # stop the broker
```

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it)
