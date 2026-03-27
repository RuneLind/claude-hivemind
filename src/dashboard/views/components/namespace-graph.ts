// SVG graph visualization for message flow between peers

export function namespaceGraphStyles(): string {
  return `
    .graph-view {
      background: #161b22;
      border: 1px solid #21262d;
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }
    .graph-svg { width: 100%; max-height: 500px; }
    .edge-label { cursor: pointer; }
    .edge-label:hover rect { fill: #30363d; stroke: #58a6ff; }
  `;
}

export function namespaceGraphScript(): string {
  return `
    var CHAR_W = 10;
    var NODE_PAD_X = 20;
    var NODE_H = 38;

    function renderNamespaceGraph(peers, pairStats) {
      var peerIds = {};
      peers.forEach(function(p) { peerIds[p.id] = true; });

      var relevantPairs = pairStats.filter(function(ps) {
        return peerIds[ps.from_id] && peerIds[ps.to_id];
      });

      if (relevantPairs.length === 0) return '';

      var nodeWidths = {};
      peers.forEach(function(p) {
        nodeWidths[p.id] = p.id.length * CHAR_W + NODE_PAD_X * 2;
      });

      var maxNodeW = 0;
      peers.forEach(function(p) {
        if (nodeWidths[p.id] > maxNodeW) maxNodeW = nodeWidths[p.id];
      });

      var radius = Math.max(180, peers.length * (maxNodeW + 28) / (2 * Math.PI));
      var SIZE = radius * 2 + 80;
      var cx = SIZE / 2;
      var cy = SIZE / 2;

      var positions = {};
      peers.forEach(function(p, i) {
        var angle = (2 * Math.PI * i) / peers.length - Math.PI / 2;
        positions[p.id] = {
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle)
        };
      });

      // Build edge map
      var edgeMap = {};
      relevantPairs.forEach(function(ps) {
        var sorted = [ps.from_id, ps.to_id].sort();
        var key = sorted[0] + '|' + sorted[1];
        if (!edgeMap[key]) {
          edgeMap[key] = { from: sorted[0], to: sorted[1], fwdCount: 0, revCount: 0 };
        }
        if (ps.from_id === sorted[0]) {
          edgeMap[key].fwdCount += ps.count;
        } else {
          edgeMap[key].revCount += ps.count;
        }
      });

      var svg = '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" class="graph-svg">';

      // Arrow markers
      svg += '<defs>';
      svg += '<marker id="arrow-fwd" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">';
      svg += '<polygon points="0 0, 8 3, 0 6" fill="#58a6ff"/>';
      svg += '</marker>';
      svg += '<marker id="arrow-rev" markerWidth="8" markerHeight="6" refX="0" refY="3" orient="auto">';
      svg += '<polygon points="8 0, 0 3, 8 6" fill="#7ee787"/>';
      svg += '</marker>';
      svg += '</defs>';

      // Edges
      Object.keys(edgeMap).forEach(function(key) {
        var edge = edgeMap[key];
        var fromPos = positions[edge.from];
        var toPos = positions[edge.to];
        if (!fromPos || !toPos) return;

        var fromHalfW = (nodeWidths[edge.from] || 60) / 2;
        var toHalfW = (nodeWidths[edge.to] || 60) / 2;

        var dx = toPos.x - fromPos.x;
        var dy = toPos.y - fromPos.y;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return;

        var ux = dx / len;
        var uy = dy / len;

        var edgeGap = 6;
        var fromOffset = Math.max(fromHalfW * Math.abs(ux), (NODE_H / 2) * Math.abs(uy)) + edgeGap;
        var toOffset = Math.max(toHalfW * Math.abs(ux), (NODE_H / 2) * Math.abs(uy)) + edgeGap;

        var x1 = fromPos.x + ux * fromOffset;
        var y1 = fromPos.y + uy * fromOffset;
        var x2 = toPos.x - ux * toOffset;
        var y2 = toPos.y - uy * toOffset;

        var midX = (x1 + x2) / 2;
        var midY = (y1 + y2) / 2;
        var total = edge.fwdCount + edge.revCount;

        var px = -uy * 10;
        var py = ux * 10;

        if (edge.fwdCount > 0) {
          svg += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2
            + '" stroke="#58a6ff" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow-fwd)"/>';
        }
        if (edge.revCount > 0) {
          svg += '<line x1="' + (x2 + px * 0.3) + '" y1="' + (y2 + py * 0.3)
            + '" x2="' + (x1 + px * 0.3) + '" y2="' + (y1 + py * 0.3)
            + '" stroke="#7ee787" stroke-width="1.5" opacity="0.6" marker-end="url(#arrow-rev)"/>';
        }

        svg += '<g class="edge-label" onclick="openConversation(\\'' + escapeJs(edge.from) + '\\',\\'' + escapeJs(edge.to) + '\\')">';
        svg += '<rect x="' + (midX - 18) + '" y="' + (midY - 12) + '" width="36" height="24" rx="4" fill="#21262d" stroke="#30363d" stroke-width="1"/>';
        svg += '<text x="' + midX + '" y="' + (midY + 4) + '" text-anchor="middle" fill="#c9d1d9" font-size="14" font-family="monospace">' + total + '</text>';
        svg += '</g>';
      });

      // Nodes
      peers.forEach(function(peer) {
        var pos = positions[peer.id];
        if (!pos) return;
        var w = nodeWidths[peer.id] || 60;
        svg += '<rect x="' + (pos.x - w / 2) + '" y="' + (pos.y - NODE_H / 2) + '" width="' + w + '" height="' + NODE_H
          + '" rx="' + (NODE_H / 2) + '" fill="#161b22" stroke="' + (peer.connected ? '#3fb950' : '#484f58') + '" stroke-width="2"/>';
        svg += '<text x="' + pos.x + '" y="' + (pos.y + 4) + '" text-anchor="middle" fill="#c9d1d9" font-size="15" font-family="monospace">'
          + escapeHtml(peer.id) + '</text>';
      });

      svg += '</svg>';
      return '<div class="graph-view">' + svg + '</div>';
    }
  `;
}
