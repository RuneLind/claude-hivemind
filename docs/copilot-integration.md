# Copilot & OpenCode Integration

Bring GitHub Copilot CLI and OpenCode instances into the hivemind network as first-class peers, enabling cross-agent coordination between Claude Code, Copilot, and OpenCode.

## Motivation

Claude Code instances coordinate via MCP channels — structured push notifications that interrupt mid-task. Neither Copilot nor OpenCode have an equivalent push mechanism, but both have evolved significantly:

- **Copilot CLI Extensions** (GA Feb 2026) provide `session.send()` — structured message injection queued for the next idle turn
- **OpenCode** provides `POST /session/:id/prompt_async` — fire-and-forget message injection via HTTP API

These mechanisms replace our original cmux terminal injection approach with structured, reliable alternatives.

## Current State

### What Copilot supports

| Mechanism | Status | Transport |
|-----------|--------|-----------|
| MCP servers | GA (VS Code, JetBrains, Copilot CLI) | stdio, HTTP, SSE |
| CLI Extensions (`.github/extensions/`) | GA (Feb 2026) | JSON-RPC over stdio (Node.js child process) |
| CLI Hooks (`.github/hooks/`) | GA | Shell commands (JSON config) |
| CLI Plugins (`/plugin install`) | GA | Bundled agents/skills/hooks/MCP |
| Custom Agents (`.agent.md`) | GA | Markdown + YAML frontmatter |
| VS Code Chat Participants | Stable API | VS Code extension |
| Copilot SDK (`@github/copilot-sdk`) | Technical Preview | Embeddable agent runtime |

### What OpenCode supports

| Mechanism | Status | Transport |
|-----------|--------|-----------|
| MCP servers | GA | stdio, SSE, HTTP (with OAuth) |
| Plugin system (`@opencode-ai/plugin`) | GA | npm packages / local paths |
| HTTP REST API | GA | Hono server on Bun |
| SSE event streams | GA | `/event`, `/global/event` |
| Session messaging | GA | `prompt_async`, `message`, `command` endpoints |
| mDNS discovery | GA | Bonjour service publication |
| SDK (`@opencode-ai/sdk`) | GA | TypeScript client from OpenAPI spec |
| ACP (Agent Client Protocol) | GA | JSON-RPC over stdio (Zed integration) |

### What claude-hivemind has

- MCP server (`src/server.ts`) with `list_peers`, `send_message`, `set_summary`, `register_service`
- Push notifications via `claude/channel` experimental MCP capability
- cmux integration (`src/cmux/client.ts`) for terminal-level control
- Dashboard launch system for spawning Claude Code instances via cmux

## Design

### Architecture: Multi-Agent Delivery

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  Claude Code peer   │  │  Copilot CLI peer   │  │  OpenCode peer      │
│                     │  │                     │  │                     │
│  MCP channel (push) │  │  session.send()     │  │  prompt_async (push)│
│  MCP tools (pull)   │  │  MCP tools (pull)   │  │  MCP tools (pull)   │
└──────────┬──────────┘  └──────────┬──────────┘  └──────────┬──────────┘
           │                        │                        │
      ┌────┴────────────────────────┴────────────────────────┴───┐
      │                        Broker                            │
      │                                                          │
      │  Routes messages by agent_type:                          │
      │  - claude-code → MCP channel notification                │
      │  - copilot     → CLI extension session.send()            │
      │  - opencode    → HTTP POST prompt_async                  │
      └──────────────────────────────────────────────────────────┘
