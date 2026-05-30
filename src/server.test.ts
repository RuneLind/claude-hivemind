/**
 * M14: server.ts WS send / reconnect / routing.
 *
 * server.ts is NOT import-testable as-is: it has no exports, holds all socket
 * state (`ws`, `myId`, `reconnectAttempts`) in module-private closures, and
 * calls `main()` at top level — importing it would spawn a StdioServerTransport
 * and open a live broker WebSocket. Fuller coverage of `wsSend()` /
 * `scheduleReconnect()` / `handleBrokerMessage()` routing needs a small
 * injectable-socket refactor (extract those into a testable module that takes
 * the socket + state as parameters). That refactor is intentionally OUT OF
 * SCOPE here and is owned by a follow-up — see the PR body.
 *
 * What IS feasible without the refactor and without side effects:
 *  - The correlation logic that `send_message` routing depends on is already
 *    fully covered by correlation-tracker.test.ts (CorrelationTracker is the
 *    one server.ts collaborator that is cleanly importable).
 *  - The reconnect backoff formula is pure arithmetic; we pin it here as a
 *    reference so a future refactor that moves it behind a function can assert
 *    behavior is unchanged. The constants and expression mirror server.ts
 *    (`Math.min(1000 * Math.pow(2, attempts), MAX_RECONNECT_DELAY)`,
 *    MAX_RECONNECT_DELAY = 30_000).
 */

import { describe, test, expect } from "bun:test";
import { CorrelationTracker } from "./correlation-tracker.ts";

// Mirror of server.ts:39 + the formula in scheduleReconnect() (server.ts:184).
const MAX_RECONNECT_DELAY = 30_000;
function reconnectDelay(attempts: number): number {
  return Math.min(1000 * Math.pow(2, attempts), MAX_RECONNECT_DELAY);
}

describe("server reconnect backoff (reference for the future refactor)", () => {
  test("grows exponentially from 1s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(1)).toBe(2000);
    expect(reconnectDelay(2)).toBe(4000);
    expect(reconnectDelay(3)).toBe(8000);
    expect(reconnectDelay(4)).toBe(16000);
  });

  test("caps at MAX_RECONNECT_DELAY", () => {
    expect(reconnectDelay(5)).toBe(30000); // 32000 clamped
    expect(reconnectDelay(10)).toBe(MAX_RECONNECT_DELAY);
    expect(reconnectDelay(100)).toBe(MAX_RECONNECT_DELAY);
  });

  test("is monotonically non-decreasing", () => {
    let prev = 0;
    for (let i = 0; i <= 20; i++) {
      const d = reconnectDelay(i);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("send_message correlation routing (server.ts collaborator)", () => {
  // server.ts derives the outbound correlation_id via correlation.resolveOutbound
  // (server.ts:469). These pin the routing-relevant contract the handler relies on.
  test("an explicit in_reply_to is echoed verbatim", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peer-x", "tok-A");
    t.recordInbound("peer-x", "tok-B");
    // Explicit selection wins even when several inbound tokens are in flight.
    expect(t.resolveOutbound("peer-x", "tok-A")).toBe("tok-A");
  });

  test("no token is echoed when nothing inbound is tracked for the peer", () => {
    const t = new CorrelationTracker();
    expect(t.resolveOutbound("unknown-peer")).toBeUndefined();
  });
});
