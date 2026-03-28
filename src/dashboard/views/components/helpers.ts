// Shared utility functions available to all components

export function helpersScript(): string {
  return `
    function escapeHtml(text) {
      return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function escapeJs(text) {
      return String(text).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function shortPath(cwd) {
      return cwd.replace(/^\\/Users\\/\\w+\\//, '~/');
    }

    function timeAgo(iso) {
      var diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      return Math.floor(diff / 3600000) + 'h ago';
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }

    function namespaceColor(name) {
      var colors = ['#58a6ff','#7ee787','#d2a8ff','#f0883e','#ff7b72','#79c0ff','#ffa657','#a5d6ff'];
      var hash = 0;
      for (var i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      return colors[Math.abs(hash) % colors.length];
    }

    function $(id) { return document.getElementById(id); }

    function toggleSection(key) {
      STATE.collapsed[key] = !STATE.collapsed[key];
      renderAll();
    }

    function collapseToggleHtml(key) {
      var collapsed = STATE.collapsed[key];
      return '<button class="collapse-toggle' + (collapsed ? ' collapsed' : '') + '"'
        + ' onclick="event.stopPropagation(); toggleSection(\\'' + escapeJs(key) + '\\')"'
        + '>&#9660;</button>';
    }
  `;
}
