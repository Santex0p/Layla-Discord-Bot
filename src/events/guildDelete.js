import guildPromptManager from '../models/GuildPromptManager.js';

export default {
  name: 'guildDelete',
  once: false,
  execute(guild) {
    console.log(`[EVENTO] Layla ha sido expulsada o el servidor ha sido eliminado: ${guild.name} (${guild.id})`);
    
    // Eliminar el servidor de la base de datos de configuraciones (server_prompts.json)
    guildPromptManager.removeGuild(guild.id);
  }
};
