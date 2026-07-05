import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

class GlobalSettingsManager {
  constructor() {
    this.settings = {
      RESPOND_ON_MENTION: true,
      BOT_FRIENDS: []
    };
    this._loadSettings();
  }

  _loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        this.settings = { ...this.settings, ...parsed };
      }
    } catch (e) {
      console.error(`[GlobalSettingsManager] Error leyendo settings.json:`, e.message);
    }
  }

  _saveSettings() {
    fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), 'utf8')
      .catch(e => console.error(`[GlobalSettingsManager] Error guardando settings.json:`, e.message));
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value) {
    this.settings[key] = value;
    this._saveSettings();
    console.log(`[GlobalSettingsManager] Ajuste actualizado: ${key} = ${value}`);
  }

  getAll() {
    return this.settings;
  }
}

export default new GlobalSettingsManager();
