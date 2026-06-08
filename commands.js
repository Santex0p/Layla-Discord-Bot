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
  default_member_permissions: '8',
};

const NOTALK_COMMAND = {
  name: 'notalk',
  description: 'Desactiva a Layla solo en este canal',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  default_member_permissions: '8',
};

const ALL_COMMANDS = [TEST_COMMAND, WACK_COMMAND, TALK_COMMAND, NOTALK_COMMAND];

console.log('[COMMANDS] Registrando comandos para APP_ID:', process.env.APP_ID || 'no definido');
InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
