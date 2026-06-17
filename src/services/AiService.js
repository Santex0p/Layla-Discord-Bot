import { GoogleGenAI } from '@google/genai';
import { CONFIG } from '../config/constants.js';
import guildPromptManager from '../models/GuildPromptManager.js';
import stateManager from '../models/ChannelStateManager.js';
import { extractTextFromParts, extractInlineAudioData, extractResponseText, isQuotaError } from '../utils/helpers.js';
import voiceChannelService from './VoiceChannelService.js';

class AiService {
  constructor() {
    this.ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_KEY
    });
  }

  isLiveQuotaBackoffActive(channelId) {
    const state = stateManager.getLiveChannelState(channelId);
    return state.quotaBackoffUntil > Date.now();
  }

  clearLiveQuotaRetryTimer(channelId) {
    const state = stateManager.getLiveChannelState(channelId);
    if (state.quotaRetryTimer) {
      clearTimeout(state.quotaRetryTimer);
      state.quotaRetryTimer = null;
    }
  }

  scheduleLiveReconnectAfterBackoff(channelId) {
    const state = stateManager.getLiveChannelState(channelId);
    this.clearLiveQuotaRetryTimer(channelId);

    const waitMs = Math.max(0, state.quotaBackoffUntil - Date.now());
    if (!waitMs) return;

    state.quotaRetryTimer = setTimeout(() => {
      state.quotaRetryTimer = null;

      if (!stateManager.isChannelActive(channelId)) return;

      if (this.isLiveQuotaBackoffActive(channelId)) {
        this.scheduleLiveReconnectAfterBackoff(channelId);
        return;
      }

      stateManager.resetLiveSession(channelId, { clearHandle: true });
      this.ensureLiveSession(channelId).then(() => {
        console.log(`✅ [LIVE] Reconectada automaticamente la sesion del canal ${channelId} tras cuota.`);
      }).catch((error) => {
        if (isQuotaError(error)) {
          this.armLiveQuotaBackoff(channelId, error);
          return;
        }
        console.warn(`⚠️ [LIVE] Fallo la reconexion automatica del canal ${channelId}: ${error.message}`);
      });
    }, waitMs);
  }

  armLiveQuotaBackoff(channelId, error) {
    const state = stateManager.getLiveChannelState(channelId);
    const nextUntil = Date.now() + CONFIG.LIVE_QUOTA_BACKOFF_MS;
    state.quotaBackoffUntil = Math.max(state.quotaBackoffUntil || 0, nextUntil);
    const seconds = Math.ceil((state.quotaBackoffUntil - Date.now()) / 1000);
    console.warn(`🚫 [LIVE] Backoff por cuota en canal ${channelId} durante ${seconds}s: ${error?.message || error}`);
    this.scheduleLiveReconnectAfterBackoff(channelId);
  }

  clearLiveQuotaBackoff(channelId) {
    const state = stateManager.getLiveChannelState(channelId);
    state.quotaBackoffUntil = 0;
    this.clearLiveQuotaRetryTimer(channelId);
  }

  async generateTextReply(text, channelId, userId, guildId) {
    const historyContents = stateManager.buildHistoryContents(channelId, userId);
    const contents = historyContents.length ? [...historyContents, text] : text;
    
    const basePrompt = guildPromptManager.getPrompt(guildId);

    const response = await this.ai.models.generateContent({
      model: CONFIG.TEXT_MODEL,
      contents,
      config: {
        systemInstruction: basePrompt,
        safetySettings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }
        ],
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

  async searchInternet(query) {
    const systemInstruction = `Eres Layla. Se te ha pedido buscar información en Internet. Lee los resultados de búsqueda, responde a la pregunta de forma natural, casual y coqueta (manteniendo tu personalidad sarcástica o bromista si aplica). ¡MANTÉN TU RESPUESTA CORTA Y RESUMIDA (Máximo 2 o 3 párrafos)! ES MUY IMPORTANTE que incluyas los enlaces o URLs de las fuentes al final de tu respuesta para que el usuario pueda hacer clic!`;

    const response = await this.ai.models.generateContent({
      model: CONFIG.TEXT_MODEL,
      contents: query,
      config: {
        systemInstruction,
        tools: [{ googleSearch: {} }],
        safetySettings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }
        ],
      },
    });

    const transcript = extractResponseText(response);

    if (!transcript) {
      throw new Error('Gemini no devolvio texto en la busqueda.');
    }

    return transcript;
  }

  async checkOllamaConnection() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const url = new URL('/api/tags', CONFIG.OLLAMA_URL).toString();
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) throw new Error(`Ollama HTTP Error: ${response.status}`);
      return true;
    } catch (e) {
      throw new Error(`Ollama inalcanzable o apagado: ${e.message}`);
    }
  }

  async generateOllamaReply(text, channelId, userId, guildId) {
    await this.checkOllamaConnection();

    const historyContents = stateManager.buildHistoryContents(channelId, userId);
    const basePrompt = guildPromptManager.getPrompt(guildId);
    
    // Transformar el formato de Gemini (text) al formato de Ollama (messages)
    const messages = [
      { role: 'system', content: basePrompt }
    ];

    for (const msg of historyContents) {
      // historyContents son strings pre-formateadas "Usuario [Nombre]: texto" o "Layla: texto"
      // Simplificamos: si empieza con "Layla:", es assistant. Si no, es user.
      if (msg.startsWith('Layla:')) {
        messages.push({ role: 'assistant', content: msg.replace('Layla: ', '') });
      } else {
        messages.push({ role: 'user', content: msg });
      }
    }
    
    messages.push({ role: 'user', content: text });

    const url = new URL('/api/chat', CONFIG.OLLAMA_URL).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: messages,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const transcript = data.message?.content?.trim();

    if (!transcript) {
      throw new Error('Ollama no devolvio texto valido.');
    }

    return { transcript };
  }

  async describeImage(imageUrl) {
    try {
      console.log(`[PROXY VISUAL] Descargando imagen: ${imageUrl}`);
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Error descargando imagen: ${response.statusText}`);
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString('base64');
      const mimeType = response.headers.get('content-type') || 'image/jpeg';

      console.log(`[PROXY VISUAL] Imagen descargada (${buffer.length} bytes). Analizando con gemini-2.5-flash...`);

      const aiResponse = await this.ai.models.generateContent({
        model: CONFIG.TEXT_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Describe qué hay en esta imagen de forma precisa, natural y breve en español (máximo 15 palabras).' },
              { inlineData: { mimeType, data: base64Data } }
            ]
          }
        ]
      });

      const description = extractResponseText(aiResponse)?.trim();
      console.log(`[PROXY VISUAL] Resultado: ${description}`);
      
      return description || 'una imagen irreconocible';
    } catch (error) {
      console.error(`[PROXY VISUAL] Falló el análisis de imagen: ${error.message}`);
      return 'una imagen que no pude analizar por un error técnico';
    }
  }

  handleLiveMessage(channelId, message) {
    const state = stateManager.getLiveChannelState(channelId);
    const isVoice = state.voiceMode;
    const voiceSession = isVoice ? voiceChannelService.players.get(channelId) : null;

    if (message.usageMetadata && state.pendingTurn) {
      state.pendingTurn.usageMetadata = message.usageMetadata;
    }

    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.outputTranscription?.text && state.pendingTurn) {
      state.pendingTurn.transcriptChunks.push(serverContent.outputTranscription.text.trim());
    }

    const parts = serverContent.modelTurn?.parts || [];
    const text = extractTextFromParts(parts);

    if (text && state.pendingTurn) {
      state.pendingTurn.textChunks.push(text);
    }

    for (const part of parts) {
      if (!part?.inlineData?.mimeType?.startsWith('audio/')) continue;
      const audioChunk = extractInlineAudioData(part);
      if (!audioChunk) continue;

      if (isVoice && voiceSession) {
        // En este modo (pure audio prompt), reproducimos el audio inmediatamente
        // y confiamos en el prompt del sistema.
        voiceChannelService.playAudioChunk(channelId, audioChunk);
        voiceChannelService.setListeningState(channelId, 'responding');
      } else {
        // Chat normal (no voz)
        voiceChannelService.playAudioChunk(channelId, audioChunk);
      }

      if (state.pendingTurn) {
        state.pendingTurn.audioChunks.push(audioChunk);
        if (!state.pendingTurn.mimeType) {
          state.pendingTurn.mimeType = part.inlineData.mimeType;
        }
      }
    }

    if (serverContent.interrupted && state.pendingTurn) {
      stateManager.rejectPendingLiveTurn(channelId, new Error('Gemini interrumpio el turno actual.'));
      // Volver a escuchar tras interrupción
      if (isVoice && voiceSession) {
        voiceChannelService.setListeningState(channelId, 'cooldown');
      }
      return;
    }

    if (serverContent.turnComplete) {
      if (state.pendingTurn) {
        stateManager.finalizePendingLiveTurn(channelId);
      }
      
      if (isVoice && voiceSession) {
        if (voiceSession.listeningState === 'responding') {
          console.log(`💬 [LAYLA] Turno completado tras haber hablado.`);
          voiceChannelService.setListeningState(channelId, 'cooldown');
        } else {
          console.log(`🤫 [LAYLA] Gemini guardó silencio.`);
          
          if (voiceSession.alexaState === 'AWAKE' || !voiceSession.alexaMode) {
            
            // Verificar si el motor local detectó palabras humanas reales
            let heardActualWords = false;
            for (const [uid, uData] of voiceSession.userBuffers.entries()) {
              if (uData.transcriptHistory && uData.transcriptHistory.length > 0) {
                heardActualWords = true;
                break;
              }
            }

            if (heardActualWords) {
              console.log(`[LAYLA] Escuchó palabras pero no las entendió. Forzando respuesta...`);
              try {
                voiceSession.session.sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: "Si no pudiste escucharme o no entendiste mi audio, actúa confundida. Usa muletillas y di algo corto como '¿Eh? No te escuché bien, ¿qué dijiste?' usando tu voz natural." }] }],
                  turnComplete: true
                });
                voiceChannelService.setListeningState(channelId, 'processing');
              } catch (e) {
                console.error('[LIVE] Error forzando respuesta de silencio:', e.message);
                voiceChannelService.setListeningState(channelId, 'cooldown');
              }
            } else {
              console.log(`[LAYLA] Era solo ruido de fondo. Ignorando.`);
              voiceChannelService.setListeningState(channelId, 'cooldown');
            }
          } else {
            voiceChannelService.setListeningState(channelId, 'cooldown');
          }
        }
      }
    }
  }

  async ensureLiveSession(channelId, userId, guildId = null) {
    const state = stateManager.getLiveChannelState(channelId);

    if (this.isLiveQuotaBackoffActive(channelId)) {
      throw new Error('quota-backoff: Live API en pausa temporal por cuota excedida.');
    }

    if (stateManager.getLiveDisabledReason()) {
      throw new Error(`Live API deshabilitada: ${stateManager.getLiveDisabledReason()}`);
    }

    if (state.session) return state.session;
    if (state.connectPromise) return state.connectPromise;

    const liveSystemInstruction = stateManager.buildLiveSystemInstruction(channelId, guildId);

    state.connectPromise = this.ai.live.connect({
      model: CONFIG.LIVE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: liveSystemInstruction,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: CONFIG.TTS_VOICE,
            },
          },
        },
        ...(state.handle ? { sessionResumption: { handle: state.handle } } : {}),
      },
      callbacks: {
        onopen: () => {
          console.log(`✅ [LIVE] Sesion Live API conectada para canal ${channelId}.`);
        },
        onmessage: (message) => this.handleLiveMessage(channelId, message),
        onerror: (event) => {
          console.error(`❌ [LIVE] Error en la sesion del canal ${channelId}:`, event.error || event.message || event);
        },
        onclose: (event) => {
          console.warn(`⚠️ [LIVE] Sesion del canal ${channelId} cerrada (${event.code}): ${event.reason || 'sin detalle'}`);

          let clearHandle = false;
          if (event.code === 1008) {
            console.warn(`⚠️ [LIVE] Codigo 1008 detectado. Probablemente la llave (handle) caduco. Descartando la llave en lugar de apagar el modo Live.`);
            clearHandle = true;
          }

          stateManager.resetLiveSession(channelId, { clearHandle });
          stateManager.rejectPendingLiveTurn(channelId, new Error(`La sesion Live API se cerro durante el turno (codigo ${event.code}: ${event.reason || 'sin detalle'}).`));
        },
      },
    }).then((session) => {
      state.session = session;
      this.clearLiveQuotaBackoff(channelId);
      return session;
    }).catch((error) => {
      state.connectPromise = null;
      if (isQuotaError(error)) {
        this.armLiveQuotaBackoff(channelId, error);
      }
      throw error;
    });

    return state.connectPromise;
  }

  async reconnectLiveSession(channelId) {
    const state = stateManager.getLiveChannelState(channelId);
    console.log(`[LIVE] Forzando reconexión cíclica para canal ${channelId} (borrando contexto de memoria)...`);
    
    // Matar sesión actual sin handle
    stateManager.resetLiveSession(channelId, { clearHandle: true });
    
    // Crear una nueva
    return this.ensureLiveSession(channelId);
  }

  enqueueLiveTurn(text, channelId, userId, authorName) {
    const state = stateManager.getLiveChannelState(channelId);

    state.turnQueue = state.turnQueue.catch(() => { }).then(async () => {
      if (this.isLiveQuotaBackoffActive(channelId)) {
        throw new Error('quota-backoff: canal en pausa por cuota; usando fallback de texto.');
      }

      const tokenLimitReached = state.sessionTokenCount >= CONFIG.LIVE_SESSION_MAX_TOKENS;
      const turnLimitReached = state.sessionTurnCount >= CONFIG.LIVE_SESSION_MAX_TURNS;

      if (state.session && (tokenLimitReached || turnLimitReached)) {
        const reason = tokenLimitReached
          ? `tokens acumulados ${state.sessionTokenCount}/${CONFIG.LIVE_SESSION_MAX_TOKENS}`
          : `turnos ${state.sessionTurnCount}/${CONFIG.LIVE_SESSION_MAX_TURNS}`;
        console.warn(`⚠️ [LIVE] Sesion del canal ${channelId} reciclada antes del turno (${reason}). La nueva sesion arrancara con el resumen del historial local.`);
        stateManager.resetLiveSession(channelId, { clearHandle: true });
      }

      const session = await this.ensureLiveSession(channelId, userId);

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
          const turnText = stateManager.buildUserTurnText(authorName, text);
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
}

export default new AiService();
