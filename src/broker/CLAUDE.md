# Broker internals

The broker is split into focused modules. The entry point `../broker.ts` wires everything together; these files contain the domain logic.

## Module layout

| File | Responsibility |
|------|---------------|
| `db.ts` | Schema creation, `BrokerContext` type, `WSData` types |
| `peers.ts` | Peer CRUD, ID generation, messaging (WebSocket + cmux injection), stale cleanup, `log()` |
| `services.ts` | Service health polling, baseline statements |
| `docker.ts` | Docker container monitoring, event stream, Docker log tailing |
| `logs.ts` | Log parsing, `LogTailer` class, service log subscriptions |
| `handlers.ts` | `handlePeerMessage`, `handleDashboardMessage`, repo scanning, cmux polling |

## BrokerContext pattern

Modules don't reference `server` or `peerSockets` via closure. Instead, a `BrokerContext` object is assembled in the entry point after `Bun.serve()` returns and passed to functions that need it:

```typescript
interface BrokerContext {
  server: import("bun").Server;
  peerSockets: Map<string, ServerWebSocket<WSData>>;
}
```

Use `ctx.server.publish()` to broadcast. Use the standalone `log()` function from `peers.ts` for logging. The `handleDashboardMessage` function takes a `DashboardDeps` object bundling all statement and state dependencies.

## Statement objects

Each module creates its own prepared statements via a factory function (`createPeerStatements(db)`, `createServiceStatements(db)`, etc.) that returns a typed object. The entry point creates all statement objects at startup and passes them to functions as needed.

## State containers

Docker, log subscriptions, and cmux each have a `createXState()` factory that returns a mutable state object. This keeps module-level state explicit and avoids hidden globals.

## Message routing by agent type

`deliverOrQueue()` in `peers.ts` routes messages based on the target peer's `agent_type`:

- **claude-code** (default): Send via WebSocket → MCP server → MCP channel notification (interrupts mid-task)
- **opencode** (plugin, no `surface_id`): WebSocket → plugin (`src/opencode/`) → `client.session.promptAsync` into the active session (queued for next turn). Carries `correlation_id`. The plugin registers with `ack: true`: its messages carry `message_id`, stay `delivered = 0` until it sends `{type:"ack", message_id}`, and are resent on its next registration from the same directory (see below).
- **opencode** with `surface_id` (legacy MCP route): typed into the cmux terminal (`deliverViaCmux`). The `opencode_url` column is unused and always null.
- **copilot**: WebSocket delivery (same as claude-code for now; future: CLI extension `session.send()`)

### Peer ids across reconnects

A registration from the same (pid, namespace, cwd) as an existing row takes that row's id back (an OpenCode 2.x process holds one peer per directory, and its instances reload). Any other registration skips the ids of disconnected rows, from any process, unless the row is from its own (namespace, cwd, agent type): that is the same peer restarting under a new pid (a Claude Code session), which takes its id back when free and gets the messages queued for it. A disconnected row is reaped `GRACE_PERIOD_MS` after its disconnect (`last_seen`), by a timer and by `cleanStalePeers`, so a broker restart does not keep it alive. `CLAUDE_HIVEMIND_GRACE_MS` overrides the period (tests); a non-positive or non-integer value is refused for the 30 s default.

A message sent to an acking peer records that peer's directory (`messages.to_cwd`, `to_namespace`), and so does a queued message once it is resent to one. Such a message is resent only to an acking registration of the same id from the same directory, never to another directory that took the id later. If that directory never comes back under that id, the message stays queued, as an offline message does, until `UNDELIVERED_RETENTION_MS` deletes it.

### `correlation_id` (opaque reply token)

`send_message` may carry an optional `correlation_id` the broker **never interprets** — it persists it on the `messages` row and round-trips it to the target (live WS payload + queued redelivery). A peer mints a token on an outbound and matches it on the echoed reply to route the reply back to the request it answers. The cmux text-injection transport can't carry it, so those targets fall back to coarse correlation. Design + consumer side: `mimir/plans/claude-hivemind-reply-correlation.md`.

## Adding new features

- New DB tables: add `CREATE TABLE` to `db.ts` → `initDatabase()`, add prepared statements to the relevant domain module.
- New WS message types: add to `shared/types.ts`, handle in `handlers.ts`.
- New HTTP routes: add to the `routes` object in `../broker.ts`.
- New background polling: add interval in `../broker.ts` after context assembly.
