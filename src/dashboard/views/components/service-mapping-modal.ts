// Service mapping configuration modal

export function serviceMappingModalStyles(): string {
  return `
    .mapping-modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 40px;
    }
    .mapping-modal {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 10px;
      width: 100%; max-width: 480px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .mapping-modal-header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid #21262d;
      background: #161b22;
    }
    .mapping-modal-header h3 {
      font-size: 14px; font-weight: 500; color: #e6edf3; margin: 0;
    }
    .mapping-modal-body {
      padding: 16px; display: flex; flex-direction: column; gap: 12px;
    }
    .mapping-field { display: flex; flex-direction: column; gap: 4px; }
    .mapping-field label {
      font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .mapping-field input, .mapping-field select {
      background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
      font-family: inherit; font-size: 13px; padding: 6px 10px;
      border-radius: 4px;
    }
    .mapping-field input:focus, .mapping-field select:focus {
      outline: none; border-color: #da70d6;
    }
    .mapping-section-label {
      font-size: 11px; color: #da70d6; font-weight: 500;
      margin-top: 4px; padding-top: 8px;
      border-top: 1px solid #21262d;
    }
    .mapping-actions {
      display: flex; gap: 8px; padding-top: 8px;
      border-top: 1px solid #21262d; margin-top: 4px;
    }
    .mapping-save-btn {
      background: #da70d6; border: none; color: #0d1117;
      font-family: inherit; font-size: 12px; font-weight: 600;
      padding: 6px 16px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .mapping-save-btn:hover { background: #e091dc; }
    .mapping-cancel-btn {
      background: none; border: 1px solid #30363d; color: #8b949e;
      font-family: inherit; font-size: 12px;
      padding: 6px 16px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .mapping-cancel-btn:hover { border-color: #8b949e; color: #e6edf3; }
    .mapping-delete-btn {
      margin-left: auto;
      background: none; border: 1px solid #30363d; color: #f85149;
      font-family: inherit; font-size: 12px;
      padding: 6px 16px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s;
    }
    .mapping-delete-btn:hover { border-color: #f85149; background: rgba(248, 81, 73, 0.1); }
  `;
}

