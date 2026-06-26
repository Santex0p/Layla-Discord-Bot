// --- NAVEGACION ---
    const navItems = document.querySelectorAll('.nav-item');
    function switchView(targetId, updateHistory = true) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.add('active');

      // Update sidebar selection
      if (targetId !== 'view-login' && targetId !== 'view-register') {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const activeNav = document.querySelector(`.nav-item[data-target="${targetId}"]`);
        if (activeNav) activeNav.classList.add('active');
      }

      if (updateHistory) {
        history.pushState({ view: targetId }, '', `#${targetId}`);
      }
    }

    // Handle browser back button
    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.view) {
        switchView(e.state.view, false);
      } else {
        // Fallback
        switchView('view-servers', false);
      }
    });

    // --- LOGIC: TABS ---
    document.querySelectorAll('.nav-item[data-target]').forEach(item => {
      item.addEventListener('click', () => {
        switchView(item.getAttribute('data-target'));
      });
    });

    // --- LOGIC: AUTH ---
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status', { method: 'POST' });
        const text = await res.text();
        const data = JSON.parse(text);
        
        if (data.error) {
          alert('Error del servidor al verificar sesión: ' + data.error);
          return;
        }
        
        document.getElementById('sidebar').classList.toggle('hidden', !data.isAuth);
        
        if (data.hasAdmin === false) {
          switchView('view-register');
        } else if (data.isAuth === false) {
          switchView('view-login');
        } else {
          // If URL has a hash, load it on startup, otherwise view-servers
          const hash = window.location.hash.replace('#', '');
          const initialView = hash || 'view-servers';
          switchView(initialView, true);
          
          loadServers();
          loadSettings();
          loadGlobalRelationships();
          connectSSE();
        }
      } catch(e) {
        console.error("Auth check failed", e);
        alert("Error de conexión al verificar estado.");
      }
    }

    async function doLogin() {
      const btn = document.querySelector('#view-login button');
      btn.disabled = true;
      btn.innerText = 'Cargando...';
      const pass = document.getElementById('login-password').value;
      const res = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pass }) });
      if(res.ok) { window.location.href = '/'; }
      else { const d = await res.json(); alert(d.error || 'Login failed'); btn.disabled = false; btn.innerText = 'Ingresar'; }
    }

    async function doRegister() {
      const btn = document.querySelector('#view-register button');
      btn.disabled = true;
      btn.innerText = 'Cargando...';
      const pass = document.getElementById('register-password').value;
      const res = await fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ password: pass }) });
      if(res.ok) { window.location.href = '/'; }
      else { const d = await res.json(); alert(d.error || 'Register failed'); btn.disabled = false; btn.innerText = 'Registrar Admin'; }
    }

    async function doLogout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    }

    // --- ACCIONES DEL MODAL ---
    let currentEditingGuild = null;
    let voskCatalog = [];

    // Cargar catálogo de idiomas Vosk al inicio
    async function loadVoskCatalog() {
      try {
        const res = await fetch('/api/vosk/catalog');
        voskCatalog = await res.json();
      } catch (e) {
        console.error('Error cargando catálogo Vosk:', e);
      }
    }
    loadVoskCatalog();

    async function loadServers() {
      try {
        const res = await fetch('/api/servers');
        const data = await res.json();
        const grid = document.getElementById('servers-grid');
        grid.innerHTML = '';

        for (const [guildId, info] of Object.entries(data)) {
          const letter = info.serverName ? info.serverName.charAt(0).toUpperCase() : '?';

          const card = document.createElement('div');
          card.className = 'server-card';
          card.onclick = () => openServerSettings(guildId, info.serverName, info.prompt, info.language, info.serverIcon, info.replyToLayla, info.triggers);

          const iconContent = info.serverIcon
            ? `<img src="${info.serverIcon}" alt="icon" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`
            : letter;

          card.innerHTML = `
            <div class="server-card-header">
              <div class="server-icon">${iconContent}</div>
              <div>
                <div class="server-name">${info.serverName}</div>
                <div class="server-id">ID: ${guildId}</div>
              </div>
            </div>
            <div class="server-prompt-preview">${info.prompt}</div>
          `;
          grid.appendChild(card);
        }
      } catch (e) {
        console.error("Error cargando servidores:", e);
      }
    }

    // --- API AJUSTES GLOBALES ---
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.RESPOND_ON_MENTION !== undefined) {
          document.getElementById('toggle-mention').checked = data.RESPOND_ON_MENTION;
        }
      } catch (e) {
        console.error("Error cargando ajustes:", e);
      }
    }

    async function toggleSetting(key, value) {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: value })
        });
        if (res.ok) showToast();
      } catch (e) {
        alert('Error al guardar ajuste');
      }
    }

    // --- ACCIONES DEL MODAL ---
    async function resetDefaultPrompt() {
      try {
        const res = await fetch('/api/default-prompt');
        const data = await res.json();
        if (data.prompt) {
          document.getElementById('prompt-textarea').value = data.prompt;
        }
      } catch (e) {
        alert('Error obteniendo el prompt por defecto');
      }
    }

    async function leaveServer() {
      if (!currentEditingGuild) return;
      // Mostrar modal personalizado en vez del confirm() nativo
      document.getElementById('confirm-modal').style.display = 'flex';
    }

    function closeConfirmModal() {
      document.getElementById('confirm-modal').style.display = 'none';
    }

    async function executeLeaveServer() {
      if (!currentEditingGuild) return;
      closeConfirmModal();

      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/leave`, {
          method: 'POST'
        });
        if (res.ok) {
          closeServerSettings();
          loadServers(); // Recargar la lista
          showToast("Layla abandonó el servidor exitosamente");
        } else {
          const data = await res.json();
          alert('Error: ' + data.error);
        }
      } catch (e) {
        alert('Error expulsando al bot');
      }
    }

    // --- VISTA AJUSTES SERVIDOR Y GUARDADO ---
    let currentServerTriggers = [];

    function openServerSettings(guildId, name, prompt, language, iconUrl, replyToLayla, triggers) {
      currentEditingGuild = guildId;
      document.getElementById('settings-server-name').innerText = name;
      document.getElementById('settings-server-id').innerText = `ID: ${guildId}`;
      document.getElementById('prompt-textarea').value = prompt;
      
      const letter = name ? name.charAt(0).toUpperCase() : '?';
      document.getElementById('settings-server-icon').innerHTML = iconUrl
        ? `<img src="${iconUrl}" alt="icon" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`
        : letter;
      
      // Poblar el selector de idiomas
      const select = document.getElementById('language-select');
      select.innerHTML = '';
      for (const lang of voskCatalog) {
        const opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.name;
        if (lang.code === (language || '')) opt.selected = true;
        select.appendChild(opt);
      }
      
      // Configurar Toggle de Respuesta
      document.getElementById('reply-layla-toggle').checked = !!replyToLayla;
      
      // Renderizar Triggers
      currentServerTriggers = triggers || [];
      renderTriggers();

      // Cargar Canales dinámicamente
      loadServerChannels(guildId);

      // Cargar Relaciones y Memorias
      loadServerMembers(guildId);
      loadRelationships(guildId);
      loadMemories(guildId);

      switchView('view-server-settings');
    }

    // --- LÓGICA DE RELACIONES ---
    async function loadServerMembers(guildId) {
      try {
        const res = await fetch(`/api/servers/${guildId}/channels`);
        // Usamos una ruta alternativa: listar miembros del servidor
        const membersRes = await fetch(`/api/servers/${guildId}/members`);
        if (!membersRes.ok) {
          // Si la ruta no existe aún, dejamos los selects vacíos con opción manual
          ['rel-user-select', 'mem-user-select'].forEach(id => {
            const sel = document.getElementById(id);
            sel.innerHTML = '<option value="">Escribe el User ID manualmente...</option>';
          });
          return;
        }
        const members = await membersRes.json();
        ['rel-user-select', 'mem-user-select'].forEach(id => {
          const sel = document.getElementById(id);
          sel.innerHTML = '<option value="">Selecciona un usuario...</option>';
          members.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `${m.displayName} (${m.username})`;
            sel.appendChild(opt);
          });
        });
      } catch (e) {
        console.error('Error cargando miembros:', e);
      }
    }

    async function loadRelationships(guildId) {
      const container = document.getElementById('relationships-list');
      container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Cargando...</span>';
      try {
        const res = await fetch(`/api/servers/${guildId}/relationships`);
        const data = await res.json();
        container.innerHTML = '';

        const entries = Object.entries(data);
        if (entries.length === 0) {
          container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No hay relaciones configuradas aún.</span>';
          return;
        }

        entries.forEach(([userId, rel]) => {
          const div = document.createElement('div');
          div.style.cssText = 'background: rgba(0,0,0,0.15); padding: 12px 16px; border-radius: var(--radius-md); border: 1px solid var(--glass-border); display: flex; justify-content: space-between; align-items: center;';
          div.innerHTML = `
            <div>
              <strong style="color: var(--accent);">${rel.name}</strong> <span style="color: var(--text-muted); font-size: 0.8rem;">(${userId})</span>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 4px;">${rel.relationship}</p>
            </div>
            <button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.8rem;" onclick="deleteRelationship('${userId}')">Eliminar</button>
          `;
          container.appendChild(div);
        });
      } catch (e) {
        container.innerHTML = '<span style="color: var(--danger);">Error cargando relaciones.</span>';
      }
    }

    window.saveRelationship = async function() {
      if (!currentEditingGuild) return;
      const userSelect = document.getElementById('rel-user-select');
      const userId = userSelect.value || prompt('Ingresa el User ID de Discord:');
      const name = document.getElementById('rel-name').value.trim();
      const relationship = document.getElementById('rel-description').value.trim();

      if (!userId || !name || !relationship) {
        alert('Todos los campos son obligatorios.');
        return;
      }

      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/relationships`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, name, relationship })
        });
        if (res.ok) {
          showToast('Relación guardada');
          document.getElementById('rel-name').value = '';
          document.getElementById('rel-description').value = '';
          loadRelationships(currentEditingGuild);
        }
      } catch (e) {
        alert('Error guardando relación');
      }
    };

    window.deleteRelationship = async function(userId) {
      if (!currentEditingGuild || !confirm('¿Eliminar esta relación?')) return;
      try {
        await fetch(`/api/servers/${currentEditingGuild}/relationships/${userId}`, { method: 'DELETE' });
        loadRelationships(currentEditingGuild);
        showToast('Relación eliminada');
      } catch (e) {
        alert('Error eliminando relación');
      }
    };

    // --- LÓGICA DE MEMORIAS ---
    async function loadMemories(guildId) {
      const container = document.getElementById('memories-list');
      container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Cargando...</span>';
      try {
        const res = await fetch(`/api/servers/${guildId}/memories`);
        const data = await res.json();
        container.innerHTML = '';

        const entries = Object.entries(data);
        if (entries.length === 0) {
          container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No hay memorias aún. Se crearán automáticamente o puedes añadirlas manualmente.</span>';
          return;
        }

        entries.forEach(([userId, mems]) => {
          // Encabezado por usuario
          const header = document.createElement('div');
          header.style.cssText = 'font-weight: bold; color: var(--accent); font-size: 0.95rem; margin-top: 8px;';
          header.textContent = `👤 Usuario: ${userId}`;
          container.appendChild(header);

          mems.forEach(mem => {
            const div = document.createElement('div');
            div.style.cssText = 'background: rgba(0,0,0,0.15); padding: 10px 16px; border-radius: var(--radius-md); border: 1px solid var(--glass-border); display: flex; justify-content: space-between; align-items: center; margin-left: 16px;';
            const date = mem.createdAt ? new Date(mem.createdAt).toLocaleDateString() : '?';
            div.innerHTML = `
              <div>
                <p style="color: var(--text-secondary); font-size: 0.9rem;">${mem.text}</p>
                <span style="color: var(--text-muted); font-size: 0.75rem;">Creado: ${date}</span>
              </div>
              <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.75rem;" onclick="deleteMemory('${userId}', '${mem.id}')">×</button>
            `;
            container.appendChild(div);
          });
        });
      } catch (e) {
        container.innerHTML = '<span style="color: var(--danger);">Error cargando memorias.</span>';
      }
    }

    window.saveMemory = async function() {
      if (!currentEditingGuild) return;
      const userSelect = document.getElementById('mem-user-select');
      const userId = userSelect.value || prompt('Ingresa el User ID de Discord:');
      const text = document.getElementById('mem-text').value.trim();

      if (!userId || !text) {
        alert('Selecciona un usuario y escribe el recuerdo.');
        return;
      }

      const btn = document.querySelector('#memories-list ~ div .btn-primary') || event.target;
      const originalText = btn.innerText;
      btn.innerText = 'Procesando...';
      btn.disabled = true;

      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/memories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, text })
        });
        const result = await res.json();
        if (result.success) {
          showToast('Memoria guardada');
          document.getElementById('mem-text').value = '';
          loadMemories(currentEditingGuild);
        } else if (result.duplicate) {
          alert('Esta memoria ya existe (duplicado detectado).');
        } else {
          alert('Error guardando memoria: ' + (result.error || 'Desconocido'));
        }
      } catch (e) {
        alert('Error de red guardando memoria');
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    };

    window.deleteMemory = async function(userId, memoryId) {
      if (!currentEditingGuild || !confirm('¿Eliminar este recuerdo?')) return;
      try {
        await fetch(`/api/servers/${currentEditingGuild}/memories/${userId}/${memoryId}`, { method: 'DELETE' });
        loadMemories(currentEditingGuild);
        showToast('Memoria eliminada');
      } catch (e) {
        alert('Error eliminando memoria');
      }
    };

    // --- RELACIONES GLOBALES ---
    async function loadGlobalRelationships() {
      try {
        const res = await fetch('/api/global-relationships');
        const data = await res.json();
        
        const listDiv = document.getElementById('global-relationships-list');
        listDiv.innerHTML = '';
        
        if (Object.keys(data).length === 0) {
          listDiv.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No hay administradores registrados.</p>';
          return;
        }

        for (const [userId, info] of Object.entries(data)) {
          const card = document.createElement('div');
          card.style.cssText = 'background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); padding: 16px; border-radius: var(--radius-md); display: flex; justify-content: space-between; align-items: center;';
          
          card.innerHTML = `
            <div>
              <div style="font-weight: 600; font-size: 1.1rem; margin-bottom: 4px; color: var(--accent);">${info.name} <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: normal;">(${userId})</span></div>
              <div style="color: var(--text-muted);">${info.relationship}</div>
            </div>
            <button class="btn btn-danger" onclick="deleteGlobalRelationship('${userId}')">Eliminar</button>
          `;
          listDiv.appendChild(card);
        }
      } catch (e) {
        console.error('Error cargando relaciones globales', e);
      }
    }

    async function saveGlobalRelationship() {
      const userId = document.getElementById('global-rel-userid').value.trim();
      const name = document.getElementById('global-rel-name').value.trim();
      const relationship = document.getElementById('global-rel-desc').value.trim();
      
      if (!userId || !name || !relationship) {
        alert('Por favor, completa todos los campos.');
        return;
      }
      
      try {
        const res = await fetch('/api/global-relationships', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, name, relationship })
        });
        
        if (res.ok) {
          document.getElementById('global-rel-userid').value = '';
          document.getElementById('global-rel-name').value = '';
          document.getElementById('global-rel-desc').value = '';
          loadGlobalRelationships();
        } else {
          const err = await res.json();
          alert('Error: ' + err.error);
        }
      } catch (e) {
        console.error(e);
        alert('Error de conexión');
      }
    }

    async function deleteGlobalRelationship(userId) {
      if (!confirm('¿Estás seguro de eliminar este administrador global?')) return;
      try {
        const res = await fetch(`/api/global-relationships/${userId}`, { method: 'DELETE' });
        if (res.ok) {
          loadGlobalRelationships();
        } else {
          alert('Error eliminando administrador');
        }
      } catch (e) {
        console.error(e);
      }
    }

    // --- LÓGICA DE PALABRAS DETONANTES (PILLS) ---
    let currentTriggerWords = [];

    window.addTriggerWord = function() {
      const input = document.getElementById('trigger-word-input');
      const word = input.value.trim().toLowerCase();
      if (word && !currentTriggerWords.includes(word)) {
        currentTriggerWords.push(word);
        renderTriggerWords();
      }
      input.value = '';
    };

    window.removeTriggerWord = function(index) {
      currentTriggerWords.splice(index, 1);
      renderTriggerWords();
    };

    function renderTriggerWords() {
      const container = document.getElementById('trigger-words-container');
      container.innerHTML = '';
      currentTriggerWords.forEach((w, i) => {
        const pill = document.createElement('span');
        pill.style.cssText = 'background: rgba(var(--accent-rgb), 0.2); border: 1px solid var(--accent); color: var(--accent); padding: 4px 8px; border-radius: 12px; font-size: 0.85rem; display: flex; align-items: center; gap: 4px;';
        pill.innerHTML = `"${w}" <button style="background:none;border:none;color:inherit;cursor:pointer;font-weight:bold;margin-left:4px;padding:0;" onclick="removeTriggerWord(${i})">×</button>`;
        container.appendChild(pill);
      });
    }

    async function loadServerChannels(guildId) {
      const container = document.getElementById('trigger-channels-container');
      container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Cargando canales...</span>';
      try {
        const res = await fetch(`/api/servers/${guildId}/channels`);
        if (!res.ok) throw new Error('Failed to load');
        const channels = await res.json();
        
        container.innerHTML = '';
        if (channels.length === 0) {
          container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No se encontraron canales de texto.</span>';
          return;
        }

        channels.forEach(ch => {
          const label = document.createElement('label');
          label.style.cssText = 'display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.2); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; border: 1px solid var(--border-color); transition: all 0.2s;';
          label.onmouseover = () => label.style.borderColor = 'var(--accent)';
          label.onmouseout = () => {
            const cb = label.querySelector('input');
            if(!cb.checked) label.style.borderColor = 'var(--border-color)';
          };

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = ch.id;
          checkbox.className = 'channel-checkbox';
          checkbox.onchange = () => {
            label.style.borderColor = checkbox.checked ? 'var(--accent)' : 'var(--border-color)';
            label.style.background = checkbox.checked ? 'rgba(var(--accent-rgb), 0.2)' : 'rgba(0,0,0,0.2)';
          };

          const span = document.createElement('span');
          span.textContent = `#${ch.name}`;

          label.appendChild(checkbox);
          label.appendChild(span);
          container.appendChild(label);
        });
      } catch (e) {
        container.innerHTML = '<span style="color: var(--danger); font-size: 0.85rem;">Error cargando canales. Asegúrate de que el bot esté encendido y conectado.</span>';
      }
    }

    // --- LÓGICA DE TRIGGERS Y REPLY ---
    window.toggleReplySetting = async function(isChecked) {
      if (!currentEditingGuild) return;
      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/reply-setting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ replyToLayla: isChecked })
        });
        if (res.ok) {
          showToast("Ajuste de respuesta guardado");
          loadServers(); // Refrescar caché
        }
      } catch (e) {
        alert("Error guardando ajuste");
      }
    }

    function renderTriggers() {
      const list = document.getElementById('triggers-list');
      if (!list) return;
      list.innerHTML = '';
      if (currentServerTriggers.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem; font-style: italic;">No hay detonantes configurados.</p>';
        return;
      }

      currentServerTriggers.forEach((trigger, index) => {
        const item = document.createElement('div');
        item.style.cssText = 'background: rgba(0,0,0,0.15); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px; display: flex; justify-content: space-between; align-items: center;';
        
        const info = document.createElement('div');
        info.innerHTML = `
          <div style="font-weight: 700; color: var(--accent); margin-bottom: 4px;">"${trigger.word}"</div>
          <div style="font-size: 0.85rem; margin-bottom: 2px;">Significado: <span style="color: var(--text-muted);">${trigger.meaning}</span></div>
          <div style="font-size: 0.8rem;">Canales: <span style="color: var(--info);">${trigger.channels.length > 0 ? trigger.channels.join(', ') : 'Todos'}</span></div>
        `;

        const btn = document.createElement('button');
        btn.className = 'btn btn-danger';
        btn.style.padding = '4px 8px';
        btn.style.fontSize = '0.8rem';
        btn.innerText = 'Eliminar';
        btn.onclick = () => removeTrigger(index);

        item.appendChild(info);
        item.appendChild(btn);
        list.appendChild(item);
      });
    }

    window.addTrigger = async function() {
      if (!currentEditingGuild) return;
      
      const meaningInput = document.getElementById('trigger-meaning');

      // Obtener canales seleccionados
      const checkboxes = document.querySelectorAll('#trigger-channels-container .channel-checkbox:checked');
      const selectedChannels = Array.from(checkboxes).map(cb => cb.value);

      const meaning = meaningInput.value.trim();

      if (currentTriggerWords.length === 0 || !meaning) {
        alert("Debes añadir al menos una palabra detonante y un significado.");
        return;
      }
      
      if (selectedChannels.length === 0) {
        alert("Debes seleccionar al menos un canal para evitar que el bot haga spam en todo el servidor.");
        return;
      }

      // Unir palabras por coma para el backend
      const wordStr = currentTriggerWords.join(', ');

      currentServerTriggers.push({ word: wordStr, meaning, channels: selectedChannels });
      renderTriggers();
      
      // Limpiar form
      currentTriggerWords = [];
      renderTriggerWords();
      meaningInput.value = '';
      
      // Deseleccionar checkboxes
      checkboxes.forEach(cb => cb.checked = false);
      document.querySelectorAll('#trigger-channels-container label').forEach(lbl => {
        lbl.style.borderColor = 'var(--border-color)';
        lbl.style.background = 'rgba(0,0,0,0.2)';
      });

      await saveTriggers();
    }

    async function removeTrigger(index) {
      if (!currentEditingGuild) return;
      currentServerTriggers.splice(index, 1);
      renderTriggers();
      await saveTriggers();
    }

    async function saveTriggers() {
      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/triggers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triggers: currentServerTriggers })
        });
        if (res.ok) {
          showToast("Detonantes guardados");
          loadServers(); // Refrescar caché principal
        } else {
          alert("Error al guardar en el servidor");
        }
      } catch (e) {
        alert("Error de red guardando detonantes");
      }
    }

    // Exponer globalmente para el botón onclick en index.html
    window.closeServerSettings = function() {
      switchView('view-servers');
      currentEditingGuild = null;
    }

    // --- VISTA PERFIL DEL BOT ---
    window.openBotProfile = async function() {
      switchView('view-bot-profile');
      try {
        const res = await fetch('/api/servers');
        const data = await res.json();
        document.getElementById('profile-servers-count').innerText = Object.keys(data).length;
      } catch (e) {
        console.error("Error obteniendo conteo de servidores", e);
      }
    };

    window.closeBotProfile = function() {
      switchView('view-servers');
    };

    async function savePrompt() {
      if (!currentEditingGuild) return;
      const newPrompt = document.getElementById('prompt-textarea').value;
      const newLanguage = document.getElementById('language-select').value;
      const btn = document.querySelector('.btn-primary');
      const originalText = btn.innerText;

      btn.innerText = "Guardando...";
      btn.disabled = true;

      try {
        // Guardar prompt
        const res = await fetch(`/api/servers/${currentEditingGuild}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: newPrompt })
        });

        // Guardar idioma
        if (newLanguage) {
          await fetch(`/api/servers/${currentEditingGuild}/language`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: newLanguage })
          });
        }

        if (res.ok) {
          closeServerSettings();
          showToast();
          loadServers();
        } else {
          alert('Error al guardar el prompt');
        }
      } catch (e) {
        alert('Error de conexión');
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    }

    function showToast() {
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // --- CONSOLA SSE ---
    const logsContainer = document.getElementById('logs');
    const consoleEl = document.getElementById('console-scroll');
    const statusDot = document.getElementById('global-status');
    const scrollBtn = document.getElementById('scroll-to-bottom-btn');
    const newLogDot = document.getElementById('new-log-indicator');

    // Función para ir al final manualmente
    function scrollToBottom() {
      consoleEl.scrollTop = consoleEl.scrollHeight;
      scrollBtn.classList.add('hidden');
      newLogDot.classList.add('hidden');
    }

    // Detectar scroll manual
    consoleEl.addEventListener('scroll', () => {
      const isAtBottom = consoleEl.scrollHeight - consoleEl.scrollTop <= consoleEl.clientHeight + 50;
      if (isAtBottom) {
        scrollBtn.classList.add('hidden');
        newLogDot.classList.add('hidden');
      } else {
        scrollBtn.classList.remove('hidden');
      }
    });

    function formatTime(iso) {
      return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
    }

    function addLog(logData) {
      const div = document.createElement('div');
      div.className = `log-entry log-${logData.level}`;

      const timeStr = formatTime(logData.timestamp);
      let safeText = String(logData.text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      safeText = safeText.replace(/\[(.*?)\]/g, '<span class="log-highlight">[$1]</span>');

      div.innerHTML = `
        <span class="timestamp">${timeStr}</span>
        <span class="badge">${logData.level}</span>
        <span class="log-text">${safeText}</span>
      `;

      logsContainer.appendChild(div);
      if (logsContainer.children.length > 500) logsContainer.removeChild(logsContainer.firstChild);

      // Auto-scroll
      const isAtBottom = consoleEl.scrollHeight - consoleEl.scrollTop <= consoleEl.clientHeight + 100;
      if (isAtBottom) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      } else {
        // Mostrar indicador de nuevo mensaje si no está al final
        if (scrollBtn) scrollBtn.classList.remove('hidden');
        if (newLogDot) newLogDot.classList.remove('hidden');
      }
    }

    function connectSSE() {
      const eventSource = new EventSource('/stream');

      eventSource.onmessage = (e) => {
        try { addLog(JSON.parse(e.data)); } catch (err) { }
      };

      eventSource.onopen = () => {
        statusDot.style.backgroundColor = 'var(--success)';
        statusDot.style.boxShadow = '0 0 8px var(--success)';
      };

      eventSource.onerror = () => {
        statusDot.style.backgroundColor = 'var(--danger)';
        statusDot.style.boxShadow = '0 0 8px var(--danger)';
        eventSource.close();
        setTimeout(connectSSE, 3000);
      };
    }

    // Inicializar
    checkAuth();