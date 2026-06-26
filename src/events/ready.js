import guildPromptManager from '../models/GuildPromptManager.js';

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
    client.guilds.cache.forEach(guild => {
      const iconUrl = guild.iconURL({ dynamic: true, size: 128 });
      guildPromptManager.ensureGuildRegistered(guild.id, guild.name, iconUrl);
    });
  }
};
