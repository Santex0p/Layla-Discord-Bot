import { CONFIG } from '../config/constants.js';

class ChannelStateManager {
  constructor() {
    this.conversationHistories = new Map(); // key: channelId -> [{role, text}, ...]
    this.perUserHistories = new Map(); // key: `${channelId}:${userId}` -> [{role, text}, ...]
    this.liveChannelStates = new Map();
    this.activeChannelIds = new Set();
    this.liveDisabledReason = null;
  }

  getLiveDisabledReason() {
    return this.liveDisabledReason;
  }

  setLiveDisabledReason(reason) {
    this.liveDisabledReason = reason;
  }

  isChannelActive(channelId) {
    return this.activeChannelIds.has(channelId);
  }

  activateChannel(channelId) {
    this.activeChannelIds.add(channelId);
  }

  deactivateChannel(channelId) {
    this.activeChannelIds.delete(channelId);
    this.resetLiveSession(channelId, { clearHandle: true });
    this.clearHistoryIdleTimer(channelId);
    this.liveChannelStates.delete(channelId);
    this.clearChannelHistory(channelId);
  }

  getLiveChannelState(channelId) {
    let state = this.liveChannelStates.get(channelId);
    if (!state) {
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
        voiceMode: false,
      };
      this.liveChannelStates.set(channelId, state);
    }
    return state;
  }

  enqueueChannelResponse(channelId, task) {
    const state = this.getLiveChannelState(channelId);
    state.responseQueue = state.responseQueue.catch(() => {}).then(task);
    return state.responseQueue;
  }

  clearLiveIdleTimer(channelId) {
    const state = this.getLiveChannelState(channelId);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  clearHistoryIdleTimer(channelId) {
    const state = this.getLiveChannelState(channelId);
    if (state.historyIdleTimer) {
      clearTimeout(state.historyIdleTimer);
      state.historyIdleTimer = null;
    }
  }

  clearChannelHistory(channelId) {
    this.conversationHistories.delete(channelId);
    for (const key of this.perUserHistories.keys()) {
      if (key.startsWith(`${channelId}:`)) {
        this.perUserHistories.delete(key);
      }
    }
  }

  resetHistoryIdleTimer(channelId) {
    const state = this.getLiveChannelState(channelId);
    this.clearHistoryIdleTimer(channelId);

    state.historyIdleTimer = setTimeout(() => {
      state.historyIdleTimer = null;
      const minutes = Math.round(CONFIG.HISTORY_IDLE_TIMEOUT_MS / 60000);
      this.clearChannelHistory(channelId);
      this.liveChannelStates.delete(channelId);
      console.warn(`🧠 [HISTORY] Historial borrado por inactividad en canal ${channelId} (${minutes} min sin mensajes).`);
    }, CONFIG.HISTORY_IDLE_TIMEOUT_MS);
  }

  resetLiveIdleTimer(channelId) {
    const state = this.getLiveChannelState(channelId);
    this.clearLiveIdleTimer(channelId);

    if (!state.session) return;

    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (!state.session) return;
      const minutes = Math.round(CONFIG.LIVE_IDLE_TIMEOUT_MS / 60000);
      console.warn(`⏳ [LIVE] Sesion cerrada por inactividad en canal ${channelId} (${minutes} min sin mensajes).`);
      this.resetLiveSession(channelId, { clearHandle: true });
    }, CONFIG.LIVE_IDLE_TIMEOUT_MS);
  }

  resetLiveSession(channelId, options = {}) {
    const state = this.getLiveChannelState(channelId);
    const { clearHandle = false } = options;

    if (state.session) {
      try {
        state.session.close();
      } catch {}
    }

    state.session = null;
    state.connectPromise = null;
    state.sessionTokenCount = 0;
    state.sessionTurnCount = 0;

    if (clearHandle) {
      state.handle = null;
    }

    this.clearLiveIdleTimer(channelId);
  }

  rejectPendingLiveTurn(channelId, error) {
    const state = this.getLiveChannelState(channelId);
    if (!state.pendingTurn) return;

    const pendingTurn = state.pendingTurn;
    state.pendingTurn = null;
    pendingTurn.reject(error);
  }

  finalizePendingLiveTurn(channelId) {
    const state = this.getLiveChannelState(channelId);
    if (!state.pendingTurn) return;

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

  appendToHistory(channelId, role, text, userId, authorName) {
    if (!channelId || !text) return;
    const raw = String(text).trim();
    const entry = {
      role,
      text: raw,
      channelId,
      userId: role === 'user' && userId ? userId : null,
      authorName: role === 'user' ? (authorName || 'Usuario') : 'Layla',
    };

    const prev = this.conversationHistories.get(channelId) || [];
    prev.push(entry);
    if (prev.length > CONFIG.HISTORY_SIZE) {
      this.conversationHistories.set(channelId, prev.slice(-CONFIG.HISTORY_SIZE));
    } else {
      this.conversationHistories.set(channelId, prev);
    }

    if (userId) {
      const key = `${channelId}:${userId}`;
      const prevUser = this.perUserHistories.get(key) || [];
      prevUser.push(entry);
      if (prevUser.length > CONFIG.HISTORY_SIZE) {
        this.perUserHistories.set(key, prevUser.slice(-CONFIG.HISTORY_SIZE));
      } else {
        this.perUserHistories.set(key, prevUser);
      }
    }
  }

  formatHistoryEntry(entry) {
    if (!entry?.text) return '';
    if (entry.role === 'user') {
      const authorLabel = entry.authorName || entry.userId || 'Usuario';
      return `Usuario [${authorLabel}]: ${entry.text}`;
    }
    return `Layla: ${entry.text}`;
  }

  buildIdentityInstruction() {
    return [
      'Reglas de identidad y memoria:',
      '- Cada nombre en el historial corresponde a una persona distinta.',
      '- No atribuyas recuerdos, instrucciones o datos de un usuario a otro por compartir canal.',
      '- Si ves `Usuario [Nombre]: ...`, ese contenido pertenece solo a ese autor salvo que el mensaje diga explicitamente que aplica a otros.',
      '- Si no estas segura de quien dijo algo o a quien pertenece una preferencia, preguntalo antes de asumirlo.',
      '- Responde al turno actual tomando en cuenta el nombre del autor del mensaje actual.',
    ].join('\n');
  }

  buildHistoryContents(channelId, userId) {
    const channelHist = this.conversationHistories.get(channelId) || [];
    const userHist = userId ? (this.perUserHistories.get(`${channelId}:${userId}`) || []) : [];
    const recentUserHist = userHist.slice(-4);
    const recentChannelHist = channelHist.slice(-2);

    const merged = [];
    const seen = new Set();

    for (const m of [...recentUserHist, ...recentChannelHist]) {
      const key = `${m.role}::${m.userId || ''}::${m.authorName || ''}::${m.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = this.formatHistoryEntry(m);
      if (line) merged.push(line);
    }

    return merged;
  }

  buildLiveSessionSummary(channelId) {
    const historyContents = this.buildHistoryContents(channelId);
    if (!historyContents.length) return '';

    return [
      'Contexto reciente de la conversacion para continuar sin perder memoria:',
      ...historyContents,
      'Usa este resumen como memoria base. No lo repitas ni lo expliques salvo que te lo pidan.',
    ].join('\n');
  }

  setVoiceMode(channelId, enabled) {
    const state = this.getLiveChannelState(channelId);
    state.voiceMode = !!enabled;
  }

  buildLiveSystemInstruction(channelId) {
    const state = this.getLiveChannelState(channelId);
    const identityInstruction = this.buildIdentityInstruction();
    const historySummary = this.buildLiveSessionSummary(channelId);
    
    let voiceAddon = '';
    if (state.voiceMode) {
      voiceAddon = state.isGroupCall ? CONFIG.VOICE_SYSTEM_INSTRUCTION_GROUP : CONFIG.VOICE_SYSTEM_INSTRUCTION_SOLO;
    }

    const parts = [CONFIG.LIVE_SYSTEM_INSTRUCTION];
    if (voiceAddon) parts.push(voiceAddon);
    parts.push(identityInstruction);
    if (historySummary) parts.push(historySummary);

    return parts.join('\n\n');
  }

  buildUserTurnText(authorName, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return '';
    return authorName ? `Usuario actual [${authorName}]: ${cleanText}` : cleanText;
  }
  
  clearAllState() {
    for (const channelId of this.liveChannelStates.keys()) {
      try {
        this.resetLiveSession(channelId);
        this.clearHistoryIdleTimer(channelId);
      } catch (e) { }
    }
    this.liveDisabledReason = null;
    this.liveChannelStates.clear();
    this.conversationHistories.clear();
    this.perUserHistories.clear();
  }
}

// Exportamos un singleton para mantener un único estado de la app
export default new ChannelStateManager();
