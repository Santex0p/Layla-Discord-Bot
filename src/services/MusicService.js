import { LavalinkManager } from 'lavalink-client';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { CONFIG } from '../config/constants.js';

class MusicService {
  constructor() {
    this.client = null;
    this.manager = null;
    this.initialized = false;
    this.playerMessages = new Map(); // guildId -> { messageId, channelId }
    this.autoplayStatus = new Map(); // guildId -> boolean
    this.pendingAnnouncements = new Map(); // guildId -> Promise<Buffer|null> (pre-generación en background)
  }

  init(discordClient) {
    if (this.initialized) return;
    this.client = discordClient;

    this.manager = new LavalinkManager({
      nodes: [
        {
          authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
          host: process.env.LAVALINK_HOST || 'layla-lavalink',
          port: parseInt(process.env.LAVALINK_PORT) || 2333,
          secure: process.env.LAVALINK_SECURE === 'true',
          id: 'Local Node'
        }
      ],
      sendToShard: (guildId, payload) => {
        const guild = this.client.guilds.cache.get(guildId);
        if (guild) guild.shard.send(payload);
      },
      client: {
        id: this.client.user.id,
        username: this.client.user.username,
      },
      playerOptions: {
        applyVolumeAsFilter: false,
        clientBasedPositionUpdateInterval: 150,
        defaultSearchPlatform: 'ytmsearch',
        volumeDecrementer: 1,
      },
      queueOptions: {
        maxPreviousTracks: 10,
      }
    });

    // Eventos del nodo
    this.manager.nodeManager.on('connect', (node) => {
      console.log(`[MUSIC] Lavalink Node ${node.id} connected`);
    });

    this.manager.nodeManager.on('error', (node, error) => {
      console.error(`[MUSIC] Lavalink Node ${node.id} error:`, error.message);
    });

    // Eventos del reproductor
    this.manager.on('trackStart', (player, track) => {
      console.log(`[MUSIC] ▶ Now playing in guild ${player.guildId}: ${track.info.title} (${track.info.uri})`);
      this.sendPlayerMenu(player);
    });

    this.manager.on('trackEnd', (player, track, payload) => {
      console.log(`[MUSIC] ⏹ Track ended in guild ${player.guildId}: ${track.info.title} (reason: ${payload.reason})`);
      if (payload.reason !== 'replaced') {
        this.deletePlayerMenu(player.guildId);
      }
    });

    this.manager.on('trackError', (player, track, payload) => {
      console.error(`[MUSIC] ❌ Track error in guild ${player.guildId}: ${track.info.title}`, payload);
      this.deletePlayerMenu(player.guildId);
      const channel = this.client.channels.cache.get(player.textChannelId);
      if (channel) channel.send(`❌ Error al reproducir **${track.info.title}**. Saltando...`).catch(() => { });
    });

    this.manager.on('trackStuck', (player, track) => {
      console.error(`[MUSIC] ⚠ Track stuck in guild ${player.guildId}: ${track.info.title}`);
      player.skip().catch(() => { });
    });

    this.manager.on('queueEnd', async (player, track) => {
      const isAutoplay = this.autoplayStatus.get(player.guildId);

      // Cuando el usuario salta la última canción, `track` puede llegar null/undefined.
      // En ese caso, usamos el último track del historial como referencia para el autoplay.
      const lastTrack = track || player.queue.previous?.[player.queue.previous.length - 1];

      // Intentar Autoplay si está activado y la canción anterior era de YouTube
      if (isAutoplay && lastTrack && lastTrack.info && (lastTrack.info.sourceName === 'youtube' || lastTrack.info.sourceName === 'youtubemusic')) {
        console.log(`[MUSIC] Autoplay intentando buscar mix para: ${lastTrack.info.title} (${lastTrack.info.identifier})`);
        const channel = this.client.channels.cache.get(player.textChannelId);
        try {
          const videoId = lastTrack.info.identifier;
          // Buscar un mix de radio basado en la canción que acaba de terminar
          const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
          const res = await player.search({ query: mixUrl }, this.client.user);
          
          console.log(`[MUSIC] Resultados del mix: ${res.tracks ? res.tracks.length : 0} pistas encontradas.`);

          if (res.tracks && res.tracks.length > 0) {
            // Evitar repetir canciones recientes
            const recentIds = player.queue.previous.slice(-10).map(t => t.info.identifier);
            recentIds.push(videoId);

            const nextTracks = res.tracks.filter(t => !recentIds.includes(t.info.identifier)).slice(0, 10);
            console.log(`[MUSIC] Pistas filtradas para añadir: ${nextTracks.length}`);

            if (nextTracks.length > 0) {
              for (const nextTrack of nextTracks) {
                nextTrack.requester = {
                  username: 'Layla (Autoplay)',
                  avatarURL: () => this.client.user.displayAvatarURL()
                };
                player.queue.add(nextTrack);
              }

              // Obtener el buffer de anuncio pre-generado (si ya está listo) o generar ahora
              const preGenPromise = this.pendingAnnouncements.get(player.guildId);
              this.pendingAnnouncements.delete(player.guildId);
              const preGenBuffer = preGenPromise ? await preGenPromise.catch(() => null) : null;

              // Anuncio de DJ estilo Spotify antes de arrancar el siguiente bloque
              await this._playDJAnnouncement(player, nextTracks, preGenBuffer).catch(() => {});

              if (!player.playing && !player.paused) await player.play();

              // Pre-generar ya el audio del SIGUIENTE anuncio en background (mientras suena este bloque)
              this._preGenerateNextAnnouncement(player, nextTracks);

              return; // Si el autoplay fue exitoso, no ejecutamos la desconexión
            }
          }
        } catch (err) {
          console.error('[MUSIC] Error en Autoplay:', err);
        }
      } else {
         console.log(`[MUSIC] Autoplay omitido. isAutoplay: ${isAutoplay}, lastTrack: ${lastTrack ? 'Sí' : 'No'}`);
      }

      console.log(`[MUSIC] 📭 Queue ended in guild ${player.guildId}. Esperando 2 minutos antes de desconectar.`);
      this.deletePlayerMenu(player.guildId);
      const channel = this.client.channels.cache.get(player.textChannelId);
      if (channel) channel.send('📭 Se acabó la cola. Me quedaré 2 minutos por si quieres poner más música.').catch(() => { });

      // Esperar 2 minutos antes de desconectar
      setTimeout(() => {
        const currentPlayer = this.manager.getPlayer(player.guildId);
        if (currentPlayer && !currentPlayer.playing) {
          currentPlayer.destroy();
          console.log(`[MUSIC] 👋 Desconectada de guild ${player.guildId} por inactividad.`);
        }
      }, 120_000);
    });

    this.initialized = true;
    this.manager.init(this.client.user.id);
  }

