import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import guildPromptManager from '../models/GuildPromptManager.js';
import globalSettingsManager from '../models/GlobalSettingsManager.js';
import authManager from '../models/AuthManager.js';
import voskModelManager from '../models/VoskModelManager.js';
import memoryManager from '../models/MemoryManager.js';

// Puerto del dashboard
const PORT = 80;
const PUBLIC_DIR = path.join(process.cwd(), 'src', 'public');

// Event Emitter para los logs en vivo
class LogEmitter extends EventEmitter { }
const logEmitter = new LogEmitter();

let discordClient = null;
export function setDiscordClient(client) {
  discordClient = client;
}

// Buffer circular para los últimos 100 logs (para enviar al conectar)
const logHistory = [];
const MAX_HISTORY = 100;

function appendToHistory(logData) {
  logHistory.push(logData);
  if (logHistory.length > MAX_HISTORY) {
    logHistory.shift();
  }
}

// Sobrescribir la consola original
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function formatLog(level, args) {
  // Convertir los argumentos a texto (manejar objetos)
  const text = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  const timestamp = new Date().toISOString();

  const logData = {
    level,
    timestamp,
    text
  };

  appendToHistory(logData);
  logEmitter.emit('log', logData);
  return text;
}

console.log = function (...args) {
  formatLog('info', args);
  originalLog.apply(console, args);
};

console.info = function (...args) {
  formatLog('info', args);
  originalInfo.apply(console, args);
};

console.warn = function (...args) {
  formatLog('warn', args);
  originalWarn.apply(console, args);
};

console.error = function (...args) {
  formatLog('error', args);
  originalError.apply(console, args);
};

