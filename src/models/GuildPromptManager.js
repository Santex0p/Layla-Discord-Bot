import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config/constants.js';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const PROMPTS_FILE = path.join(DATA_DIR, 'server_prompts.json');

class GuildPromptManager {
  constructor() {
    this.prompts = new Map();
    this._loadPrompts();
  }

  _loadPrompts() {
    try {
      if (fs.existsSync(PROMPTS_FILE)) {
        const data = fs.readFileSync(PROMPTS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        for (const [guildId, info] of Object.entries(parsed)) {
          this.prompts.set(guildId, info);
        }
      }
    } catch (e) {
      console.error(`[GuildPromptManager] Error leyendo server_prompts.json:`, e.message);
    }
  }

  _savePrompts() {
    const obj = {};
    for (const [guildId, info] of this.prompts.entries()) {
      obj[guildId] = info;
    }
    fs.promises.writeFile(PROMPTS_FILE, JSON.stringify(obj, null, 2), 'utf8')
      .catch(e => console.error(`[GuildPromptManager] Error guardando server_prompts.json:`, e.message));
  }

  ensureGuildRegistered(guildId, guildName) {
    if (!guildId) return;
    if (!this.prompts.has(guildId)) {
      this.prompts.set(guildId, {
        serverName: guildName || 'Servidor Desconocido',
        prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION,
        language: CONFIG.DEFAULT_VOSK_LANG
      });
      this._savePrompts();
      console.log(`[GuildPromptManager] Servidor registrado: ${guildName} (${guildId}) con prompt por defecto.`);
    } else {
      // Actualizar nombre si cambió
      const info = this.prompts.get(guildId);
      if (guildName && info.serverName !== guildName) {
        info.serverName = guildName;
        this._savePrompts();
      }
    }
  }

  getPrompt(guildId) {
    if (!guildId || !this.prompts.has(guildId)) {
      return CONFIG.LIVE_SYSTEM_INSTRUCTION;
    }
    const info = this.prompts.get(guildId);
    return info.prompt || CONFIG.LIVE_SYSTEM_INSTRUCTION;
  }

  setPrompt(guildId, newPrompt) {
    if (!guildId || !newPrompt) return false;
    
    // Si el servidor existe, lo actualizamos. Si no, lo creamos.
    if (this.prompts.has(guildId)) {
      const info = this.prompts.get(guildId);
      info.prompt = newPrompt;
    } else {
      this.prompts.set(guildId, {
        serverName: 'Servidor Desconocido (Añadido Web)',
        prompt: newPrompt
      });
    }
    
    this._savePrompts();
    console.log(`[GuildPromptManager] Prompt actualizado para servidor: ${guildId}`);
    return true;
  }

  getLanguage(guildId) {
    if (!guildId || !this.prompts.has(guildId)) {
      return CONFIG.DEFAULT_VOSK_LANG;
    }
    const info = this.prompts.get(guildId);
    return info.language || CONFIG.DEFAULT_VOSK_LANG;
  }

  setLanguage(guildId, langCode) {
    if (!guildId || !langCode) return false;
    if (this.prompts.has(guildId)) {
      const info = this.prompts.get(guildId);
      info.language = langCode;
    } else {
      this.prompts.set(guildId, {
        serverName: 'Servidor Desconocido',
        prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION,
        language: langCode
      });
    }
    this._savePrompts();
    console.log(`[GuildPromptManager] Idioma actualizado a '${langCode}' para servidor: ${guildId}`);
    return true;
  }
}

export default new GuildPromptManager();
