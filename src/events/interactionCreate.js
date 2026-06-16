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
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.guildId) {
      return interaction.reply({
        content: 'Este comando solo funciona dentro de un servidor.',
        ephemeral: true,
      });
    }

    // Auto-registrar servidor en la base de datos de prompts
    if (interaction.guild) {
      guildPromptManager.ensureGuildRegistered(interaction.guildId, interaction.guild.name);
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
  }
};