  /**
   * Genera en background el audio del próximo anuncio DJ mientras el bloque actual suena.
   * Almacena la promesa en pendingAnnouncements para que el siguiente queueEnd la use ya lista.
   */
  _preGenerateNextAnnouncement(player, currentTracks) {
    import('./AiService.js').then(({ default: aiService }) => {
      // Usamos las mismas canciones actuales como "pista" para el estilo del siguiente anuncio
      const promise = aiService.generateDJAnnouncement(currentTracks, player.guildId);
      this.pendingAnnouncements.set(player.guildId, promise);
      promise.then(result => {
        if (result) console.log(`[DJ-ANNOUNCE] Anuncio siguiente pre-generado (${result.buffer?.length || result.length} bytes, ${result.mimeType || 'unknown'}) y listo.`);
      }).catch(() => this.pendingAnnouncements.delete(player.guildId));
    }).catch(() => {});
  }

  /**
   * Genera un anuncio de Layla via Lavalink (sin conflicto de conexión de voz).
   * Guarda el audio en un archivo temporal, lo sirve via HTTP, y Lavalink lo reproduce.
   * @param {object} player - Lavalink player
   * @param {object[]} nextTracks - Próximas canciones
   * @param {Buffer|null} preGeneratedBuffer - Buffer de audio pre-generado (opcional)
   */
  async _playDJAnnouncement(player, nextTracks, preGeneratedBuffer = null) {
    try {
      const { default: aiService } = await import('./AiService.js');
      const { randomUUID } = await import('node:crypto');
      const fsPromises = await import('node:fs/promises');
      const path = await import('node:path');

      console.log(`[DJ-ANNOUNCE] Generando anuncio para las próximas ${nextTracks.length} canciones...`);

      // Usar buffer pre-generado si está disponible, si no, generar ahora
      let audioResult = preGeneratedBuffer;
      if (!audioResult) {
        console.log(`[DJ-ANNOUNCE] No hay pre-generado disponible. Generando en tiempo real...`);
        audioResult = await aiService.generateDJAnnouncement(nextTracks, player.guildId);
      } else {
        console.log(`[DJ-ANNOUNCE] Usando buffer pre-generado. Sin delay.`);
      }
      if (!audioResult) {
        console.warn('[DJ-ANNOUNCE] Sin audio, saltando anuncio.');
        return;
      }

      // audioResult puede ser { buffer, mimeType } o un Buffer legacy
      const audioBuffer = audioResult.buffer || audioResult;
      const mimeType = audioResult.mimeType || 'audio/l16';
      console.log(`[DJ-ANNOUNCE] Audio buffer: ${audioBuffer.length} bytes, mimeType: ${mimeType}`);

      // Convertir PCM L16 a MP3 usando AudioService (ffmpeg) — formato nativo de Lavalink
      const { default: audioService } = await import('./AudioService.js');
      const mp3Buffer = await audioService.pcm16ToMp3Buffer(audioBuffer, 24000, 1);
      console.log(`[DJ-ANNOUNCE] MP3 generado: ${mp3Buffer.length} bytes`);

      // Escribir a data/audios/announce_<uuid>.mp3
      const audiosDir = path.default.join(process.cwd(), 'data', 'audios');
      await fsPromises.default.mkdir(audiosDir, { recursive: true });
      const filename = `announce_${randomUUID()}.mp3`;
      const filepath = path.default.join(audiosDir, filename);
      await fsPromises.default.writeFile(filepath, mp3Buffer);

      // Usar la ruta compartida del volumen Docker con prefijo 'local:' que Lavalink v4 requiere
      const localPath = `/app/data/audios/${filename}`;
      const announceUrl = `local:${localPath}`;

      console.log(`[DJ-ANNOUNCE] Archivo MP3 generado. Cargando en Lavalink: ${announceUrl}`);

      // Cargar el archivo local en Lavalink
      const res = await player.search({ query: announceUrl }, this.client.user);
      if (!res?.tracks?.length) {
        console.warn('[DJ-ANNOUNCE] Lavalink no pudo cargar el archivo de anuncio.');
        await fsPromises.default.unlink(filepath).catch(() => {});
        return;
      }

      const announceTrack = res.tracks[0];
      announceTrack.requester = {
        username: 'Layla (DJ)',
        avatarURL: () => this.client.user.displayAvatarURL()
      };
      
      // Sobrescribir los metadatos visuales de la pista local
      announceTrack.info.title = 'Layla Presenta';
      announceTrack.info.author = 'Layla DJ';
      announceTrack.info.artworkUrl = this.client.user.displayAvatarURL();
      announceTrack.info.uri = ''; // Para no mostrar la ruta del archivo como link

      // Insertar el anuncio al frente de la cola (antes de las canciones de música)
      // lavalink-client usa player.queue.tracks como array interno
      if (typeof player.queue.unshift === 'function') {
        player.queue.unshift(announceTrack);
      } else {
        player.queue.tracks.unshift(announceTrack);
      }
      console.log(`[DJ-ANNOUNCE] Anuncio insertado en la cola. Reproduciendo...`);
      if (!player.playing && !player.paused) await player.play();

      // Esperar a que termine el track del anuncio (evento trackEnd con el filename)
      await new Promise((resolve) => {
        const onEnd = (p, t) => {
          if (t?.info?.uri?.includes(filename)) {
            this.manager.off('trackEnd', onEnd);
            resolve();
          }
        };
        this.manager.on('trackEnd', onEnd);
        setTimeout(() => { this.manager.off('trackEnd', onEnd); resolve(); }, 60_000);
      });

      // Borrar el archivo temporal
      await fsPromises.default.unlink(filepath).catch(() => {});
      console.log(`[DJ-ANNOUNCE] Anuncio completado.`);

    } catch (err) {
      console.error('[DJ-ANNOUNCE] Error durante el anuncio:', err.message);
    }
  }

