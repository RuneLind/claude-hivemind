/**
 * Which sessions belong to one OpenCode 2.x plugin instance.
 *
 * OpenCode 2.x runs one plugin instance per directory (`ctx.location`) inside
 * one server process, and each instance registers its own hivemind peer. An
 * instance answers only for sessions whose `location.directory` is its own:
 * a session from another directory must not move its target, reach its inbox
 * or use its peer's tools.
 *
 * Ownership is cached per session until `session.deleted`, or until
 * `session.moved` reports the session's new directory. The lookup also
 * records each session's parent, which a move does not change. When the event
 * stream may have missed events, `unconfirm()` drops every cached answer,
 * and a lookup in flight across it asks again (see lookup()).
 *
 * Delivery does not trust the cache: `confirm()` asks the server afresh, and
 * `holds()` tells, synchronously and right before a message is sent, whether
 * any event or `unconfirm()` has touched the session since.
 */

import { realpathSync } from "node:fs";

/** How long an ownership lookup may take before the session is treated as foreign. */
export const LOOKUP_MS = 3_000;

/**
 * Sessions whose ownership, parent and epoch are remembered. Past it the least
 * recently noted session without a lookup in flight is dropped; its next hook
 * looks it up again.
 */
export const MAX_SESSIONS = 1_000;

