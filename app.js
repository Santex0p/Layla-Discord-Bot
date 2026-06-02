import 'dotenv/config';
import { spawn } from 'node:child_process';
import { Client, GatewayIntentBits } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import ffmpegPath from 'ffmpeg-static';
import { getRandomEmoji } from './utils.js';

// Flujo actual con Live API:
// 1) El bot abre una sesion Live persistente por WebSocket.
// 2) Cada mensaje de Discord se manda como un turno textual dentro de esa sesion.
// 3) Gemini responde con audio nativo y con transcripcion opcional del mismo turno.
// 4) El audio PCM recibido se convierte a MP3 y se adjunta en Discord.
//
// Esto reduce el costo frente al flujo previo de dos llamadas (chat + TTS), porque la
// misma sesion conserva contexto y evita rehacer todo el trabajo en cada mensaje.
// Modelos y configuración principal
// - LIVE_MODEL: modelo para sesiones Live (audio+texto en streaming si está disponible).
// - TEXT_MODEL: modelo de texto para generateContent en el fallback.
// - TTS_MODEL: modelo de texto-a-voz (preview) usado en el fallback.
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TEXT_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
// Instrucción del sistema enviada en fallback para guiar el estilo/tono
const LIVE_SYSTEM_INSTRUCTION = 'Eres Layla, una chica simpatica y divertida. Responde a los mensajes de los usuarios con voz linda, con emociones y natural. Mantén un tono amistoso, casual, travieso y coqueto. Si el usuario te hace una pregunta o comentario, responde de manera relevante y entretenida. Si no entiendes algo, haz una broma al respecto en lugar de admitir que no sabes. Siempre busca mantener la conversación ligera y divertida. Mensajes breves, cortos pero con mucha personalidad.';
const TTS_VOICE = 'Zephyr';
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
// Límites de rotación de sesión Live.
// La sesión Live de Gemini acumula contexto en el servidor a lo largo de la conversación:
// no importa cuántos mensajes guardemos localmente, el servidor sigue creciendo.
// Cuando cualquiera de los dos umbrales se alcanza, cerramos la sesión y abrimos
// una nueva que arranca solo con el resumen de los últimos HISTORY_SIZE mensajes locales.
//
// - LAYLA_LIVE_MAX_TOKENS: tokens acumulados (suma de todos los turnos de la sesión).
//   8000 es conservador y seguro para el free tier de Gemini.
//   Súbelo con la variable de entorno LAYLA_LIVE_MAX_TOKENS si tienes cuota mayor.
// - LAYLA_LIVE_MAX_TURNS: respaldo si usageMetadata no llega (Live a veces no reporta
//   tokens intermedios). Rotamos a los N turnos sin importar los tokens contados.
const LIVE_SESSION_MAX_TOKENS = Number(process.env.LAYLA_LIVE_MAX_TOKENS) || 8000;
const LIVE_SESSION_MAX_TURNS  = Number(process.env.LAYLA_LIVE_MAX_TURNS)  || 15;

