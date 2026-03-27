// Conversation history modal

export function conversationModalStyles(): string {
  return `
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
    }
    .modal {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 10px;
      width: 700px; max-width: 90vw; max-height: 80vh;
      display: flex; flex-direction: column;
    }
    .modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid #21262d;
    }
    .modal-header h3 { font-size: 14px; font-weight: 500; color: #e6edf3; }
    .modal-body { padding: 14px 18px; overflow-y: auto; flex: 1; }
    .message-item {
      padding: 10px 12px; margin-bottom: 8px;
      border-radius: 6px; background: #0d1117;
      border: 1px solid #21262d;
    }
    .message-item.sent { border-left: 3px solid #58a6ff; }
    .message-item.received { border-left: 3px solid #7ee787; }
    .message-meta {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #8b949e; margin-bottom: 6px;
    }
    .message-from { color: #58a6ff; font-weight: 500; }
    .message-arrow { color: #484f58; }
    .message-to { color: #7ee787; font-weight: 500; }
    .message-time { margin-left: auto; color: #484f58; }
    .message-text {
      font-size: 12px; color: #c9d1d9;
      white-space: pre-wrap; word-break: break-word;
    }
  `;
}

export function conversationModalScript(): string {
  return `
    var conversationModal = { peer1: null, peer2: null };

    function openConversation(peer1, peer2) {
      conversationModal.peer1 = peer1;
      conversationModal.peer2 = peer2;

      var overlay = $('conversationModal');
      overlay.style.display = 'flex';

      var body = $('conversationBody');
      body.innerHTML = '<div class="modal-loading">Loading...</div>';

      var title = peer2 ? peer1 + ' \\u2194 ' + peer2 : 'Messages for ' + peer1;
      $('conversationTitle').textContent = title;

      var p2 = encodeURIComponent(peer2 || '*');
      fetch('/api/messages?peer1=' + encodeURIComponent(peer1) + '&peer2=' + p2)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var messages = data.messages || [];
          if (messages.length === 0) {
            body.innerHTML = '<div class="modal-empty">No messages</div>';
            return;
          }
          var html = '';
          messages.forEach(function(m) {
            var cls = m.from_id === peer1 ? 'sent' : 'received';
            html += '<div class="message-item ' + cls + '">';
            html += '<div class="message-meta">';
            html += '<span class="message-from">' + escapeHtml(m.from_id) + '</span>';
            html += '<span class="message-arrow">&rarr;</span>';
            html += '<span class="message-to">' + escapeHtml(m.to_id) + '</span>';
            html += '<span class="message-time">' + formatTime(m.sent_at) + '</span>';
            html += '</div>';
            html += '<div class="message-text">' + escapeHtml(m.text) + '</div>';
            html += '</div>';
          });
          body.innerHTML = html;
        })
        .catch(function() {
          body.innerHTML = '<div class="modal-empty">Failed to load messages</div>';
        });
    }

    function closeConversation() {
      $('conversationModal').style.display = 'none';
      conversationModal.peer1 = null;
      conversationModal.peer2 = null;
    }
  `;
}

export function conversationModalHtml(): string {
  return `
    <div id="conversationModal" class="modal-overlay" style="display:none" onclick="closeConversation()">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3 id="conversationTitle"></h3>
          <button class="modal-close" onclick="closeConversation()">&times;</button>
        </div>
        <div class="modal-body" id="conversationBody"></div>
      </div>
    </div>
  `;
}
