// Guards the theme contract that the dashboard's CSS-custom-property palette rests on.
// Every finding these pin was found by hand once (PR #31 review); a stylesheet has no
// type checker, so a broken token renders as nothing rather than failing a build.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDashboardPage } from "../page.ts";
import { themeToggleScript } from "./theme.ts";

const COMPONENTS_DIR = import.meta.dir;
const VIEWS_DIR = join(COMPONENTS_DIR, "..");

/** Every .ts under views/ that paints something, excluding theme.ts (which owns the literals) and tests. */
function viewModules(): { path: string; source: string }[] {
  const files = [
    ...readdirSync(VIEWS_DIR).map((f) => join(VIEWS_DIR, f)),
    ...readdirSync(COMPONENTS_DIR).map((f) => join(COMPONENTS_DIR, f)),
  ];
  return files
    .filter((f) => f.endsWith(".ts") && !f.endsWith("theme.ts") && !f.endsWith(".test.ts"))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

/** Token names defined inside one `{ … }` block of the rendered stylesheet. */
function definedTokens(css: string, selector: string): Set<string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found in rendered CSS: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open, close);
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
}

const page = renderDashboardPage();

// Anchor on the forced-override selectors: they are unique, while ":root {" appears
// twice (dark default, then again inside the light media query).
const DARK_SELECTOR = 'html[data-theme="dark"] {';
const LIGHT_SELECTOR = 'html[data-theme="light"] {';

test("light and dark palettes define exactly the same tokens", () => {
  const dark = definedTokens(page, DARK_SELECTOR);
  const light = definedTokens(page, LIGHT_SELECTOR);
  expect(dark.size).toBeGreaterThan(30);
  expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  expect([...dark].filter((t) => !light.has(t))).toEqual([]);
});

test("every token the dashboard references is defined in both palettes", () => {
  const dark = definedTokens(page, DARK_SELECTOR);
  const light = definedTokens(page, LIGHT_SELECTOR);
  // --ns-color is set per namespace as an inline style, not by the palette.
  const used = new Set(
    [...page.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!).filter((t) => t !== "--ns-color"),
  );
  expect([...used].filter((t) => !dark.has(t) || !light.has(t))).toEqual([]);
});

test("no view module hardcodes a color; they all read from the palette", () => {
  // A literal color survives theme switching untouched, so it is correct in at most
  // one theme — the failure mode is invisible until someone opens the other one.
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
  const offenders: string[] = [];
  for (const { path, source } of viewModules()) {
    source.split("\n").forEach((line, i) => {
      // HTML entities (&#9660;) are glyphs, not colors.
      const stripped = line.replace(/&#\d+;/g, "");
      if (colorLiteral.test(stripped)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
      colorLiteral.lastIndex = 0;
    });
  }
  expect(offenders).toEqual([]);
});

/** WCAG 2.1 relative luminance / contrast ratio for two opaque #rrggbb colors. */
function contrast(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const ch = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!);
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi! + 0.05) / (lo! + 0.05);
}