// Tiempo máximo de inactividad antes de cerrar la sesión Live automáticamente.
// Si no llega ningún mensaje en este período, cerramos el WebSocket para evitar
// que el servidor siga acumulando tokens sin que nadie esté hablando.
// Default: 5 minutos. Configurable con LAYLA_IDLE_TIMEOUT_MS.
const LIVE_IDLE_TIMEOUT_MS = Number(process.env.LAYLA_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
const HISTORY_IDLE_TIMEOUT_MS = Number(process.env.LAYLA_HISTORY_IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
const LIVE_QUOTA_BACKOFF_MS = Number(process.env.LAYLA_LIVE_QUOTA_BACKOFF_MS) || 30 * 1000;

// Historial local por canal: usado para dar contexto en el fallback (generateContent)
// `HISTORY_SIZE` controla cuántos mensajes se guardan (por defecto 8)
const HISTORY_SIZE = Number(process.env.LAYLA_HISTORY_SIZE) || 8;
const conversationHistories = new Map(); // key: channelId -> [{role, text}, ...]
const perUserHistories = new Map(); // key: `${channelId}:${userId}` -> [{role, text}, ...]

// Estado Live por canal. Cada canal conserva su propia sesion, cola y contadores.
const liveChannelStates = new Map();
let liveDisabledReason = null; // texto explicando por qué Live fue deshabilitado globalmente
const activeChannelIds = new Set();

// Devuelve el estado Live asociado a un canal.
// Si es la primera vez que el canal habla con Layla, inicializa su estado base:
// - sesion WebSocket Live
// - promesa de conexion en curso
// - turno pendiente actual
// - cola serializada de turnos
// - contadores de tokens/turnos
// - timer de inactividad de sesion
// - timer de inactividad de historial
// Esto nos permite mantener contexto y control totalmente aislados por channelId.
function getLiveChannelState(channelId) {
  let state = liveChannelStates.get(channelId); // intenta obtener el estado existente para el canal

  if (!state) { // si no existe, inicializa un nuevo estado base para ese canal
    state = {
      session: null,
      handle: null,
      connectPromise: null,
      pendingTurn: null,
      turnQueue: Promise.resolve(),
      responseQueue: Promise.resolve(),
      sessionTokenCount: 0,
      sessionTurnCount: 0,
      idleTimer: null,
      historyIdleTimer: null,
      quotaBackoffUntil: 0,
      quotaRetryTimer: null,
    };
    liveChannelStates.set(channelId, state); // guarda el estado inicializado para el canal
  }

  return state; 
}

// Convierte el audio PCM crudo que devuelve Gemini/TTS a un MP3 listo para adjuntar.
// Este método encapsula el uso de ffmpeg para que el resto del bot siempre trabaje
// con `Buffer` en memoria y no tenga que escribir archivos temporales.
//
// Parámetros:
// - pcmBuffer: Buffer con audio lineal s16le.
// - sampleRate: frecuencia de muestreo del PCM; por defecto la del modelo TTS.
// - channels: cantidad de canales del PCM; por defecto mono.
//
// Retorno:
// - Promise<Buffer> con el MP3 resultante.
async function pcm16ToMp3Buffer(pcmBuffer, sampleRate = TTS_SAMPLE_RATE, channels = TTS_CHANNELS) {
  if (!ffmpegPath) { 
    throw new Error('ffmpeg-static no devolvio una ruta ejecutable.');
  }

  return new Promise((resolve, reject) => { // Spawn de ffmpeg con argumentos para convertir PCM s16le a MP3 usando libmp3lame.
    const ffmpeg = spawn(ffmpegPath, [
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-i', 'pipe:0',
      '-f', 'mp3',
      '-codec:a', 'libmp3lame',
      '-b:a', '128k',
      'pipe:1',
    ]);

    const outputChunks = [];
    const errorChunks = [];

    ffmpeg.stdout.on('data', (chunk) => { // Cada vez que ffmpeg emite un chunk de audio MP3, lo guardamos en el arreglo outputChunks.
      outputChunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (chunk) => { // Si ffmpeg emite algo por stderr, lo guardamos en errorChunks para poder reportar el error completo si la conversión falla.
      errorChunks.push(chunk);
    });

    ffmpeg.on('error', (error) => { // Si ocurre un error al ejecutar ffmpeg (por ejemplo, si no se encuentra el ejecutable), rechazamos la promesa con ese error.
      reject(error);
    });

    ffmpeg.on('close', (code) => { // Cuando ffmpeg termina, verificamos el código de salida. Si es 0, la conversión fue exitosa y concatenamos los chunks de output para resolver la promesa con el Buffer resultante. Si no, concatenamos los chunks de error para crear un mensaje de error detallado y rechazamos la promesa.
      if (code === 0) {
        return resolve(Buffer.concat(outputChunks));
      }
      // Error
      const ffmpegError = Buffer.concat(errorChunks).toString('utf8').trim(); 
      reject(new Error(`ffmpeg fallo al codificar MP3 (exit ${code}): ${ffmpegError}`));
    });

    ffmpeg.stdin.on('error', (error) => { // Si ocurre un error al escribir en stdin de ffmpeg, rechazamos la promesa con ese error.
      reject(error); 
    });
    // Escribimos el buffer PCM completo en stdin de ffmpeg y luego cerramos la entrada para indicar que no hay más datos.
    ffmpeg.stdin.end(pcmBuffer);
  });
}

// Verifica si el MIME reportado por Gemini corresponde a audio PCM sin comprimir.
// Se usa para saber si el audio recibido debería poder pasar por ffmpeg como s16le.
function isPcmMimeType(mimeType) {
  if (!mimeType) {
    return false;
  }

  const normalizedMime = mimeType.toLowerCase(); // Algunos modelos pueden devolver variantes como "audio/l16; rate=24000; channels=1", así que verificamos solo el inicio del MIME.
  return normalizedMime.startsWith('audio/pcm') || normalizedMime.startsWith('audio/l16'); // También aceptamos "audio/raw" como fallback genérico para audio sin comprimir, aunque es menos específico.
}

// Recorre un arreglo de `parts` del SDK y concatena todos los fragmentos de texto útiles.
// Gemini puede dividir una respuesta en varias partes; esta función las normaliza en un string.
function extractTextFromParts(parts = []) {
  return parts
    .map((part) => part?.text?.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

// Normaliza el bloque inline de audio del SDK a `Buffer`.
// El SDK no siempre entrega el mismo tipo (`Buffer`, `Uint8Array` o base64),
// así que este helper unifica el dato binario antes de pasarlo a ffmpeg.
function extractInlineAudioData(part) {
  if (!part?.inlineData?.data) {
    return null;
  }

  if (Buffer.isBuffer(part.inlineData.data)) {
    return part.inlineData.data;
  }

  if (part.inlineData.data instanceof Uint8Array) {
    return Buffer.from(part.inlineData.data);
  }

  if (typeof part.inlineData.data === 'string') {
    return Buffer.from(part.inlineData.data, 'base64');
  }

  return null;
}

// Extrae el texto principal de una respuesta `generateContent`.
// Primero intenta usar `response.text` si el SDK ya lo resolvió.
// Si no existe, recorre los candidatos manualmente hasta encontrar partes de texto.
function extractResponseText(response) {
  if (typeof response?.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  const candidates = response?.candidates || [];

  for (const candidate of candidates) {
    const text = extractTextFromParts(candidate?.content?.parts || []);
    if (text) {
      return text;
    }
  }

  return '';
}

// Localiza la primera parte de audio inline en una respuesta `generateContent`.
// Se usa principalmente en el fallback TTS, donde esperamos recibir audio sintetizado.
// Si no encuentra audio, devuelve `null` para que el llamador decida cómo recuperarse.
function extractAudioPartFromResponse(response) {
  const candidates = response?.candidates || [];

  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (!part?.inlineData?.mimeType?.startsWith('audio/')) {
        continue;
      }

      const audioBuffer = extractInlineAudioData(part);

      if (audioBuffer) {
        return {
          audioBuffer,
          mimeType: part.inlineData.mimeType,
        };
      }
    }
  }

  return null;
}

// Detecta errores que indican una incompatibilidad permanente o semipermanente con Live API.
// Ejemplos típicos: cierres 1008, features no habilitadas o cuentas/modelos sin soporte.
// Cuando esto devuelve `true`, el flujo suele caer al fallback texto+TTS.
function shouldDisableLive(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('1008')
    || message.includes('operation is not implemented')
    || message.includes('supported, or enabled')
    || message.includes('sesion live api se cerro');
}

// Detecta si un error representa agotamiento de cuota o rate limiting.
// Incluye tanto la forma estructurada (`error.status === 429`) como mensajes de texto
// que el SDK o la API pueden adjuntar cuando el detalle llega serializado.
// Estos errores se consideran transitorios: el bot puede responder con texto y reintentar luego.
function isQuotaError(error) {
  // El SDK de Gemini expone el código HTTP como propiedad numérica en error.status
  if (error?.status === 429) return true;
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('429')
    || msg.includes('quota')
    || msg.includes('cuota')
    || msg.includes('rate limit')
    || msg.includes('resource_exhausted')
    || msg.includes('resource exhausted')
    || msg.includes('too many requests');
}

// Detecta cortes transitorios en medio de un turno Live.
// Este caso aparece cuando el servidor interrumpe el stream actual, pero el bot puede
// recuperarse respondiendo en texto y/o reabriendo la sesión.
function isInterruptedTurnError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('interrumpio el turno');
}

// Detecta el caso donde Live responde, pero nunca entrega audio usable para el turno.
// Es útil para distinguir un turno incompleto de una caída más grave de la sesión.
function isMissingAudioError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('no devolvio audio en el turno');
}

function isLiveQuotaBackoffActive(channelId) {
  const state = getLiveChannelState(channelId);
  return state.quotaBackoffUntil > Date.now();
}

function clearLiveQuotaRetryTimer(channelId) {
  const state = getLiveChannelState(channelId);

  if (state.quotaRetryTimer) {
    clearTimeout(state.quotaRetryTimer);
    state.quotaRetryTimer = null;
  }
}

function scheduleLiveReconnectAfterBackoff(channelId) {
  const state = getLiveChannelState(channelId);
  clearLiveQuotaRetryTimer(channelId);

  const waitMs = Math.max(0, state.quotaBackoffUntil - Date.now());
  if (!waitMs) {
    return;
  }

  state.quotaRetryTimer = setTimeout(() => {
    state.quotaRetryTimer = null;

    if (!activeChannelIds.has(channelId)) {
      return;
    }

    if (isLiveQuotaBackoffActive(channelId)) {
      scheduleLiveReconnectAfterBackoff(channelId);
      return;
    }

    resetLiveSession(channelId, { clearHandle: true });
    ensureLiveSession(channelId).then(() => {
      console.log(`✅ [LIVE] Reconectada automaticamente la sesion del canal ${channelId} tras cuota.`);
    }).catch((error) => {
      if (isQuotaError(error)) {
        armLiveQuotaBackoff(channelId, error);
        return;
      }

      console.warn(`⚠️ [LIVE] Fallo la reconexion automatica del canal ${channelId}: ${error.message}`);
    });
  }, waitMs);
}

function armLiveQuotaBackoff(channelId, error) {
  const state = getLiveChannelState(channelId);
  const nextUntil = Date.now() + LIVE_QUOTA_BACKOFF_MS;
  state.quotaBackoffUntil = Math.max(state.quotaBackoffUntil || 0, nextUntil);
  const seconds = Math.ceil((state.quotaBackoffUntil - Date.now()) / 1000);
  console.warn(`🚫 [LIVE] Backoff por cuota en canal ${channelId} durante ${seconds}s: ${error?.message || error}`);
  scheduleLiveReconnectAfterBackoff(channelId);
}

function clearLiveQuotaBackoff(channelId) {
  const state = getLiveChannelState(channelId);
  state.quotaBackoffUntil = 0;
  clearLiveQuotaRetryTimer(channelId);
}

// Genera una respuesta de texto usando el modelo normal (no Live).
// Se usa en el fallback cuando Live falla, se queda sin audio o no conviene intentar TTS.
//
// Contexto utilizado:
// - historial por canal
// - historial específico del usuario dentro de ese canal
//
// Retorno:
// - `transcript`: texto final de Layla
// - `usageMetadata`: telemetría de tokens/costo reportada por Gemini
async function generateTextReply(text, channelId, userId) {
  const historyContents = buildHistoryContents(channelId, userId);
  const contents = historyContents.length ? [...historyContents, text] : text;

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents,
    config: {
      systemInstruction: LIVE_SYSTEM_INSTRUCTION,
    },
  });

  const transcript = extractResponseText(response);

  if (!transcript) {
    throw new Error('Gemini no devolvio texto en el modo fallback.');
  }

  return {
    transcript,
    usageMetadata: response?.usageMetadata || null,
  };
}

