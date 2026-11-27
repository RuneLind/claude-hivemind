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
