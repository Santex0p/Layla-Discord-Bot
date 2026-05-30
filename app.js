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
const LIVE_SYSTEM_INSTRUCTION = 'Eres Layla, una chica simpatica y divertida. Responde a los mensajes de los usuarios con voz linda, con emociones y natural. Mantén un tono amistoso, casual y travieso. Si el usuario te hace una pregunta o comentario, responde de manera relevante y entretenida. Si no entiendes algo, haz una broma al respecto en lugar de admitir que no sabes. Siempre busca mantener la conversación ligera y divertida. Mensajes breves, cortos pero con mucha personalidad.';
const TTS_VOICE = 'Zephyr';
const TTS_SAMPLE_RATE = 24000;
const TTS_CHANNELS = 1;
const LIVE_SESSION_MAX_TOKENS = Number(process.env.LAYLA_LIVE_MAX_TOKENS) || 24000;

// Historial local por canal: usado para dar contexto en el fallback (generateContent)
// `HISTORY_SIZE` controla cuántos mensajes se guardan (por defecto 8)
const HISTORY_SIZE = Number(process.env.LAYLA_HISTORY_SIZE) || 8;
const conversationHistories = new Map(); // key: channelId -> [{role, text}, ...]

// Estado de la sesión Live y control de turnos
let liveSession = null; // instancia de la sesión WebSocket Live
let liveSessionHandle = null; // handle de reanudación (si Gemini lo provee)
let liveConnectPromise = null; // promesa pendiente de conexión Live
let livePendingTurn = null; // estructura para acumular audio/texto mientras llega el turno
let liveTurnQueue = Promise.resolve(); // cola para serializar turnos
let liveDisabledReason = null; // texto explicando por qué Live fue deshabilitado
let liveSessionTokenCount = 0; // tokens acumulados reportados por la sesion actual

// Gemini TTS suele devolver PCM lineal de 16 bits. Convertimos ese PCM a MP3
// usando `ffmpeg` (paquete `ffmpeg-static`) porque evita dependencias nativas
// problemáticas en tiempo de ejecución (por ejemplo, `lamejs`).
// Entrada: `pcmBuffer` (Buffer con s16le), `sampleRate`, `channels`.
// Salida: Promise<Buffer> con datos MP3.
async function pcm16ToMp3Buffer(pcmBuffer, sampleRate = TTS_SAMPLE_RATE, channels = TTS_CHANNELS) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static no devolvio una ruta ejecutable.');
  }

  return new Promise((resolve, reject) => {
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

    ffmpeg.stdout.on('data', (chunk) => {
      outputChunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (chunk) => {
      errorChunks.push(chunk);
    });

    ffmpeg.on('error', (error) => {
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        return resolve(Buffer.concat(outputChunks));
      }

      const ffmpegError = Buffer.concat(errorChunks).toString('utf8').trim();
      reject(new Error(`ffmpeg fallo al codificar MP3 (exit ${code}): ${ffmpegError}`));
    });

    ffmpeg.stdin.on('error', (error) => {
      reject(error);
    });

    ffmpeg.stdin.end(pcmBuffer);
  });
}

// Comprueba si un mimeType corresponde a PCM/L16 entregado por Gemini
function isPcmMimeType(mimeType) {
  if (!mimeType) {
    return false;
  }

  const normalizedMime = mimeType.toLowerCase();
  return normalizedMime.startsWith('audio/pcm') || normalizedMime.startsWith('audio/l16');
}

