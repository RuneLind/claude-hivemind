// Log viewer modal with tailing, filtering, and level toggles

export function logViewerStyles(): string {
  return `
    .log-viewer-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex; align-items: stretch; justify-content: center;
      z-index: 100; padding: 40px;
    }
    .log-viewer {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 10px;
      width: 100%; max-width: 1100px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .log-header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid #21262d;
      background: #161b22; flex-shrink: 0; flex-wrap: wrap;
    }
    .log-header h3 {
      font-size: 13px; font-weight: 500; color: #e6edf3;
      white-space: nowrap; margin: 0;
    }
    .log-filters { display: flex; gap: 4px; }
    .log-level-btn {
      background: transparent; border: 1px solid #30363d; color: #484f58;
      font-family: inherit; font-size: 10px; padding: 2px 8px;
      border-radius: 4px; cursor: pointer; transition: all 0.15s;
    }
    .log-level-btn.active { background: #21262d; }
    .log-level-btn.error.active { color: #f85149; border-color: #f85149; }
    .log-level-btn.warn.active { color: #d29922; border-color: #d29922; }
    .log-level-btn.info.active { color: #58a6ff; border-color: #58a6ff; }
    .log-level-btn.debug.active { color: #8b949e; border-color: #8b949e; }
    .log-level-btn.trace.active { color: #6e7681; border-color: #6e7681; }
    .log-search {
      background: #0d1117; border: 1px solid #30363d; color: #c9d1d9;
      font-family: inherit; font-size: 12px; padding: 4px 10px;
      border-radius: 4px; width: 160px; margin-left: auto;
    }
    .log-search:focus { outline: none; border-color: #58a6ff; }
    .log-body {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 8px 0; font-size: 12px; line-height: 1.6;
    }
    .log-line {
      padding: 0 16px; white-space: pre-wrap; word-break: break-all;
      font-family: "SF Mono", "Fira Code", monospace;
    }
    .log-line.error { background: rgba(248, 81, 73, 0.1); }
    .log-line.warn { background: rgba(210, 153, 34, 0.06); }
    .log-level-tag {
      display: inline-block; width: 50px; flex-shrink: 0; font-weight: 600;
    }
    .log-line.error .log-level-tag { color: #f85149; }
    .log-line.warn .log-level-tag { color: #d29922; }
    .log-line.info .log-level-tag { color: #58a6ff; }
    .log-line.debug .log-level-tag { color: #8b949e; }
    .log-line.trace .log-level-tag { color: #6e7681; }
    .log-message { color: #c9d1d9; }
    .log-line-count { color: #484f58; font-size: 11px; }
  `;
}

export function logViewerScript(): string {
  return `
    var logActiveLevels = { ERROR: true, WARN: true, INFO: true, DEBUG: true, TRACE: false };
    var logFilter = '';
    var logAutoScroll = true;

    function openLogViewer(peerId) {
      // Close any existing Docker log subscription
      if (STATE.dockerLogViewerContainer) {
        wsSend({ type: 'unsubscribe_docker_logs', containerId: STATE.dockerLogViewerContainer });
        STATE.dockerLogViewerContainer = null;
      }

      STATE.logLines = [];
      STATE.logViewerPeer = peerId;

      // Reset filter state
      logFilter = '';
      logAutoScroll = true;
      logActiveLevels = { ERROR: true, WARN: true, INFO: true, DEBUG: true, TRACE: false };

      var overlay = $('logViewerModal');
      overlay.style.display = 'flex';
      $('logViewerTitle').textContent = 'Logs: ' + peerId;
      $('logFilterInput').value = '';

      renderLogLevelButtons();
      renderLogLines();

      wsSend({ type: 'subscribe_logs', peer_id: peerId });
    }

    function closeLogViewer() {
      var overlay = $('logViewerModal');
      overlay.style.display = 'none';

      if (STATE.logViewerPeer) {
        wsSend({ type: 'unsubscribe_logs', peer_id: STATE.logViewerPeer });
        STATE.logViewerPeer = null;
      }
      if (STATE.dockerLogViewerContainer) {
        wsSend({ type: 'unsubscribe_docker_logs', containerId: STATE.dockerLogViewerContainer });
        STATE.dockerLogViewerContainer = null;
      }
      STATE.logLines = [];
    }

    function toggleLogLevel(level) {
      logActiveLevels[level] = !logActiveLevels[level];
      renderLogLevelButtons();
      renderLogLines();
    }

    function onLogFilter(value) {
      logFilter = value.toLowerCase();
      renderLogLines();
    }

    function renderLogLevelButtons() {
      var counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };
      STATE.logLines.forEach(function(l) { counts[l.level]++; });

      var btns = document.querySelectorAll('.log-level-btn');
      btns.forEach(function(btn) {
        var level = btn.getAttribute('data-level');
        var active = logActiveLevels[level];
        btn.className = 'log-level-btn ' + level.toLowerCase() + (active ? ' active' : '');
        btn.textContent = level + (counts[level] > 0 ? ' (' + counts[level] + ')' : '');
      });
    }

    function renderLogLines() {
      renderLogLevelButtons();
      var body = $('logBody');
      if (!body) return;

      var filtered = STATE.logLines.filter(function(l) {
        if (!logActiveLevels[l.level]) return false;
        if (logFilter && l.raw.toLowerCase().indexOf(logFilter) === -1) return false;
        return true;
      });

      var lineCount = $('logLineCount');
      if (lineCount) lineCount.textContent = STATE.logLines.length + ' lines';

      if (filtered.length === 0) {
        body.innerHTML = '<div class="modal-empty">' +
          (STATE.logLines.length === 0 ? 'Waiting for log lines...' : 'No lines match filters') +
          '</div>';
        return;
      }

      var html = '';
      filtered.forEach(function(line) {
        html += '<div class="log-line ' + line.level.toLowerCase() + '">';
        html += '<span class="log-level-tag">' + line.level.padEnd(5) + '</span>';
        html += '<span class="log-message">' + escapeHtml(line.raw) + '</span>';
        html += '</div>';
      });
      body.innerHTML = html;

      if (logAutoScroll) {
        body.scrollTop = body.scrollHeight;
      }
    }

    function onLogScroll() {
      var body = $('logBody');
      if (!body) return;
      logAutoScroll = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    }
  `;
}

export function logViewerHtml(): string {
  return `
    <div id="logViewerModal" class="log-viewer-overlay" style="display:none" onclick="closeLogViewer()">
      <div class="log-viewer" onclick="event.stopPropagation()">
        <div class="log-header">
          <h3 id="logViewerTitle">Logs</h3>
          <div class="log-filters">
            <button class="log-level-btn error active" data-level="ERROR" onclick="toggleLogLevel('ERROR')">ERROR</button>
            <button class="log-level-btn warn active" data-level="WARN" onclick="toggleLogLevel('WARN')">WARN</button>
            <button class="log-level-btn info active" data-level="INFO" onclick="toggleLogLevel('INFO')">INFO</button>
            <button class="log-level-btn debug active" data-level="DEBUG" onclick="toggleLogLevel('DEBUG')">DEBUG</button>
            <button class="log-level-btn trace" data-level="TRACE" onclick="toggleLogLevel('TRACE')">TRACE</button>
          </div>
          <input type="text" class="log-search" id="logFilterInput" placeholder="Filter..." oninput="onLogFilter(this.value)">
          <span id="logLineCount" class="log-line-count">0 lines</span>
          <button class="modal-close" onclick="closeLogViewer()">&times;</button>
        </div>
        <div class="log-body" id="logBody" onscroll="onLogScroll()"></div>
      </div>
    </div>
  `;
}
