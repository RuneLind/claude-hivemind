// cmux launch modal — scan folders for git repos and launch Claude Code instances

export function launchModalStyles(): string {
  return `
    .launch-overlay {
      display: none; position: fixed; inset: 0;
      background: var(--overlay-soft); z-index: 200;
      justify-content: center; align-items: center;
    }
    .launch-overlay.open { display: flex; }
    .launch-modal {
      background: var(--bg-panel); border: 1px solid var(--border-secondary);
      border-radius: 10px; padding: 24px; width: 540px;
      max-width: 90vw; max-height: 85vh; overflow-y: auto;
      box-shadow: 0 8px 32px var(--shadow-modal);
    }
    .launch-modal h3 {
      font-size: 15px; font-weight: 600; color: var(--text-bright);
      margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
    }
    .launch-modal h3 .cmux-badge {
      font-size: 10px; font-weight: 400; color: var(--text-muted);
      background: var(--bg-surface); padding: 2px 8px; border-radius: 4px;
    }
    .launch-modal label {
      display: block; font-size: 12px; color: var(--text-muted);
      margin-bottom: 4px; margin-top: 12px;
    }
    .launch-modal label:first-of-type { margin-top: 0; }
    .launch-modal input {
      width: 100%; background: var(--bg-inset); border: 1px solid var(--border-secondary);
      color: var(--text-bright); font-family: inherit; font-size: 13px;
      padding: 8px 10px; border-radius: 6px; outline: none;
    }
    .launch-modal input:focus { border-color: var(--accent); }
    .launch-modal textarea {
      width: 100%; background: var(--bg-inset); border: 1px solid var(--border-secondary);
      color: var(--text-bright); font-family: inherit; font-size: 12px;
      padding: 8px 10px; border-radius: 6px; outline: none;
      resize: vertical; min-height: 60px;
    }
    .launch-modal textarea:focus { border-color: var(--accent); }
    .launch-dir-row {
      display: flex; gap: 8px; align-items: stretch;
    }
    .launch-dir-row input { flex: 1; }
    .scan-btn {
      background: var(--bg-surface); border: 1px solid var(--border-secondary); color: var(--text-bright);
      font-family: inherit; font-size: 12px; padding: 0 14px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      white-space: nowrap;
    }
    .scan-btn:hover { border-color: var(--accent); color: var(--accent); }
    .scan-btn:disabled { opacity: var(--disabled-opacity); cursor: default; }
    .repo-list {
      margin-top: 8px; max-height: 300px; overflow-y: auto;
      border: 1px solid var(--border-primary); border-radius: 6px;
    }
    .repo-list-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; background: var(--bg-inset); border-bottom: 1px solid var(--border-primary);
      font-size: 11px; color: var(--text-muted);
    }
    .repo-list-header button {
      background: none; border: none; color: var(--accent);
      font-family: inherit; font-size: 11px; cursor: pointer;
      padding: 0;
    }
    .repo-list-header button:hover { text-decoration: underline; }
    .repo-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-bottom: 1px solid var(--border-primary);
      font-size: 12px; transition: background 0.1s;
    }
    .repo-item:last-child { border-bottom: none; }
    .repo-item:hover { background: var(--bg-hover); }
    .repo-item input[type="checkbox"] {
      width: auto; margin: 0; accent-color: var(--accent); cursor: pointer;
    }
    .repo-item .repo-name { color: var(--text-bright); font-weight: 500; }
    .repo-item .repo-branch {
      margin-left: auto; color: var(--status-green); font-size: 11px;
      background: var(--bg-subtle); padding: 1px 6px; border-radius: 4px;
    }
    .launch-footer {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-top: 20px;
    }
    .launch-footer .selected-count {
      font-size: 12px; color: var(--text-muted);
    }
    .launch-footer .launch-actions {
      display: flex; gap: 8px;
    }
    .launch-footer button {
      font-family: inherit; font-size: 13px; padding: 6px 16px;
      border-radius: 6px; cursor: pointer; border: 1px solid var(--border-secondary);
      transition: all 0.15s;
    }
    .launch-cancel {
      background: none; color: var(--text-muted);
    }
    .launch-cancel:hover { border-color: var(--text-muted); color: var(--text-bright); }
    .launch-submit {
      background: var(--btn-success-bg); border-color: var(--btn-success-bg); color: var(--btn-success-text);
    }
    .launch-submit:hover { background: var(--btn-success-hover); }
    .launch-submit:disabled { opacity: var(--disabled-opacity); cursor: default; }
    .launch-error {
      display: none; color: var(--status-error); font-size: 12px; margin-top: 8px;
    }
    .launch-hint {
      font-size: 11px; color: var(--text-faint); margin-top: 4px;
    }
    .agent-type-selector {
      display: flex; gap: 8px; margin-top: 4px;
    }
    .agent-type-option {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 6px;
      border: 1px solid var(--border-secondary); background: none;
      color: var(--text-muted); font-family: inherit; font-size: 12px;
      cursor: pointer; transition: all 0.15s;
    }
    .agent-type-option:hover { border-color: var(--accent); color: var(--text-bright); }
    .agent-type-option.selected { border-color: var(--accent); color: var(--accent); background: var(--badge-blue-bg); }
    .agent-type-option.selected.opencode { border-color: var(--accent-purple); color: var(--accent-purple); background: var(--badge-purple-bg); }
    .agent-type-dot {
      width: 8px; height: 8px; border-radius: 50%;
    }
    .agent-type-option .agent-type-dot { background: var(--text-faint); }
    .agent-type-option.selected .agent-type-dot { background: var(--accent); }
    .agent-type-option.selected.opencode .agent-type-dot { background: var(--accent-purple); }
    .launch-btn {
      background: none; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 11px;
      padding: 2px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .launch-btn:hover { border-color: var(--status-success); color: var(--status-success); }
    .profile-bar {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px;
      padding-bottom: 12px; border-bottom: 1px solid var(--border-primary);
      min-height: 28px; align-items: center;
    }
    .profile-bar-label {
      font-size: 11px; color: var(--text-faint); margin-right: 4px;
      white-space: nowrap;
    }
    .profile-pill {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--bg-surface); border: 1px solid var(--border-secondary);
      color: var(--text-bright); font-family: inherit; font-size: 11px;
      padding: 3px 10px; border-radius: 12px;
      cursor: pointer; transition: all 0.15s;
    }
    .profile-pill:hover { border-color: var(--accent); color: var(--accent); }
    .profile-pill.active { border-color: var(--status-success); color: var(--status-success); }
    .profile-pill .profile-delete {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      font-size: 10px; line-height: 1; color: var(--text-muted);
      cursor: pointer; transition: all 0.15s;
    }
    .profile-pill .profile-delete:hover { color: var(--status-error); background: var(--tint-error); }
    .profile-pill .profile-count {
      font-size: 10px; color: var(--text-muted); font-weight: 400;
    }
    .save-profile-btn {
      background: none; border: 1px solid var(--border-secondary); color: var(--text-muted);
      font-family: inherit; font-size: 12px; padding: 4px 12px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
    }
    .save-profile-btn:hover { border-color: var(--accent); color: var(--accent); }
    .save-profile-btn:disabled { opacity: var(--disabled-opacity); cursor: default; }
    .save-profile-row {
      display: none; align-items: center; gap: 8px; margin-top: 8px;
    }
    .save-profile-row.open { display: flex; }
    .save-profile-row input {
      flex: 1; background: var(--bg-inset); border: 1px solid var(--border-secondary);
      color: var(--text-bright); font-family: inherit; font-size: 12px;
      padding: 6px 8px; border-radius: 6px; outline: none;
    }
    .save-profile-row input:focus { border-color: var(--accent); }
    .save-profile-confirm {
      background: var(--btn-success-bg); border: 1px solid var(--btn-success-bg); color: var(--btn-success-text);
      font-family: inherit; font-size: 12px; padding: 6px 14px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      white-space: nowrap;
    }
    .save-profile-confirm:hover { background: var(--btn-success-hover); }
    .save-profile-confirm:disabled { opacity: var(--disabled-opacity); cursor: default; }
  `;
}