// Guarda una entrada en el historial local.
// Mantiene dos vistas del mismo contexto:
// - historial completo del canal
// - historial específico del usuario dentro de ese canal
//
// Guarda metadatos del autor por separado para que el prompt pueda reconstruir
// el contexto sin mezclar identidades entre usuarios del mismo canal.
function appendToHistory(channelId, role, text, userId, authorName) {
  if (!channelId || !text) return;
  const raw = String(text).trim();
  const entry = {
    role,
    text: raw,
    channelId,
    userId: role === 'user' && userId ? userId : null,
    authorName: role === 'user' ? (authorName || 'Usuario') : 'Layla',
  };

  // Channel-wide history
  const prev = conversationHistories.get(channelId) || [];
  prev.push(entry);
  if (prev.length > HISTORY_SIZE) {
    conversationHistories.set(channelId, prev.slice(-HISTORY_SIZE));
  } else {
    conversationHistories.set(channelId, prev);
  }

  // Per-user history (optional)
  if (userId) {
    const key = `${channelId}:${userId}`;
    const prevUser = perUserHistories.get(key) || [];
    prevUser.push(entry);
    if (prevUser.length > HISTORY_SIZE) {
      perUserHistories.set(key, prevUser.slice(-HISTORY_SIZE));
    } else {
      perUserHistories.set(key, prevUser);
    }
  }
}

// Resuelve menciones de Discord dentro de `message.content` a nombres humanos legibles.
// Ejemplos:
// - `<@123>` -> `LaylaFan`
// - `<@&456>` -> `Moderadores`
// - `<#789>` -> `#general`
//
// Esto evita que Gemini vea IDs crudos y mejora mucho la comprensión del mensaje.
function resolveMentionsInContent(message) {
  if (!message || typeof message.content !== 'string') return '';
  let content = message.content;

  try {
    // Usuarios
    const users = message.mentions?.users || new Map();
    users.forEach((user) => {
      const member = message.guild?.members?.cache?.get(user.id) || null;
      const name = (member && member.displayName) || user.username || 'usuario';
      // Match both <@123> and <@!123>
      const userRegex = new RegExp(`<@!?${user.id}>`, 'g');
      content = content.replace(userRegex, `${name}`);
    });

    // Roles
    const roles = message.mentions?.roles || new Map();
    roles.forEach((role) => {
      const roleRegex = new RegExp(`<@&${role.id}>`, 'g');
      content = content.replace(roleRegex, `${role.name}`);
    });

    // Canales
    const channels = message.mentions?.channels || new Map();
    channels.forEach((ch) => {
      const chRegex = new RegExp(`<#${ch.id}>`, 'g');
      content = content.replace(chRegex, `#${ch.name}`);
    });
  } catch (e) {
    return message.content;
  }

  return content;
}


