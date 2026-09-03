/**
 * Light/dark/system theme for the dashboard — ported from muninn's
 * `src/dashboard/views/components/theme.ts` so the two surfaces behave the same.
 * Three modes:
 *
 *   - `system` (default) — no `data-theme` attribute on <html>; the
 *     `prefers-color-scheme` media query below governs. True OS-follow with
 *     zero JS and zero flash.
 *   - `light` / `dark` — explicit override, persisted in localStorage and applied
 *     as `<html data-theme="…">`, whose `html[data-theme=…]` selectors
 *     (specificity 0,1,1) outrank the media-query `:root` rules (0,1,0).
 *
 * The toggle cycles system → light → dark → system.
 */

const THEME_KEY = "claude-hivemind-theme";

/** Dark palette — the default, and the forced value under html[data-theme="dark"]. */
const DARK_TOKENS = `
      color-scheme: dark;

      /* Backgrounds */
      --bg-page: #0d1117;
      --bg-panel: #161b22;
      --bg-inset: #0d1117;
      --bg-surface: #21262d;
      --bg-subtle: #1f2a37;
      --bg-subtle-hover: #263545;
      --bg-hover: #1c2128;

      /* Borders */
      --border-primary: #21262d;
      --border-secondary: #30363d;
      --border-subtle: #21262d0a;

      /* Text */
      --text-bright: #e6edf3;
      --text-primary: #c9d1d9;
      --text-muted: #8b949e;
      --text-dim: #484f58;
      --text-faint: #6e7681;

      /* Accents and status */
      --accent: #58a6ff;
      --accent-bright: #79c0ff;
      --accent-purple: #d2a8ff;
      --accent-orange: #f0883e;
      --status-success: #3fb950;
      --status-error: #f85149;
      --status-warning: #d29922;
      --status-green: #7ee787;
      --status-cyan: #56d4dd;

      /* Primary (green) button */
      --btn-success-bg: #238636;
      --btn-success-hover: #2ea043;

      /* Agent-type badges */
      --badge-blue-bg: #0d1f3c;
      --badge-blue-border: #1f3a5f;
      --badge-purple-bg: #1c1030;
      --badge-purple-border: #3d2860;
      --badge-orange-bg: #2a1a10;
      --badge-orange-border: #5a3520;

      /* Tints, overlays, glows */
      --tint-error: rgba(248, 81, 73, 0.1);
      --tint-warning: rgba(210, 153, 34, 0.06);
      --overlay: rgba(0, 0, 0, 0.7);
      --overlay-soft: rgba(0, 0, 0, 0.6);
      --shadow-modal: rgba(0, 0, 0, 0.5);
      --glow-accent: rgba(88, 166, 255, 0.15);
      --glow-cyan: rgba(86, 212, 221, 0.15);

      /* Namespace hues (helpers.ts hashes a namespace onto this ramp) */
      --ns-0: #58a6ff;
      --ns-1: #7ee787;
      --ns-2: #d2a8ff;
      --ns-3: #f0883e;
      --ns-4: #ff7b72;
      --ns-5: #79c0ff;
      --ns-6: #ffa657;
      --ns-7: #a5d6ff;
`;

/**
 * Light palette — applied under `@media (prefers-color-scheme: light)` (system
 * follow) and forced under `html[data-theme="light"]`. Values track the GitHub
 * light ramp, the light half of the GitHub dark palette this dashboard was built
 * on: panels go white against a grey page (the dark theme's inverse), and every
 * accent/status hue is darkened so it stays legible on light fills.
 */
