# cmux integration

JSON-RPC client for [cmux](https://cmux.com) terminal multiplexer. Used by the broker to launch Claude Code and OpenCode instances from the dashboard.

## Architecture

- `client.ts` — Low-level RPC client over Unix socket + high-level `launchClaudeInstance()` and `launchOpenCodeInstance()` functions.
- Broker integration in `../broker/handlers.ts` — polls cmux status every 15s, handles `launch_claude_instance` / `launch_claude_instances` / `scan_repos` messages from dashboard.
- Dashboard UI in `../dashboard/views/components/launch-modal.ts` — "+ Agents" button, folder scanning, checkbox selection.

## Socket Protocol

cmux exposes a Unix socket at the path stored in `/tmp/cmux-last-socket-path` (typically `~/Library/Application Support/cmux/cmux.sock`). Protocol is newline-terminated JSON-RPC:

```
→ {"id":"1","method":"workspace.create","params":{"name":"my-repo"}}\n
← {"id":"1","ok":true,"result":{"workspace_id":"...","surface_id":"..."}}\n
```

The `rpc()` function in `client.ts` opens a new TCP socket per call — acceptable for the low call frequency (polling every 15s, burst of 4-6 calls per launch).

## Key API Methods

| Method | Params | Used for |
|---|---|---|
| system.ping | — | Availability check |
| workspace.list | — | Dashboard status |
| workspace.create | name | New workspace |
| workspace.select | workspace_id | Focus before sending |
| workspace.close | workspace_id | Cleanup |
| surface.list | — | Get surface ID after select |
| surface.send_text | text, surface_id | Send commands |
| surface.send_key | key, surface_id | Send keystrokes |

## Launch Flow

`launchClaudeInstance()` does:

1. `workspace.create` — new workspace named after the repo
2. `workspace.select` — focus it
3. `surface.list` — capture the surface ID for targeted input
4. `surface.send_text` — send `cd <dir> && CLAUDE_HIVEMIND=1 claude --name <name> --dangerously-load-development-channels server:claude-hivemind --dangerously-skip-permissions`
5. `surface.send_key` enter — execute the command
6. setTimeout 4s + 7s → `surface.send_key` enter — auto-confirm development channels prompt (two attempts to cover slow startups)
7. (Optional) setTimeout 12s → send initial prompt

Surface IDs are captured so delayed keystrokes target the correct terminal even when launching multiple instances in sequence.

### OpenCode Launch Flow

`launchOpenCodeInstance()` does:

1. `workspace.create` — new workspace named after the repo
2. `workspace.select` — focus it
3. `surface.list` — capture surface ID
4. `surface.send_text` — write `.opencode.json` with hivemind MCP config (if not present), then `cd <dir> && opencode`
5. `surface.send_key` enter — execute
6. (Optional) setTimeout 8s → send initial prompt

The generated `.opencode.json` configures the hivemind MCP server with `CLAUDE_HIVEMIND=1` and `CLAUDE_HIVEMIND_AGENT_TYPE=opencode` env vars, so the broker knows to deliver messages via HTTP `prompt_async` instead of MCP channels.

## CLI Reference

The cmux CLI maps to the same socket methods. Key commands:

```bash
cmux tree                                    # Workspace/pane/surface hierarchy
cmux identify                                # JSON: current refs
cmux send --surface <ref> "text"             # Send to specific surface
cmux send-key --surface <ref> enter          # Keystroke to specific surface
cmux read-screen --surface <ref>             # Read terminal content
cmux new-workspace --name X --cwd /path      # One-step workspace creation
```

IDs use short refs: `workspace:1`, `surface:4`, `pane:2`.
