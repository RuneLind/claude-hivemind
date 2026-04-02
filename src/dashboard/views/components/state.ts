// Global state and message routing

export function stateScript(): string {
  return `
    var STATE = {
      peers: [],
      peerStats: [],
      pairStats: [],
      services: [],
      activity: [],
      logStatsMap: {},
      baselines: {},
      graphView: {},
      logViewerPeer: null,
      logLines: [],
      dockerContainers: [],
      dockerLogStats: {},
      dockerLogViewerContainer: null,
      collapsed: {},
      cmuxAvailable: false,
      cmuxWorkspaces: [],
      profiles: [],
    };

    var MAX_LOG_LINES = 1000;

    var START_SERVICE_MESSAGE = 'Build, start, and register your application locally.\\n\\n' +
      '1. **Build (MANDATORY)**: Run a clean Maven build (\`mvn clean package -DskipTests\`). This step is NOT optional — always build from the current branch, even if the app appears to be running already.\\n' +
      '2. **Stop Docker container**: Check if a Docker container is running on your application port (e.g. \`docker ps --format \\'{{.Names}} {{.Ports}}\\' | grep <port>\`). If found, stop it (\`docker stop <container-name>\`). Docker compose containers often have stale/wrong versions — do NOT reuse them.\\n' +
      '3. **Kill other zombies**: Check for any other process on your port (\`lsof -i :<port> -t\`). Kill if found.\\n' +
      '4. **Start locally with Maven**: Start the app using \`mvn spring-boot:run\` with the appropriate local profile (NOT via Docker). This runs the freshly built code from step 1.\\n' +
      '5. **Health check**: Wait for the app to be ready, then verify the health endpoint returns \`{"status":"UP"}\`. Common paths: \`/internal/health\`, \`/actuator/health\`, \`/health\`.\\n' +
      '6. **Register**: Call \`register_service\` with port, health URL, log format, and **log_file** (absolute path to the application log file, e.g. \`target/app.log\` or check \`logging.file.name\` in application properties). The log_file is required for log viewing in the dashboard.';

    function handleMessage(msg) {
      switch (msg.type) {
        case 'snapshot':
          STATE.peers = msg.peers;
          STATE.peerStats = msg.peer_stats || [];
          STATE.pairStats = msg.pair_stats || [];
          STATE.services = msg.services || [];
          STATE.profiles = msg.profiles || [];
          STATE.baselines = {};
          (msg.baselines || []).forEach(function(b) { STATE.baselines[b.namespace] = b.baseline_at; });
          addActivity('Loaded ' + msg.peers.length + ' peer(s)');
          renderAll();
          break;

        case 'peer_joined':
          STATE.peers = STATE.peers.filter(function(p) { return p.id !== msg.peer.id; });
          STATE.peers.push(msg.peer);
          addActivity(msg.peer.id + ' joined (' + msg.peer.namespace + ')');
          renderAll();
          break;

        case 'peer_left':
          STATE.peers = STATE.peers.filter(function(p) { return p.id !== msg.peer_id; });
          addActivity(msg.peer_id + ' left');
          renderAll();
          break;

        case 'peer_updated':
          STATE.peers = STATE.peers.map(function(p) { return p.id === msg.peer.id ? msg.peer : p; });
          renderAll();
          break;

        case 'message_sent':
          STATE.peerStats = msg.peer_stats || [];
          STATE.pairStats = msg.pair_stats || [];
          addActivity(msg.from_id + ' \\u2192 ' + msg.to_id + ': ' + msg.text.slice(0, 60));
          renderAll();
          break;

        case 'messages_cleared':
          STATE.peerStats = [];
          STATE.pairStats = [];
          addActivity('Message history cleared');
          renderAll();
          break;

        case 'service_update': {
          var old = STATE.services.find(function(s) { return s.peer_id === msg.service.peer_id; });
          if (old && old.status !== msg.service.status) {
            addActivity('Service ' + msg.service.peer_id + ' :' + msg.service.port + ' \\u2192 ' + msg.service.status);
          }
          STATE.services = STATE.services.filter(function(s) { return s.peer_id !== msg.service.peer_id; });
          STATE.services.push(msg.service);
          renderAll();
          break;
        }

        case 'log_lines':
          STATE.logLines = STATE.logLines.concat(msg.lines);
          if (STATE.logLines.length > MAX_LOG_LINES) {
            STATE.logLines = STATE.logLines.slice(-MAX_LOG_LINES);
          }
          renderLogLines();
          break;

        case 'baseline_set':
          STATE.baselines[msg.namespace] = msg.baseline_at;
          STATE.peers.forEach(function(p) {
            if (p.namespace === msg.namespace) delete STATE.logStatsMap[p.id];
          });
          addActivity('Baseline set for ' + msg.namespace);
          renderAll();
          break;

        case 'baseline_cleared':
          delete STATE.baselines[msg.namespace];
          STATE.peers.forEach(function(p) {
            if (p.namespace === msg.namespace) delete STATE.logStatsMap[p.id];
          });
          addActivity('Baseline cleared for ' + msg.namespace);
          renderAll();
          break;

        case 'docker_snapshot':
          STATE.dockerContainers = msg.containers || [];
          STATE.dockerLogStats = {};
          (msg.logStats || []).forEach(function(s) { STATE.dockerLogStats[s.containerId] = s; });
          addActivity('Loaded ' + STATE.dockerContainers.length + ' Docker container(s)');
          renderAll();
          break;

        case 'docker_update':
          STATE.dockerContainers = msg.containers || [];
          renderAll();
          break;

        case 'docker_event':
          STATE.dockerContainers = STATE.dockerContainers.filter(function(c) { return c.id !== msg.containerId; });
          if (msg.container) {
            STATE.dockerContainers.push(msg.container);
          }
          addActivity('Container ' + (msg.container ? msg.container.service || msg.container.name : msg.containerId) + ': ' + msg.event);
          renderAll();
          break;

        case 'docker_log_lines':
          STATE.logLines = STATE.logLines.concat(msg.lines);
          if (STATE.logLines.length > MAX_LOG_LINES) {
            STATE.logLines = STATE.logLines.slice(-MAX_LOG_LINES);
          }
          renderLogLines();
          break;

        case 'docker_log_stats': {
          var statsChanged = false;
          (msg.logStats || []).forEach(function(s) {
            var prev = STATE.dockerLogStats[s.containerId];
            if (!prev || prev.errorCount !== s.errorCount || prev.warnCount !== s.warnCount || prev.totalLines !== s.totalLines) {
              STATE.dockerLogStats[s.containerId] = s;
              statsChanged = true;
            }
          });
          if (statsChanged) renderAll();
          break;
        }

        case 'cmux_status': {
          var ws = msg.workspaces || [];
          var changed = STATE.cmuxAvailable !== msg.available || STATE.cmuxWorkspaces.length !== ws.length;
          if (!changed) {
            for (var i = 0; i < ws.length; i++) {
              if (!STATE.cmuxWorkspaces[i] || STATE.cmuxWorkspaces[i].id !== ws[i].id) { changed = true; break; }
            }
          }
          if (changed) {
            STATE.cmuxAvailable = msg.available;
            STATE.cmuxWorkspaces = ws;
            renderAll();
          }
          break;
        }

        case 'cmux_launch_result':
          if (msg.ok) {
            addActivity('Launched Claude instance (workspace: ' + (msg.workspaceId || '?') + ')');
          } else {
            addActivity('Failed to launch: ' + (msg.error || 'unknown'));
            var errEl = document.getElementById('launchError');
            if (errEl) { errEl.textContent = msg.error || 'Launch failed'; errEl.style.display = ''; }
          }
          break;

        case 'scan_repos_result':
          if (typeof handleScanResult === 'function') handleScanResult(msg.repos || []);
          break;

        case 'profiles_list':
          STATE.profiles = msg.profiles || [];
          renderProfileList();
          break;

        case 'profile_saved': {
          var idx = STATE.profiles.findIndex(function(p) { return p.id === msg.profile.id; });
          if (idx >= 0) {
            STATE.profiles[idx] = msg.profile;
          } else {
            STATE.profiles.push(msg.profile);
          }
          renderProfileList();
          addActivity('Profile saved: ' + msg.profile.name);
          break;
        }

        case 'profile_deleted':
          STATE.profiles = STATE.profiles.filter(function(p) { return p.id !== msg.profileId; });
          renderProfileList();
          addActivity('Profile deleted');
          break;

      }
    }

    function getPeerStatsMap() {
      var map = {};
      STATE.peerStats.forEach(function(s) { map[s.peer_id] = s; });
      return map;
    }

    function getServiceMap() {
      var map = {};
      STATE.services.forEach(function(s) { map[s.peer_id] = s; });
      return map;
    }

    function getTotalMessages() {
      return STATE.peerStats.reduce(function(sum, s) { return sum + s.sent; }, 0);
    }
  `;
}