function tokenValues(css: string, selector: string): Record<string, string> {
  const open = css.indexOf("{", css.indexOf(selector));
  const block = css.slice(open, css.indexOf("}", open));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

// The accent/status ramp carries text at 10–13px (log-level filters, service badges,
// error counts), so it owes AA. The dim text tiers are deliberately below it and are
// excluded — they carry decorative chrome, and their contrast is a design choice made
// once for both themes, not a per-theme accident.
test("accent and status colors clear AA on every surface they sit on, in both themes", () => {
  const FOREGROUNDS = [
    "--accent", "--accent-bright", "--accent-purple", "--accent-orange",
    "--status-success", "--status-error", "--status-warning", "--status-green",
    "--status-cyan", "--text-muted",
  ];
  const BACKGROUNDS = ["--bg-page", "--bg-panel", "--bg-surface"];
  const failures: string[] = [];
  for (const [theme, selector] of [["dark", DARK_SELECTOR], ["light", LIGHT_SELECTOR]] as const) {
    const tokens = tokenValues(page, selector);
    for (const fg of FOREGROUNDS) {
      for (const bg of BACKGROUNDS) {
        const ratio = contrast(tokens[fg]!, tokens[bg]!);
        if (ratio < 4.5) failures.push(`${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      }
    }
  }
  expect(failures).toEqual([]);
});

test("the dark and light palettes are actually different palettes", () => {
  // Cheap canary for the anchor above: if both selectors ever resolved to the same
  // block, every other test in this file would pass vacuously.
  const dark = tokenValues(page, DARK_SELECTOR);
  const light = tokenValues(page, LIGHT_SELECTOR);
  expect(page.split(DARK_SELECTOR).length - 1).toBe(1); // the anchor must match exactly one block
  expect(page.split(LIGHT_SELECTOR).length - 1).toBe(1);
  const differing = Object.keys(dark).filter((k) => dark[k] !== light[k]);
  expect(differing.length).toBeGreaterThan(30);
  expect(dark["--bg-page"]).not.toBe(light["--bg-page"]);
  expect(dark["--text-bright"]).not.toBe(light["--text-bright"]);
});

/** Composite an #rrggbbaa token over an opaque background. */
function flatten(token: string, bg: string): string {
  const hex = token.slice(1);
  if (hex.length !== 8) return token;
  const a = parseInt(hex.slice(6, 8), 16) / 255;
  const mix = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * a + parseInt(bg.slice(i + 1, i + 3), 16) * (1 - a));
  return "#" + [0, 2, 4].map((i) => mix(i).toString(16).padStart(2, "0")).join("");
}

test("--border-subtle carries the same visual weight in both themes", () => {
  // Alpha does not transfer between themes: the same 4% grey that is a faint rule on
  // white is literally invisible on the dark panel, so matching the alpha value gives
  // one theme a divider and the other none. Match the rendered contrast instead.
  const weights = (["dark", "light"] as const).map((theme) => {
    const t = tokenValues(page, theme === "dark" ? DARK_SELECTOR : LIGHT_SELECTOR);
    // .activity-item renders directly on the page background, not on a panel.
    const backdrop = t["--bg-page"]!;
    return contrast(flatten(t["--border-subtle"]!, backdrop), backdrop);
  });
  expect(Math.abs(weights[0]! - weights[1]!)).toBeLessThan(0.05);
  // …and it must actually be a divider in both, not an invisible one in either.
  expect(Math.min(...weights)).toBeGreaterThan(1.05);
});

test("disabled controls are dimmed hard enough to read as disabled in both themes", () => {
  // --dim-opacity (0.8 in light, so stale-but-readable cards stay legible) is the wrong
  // strength for a disabled control, which has to be obviously unavailable.
  const used = new Set<string>();
  const literals: string[] = [];
  for (const { path, source } of viewModules()) {
    for (const m of source.matchAll(/:disabled\s*\{[^}]*opacity:\s*([^;}]+)/g)) {
      const value = m[1]!.trim();
      const token = value.match(/^var\((--[\w-]+)\)$/);
      if (token) used.add(token[1]!);
      else literals.push(`${path}: opacity: ${value}`);
    }
  }
  expect(literals).toEqual([]); // a literal here escapes both this check and theming
  expect(used.size).toBeGreaterThan(0);
  for (const token of used) {
    for (const selector of [DARK_SELECTOR, LIGHT_SELECTOR]) {
      expect(Number(tokenValues(page, selector)[token])).toBeLessThanOrEqual(0.6);
    }
  }
});

/**
 * A DOM small enough to run `themeToggleScript()` against in-process. The script only
 * reaches for `document.getElementById`, `document.addEventListener`,
 * `document.documentElement.dataset`, `localStorage` and `window`, so a stub of those
 * five is enough to exercise the real emitted source rather than a paraphrase of it.
 */
function runToggleScript() {
  const listeners: ((e: any) => void)[] = [];
  const store = new Map<string, string>();
  const button = { textContent: "", title: "", attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    addEventListener(_: string, fn: () => void) { this.click = fn; }, click: () => {} };
  const documentElement = { dataset: {} as Record<string, string | undefined> };
  const fakeWindow: any = {};
  const fakeDocument = {
    documentElement,
    getElementById: (id: string) => (id === "themeToggle" ? button : null),
    addEventListener: (type: string, fn: (e: any) => void) => { if (type === "keydown") listeners.push(fn); },
  };
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  new Function("window", "document", "localStorage", themeToggleScript())(fakeWindow, fakeDocument, fakeStorage);
  return {
    theme: () => documentElement.dataset.theme ?? "system",
    press: (key: string, target: any = { tagName: "BODY" }) =>
      listeners.forEach((fn) => fn({ key, target, ctrlKey: false, metaKey: false, altKey: false })),
    clickToggle: () => button.click(),
    button,
  };
}

test("the t shortcut cycles from anywhere except an element that consumes the keystroke", () => {
  // Focus provenance (tabbed to / clicked / focused programmatically) must not matter:
  // keying on it is what broke this guard twice. Only consumption matters.
  const CYCLES = [
    { tagName: "BODY" },
    { tagName: "BUTTON" },                                  // clicked, or tabbed to — same rule
    { tagName: "A" },
    { tagName: "DIV", isContentEditable: false },
    { tagName: "LABEL" },
  ];
  for (const target of CYCLES) {
    const t = runToggleScript();
    const before = t.theme();
    t.press("t", target);
    expect({ target: target.tagName, theme: t.theme() }).not.toEqual({ target: target.tagName, theme: before });
  }

  // The case both earlier guards got wrong, from opposite directions: a button the user
  // reached with the keyboard. It does not consume 't', so it must cycle like any other.
  const tabbed = runToggleScript();
  const beforeTab = tabbed.theme();
  tabbed.press("Tab", { tagName: "BUTTON" });
  tabbed.press("t", { tagName: "BUTTON" });
  expect(tabbed.theme()).not.toBe(beforeTab);

  const SUPPRESSES = [
    { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    {},           // a non-element target (document) has no tagName at all
    null,         // …and may be absent entirely
  ];
  for (const target of SUPPRESSES) {
    const t = runToggleScript();
    const before = t.theme();
    t.press("t", target);
    expect({ target: JSON.stringify(target), theme: t.theme() }).toEqual({ target: JSON.stringify(target), theme: before });
  }
});

test("the toggle cycles system to light to dark and reports the mode to assistive tech", () => {
  const t = runToggleScript();
  const seen = [t.theme()];
  for (let i = 0; i < 3; i++) { t.clickToggle(); seen.push(t.theme()); }
  expect(seen).toEqual(["system", "light", "dark", "system"]);
  t.clickToggle();
  expect(t.button.attrs["aria-label"]).toContain("light");
  expect(t.button.title).toContain("light");
});
