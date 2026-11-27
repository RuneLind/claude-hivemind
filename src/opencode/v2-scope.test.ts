import { describe, test, expect } from "bun:test";
import { DirectoryScope } from "./v2-scope.ts";

describe("DirectoryScope.isRoot", () => {
  test("H3: answers from the parent the ownership lookup fetched, without a second lookup", async () => {
    let gets = 0;
    const scope = new DirectoryScope("/tmp", {
      get: async () => (gets++, { parentID: "ses_root", location: { directory: "/tmp" } }),
    });
    expect(await scope.owns("ses_child")).toBe(true);
    expect(await scope.isRoot("ses_child")).toBe(false);
    expect(gets).toBe(1);
  });

  test("H3: a parent unknown after session.moved is looked up; a timed-out lookup answers not-root and is asked again", async () => {
    let hang = true;
    let gets = 0;
    const scope = new DirectoryScope(
      "/tmp",
      {
        get: (async () => {
          gets++;
          if (hang) await new Promise(() => {});
          return { location: { directory: "/tmp" } };
        }) as any,
      },
      () => {},
      30,
    );
    // session.moved carries no parent.
    scope.note("ses_x", "/tmp");
    expect(await scope.isRoot("ses_x")).toBe(false);
    hang = false;
    expect(await scope.isRoot("ses_x")).toBe(true);
    expect(gets).toBe(2);
  });

  test("H1: a moved session's ownership follows session.moved's directory; its recorded parent is kept", async () => {
    const scope = new DirectoryScope("/tmp", {
      get: async () => ({ parentID: "ses_root", location: { directory: "/tmp" } }),
    });
    expect(await scope.owns("ses_c")).toBe(true);
    scope.note("ses_c", "/elsewhere");
    expect(await scope.owns("ses_c")).toBe(false);
    expect(scope.knownOwned("ses_c")).toBe(false);
    scope.note("ses_c", "/tmp");
    expect(await scope.isRoot("ses_c")).toBe(false);
  });
});

/** A session.get that waits for release() before it answers. */
function gatedLookup(answer: { parentID?: string; location: { directory: string } }) {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let gets = 0;
  return {
    session: { get: async () => (gets++, await gate, answer) },
    release: () => release(),
    gets: () => gets,
  };
}

describe("DirectoryScope: a lookup does not overwrite a newer event", () => {
  test("F3: an ownership lookup in flight when session.moved arrives leaves the move in place", async () => {
    const l = gatedLookup({ location: { directory: "/tmp" } });
    const scope = new DirectoryScope("/tmp", l.session);
    const owns = scope.owns("ses_x");
    scope.note("ses_x", "/elsewhere");
    l.release();
    expect(await owns).toBe(false);
    expect(scope.knownOwned("ses_x")).toBe(false);
    expect(await scope.owns("ses_x")).toBe(false);
    expect(l.gets()).toBe(1);
  });

  test("F3: an isRoot lookup in flight when session.moved arrives leaves the move in place, and still records the parent", async () => {
    const l = gatedLookup({ location: { directory: "/tmp" } });
    const scope = new DirectoryScope("/tmp", l.session);
    const root = scope.isRoot("ses_x");
    scope.note("ses_x", "/elsewhere");
    l.release();
    expect(await root).toBe(true);
    expect(scope.knownOwned("ses_x")).toBe(false);
  });

  test("F3: a lookup in flight when session.deleted arrives records nothing", async () => {
    const l = gatedLookup({ location: { directory: "/tmp" } });
    const scope = new DirectoryScope("/tmp", l.session);
    const owns = scope.owns("ses_x");
    scope.forget("ses_x");
    l.release();
    expect(await owns).toBe(false);
    expect(scope.knownOwned("ses_x")).toBe(false);
  });
});

