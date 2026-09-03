// Peer card component

export function peerCardStyles(): string {
  return `
    .peer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 12px;
    }
    .peer-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      padding: 0;
      transition: border-color 0.2s;
      overflow: hidden;
    }
    .peer-card:hover { border-color: var(--border-secondary); }
    .peer-card.disconnected { opacity: var(--dim-opacity); }
    .peer-toolbar {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-primary);
      font-size: 11px;
    }
    .peer-toolbar .connection-dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--status-success); flex-shrink: 0;
    }
    .peer-card.disconnected .peer-toolbar .connection-dot { background: var(--text-faint); }
    .peer-toolbar .status-text { color: var(--text-muted); }
    .peer-toolbar .service-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 8px; border-radius: 10px; border: 1px solid;
      font-size: 11px; cursor: default;
    }
    .peer-toolbar .service-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .peer-toolbar .service-check { color: var(--text-faint); font-size: 10px; }
    .peer-toolbar .toolbar-actions {
      display: flex; gap: 4px; margin-left: auto;
    }
    .toolbar-btn {
      background: none; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 10px;
      padding: 2px 8px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .toolbar-btn:hover { border-color: var(--text-muted); color: var(--text-bright); }
    .toolbar-btn.start { color: var(--text-faint); border-color: transparent; font-size: 12px; padding: 0 4px; }
    .toolbar-btn.start:hover { color: var(--accent); background: var(--bg-subtle); border-color: var(--accent); }
    .toolbar-btn.stop:hover { border-color: var(--status-error); color: var(--status-error); }
    .toolbar-btn.docker { color: var(--status-cyan); }
    .toolbar-btn.docker:hover { border-color: var(--status-cyan); }
    .peer-body {
      padding: 10px 12px;
    }
    .peer-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
    }
    .peer-id { font-weight: 600; color: var(--accent); font-size: 13px; }
    .agent-type-badge {
      display: inline-block;
      font-size: 10px; font-weight: 500;
      padding: 1px 6px; border-radius: 4px;
      border: 1px solid;
    }
    .agent-type-badge.claude-code { color: var(--accent); border-color: var(--badge-blue-border); background: var(--badge-blue-bg); }
    .agent-type-badge.opencode { color: var(--accent-purple); border-color: var(--badge-purple-border); background: var(--badge-purple-bg); }
    .agent-type-badge.copilot { color: var(--accent-orange); border-color: var(--badge-orange-border); background: var(--badge-orange-bg); }
    .message-count-badge {
      margin-left: auto;
      background: var(--bg-subtle);
      border: 1px solid var(--border-secondary);
      color: var(--accent);
      font-family: inherit;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .message-count-badge:hover { background: var(--bg-subtle-hover); border-color: var(--accent); }
    .peer-cwd { color: var(--text-muted); font-size: 12px; margin-bottom: 4px; word-break: break-all; }
    .peer-branch {
      display: inline-block;
      background: var(--bg-subtle);
      color: var(--status-green);
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .peer-summary { color: var(--text-primary); font-size: 12px; margin-bottom: 8px; font-style: italic; }
    .peer-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-faint); }
    .peer-log-stats {
      display: flex; gap: 8px; margin-top: 8px; font-size: 11px;
      padding: 4px 8px; margin-left: -8px; margin-right: -8px;
      border-radius: 4px; transition: all 0.15s;
    }
    .peer-log-stats.clickable { cursor: pointer; }
    .peer-log-stats.clickable:hover {
      background: var(--bg-subtle);
      box-shadow: 0 0 8px var(--glow-accent);
    }
  `;
}

