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
import { unifiedServiceCardStyles, unifiedServiceCardScript } from "./components/unified-service-card.ts";
import { serviceMappingModalStyles, serviceMappingModalScript, serviceMappingModalHtml } from "./components/service-mapping-modal.ts";
import { rendererScript } from "./components/renderer.ts";

function baseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0d1117; color: #c9d1d9;
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
      font-size: 14px; line-height: 1.5;
    }
    .dashboard { max-width: 1200px; margin: 0 auto; padding: 24px; }
    header {
      display: flex; align-items: center; gap: 16px;
      margin-bottom: 32px; padding-bottom: 16px;
      border-bottom: 1px solid #21262d; flex-wrap: wrap;
    }
    header h1 { font-size: 20px; font-weight: 600; color: #e6edf3; }
    .status {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .status::before {
      content: ""; display: inline-block;
      width: 8px; height: 8px; border-radius: 50%;
    }
    .status.connected::before { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
    .status.disconnected::before { background: #f85149; box-shadow: 0 0 6px #f85149; }
    .count { font-size: 13px; color: #8b949e; }
    .clear-btn {
      margin-left: auto; background: none;
      border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 4px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .clear-btn:hover { border-color: #f85149; color: #f85149; }
    .namespace-group { margin-bottom: 28px; }
    .namespace-group h2 {
      display: flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 500; color: #e6edf3;
      margin-bottom: 12px; padding: 8px 12px;
      background: #161b22; border-radius: 6px;
      border-left: 3px solid var(--ns-color, #58a6ff);
    }
    .ns-count {
      background: #21262d; color: #8b949e;
      font-size: 11px; padding: 2px 8px;
      border-radius: 10px; font-weight: 400;
    }
    .view-toggle {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .view-toggle:hover { border-color: #58a6ff; color: #58a6ff; }
    .baseline-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .baseline-btn:hover { border-color: #3fb950; color: #3fb950; }
    .baseline-btn.active {
      border-color: #3fb950; color: #3fb950; font-weight: 500;
    }
    .baseline-btn.active:hover { border-color: #f85149; color: #f85149; }
    .ns-badge { margin-left: auto; font-size: 11px; color: #8b949e; font-weight: 400; }
    .empty { text-align: center; padding: 60px 20px; color: #484f58; font-size: 14px; }
    .modal-loading, .modal-empty {
      color: #484f58; text-align: center; padding: 24px; font-size: 13px;
    }
    .modal-close {
      background: none; border: none; color: #8b949e;
      font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1;
    }
    .modal-close:hover { color: #e6edf3; }
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
    ${baseStyles()}
    ${peerCardStyles()}
    ${namespaceGraphStyles()}
    ${conversationModalStyles()}
    ${logViewerStyles()}
    ${containerCardStyles()}
    ${unifiedServiceCardStyles()}
    ${serviceMappingModalStyles()}
    ${activityLogStyles()}
  </style>
</head>
<body>
  <div class="dashboard">
    <header>
      <h1>claude-hivemind</h1>
      <span id="connectionStatus" class="status disconnected">Disconnected</span>
      <span id="peerCount" class="count">0 peers</span>
      <button id="clearBtn" class="clear-btn" style="display:none" onclick="clearMessages()">Clear history</button>
    </header>

    <div id="namespacesContainer">
      <div class="empty">No peers connected. Start a Claude Code session to see it here.</div>
    </div>

    <div id="unifiedServicesContainer" style="display:none"></div>

    <div id="dockerContainer" style="display:none"></div>

    ${activityLogHtml()}
  </div>

  ${conversationModalHtml()}
  ${logViewerHtml()}
  ${serviceMappingModalHtml()}

  <script>
      ${helpersScript()}
      ${connectionScript()}
      ${stateScript()}
      ${peerCardScript()}
      ${namespaceGraphScript()}
      ${conversationModalScript()}
      ${logViewerScript()}
      ${containerCardScript()}
      ${unifiedServiceCardScript()}
      ${serviceMappingModalScript()}
      ${activityLogScript()}
      ${rendererScript()}
  </script>
</body>
</html>`;
}
