import stateManager from '../models/ChannelStateManager.js';
import { getRandomEmoji } from '../../utils.js';
import voiceChannelService from '../services/VoiceChannelService.js';

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

    if ((commandName === 'talk' || commandName === 'notalk') && !interaction.memberPermissions?.has('Administrator')) {
      return interaction.reply({
        content: 'Ey, Solo mis administradores pueden usar este comando. :c',
        ephemeral: true,
      });
    }

    if (commandName === 'talk') {
      stateManager.activateChannel(interaction.channelId);
      return interaction.reply('¿Alguien me llamó?.');
    }
    
    if (commandName === 'notalk') {
      stateManager.deactivateChannel(interaction.channelId);
      return interaction.reply('Adiós, me voy a dormir... zzz');
    }

    if (commandName === 'call') {
      return voiceChannelService.join(interaction);
    }

    if (commandName === 'endcall') {
      return voiceChannelService.leave(interaction);
    }
  }
};