export function peerCardScript(): string {
  return `
    function renderPeerCard(peer, statsMap, svcMap) {
      var stats = statsMap[peer.id];
      var svc = svcMap[peer.id];
      var logStats = STATE.logStatsMap[peer.id];
      var total = stats ? stats.sent + stats.received : 0;
      var connected = peer.connected;

      var html = '<div class="peer-card' + (connected ? '' : ' disconnected') + '" data-peer-id="' + escapeHtml(peer.id) + '">';

      // Toolbar row: status + port + actions
      html += '<div class="peer-toolbar">';
      html += '<span class="connection-dot"></span>';
      html += '<span class="status-text">' + (connected ? 'Connected' : 'Last seen ' + timeAgo(peer.last_seen)) + '</span>';

      // Service port badge
      if (svc) {
        var color = svc.status === 'up' ? 'var(--status-success)' : svc.status === 'down' ? 'var(--status-error)' : 'var(--text-muted)';
        html += '<span class="service-badge" style="border-color:' + color + '">';
        html += '<span class="service-dot" style="background:' + color + '"></span>';
        html += ':' + svc.port;
        if (svc.last_check) {
          html += '<span class="service-check" title="Last check: ' + svc.last_check + '">' + timeAgo(svc.last_check) + '</span>';
        }
        html += '</span>';
      }

      // Action buttons
      html += '<div class="toolbar-actions">';
      if (connected) {
        var isUp = svc && svc.status === 'up';
        if (isUp) {
          html += '<button class="toolbar-btn stop"'
            + ' onclick="stopService(\\'' + escapeJs(peer.id) + '\\', ' + svc.port + ')"'
            + ' title="Stop service on :' + svc.port + '">Stop</button>';
          var dockerAlt = findDockerContainerForPeer(peer.id, svc.port);
          if (dockerAlt) {
            var dockerTitle = dockerAlt.state === 'running'
              ? 'Stop agent (Docker already running)'
              : 'Stop agent, start Docker container';
            html += '<button class="toolbar-btn docker"'
              + ' onclick="switchToDocker(\\'' + escapeJs(peer.id) + '\\', \\'' + escapeJs(dockerAlt.name) + '\\', ' + svc.port + ')"'
              + ' title="' + dockerTitle + '">Docker</button>';
          }
        } else {
          html += '<button class="toolbar-btn start"'
            + ' onclick="startService(\\'' + escapeJs(peer.id) + '\\')"'
            + ' title="Start service">&#9654;</button>';
        }
      }
      html += '</div>';
      html += '</div>';

      // Body: name + messages + info
      html += '<div class="peer-body">';

      html += '<div class="peer-header">';
      html += '<span class="peer-id">' + escapeHtml(peer.id) + '</span>';
      var agentType = peer.agent_type || 'claude-code';
      var agentLabel = agentType === 'claude-code' ? 'Claude' : agentType === 'opencode' ? 'OpenCode' : agentType === 'copilot' ? 'Copilot' : agentType;
      html += '<span class="agent-type-badge ' + escapeHtml(agentType) + '">' + escapeHtml(agentLabel) + '</span>';
      if (total > 0) {
        html += '<button class="message-count-badge" onclick="openConversation(\\'' + escapeJs(peer.id) + '\\', null)" title="View messages">';
        html += total + ' msg' + (total !== 1 ? 's' : '');
        html += '</button>';
      }
      html += '</div>';

      html += '<div class="peer-cwd">' + escapeHtml(shortPath(peer.cwd)) + '</div>';
      if (peer.git_branch) {
        html += '<div class="peer-branch">' + escapeHtml(peer.git_branch) + '</div>';
      }
      if (peer.summary) {
        html += '<div class="peer-summary">' + escapeHtml(peer.summary) + '</div>';
      }
      html += '<div class="peer-meta">';
      html += '<span>PID ' + peer.pid + '</span>';
      html += '</div>';

      if (logStats) {
        var hasLogFile = svc && svc.log_file;
        html += '<div class="peer-log-stats' + (hasLogFile ? ' clickable' : '') + '"'
          + (hasLogFile ? ' onclick="openLogViewer(\\'' + escapeJs(peer.id) + '\\')"' : '') + '>';
        if (logStats.ERROR > 0) html += '<span style="color:var(--status-error);font-weight:600">' + logStats.ERROR + ' errors</span>';
        if (logStats.WARN > 0) html += '<span style="color:var(--status-warning);font-weight:500">' + logStats.WARN + ' warn</span>';
        html += '<span style="color:var(--text-faint)">' + logStats.INFO + ' info</span>';
        html += '<span style="color:var(--text-faint)">' + logStats.total + ' lines</span>';
        html += '</div>';
      }

      html += '</div>'; // peer-body
      html += '</div>'; // peer-card
      return html;
    }

    function startService(peerId) {
      wsSend({ type: 'send_to_peer', peer_id: peerId, message: START_SERVICE_MESSAGE });
      addActivity('Sent start-service to ' + peerId);
    }

    function stopService(peerId, port) {
      if (!confirm('Stop service on port ' + port + '?')) return;
      wsSend({ type: 'stop_service', peer_id: peerId });
      addActivity('Stopping service on :' + port);
    }

    function switchToDocker(peerId, dockerName, port) {
      wsSend({ type: 'stop_service', peer_id: peerId });
      fetch('/api/docker/start?name=' + encodeURIComponent(dockerName), { method: 'POST' });
      addActivity('Switching :' + port + ' to Docker');
    }
  `;
}
