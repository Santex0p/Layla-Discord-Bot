import { PassThrough } from 'stream';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus
} from '@discordjs/voice';
import prism from 'prism-media';
import aiService from './AiService.js';
import stateManager from '../models/ChannelStateManager.js';

import path from 'path';

let vosk = null;
let voskModel = null;
import('vosk-koffi').then(v => {
  vosk = v.default || v;
  vosk.setLogLevel(-1);
  try {
    const modelPath = path.join(process.cwd(), 'vosk-model', 'vosk-model-small-es-0.42');
    voskModel = new vosk.Model(modelPath);
    console.log("✅ [VOICE] Motor Vosk-Koffi (Alexa Mode) cargado exitosamente.");
  } catch (e) {
    console.log("⚠️ [VOICE] Carpeta vosk-model no encontrada o ruta inválida. Vosk inactivo.");
  }
}).catch(e => {
  console.error("❌ [VOICE] Librería vosk-koffi no encontrada. Asegúrate de instalarla.");
});

class VoiceChannelService {
  constructor() {
    this.players = new Map(); // channelId → sessionData
  }

  // ============================================================
  //  /call — Unirse al canal de voz
  // ============================================================
  async join(interaction) {
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: 'Debes estar en un canal de voz primero para usar este comando.',
        ephemeral: true
      });
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    // Logging de red (minimo)
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE-NETWORK] ${oldState.status} -> ${newState.status}`);
      if (newState.status === 'connecting' && connection.networking) {
        connection.networking.on('stateChange', (oS, nS) => {
          console.log(`[NET-INTERNAL] ${oS.code} -> ${nS.code}`);
        });
      }
    });

    // Limpieza de sesiones huérfanas
    if (this.players.has(voiceChannel.id)) {
      console.log(`[VOICE] Limpiando sesion huerfana...`);
      this._cleanupSession(voiceChannel.id);
    }

    // Setup del reproductor de audio
    const player = createAudioPlayer();
    connection.subscribe(player);

    const sessionData = {
      player,
      connection,
      guildId: voiceChannel.guild.id,
      isPlaying: false,
      upsampleLeftover: Buffer.alloc(0),
      audioStream: null,
      // Estado multi-usuario
      userBuffers: new Map(),       // userId → { buffer, leftover, lastAudioTime }
      activeListeners: new Set(),   // userIds con listener activo
      mixerInterval: null,
      lastMixedAudioTime: Date.now(),
      silenceLogCounter: 0,
      session: null,                // Referencia a la sesion Gemini Live
      // Máquina de estados: 'listening' | 'responding' | 'cooldown'
      listeningState: 'listening',
      cooldownTimer: null,
      lastReminderTime: 0,
      recycleInterval: null,

      // Alexa Mode & Context
      alexaMode: false,
      alexaState: 'AWAKE',
      alexaWakeTimer: null,
      voskRecognizer: null,
      transcriptHistory: [],
      currentPartial: ''
    };

    if (voskModel) {
      sessionData.voskRecognizer = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 });
    }

    this.players.set(voiceChannel.id, sessionData);

    // Recrear el AudioResource cuando el player quede inactivo (entre turnos de Gemini)
    player.on(AudioPlayerStatus.Idle, () => {
      sessionData.isPlaying = false;
      if (sessionData.audioStream) {
        sessionData.audioStream.destroy();
        sessionData.audioStream = null;
      }
    });

    // Esperar a que la conexion UDP este lista
    import('@discordjs/voice').then(({ entersState, VoiceConnectionStatus }) => {
      entersState(connection, VoiceConnectionStatus.Ready, 30000)
        .then(() => console.log('✅ [VOICE] Conexion UDP/WebSocket establecida (Ready).'))
        .catch((err) => console.error('❌ [VOICE] Error conectando a Discord:', err.message || err));
    });

    // Conectar a Gemini Live API
    try {
      // Activar modo voz (añade instrucciones de wake word al prompt)
      stateManager.setVoiceMode(voiceChannel.id, true);

      const session = await aiService.ensureLiveSession(voiceChannel.id, member.user.id);
      sessionData.session = session;

      console.log(`✅ [VOICE] Unida a canal de voz ${voiceChannel.id}`);

      // Configurar escucha multi-usuario + mixer central
      this._setupMultiUserListening(connection, voiceChannel.id);

      // Suscribirse a TODOS los usuarios humanos ya en el canal
      const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
      for (const [memberId] of humanMembers) {
        this._startListeningToUser(connection, memberId, voiceChannel.id);
      }
      console.log(`🎧 [VOICE] Escuchando a ${humanMembers.size} usuario(s) en el canal.`);

      await interaction.reply('¡Me uní a la llamada! Digan **"Layla"** para hablar conmigo 🎤');
    } catch (err) {
      console.error('Error al conectar con Gemini para voz:', err);
      interaction.followUp('Ocurrió un error al intentar conectarme con mi cerebro.');
    }
  }

  // ============================================================
  //  /endcall — Salir del canal de voz
  // ============================================================
  leave(interaction) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'No estás en un canal de voz.', ephemeral: true });
    }

    const connection = getVoiceConnection(interaction.guildId);

    if (connection) {
      this._cleanupSession(voiceChannel.id);
      stateManager.setVoiceMode(voiceChannel.id, false);
      connection.destroy();
      return interaction.reply('Desconectada de la llamada de voz.');
    } else {
      return interaction.reply({ content: 'No estoy en ningún canal de voz en este servidor.', ephemeral: true });
    }
  }

  // ============================================================
  //  Eventos de voiceStateUpdate (auto-disconnect + saludos)
  // ============================================================
  handleVoiceStateUpdate(oldState, newState, client) {
    // --- Alguien SALIÓ de un canal donde estamos activas ---
    if (oldState.channelId && this.players.has(oldState.channelId) &&
      oldState.channelId !== newState.channelId &&
      oldState.member?.id !== client.user.id) {

      const channel = oldState.channel;
      if (channel) {
        const humanMembers = channel.members.filter(m => !m.user.bot).size;
        if (humanMembers === 0) {
          console.log(`[VOICE] Canal vacío. Auto-desconectando de ${oldState.channelId}...`);
          this._autoDisconnect(oldState.channelId, oldState.guild.id);
        }
      }
    }

    // --- Alguien ENTRÓ a un canal donde estamos activas ---
    if (newState.channelId && this.players.has(newState.channelId) &&
      oldState.channelId !== newState.channelId &&
      !newState.member?.user?.bot) {

      const sessionData = this.players.get(newState.channelId);
      if (sessionData?.session) {
        const displayName = newState.member.displayName || newState.member.user.username;
        console.log(`[VOICE] 👋 ${displayName} se unió al canal. Enviando saludo...`);

        // Pedirle a Gemini que salude al nuevo usuario
        try {
          sessionData.session.sendClientContent({
            turns: [{
              role: 'user',
              parts: [{ text: `Layla, el usuario ${displayName} acaba de unirse a la llamada. Salúdalo brevemente.` }]
            }],
            turnComplete: true
          });
        } catch (e) {
          console.error('[VOICE] Error al enviar saludo:', e.message);
        }

        // Auto-suscribirse al audio del nuevo usuario
        this._startListeningToUser(sessionData.connection, newState.member.id, newState.channelId);
        this._updateHumanCount(newState.channelId);
      }
    }
  }

  // ============================================================
  //  Lógica de Contador de Humanos y Modo Dinámico
  // ============================================================
  _updateHumanCount(channelId) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    const humanCount = sessionData.activeListeners.size;
    console.log(`[VOICE-MODE] Revisando humanos: ${humanCount}`);

    const state = stateManager.getLiveChannelState(channelId);
    
    if (humanCount >= 2 && !sessionData.alexaMode) {
      console.log(`[VOICE-MODE] 👥 2+ humanos detectados. Activando Sistema ALEXA (En Silencio).`);
      sessionData.alexaMode = true;
      state.isGroupCall = true;
      this._sleepAlexa(channelId, true);
    } else if (humanCount === 1 && sessionData.alexaMode) {
      console.log(`[VOICE-MODE] 👤 1 humano detectado. Activando Micrófono Abierto 100%.`);
      sessionData.alexaMode = false;
      state.isGroupCall = false;
      this._wakeUpAlexa(channelId, true);
    } else if (humanCount === 1 && !sessionData.alexaMode && state.isGroupCall === undefined) {
      // Setup inicial para 1 humano
      state.isGroupCall = false;
    } else if (humanCount >= 2 && sessionData.alexaMode && state.isGroupCall === undefined) {
      // Setup inicial para grupo
      state.isGroupCall = true;
    }
  }

  async _wakeUpAlexa(channelId, silent = false) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    sessionData.alexaState = 'AWAKE';
    if (sessionData.voskRecognizer) sessionData.voskRecognizer.reset();

    // Conectar Gemini
    if (!sessionData.session) {
      try {
        const aiService = (await import('./AiService.js')).default;
        sessionData.session = await aiService.ensureLiveSession(channelId);
      } catch (e) {
        console.error("Error reconectando Gemini al despertar:", e);
      }
    }

    if (sessionData.session) {
      if (!silent && sessionData.alexaMode) {
        console.log(`[VOICE-MODE] 🌟 Layla ha sido llamada (Wake Word). Despertando por 30s.`);
        const contextStr = sessionData.transcriptHistory.join(' ') + ' ' + sessionData.currentPartial;
        const contextMsg = contextStr.trim().length > 0 ? ` Contexto de lo que hablaban justo antes de llamarte: "${contextStr.trim()}".` : '';
        
        try {
          sessionData.session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `(Layla, te acaban de llamar por tu nombre. Responde confundida preguntando por qué te llaman. ¡Rápido!${contextMsg})` }] }],
            turnComplete: true
          });
        } catch (e) { }
      } else if (!sessionData.alexaMode) {
        // En modo continuo 1 a 1, forzamos la liberación del System Prompt base
        console.log(`[VOICE-MODE] 🗣️ Inyectando liberación de modo pasivo para llamada 1 a 1.`);
        try {
          sessionData.session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `(NOTA DEL SISTEMA: Como estás sola en la llamada con un único humano, IGNORA la regla de permanecer pasiva o esperar tu nombre. A partir de ahora, platica con él libremente de forma continua.)` }] }],
            turnComplete: true
          });
        } catch (e) { }
      }
    }

    // Temporizador de 30s de vigilia
    if (sessionData.alexaMode) {
      this._resetAlexaWakeTimer(channelId);
    } else {
      if (sessionData.alexaWakeTimer) clearTimeout(sessionData.alexaWakeTimer);
    }
  }

  _resetAlexaWakeTimer(channelId) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    if (sessionData.alexaWakeTimer) clearTimeout(sessionData.alexaWakeTimer);
    sessionData.alexaWakeTimer = setTimeout(() => {
      if (sessionData.alexaState === 'AWAKE' && sessionData.alexaMode) {
        this._sleepAlexa(channelId);
      }
    }, 30000);
  }

  async _sleepAlexa(channelId, force = false) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    if (!force && sessionData.session) {
      console.log(`[VOICE-MODE] 💤 30 segundos sin ser llamada. Regresando a dormir...`);
      try {
        sessionData.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `(El tiempo de atención terminó. Despídete diciendo: "Chicos, ya vuelvo, llámenme si me necesitan", de forma breve).` }] }],
          turnComplete: true
        });
      } catch (e) { }

      // Esperar a que hable y luego desconectar
      setTimeout(async () => {
        sessionData.alexaState = 'ASLEEP';
        const stateManager = (await import('../models/ChannelStateManager.js')).default;
        stateManager.resetLiveSession(channelId, { clearHandle: true });
        sessionData.session = null;
        if (sessionData.voskRecognizer) sessionData.voskRecognizer.reset();
      }, 5000);
    } else {
      console.log(`[VOICE-MODE] 💤 Durmiendo a Layla forzosamente...`);
      sessionData.alexaState = 'ASLEEP';
      const stateManager = (await import('../models/ChannelStateManager.js')).default;
      stateManager.resetLiveSession(channelId, { clearHandle: true });
      sessionData.session = null;
      if (sessionData.voskRecognizer) sessionData.voskRecognizer.reset();
    }
  }

  // ============================================================
  //  Setup: Escucha multi-usuario + Mixer central
  // ============================================================
  _setupMultiUserListening(connection, channelId) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    // Detectar automáticamente cuando CUALQUIER usuario empieza a hablar
    connection.receiver.speaking.on('start', (userId) => {
      if (sessionData.activeListeners.has(userId)) return;

      console.log(`🎧 [VOICE] Nuevo usuario detectado hablando: ${userId}. Suscribiéndose...`);
      this._startListeningToUser(connection, userId, channelId);
    });

    // Mixer central: cada 40ms mezcla el audio de todos y lo envía a Gemini.
    // (Discord envía paquetes nativos cada 20ms. 40ms reduce drásticamente la latencia local).
    const mixerInterval = setInterval(() => {
      this._mixAndSendAudio(channelId);
    }, 40);

    sessionData.mixerInterval = mixerInterval;

    // --- CICLO DE LLAMADA (AMNESIA) ---
    // Cada 5 minutos colgamos y volvemos a marcar para limpiar el contexto,
    // evitando que la cuota explote y protegiendo los límites de tokens.
    sessionData.recycleInterval = setInterval(async () => {
      if (this.players.has(channelId)) {
        try {
          const aiService = (await import('./AiService.js')).default;
          const newSession = await aiService.reconnectLiveSession(channelId);
          const currentSessionData = this.players.get(channelId);
          if (currentSessionData) {
            currentSessionData.session = newSession;
            console.log(`♻️ [VOICE] Ciclo de llamada reiniciado para canal ${channelId}.`);
            
            // Reinyectar contexto en 1 a 1
            if (!currentSessionData.alexaMode) {
              const contextStr = currentSessionData.transcriptHistory.join(' ') + ' ' + currentSessionData.currentPartial;
              if (contextStr.trim().length > 0) {
                try {
                  currentSessionData.session.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text: `(Nota: Tuviste un reinicio técnico de memoria para ahorrar cuota. Justo antes del reinicio, el humano te estaba diciendo esto: "${contextStr.trim()}". Continúa la plática de forma natural, no menciones el reinicio.)` }] }],
                    turnComplete: true
                  });
                } catch (e) {}
              }
            }
          }
        } catch (e) {
          console.error(`❌ [VOICE] Error reciclando sesión:`, e.message);
        }
      }
    }, 5 * 60 * 1000); // 5 minutos
  }

  // ============================================================
  //  Máquina de estados: controla cuándo Layla escucha
  // ============================================================
  setListeningState(channelId, newState) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    const oldState = sessionData.listeningState;
    if (oldState === newState) return;

    sessionData.listeningState = newState;
    console.log(`👂 [VOICE] Estado de escucha: ${oldState} → ${newState}`);

    // Limpiar timer de cooldown anterior si existe
    if (sessionData.cooldownTimer) {
      clearTimeout(sessionData.cooldownTimer);
      sessionData.cooldownTimer = null;
    }

    if (newState === 'cooldown') {
      // Después de 1.5s de cooldown, volver a escuchar
      sessionData.cooldownTimer = setTimeout(() => {
        sessionData.cooldownTimer = null;
        if (this.players.has(channelId)) {
          this.setListeningState(channelId, 'listening');
        }
      }, 1500);
    }
  }

  // ============================================================
  //  Per-user: Capturar y decodificar audio de un usuario
  // ============================================================
  _startListeningToUser(connection, userId, channelId, retryCount = 0) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    // Evitar duplicados
    if (sessionData.activeListeners.has(userId)) return;
    sessionData.activeListeners.add(userId);

    // Inicializar buffer del usuario si no existe
    if (!sessionData.userBuffers.has(userId)) {
      sessionData.userBuffers.set(userId, {
        buffer: Buffer.alloc(0),
        leftover: Buffer.alloc(0),
        lastAudioTime: Date.now()
      });
    }

    console.log(`🎧 [VOICE] Iniciando listener para ${userId} (intento ${retryCount + 1})`);

    try {
      const opusStream = connection.receiver.subscribe(userId);
      const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

      let packetCount = 0;

      opusStream.on('data', (opusPacket) => {
        try {
          const decoded = opusDecoder._decode(opusPacket);
          if (!decoded) return;

          const userData = sessionData.userBuffers.get(userId);
          if (!userData) return;

          userData.lastAudioTime = Date.now();
          packetCount++;

          // Downsample: 48kHz stereo 16bit → 16kHz mono 16bit
          // Cada 12 bytes de entrada (3 frames stereo) → 2 bytes de salida (1 sample mono)
          const fullBuffer = Buffer.concat([userData.leftover, decoded]);
          const remainder = fullBuffer.length % 12;
          const processable = fullBuffer.subarray(0, fullBuffer.length - remainder);
          userData.leftover = fullBuffer.subarray(fullBuffer.length - remainder);

          const outBuffer = Buffer.alloc((processable.length / 12) * 2);
          let outIndex = 0;
          for (let i = 0; i < processable.length; i += 12) {
            outBuffer.writeInt16LE(processable.readInt16LE(i), outIndex);
            outIndex += 2;
          }

          userData.buffer = Buffer.concat([userData.buffer, outBuffer]);
        } catch (e) {
          // Paquete Opus corrupto (rotación de llaves DAVE). Lo ignoramos.
        }
      });

      opusStream.on('error', (err) => {
        console.error(`[VOICE] opusStream error (${userId}):`, err.message);
      });

      opusStream.on('close', () => {
        console.log(`[VOICE] opusStream cerrado para ${userId}`);
        sessionData.activeListeners.delete(userId);
        this._updateHumanCount(channelId);

        // Auto-restart si la sesión sigue activa
        if (this.players.has(channelId) && retryCount < 5) {
          console.log(`[VOICE] Reiniciando listener para ${userId} en 2s (intento ${retryCount + 2}/6)...`);
          setTimeout(() => {
            if (this.players.has(channelId)) {
              this._startListeningToUser(connection, userId, channelId, retryCount + 1);
            }
          }, 2000);
        } else if (retryCount >= 5) {
          console.error(`[VOICE] Se agotaron los reintentos para ${userId}.`);
        }
      });

    } catch (err) {
      console.error(`[VOICE] Error al escuchar a ${userId}:`, err);
      sessionData.activeListeners.delete(userId);
    }
  }

  // ============================================================
  //  Mixer: Mezclar audio de todos los usuarios y enviar a Gemini
  // ============================================================
  _mixAndSendAudio(channelId) {
    const sessionData = this.players.get(channelId);
    if (!sessionData?.session) return;

    const frameSize = 3200; // 100ms a 16kHz mono 16bit

    // Si NO estamos en modo escucha, drenar los buffers para que no se acumule audio viejo
    if (sessionData.listeningState !== 'listening') {
      for (const [userId, userData] of sessionData.userBuffers) {
        userData.buffer = Buffer.alloc(0);
      }
      return;
    }

    let anyoneActive = false;
    const mixedBuffer = Buffer.alloc(frameSize);

    for (const [userId, userData] of sessionData.userBuffers) {
      if (userData.buffer.length >= frameSize) {
        anyoneActive = true;
        const chunk = userData.buffer.subarray(0, frameSize);
        userData.buffer = userData.buffer.subarray(frameSize);

        // Mezcla aditiva con clipping (como sumar ondas en la vida real)
        for (let i = 0; i < frameSize; i += 2) {
          const existing = mixedBuffer.readInt16LE(i);
          const incoming = chunk.readInt16LE(i);
          const sum = Math.max(-32768, Math.min(32767, existing + incoming));
          mixedBuffer.writeInt16LE(sum, i);
        }
      }
    }

    if (anyoneActive) {
      sessionData.lastMixedAudioTime = Date.now();
      sessionData.silenceLogCounter = 0;
      
      // --- PROCESAMIENTO DE TEXTO (VOSK) Y WAKE WORD ---
      if (sessionData.voskRecognizer) {
        let wakeWordDetected = false;
        
        if (sessionData.voskRecognizer.acceptWaveform(mixedBuffer)) {
          const result = sessionData.voskRecognizer.result();
          if (result.text && result.text.length > 0) {
            sessionData.transcriptHistory.push(result.text);
            if (sessionData.transcriptHistory.length > 5) {
              sessionData.transcriptHistory.shift();
            }
          }
          if (result.text.toLowerCase().includes('layla') || result.text.toLowerCase().includes('laila') || result.text.toLowerCase().includes('ley')) {
            wakeWordDetected = true;
          }
          sessionData.currentPartial = '';
        } else {
          const partial = sessionData.voskRecognizer.partialResult();
          if (partial.partial && partial.partial.length > 0) {
            sessionData.currentPartial = partial.partial;
          }
          if (partial.partial.toLowerCase().includes('layla') || partial.partial.toLowerCase().includes('laila') || partial.partial.toLowerCase().includes('ley')) {
            wakeWordDetected = true;
          }
        }
        
        if (wakeWordDetected && sessionData.alexaMode) {
          console.log(`[VOSK] Wake Word detectado localmente!`);
          if (sessionData.alexaState === 'ASLEEP') {
            this._wakeUpAlexa(channelId);
          } else {
            this._resetAlexaWakeTimer(channelId);
          }
          sessionData.voskRecognizer.reset();
        }
      }
      
      // Si está dormida, NO enviamos audio a Gemini. Solo consumió Vosk.
      if (sessionData.alexaMode && sessionData.alexaState === 'ASLEEP') {
        return;
      }

      // Enviar a Gemini si está despierta
      if (!sessionData.session) return;
      try {
        sessionData.session.sendRealtimeInput({
          media: [{ mimeType: 'audio/pcm;rate=16000', data: mixedBuffer.toString('base64') }]
        });
      } catch (e) { }
    } else {
      // VAD: Enviar 2 segundos de silencio tras el último audio, luego parar
      if (!sessionData.session || (sessionData.alexaMode && sessionData.alexaState === 'ASLEEP')) return;
      
      const timeSinceLastAudio = Date.now() - sessionData.lastMixedAudioTime;
      if (timeSinceLastAudio >= 100 && timeSinceLastAudio <= 2000) {
        sessionData.silenceLogCounter++;
        try {
          sessionData.session.sendRealtimeInput({
            media: [{ mimeType: 'audio/pcm;rate=16000', data: Buffer.alloc(frameSize, 0).toString('base64') }]
          });
        } catch (e) { }
      }
    }
  }

  // ============================================================
  //  Auto-desconexión cuando el canal queda vacío
  // ============================================================
  _autoDisconnect(channelId, guildId) {
    this._cleanupSession(channelId);
    stateManager.setVoiceMode(channelId, false);
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
    }
    console.log(`[VOICE] Auto-desconectada del canal vacío ${channelId}.`);
  }

  // ============================================================
  //  Limpieza de recursos de una sesión
  // ============================================================
  _cleanupSession(channelId) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    if (sessionData.audioStream) {
      try { sessionData.audioStream.end(); } catch (e) { }
    }
    if (sessionData.mixerInterval) clearInterval(sessionData.mixerInterval);
    if (sessionData.recycleInterval) clearInterval(sessionData.recycleInterval);
    if (sessionData.cooldownTimer) clearTimeout(sessionData.cooldownTimer);
    if (sessionData.alexaWakeTimer) clearTimeout(sessionData.alexaWakeTimer);
    if (sessionData.voskRecognizer) sessionData.voskRecognizer.free();
    sessionData.activeListeners.clear();
    sessionData.userBuffers.clear();

    this.players.delete(channelId);
    console.log(`[VOICE] Recursos limpiados para canal ${channelId}.`);
  }

  // ============================================================
  //  Reproducir audio de Gemini en Discord (sin cambios)
  // ============================================================
  playAudioChunk(channelId, audioChunkBuffer) {
    const sessionData = this.players.get(channelId);
    if (!sessionData) return;

    if (!sessionData.isPlaying || !sessionData.audioStream) {
      sessionData.isPlaying = true;
      sessionData.audioStream = new PassThrough();
      const resource = createAudioResource(sessionData.audioStream, { inputType: StreamType.Raw });
      sessionData.player.play(resource);
    }

    // Upsampling puramente matemático (Cero Delay, Cero FFmpeg)
    // 24kHz Mono (2 bytes por frame) → 48kHz Stereo (8 bytes por frame repetidos)
    const fullBuffer = Buffer.concat([sessionData.upsampleLeftover, audioChunkBuffer]);
    const remainder = fullBuffer.length % 2;
    const processableBuffer = fullBuffer.subarray(0, fullBuffer.length - remainder);
    sessionData.upsampleLeftover = fullBuffer.subarray(fullBuffer.length - remainder);

    const outBuffer = Buffer.alloc((processableBuffer.length / 2) * 8);
    let outIndex = 0;
    for (let i = 0; i < processableBuffer.length; i += 2) {
      const sample = processableBuffer.readInt16LE(i);
      outBuffer.writeInt16LE(sample, outIndex);     // Frame 1 Left
      outBuffer.writeInt16LE(sample, outIndex + 2); // Frame 1 Right
      outBuffer.writeInt16LE(sample, outIndex + 4); // Frame 2 Left
      outBuffer.writeInt16LE(sample, outIndex + 6); // Frame 2 Right
      outIndex += 8;
    }

    sessionData.audioStream.write(outBuffer);
  }
}

export default new VoiceChannelService();