```

### Push delivery comparison

| Agent | Push mechanism | Structured? | Delivery confirmation | Interrupts mid-task? |
|-------|---------------|-------------|----------------------|---------------------|
| Claude Code | MCP channel notification | Yes | Yes | **Yes** |
| Copilot CLI | CLI extension `session.send()` | Yes | Yes (`sendAndWait`) | No (queued for next turn) |
| OpenCode | HTTP `prompt_async` | Yes | Yes (204 response) | No (queued) |
| ~~cmux injection~~ | ~~Raw terminal text~~ | ~~No~~ | ~~No~~ | ~~No~~ |

All three structured approaches are superior to cmux terminal injection. The key difference is that Claude Code channels interrupt mid-reasoning, while Copilot and OpenCode queue messages for the next agent turn.

---

## Copilot Integration

### Option A: CLI Extension (recommended)

Build a Copilot CLI extension at `.github/extensions/hivemind/extension.mjs` that bridges the hivemind broker:

```javascript
import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
  tools: [
    {
      name: "hivemind_list_peers",
      description: "List other AI agents in the hivemind network",
      parameters: { scope: { type: "string", enum: ["namespace", "machine"] } },
      execute: async ({ scope }) => {
        // Forward to broker via WebSocket
        return await broker.listPeers(scope);
      }
    },
    {
      name: "hivemind_send_message",
      description: "Send a message to another agent",
      parameters: {
        to: { type: "string" },
        message: { type: "string" }
      },
      execute: async ({ to, message }) => {
        return await broker.sendMessage(to, message);
      }
    }
  ],
  hooks: {
    onSessionStart: async () => {
      // Register as peer with broker
      await broker.register({ agent_type: "copilot", name: session.id });
    },
    onSessionEnd: async () => {
      await broker.disconnect();
    }
  }
});

// Push: deliver queued hivemind messages when Copilot is idle
session.on("session.idle", async () => {
  const messages = await broker.drainQueue();
  for (const msg of messages) {
    await session.send({
      prompt: `[hivemind from ${msg.from_id}] ${msg.message}`
    });
  }
});

// Observe Copilot's activity for summary updates
session.on("assistant.turn_start", async () => {
  await broker.setSummary("Processing...");
});
```

**Advantages over cmux approach:**
- Structured delivery with `session.send()` — no terminal text garbling
- Delivery confirmation via `session.sendAndWait()`
- Event observability (`session.idle`, `assistant.message`, etc.)
- Native tool registration (no separate MCP config needed)
- No dependency on cmux for the push path

**Limitation:** `session.send()` queues messages for the next idle turn. It does not interrupt Copilot mid-reasoning like Claude Code channels do.

### Option B: MCP server only (fallback)

If CLI extensions are unavailable, Copilot can still connect to the hivemind MCP server for pull-based tools (`list_peers`, `send_message`). Push delivery falls back to cmux terminal injection.

### Message flow: Claude Code → Copilot

1. Claude Code calls `send_message(to: "copilot-peer-1", message: "...")`
2. Broker receives message, looks up target peer (`agent_type: "copilot"`)
3. Broker queues message for the CLI extension's WebSocket connection
4. Extension receives message, waits for `session.idle` event
5. Extension calls `session.send({ prompt: formattedMessage })`
6. Copilot processes the message on its next turn

### Message flow: Copilot → Claude Code

1. Copilot calls `hivemind_send_message` tool (registered by CLI extension)
2. Extension forwards to broker via WebSocket
3. Broker delivers to Claude Code peer via MCP channel notification (existing flow)

---

## OpenCode Integration (implemented)

### Current: MCP server + HTTP push (implemented)

OpenCode connects to the hivemind MCP server for pull tools (list_peers, send_message). The broker pushes messages to OpenCode via its HTTP API. This is fully implemented:

**Pull path (OpenCode → broker):** MCP server configured in `opencode.json` (no leading dot):

```json
{
  "mcp": {
    "claude-hivemind": {
      "type": "local",
      "command": ["bun", "run", "/path/to/claude-hivemind/src/server.ts"],
      "environment": {
        "CLAUDE_HIVEMIND": "1",
        "CLAUDE_HIVEMIND_AGENT_TYPE": "opencode",
        "OPENCODE_URL": "http://localhost:3000"
      }
    }
  }
}
```

**Push path (broker → OpenCode):** Implemented in `src/broker/peers.ts`:

```typescript
// Session resolution with 30s cache
async function resolveOpenCodeSession(baseUrl: string): Promise<string | null>

// Fire-and-forget HTTP delivery
async function deliverToOpenCode(target: Peer, fromId: string, text: string, stmts: PeerStatements): Promise<boolean>
```

The broker resolves the active session via `GET {opencode_url}/session`, caches it for 30s, then delivers via `POST {opencode_url}/session/{id}/prompt_async`.

**Dashboard launch:** `launchOpenCodeInstance()` in `src/cmux/client.ts` creates a cmux workspace, writes `opencode.json` with hivemind MCP config, and starts `opencode`.

### Future: Plugin (richer integration)

An OpenCode plugin could provide deeper integration:

```typescript
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

