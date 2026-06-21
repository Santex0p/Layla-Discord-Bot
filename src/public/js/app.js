// --- NAVEGACION ---
    const navItems = document.querySelectorAll('.nav-item');
    function switchView(targetId) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(targetId).classList.add('active');
    }

    // --- LOGIC: TABS ---
    document.querySelectorAll('.nav-item[data-target]').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
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
          switchView('view-servers');
          loadServers();
          loadSettings();
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
      if(res.ok) { window.location.reload(); }
      else { const d = await res.json(); alert(d.error || 'Login failed'); btn.disabled = false; btn.innerText = 'Ingresar'; }
    }

    async function doRegister() {
      const btn = document.querySelector('#view-register button');
      btn.disabled = true;
      btn.innerText = 'Cargando...';
      const pass = document.getElementById('register-password').value;
      const res = await fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ password: pass }) });
      if(res.ok) { window.location.reload(); }
      else { const d = await res.json(); alert(d.error || 'Register failed'); btn.disabled = false; btn.innerText = 'Registrar Admin'; }
    }

    async function doLogout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.reload();
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
          card.onclick = () => openModal(guildId, info.serverName, info.prompt, info.language);

          card.innerHTML = `
            <div class="server-card-header">
              <div class="server-icon">${letter}</div>
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
          closeModal();
          loadServers(); // Recargar lista
          showToast("Layla abandonó el servidor exitosamente");
        } else {
          const data = await res.json();
          alert('Error: ' + data.error);
        }
      } catch (e) {
        alert('Error expulsando al bot');
      }
    }

    // --- MODAL Y GUARDADO ---
    function openModal(guildId, name, prompt, language) {
      currentEditingGuild = guildId;
      document.getElementById('modal-server-name').innerText = name;
      document.getElementById('modal-server-id').innerText = `ID: ${guildId}`;
      document.getElementById('prompt-textarea').value = prompt;
      
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
      
      document.getElementById('prompt-modal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('prompt-modal').classList.remove('active');
      currentEditingGuild = null;
    }

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
          closeModal();
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
      if (isAtBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
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