import { GoogleGenAI } from '@google/genai';
import { CONFIG } from '../config/constants.js';
import stateManager from '../models/ChannelStateManager.js';
import { extractTextFromParts, extractInlineAudioData, extractResponseText, isQuotaError } from '../utils/helpers.js';

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

  async generateTextReply(text, channelId, userId) {
    const historyContents = stateManager.buildHistoryContents(channelId, userId);
    const contents = historyContents.length ? [...historyContents, text] : text;

    const response = await this.ai.models.generateContent({
      model: CONFIG.TEXT_MODEL,
      contents,
      config: {
        systemInstruction: CONFIG.LIVE_SYSTEM_INSTRUCTION,
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

  handleLiveMessage(channelId, message) {
    const state = stateManager.getLiveChannelState(channelId);

    if (message.sessionResumptionUpdate?.newHandle) {
      state.handle = message.sessionResumptionUpdate.newHandle;
    }

    if (message.goAway) {
      console.warn('⚠️ [LIVE] Gemini pidio cerrar la sesion pronto. Se reabrira en el siguiente turno.');
    }

    if (!state.pendingTurn) return;

    if (message.usageMetadata) {
      state.pendingTurn.usageMetadata = message.usageMetadata;
    }

    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.outputTranscription?.text) {
      state.pendingTurn.transcriptChunks.push(serverContent.outputTranscription.text.trim());
    }

    const parts = serverContent.modelTurn?.parts || [];
    const text = extractTextFromParts(parts);

    if (text) {
      state.pendingTurn.textChunks.push(text);
    }

    for (const part of parts) {
      if (!part?.inlineData?.mimeType?.startsWith('audio/')) continue;
      const audioChunk = extractInlineAudioData(part);
      if (!audioChunk) continue;

      state.pendingTurn.audioChunks.push(audioChunk);
      if (!state.pendingTurn.mimeType) {
        state.pendingTurn.mimeType = part.inlineData.mimeType;
      }
    }

    if (serverContent.interrupted) {
      stateManager.rejectPendingLiveTurn(channelId, new Error('Gemini interrumpio el turno actual.'));
      return;
    }

    if (serverContent.turnComplete) {
      stateManager.finalizePendingLiveTurn(channelId);
    }
  }

  async ensureLiveSession(channelId, userId) {
    const state = stateManager.getLiveChannelState(channelId);

    if (this.isLiveQuotaBackoffActive(channelId)) {
      throw new Error('quota-backoff: Live API en pausa temporal por cuota excedida.');
    }

    if (stateManager.getLiveDisabledReason()) {
      throw new Error(`Live API deshabilitada: ${stateManager.getLiveDisabledReason()}`);
    }

    if (state.session) return state.session;
    if (state.connectPromise) return state.connectPromise;

    const liveSystemInstruction = stateManager.buildLiveSystemInstruction(channelId);

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
          if (event.code === 1008) {
            stateManager.setLiveDisabledReason(event.reason || 'La cuenta o el modelo no soportan esta configuracion Live.');
          }
          stateManager.resetLiveSession(channelId);
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
