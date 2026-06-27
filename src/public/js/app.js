// --- NAVEGACION ---
    const navItems = document.querySelectorAll('.nav-item');
    let currentView = 'view-servers';

    // Función para menú móvil
    window.toggleMobileMenu = function() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('mobile-overlay');
      if (sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
      } else {
        sidebar.classList.add('open');
        overlay.classList.add('active');
      }
    };

    function switchView(targetId, updateHistory = true) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const targetView = document.getElementById(targetId);
      if (targetView) targetView.classList.add('active');

      // Update sidebar selection — only touch main nav items, not server-nav-items
      if (targetId !== 'view-login' && targetId !== 'view-register') {
        // Handle Sidebar Menu Visibility
        if (targetId === 'view-server-container') {
          if (!currentEditingGuild) {
            // Si el usuario recargó la página y se perdió el contexto del servidor, forzar al inicio.
            targetId = 'view-servers';
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById('view-servers').classList.add('active');
            document.getElementById('main-nav-menu').style.display = 'flex';
            document.getElementById('server-nav-menu').style.display = 'none';
          } else {
            document.getElementById('main-nav-menu').style.display = 'none';
            document.getElementById('server-nav-menu').style.display = 'flex';
          }
        } else {
          document.getElementById('main-nav-menu').style.display = 'flex';
          document.getElementById('server-nav-menu').style.display = 'none';
          currentEditingGuild = null; // Reseteamos el servidor activo si salimos de su vista
        }

        document.querySelectorAll('#main-nav-menu .nav-item').forEach(n => n.classList.remove('active'));
        const activeNav = document.querySelector(`#main-nav-menu .nav-item[data-target="${targetId}"]`);
        if (activeNav) activeNav.classList.add('active');
        
        // Cerrar sidebar en móviles tras hacer clic
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('mobile-overlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
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
          customAlert('Atención', 'Error del servidor al verificar sesión: ' + data.error);
          return;
        }
        
        document.getElementById('sidebar').classList.toggle('hidden', !data.isAuth);
        
        if (data.hasAdmin === false) {
          switchView('view-register');
        } else if (data.isAuth === false) {
          switchView('view-login');
        } else {
          // If URL has a hash, load it on startup, otherwise view-servers
          let hash = window.location.hash.replace('#', '');
          if (hash.startsWith('subview-')) hash = 'view-servers'; // Fallback if refreshing inside a server subview
          const initialView = hash || 'view-servers';
          switchView(initialView, true);
          
          loadServers();
          loadSettings();
          loadGlobalRelationships();
          connectSSE();
        }
      } catch(e) {
        console.error("Auth check failed", e);
        customAlert('Atención', "Error de conexión al verificar estado.");
      }
    }

    async function doLogin() {
      const btn = document.querySelector('#view-login button');
      btn.disabled = true;
      btn.innerText = 'Cargando...';
      const pass = document.getElementById('login-password').value;
      const res = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pass }) });
      if(res.ok) { window.location.href = '/'; }
      else { const d = await res.json(); customAlert('Atención', d.error || 'Login failed'); btn.disabled = false; btn.innerText = 'Ingresar'; }
    }

    async function doRegister() {
      const btn = document.querySelector('#view-register button');
      btn.disabled = true;
      btn.innerText = 'Cargando...';
      const pass = document.getElementById('register-password').value;
      const res = await fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ password: pass }) });
      if(res.ok) { window.location.href = '/'; }
      else { const d = await res.json(); customAlert('Atención', d.error || 'Register failed'); btn.disabled = false; btn.innerText = 'Registrar Admin'; }
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
            <div class="server-card-header" style="border-bottom: none; margin-bottom: 0;">
              <div class="server-icon">${iconContent}</div>
              <div>
                <div class="server-name">${info.serverName}</div>
                <div class="server-id">ID: ${guildId}</div>
              </div>
            </div>
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
        customAlert('Atención', 'Error al guardar ajuste');
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
        customAlert('Atención', 'Error obteniendo el prompt por defecto');
      }
    }


    window.customAlert = function(title, message) {
      return new Promise((resolve) => {
        const modal = document.getElementById('alert-modal');
        document.getElementById('alert-modal-title').innerText = title || 'Alerta';
        document.getElementById('alert-modal-message').innerText = message;
        
        modal.style.display = 'flex';

        const btnOk = document.getElementById('alert-modal-ok');
        const onOk = () => { 
          modal.style.display = 'none';
          btnOk.removeEventListener('click', onOk);
          resolve();
        };

        btnOk.addEventListener('click', onOk);
      });
    }

    window.customPrompt = function(title, placeholder) {
      return new Promise((resolve) => {
        const modal = document.getElementById('prompt-modal');
        document.getElementById('prompt-modal-title').innerText = title || 'Ingreso de Datos';
        const input = document.getElementById('prompt-modal-input');
        input.placeholder = placeholder || '';
        input.value = '';
        
        modal.style.display = 'flex';
        input.focus();

        const btnOk = document.getElementById('prompt-modal-ok');
        const btnCancel = document.getElementById('prompt-modal-cancel');

        const cleanup = () => {
          modal.style.display = 'none';
          btnOk.removeEventListener('click', onOk);
          btnCancel.removeEventListener('click', onCancel);
        };

        const onOk = () => { cleanup(); resolve(input.value); };
        const onCancel = () => { cleanup(); resolve(null); };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
      });
    }

    function customConfirm(title, message, okText = 'Sí, confirmar') {
      return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-modal-title').innerText = title;
        document.getElementById('confirm-modal-message').innerText = message;
        document.getElementById('confirm-modal-ok').innerText = okText;
        
        modal.style.display = 'flex';

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };

        const btnOk = document.getElementById('confirm-modal-ok');
        const btnCancel = document.getElementById('confirm-modal-cancel');

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);

        function cleanup() {
          modal.style.display = 'none';
          btnOk.removeEventListener('click', onOk);
          btnCancel.removeEventListener('click', onCancel);
        }
      });
    }

    async function leaveServer() {
      if (!currentEditingGuild) return;
      const confirmed = await customConfirm(
        '¿Expulsar a Layla?',
        '¿Estás 100% seguro de que quieres expulsar a Layla de este servidor? Tendrás que volver a invitarla manualmente con el enlace de Discord si te arrepientes.',
        'Sí, expulsarla'
      );
      if (confirmed) {
        executeLeaveServer();
      }
    }

    async function executeLeaveServer() {
      if (!currentEditingGuild) return;

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
          customAlert('Atención', 'Error: ' + data.error);
        }
      } catch (e) {
        customAlert('Atención', 'Error expulsando al bot');
      }
    }

    // --- VISTA AJUSTES SERVIDOR Y GUARDADO ---
    let currentServerTriggers = [];

    function openServerSettings(guildId, name, prompt, language, iconUrl, replyToLayla, triggers) {
      currentEditingGuild = guildId;
      document.getElementById('sticky-server-name').innerText = name;
      document.getElementById('sticky-server-id').innerText = `ID: ${guildId}`;
      document.getElementById('prompt-textarea').value = prompt;
      
      const letter = name ? name.charAt(0).toUpperCase() : '?';
      document.getElementById('sticky-server-icon').innerHTML = iconUrl
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

      // UI Contextual Sidebar handled in switchView now
      
      switchServerSubview('subview-prompt');
      switchView('view-server-container');
    }

    function closeServerSettings() {
      switchView('view-servers');
    }

    // -- Lógica de Subviews del servidor --
    function switchServerSubview(subviewId) {
      document.querySelectorAll('.subview').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.server-nav-item').forEach(el => el.classList.remove('active'));
      
      const target = document.getElementById(subviewId);
      if (target) target.classList.add('active');
      
      const navItem = document.querySelector(`.server-nav-item[data-subview="${subviewId}"]`);
      if (navItem) navItem.classList.add('active');
    }

    document.querySelectorAll('.server-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        switchServerSubview(item.getAttribute('data-subview'));
        
        // Cerrar sidebar en móviles tras hacer clic
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('mobile-overlay');
        if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('open');
        if (overlay && window.innerWidth <= 768) overlay.classList.remove('active');
      });
    });

    window.userCache = window.userCache || {};
    window.userAvatarCache = window.userAvatarCache || {};
    
    async function resolveUsername(userId) {
      if (window.userCache[userId]) return window.userCache[userId];
      try {
        const res = await fetch(`/api/users/${userId}`);
        if (res.ok) {
          const data = await res.json();
          const name = `@${data.username}`;
          window.userCache[userId] = name;
          if (data.avatarURL) window.userAvatarCache[userId] = data.avatarURL;
          return name;
        }
      } catch(e) {}
      return userId;
    }

    async function resolveUserAvatar(userId) {
      if (window.userAvatarCache[userId]) return window.userAvatarCache[userId];
      // Resolve name will also cache avatar if it exists
      await resolveUsername(userId);
      return window.userAvatarCache[userId] || `https://cdn.discordapp.com/embed/avatars/${(userId % 5) || 0}.png`;
    }

    function setupCustomDropdown(inputId, listId) {
      const input = document.getElementById(inputId);
      const list = document.getElementById(listId);
      if (!input || !list) return;

      input.addEventListener('focus', () => {
        list.classList.add('active');
        filterList();
      });

      input.addEventListener('input', () => {
        list.classList.add('active');
        filterList();
        input.removeAttribute('data-selected-id'); // User is typing, clear selection
        input.removeAttribute('data-selected-name');
      });

      function filterList() {
        const filter = input.value.toLowerCase();
        const items = list.querySelectorAll('.custom-dropdown-item');
        items.forEach(item => {
          const text = item.textContent.toLowerCase();
          if (text.includes(filter)) {
            item.style.display = 'block';
          } else {
            item.style.display = 'none';
          }
        });
      }

      // Cerrar al hacer clic fuera
      document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !list.contains(e.target)) {
          list.classList.remove('active');
        }
      });
    }

    // Inicializar dropdowns
    setupCustomDropdown('rel-user-select', 'rel-user-dropdown-list');
    setupCustomDropdown('mem-user-select', 'mem-user-dropdown-list');

    function getUserIdFromDropdown(inputId) {
      const input = document.getElementById(inputId);
      if (!input) return null;
      return input.getAttribute('data-selected-id') || input.value.trim();
    }

    function setDropdownValueFromId(inputId, listId, userId) {
      const input = document.getElementById(inputId);
      const list = document.getElementById(listId);
      if (!input || !list) return;
      
      const option = list.querySelector(`.custom-dropdown-item[data-id="${userId}"]`);
      if (option) {
        input.value = option.textContent;
        input.setAttribute('data-selected-id', userId);
        input.setAttribute('data-selected-name', option.getAttribute('data-name'));
      } else {
        input.value = userId;
        input.removeAttribute('data-selected-id');
        input.removeAttribute('data-selected-name');
      }
    }

    // --- LÓGICA DE RELACIONES ---
    async function loadServerMembers(guildId) {
      try {
        const res = await fetch(`/api/servers/${guildId}/channels`);
        // Usamos una ruta alternativa: listar miembros del servidor
        const membersRes = await fetch(`/api/servers/${guildId}/members`);
        if (!membersRes.ok) {
          ['rel-user-dropdown-list', 'mem-user-dropdown-list'].forEach(id => {
            const dl = document.getElementById(id);
            if (dl) dl.innerHTML = '';
          });
          return;
        }
        const members = await membersRes.json();
        members.forEach(m => window.userCache[m.id] = `@${m.username}`); // Pre-cache

        // Llenar listas dropdown
        ['rel-user', 'mem-user'].forEach(prefix => {
          const list = document.getElementById(`${prefix}-dropdown-list`);
          if (!list) return;
          list.innerHTML = '';
          members.forEach(m => {
            const div = document.createElement('div');
            div.className = 'custom-dropdown-item';
            div.textContent = `@${m.username} (${m.displayName})`;
            div.setAttribute('data-id', m.id);
            div.setAttribute('data-name', m.displayName);
            div.addEventListener('click', () => {
              const input = document.getElementById(`${prefix}-select`);
              input.value = div.textContent;
              input.setAttribute('data-selected-id', m.id);
              input.setAttribute('data-selected-name', m.displayName);
              list.classList.remove('active');
            });
            list.appendChild(div);
          });
        });
      } catch (e) {
        console.error('Error cargando miembros:', e);
      }
    }

    window.editRelationship = function(userId, nameEncoded, descEncoded) {
      const name = decodeURIComponent(nameEncoded);
      const desc = decodeURIComponent(descEncoded);
      
      setDropdownValueFromId('rel-user-select', 'rel-user-dropdown-list', userId);
      const input = document.getElementById('rel-user-select');
      if (!input.getAttribute('data-selected-id')) {
        input.setAttribute('data-selected-id', userId);
        input.setAttribute('data-selected-name', name);
        input.value = `${name} (${userId})`;
      }
      document.getElementById('rel-description').value = desc;
      document.getElementById('rel-description').focus();
    };

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

        for (const [userId, rel] of entries) {
          const resolvedName = await resolveUsername(userId);
          const div = document.createElement('div');
          div.style.cssText = 'background: rgba(0,0,0,0.15); padding: 12px 16px; border-radius: var(--radius-md); border: 1px solid var(--glass-border); display: flex; justify-content: space-between; align-items: center;';
          div.innerHTML = `
            <div>
              <strong style="color: var(--accent);">${rel.name}</strong> <span style="color: var(--text-muted); font-size: 0.8rem;">(${resolvedName})</span>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 4px;">${rel.relationship}</p>
            </div>
            <div>
              <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.8rem; margin-right: 8px;" onclick="editRelationship('${userId}', '${encodeURIComponent(rel.name)}', '${encodeURIComponent(rel.relationship)}')">Editar</button>
              <button class="btn btn-danger" style="padding: 6px 12px; font-size: 0.8rem;" onclick="deleteRelationship('${userId}')">Eliminar</button>
            </div>
          `;
          container.appendChild(div);
        }
      } catch (e) {
        container.innerHTML = '<span style="color: var(--danger);">Error cargando relaciones.</span>';
      }
    }

    window.saveRelationship = async function() {
      if (!currentEditingGuild) return;
      const inputEl = document.getElementById('rel-user-select');
      const userIdStr = getUserIdFromDropdown('rel-user-select');
      const userId = userIdStr || await customPrompt('Ingreso', 'Ingresa el User ID de Discord:');
      
      // Auto-extract name if not set manually (rel-name field removed)
      let name = inputEl.getAttribute('data-selected-name');
      if (!name) {
        // If they typed "@username (DisplayName)", try to extract Name or fallback to the whole string
        const val = inputEl.value.trim();
        const match = val.match(/\((.*?)\)/);
        name = match ? match[1] : val;
        if (!name) name = `@Unknown`; // Default if completely empty
      }
      
      const relationship = document.getElementById('rel-description').value.trim();

      if (!userId || !name || !relationship) {
        customAlert('Atención', 'Todos los campos son obligatorios.');
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
        customAlert('Atención', 'Error guardando relación');
      }
    };

    window.deleteRelationship = async function(userId) {
      if (!currentEditingGuild) return;
      const confirmed = await customConfirm('¿Eliminar Relación?', '¿Eliminar esta relación de forma permanente?', 'Eliminar');
      if (!confirmed) return;
      try {
        await fetch(`/api/servers/${currentEditingGuild}/relationships/${userId}`, { method: 'DELETE' });
        loadRelationships(currentEditingGuild);
        showToast('Relación eliminada');
      } catch (e) {
        customAlert('Atención', 'Error eliminando relación');
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

        const allMemories = [];
        for (const [userId, mems] of entries) {
          mems.forEach(mem => {
            allMemories.push({ userId, ...mem });
          });
        }
        
        // Ordenar de más reciente a más antiguo
        allMemories.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        for (const mem of allMemories) {
          const resolvedName = await resolveUsername(mem.userId);
          const avatarUrl = await resolveUserAvatar(mem.userId);
          const date = mem.createdAt ? new Date(mem.createdAt).toLocaleDateString() : '?';
          
          const div = document.createElement('div');
          div.className = 'memory-row';
          div.innerHTML = `
            <img class="memory-avatar" src="${avatarUrl}" alt="Avatar">
            <div class="memory-content-box">
              <div class="memory-badge">MEMORIA MANUAL • ${resolvedName}</div>
              <div class="memory-text">${mem.text}</div>
            </div>
            <div class="memory-date-pill">${date}</div>
            <div class="memory-actions">
              <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.8rem;" onclick="editMemory('${mem.userId}', '${mem.id}', '${mem.text.replace(/'/g, "\\'")}')">✏️</button>
              <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.8rem;" onclick="deleteMemory('${mem.userId}', '${mem.id}')">×</button>
            </div>
          `;
          container.appendChild(div);
        }
      } catch (e) {
        container.innerHTML = '<span style="color: var(--danger);">Error cargando memorias.</span>';
      }
    }

    window.editingMemoryId = null;

    window.editMemory = function(userId, memoryId, text) {
      window.editingMemoryId = { userId, memoryId };
      setDropdownValueFromId('mem-user-select', 'mem-user-dropdown-list', userId);
      document.getElementById('mem-user-select').disabled = true;
      document.getElementById('mem-user-select').style.opacity = '0.6';
      
      document.getElementById('mem-text').value = text;
      document.getElementById('mem-text').focus();
      
      document.getElementById('cancel-edit-mem-btn').style.display = 'inline-block';
      document.getElementById('save-mem-btn').innerText = 'Guardar Edición';
    };

    window.cancelEditMemory = function() {
      window.editingMemoryId = null;
      const userSelect = document.getElementById('mem-user-select');
      userSelect.disabled = false;
      userSelect.style.opacity = '1';
      userSelect.value = '';
      
      document.getElementById('mem-text').value = '';
      document.getElementById('cancel-edit-mem-btn').style.display = 'none';
      document.getElementById('save-mem-btn').innerText = 'Guardar Memoria';
    };

    window.saveMemory = async function() {
      if (!currentEditingGuild) return;
      
      const userIdStr = getUserIdFromDropdown('mem-user-select');
      const userId = userIdStr || await customPrompt('Ingreso', 'Ingresa el User ID de Discord:');
      const text = document.getElementById('mem-text').value.trim();

      if (!userId || !text) {
        customAlert('Atención', 'Selecciona un usuario y escribe el recuerdo.');
        return;
      }

      const btn = document.querySelector('#memories-list ~ div .btn-primary') || event.target;
      const originalText = btn.innerText;
      btn.innerText = 'Procesando...';
      btn.disabled = true;

      try {
        if (window.editingMemoryId) {
          await fetch(`/api/servers/${currentEditingGuild}/memories/${window.editingMemoryId.userId}/${window.editingMemoryId.memoryId}`, { method: 'DELETE' });
          window.editingMemoryId = null;
        }

        const res = await fetch(`/api/servers/${currentEditingGuild}/memories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, text })
        });
        const result = await res.json();
        if (result.success) {
          showToast('Memoria guardada');
          cancelEditMemory(); // Limpia y resetea los botones
          loadMemories(currentEditingGuild);
        } else if (result.duplicate) {
          customAlert('Atención', 'Esta memoria ya existe (duplicado detectado).');
        } else {
          customAlert('Atención', 'Error guardando memoria: ' + (result.error || 'Desconocido'));
        }
      } catch (e) {
        customAlert('Atención', 'Error de red guardando memoria');
      } finally {
        btn.innerText = window.editingMemoryId ? 'Guardar Edición' : 'Guardar Memoria';
        btn.disabled = false;
      }
    };

    window.deleteMemory = async function(userId, memoryId) {
      if (!currentEditingGuild) return;
      const confirmed = await customConfirm('¿Borrar Memoria?', '¿Borrar esta memoria permanentemente?', 'Eliminar');
      if (!confirmed) return;
      try {
        await fetch(`/api/servers/${currentEditingGuild}/memories/${userId}/${memoryId}`, { method: 'DELETE' });
        loadMemories(currentEditingGuild);
        showToast('Memoria eliminada');
      } catch (e) {
        customAlert('Atención', 'Error eliminando memoria');
      }
    };

    window.editGlobalRelationship = function(userId, nameEncoded, descEncoded) {
      const name = decodeURIComponent(nameEncoded);
      const desc = decodeURIComponent(descEncoded);
      document.getElementById('global-rel-userid').value = userId;
      document.getElementById('global-rel-name').value = name;
      document.getElementById('global-rel-desc').value = desc;
      document.getElementById('global-rel-desc').focus();
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
          const resolvedName = await resolveUsername(userId);
          const card = document.createElement('div');
          card.style.cssText = 'background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.05); padding: 16px; border-radius: var(--radius-md); display: flex; justify-content: space-between; align-items: center;';
          
          card.innerHTML = `
            <div>
              <div style="font-weight: 600; font-size: 1.1rem; margin-bottom: 4px; color: var(--accent);">${info.name} <span style="font-size: 0.9rem; color: var(--text-muted); font-weight: normal;">(${resolvedName})</span></div>
              <div style="color: var(--text-muted);">${info.relationship}</div>
            </div>
            <div>
              <button class="btn btn-secondary" style="margin-right: 8px;" onclick="editGlobalRelationship('${userId}', '${encodeURIComponent(info.name)}', '${encodeURIComponent(info.relationship)}')">Editar</button>
              <button class="btn btn-danger" onclick="deleteGlobalRelationship('${userId}')">Eliminar</button>
            </div>
          `;
          listDiv.appendChild(card);
        }
      } catch (e) {
        console.error('Error cargando relaciones globales', e);
      }
    }

    async function saveGlobalRelationship() {
      const rawInput = document.getElementById('global-rel-userid').value.trim();
      const name = document.getElementById('global-rel-name').value.trim();
      const relationship = document.getElementById('global-rel-desc').value.trim();

      if (!rawInput || !name || !relationship) {
        customAlert('Atención', 'Todos los campos son obligatorios.');
        return;
      }

      const btn = document.querySelector('button[onclick="saveGlobalRelationship()"]');
      const originalText = btn.innerText;
      btn.innerText = 'Guardando...';
      btn.disabled = true;

      try {
        // Resolver ID o Username
        const resolveRes = await fetch(`/api/users/${encodeURIComponent(rawInput)}`);
        if (!resolveRes.ok) {
           customAlert('Atención', "No se encontró ningún usuario con ese ID o Nombre en los servidores donde Layla está activa.");
           return;
        }
        
        const userObj = await resolveRes.json();
        const userId = userObj.id; // ID real resuelto
        window.userCache[userId] = `@${userObj.username}`; // Actualizar cache local

        const res = await fetch('/api/global-relationships', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, name, relationship })
        });
        
        if (res.ok) {
          document.getElementById('global-rel-userid').value = '';
          document.getElementById('global-rel-name').value = '';
          document.getElementById('global-rel-desc').value = '';
          showToast('Relación global guardada');
          loadGlobalRelationships();
        } else {
          const err = await res.json();
          customAlert('Atención', 'Error: ' + err.error);
        }
      } catch (e) {
        console.error(e);
        customAlert('Atención', 'Error de conexión');
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    }

    window.saveLanguage = async function() {
      if (!currentEditingGuild) return;
      const newLanguage = document.getElementById('language-select').value;
      const btn = document.querySelector('button[onclick="saveLanguage()"]');
      const originalText = btn.innerText;

      btn.innerText = "Guardando...";
      btn.disabled = true;

      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/language`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: newLanguage })
        });
        
        if (res.ok) {
          showToast('Idioma de Voz Guardado');
        } else {
          const err = await res.json();
          customAlert('Atención', 'Error guardando idioma: ' + err.error);
        }
      } catch (e) {
        console.error(e);
        customAlert('Atención', 'Error de conexión');
      } finally {
        if (btn) {
            btn.innerText = originalText;
            btn.disabled = false;
        }
      }
    };

    async function deleteGlobalRelationship(userId) {
      const confirmed = await customConfirm('¿Eliminar Admin Global?', '¿Estás seguro de eliminar este administrador global?', 'Eliminar');
      if (!confirmed) return;
      try {
        const res = await fetch(`/api/global-relationships/${userId}`, { method: 'DELETE' });
        if (res.ok) {
          loadGlobalRelationships();
        } else {
          customAlert('Atención', 'Error eliminando administrador');
        }
      } catch (e) {
        console.error(e);
      }
    }

    window.deleteAllUserMemories = async function(userId) {
      if (!currentEditingGuild) return;
      const confirmed = await customConfirm('¿Eliminar TODAS las memorias?', '¿Estás seguro de eliminar TODAS las memorias de este usuario permanentemente?', 'Eliminar Todo');
      if (!confirmed) return;
      try {
        const res = await fetch(`/api/servers/${currentEditingGuild}/memories/user/${userId}`, { method: 'DELETE' });
        if (res.ok) {
          loadMemories(currentEditingGuild);
          showToast('Todas las memorias del usuario fueron eliminadas');
        } else {
          customAlert('Atención', 'Error eliminando las memorias del usuario');
        }
      } catch (e) {
        console.error(e);
        customAlert('Atención', 'Error de conexión');
      }
    };

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
        customAlert('Atención', "Error guardando ajuste");
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
        customAlert('Atención', "Debes añadir al menos una palabra detonante y un significado.");
        return;
      }
      
      if (selectedChannels.length === 0) {
        customAlert('Atención', "Debes seleccionar al menos un canal para evitar que el bot haga spam en todo el servidor.");
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
          customAlert('Atención', "Error al guardar en el servidor");
        }
      } catch (e) {
        customAlert('Atención', "Error de red guardando detonantes");
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
          customAlert('Atención', 'Error al guardar el prompt');
        }
      } catch (e) {
        customAlert('Atención', 'Error de conexión');
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