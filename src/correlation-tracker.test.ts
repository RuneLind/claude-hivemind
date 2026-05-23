import { describe, test, expect } from "bun:test";
import { CorrelationTracker } from "./correlation-tracker.ts";

describe("CorrelationTracker", () => {
  test("echoes the token when exactly one is in flight", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    expect(t.resolveOutbound("peerA")).toBe("tok-1");
  });

  test("omits the token when none is in flight (fresh outbound)", () => {
    const t = new CorrelationTracker();
    expect(t.resolveOutbound("peerA")).toBeUndefined();
  });

  test("omits the token when two or more are outstanding (ambiguous)", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    t.recordInbound("peerA", "tok-2");
    expect(t.resolveOutbound("peerA")).toBeUndefined();
  });

  test("explicit in_reply_to always wins, even when ambiguous", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    t.recordInbound("peerA", "tok-2");
    expect(t.resolveOutbound("peerA", "tok-2")).toBe("tok-2");
  });

  test("explicit in_reply_to wins even with nothing outstanding", () => {
    const t = new CorrelationTracker();
    expect(t.resolveOutbound("peerA", "tok-x")).toBe("tok-x");
  });

  test("resolving clears the peer's outstanding set (agent has replied)", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    expect(t.resolveOutbound("peerA")).toBe("tok-1");
    // Second send with nothing new recorded → no echo.
    expect(t.resolveOutbound("peerA")).toBeUndefined();
  });

  test("clearing on send lets precision recover after an ambiguous burst", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    t.recordInbound("peerA", "tok-2");
    expect(t.resolveOutbound("peerA")).toBeUndefined(); // ambiguous → omit + clear
    t.recordInbound("peerA", "tok-3");
    expect(t.resolveOutbound("peerA")).toBe("tok-3"); // single again → echo
  });

  test("outstanding sets are isolated per peer", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-A");
    t.recordInbound("peerB", "tok-B");
    // Sending to A must not disturb B's outstanding token.
    expect(t.resolveOutbound("peerA")).toBe("tok-A");
    expect(t.resolveOutbound("peerB")).toBe("tok-B");
  });

  test("duplicate inbound token counts once", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    t.recordInbound("peerA", "tok-1");
    expect(t.outstandingCount("peerA")).toBe(1);
    expect(t.resolveOutbound("peerA")).toBe("tok-1");
  });

  test("absent / empty inbound tokens are not tracked", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", undefined);
    t.recordInbound("peerA", null);
    t.recordInbound("peerA", "");
    expect(t.outstandingCount("peerA")).toBe(0);
    expect(t.resolveOutbound("peerA")).toBeUndefined();
  });

  test("empty explicit in_reply_to falls through to auto-echo", () => {
    const t = new CorrelationTracker();
    t.recordInbound("peerA", "tok-1");
    expect(t.resolveOutbound("peerA", "")).toBe("tok-1");
  });
});
