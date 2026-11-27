/**
 * Which sessions belong to one OpenCode 2.x plugin instance.
 *
 * OpenCode 2.x runs one plugin instance per directory (`ctx.location`) inside
 * one server process, and each instance registers its own hivemind peer. An
 * instance answers only for sessions whose `location.directory` is its own:
 * a session from another directory must not move its target, reach its inbox
 * or use its peer's tools.
 */

import { realpathSync } from "node:fs";

/** How long an ownership lookup may take before the session is treated as foreign. */
const LOOKUP_MS = 3_000;

export interface SessionLookup {
  get(input: { sessionID: string }): Promise<{ location?: { directory?: string } }>;
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
  private lookups = new Map<string, Promise<boolean>>();

  constructor(
    directory: string,
    private session: SessionLookup,
    private log: (m: string) => void = () => {},
    private lookupMs = LOOKUP_MS,
  ) {
    this.directory = canonical(directory);
  }

  matches(directory: string | undefined): boolean {
    return directory !== undefined && canonical(directory) === this.directory;
  }

  /** Record a session whose directory an event reported. */
  note(sessionID: string, directory: string | undefined): boolean {
    const mine = this.matches(directory);
    this.owned.set(sessionID, mine);
    return mine;
  }

  /** Known to be this instance's, without a lookup. */
  knownOwned(sessionID: string): boolean {
    return this.owned.get(sessionID) === true;
  }

  forget(sessionID: string): void {
    this.owned.delete(sessionID);
  }

  /** Whether the session is in this instance's directory; looked up once, then cached. */
  async owns(sessionID: string): Promise<boolean> {
    const known = this.owned.get(sessionID);
    if (known !== undefined) return known;
    let lookup = this.lookups.get(sessionID);
    if (!lookup) {
      lookup = this.lookup(sessionID).finally(() => this.lookups.delete(sessionID));
      this.lookups.set(sessionID, lookup);
    }
    return lookup;
  }

  private async lookup(sessionID: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), this.lookupMs)));
    try {
      const res = await Promise.race([this.session.get({ sessionID }), timeout]);
      // A timed-out lookup is not cached: the next hook asks again.
      if (res === "timeout") {
        this.log(`session.get ${sessionID} timed out; treated as another directory's`);
        return false;
      }
      return this.note(sessionID, res.location?.directory);
    } catch (e) {
      this.log(`session.get ${sessionID} failed: ${e}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