// Crear el servidor HTTP para el Dashboard Web
const server = http.createServer(async (req, res) => {
  const send404Gif = (res, statusCode = 404) => {
    const gifPath = path.join(PUBLIC_DIR, 'img', '404.gif');
    fs.readFile(gifPath, (err, data) => {
      if (err) {
        res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
        res.end(statusCode === 403 ? '403 Forbidden' : '404 Not found');
        return;
      }
      res.writeHead(statusCode, { 'Content-Type': 'image/gif' });
      res.end(data);
    });
  };

  function parseCookies(request) {
    const list = {};
    const rc = request.headers.cookie;
    if (rc) {
      rc.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
      });
    }
    return list;
  }

  // --- INTERCEPTOR DE AUDIO PARA DISCORD (Ruta raíz /*.mp3) ---
  const mp3RootMatch = req.url.match(/^\/([^/]+)\.mp3$/);
  if (mp3RootMatch && req.method === 'GET') {
    const filename = mp3RootMatch[1];
    const userAgent = req.headers['user-agent'] || '';

    if (userAgent.toLowerCase().includes('discordbot')) {
      const host = req.headers.host || process.env.MEDIA_DOMAIN || 'localhost';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      res.end(`<!doctype html>
      <html lang="es">
      <head>
          <meta charset="UTF-8">
          <meta property="og:site_name" content="Layla Audio">
          <meta property="og:title" content="Laya Habla - Reproduce el audio">
          <meta property="og:description" content="Reproduce el audio">
          
          <meta property="og:image" content="https://${host}/background.png">
          
          <meta property="og:type" content="video.other">
          <meta property="og:video" content="https://${host}/audios/${filename}.mp4">
          <meta property="og:video:secure_url" content="https://${host}/audios/${filename}.mp4">
          <meta property="og:video:type" content="video/mp4">
          <meta property="og:video:width" content="600">
          <meta property="og:video:height" content="600">
      </head>
      <body style="background:#222;"></body>
      </html>`);
      return;
    } else {
      // Reescritura interna: si es humano o navegador, buscar en /audios/
      req.url = `/audios/${filename}.mp3`;
    }
  }

  // --- IMAGEN DE FONDO PERSONALIZADA ---
  if (req.url === '/background.png' && req.method === 'GET') {
    const filePath = '/app/data/background.png';
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }

  // --- SERVIDOR DE CARPETA FISICA (/audios/) ---
  if (req.url.startsWith('/audios/') && req.method === 'GET') {
    const safePath = path.normalize(decodeURIComponent(req.url.replace('/audios', '')));
    const filePath = path.join('/app/data/audios', safePath);

    // Evitar Path Traversal
    if (!filePath.startsWith('/app/data/audios')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err) {
        res.writeHead(404);
        res.end('Audio file not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.mp3') contentType = 'audio/mpeg';
      else if (ext === '.mp4') contentType = 'video/mp4';
      else if (ext === '.png') contentType = 'image/png';

      // Cabeceras equivalentes a Nginx
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;

        const fileStream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': contentType,
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  // --- FILTRO DE DOMINIO PARA EL DASHBOARD ---
  const requestedHost = (req.headers.host || '').split(':')[0];
  if (process.env.DASHBOARD_DOMAIN && requestedHost !== process.env.DASHBOARD_DOMAIN) {
    return send404Gif(res, 403);
  }

  // --- RUTAS DE AUTENTICACIÓN ---
  if (req.url.startsWith('/api/auth/status') && req.method === 'POST') {
    try {
      const cookies = parseCookies(req);
      const hasAdmin = await authManager.hasAdmin();
      const isValidToken = await authManager.validateToken(cookies.LaylaAuth);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      });
      res.end(JSON.stringify({ hasAdmin, isAuth: isValidToken }));
    } catch (e) {
      console.error('[AUTH] Error en status:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
    return;
  }

  if (req.url === '/api/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 51200) req.destroy(); });
    req.on('end', async () => {
      try {
        const { password } = JSON.parse(body);
        if (!password || password.length < 4) throw new Error('Contraseña demasiado corta');
        await authManager.registerAdmin(password);

        const token = await authManager.loginAdmin(password);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `LaylaAuth=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`
        });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 51200) req.destroy(); });
    req.on('end', async () => {
      try {
        const { password } = JSON.parse(body);
        const token = await authManager.loginAdmin(password);
        if (token) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `LaylaAuth=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`
          });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Contraseña incorrecta' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    await authManager.logoutAdmin(cookies.LaylaAuth);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `LaylaAuth=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // --- MIDDLEWARE DE PROTECCIÓN ---
  const isApiOrStream = req.url.startsWith('/api/') || req.url === '/stream';
  if (isApiOrStream) {
    const cookies = parseCookies(req);
    const isValidToken = await authManager.validateToken(cookies.LaylaAuth);
    if (!isValidToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // --- SERVIDOR DE ARCHIVOS ESTÁTICOS ---
  if (!isApiOrStream && req.method === 'GET') {
    let reqPath = req.url === '/' ? '/index.html' : req.url;
    reqPath = reqPath.split('?')[0]; // Remover query strings

    // Evitar directory traversal
    const safePath = path.normalize(decodeURIComponent(reqPath));
    const filePath = path.resolve(PUBLIC_DIR, '.' + safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (reqPath === '/index.html') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Dashboard not found. Please create src/public/index.html');
        } else {
          res.writeHead(404);
          res.end('File not found');
        }
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'text/plain';
      if (ext === '.html') contentType = 'text/html';
      else if (ext === '.css') contentType = 'text/css';
      else if (ext === '.js') contentType = 'application/javascript';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.gif') contentType = 'image/gif';
      else if (ext === '.svg') contentType = 'image/svg+xml';
      else if (ext === '.webp') contentType = 'image/webp';
      else if (ext === '.ico') contentType = 'image/x-icon';
      else if (ext === '.json') contentType = 'application/json';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }

  // Ruta SSE: Stream de Logs
  if (req.url === '/stream') {
    // Configurar cabeceras obligatorias para SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*' // Permite conectar desde otras IPs si hace falta
    });

    // Enviar mensaje inicial
    res.write('data: {"level":"system", "timestamp":"' + new Date().toISOString() + '", "text":"[SSE] Conectado al stream de logs de Layla."}\n\n');

    // Enviar historial reciente
    for (const log of logHistory) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    // Escuchar nuevos logs y transmitirlos
    const onLog = (logData) => {
      // El formato de SSE exige "data: {JSON}\\n\\n"
      res.write(`data: ${JSON.stringify(logData)}\n\n`);
    };

    logEmitter.on('log', onLog);

    // Limpiar evento si el navegador se desconecta
    req.on('close', () => {
      logEmitter.removeListener('log', onLog);
    });

    return;
  }

  // API GET: Obtener prompt por defecto
  if (req.url === '/api/default-prompt' && req.method === 'GET') {
    import('../config/constants.js').then(({ CONFIG }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION }));
    });
    return;
  }

  // API GET: Obtener lista de servidores y sus prompts
  if (req.url === '/api/servers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const data = {};
    for (const [id, info] of guildPromptManager.prompts.entries()) {
      data[id] = info;
    }
    res.end(JSON.stringify(data));
    return;
  }

  // API GET: Obtener lista de canales de texto de un servidor
  if (req.url.match(/^\/api\/servers\/[^/]+\/channels(\?.*)?$/) && req.method === 'GET') {
    try {
      const guildId = req.url.split('/')[3];
      if (discordClient) {
        const guild = discordClient.guilds.cache.get(guildId);
        if (guild) {
          // Filtrar solo canales de texto (tipo 0 en discord.js v14)
          const channels = guild.channels.cache
            .filter(c => c.type === 0 || c.type === 5 || c.type === 15) // Text = 0, News = 5, Forum = 15
            .map(c => ({ id: c.id, name: c.name || 'sin-nombre' }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(channels));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found in cache' }));
        }
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Discord client not ready' }));
      }
    } catch (error) {
      console.error('[API] Error cargando canales:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API GET: Listar miembros de un servidor (para selectores de Relaciones y Memorias)
  if (req.url.match(/^\/api\/servers\/[^/]+\/members$/) && req.method === 'GET') {
    const guildId = req.url.split('/')[3];
    try {
      if (discordClient) {
        const guild = discordClient.guilds.cache.get(guildId);
        if (guild) {
          // Intentar cargar miembros si no están en caché
          await guild.members.fetch().catch(() => { });
          const members = guild.members.cache
            .filter(m => !m.user.bot)
            .map(m => ({
              id: m.user.id,
              username: m.user.username,
              displayName: m.displayName || m.user.username,
            }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(members));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
        }
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Discord client not ready' }));
      }
    } catch (error) {
      console.error('[API] Error cargando miembros:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ==================== API: RELACIONES GLOBALES ====================

  // API GET: Obtener lista de relaciones globales
  if (req.url === '/api/global-relationships' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(memoryManager.getAllGlobalRelationships()));
    return;
  }

  // API POST: Añadir/editar relación global
  if (req.url === '/api/global-relationships' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { userId, name, relationship } = payload;

        if (!userId || !name || !relationship) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing userId, name or relationship' }));
          return;
        }

        memoryManager.setGlobalRelationship(userId, name, relationship);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[API] Error guardando relación global:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // API DELETE: Eliminar relación global
  if (req.url.startsWith('/api/global-relationships/') && req.method === 'DELETE') {
    const userId = req.url.split('/')[3];
    try {
      const deleted = memoryManager.deleteGlobalRelationship(userId);
      if (deleted) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Relationship not found' }));
      }
    } catch (error) {
      console.error('[API] Error eliminando relación global:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API POST: Actualizar el prompt de un servidor
  if (req.url.match(/^\/api\/servers\/[^/]+$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 524288) { req.destroy(); return; } // 512KB max
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.prompt) {
          const success = guildPromptManager.setPrompt(guildId, parsed.prompt);
          if (success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server not found' }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing prompt' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API POST: Expulsar al bot de un servidor
  if (req.url.startsWith('/api/servers/') && req.url.endsWith('/leave') && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    if (discordClient) {
      const guild = discordClient.guilds.cache.get(guildId);
      if (guild) {
        guild.leave()
          .then(() => {
            console.log(`[DASHBOARD] Layla abandonó el servidor ${guildId}`);
            guildPromptManager.prompts.delete(guildId); // Borrar config
            guildPromptManager._savePrompts();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          })
          .catch(e => {
            console.error(`[DASHBOARD] Error al abandonar servidor ${guildId}:`, e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No se pudo abandonar el servidor' }));
          });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'El bot no se encuentra en ese servidor' }));
      }
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cliente de Discord no disponible' }));
    }
    return;
  }

  // API GET: Obtener ajustes globales
  if (req.url === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(globalSettingsManager.getAll()));
    return;
  }

  // API GET: Obtener un usuario por ID o username
  if (req.url.match(/^\/api\/users\/[^/]+$/) && req.method === 'GET') {
    const query = decodeURIComponent(req.url.split('/')[3]).toLowerCase().replace('@', '');
    try {
      if (discordClient) {
        let user = null;
        if (/^\d{17,20}$/.test(query)) {
          user = await discordClient.users.fetch(query).catch(() => null);
        } else {
          for (const guild of discordClient.guilds.cache.values()) {
            const member = guild.members.cache.find(m => m.user.username.toLowerCase() === query);
            if (member) {
              user = member.user;
              break;
            }
          }
        }

        if (user) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: user.id,
            username: user.username,
            displayName: user.displayName || user.username,
            avatarURL: user.displayAvatarURL({ dynamic: true, size: 128 })
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User not found' }));
        }
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Discord client not ready' }));
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // API POST: Actualizar un ajuste global
  if (req.url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 524288) { req.destroy(); return; } // 512KB max
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        for (const [key, value] of Object.entries(parsed)) {
          globalSettingsManager.set(key, value);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API GET: Catálogo de idiomas Vosk
  if (req.url === '/api/vosk/catalog' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(voskModelManager.getCatalog()));
    return;
  }

  // API POST: Actualizar idioma de un servidor
  if (req.url.match(/^\/api\/servers\/[^/]+\/language$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 4096) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.language || !voskModelManager.isValidLang(parsed.language)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Idioma no válido o no soportado' }));
          return;
        }
        const success = guildPromptManager.setLanguage(guildId, parsed.language);
        if (success) {
          // Pre-descargar el modelo en segundo plano si no existe
          voskModelManager.getModel(parsed.language).catch(() => { });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API POST: Actualizar configuración de Respuesta Directa a Layla
  if (req.url.match(/^\/api\/servers\/[^/]+\/reply-setting$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 4096) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.replyToLayla !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'replyToLayla debe ser un booleano' }));
          return;
        }
        const success = guildPromptManager.setReplySetting(guildId, parsed.replyToLayla);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // API POST: Actualizar configuración de Detonantes (Triggers)
  if (req.url.match(/^\/api\/servers\/[^/]+\/triggers$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 512000) { req.destroy(); return; } // 500KB Max
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.triggers)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'triggers debe ser un array' }));
          return;
        }

        // Validación básica
        const validTriggers = parsed.triggers.filter(t => t.word && typeof t.word === 'string' && t.meaning && typeof t.meaning === 'string');

        const success = guildPromptManager.setTriggers(guildId, validTriggers);
        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ==================== API: RELACIONES ====================

  // GET: Obtener todas las relaciones de un servidor
  if (req.url.match(/^\/api\/servers\/[^/]+\/relationships$/) && req.method === 'GET') {
    const guildId = req.url.split('/')[3];
    const relationships = memoryManager.getAllRelationships(guildId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(relationships));
    return;
  }

  // POST: Crear/actualizar una relación
  if (req.url.match(/^\/api\/servers\/[^/]+\/relationships$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { userId, name, relationship } = JSON.parse(body);
        if (!userId || !name || !relationship) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId, name y relationship son obligatorios' }));
          return;
        }
        memoryManager.setRelationship(guildId, userId, name, relationship);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // DELETE: Eliminar una relación
  if (req.url.match(/^\/api\/servers\/[^/]+\/relationships\/[^/]+$/) && req.method === 'DELETE') {
    const parts = req.url.split('/');
    const guildId = parts[3];
    const userId = parts[5];
    const success = memoryManager.deleteRelationship(guildId, userId);
    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }

  // ==================== API: MEMORIAS ====================

  // GET: Obtener todas las memorias de un servidor
  if (req.url.match(/^\/api\/servers\/[^/]+\/memories$/) && req.method === 'GET') {
    const guildId = req.url.split('/')[3];
    const memories = memoryManager.getAllMemories(guildId);
    // Enviar sin embeddings para no saturar el payload
    const cleaned = {};
    for (const [uid, mems] of Object.entries(memories)) {
      cleaned[uid] = mems.map(m => ({ id: m.id, text: m.text, createdAt: m.createdAt }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cleaned));
    return;
  }

  // POST: Añadir una memoria manualmente
  if (req.url.match(/^\/api\/servers\/[^/]+\/memories$/) && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      try {
        const { userId, text } = JSON.parse(body);
        if (!userId || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId y text son obligatorios' }));
          return;
        }
        const saved = await memoryManager.addMemory(guildId, userId, text);
        res.writeHead(saved ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: saved, duplicate: !saved }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Error procesando memoria' }));
      }
    });
    return;
  }

  // DELETE: Eliminar todas las memorias de un usuario
  if (req.url.match(/^\/api\/servers\/[^/]+\/memories\/user\/[^/]+$/) && req.method === 'DELETE') {
    const parts = req.url.split('/');
    const guildId = parts[3];
    const userId = parts[6];
    const success = memoryManager.deleteAllUserMemories(guildId, userId);
    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }

  // DELETE: Eliminar una memoria
  if (req.url.match(/^\/api\/servers\/[^/]+\/memories\/[^/]+\/[^/]+$/) && req.method === 'DELETE') {
    const parts = req.url.split('/');
    const guildId = parts[3];
    const userId = parts[5];
    const memoryId = parts[6];
    const success = memoryManager.deleteMemory(guildId, userId, memoryId);
    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }

  // Cualquier otra ruta
  send404Gif(res, 404);
});

// Arrancar el servidor web silenciosamente
server.listen(PORT, '0.0.0.0', () => {
  originalLog(`🌐 [WEB] Dashboard de Logs corriendo en http://localhost:${PORT}`);
});

export default logEmitter;
