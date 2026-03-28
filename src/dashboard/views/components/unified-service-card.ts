// Unified service card component — shows services from Docker and/or Agent sources

export function unifiedServiceCardStyles(): string {
  return `
    .unified-section { margin-bottom: 28px; }
    .unified-section h2 {
      display: flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 500; color: #e6edf3;
      margin-bottom: 12px; padding: 8px 12px;
      background: #161b22; border-radius: 6px;
      border-left: 3px solid #da70d6;
    }
    .unified-count {
      background: #21262d; color: #8b949e;
      font-size: 11px; padding: 2px 8px;
      border-radius: 10px; font-weight: 400;
    }
    .unified-add-btn {
      margin-left: auto;
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .unified-add-btn:hover { border-color: #da70d6; color: #da70d6; }
    .unified-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 12px;
    }
    .unified-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 14px 16px;
      border-left: 3px solid #484f58;
      transition: border-color 0.2s;
    }
    .unified-card:hover { border-color: #30363d; }
    .unified-card.source-docker { border-left-color: #56d4dd; }
    .unified-card.source-agent { border-left-color: #58a6ff; }
    .unified-card.source-both { border-left-color: #d29922; }
    .unified-card.source-none { opacity: 0.5; }
    .unified-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    }
    .unified-name { font-weight: 600; color: #e6edf3; font-size: 14px; }
    .unified-port { color: #8b949e; font-size: 12px; }
    .unified-source-badge {
      font-size: 10px; padding: 2px 8px;
      border-radius: 10px; border: 1px solid; font-weight: 500;
    }
    .unified-source-badge.docker { color: #56d4dd; border-color: #56d4dd; }
    .unified-source-badge.agent { color: #58a6ff; border-color: #58a6ff; }
    .unified-source-badge.both { color: #d29922; border-color: #d29922; }
    .unified-source-badge.none { color: #484f58; border-color: #484f58; }
    .unified-actions {
      display: flex; gap: 6px; margin-left: auto;
    }
    .unified-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .unified-btn.logs:hover { border-color: #da70d6; color: #da70d6; }
    .unified-btn.stop:hover { border-color: #f85149; color: #f85149; }
    .unified-btn.switch:hover { border-color: #3fb950; color: #3fb950; }
    .unified-btn.edit:hover { border-color: #8b949e; color: #e6edf3; }
    .unified-sources {
      display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;
    }
    .unified-source {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #8b949e;
      padding: 3px 8px; border-radius: 4px;
    }
    .unified-source.active { color: #c9d1d9; background: #1f2a37; }
    .unified-source .source-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .unified-source.active .source-dot { background: #3fb950; }
    .unified-source:not(.active) .source-dot { background: #484f58; }
    .unified-source.missing { display: none; }
    .unified-conflict {
      color: #d29922; font-size: 11px;
      padding: 4px 8px; margin-bottom: 6px;
      background: rgba(210, 153, 34, 0.1);
      border-radius: 4px;
    }
    .unified-log-stats {
      display: flex; gap: 8px; font-size: 11px;
      padding: 4px 8px; margin-left: -8px; margin-right: -8px;
      border-radius: 4px; cursor: pointer; transition: all 0.15s;
    }
    .unified-log-stats:hover {
      background: #1f2a37;
      box-shadow: 0 0 8px rgba(218, 112, 214, 0.15);
    }
  `;
}

