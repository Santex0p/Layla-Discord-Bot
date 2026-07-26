import 'dotenv/config';
import { setDiscordClient } from './utils/dashboardServer.js'; // Iniciar servidor web, API y captura de logs
import { Client, GatewayIntentBits } from 'discord.js';
import readyEvent from './events/ready.js';
import messageCreateEvent from './events/messageCreate.js';
import interactionCreateEvent from './events/interactionCreate.js';
import guildDeleteEvent from './events/guildDelete.js';
import voiceChannelService from './services/VoiceChannelService.js';

// Cliente de Discord: configuración de intents mínimos necesarios para chat
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// Pasar el cliente al servidor web para que pueda expulsar al bot si se pide
setDiscordClient(client);

// Inicializar MusicService (Lavalink)
import musicService from './services/MusicService.js';
client.on('ready', () => {
  musicService.init(client);
});
client.on('raw', (d) => {
  if (musicService.manager) musicService.manager.sendRawData(d);
});

// Registrar eventos
const events = [readyEvent, messageCreateEvent, interactionCreateEvent, guildDeleteEvent];

for (const event of events) {
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// === VOZ: Auto-disconnect + Saludos automáticos ===
client.on('voiceStateUpdate', (oldState, newState) => {
  voiceChannelService.handleVoiceStateUpdate(oldState, newState, client);
});

// Eventos de debug
client.on('error', (err) => {
  console.error('[DISCORD CLIENT] error:', err);
});

client.on('shardError', (err) => {
  console.error('[DISCORD CLIENT] shardError:', err);
});

// === ARRANQUE GENERAL ===
const tokenFinal = process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!tokenFinal) {
  console.error('Falta el Token en el .env');
} else {
  console.log('Conectando a la API de Discord...');
  client.login(tokenFinal).catch(err => {
    console.error('Error de login:', err);
  });
}
