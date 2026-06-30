import stateManager from '../models/ChannelStateManager.js';
import aiService from '../services/AiService.js';
import audioService from '../services/AudioService.js';
import memoryManager from '../models/MemoryManager.js';
import guildPromptManager from '../models/GuildPromptManager.js';
import globalSettingsManager from '../models/GlobalSettingsManager.js';
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
    let isTriggerActivated = false;
    let injectedContext = '';

    const isReplyToLayla = message.reference && message.reference.messageId;
    const isRawMention = message.mentions.users.has(message.client.user.id) &&
      (!isReplyToLayla || message.content.includes(`<@${message.client.user.id}>`) || message.content.includes(`<@!${message.client.user.id}>`));

    // ==================== HISTORIAL Y MEMORIA GLOBAL ====================
    // Parsear el texto base (resolviendo menciones y replies) para el historial general
    let cleanText = resolveMentionsInContent(message) || message.content;
    const authorName = message.member?.displayName || message.author.username;
    const guildId = message.guild.id;
    const userId = message.author.id;

    if (message.reference && message.reference.messageId) {
      try {
        const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedMsg && repliedMsg.content) {
          const repliedAuthor = repliedMsg.member?.displayName || repliedMsg.author.username;
          if (repliedMsg.author.id !== message.client.user.id) {
            cleanText = `[Respondiendo a ${repliedAuthor}: "${repliedMsg.content}"] ` + cleanText;
          } else {
            cleanText = `[Respondiéndote a ti: "${repliedMsg.content}"] ` + cleanText;
          }
        }
      } catch (e) {
        console.error("No se pudo obtener el contexto del mensaje referenciado:", e.message);
      }
    }

    // Guardar el mensaje en el historial (Layla recuerda de qué hablaron, aunque no responda)
    stateManager.appendToHistory(channelId, 'user', cleanText, userId, authorName);
    stateManager.resetHistoryIdleTimer(channelId);

    // Banderas y función de Extracción automática de memorias (cada 15 mensajes)
    // Solo extrae si Layla está activada en el canal (talk) y NO en modo Ollama estricto
    let shouldExtract = false;
    if (stateManager.isChannelActive(channelId) && !CONFIG.OLLAMA_ONLY) {
      shouldExtract = memoryManager.incrementMessageCount(guildId, userId);
    }
    const executeMemoryExtraction = () => {
      const historyContents = stateManager.buildExtractionHistory(channelId, userId);
      if (historyContents.length > 0) {
        const historyBlock = historyContents.join('\n');
        
        // Construir lista de relaciones protegidas para blindar la extracción
        const allRels = memoryManager.getAllRelationships(guildId);
        const protectedRelationships = Object.entries(allRels)
          .map(([uid, rel]) => `- ${rel.name}: ${rel.relationship}`)
          .join('\n');

        // Ejecutar en segundo plano
        aiService.extractFactsFromHistory(historyBlock, authorName, protectedRelationships)
          .then(facts => memoryManager.processExtractedFacts(guildId, userId, facts))
          .catch(err => console.warn('[MEMORIA] Error en extracción automática:', err.message));
      }
    };

    // ==================== EVALUAR RESPUESTA ====================
    if (!stateManager.isChannelActive(channelId)) {
      let shouldRespond = false;

      // 1. Verificar Mención Directa (Ignorando las menciones que provienen de un Reply)
      const respondOnMention = globalSettingsManager.get('RESPOND_ON_MENTION');

      if (isRawMention && respondOnMention) {
        shouldRespond = true;
      }

      // 2. Verificar Respuesta a Layla (Reply Setting)
      let isReplyToLaylaValid = false;
      if (!shouldRespond && isReplyToLayla && guildPromptManager.getReplySetting(guildId)) {
        try {
          if (message.mentions.repliedUser && message.mentions.repliedUser.id === message.client.user.id) {
            isReplyToLaylaValid = true;
          }
        } catch (e) { }
      }

      // 3. Verificar Palabras Detonantes (Triggers)
      if (!shouldRespond && !isReplyToLaylaValid) {
        const triggers = guildPromptManager.getTriggers(guildId);
        if (triggers && triggers.length > 0) {
          for (const t of triggers) {
            if (!t.word) continue;
            // Validar canal
            if (t.channels && t.channels.length > 0 && !t.channels.includes(channelId)) {
              continue; // Canal no permitido para este detonante
            }

            // Extraer las palabras separadas por coma, limpiarlas de espacios y escapar caracteres
            const words = t.word.split(',').map(w => w.trim()).filter(Boolean);
            if (words.length === 0) continue;

            const escapedWords = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

            const regex = new RegExp(`(?:^|\\s)(?:${escapedWords})(?:$|\\s|\\W)`, 'i');
            if (regex.test(message.content)) {
              console.log(`⚡ [TRIGGER] Detonante activado en canal ${channelId} ('${t.word}')`);
              shouldRespond = true;
              isTriggerActivated = true;
              injectedContext = `\n\n(Contexto interno: El usuario usó la palabra detonante "${t.word}". Por favor, tu respuesta a este mensaje debe ser única y exclusivamente cumplir con esta instrucción: "${t.meaning}". No añadas ningún comentario extra.)`;
              break;
            }
          }
        }
      }

      // 4. Evaluar Oportunidades si es un Reply sin Mención Directa
      if (isReplyToLaylaValid && !shouldRespond && !isTriggerActivated) {
        if (stateManager.consumeTextOpportunity(channelId)) {
          shouldRespond = true;
        } else {
          // Sin oportunidades: reaccionar con un emoji random y abortar
          const emojis = ['👀', '✨', '💤', '🌸', '🎶', '🤷‍♀️', '💖', '😜', '🔥'];
          const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
          await message.react(randomEmoji).catch(() => { });
          if (shouldExtract) executeMemoryExtraction();
          return;
        }
      }

      if (!shouldRespond) {
        if (shouldExtract) executeMemoryExtraction();
        return; // Ignorar por completo si no hay razón para responder
      }

      // 5. Otorgar oportunidades si fue un detonante o mención directa
      if (isTriggerActivated || isRawMention) {
        stateManager.setTextOpportunities(channelId, 1);
      }
    }

    await message.channel.sendTyping();

    try {
      // Usar el texto limpio como base para la inyección de contexto
      let incomingText = cleanText;

      // PROXY VISUAL: Procesar imágenes si existen (Solo si no estamos en Modo Ollama estricto)
      if (message.attachments.size > 0 && !CONFIG.OLLAMA_ONLY) {
        for (const attachment of message.attachments.values()) {
          if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            // Pedimos a Discord una miniatura WebP de max 800px para ahorrar ~95% de RAM y cuota
            const optimizedUrl = attachment.url + '?format=webp&width=800';
            const description = await aiService.describeImage(optimizedUrl);
            incomingText += ` [Envió una imagen de: ${description}]`;
          }
        }
        incomingText = incomingText.trim();
      } else if (message.attachments.size > 0 && CONFIG.OLLAMA_ONLY) {
        incomingText += ` [Adjuntó una imagen, pero no puedo verla en este momento]`;
        incomingText = incomingText.trim();
      }

      if (injectedContext) {
        incomingText += injectedContext;
      }

      // ==================== SISTEMA DE MEMORIA ====================
      // Capa 1: Relaciones (SIEMPRE se inyectan, prioridad alta)
      const relationshipContext = memoryManager.buildRelationshipContext(guildId, userId);
      if (relationshipContext) {
        incomingText = `${relationshipContext}\n${incomingText}`;
      }

      // Capa 2: Memorias vectoriales (solo si son relevantes al tema y NO estamos en modo Ollama estricto)
      if (!CONFIG.OLLAMA_ONLY) {
        try {
          const relevantMemories = await memoryManager.getRelevantMemories(guildId, userId, message.content);
          const memoryContext = memoryManager.buildMemoryContext(relevantMemories);
          if (memoryContext) {
            incomingText = `${memoryContext}\n${incomingText}`;
          }
        } catch (e) {
          // Si falla el embedding, no pasa nada. Layla responde sin memorias.
        }
      }

      // El flujo ahora siempre pasará por el sistema de sesiones (Live API)
      // Incluso si el canal está inactivo globalmente, las menciones y detonantes
      // abrirán el túnel temporalmente para procesar el mensaje con el contexto completo.

      await stateManager.enqueueChannelResponse(channelId, async () => {
        let voiceResponse = null;
        let needsTextFallback = false;

        // ------------------------------------------------------------------
        // PASO 1: VERIFICAR SI PODEMOS USAR LIVE API
        // ------------------------------------------------------------------
        if (CONFIG.OLLAMA_ONLY) {
          needsTextFallback = true;
        } else if (stateManager.getLiveDisabledReason() || aiService.isLiveQuotaBackoffActive(channelId)) {
          console.warn(`🚫 [FALLBACK] Live inactivo (Razón: ${stateManager.getLiveDisabledReason() || 'Cuota excedida'}). Usando fallback de texto.`);
          needsTextFallback = true;
        } else if (!stateManager.isChannelActive(channelId) && !isRawMention) {
          // Si el canal está inactivo y NO es una mención explícita (@Layla), usamos el modelo de texto.
          // Esto maneja Triggers y Replies sin forzar el modelo de audio.
          // Las menciones explícitas (@Layla) irán al modelo Live para generar una nota de voz.
          needsTextFallback = true;
        } else {
          // ------------------------------------------------------------------
          // PASO 2: INTENTAR SESIÓN LIVE
          // ------------------------------------------------------------------
          try {
            voiceResponse = await aiService.enqueueLiveTurn(incomingText, channelId, message.author.id, authorName, message.guild?.id);
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

          if (!CONFIG.OLLAMA_ONLY) {
            try {
              const textResult = await aiService.generateTextReply(incomingText, channelId, message.author.id, message.guild?.id);
              replyText = textResult.transcript;
            } catch (textError) {
              console.warn('[FALLBACK] Error con Gemini Texto:', textError.message);
              // PASO 4 (PLAN C): FALLBACK A OLLAMA
              try {
                const ollamaResult = await aiService.generateOllamaReply(incomingText, channelId, message.author.id, message.guild?.id);
                replyText = ollamaResult.transcript;
                console.log('✅ [FALLBACK] Ollama al rescate.');
              } catch (ollamaError) {
                console.error('❌ [FALLBACK] Ollama tampoco respondió:', ollamaError.message);
                replyText = '¡Uy! Me quedé sin palabras (ni texto). Dame un segundito... hehe';
              }
            }
          } else {
            // MODO OLLAMA ESTRICTO
            try {
              const ollamaResult = await aiService.generateOllamaReply(incomingText, channelId, message.author.id, message.guild?.id);
              replyText = ollamaResult.transcript;
            } catch (ollamaError) {
              replyText = '¡Uy! El servidor local de Ollama falló. ¿Está encendido?';
            }
          }

          await message.reply(replyText).catch(() => { });
          if (replyText) stateManager.appendToHistory(channelId, 'assistant', replyText, message.author.id);

          // Reconectar
          if (!stateManager.getLiveDisabledReason() && !CONFIG.OLLAMA_ONLY) {
            aiService.ensureLiveSession(channelId, message.author.id, message.guild?.id).catch((e) =>
              console.warn(`⚠️ [LIVE] Reconexión en segundo plano falló: ${e.message}`)
            );
          }
          return;
        }

        // ------------------------------------------------------------------
        // PASO 4: PROCESAR ÉXITO DE LIVE API
        // ------------------------------------------------------------------
        const { audioBuffer, mimeType, transcript, usageMetadata } = voiceResponse;
        const liveState = stateManager.getLiveChannelState(channelId);

        // Si el canal SÍ está activo (Autotalk), Layla responde con Notas de Voz (Audio URL)
        if (audioBuffer?.length) {
          if (!isPcmMimeType(mimeType)) {
            console.warn(`⚠️ [LIVE] MIME inesperado para MP3: ${mimeType}. Se intentará codificar igual.`);
          }

          const attachmentBuffer = await audioService.pcm16ToMp3Buffer(audioBuffer);
          const fileId = `layla_${Date.now()}`;
          const audiosDir = '/app/data/audios';

          // Asegurar que el directorio exista
          try { await fs.mkdir(audiosDir, { recursive: true }); } catch (e) { }

          const mp3Path = path.join(audiosDir, `${fileId}.mp3`);
          const mp4Path = path.join(audiosDir, `${fileId}.mp4`);

          await fs.writeFile(mp3Path, attachmentBuffer);

          try {
            await audioService.createMp4WithStaticImage(mp3Path, mp4Path);
          } catch (e) {
            console.error('⚠️ [FFMPEG] Falló la creación del MP4:', e);
          }

          if (!CONFIG.MEDIA_DOMAIN) {
            console.error('⚠️ [ENV] Error: No se ha configurado la variable MEDIA_DOMAIN en el archivo .env.');
            await message.reply('Oops, mi administrador no ha configurado mi dominio de archivos, así que no puedo enviarte el audio.');
          } else {
            const audioUrl = `https://${CONFIG.MEDIA_DOMAIN}/${fileId}.mp3`;
            await message.reply(audioUrl);
          }
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

        // Al finalizar de responder y liberar recursos, procedemos con la memoria silenciosamente
        if (shouldExtract) {
          executeMemoryExtraction();
        }
      });
    } catch (error) {
      console.error('[ERROR GENERAL MESSAGE CREATE]:', error.stack || error);
      await message.reply('¡Uy! Mi sistema falló de forma inesperada. ¡Lo siento!').catch(() => { });
    }
  }
};
