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

  ensureGuildRegistered(guildId, guildName, iconUrl = null) {
    if (!guildId) return;
    if (!this.prompts.has(guildId)) {
      this.prompts.set(guildId, {
        serverName: guildName || 'Servidor Desconocido',
        serverIcon: iconUrl,
        prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION,
        language: CONFIG.DEFAULT_LANG,
        replyToLayla: false,
        triggers: []
      });
      this._savePrompts();
      console.log(`[GuildPromptManager] Servidor registrado: ${guildName} (${guildId}).`);
    } else {
      // Actualizar nombre o icono si cambiaron
      const info = this.prompts.get(guildId);
      let changed = false;
      if (guildName && info.serverName !== guildName) {
        info.serverName = guildName;
        changed = true;
      }
      if (iconUrl && info.serverIcon !== iconUrl) {
        info.serverIcon = iconUrl;
        changed = true;
      }
      if (changed) {
        this._savePrompts();
      }
    }
  }

  removeGuild(guildId) {
    if (!guildId) return;
    if (this.prompts.has(guildId)) {
      const info = this.prompts.get(guildId);
      this.prompts.delete(guildId);
      this._savePrompts();
      console.log(`[GuildPromptManager] Servidor eliminado de la base de datos: ${info.serverName || 'Desconocido'} (${guildId}).`);
    }
  }

  cleanupOrphanedGuilds(activeGuildIds) {
    let changed = false;
    for (const guildId of this.prompts.keys()) {
      if (!activeGuildIds.includes(guildId)) {
        this.prompts.delete(guildId);
        changed = true;
        console.log(`[GuildPromptManager] Limpieza: Servidor fantasma eliminado (${guildId}).`);
      }
    }
    if (changed) {
      this._savePrompts();
    }
  }

  getPrompt(guildId) {
    let promptText = CONFIG.LIVE_SYSTEM_INSTRUCTION;
    let lang = CONFIG.DEFAULT_LANG;

    if (guildId && this.prompts.has(guildId)) {
      const info = this.prompts.get(guildId);
      promptText = info.prompt || CONFIG.LIVE_SYSTEM_INSTRUCTION;
      lang = info.language || CONFIG.DEFAULT_LANG;
    }

    const langInstruction = `\n\n[Hablas "${lang}" a menos que alguien te pida cambiarlo explícitamente.]`;

    return promptText + langInstruction;
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
      return CONFIG.DEFAULT_LANG;
    }
    const info = this.prompts.get(guildId);
    return info.language || CONFIG.DEFAULT_LANG;
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
        language: langCode,
        replyToLayla: false,
        triggers: []
      });
    }
    this._savePrompts();
    console.log(`[GuildPromptManager] Idioma actualizado a '${langCode}' para servidor: ${guildId}`);
    return true;
  }

  getTriggers(guildId) {
    if (!guildId || !this.prompts.has(guildId)) return [];
    return this.prompts.get(guildId).triggers || [];
  }

  setTriggers(guildId, triggersList) {
    if (!guildId) return false;
    if (!Array.isArray(triggersList)) return false;
    
    if (this.prompts.has(guildId)) {
      this.prompts.get(guildId).triggers = triggersList;
    } else {
      this.prompts.set(guildId, {
        serverName: 'Servidor Desconocido',
        prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION,
        language: CONFIG.DEFAULT_LANG,
        replyToLayla: false,
        triggers: triggersList
      });
    }
    this._savePrompts();
    return true;
  }

  getReplySetting(guildId) {
    if (!guildId || !this.prompts.has(guildId)) return false;
    return !!this.prompts.get(guildId).replyToLayla;
  }

  setReplySetting(guildId, isEnabled) {
    if (!guildId) return false;
    if (this.prompts.has(guildId)) {
      this.prompts.get(guildId).replyToLayla = !!isEnabled;
    } else {
      this.prompts.set(guildId, {
        serverName: 'Servidor Desconocido',
        prompt: CONFIG.LIVE_SYSTEM_INSTRUCTION,
        language: CONFIG.DEFAULT_LANG,
        replyToLayla: !!isEnabled,
        triggers: []
      });
    }
    this._savePrompts();
    return true;
  }
}

export default new GuildPromptManager();