// Extrae y concatena el texto de `parts` (estructura que devuelve el SDK).
// Normalmente `parts` contiene objetos con `.text` si el candidato devuelve texto.
function extractTextFromParts(parts = []) {
  return parts
    .map((part) => part?.text?.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

// El SDK puede entregar los bytes como Buffer, Uint8Array o base64 segun la version.
// Unificamos eso para que el resto del flujo trabaje siempre con Buffer.
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
// Prioriza `response.text` y, si no existe, busca en `candidates[*].content.parts`.
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

// Busca y devuelve la primera parte de audio inline en una respuesta de `generateContent`.
// Retorna { audioBuffer, mimeType } o `null` si no hay audio.
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

// Heurística para decidir si un error significa que Live no está soportado
// (por ejemplo, cierre con código 1008 o mensajes del servidor indicando falta de feature).
function shouldDisableLive(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('1008')
    || message.includes('operation is not implemented')
    || message.includes('supported, or enabled')
    || message.includes('sesion live api se cerro');
}

// Genera texto con `models.generateContent`. Si `channelId` existe se incluye
// el historial local (buildHistoryContents) para dar contexto en el fallback.
async function generateTextReply(text, channelId) {
  const historyContents = buildHistoryContents(channelId);
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

function appendToHistory(channelId, role, text) {
  if (!channelId || !text) return;
  const prev = conversationHistories.get(channelId) || [];
  prev.push({ role, text: String(text).trim() });
  if (prev.length > HISTORY_SIZE) {
    conversationHistories.set(channelId, prev.slice(-HISTORY_SIZE));
  } else {
    conversationHistories.set(channelId, prev);
  }
}

function buildHistoryContents(channelId) {
  const hist = conversationHistories.get(channelId) || [];
  return hist.map((m) => (m.role === 'user' ? `Usuario: ${m.text}` : `Layla: ${m.text}`));
}

function buildLiveSessionSummary(channelId) {
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

function buildLiveSystemInstruction(channelId) {
  const historySummary = buildLiveSessionSummary(channelId);

  if (!historySummary) {
    return LIVE_SYSTEM_INSTRUCTION;
  }

  return `${LIVE_SYSTEM_INSTRUCTION}\n\n${historySummary}`;
}

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

// Flujo fallback (texto -> TTS): genera texto (incluyendo historial) y luego sintetiza audio.
async function generateVoiceReplyFallback(text, channelId) {
  const textResult = await generateTextReply(text, channelId);
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
}

// Cierra la sesión Live y resetea variables vinculadas a la conexión.
// No hace reconexión automática: `ensureLiveSession()` la reintentará cuando sea necesario.
function resetLiveSession(options = {}) {
  const { clearHandle = false } = options;

  if (liveSession) {
    try {
      liveSession.close();
    } catch {
      // Si el socket ya se cerro, no hace falta hacer nada adicional.
    }
  }

  liveSession = null;
  liveConnectPromise = null;
  liveSessionTokenCount = 0;

  if (clearHandle) {
    liveSessionHandle = null;
  }
}

function rejectPendingLiveTurn(error) {
  if (!livePendingTurn) {
    return;
  }

  const pendingTurn = livePendingTurn;
  livePendingTurn = null;
  pendingTurn.reject(error);
}

// Cuando Gemini marca `turnComplete`, esta función junta los chunks
// de audio y texto que se acumularon en `livePendingTurn` y resuelve la promesa
// que estaba esperando el resultado del turno.
function finalizePendingLiveTurn() {
  if (!livePendingTurn) {
    return;
  }

  const pendingTurn = livePendingTurn;
  livePendingTurn = null;

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

// Maneja mensajes entrantes desde la sesión Live.
// Acumula transcripción (outputTranscription), texto y trozos de audio
// en `livePendingTurn` hasta que el servidor indique `turnComplete`.
function handleLiveMessage(message) {
  if (message.sessionResumptionUpdate?.newHandle) {
    liveSessionHandle = message.sessionResumptionUpdate.newHandle;
  }

  if (message.goAway) {
    console.warn('⚠️ [LIVE] Gemini pidio cerrar la sesion pronto. Se reabrira en el siguiente turno.');
  }

  if (!livePendingTurn) {
    return;
  }

  if (message.usageMetadata) {
    livePendingTurn.usageMetadata = message.usageMetadata;
  }

  const serverContent = message.serverContent;

  if (!serverContent) {
    return;
  }

  if (serverContent.outputTranscription?.text) {
    livePendingTurn.transcriptChunks.push(serverContent.outputTranscription.text.trim());
  }

  const parts = serverContent.modelTurn?.parts || [];
  const text = extractTextFromParts(parts);

  if (text) {
    livePendingTurn.textChunks.push(text);
  }

  for (const part of parts) {
    if (!part?.inlineData?.mimeType?.startsWith('audio/')) {
      continue;
    }

    const audioChunk = extractInlineAudioData(part);

    if (!audioChunk) {
      continue;
    }

    livePendingTurn.audioChunks.push(audioChunk);
    if (!livePendingTurn.mimeType) {
      livePendingTurn.mimeType = part.inlineData.mimeType;
    }
  }

  if (serverContent.interrupted) {
    rejectPendingLiveTurn(new Error('Gemini interrumpio el turno actual.'));
    return;
  }

  if (serverContent.turnComplete) {
    finalizePendingLiveTurn();
  }
}

// Asegura y abre la sesión Live si no existe. Establece callbacks para
// recibir mensajes, errores y cierres del socket. Marca `liveDisabledReason`
// si el servidor rechaza la conexión por capacidades no habilitadas.
async function ensureLiveSession(channelId) {
  if (liveDisabledReason) {
    throw new Error(`Live API deshabilitada: ${liveDisabledReason}`);
  }

  if (liveSession) {
    return liveSession;
  }

  if (liveConnectPromise) {
    return liveConnectPromise;
  }

  const liveSystemInstruction = buildLiveSystemInstruction(channelId);

  liveConnectPromise = ai.live.connect({
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
      ...(liveSessionHandle ? { sessionResumption: { handle: liveSessionHandle } } : {}),
    },
    callbacks: {
      onopen: () => {
        console.log('✅ [LIVE] Sesion Live API conectada.');
      },
      onmessage: handleLiveMessage,
      onerror: (event) => {
        console.error('❌ [LIVE] Error en la sesion:', event.error || event.message || event);
      },
      onclose: (event) => {
        console.warn(`⚠️ [LIVE] Sesion cerrada (${event.code}): ${event.reason || 'sin detalle'}`);

        if (event.code === 1008) {
          liveDisabledReason = event.reason || 'La cuenta o el modelo no soportan esta configuracion Live.';
        }

        resetLiveSession();
        rejectPendingLiveTurn(new Error(`La sesion Live API se cerro durante el turno (codigo ${event.code}: ${event.reason || 'sin detalle'}).`));
      },
    },
  }).then((session) => {
    liveSession = session;
    return session;
  }).catch((error) => {
    liveConnectPromise = null;
    throw error;
  });

  return liveConnectPromise;
}

// Los turnos se serializan porque esta integracion usa una unica sesion Live.
// Eso simplifica mucho el manejo del contexto y evita mezclar audio de varias respuestas.
// Envía un turno de texto a la sesión Live. La cola `liveTurnQueue` garantiza
// que los turnos se procesen uno a la vez (serializados).
function enqueueLiveTurn(text, channelId) {
  liveTurnQueue = liveTurnQueue.then(async () => {
    if (liveSession && liveSessionTokenCount >= LIVE_SESSION_MAX_TOKENS) {
      console.warn(`⚠️ [LIVE] Sesion reciclada antes del turno por limite de tokens (${liveSessionTokenCount}/${LIVE_SESSION_MAX_TOKENS}).`);
      resetLiveSession({ clearHandle: true });
    }

    const session = await ensureLiveSession(channelId);

    return new Promise((resolve, reject) => {
      livePendingTurn = {
        audioChunks: [],
        mimeType: null,
        textChunks: [],
        transcriptChunks: [],
        usageMetadata: null,
        resolve,
        reject,
      };

      try {
        session.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{ text }],
          }],
          turnComplete: true,
        });
      } catch (error) {
        livePendingTurn = null;
        reject(error);
      }
    });
  });

  return liveTurnQueue;
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

