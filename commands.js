import 'dotenv/config';
import { getRPSChoices } from './game.js';
import { capitalize, InstallGlobalCommands } from './utils.js';

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

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

// Command containing options
const CHALLENGE_COMMAND = {
  name: 'challenge',
  description: 'Challenge to a match of rock paper scissors',
  options: [
    {
      type: 3,
      name: 'object',
      description: 'Pick your object',
      required: true,
      choices: createCommandChoices(),
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

const ACTIVE_COMMAND = {
  name: 'active',
  description: 'Activa el modo conversacion',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const DESACTIVE_COMMAND = {
  name: 'desactive',
  description: 'Desactiva el modo conversacion',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [TEST_COMMAND, CHALLENGE_COMMAND, WACK_COMMAND];

console.log('[COMMANDS] Registrando comandos para APP_ID:', process.env.APP_ID || 'no definido');
InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