  formatDuration(ms) {
    if (!ms || ms === 0) return '00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  createPlayerMenu(player, track) {
    const embed = new EmbedBuilder()
      .setColor('#FF007F')
      .setTitle('🎧 Layla DJ')
      .setDescription(`**Reproduciendo ahora:**\n${track.info.uri ? `[${track.info.title}](${track.info.uri})` : `**${track.info.title}**`}`)
      .setThumbnail(track.info.artworkUrl || null)
      .addFields(
        { name: '👤 Autor', value: track.info.author || 'Desconocido', inline: true },
        { name: '⏱️ Duración', value: this.formatDuration(track.info.duration), inline: true },
        { name: '📜 En Cola', value: `${player.queue.tracks.length} canciones`, inline: true }
      );

    if (track.requester) {
      embed.setFooter({
        text: `Pedido por ${track.requester.username || track.requester.tag} • Volumen: ${player.volume}%`,
        iconURL: track.requester.avatarURL ? track.requester.avatarURL() : (track.requester.displayAvatarURL ? track.requester.displayAvatarURL() : undefined)
      });
    } else {
      embed.setFooter({ text: `Volumen: ${player.volume}%` });
    }

    const isPaused = player.paused;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('music_playpause')
        .setEmoji(isPaused ? '▶️' : '⏸️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('music_skip')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music_stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('music_voldown')
        .setEmoji('🔉')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('music_volup')
        .setEmoji('🔊')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
  }

  async sendPlayerMenu(player) {
    const track = player.queue.current;
    if (!track) return;

    const channel = this.client.channels.cache.get(player.textChannelId);
    if (!channel) return;

    try {
      await this.deletePlayerMenu(player.guildId);
      const menu = this.createPlayerMenu(player, track);
      const message = await channel.send(menu);
      this.playerMessages.set(player.guildId, { messageId: message.id, channelId: channel.id });
    } catch (err) {
      console.error('Error enviando menú de reproductor:', err);
    }
  }

  async updatePlayerMenu(guildId) {
    const player = this.manager.getPlayer(guildId);
    if (!player || !player.queue.current) return;

    const record = this.playerMessages.get(guildId);
    if (!record) return;

    const channel = this.client.channels.cache.get(record.channelId);
    if (!channel) return;

    try {
      const message = channel.messages.cache.get(record.messageId) || await channel.messages.fetch(record.messageId);
      if (message) {
        const menu = this.createPlayerMenu(player, player.queue.current);
        await message.edit(menu);
      }
    } catch (err) {
      console.error('Error actualizando menú:', err);
      this.playerMessages.delete(guildId);
    }
  }

  async deletePlayerMenu(guildId) {
    const record = this.playerMessages.get(guildId);
    if (!record) return;

    const channel = this.client.channels.cache.get(record.channelId);
    if (channel) {
      try {
        const message = channel.messages.cache.get(record.messageId) || await channel.messages.fetch(record.messageId);
        if (message) await message.delete();
      } catch (err) {
        // Ignorar si el mensaje ya fue borrado
      }
    }
    this.playerMessages.delete(guildId);
  }

  /**
   * Verifica si hay música reproduciéndose en un servidor
   */
  isMusicPlaying(guildId) {
    if (!this.manager) return false;
    const player = this.manager.getPlayer(guildId);
    return player && player.playing;
  }
}

export default new MusicService();
