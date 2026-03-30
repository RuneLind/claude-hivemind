// cmux launch modal — scan folders for git repos and launch Claude Code instances

export function launchModalStyles(): string {
  return `
    .launch-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.6); z-index: 200;
      justify-content: center; align-items: center;
    }
    .launch-overlay.open { display: flex; }
    .launch-modal {
      background: #161b22; border: 1px solid #30363d;
      border-radius: 10px; padding: 24px; width: 540px;
      max-width: 90vw; max-height: 85vh; overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .launch-modal h3 {
      font-size: 15px; font-weight: 600; color: #e6edf3;
      margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
    }
    .launch-modal h3 .cmux-badge {
      font-size: 10px; font-weight: 400; color: #8b949e;
      background: #21262d; padding: 2px 8px; border-radius: 4px;
    }
    .launch-modal label {
      display: block; font-size: 12px; color: #8b949e;
      margin-bottom: 4px; margin-top: 12px;
    }
    .launch-modal label:first-of-type { margin-top: 0; }
    .launch-modal input {
      width: 100%; background: #0d1117; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 13px;
      padding: 8px 10px; border-radius: 6px; outline: none;
    }
    .launch-modal input:focus { border-color: #58a6ff; }
    .launch-modal textarea {
      width: 100%; background: #0d1117; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 12px;
      padding: 8px 10px; border-radius: 6px; outline: none;
      resize: vertical; min-height: 60px;
    }
    .launch-modal textarea:focus { border-color: #58a6ff; }
    .launch-dir-row {
      display: flex; gap: 8px; align-items: stretch;
    }
    .launch-dir-row input { flex: 1; }
    .scan-btn {
      background: #21262d; border: 1px solid #30363d; color: #e6edf3;
      font-family: inherit; font-size: 12px; padding: 0 14px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      white-space: nowrap;
    }
    .scan-btn:hover { border-color: #58a6ff; color: #58a6ff; }
    .scan-btn:disabled { opacity: 0.5; cursor: default; }
    .repo-list {
      margin-top: 8px; max-height: 300px; overflow-y: auto;
      border: 1px solid #21262d; border-radius: 6px;
    }
    .repo-list-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; background: #0d1117; border-bottom: 1px solid #21262d;
      font-size: 11px; color: #8b949e;
    }
    .repo-list-header button {
      background: none; border: none; color: #58a6ff;
      font-family: inherit; font-size: 11px; cursor: pointer;
      padding: 0;
    }
    .repo-list-header button:hover { text-decoration: underline; }
    .repo-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-bottom: 1px solid #161b22;
      font-size: 12px; transition: background 0.1s;
    }
    .repo-item:last-child { border-bottom: none; }
    .repo-item:hover { background: #1c2128; }
    .repo-item input[type="checkbox"] {
      width: auto; margin: 0; accent-color: #58a6ff; cursor: pointer;
    }
    .repo-item .repo-name { color: #e6edf3; font-weight: 500; }
    .repo-item .repo-branch {
      margin-left: auto; color: #7ee787; font-size: 11px;
      background: #1f2a37; padding: 1px 6px; border-radius: 4px;
    }
    .launch-footer {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-top: 20px;
    }
    .launch-footer .selected-count {
      font-size: 12px; color: #8b949e;
    }
    .launch-footer .launch-actions {
      display: flex; gap: 8px;
    }
    .launch-footer button {
      font-family: inherit; font-size: 13px; padding: 6px 16px;
      border-radius: 6px; cursor: pointer; border: 1px solid #30363d;
      transition: all 0.15s;
    }
    .launch-cancel {
      background: none; color: #8b949e;
    }
    .launch-cancel:hover { border-color: #8b949e; color: #e6edf3; }
    .launch-submit {
      background: #238636; border-color: #238636; color: #fff;
    }
    .launch-submit:hover { background: #2ea043; }
    .launch-submit:disabled { opacity: 0.5; cursor: default; }
    .launch-error {
      display: none; color: #f85149; font-size: 12px; margin-top: 8px;
    }
    .launch-hint {
      font-size: 11px; color: #484f58; margin-top: 4px;
    }
    .launch-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .launch-btn:hover { border-color: #3fb950; color: #3fb950; }
  `;
}

