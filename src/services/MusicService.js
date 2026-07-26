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
      
      // Intentar Autoplay si está activado y la canción anterior era de YouTube
      if (isAutoplay && track && track.info && (track.info.sourceName === 'youtube' || track.info.sourceName === 'youtubemusic')) {
        const channel = this.client.channels.cache.get(player.textChannelId);
        try {
          const videoId = track.info.identifier;
          // Buscar un mix de radio basado en la canción que acaba de terminar
          const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
          const res = await player.search({ query: mixUrl }, this.client.user);
          
          if (res.tracks && res.tracks.length > 0) {
            // Evitar repetir canciones recientes
            const recentIds = player.queue.previous.slice(-10).map(t => t.info.identifier);
            recentIds.push(videoId);
            
            const nextTrack = res.tracks.find(t => !recentIds.includes(t.info.identifier));
            
            if (nextTrack) {
              player.queue.add(nextTrack);
              if (!player.playing && !player.paused) await player.play();
              if (channel) channel.send(`📻 **Autoplay**: Añadida automáticamente **${nextTrack.info.title}**`).catch(()=>{});
              return; // Si el autoplay fue exitoso, no ejecutamos la desconexión
            }
          }
        } catch (err) {
          console.error('[MUSIC] Error en Autoplay:', err);
        }
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
      .setDescription(`**Reproduciendo ahora:**\n[${track.info.title}](${track.info.uri || ''})`)
      .setThumbnail(track.info.artworkUrl || null)
      .addFields(
        { name: '👤 Autor', value: track.info.author || 'Desconocido', inline: true },
        { name: '⏱️ Duración', value: this.formatDuration(track.info.length), inline: true },
        { name: '📜 En Cola', value: `${player.queue.tracks.length} canciones`, inline: true }
      )
      .setFooter({ text: `Volumen: ${player.volume}%` });

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
