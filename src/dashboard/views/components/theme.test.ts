// Guards the theme contract that the dashboard's CSS-custom-property palette rests on.
// Every finding these pin was found by hand once (PR #31 review); a stylesheet has no
// type checker, so a broken token renders as nothing rather than failing a build.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDashboardPage } from "../page.ts";

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

test("light and dark palettes define exactly the same tokens", () => {
  const dark = definedTokens(page, ":root {");
  const light = definedTokens(page, 'html[data-theme="light"] {');
  expect(dark.size).toBeGreaterThan(30);
  expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  expect([...dark].filter((t) => !light.has(t))).toEqual([]);
});

test("every token the dashboard references is defined in both palettes", () => {
  const dark = definedTokens(page, ":root {");
  const light = definedTokens(page, 'html[data-theme="light"] {');
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
  for (const [theme, selector] of [["dark", ":root {"], ["light", 'html[data-theme="light"] {']] as const) {
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
