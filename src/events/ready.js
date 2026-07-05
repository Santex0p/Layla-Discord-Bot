import guildPromptManager from '../models/GuildPromptManager.js';
import { ActivityType } from 'discord.js';
import { CONFIG } from '../config/constants.js';

export default {
  name: 'clientReady',
  once: true,
  execute(client) {
    console.log(`✅ [CONEXIÓN] ¡Bot Layla conectado con éxito como ${client.user.tag}!`);
    try {
      const appId = client.application?.id || (client.application && client.application.id) || process.env.APP_ID || 'desconocido';
      console.log(`🔎 [APP] Application ID: ${appId}`);
    } catch (e) {
      console.warn('No se pudo obtener client.application.id:', e);
    }

    // Registrar/actualizar información de todos los servidores en los que está el bot
    const currentGuildIds = [];
    client.guilds.cache.forEach(guild => {
      currentGuildIds.push(guild.id);
      const iconUrl = guild.iconURL({ dynamic: true, size: 128 });
      guildPromptManager.ensureGuildRegistered(guild.id, guild.name, iconUrl);
    });

    // Limpiar servidores de los que el bot fue expulsado mientras estaba apagado
    guildPromptManager.cleanupOrphanedGuilds(currentGuildIds);

    // Establecer estado (Custom Status)
    client.user.setActivity({
      name: 'Custom Status',
      type: ActivityType.Custom,
      state: `Panel | ${CONFIG.DASHBOARD_DOMAIN.replace(/^https?:\/\//, '')}`
    });
  }
};
