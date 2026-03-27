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
    };

    var MAX_LOG_LINES = 1000;

    var START_SERVICE_MESSAGE = 'Please ensure your application is running and healthy, then register it:\\n\\n' +
      '1. **Build**: Run a clean build (e.g. \`mvn package -DskipTests\`) to ensure you have the latest version.\\n' +
      '2. **Kill zombies**: Check if anything is already running on your application port (e.g. \`lsof -i :<port> -t\`). If a process is found, kill it before starting fresh.\\n' +
      '3. **Start**: Start the application with the appropriate local profile.\\n' +
      '4. **Health check**: Wait for the application to be ready, then verify the health endpoint returns a healthy status (e.g. curl the health URL and confirm \`"status":"UP"\`). Common health paths: \`/internal/health\`, \`/actuator/health\`, \`/health\`.\\n' +
      '5. **Register**: Once healthy, call \`register_service\` with the correct port, health URL, log format, and **log_file** (absolute path to the application log file, e.g. \`target/app.log\` or check \`logging.file.name\` in application properties). The log_file is required for log viewing in the dashboard.';

    function handleMessage(msg) {
      switch (msg.type) {
        case 'snapshot':
          STATE.peers = msg.peers;
          STATE.peerStats = msg.peer_stats || [];
          STATE.pairStats = msg.pair_stats || [];
          STATE.services = msg.services || [];
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
          STATE.logStatsMap = {};
          addActivity('Baseline set for ' + msg.namespace);
          renderAll();
          break;

        case 'baseline_cleared':
          delete STATE.baselines[msg.namespace];
          STATE.logStatsMap = {};
          addActivity('Baseline cleared for ' + msg.namespace);
          renderAll();
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
