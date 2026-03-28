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
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }
    .unified-card {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 10px 12px;
      border-left: 3px solid #484f58;
      transition: border-color 0.2s;
    }
    .unified-card:hover { border-color: #30363d; }
    .unified-card.source-docker { border-left-color: #56d4dd; }
    .unified-card.source-agent { border-left-color: #58a6ff; }
    .unified-card.source-both { border-left-color: #d29922; }
    .unified-card.source-none { opacity: 0.5; border-left-color: #484f58; }
    .unified-header {
      display: flex; align-items: center; gap: 6px;
    }
    .unified-name { font-weight: 600; color: #e6edf3; font-size: 13px; }
    .unified-port {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; padding: 1px 6px;
      border-radius: 10px; border: 1px solid;
      cursor: default;
    }
    .unified-port.healthy { color: #3fb950; border-color: #3fb950; }
    .unified-port.unhealthy { color: #f85149; border-color: #f85149; }
    .unified-port.unknown { color: #484f58; border-color: #484f58; }
    .unified-port-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: currentColor;
    }
    .unified-source-badge {
      font-size: 10px; padding: 1px 6px;
      border-radius: 10px; border: 1px solid; font-weight: 500;
    }
    .unified-source-badge.docker { color: #56d4dd; border-color: #56d4dd; }
    .unified-source-badge.agent { color: #58a6ff; border-color: #58a6ff; }
    .unified-source-badge.both { color: #d29922; border-color: #d29922; }
    .unified-source-badge.none { color: #484f58; border-color: #484f58; }
    .unified-actions {
      display: flex; gap: 4px; margin-left: auto; flex-shrink: 0;
    }
    .unified-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 10px;
      padding: 2px 8px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    .unified-btn.logs:hover { border-color: #da70d6; color: #da70d6; }
    .unified-btn.stop:hover { border-color: #f85149; color: #f85149; }
    .unified-btn.switch:hover { border-color: #3fb950; color: #3fb950; }
    .unified-btn.edit:hover { border-color: #8b949e; color: #e6edf3; }
    .unified-detail {
      display: flex; align-items: center; gap: 8px;
      margin-top: 6px; font-size: 11px; color: #484f58;
      flex-wrap: wrap;
    }
    .unified-conflict {
      color: #d29922; font-size: 10px;
      padding: 2px 6px; margin-top: 4px;
      background: rgba(210, 153, 34, 0.1);
      border-radius: 4px;
    }
    .unified-log-stats {
      display: inline-flex; gap: 6px; font-size: 11px;
      cursor: pointer; transition: color 0.15s;
    }
    .unified-log-stats:hover { color: #8b949e; }
  `;
}

export function unifiedServiceCardScript(): string {
  return `
    function resolveUnifiedService(mapping) {
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

      // Determine health status
      var healthy;
      if (activeSource === 'docker') {
        healthy = dockerMatch.health === 'healthy' || dockerMatch.state === 'running' ? 'healthy' : 'unhealthy';
      } else if (activeSource === 'agent') {
        healthy = agentMatch.status === 'up' ? 'healthy' : 'unhealthy';
      } else if (activeSource === 'both') {
        healthy = 'healthy';
      } else {
        healthy = 'unknown';
      }

      var lastCheck = null;
      if (activeSource === 'agent' && agentMatch && agentMatch.last_check) {
        lastCheck = agentMatch.last_check;
      } else if (activeSource === 'docker' && dockerMatch) {
        lastCheck = null; // Docker health is from polling, no per-service timestamp
      }

      return {
        mapping: mapping,
        dockerContainer: dockerMatch,
        dockerLogStats: dockerMatch ? STATE.dockerLogStats[dockerMatch.id] : null,
        agentService: agentMatch,
        agentPeerId: agentPeerId,
        agentLogStats: agentPeerId ? STATE.logStatsMap[agentPeerId] : null,
        activeSource: activeSource,
        dockerOwnsPort: dockerOwnsPort,
        healthy: healthy,
        lastCheck: lastCheck
      };
    }

    function renderUnifiedServices() {
      var container = $('unifiedServicesContainer');
      if (!container) return;

      if (STATE.dockerContainers.length === 0 && STATE.services.length === 0 && STATE.serviceMappings.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';

      var resolved = STATE.serviceMappings.map(resolveUnifiedService);
      var running = resolved.filter(function(r) { return r.activeSource !== 'none'; }).length;

      var svcCollapsed = STATE.collapsed['services'];
      var html = '<section class="unified-section">';
      html += '<h2>' + collapseToggleHtml('services') + ' Services';
      if (resolved.length > 0) {
        html += '<span class="unified-count">' + running + '/' + resolved.length + ' running</span>';
      }
      html += '<button class="unified-add-btn" onclick="openMappingModal()">+ Add</button>';
      html += '</h2>';
      if (resolved.length > 0) {
        html += '<div class="unified-grid section-body' + (svcCollapsed ? ' collapsed' : '') + '">';
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

      // Single header row: name, health port, badge, actions
      html += '<div class="unified-header">';
      html += '<span class="unified-name">' + escapeHtml(m.display_name) + '</span>';

      // Port with health color and tooltip
      if (port) {
        var tooltip = r.healthy === 'healthy' ? 'Healthy' : r.healthy === 'unhealthy' ? 'Unhealthy' : 'Not running';
        if (r.lastCheck) tooltip += ' (checked ' + timeAgo(r.lastCheck) + ')';
        html += '<span class="unified-port ' + r.healthy + '" title="' + tooltip + '">';
        html += '<span class="unified-port-dot"></span>';
        html += ':' + port;
        html += '</span>';
      }

      // Source badge
      var badgeLabel = r.activeSource === 'docker' ? 'Docker'
        : r.activeSource === 'agent' ? 'Agent'
        : r.activeSource === 'both' ? 'Conflict'
        : 'Stopped';
      html += '<span class="unified-source-badge ' + r.activeSource + '">' + badgeLabel + '</span>';

      // Action buttons inline
      html += '<div class="unified-actions">';
      if (r.activeSource !== 'none') {
        html += '<button class="unified-btn logs" onclick="openUnifiedLogs(' + m.id + ')" title="View logs">Logs</button>';
        html += '<button class="unified-btn stop" onclick="stopUnified(' + m.id + ')" title="Stop">Stop</button>';
      }
      if (m.docker_service && m.agent_port) {
        if (r.activeSource === 'docker') {
          html += '<button class="unified-btn switch" onclick="switchUnifiedSource(' + m.id + ')" title="Stop Docker, tell agent to start the app">Agent</button>';
        } else if (r.activeSource === 'agent') {
          html += '<button class="unified-btn switch" onclick="switchUnifiedSource(' + m.id + ')" title="Stop agent, start Docker container">Docker</button>';
        } else if (r.activeSource === 'none') {
          html += '<button class="unified-btn switch" onclick="switchUnifiedSource(' + m.id + ')" title="Start Docker container">Docker</button>';
        }
      }
      html += '<button class="unified-btn edit" onclick="editMapping(' + m.id + ')" title="Edit mapping">&#9881;</button>';
      html += '</div>';
      html += '</div>';

      // Detail row: source info + log stats
      html += '<div class="unified-detail">';
      if (r.activeSource === 'docker' && r.dockerContainer) {
        html += '<span>' + escapeHtml(r.dockerContainer.status) + '</span>';
        if (r.dockerContainer.cpuPerc) html += '<span>CPU ' + escapeHtml(r.dockerContainer.cpuPerc) + '</span>';
      } else if (r.activeSource === 'agent' && r.agentPeerId) {
        html += '<span>via ' + escapeHtml(r.agentPeerId) + '</span>';
      } else if (r.activeSource === 'both') {
        html += '<span>Docker + Agent</span>';
      }

      // Log stats inline
      var logStats = r.activeSource === 'docker' ? r.dockerLogStats
        : r.activeSource === 'agent' ? r.agentLogStats
        : r.dockerLogStats || r.agentLogStats;
      if (logStats) {
        var errors = logStats.errorCount || logStats.ERROR || 0;
        var warns = logStats.warnCount || logStats.WARN || 0;
        var total = logStats.totalLines || logStats.total || 0;
        if (total > 0) {
          html += '<span class="unified-log-stats" onclick="openUnifiedLogs(' + m.id + ')">';
          if (errors > 0) html += '<span style="color:#f85149;font-weight:600">' + errors + ' err</span>';
          if (warns > 0) html += '<span style="color:#d29922">' + warns + ' warn</span>';
          html += '<span>' + total + ' lines</span>';
          html += '</span>';
        }
      }
      html += '</div>';

      // Conflict warning
      if (r.activeSource === 'both') {
        html += '<div class="unified-conflict">&#9888; Both running on port ' + (port || '?') + '</div>';
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

      if (r.activeSource === 'docker' || r.activeSource === 'none') {
        // Switch to Agent: stop Docker, tell agent to start the app
        if (r.dockerContainer && r.dockerContainer.state === 'running') {
          wsSend({ type: 'stop_docker_container', containerId: r.dockerContainer.id });
        }
        if (r.agentPeerId) {
          wsSend({ type: 'send_to_peer', peer_id: r.agentPeerId, message: START_SERVICE_MESSAGE });
          addActivity('Switching ' + r.mapping.display_name + ' to Agent');
        }
      } else if (r.activeSource === 'agent') {
        // Switch to Docker: stop Agent, start Docker container
        if (r.agentPeerId) {
          wsSend({ type: 'stop_service', peer_id: r.agentPeerId });
        }
        if (r.dockerContainer) {
          fetch('/api/docker/start?name=' + encodeURIComponent(r.dockerContainer.name), { method: 'POST' });
        }
        addActivity('Switching ' + r.mapping.display_name + ' to Docker');
      }
    }
  `;
}
