import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

import readyEvent from './events/ready.js';
import messageCreateEvent from './events/messageCreate.js';
import interactionCreateEvent from './events/interactionCreate.js';

// Cliente de Discord: configuración de intents mínimos necesarios para chat
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Registrar eventos
const events = [readyEvent, messageCreateEvent, interactionCreateEvent];

for (const event of events) {
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

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