export function serviceMappingModalScript(): string {
  return `
    function openMappingModal(existingId) {
      var modal = $('mappingModal');
      modal.style.display = 'flex';

      // Populate Docker service dropdown
      var dockerSelect = $('mappingDockerService');
      var dockerServices = {};
      STATE.dockerContainers.forEach(function(c) {
        if (c.service) dockerServices[c.service] = true;
      });
      dockerSelect.innerHTML = '<option value="">-- None --</option>';
      Object.keys(dockerServices).sort().forEach(function(svc) {
        dockerSelect.innerHTML += '<option value="' + escapeHtml(svc) + '">' + escapeHtml(svc) + '</option>';
      });

      // Populate Docker project dropdown
      var projectSelect = $('mappingDockerProject');
      var projects = {};
      STATE.dockerContainers.forEach(function(c) {
        if (c.project) projects[c.project] = true;
      });
      projectSelect.innerHTML = '<option value="">-- Any --</option>';
      Object.keys(projects).sort().forEach(function(proj) {
        projectSelect.innerHTML += '<option value="' + escapeHtml(proj) + '">' + escapeHtml(proj) + '</option>';
      });

      // Populate Agent port dropdown
      var portSelect = $('mappingAgentPort');
      var ports = {};
      STATE.services.forEach(function(s) {
        ports[s.port] = s.peer_id;
      });
      portSelect.innerHTML = '<option value="">-- None --</option>';
      Object.keys(ports).sort(function(a, b) { return a - b; }).forEach(function(port) {
        portSelect.innerHTML += '<option value="' + port + '">:' + port + ' (' + escapeHtml(ports[port]) + ')</option>';
      });

      // Pre-fill if editing
      var deleteBtn = $('mappingDeleteBtn');
      if (existingId) {
        var existing = STATE.serviceMappings.find(function(m) { return m.id === existingId; });
        if (existing) {
          $('mappingId').value = existing.id;
          $('mappingDisplayName').value = existing.display_name;
          dockerSelect.value = existing.docker_service || '';
          projectSelect.value = existing.docker_project || '';
          portSelect.value = existing.agent_port ? String(existing.agent_port) : '';
          $('mappingModalTitle').textContent = 'Edit Service Mapping';
          deleteBtn.style.display = '';
        }
      } else {
        $('mappingId').value = '';
        $('mappingDisplayName').value = '';
        dockerSelect.value = '';
        projectSelect.value = '';
        portSelect.value = '';
        $('mappingModalTitle').textContent = 'Add Service Mapping';
        deleteBtn.style.display = 'none';
      }
    }

    function closeMappingModal() {
      $('mappingModal').style.display = 'none';
    }

    function onDockerServiceChange() {
      var name = $('mappingDisplayName');
      var svc = $('mappingDockerService').value;
      if (!name.value && svc) {
        name.value = svc;
      }
    }

    function saveMappingForm() {
      var displayName = $('mappingDisplayName').value.trim();
      if (!displayName) { alert('Display name is required'); return; }

      var dockerService = $('mappingDockerService').value || null;
      var dockerProject = $('mappingDockerProject').value || null;
      var agentPort = $('mappingAgentPort').value ? parseInt($('mappingAgentPort').value, 10) : null;

      if (!dockerService && !agentPort) {
        alert('Select at least a Docker service or an Agent port');
        return;
      }

      var id = $('mappingId').value ? parseInt($('mappingId').value, 10) : undefined;

      wsSend({
        type: 'save_service_mapping',
        mapping: {
          id: id,
          display_name: displayName,
          docker_service: dockerService,
          docker_project: dockerProject,
          agent_port: agentPort
        }
      });

      closeMappingModal();
    }

    function deleteMappingForm() {
      var id = parseInt($('mappingId').value, 10);
      if (!id) return;
      if (!confirm('Delete this service mapping?')) return;
      wsSend({ type: 'delete_service_mapping', id: id });
      closeMappingModal();
    }

    function editMapping(id) {
      openMappingModal(id);
    }
  `;
}

export function serviceMappingModalHtml(): string {
  return `
    <div id="mappingModal" class="mapping-modal-overlay" style="display:none" onclick="closeMappingModal()">
      <div class="mapping-modal" onclick="event.stopPropagation()">
        <div class="mapping-modal-header">
          <h3 id="mappingModalTitle">Add Service Mapping</h3>
          <button class="modal-close" onclick="closeMappingModal()" style="margin-left:auto">&times;</button>
        </div>
        <div class="mapping-modal-body">
          <input type="hidden" id="mappingId" value="">

          <div class="mapping-field">
            <label>Display Name</label>
            <input type="text" id="mappingDisplayName" placeholder="e.g. melosys-api">
          </div>

          <div class="mapping-section-label">Docker Source</div>
          <div class="mapping-field">
            <label>Compose Service</label>
            <select id="mappingDockerService" onchange="onDockerServiceChange()">
              <option value="">-- None --</option>
            </select>
          </div>
          <div class="mapping-field">
            <label>Compose Project</label>
            <select id="mappingDockerProject">
              <option value="">-- Any --</option>
            </select>
          </div>

          <div class="mapping-section-label">Agent Source</div>
          <div class="mapping-field">
            <label>Port</label>
            <select id="mappingAgentPort">
              <option value="">-- None --</option>
            </select>
          </div>

          <div class="mapping-actions">
            <button class="mapping-save-btn" onclick="saveMappingForm()">Save</button>
            <button class="mapping-cancel-btn" onclick="closeMappingModal()">Cancel</button>
            <button class="mapping-delete-btn" id="mappingDeleteBtn" onclick="deleteMappingForm()" style="display:none">Delete</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
