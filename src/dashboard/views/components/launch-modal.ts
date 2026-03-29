// cmux launch modal — start a Claude Code instance in a new cmux workspace

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
      border-radius: 10px; padding: 24px; width: 480px;
      max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
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
    .launch-modal input, .launch-modal select {
      width: 100%; background: #0d1117; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 13px;
      padding: 8px 10px; border-radius: 6px; outline: none;
    }
    .launch-modal input:focus, .launch-modal select:focus {
      border-color: #58a6ff;
    }
    .launch-modal textarea {
      width: 100%; background: #0d1117; border: 1px solid #30363d;
      color: #e6edf3; font-family: inherit; font-size: 12px;
      padding: 8px 10px; border-radius: 6px; outline: none;
      resize: vertical; min-height: 60px;
    }
    .launch-modal textarea:focus { border-color: #58a6ff; }
    .launch-footer {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;
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
        <h3>Launch Claude Code <span class="cmux-badge">via cmux</span></h3>
        <label for="launchDir">Working directory</label>
        <input id="launchDir" type="text" placeholder="/Users/you/source/project/repo" />
        <label for="launchName">Workspace name (optional)</label>
        <input id="launchName" type="text" placeholder="Auto-derived from directory" />
        <label for="launchPrompt">Initial prompt (optional)</label>
        <textarea id="launchPrompt" placeholder="e.g. Build and start the service, then register it with hivemind"></textarea>
        <div id="launchError" class="launch-error"></div>
        <div class="launch-footer">
          <button class="launch-cancel" onclick="closeLaunchModal()">Cancel</button>
          <button class="launch-submit" onclick="submitLaunch()">Launch</button>
        </div>
      </div>
    </div>
  `;
}

export function launchModalScript(): string {
  return `
    function openLaunchModal() {
      var overlay = $('launchOverlay');
      overlay.classList.add('open');
      $('launchDir').value = '';
      $('launchName').value = '';
      $('launchPrompt').value = '';
      $('launchError').style.display = 'none';
      $('launchDir').focus();
    }

    function closeLaunchModal() {
      $('launchOverlay').classList.remove('open');
    }

    function submitLaunch() {
      var dir = $('launchDir').value.trim();
      if (!dir) {
        $('launchError').textContent = 'Directory is required';
        $('launchError').style.display = '';
        return;
      }
      $('launchError').style.display = 'none';
      var msg = { type: 'launch_claude_instance', directory: dir };
      var name = $('launchName').value.trim();
      var prompt = $('launchPrompt').value.trim();
      if (name) msg.name = name;
      if (prompt) msg.prompt = prompt;
      wsSend(msg);
      addActivity('Launching Claude instance in ' + dir + '...');
    }

    function renderLaunchButton() {
      if (!STATE.cmuxAvailable) return '';
      return '<button class="launch-btn" onclick="openLaunchModal()" title="Launch Claude Code in a new cmux workspace">+ Agent</button>';
    }
  `;
}
