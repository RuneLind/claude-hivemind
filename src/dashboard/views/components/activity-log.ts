// Activity log component

export function activityLogStyles(): string {
  return `
    .activity-log {
      margin-top: 32px;
      border-top: 1px solid var(--border-primary);
      padding-top: 16px;
    }
    .activity-log h3 {
      font-size: 14px; font-weight: 500; color: var(--text-muted); margin-bottom: 12px;
    }
    .activity-item {
      font-size: 12px; color: var(--text-muted);
      padding: 4px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .activity-item .time { color: var(--text-faint); margin-right: 8px; }
  `;
}

export function activityLogScript(): string {
  return `
    var MAX_ACTIVITY = 50;

    function addActivity(text) {
      STATE.activity.unshift({ time: new Date().toISOString(), text: text });
      if (STATE.activity.length > MAX_ACTIVITY) STATE.activity = STATE.activity.slice(0, MAX_ACTIVITY);
    }

    function renderActivityLog() {
      var container = $('activityLog');
      if (!container) return;

      if (STATE.activity.length === 0) {
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      var html = '<h3>Activity</h3>';
      STATE.activity.forEach(function(item) {
        html += '<div class="activity-item">';
        html += '<span class="time">' + formatTime(item.time) + '</span>';
        html += escapeHtml(item.text);
        html += '</div>';
      });
      container.innerHTML = html;
    }
  `;
}

export function activityLogHtml(): string {
  return `<div id="activityLog" class="activity-log" style="display:none"></div>`;
}