function formatHistoryEntry(entry) {// Si el mensaje no tiene texto, no lo incluimos en el historial para no inflar el prompt con entradas vacías.
  if (!entry?.text) return '';

  // Para los mensajes de usuario, incluimos el nombre del autor (si está disponible)
  if (entry.role === 'user') {
    const authorLabel = entry.authorName || entry.userId || 'Usuario';
    return `Usuario [${authorLabel}]: ${entry.text}`;
  }

  return `Layla: ${entry.text}`;
}

function buildIdentityInstruction() {
  return [
    'Reglas de identidad y memoria:',
    '- Cada nombre en el historial corresponde a una persona distinta.',
    '- No atribuyas recuerdos, instrucciones o datos de un usuario a otro por compartir canal.',
    '- Si ves `Usuario [Nombre]: ...`, ese contenido pertenece solo a ese autor salvo que el mensaje diga explicitamente que aplica a otros.',
    '- Si no estas segura de quien dijo algo o a quien pertenece una preferencia, preguntalo antes de asumirlo.',
    '- Responde al turno actual tomando en cuenta el nombre del autor del mensaje actual.',
  ].join('\n');
}

// Construye el contexto textual que se enviará a Gemini.
// Mezcla primero el historial del usuario en ese canal y luego el historial general del canal,
// eliminando duplicados exactos para no inflar innecesariamente el prompt.
//
// Formato resultante:
// - `Usuario [Nombre]: ...`
// - `Layla: ...`
function buildHistoryContents(channelId, userId) {
  const channelHist = conversationHistories.get(channelId) || [];
  const userHist = userId ? (perUserHistories.get(`${channelId}:${userId}`) || []) : [];
  const recentUserHist = userHist.slice(-4);
  const recentChannelHist = channelHist.slice(-2);

  const merged = [];
  const seen = new Set();

  for (const m of [...recentUserHist, ...recentChannelHist]) {
    const key = `${m.role}::${m.userId || ''}::${m.authorName || ''}::${m.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = formatHistoryEntry(m);
    if (line) merged.push(line);
  }

  return merged;
}

// Resume el historial reciente del canal para usarlo como memoria base de una sesión Live nueva.
// Importante: como cada canal tiene su propia sesión Live, aquí usamos solo `channelId`.
// Eso permite que la sesión recuerde lo que pasó en ese canal sin contaminarse con otros.
function buildLiveSessionSummary(channelId) {
  // La sesion Live se comparte entre usuarios del mismo canal.
  // Por eso el resumen base debe salir del historial del canal completo,
  // no del historial individual del primer usuario que abrió la sesion.
  const historyContents = buildHistoryContents(channelId);

  if (!historyContents.length) {
    return '';
  }

  return [
    'Contexto reciente de la conversacion para continuar sin perder memoria:',
    ...historyContents,
    'Usa este resumen como memoria base. No lo repitas ni lo expliques salvo que te lo pidan.',
  ].join('\n');
}

// Compone la system instruction final que se envía al abrir una nueva sesión Live.
// Toma la personalidad fija de Layla y, si existe, le agrega el resumen del canal.
// El modelo recibe ambas cosas como contexto inicial de la conversación.
function buildLiveSystemInstruction(channelId) {
  const identityInstruction = buildIdentityInstruction();
  const historySummary = buildLiveSessionSummary(channelId);

  if (!historySummary) {
    return `${LIVE_SYSTEM_INSTRUCTION}\n\n${identityInstruction}`;
  }

  return `${LIVE_SYSTEM_INSTRUCTION}\n\n${identityInstruction}\n\n${historySummary}`;
}

// Prepara el texto del turno para Live incluyendo la identidad del hablante.
// En una sesión compartida por canal, esto ayuda a que Gemini sepa quién habló
// sin tener que reabrir la sesión por cada usuario.
function buildUserTurnText(authorName, text) {
  const cleanText = String(text || '').trim();

  if (!cleanText) {
    return '';
  }

  return authorName ? `Usuario actual [${authorName}]: ${cleanText}` : cleanText;
}

// Solicita a Gemini un clip de audio TTS para un texto dado.
// Si por alguna razón la API no entrega audio en el primer intento, reintenta una vez.
// Si ambos intentos fallan, propaga un error para que el flujo de recuperación decida qué hacer.
async function generateTtsAudio(text, attempt = 1) {
  const response = await ai.models.generateContent({
    // Genera audio TTS usando `models.generateContent` con `responseModalities: ['AUDIO']`.
    // Reintenta una vez si la respuesta no contiene audio.
    model: TTS_MODEL,
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: TTS_VOICE,
          },
        },
      },
    },
  });

  const audioPart = extractAudioPartFromResponse(response);

  if (audioPart) {
    return {
      ...audioPart,
      usageMetadata: response?.usageMetadata || null,
    };
  }

  if (attempt < 2) {
    return generateTtsAudio(text, attempt + 1);
  }

  throw new Error('Gemini TTS no devolvio audio en el modo fallback.');
}

// Ejecuta el fallback completo con preferencia por audio.
// Primero genera el contenido textual de Layla y luego intenta sintetizarlo a audio.
// Si TTS no esta disponible en ese momento, devuelve el texto para responder sin romper el flujo.
async function generateVoiceReplyFallback(text, channelId, userId) {
  const textResult = await generateTextReply(text, channelId, userId);

  try {
    const audioResult = await generateTtsAudio(textResult.transcript);

    return {
      audioBuffer: audioResult.audioBuffer,
      mimeType: audioResult.mimeType,
      transcript: textResult.transcript,
      usageMetadata: {
        text: textResult.usageMetadata,
        audio: audioResult.usageMetadata,
      },
    };
  } catch (audioError) {
    if (!isQuotaError(audioError) && !isMissingAudioError(audioError)) {
      console.warn(`⚠️ [FALLBACK] TTS no disponible, se respondera solo con texto: ${audioError.message}`);
    }

    return {
      audioBuffer: null,
      mimeType: null,
      transcript: textResult.transcript,
      usageMetadata: {
        text: textResult.usageMetadata,
        audio: null,
      },
    };
  }
}

// Cancela el timer de inactividad de un canal.
// Se llama al cerrar una sesión o al reiniciar el contador para evitar timers duplicados.
function clearLiveIdleTimer(channelId) {
  const state = getLiveChannelState(channelId);

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function clearHistoryIdleTimer(channelId) {
  const state = getLiveChannelState(channelId);

  if (state.historyIdleTimer) {
    clearTimeout(state.historyIdleTimer);
    state.historyIdleTimer = null;
  }
}

function clearChannelHistory(channelId) {
  conversationHistories.delete(channelId);

  for (const key of perUserHistories.keys()) {
    if (key.startsWith(`${channelId}:`)) {
      perUserHistories.delete(key);
    }
  }
}

function resetHistoryIdleTimer(channelId) {
  const state = getLiveChannelState(channelId);
  clearHistoryIdleTimer(channelId);

  state.historyIdleTimer = setTimeout(() => {
    state.historyIdleTimer = null;
    const minutes = Math.round(HISTORY_IDLE_TIMEOUT_MS / 60000);
    clearChannelHistory(channelId);
    console.warn(`🧠 [HISTORY] Historial borrado por inactividad en canal ${channelId} (${minutes} min sin mensajes).`);
  }, HISTORY_IDLE_TIMEOUT_MS);
}

// Reinicia el contador de inactividad de una sesión Live por canal.
// Debe llamarse después de cada turno exitoso mientras la sesión siga viva.
// Si se alcanza el timeout, la sesión se cierra pero el historial local permanece.
function resetLiveIdleTimer(channelId) {
  const state = getLiveChannelState(channelId);
  clearLiveIdleTimer(channelId);

  if (!state.session) return; // solo aplica cuando hay sesion abierta

  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    if (!state.session) return;
    const minutes = Math.round(LIVE_IDLE_TIMEOUT_MS / 60000);
    console.warn(`⏳ [LIVE] Sesion cerrada por inactividad en canal ${channelId} (${minutes} min sin mensajes). El historial local se conserva.`);
    resetLiveSession(channelId, { clearHandle: true });
  }, LIVE_IDLE_TIMEOUT_MS);
}

// Cierra y limpia la sesión Live de un canal.
// No intenta reconectar por sí sola; simplemente deja el estado listo para que el
// siguiente `ensureLiveSession(channelId)` abra una sesión nueva y limpia.
//
// Efectos:
// - cierra el socket actual si existe
// - resetea promesa de conexión, contadores y timer
// - opcionalmente borra el handle de reanudación (`clearHandle`)
function resetLiveSession(channelId, options = {}) {
  const state = getLiveChannelState(channelId);
  const { clearHandle = false } = options;

  if (state.session) {
    try {
      state.session.close();
    } catch {
      // Si el socket ya se cerro, no hace falta hacer nada adicional.
    }
  }

  state.session = null;
  state.connectPromise = null;
  // Reiniciamos ambos contadores al cerrar la sesión para que la próxima empiece desde cero.
  state.sessionTokenCount = 0;
  state.sessionTurnCount = 0;

  if (clearHandle) {
    state.handle = null;
  }

  // También cancelamos el timer de inactividad al cerrar la sesión para evitar
  // que un timer obsoleto intente cerrar una sesión que ya no existe.
  clearLiveIdleTimer(channelId);
}

// Rechaza la promesa del turno pendiente actual de un canal.
// Se usa cuando la sesión se cierra o el stream es interrumpido antes de completar audio/texto.
function rejectPendingLiveTurn(channelId, error) {
  const state = getLiveChannelState(channelId);

  if (!state.pendingTurn) {
    return;
  }

  const pendingTurn = state.pendingTurn;
  state.pendingTurn = null;
  pendingTurn.reject(error);
}

// Finaliza el turno Live pendiente de un canal.
// Junta todos los chunks acumulados durante el stream y entrega un único resultado:
// - audio final concatenado
// - transcripción/texto del turno
// - usageMetadata asociado
//
// Si no llegó audio, rechaza el turno para que el flujo superior decida el fallback.
function finalizePendingLiveTurn(channelId) {
  const state = getLiveChannelState(channelId);

  if (!state.pendingTurn) {
    return;
  }

  const pendingTurn = state.pendingTurn;
  state.pendingTurn = null;

  const transcript = pendingTurn.transcriptChunks.join(' ').trim() || pendingTurn.textChunks.join(' ').trim();
  const audioBuffer = Buffer.concat(pendingTurn.audioChunks);

  if (audioBuffer.length === 0) {
    pendingTurn.reject(new Error('Live API no devolvio audio en el turno.'));
    return;
  }

  pendingTurn.resolve({
    audioBuffer,
    mimeType: pendingTurn.mimeType,
    transcript,
    usageMetadata: pendingTurn.usageMetadata,
  });
}

// Procesa cada frame/mensaje recibido desde la sesión Live de un canal.
// Este método es el acumulador central del streaming:
// - guarda handles de reanudación
// - acumula usageMetadata
// - acumula texto/transcripción parcial
// - acumula chunks de audio
// - detecta interrupciones o fin de turno
function handleLiveMessage(channelId, message) {
  const state = getLiveChannelState(channelId);

  if (message.sessionResumptionUpdate?.newHandle) {
    state.handle = message.sessionResumptionUpdate.newHandle;
  }

  if (message.goAway) {
    console.warn('⚠️ [LIVE] Gemini pidio cerrar la sesion pronto. Se reabrira en el siguiente turno.');
  }

  if (!state.pendingTurn) {
    return;
  }

  if (message.usageMetadata) {
    state.pendingTurn.usageMetadata = message.usageMetadata;
  }

  const serverContent = message.serverContent;

  if (!serverContent) {
    return;
  }

  if (serverContent.outputTranscription?.text) {
    state.pendingTurn.transcriptChunks.push(serverContent.outputTranscription.text.trim());
  }

  const parts = serverContent.modelTurn?.parts || [];
  const text = extractTextFromParts(parts);

  if (text) {
    state.pendingTurn.textChunks.push(text);
  }

  for (const part of parts) {
    if (!part?.inlineData?.mimeType?.startsWith('audio/')) {
      continue;
    }

    const audioChunk = extractInlineAudioData(part);

    if (!audioChunk) {
      continue;
    }

    state.pendingTurn.audioChunks.push(audioChunk);
    if (!state.pendingTurn.mimeType) {
      state.pendingTurn.mimeType = part.inlineData.mimeType;
    }
  }

  if (serverContent.interrupted) {
    rejectPendingLiveTurn(channelId, new Error('Gemini interrumpio el turno actual.'));
    return;
  }

  if (serverContent.turnComplete) {
    finalizePendingLiveTurn(channelId);
  }
}

// Garantiza que exista una sesión Live abierta para un canal.
// Si ya existe una sesión activa, la devuelve tal cual.
// Si hay una conexión en curso, reutiliza esa promesa para evitar conexiones duplicadas.
// Si no existe nada, abre una nueva sesión con callbacks enlazados al `channelId`.
//
// Esta función es el punto de entrada oficial para abrir o reutilizar Live por canal.
async function ensureLiveSession(channelId, userId) {
  const state = getLiveChannelState(channelId);

  if (isLiveQuotaBackoffActive(channelId)) {
    throw new Error('quota-backoff: Live API en pausa temporal por cuota excedida.');
  }

  if (liveDisabledReason) {
    throw new Error(`Live API deshabilitada: ${liveDisabledReason}`);
  }

  if (state.session) {
    return state.session;
  }

  if (state.connectPromise) {
    return state.connectPromise;
  }

  const liveSystemInstruction = buildLiveSystemInstruction(channelId);

  state.connectPromise = ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: ['AUDIO'],
      systemInstruction: liveSystemInstruction,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: TTS_VOICE,
          },
        },
      },
      ...(state.handle ? { sessionResumption: { handle: state.handle } } : {}),
    },
    callbacks: {
      onopen: () => {
        console.log(`✅ [LIVE] Sesion Live API conectada para canal ${channelId}.`);
      },
      onmessage: (message) => handleLiveMessage(channelId, message),
      onerror: (event) => {
        console.error(`❌ [LIVE] Error en la sesion del canal ${channelId}:`, event.error || event.message || event);
      },
      onclose: (event) => {
        console.warn(`⚠️ [LIVE] Sesion del canal ${channelId} cerrada (${event.code}): ${event.reason || 'sin detalle'}`);

        if (event.code === 1008) {
          liveDisabledReason = event.reason || 'La cuenta o el modelo no soportan esta configuracion Live.';
        }

        resetLiveSession(channelId);
        rejectPendingLiveTurn(channelId, new Error(`La sesion Live API se cerro durante el turno (codigo ${event.code}: ${event.reason || 'sin detalle'}).`));
      },
    },
  }).then((session) => {
    state.session = session;
    clearLiveQuotaBackoff(channelId);
    return session;
  }).catch((error) => {
    state.connectPromise = null;

    if (isQuotaError(error)) {
      armLiveQuotaBackoff(channelId, error);
    }

    throw error;
  });

  return state.connectPromise;
}

// Encola un mensaje de usuario como un turno Live del canal.
// Aunque haya muchos mensajes entrando casi al mismo tiempo, la cola del canal garantiza
// que Gemini procese un turno tras otro, sin mezclar audio ni transcripciones.
//
// Antes de enviar el turno:
// - limpia posibles rechazos viejos de la cola
// - rota la sesión si superó límites de tokens/turnos
// - asegura que la sesión del canal esté abierta
//
// Luego envía el texto ya enriquecido con el nombre del autor (`Nombre: mensaje`).
function enqueueLiveTurn(text, channelId, userId, authorName) {
  const state = getLiveChannelState(channelId);

  // Si un turno anterior fallo, limpiamos el rechazo para que la cola pueda seguir.
  // Sin esto, una sola promesa rechazada deja envenenada toda la cola hasta reiniciar el bot.
  state.turnQueue = state.turnQueue.catch(() => {}).then(async () => {
    // Si el canal está en backoff por cuota, rechazamos inmediatamente para que
    // el handler del mensaje caiga al fallback de texto sin perder otro turno Live.
    if (isLiveQuotaBackoffActive(channelId)) {
      throw new Error('quota-backoff: canal en pausa por cuota; usando fallback de texto.');
    }

    // Comprobamos ANTES de cada turno si ya superamos alguno de los dos umbrales.
    // Hacerlo aquí (y no solo después) garantiza que un turno nunca se envíe
    // a una sesión que ya está inflada en contexto.
    const tokenLimitReached = state.sessionTokenCount >= LIVE_SESSION_MAX_TOKENS;
    const turnLimitReached  = state.sessionTurnCount  >= LIVE_SESSION_MAX_TURNS;
    if (state.session && (tokenLimitReached || turnLimitReached)) {
      const reason = tokenLimitReached
        ? `tokens acumulados ${state.sessionTokenCount}/${LIVE_SESSION_MAX_TOKENS}`
        : `turnos ${state.sessionTurnCount}/${LIVE_SESSION_MAX_TURNS}`;
      console.warn(`⚠️ [LIVE] Sesion del canal ${channelId} reciclada antes del turno (${reason}). La nueva sesion arrancara con el resumen del historial local.`);
      resetLiveSession(channelId, { clearHandle: true });
    }

    const session = await ensureLiveSession(channelId, userId);

    return new Promise((resolve, reject) => {
      state.pendingTurn = {
        audioChunks: [],
        mimeType: null,
        textChunks: [],
        transcriptChunks: [],
        usageMetadata: null,
        resolve,
        reject,
      };

      try {
        const turnText = buildUserTurnText(authorName, text);
        session.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{ text: turnText }],
          }],
          turnComplete: true,
        });
      } catch (error) {
        state.pendingTurn = null;
        reject(error);
      }
    });
  });

  return state.turnQueue;
}

function enqueueChannelResponse(channelId, task) {
  const state = getLiveChannelState(channelId);
  state.responseQueue = state.responseQueue.catch(() => {}).then(task);
  return state.responseQueue;
}


// Cliente de Discord: configuración de intents mínimos necesarios para chat
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, 
  ],
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_KEY
});

client.once('ready', () => {
  console.log(`✅ [CONEXIÓN] ¡Bot Layla conectado con éxito como ${client.user.tag}!`);
  try {
    // Mostrar el Application ID ligado al cliente para verificar que coincida con APP_ID
    const appId = client.application?.id || (client.application && client.application.id) || process.env.APP_ID || 'desconocido';
    console.log(`🔎 [APP] Application ID: ${appId}`);
  } catch (e) {
    console.warn('No se pudo obtener client.application.id:', e);
  }
});

client.on('error', (err) => {
  console.error('[DISCORD CLIENT] error:', err);
});

client.on('shardError', (err) => {
  console.error('[DISCORD CLIENT] shardError:', err);
});

// 1. ESCUCHA DE CHAT TRADICIONAL
// Este handler es el corazón operativo del bot.
// Responsabilidades principales:
// - ignorar bots
// - verificar si el canal está activado con `/talk`
// - resolver menciones y nombres del autor
// - guardar historial local por canal/usuario
// - intentar respuesta por Live
// - degradar a fallback texto/TTS cuando Live falla
// - responder con audio o texto según el caso
// - rotar o cerrar sesiones Live cuando haga falta
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const channelId = message.channel.id;
  if (!activeChannelIds.has(channelId)) {
    return;
  }

  await message.channel.sendTyping();
  try {
    const incomingText = resolveMentionsInContent(message) || message.content;
    const authorName = message.member?.displayName || message.author.username;
    appendToHistory(channelId, 'user', incomingText, message.author.id, authorName);
    resetHistoryIdleTimer(channelId);

    await enqueueChannelResponse(channelId, async () => {
      let voiceResponse;

      try {
        if (liveDisabledReason || isLiveQuotaBackoffActive(channelId)) {
          try {
            voiceResponse = await generateVoiceReplyFallback(incomingText, channelId, message.author.id);
          } catch (fallbackError) {
            if (isQuotaError(fallbackError)) {
              console.warn(`🚫 [FALLBACK] Cuota excedida en TTS/texto: ${fallbackError.message}. Respondiendo solo con texto...`);
              let replyText = '';
              try {
                const tr = await generateTextReply(incomingText, channelId, message.author.id);
                replyText = tr.transcript;
              } catch {
                replyText = '¡¡Esperaaaa!!. ¡¡Me están escribiendo muchos a la veeeez!!';
              }
              await message.reply(replyText).catch(() => {});
              if (replyText) appendToHistory(channelId, 'assistant', replyText, message.author.id);
              liveDisabledReason = null;
              resetLiveSession(channelId, { clearHandle: true });
              ensureLiveSession(channelId, message.author.id).catch((e) =>
                console.warn(`⚠️ [LIVE] Reconexion tras cuota (fallback) fallo: ${e.message}`)
              );
              return;
            }

            console.warn('[FALLBACK] Error inesperado:', fallbackError.message);
            await message.reply('Mmm, algo salió mal. Dame un momento y vuelve a intentarlo.').catch(() => {});
            return;
          }
        } else {
          try {
            voiceResponse = await enqueueLiveTurn(incomingText, channelId, message.author.id, authorName);
          } catch (error) {
            if (isQuotaError(error) || isInterruptedTurnError(error) || isMissingAudioError(error)) {
              if (isQuotaError(error)) {
                armLiveQuotaBackoff(channelId, error);
              }

              const label = isQuotaError(error)
                ? '🚫 [LIVE] Cuota excedida'
                : isMissingAudioError(error)
                  ? '🔇 [LIVE] Turno sin audio'
                  : '⚡ [LIVE] Sesion interrumpida inesperadamente';
              console.warn(`${label}: ${error.message}. Respondiendo con texto y reconectando la sesion...`);

              resetLiveSession(channelId, { clearHandle: true });

              let replyText = '';
              try {
                const textResult = await generateTextReply(incomingText, channelId, message.author.id);
                replyText = textResult.transcript;
              } catch (textError) {
                console.warn('[LIVE] Error generando respuesta de texto:', textError.message);
                replyText = ':sweat_smile: ?';
              }

              await message.reply(replyText).catch(() => {});
              if (replyText) appendToHistory(channelId, 'assistant', replyText, message.author.id);

              ensureLiveSession(channelId, message.author.id).catch((e) =>
                console.warn(`⚠️ [LIVE] Reconexion en segundo plano fallo: ${e.message}`)
              );

              return;
            }

            if (!shouldDisableLive(error)) {
              throw error;
            }

            console.warn(`⚠️ [LIVE] Se usara fallback chat+TTS: ${error.message}`);
            resetLiveSession(channelId);
            liveDisabledReason = liveDisabledReason || error.message;
            voiceResponse = await generateVoiceReplyFallback(message.content, channelId, message.author.id);
          }
        }

        const { audioBuffer, mimeType, transcript, usageMetadata } = voiceResponse;
        const liveState = getLiveChannelState(channelId);

        if (audioBuffer?.length) {
          if (!isPcmMimeType(mimeType)) {
            console.warn(`⚠️ [LIVE] MIME inesperado para MP3: ${mimeType}. Se intentara codificar igual.`);
          }

          const attachmentBuffer = await pcm16ToMp3Buffer(audioBuffer);

          await message.reply({
            files: [{
              attachment: attachmentBuffer,
              name: 'layla_te_habla.mp3'
            }]
          });
        } else {
          await message.reply(transcript || 'No pude hablar, pero aqui va mi respuesta en texto.').catch(() => {});
        }

        if (usageMetadata?.totalTokenCount) {
          liveState.sessionTokenCount += Number(usageMetadata.totalTokenCount) || 0;
          liveState.sessionTurnCount += 1;
          console.log(`ℹ️ [LIVE] Canal ${channelId} | Tokens acumulados sesion: ${liveState.sessionTokenCount}/${LIVE_SESSION_MAX_TOKENS} | Turnos: ${liveState.sessionTurnCount}/${LIVE_SESSION_MAX_TURNS}`);
        } else if (usageMetadata?.text || usageMetadata?.audio) {
          liveState.sessionTurnCount += 1;
          console.log(`ℹ️ [FALLBACK] Canal ${channelId} | Respuesta generada con ${usageMetadata?.audio ? 'chat + TTS' : 'solo texto'}. Turnos Live: ${liveState.sessionTurnCount}/${LIVE_SESSION_MAX_TURNS}`);
        }

        try {
          if (transcript) {
            appendToHistory(channelId, 'assistant', transcript, message.author.id);
          } else {
            appendToHistory(channelId, 'assistant', 'voz de Layla (sin transcripción)', message.author.id);
          }
        } catch {}

        const tokensDone = liveState.sessionTokenCount >= LIVE_SESSION_MAX_TOKENS;
        const turnsDone = liveState.sessionTurnCount >= LIVE_SESSION_MAX_TURNS;
        if (tokensDone || turnsDone) {
          const reason = tokensDone
            ? `tokens acumulados ${liveState.sessionTokenCount}/${LIVE_SESSION_MAX_TOKENS}`
            : `turnos ${liveState.sessionTurnCount}/${LIVE_SESSION_MAX_TURNS}`;
          console.warn(`⚠️ [LIVE] Rotando sesion del canal ${channelId} (${reason}). La proxima conversacion arrancara con resumen del historial local.`);
          resetLiveSession(channelId, { clearHandle: true });
        } else {
          resetLiveIdleTimer(channelId);
        }
      } catch (error) {
        if (isQuotaError(error)) {
          console.warn(`🚫 [CUOTA] 429 en flujo principal: ${error.message}. Intentando respuesta de texto...`);
          armLiveQuotaBackoff(channelId, error);
          resetLiveSession(channelId, { clearHandle: true });
          liveDisabledReason = null;
          try {
            const tr = await generateTextReply(
              resolveMentionsInContent(message) || message.content,
              message.channel.id,
              message.author.id
            );
            await message.reply(tr.transcript).catch(() => {});
            appendToHistory(message.channel.id, 'assistant', tr.transcript, message.author.id);
          } catch {
            await message.reply('Mi voz me duele un poco.. espera').catch(() => {});
          }
          ensureLiveSession(message.channel.id, message.author.id).catch((e) =>
            console.warn(`⚠️ [LIVE] Reconexion tras cuota (catch raiz) fallo: ${e.message}`)
          );
          return;
        }

        console.error('[ERROR MULTIMODAL VÓZ]:', error);
        await message.reply('Error con la respuesta de voz de Layla. ¡Lo siento!').catch(() => {});
      }
    });
  } catch (error) {
    console.error('[ERROR MULTIMODAL VÓZ]:', error);
    await message.reply('Error con la respuesta de voz de Layla. ¡Lo siento!').catch(() => {});
  }
});


// 2. ESCUCHA DE COMANDOS DE BARRA
// Administra los slash commands del bot.
// - `/talk`: activa Layla solo en el canal actual
// - `/notalk`: la desactiva solo en el canal actual
// - `/wack`: limpia todas las sesiones Live e historiales locales
// - `/test`: comando simple de diagnóstico
client.on('interactionCreate', async (interaction) => {
  // Si la interacción no es un comando de barra (Slash Command), la ignoramos
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guildId) {
    return interaction.reply({
      content: 'Este comando solo funciona dentro de un servidor.',
      ephemeral: true,
    });
  }

  const { commandName } = interaction;

  // test
  if (commandName === 'test') {
    return interaction.reply(`si, estoy viva ${getRandomEmoji()}`);
  }

  // reiniciar sesion Live y limpiar estado
  if (commandName === 'wack') {
    try {
      // cerrar y limpiar
      for (const channelId of liveChannelStates.keys()) {
        try {
          resetLiveSession(channelId);
          clearHistoryIdleTimer(channelId);
        } catch (e) { console.warn('resetLiveSession error', e); }
      }
      liveDisabledReason = null;
      liveChannelStates.clear();
      conversationHistories.clear();
      perUserHistories.clear();

      await interaction.reply({ content: 'Ay, me golpee muy fuerte la cabeza...' });
    } catch (err) {
      console.error('Error al reiniciar Layla:', err);
      await interaction.reply({ content: `Error reiniciando Layla: ${err.message}`, ephemeral: true });
    }

    return;
  }

  if ((commandName === 'talk' || commandName === 'notalk')
  && !interaction.memberPermissions?.has('Administrator')) {
  return interaction.reply({
    content: 'Ey, Solo mis administradores pueden usar este comando. :c',
    ephemeral: true,
  });
}

  if (commandName === 'talk') {
    activeChannelIds.add(interaction.channelId);
    return interaction.reply('¿Alguien me llamó?.');
  }
  if (commandName === 'notalk') {
    activeChannelIds.delete(interaction.channelId);
    resetLiveSession(interaction.channelId, { clearHandle: true });
    clearHistoryIdleTimer(interaction.channelId);
    //Borrar el canal de los Map principales para liberar RAM
    liveChannelStates.delete(interaction.channelId);
    clearChannelHistory(interaction.channelId);
    return interaction.reply('Adiós, me voy a dormir... zzz');
  }
  
});

// === ARRANQUE GENERAL ===
const tokenFinal = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!tokenFinal) {
  console.error('Falta el Token en el .env');
} else {
  console.log('Conectando a la API de Discord...');
  client.login(tokenFinal).catch(err => {
    console.error('Error de login:', err);
  });
}
