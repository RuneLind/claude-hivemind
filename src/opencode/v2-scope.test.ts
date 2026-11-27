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

  test("A2: a lookup in flight across unconfirm answers not-owned and caches nothing", async () => {
    const g = gated(() => "/tmp");
    const scope = new DirectoryScope("/tmp", g.session);
    g.close();
    const p = scope.owns("s");
    await Promise.resolve();
    scope.unconfirm();
    g.open();
    expect(await p).toBe(false);
    expect(scope.knownOwned("s")).toBe(false);
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