export function launchModalHtml(): string {
  return `
    <div id="launchOverlay" class="launch-overlay" onclick="if(event.target===this)closeLaunchModal()">
      <div class="launch-modal">
        <h3>Launch Agents <span class="cmux-badge">via cmux</span></h3>
        <label for="launchDir">Folder or directory path</label>
        <div class="launch-dir-row">
          <input id="launchDir" type="text" placeholder="nav, private, or /full/path/to/project" />
          <button class="scan-btn" id="scanBtn" onclick="scanRepos()">Scan</button>
        </div>
        <div class="launch-hint">Enter a folder name (e.g. <b>nav</b>) to scan ~/source/nav for git repos, or a full path</div>
        <div id="repoListContainer"></div>
        <label for="launchPrompt">Shared prompt for all agents (optional)</label>
        <textarea id="launchPrompt" placeholder="e.g. Build and start the service, then register it with hivemind"></textarea>
        <div id="launchError" class="launch-error"></div>
        <div class="launch-footer">
          <span class="selected-count" id="selectedCount"></span>
          <div class="launch-actions">
            <button class="launch-cancel" onclick="closeLaunchModal()">Cancel</button>
            <button class="launch-submit" id="launchSubmitBtn" onclick="submitLaunch()" disabled>Launch</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function launchModalScript(): string {
  return `
    var scannedRepos = [];

    function openLaunchModal() {
      var overlay = $('launchOverlay');
      overlay.classList.add('open');
      $('launchDir').value = '';
      $('launchPrompt').value = '';
      $('launchError').style.display = 'none';
      $('repoListContainer').innerHTML = '';
      $('selectedCount').textContent = '';
      $('launchSubmitBtn').disabled = true;
      scannedRepos = [];
      $('launchDir').focus();
    }

    function closeLaunchModal() {
      $('launchOverlay').classList.remove('open');
    }

    function scanRepos() {
      var dir = $('launchDir').value.trim();
      if (!dir) {
        $('launchError').textContent = 'Enter a folder name or path';
        $('launchError').style.display = '';
        return;
      }
      $('launchError').style.display = 'none';
      $('scanBtn').disabled = true;
      $('scanBtn').textContent = 'Scanning...';
      wsSend({ type: 'scan_repos', directory: dir });
    }

    function handleScanResult(repos) {
      $('scanBtn').disabled = false;
      $('scanBtn').textContent = 'Scan';
      scannedRepos = repos;

      if (repos.length === 0) {
        $('repoListContainer').innerHTML = '<div style="padding:12px;color:#484f58;font-size:12px;text-align:center">No git repos found in this directory</div>';
        updateSelectedCount();
        return;
      }

      var html = '<div class="repo-list">';
      html += '<div class="repo-list-header">';
      html += '<span>' + repos.length + ' repos found</span>';
      html += '<button onclick="toggleAllRepos()">Select all</button>';
      html += '</div>';
      for (var i = 0; i < repos.length; i++) {
        var r = repos[i];
        html += '<div class="repo-item">';
        html += '<input type="checkbox" id="repo-' + i + '" onchange="updateSelectedCount()">';
        html += '<span class="repo-name">' + escapeHtml(r.name) + '</span>';
        if (r.branch) {
          html += '<span class="repo-branch">' + escapeHtml(r.branch) + '</span>';
        }
        html += '</div>';
      }
      html += '</div>';
      $('repoListContainer').innerHTML = html;
      updateSelectedCount();
    }

    function toggleAllRepos() {
      var checkboxes = document.querySelectorAll('#repoListContainer input[type="checkbox"]');
      var allChecked = true;
      for (var i = 0; i < checkboxes.length; i++) {
        if (!checkboxes[i].checked) { allChecked = false; break; }
      }
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].checked = !allChecked;
      }
      updateSelectedCount();
    }

    function getSelectedRepos() {
      var selected = [];
      for (var i = 0; i < scannedRepos.length; i++) {
        var cb = $('repo-' + i);
        if (cb && cb.checked) {
          selected.push(scannedRepos[i]);
        }
      }
      return selected;
    }

    function updateSelectedCount() {
      var selected = getSelectedRepos();
      var count = selected.length;
      $('selectedCount').textContent = count > 0 ? count + ' selected' : '';
      $('launchSubmitBtn').disabled = count === 0;
      $('launchSubmitBtn').textContent = count > 1 ? 'Launch ' + count + ' agents' : 'Launch';
    }

    function submitLaunch() {
      var selected = getSelectedRepos();
      if (selected.length === 0) {
        // Fallback: try single directory mode
        var dir = $('launchDir').value.trim();
        if (!dir) {
          $('launchError').textContent = 'Select repos or enter a directory';
          $('launchError').style.display = '';
          return;
        }
        // Single launch (backwards compat)
        $('launchError').style.display = 'none';
        var msg = { type: 'launch_claude_instance', directory: dir };
        var prompt = $('launchPrompt').value.trim();
        if (prompt) msg.prompt = prompt;
        wsSend(msg);
        addActivity('Launching Claude instance in ' + dir + '...');
        return;
      }

      $('launchError').style.display = 'none';
      var dirs = selected.map(function(r) { return { directory: r.path, name: r.name }; });
      var msg = { type: 'launch_claude_instances', directories: dirs };
      var prompt = $('launchPrompt').value.trim();
      if (prompt) msg.prompt = prompt;
      wsSend(msg);
      addActivity('Launching ' + selected.length + ' agents...');
      closeLaunchModal();
    }

    function renderLaunchButton() {
      if (!STATE.cmuxAvailable) return '';
      return '<button class="launch-btn" onclick="openLaunchModal()" title="Launch Claude Code agents in cmux workspaces">+ Agents</button>';
    }
  `;
}