export function unifiedServiceCardScript(): string {
  return `
    function resolveUnifiedService(mapping) {
      // Find matching Docker container
      var dockerMatch = null;
      if (mapping.docker_service) {
        for (var i = 0; i < STATE.dockerContainers.length; i++) {
          var c = STATE.dockerContainers[i];
          if (c.service === mapping.docker_service &&
              (!mapping.docker_project || c.project === mapping.docker_project)) {
            dockerMatch = c;
            break;
          }
        }
      }

      // Find matching agent service
      var agentMatch = null;
      var agentPeerId = null;
      if (mapping.agent_port) {
        for (var i = 0; i < STATE.services.length; i++) {
          var s = STATE.services[i];
          if (s.port === mapping.agent_port) {
            agentMatch = s;
            agentPeerId = s.peer_id;
            break;
          }
        }
      }

      var dockerRunning = dockerMatch && dockerMatch.state === 'running';
      var agentRunning = agentMatch && agentMatch.status === 'up';

      // When Docker is running on the same port, the agent health check
      // hits Docker's port and falsely reports "up". Detect this: if Docker
      // exposes the agent_port, the agent isn't really running its own process.
      var dockerOwnsPort = false;
      if (dockerRunning && agentRunning && mapping.agent_port && dockerMatch) {
        var dockerPort = extractHostPort(dockerMatch.ports);
        if (dockerPort === mapping.agent_port) {
          dockerOwnsPort = true;
        }
      }

      var activeSource;
      if (dockerRunning && agentRunning && !dockerOwnsPort) activeSource = 'both';
      else if (dockerRunning) activeSource = 'docker';
      else if (agentRunning) activeSource = 'agent';
      else activeSource = 'none';

      return {
        mapping: mapping,
        dockerContainer: dockerMatch,
        dockerLogStats: dockerMatch ? STATE.dockerLogStats[dockerMatch.id] : null,
        agentService: agentMatch,
        agentPeerId: agentPeerId,
        agentLogStats: agentPeerId ? STATE.logStatsMap[agentPeerId] : null,
        activeSource: activeSource
      };
    }

    function renderUnifiedServices() {
      var container = $('unifiedServicesContainer');
      if (!container) return;

      // Only show if Docker or agent services exist (potential things to map)
      if (STATE.dockerContainers.length === 0 && STATE.services.length === 0 && STATE.serviceMappings.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';

      var resolved = STATE.serviceMappings.map(resolveUnifiedService);
      var running = resolved.filter(function(r) { return r.activeSource !== 'none'; }).length;

      var html = '<section class="unified-section">';
      html += '<h2>Services';
      if (resolved.length > 0) {
        html += '<span class="unified-count">' + running + '/' + resolved.length + ' running</span>';
      }
      html += '<button class="unified-add-btn" onclick="openMappingModal()">+ Add</button>';
      html += '</h2>';
      if (resolved.length > 0) {
        html += '<div class="unified-grid">';
        resolved.forEach(function(r) {
          html += renderUnifiedCard(r);
        });
        html += '</div>';
      }
      html += '</section>';

      container.innerHTML = html;
    }

    function renderUnifiedCard(r) {
      var m = r.mapping;
      var port = m.agent_port || (r.dockerContainer ? extractHostPort(r.dockerContainer.ports) : null);

      var html = '<div class="unified-card source-' + r.activeSource + '">';

      // Header
      html += '<div class="unified-header">';
      html += '<span class="unified-name">' + escapeHtml(m.display_name) + '</span>';
      if (port) html += '<span class="unified-port">:' + port + '</span>';

      // Source badge
      var badgeLabel = r.activeSource === 'docker' ? 'Docker'
        : r.activeSource === 'agent' ? 'Agent'
        : r.activeSource === 'both' ? 'Conflict'
        : 'Stopped';
      html += '<span class="unified-source-badge ' + r.activeSource + '">' + badgeLabel + '</span>';

      // Actions
      html += '<div class="unified-actions">';
      if (r.activeSource !== 'none') {
        html += '<button class="unified-btn logs" onclick="openUnifiedLogs(' + m.id + ')" title="View logs">Logs</button>';
        html += '<button class="unified-btn stop" onclick="stopUnified(' + m.id + ')" title="Stop active source">Stop</button>';
      }
      if (m.docker_service && m.agent_port) {
        var switchLabel = r.activeSource === 'docker' ? 'Use Agent' : 'Use Docker';
        if (r.activeSource === 'docker' || r.activeSource === 'agent') {
          html += '<button class="unified-btn switch" onclick="switchUnifiedSource(' + m.id + ')" title="' + switchLabel + '">' + switchLabel + '</button>';
        }
      }
      html += '<button class="unified-btn edit" onclick="editMapping(' + m.id + ')" title="Edit mapping">&#9881;</button>';
      html += '</div>';
      html += '</div>';

      // Source rows
      html += '<div class="unified-sources">';
      if (m.docker_service) {
        var dActive = r.dockerContainer && r.dockerContainer.state === 'running';
        html += '<div class="unified-source' + (dActive ? ' active' : '') + '">';
        html += '<span class="source-dot"></span>';
        html += 'Docker: ';
        if (r.dockerContainer) {
          html += escapeHtml(r.dockerContainer.status);
          if (r.dockerContainer.health) html += ' (' + escapeHtml(r.dockerContainer.health) + ')';
          if (dActive && r.dockerContainer.cpuPerc) html += ' &middot; CPU ' + escapeHtml(r.dockerContainer.cpuPerc);
        } else {
          html += 'not found';
        }
        html += '</div>';
      }
      if (m.agent_port) {
        var aActive = r.agentService && r.agentService.status === 'up';
        html += '<div class="unified-source' + (aActive ? ' active' : '') + '">';
        html += '<span class="source-dot"></span>';
        html += 'Agent';
        if (r.agentPeerId) html += ' (' + escapeHtml(r.agentPeerId) + ')';
        html += ': ';
        if (r.agentService) {
          html += r.agentService.status;
          if (r.agentService.last_check) html += ' &middot; ' + timeAgo(r.agentService.last_check);
        } else {
          html += 'not registered';
        }
        html += '</div>';
      }
      html += '</div>';

      // Conflict warning
      if (r.activeSource === 'both') {
        html += '<div class="unified-conflict">&#9888; Both Docker and Agent are running' + (port ? ' on port ' + port : '') + '</div>';
      }

      // Log stats from active source
      var logStats = r.activeSource === 'docker' ? r.dockerLogStats
        : r.activeSource === 'agent' ? r.agentLogStats
        : r.dockerLogStats || r.agentLogStats;

      if (logStats) {
        var errors = logStats.errorCount || logStats.ERROR || 0;
        var warns = logStats.warnCount || logStats.WARN || 0;
        var total = logStats.totalLines || logStats.total || 0;
        if (total > 0) {
          html += '<div class="unified-log-stats" onclick="openUnifiedLogs(' + m.id + ')">';
          if (errors > 0) html += '<span style="color:#f85149;font-weight:600">' + errors + ' errors</span>';
          if (warns > 0) html += '<span style="color:#d29922;font-weight:500">' + warns + ' warn</span>';
          html += '<span style="color:#484f58">' + total + ' lines</span>';
          html += '</div>';
        }
      }

      html += '</div>';
      return html;
    }

    function extractHostPort(portsStr) {
      if (!portsStr) return null;
      var m = portsStr.match(/(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|::):(\\d+)->/);
      return m ? parseInt(m[1], 10) : null;
    }

    function findResolvedService(mappingId) {
      for (var i = 0; i < STATE.serviceMappings.length; i++) {
        if (STATE.serviceMappings[i].id === mappingId) {
          return resolveUnifiedService(STATE.serviceMappings[i]);
        }
      }
      return null;
    }

    function openUnifiedLogs(mappingId) {
      var r = findResolvedService(mappingId);
      if (!r) return;
      if (r.activeSource === 'agent' && r.agentPeerId) {
        openLogViewer(r.agentPeerId);
      } else if (r.dockerContainer) {
        openDockerLogViewer(r.dockerContainer.id, r.dockerContainer.service || r.dockerContainer.name);
      }
    }

    function stopUnified(mappingId) {
      var r = findResolvedService(mappingId);
      if (!r) return;
      if (!confirm('Stop ' + r.mapping.display_name + '?')) return;

      if (r.activeSource === 'agent' || r.activeSource === 'both') {
        if (r.agentPeerId) {
          wsSend({ type: 'stop_service', peer_id: r.agentPeerId });
        }
      }
      if (r.activeSource === 'docker' || r.activeSource === 'both') {
        if (r.dockerContainer) {
          wsSend({ type: 'stop_docker_container', containerId: r.dockerContainer.id });
        }
      }
      addActivity('Stopping ' + r.mapping.display_name);
    }

    function switchUnifiedSource(mappingId) {
      var r = findResolvedService(mappingId);
      if (!r) return;

      if (r.activeSource === 'docker') {
        // Switch to Agent: stop Docker
        if (r.dockerContainer) {
          wsSend({ type: 'stop_docker_container', containerId: r.dockerContainer.id });
          addActivity('Switching ' + r.mapping.display_name + ' to Agent (stopping Docker)');
        }
      } else if (r.activeSource === 'agent') {
        // Switch to Docker: stop Agent, start Docker container
        if (r.agentPeerId) {
          wsSend({ type: 'stop_service', peer_id: r.agentPeerId });
        }
        if (r.dockerContainer && r.dockerContainer.state !== 'running') {
          // Start the docker container via a fetch to avoid needing a new WS message type
          fetch('/api/docker/start?name=' + encodeURIComponent(r.dockerContainer.name), { method: 'POST' });
        }
        addActivity('Switching ' + r.mapping.display_name + ' to Docker (stopping Agent)');
      }
    }
  `;
}
