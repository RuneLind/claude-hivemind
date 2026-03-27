import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveNamespace } from "./namespace.ts";
import type { NamespaceConfig } from "./types.ts";

describe("resolveNamespace", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = "/home/testuser";
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  // --- Explicit config rule matching ---

  describe("explicit config rules", () => {
    test("matches a single rule by path prefix", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "work", path_prefix: "/projects/work" }],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/work/repo-a", config)).toBe("work");
    });

    test("longest prefix wins when multiple rules match", () => {
      const config: NamespaceConfig = {
        rules: [
          { name: "broad", path_prefix: "/projects" },
          { name: "specific", path_prefix: "/projects/work" },
          { name: "most-specific", path_prefix: "/projects/work/team-a" },
        ],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/work/team-a/repo", config)).toBe(
        "most-specific"
      );
    });

    test("matches shorter prefix when longer does not match", () => {
      const config: NamespaceConfig = {
        rules: [
          { name: "broad", path_prefix: "/projects" },
          { name: "specific", path_prefix: "/projects/work" },
        ],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/personal/repo", config)).toBe(
        "broad"
      );
    });

    test("rule with trailing slash on path_prefix still matches", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "slashed", path_prefix: "/projects/work/" }],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/work/repo", config)).toBe("slashed");
    });

    test("rule without trailing slash still matches paths under it", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "noslash", path_prefix: "/projects/work" }],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/work/deep/nested/path", config)).toBe(
        "noslash"
      );
    });

    test("exact path match (cwd equals path_prefix without trailing slash)", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "exact", path_prefix: "/projects/work" }],
        default_namespace: "default",
      };
      // cwd === rule.path_prefix (the `cwd === rule.path_prefix` branch)
      expect(resolveNamespace("/projects/work", config)).toBe("exact");
    });

    test("no rules match falls through to auto-derive", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "unrelated", path_prefix: "/other/path" }],
        default_namespace: "custom-default",
      };
      // This cwd matches auto-derive pattern ~/source/<group>/
      expect(
        resolveNamespace("/home/testuser/source/mygroup/repo", config)
      ).toBe("mygroup");
    });
  });

  // --- Auto-derive from ~/source/<group>/ ---

  describe("auto-derive from ~/source/<group>/", () => {
    test("derives namespace from ~/source/<group>/repo", () => {
      expect(resolveNamespace("/home/testuser/source/private/my-repo", null)).toBe(
        "private"
      );
    });

    test("derives namespace from ~/source/<group>/repo/subdir", () => {
      expect(
        resolveNamespace("/home/testuser/source/work/repo/src/deep", null)
      ).toBe("work");
    });

    test("derives group even with just ~/source/<group>/ (trailing content)", () => {
      expect(
        resolveNamespace("/home/testuser/source/experiments/foo", null)
      ).toBe("experiments");
    });

    test("does not derive when cwd is exactly ~/source/ (no group dir)", () => {
      // rest = "" -> split("/")[0] = "" -> falsy, falls through
      expect(resolveNamespace("/home/testuser/source/", null)).toBe("default");
    });

    test("does not derive when cwd is ~/source with no trailing slash", () => {
      // Does not start with ~/source/ so no match
      expect(resolveNamespace("/home/testuser/source", null)).toBe("default");
    });
  });

  // --- Fallback behavior ---

  describe("fallback", () => {
    test("returns 'default' when no config and no auto-derive match", () => {
      expect(resolveNamespace("/some/random/path", null)).toBe("default");
    });

    test("returns config default_namespace when set and nothing else matches", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "unrelated", path_prefix: "/other" }],
        default_namespace: "my-fallback",
      };
      expect(resolveNamespace("/some/random/path", config)).toBe("my-fallback");
    });

    test("returns 'default' when config has empty rules and no default_namespace matches auto-derive", () => {
      const config: NamespaceConfig = {
        rules: [],
        default_namespace: "custom",
      };
      // No rules, cwd not under ~/source/, so fallback to config.default_namespace
      expect(resolveNamespace("/some/path", config)).toBe("custom");
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    test("null config goes straight to auto-derive", () => {
      expect(
        resolveNamespace("/home/testuser/source/group/repo", null)
      ).toBe("group");
    });

    test("config with empty rules array goes to auto-derive", () => {
      const config: NamespaceConfig = {
        rules: [],
        default_namespace: "fallback",
      };
      expect(
        resolveNamespace("/home/testuser/source/group/repo", config)
      ).toBe("group");
    });

    test("HOME not set falls through auto-derive gracefully", () => {
      delete process.env.HOME;
      const result = resolveNamespace("/some/path", null);
      expect(result).toBe("default");
    });

    test("cwd with trailing slash still matches rule", () => {
      const config: NamespaceConfig = {
        rules: [{ name: "match", path_prefix: "/projects/work" }],
        default_namespace: "default",
      };
      expect(resolveNamespace("/projects/work/", config)).toBe("match");
    });

    test("rule order does not matter - longest prefix always wins", () => {
      const config: NamespaceConfig = {
        rules: [
          { name: "specific", path_prefix: "/a/b/c" },
          { name: "broad", path_prefix: "/a" },
          { name: "medium", path_prefix: "/a/b" },
        ],
        default_namespace: "default",
      };
      expect(resolveNamespace("/a/b/c/d", config)).toBe("specific");
    });
  });
});
