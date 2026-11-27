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
 * stream may have missed events, `unconfirm()` drops every cached answer.
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
   * in flight discards its answer and asks once more.
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

  private async lookup(sessionID: string, retry = true): Promise<boolean> {
    const epoch = this.epochs.get(sessionID) ?? 0;
    const generation = this.generation;
    this.inflight.set(sessionID, (this.inflight.get(sessionID) ?? 0) + 1);
    try {
      const res = await withTimeout(this.session.get({ sessionID }), this.lookupMs);
      // A timed-out lookup is not cached: the next hook asks again.
      if (res === "timeout") {
        this.log(`session.get ${sessionID} timed out; treated as another directory's`);
        return false;
      }
      // unconfirm() ran meanwhile, so the answer may predate a missed move.
      // That voids the answer, not the ownership: ask once more, within the
      // same bound, rather than read a reconnect as "not ours".
      if (this.generation !== generation) return retry ? this.lookup(sessionID, false) : false;
      // A session.moved (or deleted) that arrived meanwhile is newer than this
      // answer: keep its ownership. The parent still holds, as a move keeps it.
      if ((this.epochs.get(sessionID) ?? 0) !== epoch) {
        if (this.owned.has(sessionID) && !this.parents.has(sessionID)) this.parents.set(sessionID, res.parentID ?? null);
        return this.knownOwned(sessionID);
      }
      return this.note(sessionID, res.location?.directory, res.parentID ?? null);
    } catch (e) {
      this.log(`session.get ${sessionID} failed: ${e}`);
      return false;
    } finally {
      const n = (this.inflight.get(sessionID) ?? 1) - 1;
      if (n > 0) this.inflight.set(sessionID, n);
      else this.inflight.delete(sessionID);
    }
  }
}
