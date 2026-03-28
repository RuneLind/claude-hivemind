// Peer card component

export function peerCardStyles(): string {
  return `
    .peer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }
    .peer-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 14px 16px;
      transition: border-color 0.2s;
    }
    .peer-card:hover { border-color: #30363d; }
    .peer-card.disconnected { opacity: 0.5; }
    .peer-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .peer-id { font-weight: 600; color: #58a6ff; font-size: 13px; }
    .connection-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #3fb950;
    }
    .peer-card.disconnected .connection-dot { background: #484f58; }
    .message-count-badge {
      margin-left: auto;
      background: #1f2a37;
      border: 1px solid #30363d;
      color: #58a6ff;
      font-family: inherit;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .message-count-badge:hover { background: #263545; border-color: #58a6ff; }
    .peer-cwd { color: #8b949e; font-size: 12px; margin-bottom: 4px; word-break: break-all; }
    .peer-branch {
      display: inline-block;
      background: #1f2a37;
      color: #7ee787;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .peer-summary { color: #c9d1d9; font-size: 12px; margin-bottom: 8px; font-style: italic; }
    .peer-meta { display: flex; gap: 12px; font-size: 11px; color: #484f58; }
    .peer-log-stats {
      display: flex; gap: 8px; margin-top: 8px; font-size: 11px;
      padding: 4px 8px; margin-left: -8px; margin-right: -8px;
      border-radius: 4px; transition: all 0.15s;
    }
    .peer-log-stats.clickable { cursor: pointer; }
    .peer-log-stats.clickable:hover {
      background: #1f2a37;
      box-shadow: 0 0 8px rgba(88, 166, 255, 0.15);
    }
    .service-badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; color: #c9d1d9; padding: 2px 8px;
      border-radius: 10px; border: 1px solid;
    }
    .service-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .service-check { color: #484f58; font-size: 10px; }
    .service-play-btn {
      background: none; border: 1px solid transparent; color: #484f58;
      font-size: 12px; cursor: pointer; padding: 3px 6px;
      margin: -4px 0; line-height: 1; border-radius: 4px;
      transition: all 0.15s;
    }
    .service-play-btn:hover:not(:disabled) {
      color: #58a6ff; background: #1f2a37;
      border-color: #58a6ff;
    }
    .service-play-btn.up { color: #3fb950; cursor: default; }
    .service-play-btn:disabled { opacity: 1; }
    .service-stop-btn {
      background: none; border: 1px solid transparent; color: #484f58;
      font-size: 11px; cursor: pointer; padding: 3px 6px;
      margin: -4px 0; line-height: 1; border-radius: 4px;
      transition: all 0.15s;
    }
    .service-stop-btn:hover {
      color: #f85149; background: #1f2a37;
      border-color: #f85149;
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
      html += '<div class="peer-header">';
      html += '<span class="connection-dot"></span>';
      html += '<span class="peer-id">' + escapeHtml(peer.id) + '</span>';

      if (connected) {
        var isUp = svc && svc.status === 'up';
        if (isUp) {
          html += '<button class="service-stop-btn"'
            + ' onclick="stopService(\\'' + escapeJs(peer.id) + '\\', ' + svc.port + ')"'
            + ' title="Stop service on :' + svc.port + '">Stop</button>';
          // Show "Docker" button if a Docker container exists for this service
          var dockerAlt = findDockerContainerForPeer(peer.id, svc.port);
          if (dockerAlt) {
            var dockerLabel = dockerAlt.state === 'running' ? 'Docker' : 'Docker';
            var dockerTitle = dockerAlt.state === 'running'
              ? 'Stop agent (Docker already running on :' + (extractHostPort(dockerAlt.ports) || '?') + ')'
              : 'Stop agent, start Docker container';
            html += '<button class="service-stop-btn"'
              + ' onclick="switchToDocker(\\'' + escapeJs(peer.id) + '\\', \\'' + escapeJs(dockerAlt.name) + '\\', ' + svc.port + ')"'
              + ' title="' + dockerTitle + '" style="color:#56d4dd">Docker</button>';
          }
        } else {
          html += '<button class="service-play-btn"'
            + ' onclick="startService(\\'' + escapeJs(peer.id) + '\\')"'
            + ' title="Start service">&#9654;</button>';
        }
      }

      if (svc) {
        var color = svc.status === 'up' ? '#3fb950' : svc.status === 'down' ? '#f85149' : '#848d97';
        html += '<span class="service-badge" style="border-color:' + color + '">';
        html += '<span class="service-dot" style="background:' + color + '"></span>';
        html += ':' + svc.port;
        if (svc.last_check) {
          html += '<span class="service-check" title="Last check: ' + svc.last_check + '">' + timeAgo(svc.last_check) + '</span>';
        }
        html += '</span>';
      }

      if (total > 0) {
        html += '<button class="message-count-badge" onclick="openConversation(\\'' + escapeJs(peer.id) + '\\', null)" title="View messages">';
        html += total + ' msg' + (total !== 1 ? 's' : '');
        html += '</button>';
      }
      html += '</div>'; // peer-header

      html += '<div class="peer-cwd">' + escapeHtml(shortPath(peer.cwd)) + '</div>';
      if (peer.git_branch) {
        html += '<div class="peer-branch">' + escapeHtml(peer.git_branch) + '</div>';
      }
      if (peer.summary) {
        html += '<div class="peer-summary">' + escapeHtml(peer.summary) + '</div>';
      }
      html += '<div class="peer-meta">';
      html += '<span>PID ' + peer.pid + '</span>';
      html += '<span>' + (connected ? 'Connected' : 'Last seen ' + timeAgo(peer.last_seen)) + '</span>';
      html += '</div>';

      if (logStats) {
        var hasLogFile = svc && svc.log_file;
        html += '<div class="peer-log-stats' + (hasLogFile ? ' clickable' : '') + '"'
          + (hasLogFile ? ' onclick="openLogViewer(\\'' + escapeJs(peer.id) + '\\')"' : '') + '>';
        if (logStats.ERROR > 0) html += '<span style="color:#f85149;font-weight:600">' + logStats.ERROR + ' errors</span>';
        if (logStats.WARN > 0) html += '<span style="color:#d29922;font-weight:500">' + logStats.WARN + ' warn</span>';
        html += '<span style="color:#484f58">' + logStats.INFO + ' info</span>';
        html += '<span style="color:#484f58">' + logStats.total + ' lines</span>';
        html += '</div>';
      }

      html += '</div>';
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
