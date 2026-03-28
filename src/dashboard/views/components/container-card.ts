// Docker container card component

export function containerCardStyles(): string {
  return `
    .docker-section { margin-bottom: 28px; }
    .docker-section h2 {
      display: flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 500; color: #e6edf3;
      margin-bottom: 12px; padding: 8px 12px;
      background: #161b22; border-radius: 6px;
      border-left: 3px solid #56d4dd;
    }
    .docker-project-name { color: #56d4dd; }
    .docker-count {
      background: #21262d; color: #8b949e;
      font-size: 11px; padding: 2px 8px;
      border-radius: 10px; font-weight: 400;
    }
    .docker-error-summary {
      margin-left: auto; font-size: 11px; font-weight: 400;
    }
    .container-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }
    .container-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 14px 16px;
      transition: border-color 0.2s;
    }
    .container-card:hover { border-color: #30363d; }
    .container-card.stopped { opacity: 0.5; }
    .container-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    }
    .container-state-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .container-state-dot.running { background: #3fb950; }
    .container-state-dot.exited { background: #f85149; }
    .container-state-dot.paused { background: #d29922; }
    .container-state-dot.restarting { background: #d29922; animation: container-pulse 1s infinite; }
    .container-state-dot.dead { background: #f85149; }
    .container-state-dot.created { background: #484f58; }
    .container-name { font-weight: 600; color: #56d4dd; font-size: 13px; }
    .container-status { color: #8b949e; font-size: 11px; margin-bottom: 6px; }
    .container-image { color: #484f58; font-size: 11px; margin-bottom: 4px; word-break: break-all; }
    .container-resources {
      display: flex; gap: 12px; font-size: 11px; color: #8b949e; margin-bottom: 6px;
    }
    .container-resources span { white-space: nowrap; }
    .container-ports {
      font-size: 11px; color: #8b949e;
      background: #1f2a37; padding: 2px 8px;
      border-radius: 4px; display: inline-block; margin-bottom: 6px;
    }
    .container-actions {
      display: flex; gap: 6px; margin-left: auto;
    }
    .container-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .container-btn.stop:hover { border-color: #f85149; color: #f85149; }
    .container-btn.logs:hover { border-color: #56d4dd; color: #56d4dd; }
    .container-log-stats {
      display: flex; gap: 8px; margin-top: 8px; font-size: 11px;
      padding: 4px 8px; margin-left: -8px; margin-right: -8px;
      border-radius: 4px; cursor: pointer; transition: all 0.15s;
    }
    .container-log-stats:hover {
      background: #1f2a37;
      box-shadow: 0 0 8px rgba(86, 212, 221, 0.15);
    }
    @keyframes container-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  `;
}

