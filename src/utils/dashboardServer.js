import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import guildPromptManager from '../models/GuildPromptManager.js';
import globalSettingsManager from '../models/GlobalSettingsManager.js';
import stateManager from '../models/ChannelStateManager.js';

// Configuración
const PORT = 8080;
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
const server = http.createServer((req, res) => {
  // Ruta principal: Servir el HTML
  if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Dashboard not found. Please create src/public/index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Servir imágenes estáticas
  if (req.url.startsWith('/img/') && req.method === 'GET') {
    // Evitar directory traversal
    const safePath = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
    const imgPath = path.join(PUBLIC_DIR, safePath);
    
    fs.readFile(imgPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Image not found');
        return;
      }
      
      const ext = path.extname(imgPath).toLowerCase();
      let contentType = 'image/jpeg';
      if (ext === '.png') contentType = 'image/png';
      if (ext === '.gif') contentType = 'image/gif';
      if (ext === '.svg') contentType = 'image/svg+xml';
      if (ext === '.webp') contentType = 'image/webp';
      
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

  // API POST: Actualizar el prompt de un servidor
  if (req.url.startsWith('/api/servers/') && req.method === 'POST') {
    const guildId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
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

  // API POST: Actualizar un ajuste global
  if (req.url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
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

  // Cualquier otra ruta
  res.writeHead(404);
  res.end('Not found');
});

// Arrancar el servidor web silenciosamente
server.listen(PORT, '0.0.0.0', () => {
  originalLog(`🌐 [WEB] Dashboard de Logs corriendo en http://localhost:${PORT}`);
});

export default logEmitter;
