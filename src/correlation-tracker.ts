/**
 * Per-peer tracking of inbound correlation tokens for the MCP server's reply
 * auto-echo (`server.ts`).
 *
 * The broker round-trips an opaque `correlation_id` (see `broker/CLAUDE.md`),
 * but a reply only correlates if the replying agent echoes the inbound token
 * back. A raw Claude Code / OpenCode agent won't reliably hand-copy it, so the
 * MCP server echoes automatically — but only when it's unambiguous.
 *
 * The decision logic lives here (pure, no I/O) so it can be unit-tested apart
 * from the stdio MCP server's global state. The rule:
 *
 *   - An explicit `in_reply_to` always wins.
 *   - Otherwise auto-echo the inbound token ONLY when exactly one is in flight
 *     for that peer. With zero or two-plus outstanding, omit it — the reply is
 *     ambiguous, so the consumer should miss its token store and fall back to
 *     coarse `(bot, peer)` correlation rather than confidently misrouting.
 *   - Sending to a peer clears its outstanding set: the agent has now replied,
 *     so later inbound from that peer is fresh context. This also lets the
 *     system recover precision after an ambiguous burst (a new single inbound
 *     becomes unambiguous again).
 *
 * Empty-string tokens are treated as absent (never tracked, never echoed) —
 * the broker is an opaque pass-through, but a meaningful token is non-empty.
 */
export class CorrelationTracker {
  private outstanding = new Map<string, Set<string>>();

  /** Record an inbound token from `fromId`. No-op for empty/absent tokens. */
  recordInbound(fromId: string, correlationId: string | null | undefined): void {
    if (!correlationId) return;
    let set = this.outstanding.get(fromId);
    if (!set) this.outstanding.set(fromId, (set = new Set()));
    set.add(correlationId);
  }

  /**
   * Decide the `correlation_id` to attach to an outbound to `toId`, then clear
   * that peer's outstanding set. Returns `undefined` to omit the field.
   */
  resolveOutbound(toId: string, inReplyTo?: string | null): string | undefined {
    const set = this.outstanding.get(toId);
    const auto = set && set.size === 1 ? [...set][0] : undefined;
    this.outstanding.delete(toId);
    // `|| undefined` so an empty explicit value falls through to auto/omit.
    return (inReplyTo || undefined) ?? auto;
  }

  /** Number of distinct inbound tokens currently in flight for `fromId`. */
  outstandingCount(fromId: string): number {
    return this.outstanding.get(fromId)?.size ?? 0;
  }
}