describe("DirectoryScope: caching", () => {
  test("ownership is looked up once and then answered from the cache", async () => {
    let gets = 0;
    const scope = new DirectoryScope("/tmp", { get: async () => (gets++, { location: { directory: "/tmp" } }) });
    expect(await scope.owns("ses_a")).toBe(true);
    expect(await scope.owns("ses_a")).toBe(true);
    expect(gets).toBe(1);
  });

  test("a session.moved without a parent keeps the parent recorded earlier", async () => {
    let gets = 0;
    const scope = new DirectoryScope("/tmp", { get: async () => (gets++, { location: { directory: "/tmp" } }) });
    scope.note("ses_r", "/tmp", null);
    scope.note("ses_r", "/elsewhere");
    scope.note("ses_r", "/tmp");
    expect(await scope.isRoot("ses_r")).toBe(true);
    expect(gets).toBe(0);
  });
});

describe("DirectoryScope.confirm / holds / unconfirm", () => {
  function gated(directory: () => string) {
    let open!: () => void;
    let gate: Promise<void> | null = null;
    let gets = 0;
    return {
      get gets() {
        return gets;
      },
      close() {
        gate = new Promise<void>((r) => (open = r));
      },
      open: () => open(),
      session: {
        get: async () => {
          gets++;
          if (gate) await gate;
          return { location: { directory: directory() } };
        },
      },
    };
  }

  test("A1: confirm asks the server even when the cache says owned", async () => {
    let dir = "/tmp";
    const g = gated(() => dir);
    const scope = new DirectoryScope("/tmp", g.session);
    expect(await scope.owns("s")).toBe(true);
    dir = "/elsewhere";
    expect(await scope.confirm("s")).toBeNull();
    expect(g.gets).toBe(2);
    expect(scope.knownOwned("s")).toBe(false);
  });

  test("A1: holds fails once an event or unconfirm touches the session after confirm", async () => {
    const scope = new DirectoryScope("/tmp", gated(() => "/tmp").session);
    const t1 = (await scope.confirm("s"))!;
    expect(t1).not.toBeNull();
    expect(scope.holds("s", t1)).toBe(true);
    scope.note("s", "/tmp"); // even a move that keeps it here voids the token
    expect(scope.holds("s", t1)).toBe(false);
    const t2 = (await scope.confirm("s"))!;
    scope.unconfirm();
    expect(scope.holds("s", t2)).toBe(false);
  });

  test("R2-2: a lookup in flight across unconfirm discards its answer and asks again: a still-owned session stays owned", async () => {
    const g = gated(() => "/tmp");
    const scope = new DirectoryScope("/tmp", g.session);
    g.close();
    const p = scope.owns("s");
    await Promise.resolve();
    scope.unconfirm();
    g.open();
    expect(await p).toBe(true);
    expect(g.gets).toBe(2);
    expect(scope.knownOwned("s")).toBe(true);
  });

  test("R2-1: a confirm in flight across unconfirm still returns a token that holds when the session is still owned", async () => {
    const g = gated(() => "/tmp");
    const scope = new DirectoryScope("/tmp", g.session);
    g.close();
    const p = scope.confirm("s");
    await Promise.resolve();
    scope.unconfirm();
    g.open();
    const token = await p;
    expect(token).not.toBeNull();
    expect(scope.holds("s", token!)).toBe(true);
  });

  test("R2: the second ask is bounded too: a lookup that hangs after unconfirm answers not-owned within lookupMs", async () => {
    let calls = 0;
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const scope = new DirectoryScope(
      "/tmp",
      {
        get: (async () => {
          if (++calls === 1) await first;
          else await new Promise(() => {});
          return { location: { directory: "/tmp" } };
        }) as any,
      },
      () => {},
      30,
    );
    const p = scope.owns("s");
    await Promise.resolve();
    scope.unconfirm();
    release();
    const started = Date.now();
    expect(await p).toBe(false);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("A1: a session deleted while confirm runs is not recorded as owned", async () => {
    const g = gated(() => "/tmp");
    const scope = new DirectoryScope("/tmp", g.session);
    g.close();
    const p = scope.confirm("s");
    await Promise.resolve();
    scope.forget("s");
    g.open();
    expect(await p).toBeNull();
    expect(scope.knownOwned("s")).toBe(false);
  });
});

describe("DirectoryScope: bounded memory", () => {
  const sizes = (scope: DirectoryScope) => {
    const s = scope as any;
    return { owned: s.owned.size, parents: s.parents.size, epochs: s.epochs.size, lookups: s.lookups.size, inflight: s.inflight.size };
  };

  test("noting 10,000 sessions keeps each per-session map at 1,000 or fewer; the newest stay known", () => {
    const scope = new DirectoryScope("/tmp", { get: async () => ({ location: { directory: "/tmp" } }) });
    for (let i = 0; i < 10_000; i++) scope.note(`ses_${i}`, i % 2 ? "/tmp" : "/elsewhere", null);
    const n = sizes(scope);
    expect(Math.max(n.owned, n.parents, n.epochs)).toBeLessThanOrEqual(1_000);
    expect(n.lookups + n.inflight).toBe(0);
    expect(scope.knownOwned("ses_9999")).toBe(true);
  });

  test("F3 kept: a session with a lookup in flight is never dropped, so a move during the lookup still wins", async () => {
    const l = gatedLookup({ location: { directory: "/tmp" } });
    const scope = new DirectoryScope("/tmp", l.session);
    const owns = scope.owns("ses_x");
    scope.note("ses_x", "/elsewhere");
    for (let i = 0; i < 10_000; i++) scope.note(`ses_${i}`, "/elsewhere");
    expect(sizes(scope).epochs).toBeLessThanOrEqual(1_000);
    l.release();
    expect(await owns).toBe(false);
    expect(scope.knownOwned("ses_x")).toBe(false);
  });

  test("a token taken before a session was dropped does not hold after the session is noted again", async () => {
    const scope = new DirectoryScope("/tmp", { get: async () => ({ location: { directory: "/tmp" } }) });
    const token = await scope.confirm("ses_x");
    expect(token).not.toBeNull();
    for (let i = 0; i < 10_000; i++) scope.note(`ses_${i}`, "/elsewhere");
    expect(sizes(scope).epochs).toBeLessThanOrEqual(1_000);
    scope.note("ses_x", "/tmp");
    expect(scope.holds("ses_x", token!)).toBe(false);
  });
});

/**
 * One session.get per call, each answering only when its own ask is released.
 * The directory is read when the ask is made, so a straddled ask carries the
 * answer the server gave before the change.
 */
function scripted(directory: () => string, parentID: string | null = null) {
  const asks: { release: () => void; fail: (e: unknown) => void; directory: string }[] = [];
  return {
    asks,
    session: {
      get: () =>
        new Promise<any>((resolve, reject) => {
          const d = directory();
          asks.push({
            release: () => resolve({ ...(parentID ? { parentID } : {}), location: { directory: d } }),
            fail: reject,
            directory: d,
          });
        }),
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const internals = (scope: DirectoryScope) => scope as any;

describe("DirectoryScope.lookup: one deadline, re-ask on unconfirm, epoch fixed at the start (class check)", () => {
  for (const n of [0, 1, 2, 3]) {
    for (const via of ["owns", "confirm"] as const) {
      test(`K${n}-${via}: ${n} unconfirm() bumps, each straddling one ask: an owned session stays owned through ${via}()`, async () => {
        const s = scripted(() => "/tmp");
        const scope = new DirectoryScope("/tmp", s.session, () => {}, 1_000);
        const p = via === "owns" ? scope.owns("s") : scope.confirm("s");
        for (let i = 0; i < n; i++) {
          await tick();
          scope.unconfirm();
          s.asks[i]?.release();
        }
        await tick();
        s.asks[n]?.release();
        const r = await p;
        if (via === "owns") expect(r).toBe(true);
        else expect(scope.holds("s", r as string)).toBe(true);
        expect(s.asks).toHaveLength(n + 1);
        expect(scope.knownOwned("s")).toBe(true);
        expect(internals(scope).inflight.size).toBe(0);
      });
    }
  }

  test("K-moved: a session moved (no event) while an ask straddled unconfirm is not owned: the second ask is made and sees the move", async () => {
    let dir = "/tmp";
    const s = scripted(() => dir);
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("s");
    await tick();
    scope.unconfirm();
    dir = "/elsewhere";
    s.asks[0]!.release();
    await tick();
    s.asks[1]?.release();
    expect(await owns).toBe(false);
    expect(s.asks.map((a) => a.directory)).toEqual(["/tmp", "/elsewhere"]);
    // Cached as known not-owned: the second answer straddled nothing.
    expect(internals(scope).owned.get("s")).toBe(false);
  });

  for (const n of [0, 1]) {
    test(`K-failed-${n}: a failed ask after ${n} bumps answers not-owned and caches nothing; the next hook asks again`, async () => {
      const s = scripted(() => "/tmp");
      const scope = new DirectoryScope("/tmp", s.session);
      const owns = scope.owns("s");
      for (let i = 0; i < n; i++) {
        await tick();
        scope.unconfirm();
        s.asks[i]!.release();
      }
      await tick();
      s.asks[n]!.fail(new Error("404"));
      expect(await owns).toBe(false);
      expect(internals(scope).owned.has("s")).toBe(false);
      const again = scope.owns("s");
      await tick();
      s.asks[n + 1]!.release();
      expect(await again).toBe(true);
    });
  }

  test("K-hang: a hung ask answers not-owned at the deadline and caches nothing", async () => {
    const scope = new DirectoryScope("/tmp", { get: () => new Promise(() => {}) as any }, () => {}, 50);
    const started = Date.now();
    expect(await scope.owns("s")).toBe(false);
    expect(Date.now() - started).toBeLessThan(150);
    expect(internals(scope).owned.has("s")).toBe(false);
    expect(internals(scope).inflight.size).toBe(0);
  });

  test("K-storm: bumps that keep straddling every ask past the deadline answer not-owned at the deadline, re-asking until then, caching nothing", async () => {
    let asks = 0;
    const scope = new DirectoryScope(
      "/tmp",
      { get: async () => (asks++, await Bun.sleep(20), { parentID: undefined, location: { directory: "/tmp" } }) },
      () => {},
      100,
    );
    const storm = setInterval(() => scope.unconfirm(), 5);
    const started = Date.now();
    try {
      expect(await scope.owns("s")).toBe(false);
    } finally {
      clearInterval(storm);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(300);
    expect(asks).toBeGreaterThan(2);
    expect(internals(scope).owned.has("s")).toBe(false);
    expect(internals(scope).parents.has("s")).toBe(false);
    expect(internals(scope).inflight.size).toBe(0);
  });

  test("K-total: the deadline is total, not per ask: a straddled first ask that took most of it leaves only the rest for the second", async () => {
    let calls = 0;
    const scope = new DirectoryScope(
      "/tmp",
      {
        get: (async () => {
          if (++calls === 1) {
            await Bun.sleep(140);
            return { location: { directory: "/tmp" } };
          }
          return new Promise(() => {});
        }) as any,
      },
      () => {},
      200,
    );
    const started = Date.now();
    const p = scope.owns("s");
    await Bun.sleep(10);
    scope.unconfirm();
    expect(await p).toBe(false);
    const elapsed = Date.now() - started;
    expect(calls).toBe(2);
    // Per-ask bounds would answer at ~340 ms (140 + 200).
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(300);
  });

  test("K-straddled: a straddled answer is never cached, neither its ownership nor its parent", async () => {
    const s = scripted(() => "/tmp", null);
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("s");
    await tick();
    scope.unconfirm();
    s.asks[0]!.release();
    await tick();
    s.asks[1]!.fail(new Error("down"));
    expect(await owns).toBe(false);
    expect(internals(scope).owned.has("s")).toBe(false);
    expect(internals(scope).parents.has("s")).toBe(false);
  });

  for (const via of ["owns", "confirm"] as const) {
    test(`K-deleted-${via}: forget() and unconfirm() during the first ask, with the server still answering the session: not owned, nothing cached`, async () => {
      const s = scripted(() => "/tmp");
      const scope = new DirectoryScope("/tmp", s.session);
      const p = via === "owns" ? scope.owns("s") : scope.confirm("s");
      await tick();
      scope.forget("s");
      scope.unconfirm();
      s.asks[0]!.release();
      await tick();
      s.asks[1]?.release();
      expect(await p).toBe(via === "owns" ? false : null);
      expect(internals(scope).owned.has("s")).toBe(false);
      expect(internals(scope).parents.has("s")).toBe(false);
    });
  }

  test("K-away-later: a note() move away during a later ask (after a bump) answers not-owned", async () => {
    const s = scripted(() => "/tmp");
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("s");
    await tick();
    scope.unconfirm();
    s.asks[0]!.release();
    await tick();
    expect(s.asks).toHaveLength(2);
    scope.note("s", "/elsewhere");
    s.asks[1]!.release();
    expect(await owns).toBe(false);
    expect(scope.knownOwned("s")).toBe(false);
    expect(internals(scope).owned.get("s")).toBe(false);
  });

  for (const n of [0, 1]) {
    test(`K-here-${n}: a note() move here during an ask (after ${n} bumps) wins over the stale not-owned answer`, async () => {
      const s = scripted(() => "/elsewhere");
      const scope = new DirectoryScope("/tmp", s.session);
      const owns = scope.owns("s");
      for (let i = 0; i < n; i++) {
        await tick();
        scope.unconfirm();
        s.asks[i]!.release();
      }
      await tick();
      scope.note("s", "/tmp");
      s.asks[n]!.release();
      expect(await owns).toBe(true);
      expect(scope.knownOwned("s")).toBe(true);
    });
  }

  test("K-here-then-unconfirm: a move here followed by unconfirm() during the ask answers not-owned and caches nothing", async () => {
    const s = scripted(() => "/tmp");
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("s");
    await tick();
    scope.note("s", "/tmp");
    scope.unconfirm();
    s.asks[0]!.release();
    await tick();
    s.asks[1]?.release();
    expect(await owns).toBe(false);
    expect(internals(scope).owned.has("s")).toBe(false);
  });

  for (const outcome of ["hang", "fail"] as const) {
    for (const change of ["here", "deleted"] as const) {
      test(`K-${outcome}-${change}: ${change === "here" ? "a move here" : "a delete"} during a ${outcome === "hang" ? "hung" : "failed"} ask decides the answer`, async () => {
        let fail!: (e: unknown) => void;
        const scope = new DirectoryScope(
          "/tmp",
          { get: () => new Promise<any>((_, rej) => (fail = rej)) },
          () => {},
          50,
        );
        const owns = scope.owns("s");
        await tick();
        if (change === "here") scope.note("s", "/tmp");
        else scope.forget("s");
        if (outcome === "fail") fail(new Error("down"));
        expect(await owns).toBe(change === "here");
        expect(scope.knownOwned("s")).toBe(change === "here");
      });
    }
  }

  test("K-evict: a session is kept through every ask of its lookup, so a move during a later ask survives 10,000 newer notes", async () => {
    const s = scripted(() => "/tmp");
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("ses_x");
    await tick();
    scope.unconfirm();
    s.asks[0]!.release();
    await tick();
    scope.note("ses_x", "/elsewhere");
    for (let i = 0; i < 10_000; i++) scope.note(`ses_${i}`, "/elsewhere");
    expect(internals(scope).epochs.size).toBeLessThanOrEqual(1_000);
    s.asks[1]!.release();
    expect(await owns).toBe(false);
    expect(scope.knownOwned("ses_x")).toBe(false);
    expect(internals(scope).inflight.size).toBe(0);
  });

  test("K-dedupe: owns() and isRoot() share one lookup chain across a bump", async () => {
    const s = scripted(() => "/tmp", null);
    const scope = new DirectoryScope("/tmp", s.session);
    const owns = scope.owns("s");
    const root = scope.isRoot("s");
    await tick();
    scope.unconfirm();
    s.asks[0]!.release();
    await tick();
    s.asks[1]!.release();
    expect(await owns).toBe(true);
    expect(await root).toBe(true);
    expect(s.asks).toHaveLength(2);
  });
});
