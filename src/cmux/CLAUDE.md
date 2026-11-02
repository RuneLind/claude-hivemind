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
| surface.list | workspace_id | Fallback: the workspace's selected surface (`selected_in_pane`). Without `workspace_id` it lists the CALLER's workspace |
| surface.send_text | text, surface_id | Send commands |
| surface.send_key | key, surface_id | Send keystrokes |
| surface.read_text | surface_id | Read the terminal's visible text (shell readiness) |

## Launch Flow

`launchClaudeInstance()` does:

1. `workspace.create` — new workspace named after the repo
2. `workspace.select` — focus it
3. Take the new terminal's `surface_id` from the `workspace.create` result (fallback: `surface.list` with that `workspace_id`) for targeted input
4. `surface.send_text` — send `cd <dir> && CLAUDE_HIVEMIND=1 claude --name <name> --dangerously-load-development-channels server:claude-hivemind --dangerously-skip-permissions`
5. `surface.send_key` enter — execute the command
6. setTimeout 4s + 7s → `surface.send_key` enter — auto-confirm development channels prompt (two attempts to cover slow startups)
7. (Optional) setTimeout 12s → send initial prompt

Surface IDs are captured so delayed keystrokes target the correct terminal even when launching multiple instances in sequence.

### OpenCode Launch Flow

`launchOpenCodeInstance()` does:

1. `workspace.create` — new workspace named "<repo> - OpenCode"
2. `workspace.select` — focus it
3. Take the new terminal's surface ID, as above
4. `waitForShellReady()` — poll `surface.read_text` until the shell has drawn its prompt and stopped changing (max 10s). Typing earlier lost the Enter: the command sat unexecuted on the prompt line.
5. `surface.send_text` + `send_key enter` — `cd <dir> && CLAUDE_HIVEMIND=1 OPENCODE_CONFIG_CONTENT='{"plugin":["file://…/src/opencode/plugin.ts"],"permission":{"*":"allow"}}' opencode [--prompt '<initial prompt>']` (built by `opencode-command.ts`)

The plugin arrives through `OPENCODE_CONFIG_CONTENT`, so no global install is needed and the project's `opencode.json` is left alone; the plugin guards against loading twice when it is also installed globally. The initial prompt rides on `--prompt` instead of being typed after a delay. cmux sets `CMUX_WORKSPACE_ID` in the new terminal, which the plugin sends at registration so the broker can rename the workspace.

`workspace.create` also accepts `working_directory` and `initial_command`, but cmux runs that command in a non-interactive login shell (no `.zshrc` PATH), and the workspace closes when it exits, so the launcher types the command instead.

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
