# Broker internals

The broker is split into focused modules. The entry point `../broker.ts` wires everything together; these files contain the domain logic.

## Module layout

| File | Responsibility |
|------|---------------|
| `db.ts` | Schema creation, `BrokerContext` type, `WSData` types |
| `peers.ts` | Peer CRUD, ID generation, messaging, stale cleanup, `log()` |
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

## Adding new features

- New DB tables: add `CREATE TABLE` to `db.ts` → `initDatabase()`, add prepared statements to the relevant domain module.
- New WS message types: add to `shared/types.ts`, handle in `handlers.ts`.
- New HTTP routes: add to the `routes` object in `../broker.ts`.
- New background polling: add interval in `../broker.ts` after context assembly.