let laylaActive = false;

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
// Handler para mensajes de texto en canales: controla activación/desactivación
// del modo Layla y enruta los mensajes a Live o al fallback.
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const userMessage = message.content.trim().toLowerCase();

  if (userMessage === '!layla on') {
    laylaActive = true;
    console.log('Modo conversacion ACTIVADO.');
    return message.reply('Modo conversacion activado');
  }

  if (userMessage === '!layla off') {
    laylaActive = false;
    console.log('Modo conversacion DESACTIVADO.');
    return message.reply('Modo conversacion desactivado.');
  }

if (laylaActive) {
  await message.channel.sendTyping();
  try {
    const channelId = message.channel.id;
    appendToHistory(channelId, 'user', message.content);

    let voiceResponse;

    if (liveDisabledReason) {
      voiceResponse = await generateVoiceReplyFallback(message.content, channelId);
    } else {
      try {
        voiceResponse = await enqueueLiveTurn(message.content, channelId);
      } catch (error) {
        if (!shouldDisableLive(error)) {
          throw error;
        }

        console.warn(`⚠️ [LIVE] Se usara fallback chat+TTS: ${error.message}`);
        resetLiveSession();
        liveDisabledReason = liveDisabledReason || error.message;
        voiceResponse = await generateVoiceReplyFallback(message.content, channelId);
      }
    }

    const { audioBuffer, mimeType, transcript, usageMetadata } = voiceResponse;

    if (!isPcmMimeType(mimeType)) {
      console.warn(`⚠️ [LIVE] MIME inesperado para MP3: ${mimeType}. Se intentara codificar igual.`);
    }

    const attachmentBuffer = await pcm16ToMp3Buffer(audioBuffer);

    if (usageMetadata?.totalTokenCount) {
      liveSessionTokenCount = Number(usageMetadata.totalTokenCount) || 0;
      console.log(`ℹ️ [LIVE] Tokens de la sesion: ${liveSessionTokenCount}`);
    } else if (usageMetadata?.text || usageMetadata?.audio) {
      console.log('ℹ️ [FALLBACK] Respuesta generada con chat + TTS.');
    }

    await message.reply({
      //content: transcript ? `voz: ${transcript}` : 'voz: respuesta de Layla',
      files: [{
        attachment: attachmentBuffer,
        name: 'layla_te_habla.mp3'
      }]
    });

    // Guardar la respuesta del asistente en el historial para futuros turnos fallback
    try {
      if (transcript) {
        appendToHistory(channelId, 'assistant', transcript);
      } else {
        appendToHistory(channelId, 'assistant', 'voz de Layla (sin transcripción)');
      }
    } catch {}

    if (liveSessionTokenCount >= LIVE_SESSION_MAX_TOKENS) {
      console.warn(`⚠️ [LIVE] Limite de tokens alcanzado (${liveSessionTokenCount}/${LIVE_SESSION_MAX_TOKENS}). Se abrira una sesion nueva con resumen del historial local.`);
      resetLiveSession({ clearHandle: true });
    }

  } catch (error) {
    console.error('[ERROR MULTIMODAL VÓZ]:', error);
    await message.reply('Error con la respuesta de voz de Layla. ¡Lo siento!').catch(() => {});
  }
}
});


// 2. ESCUCHA DE COMANDOS DE BARRA 
client.on('interactionCreate', async (interaction) => {
  // Si la interacción no es un comando de barra (Slash Command), la ignoramos
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // test
  if (commandName === 'test') {
    return interaction.reply(`hello world ${getRandomEmoji()}`);
  }

  // reiniciar sesion Live y limpiar estado
  if (commandName === 'wack') {
    await interaction.reply({ content: 'Ay, me golpee muy fuerte la cabeza', ephemeral: true });
    try {
      // cerrar y limpiar
      try { resetLiveSession(); } catch (e) { console.warn('resetLiveSession error', e); }
      liveDisabledReason = null;
      liveSessionHandle = null;
      conversationHistories.clear();
      laylaActive = false;

      await interaction.followUp({ content: 'Reinicio completado. Layla está lista.', ephemeral: true });
    } catch (err) {
      console.error('Error al reiniciar Layla:', err);
      await interaction.followUp({ content: `Error reiniciando Layla: ${err.message}`, ephemeral: true });
    }

    return;
  }

  // mas comandos
  /*
  if (commandName === 'wack') {
    return interaction.reply('¡Aquí estoy para ayudarte!');
  }
  */
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