export function launchModalHtml(): string {
  return `
    <div id="launchOverlay" class="launch-overlay" onclick="if(event.target===this)closeLaunchModal()">
      <div class="launch-modal">
        <h3>Launch Agents <span class="cmux-badge">via cmux</span></h3>
        <div id="profileBar" class="profile-bar"></div>
        <label for="launchDir">Folder or directory path</label>
        <div class="launch-dir-row">
          <input id="launchDir" type="text" placeholder="nav, private, or /full/path/to/project" />
          <button class="scan-btn" id="scanBtn" onclick="scanRepos()">Scan</button>
        </div>
        <div class="launch-hint">Enter a folder name (e.g. <b>nav</b>) to scan ~/source/nav for git repos, or a full path</div>
        <div id="repoListContainer"></div>
        <label>Agent type</label>
        <div class="agent-type-selector" id="agentTypeSelector">
          <button class="agent-type-option selected" data-type="claude-code" onclick="selectAgentType('claude-code')">
            <span class="agent-type-dot"></span> Claude Code
          </button>
          <button class="agent-type-option opencode" data-type="opencode" onclick="selectAgentType('opencode')">
            <span class="agent-type-dot"></span> OpenCode
          </button>
        </div>
        <label for="launchPrompt">Shared prompt for all agents (optional)</label>
        <textarea id="launchPrompt" placeholder="e.g. Build and start the service, then register it with hivemind"></textarea>
        <div id="saveProfileRow" class="save-profile-row">
          <input id="profileNameInput" type="text" placeholder="Profile name" />
          <button class="save-profile-confirm" id="saveProfileConfirmBtn" onclick="confirmSaveProfile()">Save</button>
        </div>
        <div id="launchError" class="launch-error"></div>
        <div class="launch-footer">
          <span class="selected-count" id="selectedCount"></span>
          <div class="launch-actions">
            <button class="save-profile-btn" id="saveProfileBtn" onclick="toggleSaveProfile()" disabled>Save Profile</button>
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
    var activeProfileId = null;
    var pendingProfileLoad = null;
    var selectedAgentType = 'claude-code';

    function selectAgentType(type) {
      selectedAgentType = type;
      var btns = document.querySelectorAll('.agent-type-option');
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (btn.getAttribute('data-type') === type) {
          btn.classList.add('selected');
        } else {
          btn.classList.remove('selected');
        }
      }
    }

    function openLaunchModal() {
      var overlay = $('launchOverlay');
      overlay.classList.add('open');
      $('launchDir').value = '';
      $('launchPrompt').value = '';
      $('launchError').style.display = 'none';
      $('repoListContainer').innerHTML = '';
      $('selectedCount').textContent = '';
      $('launchSubmitBtn').disabled = true;
      $('saveProfileBtn').disabled = true;
      $('saveProfileRow').classList.remove('open');
      scannedRepos = [];
      activeProfileId = null;
      pendingProfileLoad = null;
      selectAgentType('claude-code');
      renderProfileList();
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
        pendingProfileLoad = null;
        $('repoListContainer').innerHTML = '<div style="padding:12px;color:var(--text-faint);font-size:12px;text-align:center">No git repos found in this directory</div>';
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
      if (pendingProfileLoad) {
        applyProfileSelection(pendingProfileLoad);
        pendingProfileLoad = null;
      } else {
        updateSelectedCount();
      }
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
      $('saveProfileBtn').disabled = count === 0;
    }

    function submitLaunch() {
      var selected = getSelectedRepos();
      if (selected.length === 0) return;

      $('launchError').style.display = 'none';
      var dirs = selected.map(function(r) { return { directory: r.path, name: r.name }; });
      var msg = { type: 'launch_claude_instances', directories: dirs, agent_type: selectedAgentType };
      var prompt = $('launchPrompt').value.trim();
      if (prompt) msg.prompt = prompt;
      wsSend(msg);
      var label = selectedAgentType === 'opencode' ? 'OpenCode' : 'Claude Code';
      addActivity('Launching ' + selected.length + ' ' + label + ' agents...');
      closeLaunchModal();
    }

    function renderLaunchButton() {
      if (!STATE.cmuxAvailable) return '';
      return '<button class="launch-btn" onclick="openLaunchModal()" title="Launch Claude Code agents in cmux workspaces">+ Agents</button>';
    }

    function renderProfileList() {
      var bar = $('profileBar');
      if (!bar) return;
      var profiles = (STATE.profiles || []).slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
      if (profiles.length === 0) {
        bar.innerHTML = '<span class="profile-bar-label">No saved profiles</span>';
        return;
      }
      var html = '<span class="profile-bar-label">Profiles</span>';
      for (var i = 0; i < profiles.length; i++) {
        var p = profiles[i];
        var isActive = activeProfileId === p.id;
        html += '<span class="profile-pill' + (isActive ? ' active' : '') + '" onclick="loadProfile(\\'' + escapeJs(p.id) + '\\')">';
        html += escapeHtml(p.name);
        html += ' <span class="profile-count">' + p.repos.length + '</span>';
        html += '<span class="profile-delete" onclick="event.stopPropagation();deleteProfile(\\'' + escapeJs(p.id) + '\\')" title="Delete profile">\\u00d7</span>';
        html += '</span>';
      }
      bar.innerHTML = html;
    }

    function loadProfile(profileId) {
      var profile = (STATE.profiles || []).find(function(p) { return p.id === profileId; });
      if (!profile) return;
      activeProfileId = profileId;
      $('launchDir').value = profile.directory;
      $('launchPrompt').value = profile.prompt || '';
      pendingProfileLoad = profile;
      renderProfileList();
      scanRepos();
    }

    function applyProfileSelection(profile) {
      if (!profile || !profile.repos) return;
      var repoNames = {};
      profile.repos.forEach(function(name) { repoNames[name] = true; });
      for (var i = 0; i < scannedRepos.length; i++) {
        var cb = $('repo-' + i);
        if (cb) cb.checked = !!repoNames[scannedRepos[i].name];
      }
      updateSelectedCount();
    }

    function toggleSaveProfile() {
      var row = $('saveProfileRow');
      if (row.classList.contains('open')) {
        row.classList.remove('open');
        return;
      }
      row.classList.add('open');
      var input = $('profileNameInput');
      if (activeProfileId) {
        var existing = (STATE.profiles || []).find(function(p) { return p.id === activeProfileId; });
        if (existing) input.value = existing.name;
      } else {
        input.value = '';
      }
      input.focus();
    }

    function confirmSaveProfile() {
      var name = $('profileNameInput').value.trim();
      if (!name) return;
      var selected = getSelectedRepos();
      if (selected.length === 0) return;
      var dir = $('launchDir').value.trim();
      var prompt = $('launchPrompt').value.trim();
      var repoNames = selected.map(function(r) { return r.name; });
      wsSend({
        type: 'save_profile',
        name: name,
        directory: dir,
        repos: repoNames,
        prompt: prompt
      });
      $('saveProfileRow').classList.remove('open');
      addActivity('Saving profile: ' + name);
    }

    function deleteProfile(profileId) {
      wsSend({ type: 'delete_profile', profileId: profileId });
      if (activeProfileId === profileId) activeProfileId = null;
    }
  `;
}
