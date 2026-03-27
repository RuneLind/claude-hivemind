// WebSocket connection management

export function connectionScript(): string {
  return `
    var ws = null;
    var reconnectTimer = null;
    var wsConnected = false;

    function connectWs() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      ws = new WebSocket('ws://' + location.host + '/ws/dashboard');

      ws.onopen = function() {
        wsConnected = true;
        updateConnectionStatus(true);
        addActivity('Connected to broker');
      };

      ws.onclose = function() {
        wsConnected = false;
        updateConnectionStatus(false);
        addActivity('Disconnected from broker');
        reconnectTimer = setTimeout(connectWs, 2000);
      };

      ws.onmessage = function(event) {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      };
    }

    function wsSend(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }

    function updateConnectionStatus(connected) {
      var el = $('connectionStatus');
      if (!el) return;
      el.className = 'status ' + (connected ? 'connected' : 'disconnected');
      el.textContent = connected ? 'Live' : 'Disconnected';
    }
  `;
}
