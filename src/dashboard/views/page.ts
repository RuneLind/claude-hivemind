// Main dashboard page — composes all components into a single HTML string

import { helpersScript } from "./components/helpers.ts";
import { connectionScript } from "./components/connection.ts";
import { stateScript } from "./components/state.ts";
import { peerCardStyles, peerCardScript } from "./components/peer-card.ts";
import { namespaceGraphStyles, namespaceGraphScript } from "./components/namespace-graph.ts";
import { conversationModalStyles, conversationModalScript, conversationModalHtml } from "./components/conversation-modal.ts";
import { logViewerStyles, logViewerScript, logViewerHtml } from "./components/log-viewer.ts";
import { activityLogStyles, activityLogScript, activityLogHtml } from "./components/activity-log.ts";
import { containerCardStyles, containerCardScript } from "./components/container-card.ts";
import { launchModalStyles, launchModalHtml, launchModalScript } from "./components/launch-modal.ts";
import { rendererScript } from "./components/renderer.ts";
import { themeStyles, themeInitScript, themeToggleHtml, themeToggleScript } from "./theme.ts";

function baseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg-page); color: var(--text-primary);
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
      font-size: 14px; line-height: 1.5;
    }
    .dashboard { max-width: 1400px; margin: 0 auto; padding: 24px; }
    header {
      display: flex; align-items: center; gap: 16px;
      margin-bottom: 32px; padding-bottom: 16px;
      border-bottom: 1px solid var(--border-primary); flex-wrap: wrap;
    }
    header h1 { font-size: 20px; font-weight: 600; color: var(--text-bright); }
    .status {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .status::before {
      content: ""; display: inline-block;
      width: 8px; height: 8px; border-radius: 50%;
    }
    .status.connected::before { background: var(--status-success); box-shadow: 0 0 6px var(--status-success); }
    .status.disconnected::before { background: var(--status-error); box-shadow: 0 0 6px var(--status-error); }
    .count { font-size: 13px; color: var(--text-muted); }
    /* Right-hand header group: the clear button toggles display, so the
       auto margin lives on the wrapper — otherwise the theme toggle loses its
       right alignment whenever there is no history to clear. */
    .header-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .clear-btn {
      background: none;
      border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 11px;
      padding: 4px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .clear-btn:hover { border-color: var(--status-error); color: var(--status-error); }
    .namespace-group { margin-bottom: 28px; }
    .namespace-group h2 {
      display: flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 500; color: var(--text-bright);
      margin-bottom: 12px; padding: 8px 12px;
      background: var(--bg-panel); border-radius: 6px;
      border-left: 3px solid var(--ns-color, var(--accent));
    }
    .ns-count {
      background: var(--bg-surface); color: var(--text-muted);
      font-size: 11px; padding: 2px 8px;
      border-radius: 10px; font-weight: 400;
    }
    .view-toggle {
      background: none; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .view-toggle:hover { border-color: var(--accent); color: var(--accent); }
    .baseline-btn {
      background: none; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .baseline-btn:hover { border-color: var(--status-success); color: var(--status-success); }
    .baseline-btn.active {
      border-color: var(--status-success); color: var(--status-success); font-weight: 500;
    }
    .baseline-btn.active:hover { border-color: var(--status-error); color: var(--status-error); }
    .ns-badge { margin-left: auto; font-size: 11px; color: var(--text-muted); font-weight: 400; }
    .collapse-toggle {
      background: none; border: none; color: var(--text-dim);
      font-size: 12px; cursor: pointer; padding: 0 4px;
      transition: transform 0.2s, color 0.15s; line-height: 1;
    }
    .collapse-toggle:hover { color: var(--text-muted); }
    .collapse-toggle.collapsed { transform: rotate(-90deg); }
    .section-body.collapsed { display: none; }
    .empty { text-align: center; padding: 60px 20px; color: var(--text-dim); font-size: 14px; }
    .modal-loading, .modal-empty {
      color: var(--text-dim); text-align: center; padding: 24px; font-size: 13px;
    }
    .modal-close {
      background: none; border: none; color: var(--text-muted);
      font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1;
    }
    .modal-close:hover { color: var(--text-bright); }
  `;
}

export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>claude-hivemind</title>
  <style>
    ${themeStyles()}
    ${baseStyles()}
    ${peerCardStyles()}
    ${namespaceGraphStyles()}
    ${conversationModalStyles()}
    ${logViewerStyles()}
    ${containerCardStyles()}
    ${launchModalStyles()}
    ${activityLogStyles()}
  </style>
</head>
<body>
  <script>${themeInitScript()}</script>
  <div class="dashboard">
    <header>
      <h1>claude-hivemind</h1>
      <span id="connectionStatus" class="status disconnected">Disconnected</span>
      <span id="peerCount" class="count">0 peers</span>
      <span id="launchBtnSlot"></span>
      <span class="header-right">
        <button id="clearBtn" class="clear-btn" style="display:none" onclick="clearMessages()">Clear history</button>
        ${themeToggleHtml()}
      </span>
    </header>

    <div id="namespacesContainer">
      <div class="empty">No peers connected. Start a Claude Code session to see it here.</div>
    </div>

    <div id="dockerContainer" style="display:none"></div>

    ${activityLogHtml()}
  </div>

  ${conversationModalHtml()}
  ${logViewerHtml()}
  ${launchModalHtml()}

  <script>
      ${helpersScript()}
      ${connectionScript()}
      ${stateScript()}
      ${peerCardScript()}
      ${namespaceGraphScript()}
      ${conversationModalScript()}
      ${logViewerScript()}
      ${containerCardScript()}
      ${launchModalScript()}
      ${activityLogScript()}
      ${rendererScript()}
      ${themeToggleScript()}
  </script>
</body>
</html>`;
}
