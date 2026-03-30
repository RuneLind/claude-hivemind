# Dashboard

Server-rendered single-page dashboard using vanilla TypeScript. No framework, no bundler — each component module exports functions returning HTML, CSS, and/or JS strings that are composed into one HTML page at broker startup.

## Component pattern

Each file in `views/components/` exports one or more of:
- `fooStyles()` — CSS string
- `fooScript()` — JavaScript string (browser-side, runs in global scope)
- `fooHtml()` — HTML string for static DOM elements

These are assembled by `views/page.ts` into a single `renderDashboardPage()` return value served at `/`.

## Key components

| File | Role |
|------|------|
| `state.ts` | Global `STATE` object + `handleMessage()` WebSocket dispatcher |
| `connection.ts` | WebSocket connection to broker, reconnect logic |
| `renderer.ts` | `renderAll()` orchestrator, calls component render functions |
| `helpers.ts` | DOM utilities (`$()`, `escapeHtml()`, `formatTime()`) |
| `peer-card.ts` | Peer cards with service status, summary, message button |
| `container-card.ts` | Docker container cards with state, stats, log/stop buttons |
| `log-viewer.ts` | Service and Docker log viewer panel |
| `launch-modal.ts` | Multi-agent launch modal with folder scanning |
| `namespace-graph.ts` | Per-namespace collapsible sections |
| `conversation-modal.ts` | Peer-to-peer message dialog |
| `activity-log.ts` | Real-time event feed |

## Data flow

1. Browser connects to `ws://localhost:7899/ws/dashboard`
2. Broker sends `snapshot` message with full state
3. `handleMessage()` in `state.ts` updates `STATE` and calls `renderAll()`
4. Incremental updates (`peer_joined`, `service_update`, `docker_update`, etc.) patch `STATE` and re-render

## Adding a new component

1. Create `views/components/foo.ts` exporting `fooStyles()`, `fooScript()`, and optionally `fooHtml()`
2. Import and compose in `views/page.ts`
3. If the component needs data, add a message type handler in `state.ts` → `handleMessage()`
4. Call render function from `renderer.ts` → `renderAll()`
