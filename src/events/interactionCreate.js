import stateManager from '../models/ChannelStateManager.js';
import { getRandomEmoji } from '../../utils.js';
import voiceChannelService from '../services/VoiceChannelService.js';
import aiService from '../services/AiService.js';

import { CONFIG } from '../config/constants.js';
import guildPromptManager from '../models/GuildPromptManager.js';

// Set para llevar un registro de los canales que actualmente están procesando una búsqueda
const activeSearches = new Set();

export default {
  name: 'interactionCreate',
  once: false,
  async execute(interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('music_')) return;
      
      const { default: musicService } = await import('../services/MusicService.js');
      const player = musicService.manager.getPlayer(interaction.guildId);
      
      if (!player) {
        return interaction.reply({ content: 'No hay música sonando ahora mismo.', ephemeral: true });
      }

      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel || voiceChannel.id !== player.voiceChannelId) {
        return interaction.reply({ content: 'Debes estar en mi canal de voz para usar los controles.', ephemeral: true });
      }

      const action = interaction.customId.replace('music_', '');
      
      try {
        switch (action) {
          case 'playpause':
            if (player.paused) {
              await player.resume();
            } else {
              await player.pause();
            }
            break;
          case 'skip':
            await player.skip();
            break;
          case 'stop':
            await musicService.deletePlayerMenu(interaction.guildId);
            player.destroy();
            break;
          case 'voldown':
            await player.setVolume(Math.max(0, player.volume - 10));
            break;
          case 'volup':
            await player.setVolume(Math.min(200, player.volume + 10));
            break;
        }
        
        // El update del menú se hace sin responder a la interacción, pero Discord requiere defer o reply
        await interaction.deferUpdate();
        
        if (action !== 'stop' && action !== 'skip') {
          await musicService.updatePlayerMenu(interaction.guildId);
        }
      } catch (err) {
        console.error('Error al manejar botón de música:', err);
      }
      return;
    }

    if (!interaction.guildId) {
      return interaction.reply({
        content: 'Este comando solo funciona dentro de un servidor.',
        ephemeral: true,
      });
    }

    // Auto-registrar servidor en la base de datos de prompts
    if (interaction.guild) {
      const iconUrl = interaction.guild.iconURL({ dynamic: true, size: 128 });
      guildPromptManager.ensureGuildRegistered(interaction.guildId, interaction.guild.name, iconUrl);
    }

    const { commandName } = interaction;

    if (commandName === 'test') {
      return interaction.reply(`si, estoy viva ${getRandomEmoji()}`);
    }

    if (commandName === 'wack') {
      try {
        stateManager.clearAllState();
        await interaction.reply({ content: 'Ay, me golpee muy fuerte la cabeza...' });
      } catch (err) {
        console.error('Error al reiniciar Layla:', err);
        await interaction.reply({ content: `Error reiniciando Layla: ${err.message}`, ephemeral: true });
      }
      return;
    }

    if ((commandName === 'talk' || commandName === 'notalk') && !interaction.memberPermissions?.has('ManageGuild')) {
      return interaction.reply({
        content: 'Ey, Solo mis administradores (o roles con permiso de Gestionar Servidor) pueden usar este comando. :c',
        ephemeral: true,
      });
    }

    if (commandName === 'talk') {
      stateManager.activateChannel(interaction.channelId, interaction.guildId);
      return interaction.reply('¿Alguien me llamó?.');
    }

    if (commandName === 'notalk') {
      stateManager.deactivateChannel(interaction.channelId);
      return interaction.reply('Adiós, me voy a dormir... zzz');
    }

    if (commandName === 'call') {
      if (CONFIG.OLLAMA_ONLY) {
        return interaction.reply({
          content: 'Estoy en Modo Local (Ollama) y mi módulo de voz está apagado. Solo puedo hablar por chat de texto.',
          ephemeral: true
        });
      }
      return voiceChannelService.join(interaction);
    }

    if (commandName === 'endcall') {
      return voiceChannelService.leave(interaction);
    }

    if (commandName === 'search') {
      const query = interaction.options.getString('pregunta');

      if (CONFIG.OLLAMA_ONLY) {
        return interaction.reply({
          content: 'No puedo buscar en Internet mientras estoy en Modo Local (Ollama).',
          ephemeral: true
        });
      }

      // Prevenir múltiples búsquedas en el mismo canal para evitar gasto de tokens
      if (activeSearches.has(interaction.channelId)) {
        return interaction.reply({
          content: '¡Paciencia! Ya estoy buscando algo en este canal. Dame un segundito... ⏳',
          ephemeral: true
        });
      }

      activeSearches.add(interaction.channelId);

      await interaction.deferReply(); // "Layla está pensando..."
      try {
        let responseText = await aiService.searchInternet(query);
        console.log(`[SEARCH] Longitud original de la respuesta: ${responseText.length} caracteres.`);
        
        if (responseText.length > 1800) {
          responseText = responseText.substring(0, 1800) + '\n\n... [La respuesta era demasiado larga y tuve que cortarla]';
          console.log(`[SEARCH] Respuesta recortada a: ${responseText.length} caracteres.`);
        }
        
        return interaction.editReply({ content: responseText });
      } catch (err) {
        console.error('Error en /search:', err);
        return interaction.editReply('¡Uy! Google se me puso roñoso y no me dejó buscar eso. Mejor hablemos de otra cosa... 🙄');
      } finally {
        // Liberar el canal para permitir nuevas búsquedas
        activeSearches.delete(interaction.channelId);
      }
    }

    if (commandName === 'play') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) return interaction.reply({ content: 'Debes estar en un canal de voz.', ephemeral: true });

      // Resolución de conflicto: ¿Layla está hablando?
      if (voiceChannelService.players.has(voiceChannel.id) || voiceChannelService.players.has(interaction.guildId)) {
        return interaction.reply({ content: '¡Espera! Déjame terminar de hablar primero 🤫', ephemeral: true });
      }

      await interaction.deferReply();
      const query = interaction.options.getString('cancion');
      const { default: musicService } = await import('../services/MusicService.js');

      const player = musicService.manager.createPlayer({
        guildId: interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId: interaction.channelId,
        selfDeaf: true,
        selfMute: false,
        volume: parseInt(process.env.DEFAULT_VOLUME) || 100
      });

      await player.connect();
      const res = await player.search({ query }, interaction.user);

      if (res.loadType === 'error' || res.loadType === 'empty') {
        if (!player.playing && !player.queue.tracks.length) player.destroy();
        return interaction.editReply({ content: 'No encontré esa canción.' });
      }

      if (res.loadType === 'playlist') {
        const wasPlaying = player.playing || player.paused;
        player.queue.add(res.tracks);
        if (!wasPlaying) await player.play();
        
        if (wasPlaying) {
          return interaction.editReply({ content: `🎶 Añadida playlist con ${res.tracks.length} canciones.` });
        } else {
          return interaction.deleteReply().catch(() => {});
        }
      } else {
        const wasPlaying = player.playing || player.paused;
        player.queue.add(res.tracks[0]);
        if (!wasPlaying) await player.play();
        
        if (wasPlaying) {
          return interaction.editReply({ content: `🎶 Añadida a la cola: **${res.tracks[0].info.title}**` });
        } else {
          return interaction.deleteReply().catch(() => {});
        }
      }
    }

    if (commandName === 'stop') {
      const { default: musicService } = await import('../services/MusicService.js');
      const player = musicService.manager.getPlayer(interaction.guildId);
      if (!player) return interaction.reply({ content: 'No hay música sonando.', ephemeral: true });
      await musicService.deletePlayerMenu(interaction.guildId);
      player.destroy();
      return interaction.reply({ content: 'Música detenida.' });
    }

    if (commandName === 'skip') {
      const { default: musicService } = await import('../services/MusicService.js');
      const player = musicService.manager.getPlayer(interaction.guildId);
      if (!player) return interaction.reply({ content: 'No hay música sonando.', ephemeral: true });
      await player.skip();
      return interaction.reply({ content: 'Canción saltada.' });
    }

    if (commandName === 'autoplay') {
      const { default: musicService } = await import('../services/MusicService.js');
      const guildId = interaction.guildId;
      const current = musicService.autoplayStatus.get(guildId) || false;
      const newState = !current;
      musicService.autoplayStatus.set(guildId, newState);
      
      return interaction.reply({ 
        content: newState 
          ? '📻 **Autoplay Activado**: Buscararé canciones similares cuando se acabe la cola.' 
          : '📻 **Autoplay Desactivado**: Me detendré cuando termine la cola.',
        ephemeral: false
      });
    }

    if (commandName === 'volume') {
      const { default: musicService } = await import('../services/MusicService.js');
      const player = musicService.manager.getPlayer(interaction.guildId);
      if (!player) return interaction.reply({ content: 'No hay música sonando.', ephemeral: true });
      
      const level = interaction.options.getInteger('nivel');
      await player.setVolume(level);
      await musicService.updatePlayerMenu(interaction.guildId);
      
      return interaction.reply({ content: `🔊 Volumen ajustado al **${level}%**.`, ephemeral: true });
    }
  }
};
