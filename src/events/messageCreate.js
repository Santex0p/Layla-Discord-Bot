import stateManager from '../models/ChannelStateManager.js';
import aiService from '../services/AiService.js';
import audioService from '../services/AudioService.js';
import {
  resolveMentionsInContent,
  isQuotaError,
  isMissingAudioError,
  isInterruptedTurnError,
  shouldDisableLive,
  isPcmMimeType
} from '../utils/helpers.js';
import { CONFIG } from '../config/constants.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  name: 'messageCreate',
  once: false,
  async execute(message) {
    if (message.author.bot) return; // Ignorar bots
    if (!message.guild) return; // Solo responder en servidores

    const channelId = message.channel.id;
    if (!stateManager.isChannelActive(channelId)) {
      return; // Ignorar si el canal no está activado
    }

    await message.channel.sendTyping();

    try {
      const incomingText = resolveMentionsInContent(message) || message.content;
      const authorName = message.member?.displayName || message.author.username;

      // Guardar el mensaje del usuario en el historial
      stateManager.appendToHistory(channelId, 'user', incomingText, message.author.id, authorName);
      stateManager.resetHistoryIdleTimer(channelId);

      await stateManager.enqueueChannelResponse(channelId, async () => {
        let voiceResponse = null;
        let needsTextFallback = false;

        // ------------------------------------------------------------------
        // PASO 1: VERIFICAR SI PODEMOS USAR LIVE API
        // ------------------------------------------------------------------
        if (stateManager.getLiveDisabledReason() || aiService.isLiveQuotaBackoffActive(channelId)) {
          console.warn(`🚫 [FALLBACK] Live inactivo (Razón: ${stateManager.getLiveDisabledReason() || 'Cuota excedida'}). Usando fallback de texto.`);
          needsTextFallback = true;
        } else {
          // ------------------------------------------------------------------
          // PASO 2: INTENTAR SESIÓN LIVE
          // ------------------------------------------------------------------
          try {
            voiceResponse = await aiService.enqueueLiveTurn(incomingText, channelId, message.author.id, authorName);
          } catch (error) {
            const isQuota = isQuotaError(error);
            const isMissingAudio = isMissingAudioError(error);
            const isInterrupted = isInterruptedTurnError(error);

            if (shouldDisableLive(error)) {
              if (!stateManager.getLiveDisabledReason()) stateManager.setLiveDisabledReason(error.message);
            }
            if (isQuota) aiService.armLiveQuotaBackoff(channelId, error);

            const label = isQuota ? '🚫 [LIVE] Cuota excedida'
              : isMissingAudio ? '🔇 [LIVE] Turno sin audio'
                : isInterrupted ? '⚡ [LIVE] Sesión interrumpida'
                  : '⚠️ [LIVE] Error inesperado';

            console.warn(`${label}: ${error.message}. Pasando a fallback de texto...`);

            stateManager.resetLiveSession(channelId, { clearHandle: true });
            needsTextFallback = true;
          }
        }

        // ------------------------------------------------------------------
        // PASO 3: EJECUTAR FALLBACK DE TEXTO SI LIVE FALLÓ
        // ------------------------------------------------------------------
        if (needsTextFallback) {
          let replyText = '';
          try {
            const textResult = await aiService.generateTextReply(incomingText, channelId, message.author.id);
            replyText = textResult.transcript;
          } catch (textError) {
            console.warn('[FALLBACK] Error con Gemini Texto:', textError.message);
            // PASO 4 (PLAN C): FALLBACK A OLLAMA
            try {
              const ollamaResult = await aiService.generateOllamaReply(incomingText, channelId, message.author.id);
              replyText = ollamaResult.transcript;
              console.log('✅ [FALLBACK] Ollama al rescate.');
            } catch (ollamaError) {
              console.error('❌ [FALLBACK] Ollama tampoco respondió:', ollamaError.message);
              replyText = '¡Uy! Me quedé sin palabras (ni texto). Dame un segundito... hehe';
            }
          }

          await message.reply(replyText).catch(() => { });
          if (replyText) stateManager.appendToHistory(channelId, 'assistant', replyText, message.author.id);

          // Reconectar
          if (!stateManager.getLiveDisabledReason()) {
            aiService.ensureLiveSession(channelId, message.author.id).catch((e) =>
              console.warn(`⚠️ [LIVE] Reconexión en segundo plano falló: ${e.message}`)
            );
          }
          return;
        }

        // ------------------------------------------------------------------
        // PASO 4: PROCESAR ÉXITO DE LIVE API (AUDIO)
        // ------------------------------------------------------------------
        const { audioBuffer, mimeType, transcript, usageMetadata } = voiceResponse;
        const liveState = stateManager.getLiveChannelState(channelId);

        if (audioBuffer?.length) {
          if (!isPcmMimeType(mimeType)) {
            console.warn(`⚠️ [LIVE] MIME inesperado para MP3: ${mimeType}. Se intentará codificar igual.`);
          }

          const attachmentBuffer = await audioService.pcm16ToMp3Buffer(audioBuffer);
          const fileId = `layla_${Date.now()}`;
          const audiosDir = '/app/layla-media/audios';

          // Asegurar que el directorio exista (en docker suele existir, pero por seguridad)
          try { await fs.mkdir(audiosDir, { recursive: true }); } catch (e) { }

          const mp3Path = path.join(audiosDir, `${fileId}.mp3`);
          const mp4Path = path.join(audiosDir, `${fileId}.mp4`);

          await fs.writeFile(mp3Path, attachmentBuffer);

          try {
            await audioService.createMp4WithStaticImage(mp3Path, mp4Path);
          } catch (e) {
            console.error('⚠️ [FFMPEG] Falló la creación del MP4:', e);
          }

          const audioUrl = `https://files.universan.fun/${fileId}.mp3`;
          await message.reply(audioUrl);
        } else {
          await message.reply(transcript || 'No pude hablar, pero aquí va mi respuesta en texto.').catch(() => { });
        }

        // ------------------------------------------------------------------
        // PASO 5: GESTIÓN DE MÉTRICAS, HISTORIAL Y ROTACIÓN
        // ------------------------------------------------------------------
        if (usageMetadata?.totalTokenCount) {
          liveState.sessionTokenCount = Number(usageMetadata.totalTokenCount) || 0;
          liveState.sessionTurnCount += 1;
          console.log(`ℹ️ [LIVE] Canal ${channelId} | Tokens acumulados: ${liveState.sessionTokenCount}/${CONFIG.LIVE_SESSION_MAX_TOKENS} | Turnos: ${liveState.sessionTurnCount}/${CONFIG.LIVE_SESSION_MAX_TURNS}`);
        }

        if (transcript) {
          stateManager.appendToHistory(channelId, 'assistant', transcript, message.author.id);
        } else {
          stateManager.appendToHistory(channelId, 'assistant', 'voz de Layla (sin transcripción)', message.author.id);
        }

        const tokensDone = liveState.sessionTokenCount >= CONFIG.LIVE_SESSION_MAX_TOKENS;
        const turnsDone = liveState.sessionTurnCount >= CONFIG.LIVE_SESSION_MAX_TURNS;

        if (tokensDone || turnsDone) {
          const reason = tokensDone
            ? `tokens acumulados ${liveState.sessionTokenCount}/${CONFIG.LIVE_SESSION_MAX_TOKENS}`
            : `turnos ${liveState.sessionTurnCount}/${CONFIG.LIVE_SESSION_MAX_TURNS}`;
          console.warn(`⚠️ [LIVE] Rotando sesión del canal ${channelId} (${reason}).`);
          stateManager.resetLiveSession(channelId, { clearHandle: true });
        } else {
          stateManager.resetLiveIdleTimer(channelId);
        }
      });
    } catch (error) {
      console.error('[ERROR GENERAL MESSAGE CREATE]:', error);
      await message.reply('¡Uy! Mi sistema falló de forma inesperada. ¡Lo siento!').catch(() => { });
    }
  }
};