/** Resolves to "timeout" if `p` has not settled within `ms`. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SessionLookup {
  get(input: { sessionID: string }): Promise<{ parentID?: string; location?: { directory?: string } }>;
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export class DirectoryScope {
  readonly directory: string;
  private owned = new Map<string, boolean>();
  /** Parent session id, or null for a root session. */
  private parents = new Map<string, string | null>();
  private lookups = new Map<string, Promise<boolean>>();
  /** session.get calls in flight per session, deduped or not. */
  private inflight = new Map<string, number>();
  /**
   * Set by note(), and by forget() during a lookup: a lookup that started before
   * either does not overwrite it. Drawn from one counter, so a session dropped
   * past MAX_SESSIONS and noted again never repeats an epoch a token holds.
   * Key order is least recently noted first.
   */
  private epochs = new Map<string, number>();
  private epochSeq = 0;
  /** Bumped by unconfirm(): every answer obtained before it is stale. */
  private generation = 0;

  constructor(
    directory: string,
    private session: SessionLookup,
    private log: (m: string) => void = () => {},
    private lookupMs = LOOKUP_MS,
    private maxSessions = MAX_SESSIONS,
  ) {
    this.directory = canonical(directory);
  }

  matches(directory: string | undefined): boolean {
    return directory !== undefined && canonical(directory) === this.directory;
  }

  /**
   * Record a session whose directory an event or lookup reported, and its
   * parent when the source carries one (`session.moved` does not).
   */
  note(sessionID: string, directory: string | undefined, parentID?: string | null): boolean {
    this.epochs.delete(sessionID);
    this.epochs.set(sessionID, ++this.epochSeq);
    const mine = this.matches(directory);
    this.owned.set(sessionID, mine);
    if (parentID !== undefined) this.parents.set(sessionID, parentID);
    this.evict();
    return mine;
  }

  /**
   * Drop the least recently noted sessions past maxSessions. A session with a
   * lookup in flight is kept: its epoch is what stops that lookup from undoing
   * a newer move or delete. Every owned/parents key has an epoch entry.
   */
  private evict(): void {
    for (const id of this.epochs.keys()) {
      if (this.epochs.size <= this.maxSessions) return;
      if (this.inflight.has(id)) continue;
      this.epochs.delete(id);
      this.owned.delete(id);
      this.parents.delete(id);
    }
  }

  /** Known to be this instance's, without a lookup. */
  knownOwned(sessionID: string): boolean {
    return this.owned.get(sessionID) === true;
  }

  forget(sessionID: string): void {
    // Only a lookup in flight needs to see that the session changed.
    if (this.inflight.has(sessionID)) this.epochs.set(sessionID, ++this.epochSeq);
    else this.epochs.delete(sessionID);
    this.owned.delete(sessionID);
    this.parents.delete(sessionID);
  }

  /**
   * Whether the session is a root session (no parent). Answered from what an
   * event or the ownership lookup recorded; otherwise looked up, within the
   * same bound. A failed or timed-out lookup answers false, so a caller that
   * adds something to root sessions only adds nothing.
   */
  async isRoot(sessionID: string): Promise<boolean> {
    if (!this.parents.has(sessionID)) await this.lookupDeduped(sessionID);
    return this.parents.get(sessionID) === null;
  }

  /** Whether the session is in this instance's directory; looked up once, then cached. */
  async owns(sessionID: string): Promise<boolean> {
    const known = this.owned.get(sessionID);
    if (known !== undefined) return known;
    return this.lookupDeduped(sessionID);
  }

  /**
   * Drop every cached ownership answer (the event stream may have missed a
   * move or delete), so the next owns() looks each session up again. A lookup
   * in flight discards the answer it is waiting for and asks again within its
   * deadline (see lookup()).
   */
  unconfirm(): void {
    this.generation++;
    this.owned.clear();
  }

  /**
   * Ask the server afresh, bypassing the cache, whether the session is this
   * instance's. Resolves to a token for holds() when it is, else null.
   */
  async confirm(sessionID: string): Promise<string | null> {
    const mine = await this.lookup(sessionID);
    return mine && this.knownOwned(sessionID) ? this.token(sessionID) : null;
  }

  /** True while the session is owned and nothing has changed its ownership since confirm() returned the token. */
  holds(sessionID: string, token: string): boolean {
    return this.knownOwned(sessionID) && this.token(sessionID) === token;
  }

  private token(sessionID: string): string {
    return `${this.generation}:${this.epochs.get(sessionID) ?? 0}`;
  }

  private lookupDeduped(sessionID: string): Promise<boolean> {
    let lookup = this.lookups.get(sessionID);
    if (!lookup) {
      lookup = this.lookup(sessionID).finally(() => this.lookups.delete(sessionID));
      this.lookups.set(sessionID, lookup);
    }
    return lookup;
  }

  /**
   * Ask the server whether the session is this instance's, under one rule:
   *
   * - One total deadline, `lookupMs` from the start, across every ask.
   * - An answer is final only if no `unconfirm()` ran while its ask was out.
   *   A straddled answer may predate a missed move: it is discarded, never
   *   cached, and the server is asked again while the deadline allows. A
   *   reconnect bumps the generation 2-3 times, so one retry is not enough.
   * - The epoch is read once, at the start. If note() or forget() changed it
   *   (a newer move or delete), the lookup returns what that newer state
   *   records, whatever the ask returned, and caches nothing over it (F3).
   * - Past the deadline, or when the ask fails, it answers not-owned and
   *   caches nothing: the next hook asks again.
   */
  private async lookup(sessionID: string): Promise<boolean> {
    const epoch = this.epochs.get(sessionID) ?? 0;
    const deadline = Date.now() + this.lookupMs;
    const newer = () => (this.epochs.get(sessionID) ?? 0) !== epoch;
    this.inflight.set(sessionID, (this.inflight.get(sessionID) ?? 0) + 1);
    try {
      for (;;) {
        const generation = this.generation;
        let res: Awaited<ReturnType<SessionLookup["get"]>> | "timeout" | "failed";
        try {
          res = await withTimeout(this.session.get({ sessionID }), Math.max(0, deadline - Date.now()));
        } catch (e) {
          this.log(`session.get ${sessionID} failed: ${e}`);
          res = "failed";
        }
        if (newer()) {
          // The parent still holds, as a move keeps it; only an answer no
          // unconfirm() straddled records it.
          if (typeof res === "object" && this.generation === generation && this.owned.has(sessionID) && !this.parents.has(sessionID)) {
            this.parents.set(sessionID, res.parentID ?? null);
          }
          return this.knownOwned(sessionID);
        }
        if (res === "failed") return false;
        if (res === "timeout") {
          this.log(`session.get ${sessionID} timed out; treated as another directory's`);
          return false;
        }
        if (this.generation === generation) return this.note(sessionID, res.location?.directory, res.parentID ?? null);
        if (Date.now() >= deadline) {
          this.log(`session.get ${sessionID} kept straddling unconfirm() past ${this.lookupMs} ms; treated as another directory's`);
          return false;
        }
      }
    } finally {
      const n = (this.inflight.get(sessionID) ?? 1) - 1;
      if (n > 0) this.inflight.set(sessionID, n);
      else this.inflight.delete(sessionID);
    }
  }
}
