import 'dotenv/config';
import { capitalize, InstallGlobalCommands } from './utils.js';


// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Restart / maintenance command: reinicia la sesion y limpia el estado de la bot
const WACK_COMMAND = {
  name: 'wack',
  description: 'Limpia el contexto local de Layla',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};


const TALK_COMMAND = {
  name: 'talk',
  description: 'Activa a Layla solo en este canal',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  default_member_permissions: '32',
};

const NOTALK_COMMAND = {
  name: 'notalk',
  description: 'Desactiva a Layla solo en este canal',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  default_member_permissions: '32',
};

const CALL_COMMAND = {
  name: 'call',
  description: 'Une a Layla a tu canal de voz actual',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const ENDCALL_COMMAND = {
  name: 'endcall',
  description: 'Desconecta a Layla del canal de voz',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const SEARCH_COMMAND = {
  name: 'search',
  description: 'Le pide a Layla que busque algo en Internet',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3, // STRING
      name: 'pregunta',
      description: 'Lo que quieres que Layla busque en Google',
      required: true
    }
  ]
};

const PLAY_COMMAND = {
  name: 'play',
  description: 'Layla pone música para ti (Lavalink)',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 3, // STRING
      name: 'cancion',
      description: 'Nombre o URL de la canción',
      required: true
    }
  ]
};

const STOP_COMMAND = {
  name: 'stop',
  description: 'Layla detiene la música',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const SKIP_COMMAND = {
  name: 'skip',
  description: 'Layla salta a la siguiente canción',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const AUTOPLAY_COMMAND = {
  name: 'autoplay',
  description: 'Layla buscará música recomendada automáticamente cuando se acabe la cola',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const VOLUME_COMMAND = {
  name: 'volume',
  description: 'Ajusta el volumen de Layla (0-200)',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 4, // INTEGER
      name: 'nivel',
      description: 'Nivel de volumen (0 a 200)',
      required: true,
      min_value: 0,
      max_value: 200
    }
  ]
};

const ALL_COMMANDS = [TEST_COMMAND, WACK_COMMAND, TALK_COMMAND, NOTALK_COMMAND, CALL_COMMAND, ENDCALL_COMMAND, SEARCH_COMMAND, PLAY_COMMAND, STOP_COMMAND, SKIP_COMMAND, AUTOPLAY_COMMAND, VOLUME_COMMAND];

console.log('[COMMANDS] Registrando comandos para APP_ID:', process.env.APP_ID || 'no definido');
InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
