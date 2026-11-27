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
