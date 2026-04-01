# Copilot Integration

Bring GitHub Copilot CLI instances into the hivemind network as first-class peers, enabling cross-agent coordination between Claude Code and Copilot.

## Motivation

Claude Code instances coordinate via MCP channels — structured push notifications that interrupt mid-task. Copilot CLI has no equivalent push mechanism, but it does support MCP tools (pull-based). By combining MCP for the pull side with cmux terminal injection for the push side, we can bridge the gap and create a heterogeneous multi-agent network.

## Current State

### What Copilot supports

| Mechanism | Status | Transport |
|-----------|--------|-----------|
| MCP servers | GA (VS Code, JetBrains, Copilot CLI) | stdio, HTTP, SSE |
| Copilot Extensions (old HTTP-based) | Sunset Nov 2025 | — |
| VS Code Chat Participants | Stable API | VS Code extension |
| Copilot SDK (`@github/copilot-sdk`) | Technical Preview | Embeddable agent runtime |
| Agent Skills (`SKILL.md`) | GA | File convention |

### What claude-hivemind has

- MCP server (`src/server.ts`) with `list_peers`, `send_message`, `set_summary`, `register_service`
- Push notifications via `claude/channel` experimental MCP capability
- cmux integration (`src/cmux/client.ts`) for terminal-level control: `sendText`, `sendKey`, workspace/surface management
- Dashboard launch system for spawning Claude Code instances via cmux

## Design

### Architecture: Hybrid MCP + cmux

```
┌─────────────────────┐         ┌─────────────────────┐
│  Claude Code peer   │         │  Copilot CLI peer   │
│                     │         │                     │
│  MCP channel (push) │◄──┐    │  MCP tools (pull)   │◄──┐
│  MCP tools (pull)   │◄──┤    │  cmux text (push)   │◄──┤
└─────────────────────┘   │    └─────────────────────┘   │
                          │                              │
                     ┌────┴──────────────────────────────┴───┐
                     │              Broker                    │
                     │                                       │
                     │  Routes messages by peer type:        │
                     │  - Claude Code → MCP channel notify   │
                     │  - Copilot     → cmux sendText        │
                     └───────────────────────────────────────┘
```

### Message flow: Claude Code → Copilot

1. Claude Code calls `send_message(to: "copilot-peer-1", message: "...")`
2. Broker receives message, looks up target peer
3. Peer is type `copilot` with an associated `surface_id`
4. Broker calls `cmux.sendText(formattedMessage, surfaceId)` + `cmux.sendKey("enter", surfaceId)`
5. Text appears in Copilot's terminal input and is submitted

### Message flow: Copilot → Claude Code

1. Copilot calls `send_message` MCP tool (pull-based, Copilot-initiated)
2. MCP server forwards to broker via WebSocket
3. Broker delivers to Claude Code peer via MCP channel notification (existing flow)

### Peer type tracking

Extend the peer model to include an `agent_type` field:

```ts
interface Peer {
  id: string;
  name: string;
  namespace: string;
  agent_type: "claude-code" | "copilot" | "unknown";
  surface_id?: string;  // cmux surface for terminal-based push
  // ... existing fields
}
```

The broker uses `agent_type` to decide the delivery mechanism when routing messages.

### Launching Copilot via cmux

Add a `launchCopilotInstance()` function mirroring `launchClaudeInstance()`:

```ts
async function launchCopilotInstance(opts: {
  directory: string;
  name?: string;
  prompt?: string;
}) {
  const workspaceId = await createWorkspace(opts.name ?? basename(opts.directory));
  await selectWorkspace(workspaceId);
  const surfaceId = await getActiveSurface() ?? undefined;

  // Launch Copilot CLI with hivemind MCP server
  const cmd = `cd ${JSON.stringify(opts.directory)} && copilot-cli --mcp-config ~/.copilot/mcp-config.json`;
  await sendText(cmd, surfaceId);
  await sendKey("enter", surfaceId);

  return { workspaceId, surfaceId };
}
```

### Message formatting for terminal injection

Since cmux injects raw text (no structured framing), format messages clearly:

```
[hivemind from peer-a (Claude Code)] Can you check the test failures in UserService?
```

Copilot needs instructions (via MCP server `instructions` or a `SKILL.md`) to recognize this pattern as a peer message and respond appropriately.

## Limitations and Open Questions

### Known limitations

- **Input timing** — cmux sends text regardless of Copilot's state. If Copilot is mid-generation or waiting for tool approval, injected text may be garbled or ignored.
- **No delivery confirmation** — terminal injection is fire-and-forget. No way to know if Copilot processed the message.
- **Unstructured push** — Copilot receives raw text, not a structured notification with metadata. Context (sender, namespace, priority) must be encoded in the message string.
- **One-way push** — cmux provides push *to* Copilot, but Copilot can only respond via MCP tools (pull). The response path requires Copilot to actively call `send_message`.

### Open questions

1. **Copilot CLI availability** — Is `copilot-cli` (the terminal agent) stable enough for automated launching? What flags does it accept?
2. **MCP config for Copilot CLI** — Exact config format and whether it supports stdio servers the same way VS Code does.
3. **Input buffering** — Does Copilot CLI buffer terminal input cleanly when it's busy, or does injected text get lost?
4. **Agent instructions** — Can we include `instructions` in the MCP server capability declaration that Copilot will respect (like Claude Code does)?
5. **VS Code alternative** — For Copilot in VS Code (not CLI), a Chat Participant extension could provide a cleaner push channel than cmux. Worth exploring as a separate track.

## Next Steps

- [ ] Test registering the existing MCP server with Copilot CLI and verify tools work
- [ ] Prototype `launchCopilotInstance()` in cmux client
- [ ] Add `agent_type` field to peer model and broker routing logic
- [ ] Design message formatting convention for terminal injection
- [ ] Investigate Copilot CLI input buffering behavior
- [ ] Extend dashboard launch modal to support Copilot as a launch target