const LIGHT_TOKENS = `
      color-scheme: light;

      /* Backgrounds */
      --bg-page: #f6f8fa;
      --bg-panel: #ffffff;
      --bg-inset: #f6f8fa;
      --bg-surface: #eaeef2;
      --bg-subtle: #eef4fb;
      --bg-subtle-hover: #dbe9f8;
      --bg-hover: #f0f2f5;

      /* Borders */
      --border-primary: #d8dee4;
      --border-secondary: #d0d7de;
      --border-subtle: #d8dee4;

      /* Text */
      --text-bright: #1f2328;
      --text-primary: #24292f;
      --text-muted: #57606a;
      --text-dim: #8c959f;
      --text-faint: #6e7781;

      /* Accents and status */
      --accent: #0969da;
      --accent-bright: #0550ae;
      --accent-purple: #8250df;
      --accent-orange: #bc4c00;
      --status-success: #1a7f37;
      --status-error: #cf222e;
      --status-warning: #9a6700;
      --status-green: #1a7f37;
      --status-cyan: #0e7490;

      /* Primary (green) button */
      --btn-success-bg: #1f883d;
      --btn-success-hover: #1a7f37;

      /* Agent-type badges */
      --badge-blue-bg: #ddf4ff;
      --badge-blue-border: #b6e3ff;
      --badge-purple-bg: #fbf0ff;
      --badge-purple-border: #d8b9ff;
      --badge-orange-bg: #fff4ec;
      --badge-orange-border: #ffd8b5;

      /* Tints, overlays, glows */
      --tint-error: #ffebe9;
      --tint-warning: #fff8c5;
      --overlay: rgba(27, 31, 36, 0.4);
      --overlay-soft: rgba(27, 31, 36, 0.35);
      --shadow-modal: rgba(27, 31, 36, 0.2);
      --glow-accent: rgba(9, 105, 218, 0.2);
      --glow-cyan: rgba(14, 116, 144, 0.2);

      /* Namespace hues — the light half of the ramp above */
      --ns-0: #0969da;
      --ns-1: #1a7f37;
      --ns-2: #8250df;
      --ns-3: #bc4c00;
      --ns-4: #cf222e;
      --ns-5: #0550ae;
      --ns-6: #953800;
      --ns-7: #0a6c9e;
`;

export function themeStyles(): string {
  return `
    :root {${DARK_TOKENS}    }

    /* System follow: honor the OS preference when no explicit override is set. */
    @media (prefers-color-scheme: light) {
      :root {${LIGHT_TOKENS}      }
    }

    /* Explicit overrides (set by the theme toggle). html[data-theme] has higher
       specificity than the media-query :root, so it wins regardless of OS setting. */
    html[data-theme="dark"] {${DARK_TOKENS}    }
    html[data-theme="light"] {${LIGHT_TOKENS}    }

    .theme-toggle {
      width: 26px; height: 26px;
      display: grid; place-items: center;
      cursor: pointer;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 4px;
      color: var(--text-muted);
      font-size: 13px; line-height: 1;
      font-family: inherit;
      transition: color 0.15s, border-color 0.15s;
    }
    .theme-toggle:hover { color: var(--text-bright); border-color: var(--accent); }
  `;
}

/**
 * Early script — injected as the first thing inside <body>, so it runs before the
 * browser paints any body content (an inline sync script blocks rendering of what
 * follows it). Only forces a theme when the user has an explicit 'light'/'dark'
 * preference; otherwise leaves `data-theme` unset so the prefers-color-scheme
 * media query governs (no flash for the system-follow default).
 */
export function themeInitScript(): string {
  return `
    (function() {
      try {
        var t = localStorage.getItem('${THEME_KEY}');
        if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
        else delete document.documentElement.dataset.theme;
      } catch (e) {}
    })();`;
}

/** Header toggle button. */
export function themeToggleHtml(): string {
  return `<button class="theme-toggle" id="themeToggle" title="Theme (t to cycle)" aria-label="Cycle theme: system, light, dark">&#9680;</button>`;
}

/**
 * Cycles + persists the theme, keeps the button glyph in sync, and binds the `t`
 * shortcut. Guarded by `window.__themeToggle` so it only wires once.
 */
export function themeToggleScript(): string {
  return `
  (function() {
    if (window.__themeToggle) return;
    window.__themeToggle = true;
    var KEY = '${THEME_KEY}';
    var root = document.documentElement;
    var ICONS = { system: '\\u25D0', light: '\\u2600', dark: '\\u263E' };
    var LABELS = { system: 'follow system', light: 'light', dark: 'dark' };
    function current() {
      try { var t = localStorage.getItem(KEY); return (t === 'light' || t === 'dark') ? t : 'system'; }
      catch (e) { return 'system'; }
    }
    function apply(mode) {
      if (mode === 'system') { delete root.dataset.theme; try { localStorage.removeItem(KEY); } catch (e) {} }
      else { root.dataset.theme = mode; try { localStorage.setItem(KEY, mode); } catch (e) {} }
      var btn = document.getElementById('themeToggle');
      if (btn) { btn.textContent = ICONS[mode]; btn.title = 'Theme: ' + LABELS[mode] + ' (t to cycle)'; }
    }
    function cycle() {
      var c = current();
      apply(c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system');
    }
    apply(current()); // sync the button glyph on load
    var btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', cycle);
    document.addEventListener('keydown', function(e) {
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
          !e.target.isContentEditable) {
        cycle();
      }
    });
  })();`;
}
