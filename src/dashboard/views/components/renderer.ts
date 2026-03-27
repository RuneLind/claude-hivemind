// Main render orchestration — ties all components together

export function rendererScript(): string {
  return `
    function renderAll() {
      renderHeader();
      renderNamespaces();
      renderActivityLog();
    }

    function renderHeader() {
      var countEl = $('peerCount');
      if (countEl) {
        var n = STATE.peers.length;
        countEl.textContent = n + ' peer' + (n !== 1 ? 's' : '');
      }

      var total = getTotalMessages();
      var clearBtn = $('clearBtn');
      if (clearBtn) {
        if (total > 0) {
          clearBtn.style.display = '';
          clearBtn.textContent = 'Clear history (' + total + ')';
        } else {
          clearBtn.style.display = 'none';
        }
      }
    }

    function renderNamespaces() {
      var container = $('namespacesContainer');
      if (!container) return;

      var grouped = {};
      STATE.peers.forEach(function(peer) {
        if (!grouped[peer.namespace]) grouped[peer.namespace] = [];
        grouped[peer.namespace].push(peer);
      });

      var namespaces = Object.keys(grouped).sort();

      if (namespaces.length === 0) {
        container.innerHTML = '<div class="empty">No peers connected. Start a Claude Code session to see it here.</div>';
        return;
      }

      var statsMap = getPeerStatsMap();
      var svcMap = getServiceMap();

      var html = '';
      namespaces.forEach(function(ns) {
        var peers = grouped[ns];
        var peerIds = {};
        peers.forEach(function(p) { peerIds[p.id] = true; });

        var hasMessages = STATE.pairStats.some(function(ps) {
          return peerIds[ps.from_id] && peerIds[ps.to_id];
        });

        var nsColor = namespaceColor(ns);
        html += '<section class="namespace-group" style="--ns-color:' + nsColor + '">';
        html += '<h2>' + escapeHtml(ns);
        html += '<span class="ns-count">' + peers.length + '</span>';

        if (hasMessages) {
          var isGraph = STATE.graphView[ns];
          html += '<button class="view-toggle" onclick="toggleGraphView(\\'' + escapeJs(ns) + '\\')">'
            + (isGraph ? 'Peers' : 'Graph') + '</button>';
        }

        html += '<span class="ns-badge">Can message each other</span>';
        html += '</h2>';

        if (STATE.graphView[ns]) {
          html += renderNamespaceGraph(peers, STATE.pairStats);
        } else {
          html += '<div class="peer-grid">';
          peers.forEach(function(peer) {
            html += renderPeerCard(peer, statsMap, svcMap);
          });
          html += '</div>';
        }

        html += '</section>';
      });

      container.innerHTML = html;
    }

    function toggleGraphView(ns) {
      STATE.graphView[ns] = !STATE.graphView[ns];
      renderNamespaces();
    }

    function clearMessages() {
      fetch('/api/messages/clear', { method: 'POST' });
    }

    function fetchLogStatsIfNeeded() {
      var svcs = STATE.services.filter(function(s) { return s.log_file; });
      if (svcs.length === 0) return;

      Promise.all(svcs.map(function(svc) {
        return fetch('/api/log-stats?peer_id=' + encodeURIComponent(svc.peer_id))
          .then(function(r) { return r.ok ? r.json() : null; })
          .catch(function() { return null; });
      })).then(function(results) {
        var changed = false;
        svcs.forEach(function(svc, i) {
          if (results[i]) {
            var prev = STATE.logStatsMap[svc.peer_id];
            if (!prev || prev.total !== results[i].total || prev.ERROR !== results[i].ERROR || prev.WARN !== results[i].WARN) {
              STATE.logStatsMap[svc.peer_id] = results[i];
              changed = true;
            }
          }
        });
        if (changed) renderNamespaces();
      });
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if ($('logViewerModal').style.display !== 'none') {
          closeLogViewer();
        } else if ($('conversationModal').style.display !== 'none') {
          closeConversation();
        }
      }
    });

    // Single 30s interval for timestamp refresh + log stats polling
    setInterval(function() {
      renderNamespaces();
      fetchLogStatsIfNeeded();
    }, 30000);

    connectWs();
  `;
}
