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
    .profile-bar {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px;
      padding-bottom: 12px; border-bottom: 1px solid #21262d;
      min-height: 28px; align-items: center;
    }
    .profile-bar-label {
      font-size: 11px; color: #484f58; margin-right: 4px;
      white-space: nowrap;
    }
    .profile-pill {
      display: inline-flex; align-items: center; gap: 4px;
      background: #21262d; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 11px;
      padding: 3px 10px; border-radius: 12px;
      cursor: pointer; transition: all 0.15s;
    }
    .profile-pill:hover { border-color: #58a6ff; color: #58a6ff; }
    .profile-pill.active { border-color: #3fb950; color: #3fb950; }
    .profile-pill .profile-delete {
      display: inline-flex; align-items: center; justify-content: center;
      width: 14px; height: 14px; border-radius: 50%;
      font-size: 10px; line-height: 1; color: #484f58;
      cursor: pointer; transition: all 0.15s;
    }
    .profile-pill .profile-delete:hover { color: #f85149; background: rgba(248,81,73,0.1); }
    .profile-pill .profile-count {
      font-size: 10px; color: #8b949e; font-weight: 400;
    }
    .save-profile-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 12px; padding: 4px 12px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
    }
    .save-profile-btn:hover { border-color: #58a6ff; color: #58a6ff; }
    .save-profile-btn:disabled { opacity: 0.5; cursor: default; }
    .save-profile-row {
      display: none; align-items: center; gap: 8px; margin-top: 8px;
    }
    .save-profile-row.open { display: flex; }
    .save-profile-row input {
      flex: 1; background: #0d1117; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 12px;
      padding: 6px 8px; border-radius: 6px; outline: none;
    }
    .save-profile-row input:focus { border-color: #58a6ff; }
    .save-profile-confirm {
      background: #238636; border: 1px solid #238636; color: #fff;
      font-family: inherit; font-size: 12px; padding: 6px 14px;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      white-space: nowrap;
    }
    .save-profile-confirm:hover { background: #2ea043; }
    .save-profile-confirm:disabled { opacity: 0.5; cursor: default; }
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

    function renderProfileList() {
      var bar = $('profileBar');
      if (!bar) return;
      var profiles = STATE.profiles || [];
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
