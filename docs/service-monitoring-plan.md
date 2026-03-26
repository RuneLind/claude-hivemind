# Service Monitoring Plan

Monitor running application instances (Spring Boot, Node, Bun, etc.) from the hivemind dashboard — health status, log viewing, and log level filtering.

## Motivation

Each Claude Code instance typically works in a project that runs a local dev server. Today the dashboard shows peers and messages, but has no visibility into whether the actual applications are running, healthy, or producing errors. Surfacing this in the dashboard means less terminal switching and faster debugging.

## Design

### Data model

Each peer can optionally register a service:

```ts
interface ServiceInfo {
  port: number;               // e.g. 8080
  health_url?: string;        // e.g. "/actuator/health", defaults to "/health"
  log_file?: string;          // absolute path to log file
  log_format?: "spring" | "json" | "plain";  // helps parse log levels
  status?: "up" | "down" | "unknown";
  last_check?: string;        // ISO timestamp
}
```

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS services (
  peer_id TEXT PRIMARY KEY REFERENCES peers(id),
  port INTEGER NOT NULL,
  health_url TEXT NOT NULL DEFAULT '/health',
  log_file TEXT,
  log_format TEXT DEFAULT 'plain',
  status TEXT NOT NULL DEFAULT 'unknown',
  last_check TEXT
);
```

### Phase 1: Service registration and health checks

**New MCP tool: `register_service`**

Called by Claude instances to register their running application:

```ts
{
  name: "register_service",
  inputSchema: {
    properties: {
      port: { type: "number", description: "Port the service listens on" },
      health_url: { type: "string", description: "Health endpoint path (default: /health)" },
      log_file: { type: "string", description: "Path to log file" },
    },
    required: ["port"]
  }
}
```

The MCP server sends this to the broker as a new `ClientMessage` type:

```ts
| { type: "register_service"; port: number; health_url: string; log_file?: string }
```

**Broker-side health polling**

The broker polls registered services every 15 seconds:

```ts
async function pollServiceHealth() {
  const services = selectAllServices.all();
  for (const svc of services) {
    try {
      const res = await fetch(`http://127.0.0.1:${svc.port}${svc.health_url}`, {
        signal: AbortSignal.timeout(3000),
      });
      updateServiceStatus.run(res.ok ? "up" : "down", new Date().toISOString(), svc.peer_id);
    } catch {
      updateServiceStatus.run("down", new Date().toISOString(), svc.peer_id);
    }
  }
  // Push updated statuses to dashboard
}
```

**Dashboard changes**

- Peer card gets a service status indicator (green/red dot or badge)
- Tooltip or inline text showing port and last check time
- Service status included in the snapshot WebSocket message

### Phase 2: Log viewer

**Log tailing approach**

Two options for where to tail logs:

1. **Broker-side** (simpler) — broker reads log files directly since everything is localhost
2. **MCP-server-side** — MCP server tails and forwards via WebSocket

Recommendation: **broker-side** for simplicity. The broker already has the file paths from service registration.

**Implementation**

New WebSocket message type for dashboard clients:

```ts
| { type: "subscribe_logs"; peer_id: string; level?: "ERROR" | "WARN" | "INFO" | "DEBUG" }
| { type: "unsubscribe_logs"; peer_id: string }
| { type: "log_lines"; peer_id: string; lines: LogLine[] }
```

```ts
interface LogLine {
  timestamp: string;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
  message: string;
  raw: string;
}
```

Broker implementation:

```ts
// Per-peer log tailer using Bun.file + watch
class LogTailer {
  private offset: number;
  private watcher: FSWatcher;

  constructor(filePath: string, onLines: (lines: LogLine[]) => void) {
    // Read initial offset (end of file)
    // Watch for changes, read new bytes, parse into lines
    // Call onLines with parsed results
  }
}
```

Log line parsing per format:

- **spring**: `2026-03-24 12:00:00.123  INFO 12345 --- [main] c.n.m.Service : message`
- **json**: `{"timestamp":"...","level":"INFO","message":"..."}`
- **plain**: best-effort regex for common patterns, fallback to "INFO"

**Dashboard log panel**

- Click a peer card or service indicator to open log viewer
- Streaming log lines in a scrollable panel (auto-scroll to bottom)
- Filter buttons: ERROR / WARN / INFO / DEBUG (toggle on/off)
- Search/filter text input
- Max 1000 lines in browser (ring buffer)
- Red highlight for ERROR lines, yellow for WARN

### Phase 3: Auto-detection (optional)

Instead of requiring `register_service`, detect services automatically:

**Spring Boot detection:**
- Read `src/main/resources/application.properties` or `application.yml` for `server.port`
- Default health endpoint: `/actuator/health`
- Log file: check `logging.file.name` property, or scan for `logs/*.log`

**Node/Bun detection:**
- Read `package.json` scripts for port patterns (`PORT=3000`, `--port 3000`)
- Check common health endpoints: `/health`, `/healthz`, `/api/health`

**Docker Compose detection:**
- Parse `docker-compose.yml` for port mappings and service names
- Health checks defined in compose file

This phase is nice-to-have. Manual registration via the tool is sufficient for v1.

## API changes summary

### New ClientMessage types
- `register_service` — peer registers its application service

### New BrokerMessage types
- `service_status` — broker pushes status updates to peers

### New DashboardMessage types
- `service_update` — health status change for a peer's service
- `log_lines` — streamed log lines for subscribed viewers

### New HTTP endpoints
- `GET /api/services` — list all registered services and their status
- `GET /api/logs?peer_id=X&lines=100&level=ERROR` — fetch recent log lines

### New dashboard WebSocket messages
- `subscribe_logs` / `unsubscribe_logs` — client requests log streaming
- `log_lines` — server pushes new log lines

## Implementation order

1. `register_service` tool + SQLite table + broker handler
2. Health polling + dashboard status indicators on peer cards
3. Log tailing infrastructure (broker-side file watcher + parser)
4. Dashboard log viewer panel with level filtering
5. (Optional) Auto-detection of services

## Open questions

- Should we support multiple services per peer? (e.g., a project running both API and frontend)
- Should log lines be persisted in SQLite or purely in-memory/streaming?
- Rate limiting on log streaming — how many lines/second to push to dashboard?
- Should health check results be persisted or purely in-memory?