export function containerCardScript(): string {
  return `
    function renderDockerSection() {
      var container = $('dockerContainer');
      if (!container) return;

      if (STATE.dockerContainers.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';

      // Group by project
      var grouped = {};
      STATE.dockerContainers.forEach(function(c) {
        var proj = c.project || 'default';
        if (!grouped[proj]) grouped[proj] = [];
        grouped[proj].push(c);
      });

      var projects = Object.keys(grouped).sort();
      var html = '';

      projects.forEach(function(project) {
        var containers = grouped[project];
        // Sort: running first, then by service name
        containers.sort(function(a, b) {
          if (a.state === 'running' && b.state !== 'running') return -1;
          if (a.state !== 'running' && b.state === 'running') return 1;
          return a.service.localeCompare(b.service);
        });

        var running = containers.filter(function(c) { return c.state === 'running'; }).length;

        // Calculate total errors across project
        var totalErrors = 0;
        var totalWarns = 0;
        containers.forEach(function(c) {
          var stats = STATE.dockerLogStats[c.id];
          if (stats) {
            totalErrors += stats.errorCount;
            totalWarns += stats.warnCount;
          }
        });

        var dKey = 'docker:' + project;
        var dCollapsed = STATE.collapsed[dKey];
        html += '<section class="docker-section">';
        html += '<h2>';
        html += collapseToggleHtml(dKey) + ' ';
        html += '<span class="docker-project-name">' + escapeHtml(project) + '</span>';
        html += '<span class="docker-count">' + running + '/' + containers.length + ' running</span>';
        if (totalErrors > 0) {
          html += '<span class="docker-error-summary" style="color:#f85149">' + totalErrors + ' error' + (totalErrors !== 1 ? 's' : '') + '</span>';
        } else if (totalWarns > 0) {
          html += '<span class="docker-error-summary" style="color:#d29922">' + totalWarns + ' warn</span>';
        }
        html += '</h2>';
        html += '<div class="container-grid section-body' + (dCollapsed ? ' collapsed' : '') + '">';
        containers.forEach(function(c) {
          html += renderContainerCard(c);
        });
        html += '</div>';
        html += '</section>';
      });

      container.innerHTML = html;
    }

    function renderContainerCard(c) {
      var logStats = STATE.dockerLogStats[c.id];
      var isRunning = c.state === 'running';
      var isStopped = c.state === 'exited' || c.state === 'dead';

      var html = '<div class="container-card' + (isStopped ? ' stopped' : '') + '">';

      // Header: state dot + service name + actions
      html += '<div class="container-header">';
      html += '<span class="container-state-dot ' + c.state + '"></span>';
      html += '<span class="container-name">' + escapeHtml(c.service || c.name) + '</span>';
      html += '<div class="container-actions">';
      if (isRunning) {
        html += '<button class="container-btn stop" onclick="stopDockerContainer(\\'' + escapeJs(c.id) + '\\', \\'' + escapeJs(c.service || c.name) + '\\')" title="Stop container">Stop</button>';
        // Show "Agent" button if an agent has registered on the same port
        var containerPort = extractHostPort(c.ports);
        var agentSvc = containerPort ? findAgentServiceByPort(containerPort) : null;
        if (agentSvc) {
          html += '<button class="container-btn logs" onclick="switchToAgent(\\'' + escapeJs(c.id) + '\\', \\'' + escapeJs(c.service || c.name) + '\\', \\'' + escapeJs(agentSvc.peer_id) + '\\')"'
            + ' title="Stop Docker, tell agent to start" style="color:#58a6ff;border-color:#58a6ff">Agent</button>';
        }
      }
      html += '<button class="container-btn logs" onclick="openDockerLogViewer(\\'' + escapeJs(c.id) + '\\', \\'' + escapeJs(c.service || c.name) + '\\')" title="View logs">Logs</button>';
      html += '</div>';
      html += '</div>';

      // Status + health
      html += '<div class="container-status">' + escapeHtml(c.status);
      if (c.health) html += ' &middot; ' + escapeHtml(c.health);
      html += '</div>';

      // Ports
      if (c.ports) {
        html += '<div class="container-ports">' + escapeHtml(c.ports) + '</div>';
      }

      // Resources (only for running containers with stats)
      if (isRunning && c.cpuPerc) {
        html += '<div class="container-resources">';
        html += '<span>CPU ' + escapeHtml(c.cpuPerc) + '</span>';
        html += '<span>MEM ' + escapeHtml(c.memPerc) + '</span>';
        html += '<span>' + escapeHtml(c.memUsage) + '</span>';
        html += '</div>';
      }

      // Image
      html += '<div class="container-image">' + escapeHtml(c.image) + '</div>';

      // Log stats
      if (logStats && logStats.totalLines > 0) {
        html += '<div class="container-log-stats" onclick="openDockerLogViewer(\\'' + escapeJs(c.id) + '\\', \\'' + escapeJs(c.service || c.name) + '\\')">';
        if (logStats.errorCount > 0) html += '<span style="color:#f85149;font-weight:600">' + logStats.errorCount + ' errors</span>';
        if (logStats.warnCount > 0) html += '<span style="color:#d29922;font-weight:500">' + logStats.warnCount + ' warn</span>';
        html += '<span style="color:#484f58">' + logStats.totalLines + ' lines</span>';
        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    function stopDockerContainer(containerId, serviceName) {
      if (!confirm('Stop container ' + serviceName + '?')) return;
      wsSend({ type: 'stop_docker_container', containerId: containerId });
      addActivity('Stopping container ' + serviceName);
    }

    function openDockerLogViewer(containerId, serviceName) {
      // Close any existing peer log subscription
      if (STATE.logViewerPeer) {
        wsSend({ type: 'unsubscribe_logs', peer_id: STATE.logViewerPeer });
        STATE.logViewerPeer = null;
      }

      STATE.logLines = [];
      STATE.dockerLogViewerContainer = containerId;

      // Reset filter state
      logFilter = '';
      logAutoScroll = true;
      logActiveLevels = { ERROR: true, WARN: true, INFO: true, DEBUG: true, TRACE: false };

      var overlay = $('logViewerModal');
      overlay.style.display = 'flex';
      $('logViewerTitle').textContent = 'Logs: ' + serviceName + ' (Docker)';
      $('logFilterInput').value = '';

      renderLogLevelButtons();
      renderLogLines();

      wsSend({ type: 'subscribe_docker_logs', containerId: containerId });
    }

    function switchToAgent(containerId, serviceName, agentPeerId) {
      wsSend({ type: 'stop_docker_container', containerId: containerId });
      wsSend({ type: 'send_to_peer', peer_id: agentPeerId, message: START_SERVICE_MESSAGE });
      addActivity('Switching ' + serviceName + ' to Agent (' + agentPeerId + ')');
    }
  `;
}
