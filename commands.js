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

const ALL_COMMANDS = [TEST_COMMAND, WACK_COMMAND, TALK_COMMAND, NOTALK_COMMAND, CALL_COMMAND, ENDCALL_COMMAND];

console.log('[COMMANDS] Registrando comandos para APP_ID:', process.env.APP_ID || 'no definido');
InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