export default function hivemindPlugin(input: PluginInput): Hooks {
  const { client, project } = input;
  let broker: WebSocket;

  return {
    tool: () => [
      {
        name: "hivemind_list_peers",
        description: "List other AI agents in the hivemind network",
        parameters: { scope: { type: "string", enum: ["namespace", "machine"] } },
        execute: async ({ scope }) => broker.listPeers(scope),
      },
      {
        name: "hivemind_send_message",
        description: "Send a message to another agent",
        parameters: { to: { type: "string" }, message: { type: "string" } },
        execute: async ({ to, message }) => broker.sendMessage(to, message),
      }
    ],
    event: async (event) => {
      if (event.type === "session.updated") {
        await broker.setSummary(event.properties?.summary);
      }
    },
  };
}
```

### Message flow: Claude Code → OpenCode

1. Claude Code calls `send_message(to: "opencode-peer-1", message: "...")`
2. Broker receives message, looks up target peer (`agent_type: "opencode"`)
3. Broker resolves active session via `GET {opencode_url}/session` (cached 30s)
4. Broker calls `POST {opencode_url}/session/{id}/prompt_async`
5. OpenCode queues the message for the next agent turn

### Message flow: OpenCode → Claude Code

1. OpenCode calls `send_message` tool (via hivemind MCP server)
2. MCP server forwards via WebSocket to broker
3. Broker delivers to Claude Code peer via MCP channel notification

---

## Peer Type Tracking (implemented)

The peer model includes `agent_type` and `opencode_url`:

```ts
type AgentType = "claude-code" | "opencode" | "copilot";

interface Peer {
  id: string;
  // ... existing fields
  agent_type: AgentType;
  opencode_url: string | null; // Base URL for OpenCode HTTP API
}
```

The broker uses `agent_type` to select the delivery mechanism when routing messages. For OpenCode peers, it resolves the active session via `GET /session` (cached 30s) and delivers via `POST /session/:id/prompt_async`.

## Limitations

### Copilot
- **No mid-task interrupts** — `session.send()` queues for next idle turn, unlike Claude Code channels
- **Single extension hook bug** — Only the last-loaded extension's hooks fire if multiple extensions register the same hook type
- **Node.js only** — CLI extensions must be ES modules in Node.js

### OpenCode
- **No mid-task interrupts** — `prompt_async` queues messages, doesn't interrupt reasoning
- **Port discovery** — Need to know OpenCode's HTTP port (mDNS helps, but adds complexity)
- **Session lifecycle** — Must track which session ID to target for message delivery

### General
- **Asymmetric push** — Only Claude Code channels truly interrupt mid-task. Copilot and OpenCode queue messages, meaning response latency depends on current task completion time.
- **No universal push standard** — Each agent type requires a different delivery mechanism in the broker.

## Implementation Status

### Done

- [x] `agent_type` field on peer model (`AgentType = "claude-code" | "opencode" | "copilot"`) with DB migration
- [x] `opencode_url` field on peer model for HTTP push delivery base URL
- [x] Broker routes messages by `agent_type` — OpenCode peers get HTTP `prompt_async`, Claude Code gets WebSocket/MCP channel
- [x] OpenCode session resolution with 30s cache in `peers.ts` → `resolveOpenCodeSession()`
- [x] MCP server detects agent type via `CLAUDE_HIVEMIND_AGENT_TYPE` env var, includes in registration
- [x] Dashboard peer cards show agent type badge (blue=Claude, purple=OpenCode, orange=Copilot)
- [x] Dashboard launch modal has agent type selector (Claude Code / OpenCode)
- [x] `launchOpenCodeInstance()` in cmux client — creates workspace, writes `opencode.json` with hivemind MCP config
- [x] Tool descriptions and instructions are agent-type-aware (not Claude Code-specific)

### Remaining

- [ ] Build Copilot CLI extension prototype (`.github/extensions/hivemind/extension.mjs`)
- [ ] Build OpenCode plugin prototype (`@claude-hivemind/opencode-plugin`) for richer integration
- [ ] Test `session.send()` delivery timing and reliability in Copilot CLI
- [ ] Test `prompt_async` delivery with a real OpenCode instance
- [ ] Add OpenCode instance discovery via mDNS or manual registration
- [ ] Investigate whether OpenCode's `chat.message` hook can provide true push interrupts
- [ ] Add SSE event stream observation for OpenCode state tracking
