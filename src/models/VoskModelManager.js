import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const VOSK_MODEL_DIR = path.join(process.cwd(), 'vosk-model');

// Catálogo oficial de modelos small de Vosk (alphacephei.com)
const VOSK_CATALOG = {
  es: { name: 'Español',    model: 'vosk-model-small-es-0.42',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip' },
  en: { name: 'English',    model: 'vosk-model-small-en-us-0.15', url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip' },
  fr: { name: 'Français',   model: 'vosk-model-small-fr-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip' },
  de: { name: 'Deutsch',    model: 'vosk-model-small-de-0.15',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip' },
  it: { name: 'Italiano',   model: 'vosk-model-small-it-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-it-0.22.zip' },
  pt: { name: 'Português',  model: 'vosk-model-small-pt-0.3',   url: 'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip' },
  nl: { name: 'Nederlands', model: 'vosk-model-small-nl-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-nl-0.22.zip' },
  ru: { name: 'Русский',    model: 'vosk-model-small-ru-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip' },
  ja: { name: '日本語',      model: 'vosk-model-small-ja-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip' },
  cn: { name: '中文',        model: 'vosk-model-small-cn-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip' },
  tr: { name: 'Türkçe',     model: 'vosk-model-small-tr-0.3',   url: 'https://alphacephei.com/vosk/models/vosk-model-small-tr-0.3.zip' },
  ko: { name: '한국어',      model: 'vosk-model-small-ko-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-ko-0.22.zip' },
  hi: { name: 'हिन्दी',       model: 'vosk-model-small-hi-0.22',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip' },
  ca: { name: 'Català',     model: 'vosk-model-small-ca-0.4',   url: 'https://alphacephei.com/vosk/models/vosk-model-small-ca-0.4.zip' },
  fa: { name: 'فارسی',      model: 'vosk-model-small-fa-0.42',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip' },
  vn: { name: 'Tiếng Việt', model: 'vosk-model-small-vn-0.4',   url: 'https://alphacephei.com/vosk/models/vosk-model-small-vn-0.4.zip' },
  uk: { name: 'Українська',  model: 'vosk-model-small-uk-v3-nano', url: 'https://alphacephei.com/vosk/models/vosk-model-small-uk-v3-nano.zip' },
  kz: { name: 'Қазақша',    model: 'vosk-model-small-kz-0.42',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-kz-0.42.zip' },
  eo: { name: 'Esperanto',  model: 'vosk-model-small-eo-0.42',  url: 'https://alphacephei.com/vosk/models/vosk-model-small-eo-0.42.zip' },
};

let vosk = null;

// Intentar cargar la librería vosk-koffi
try {
  const v = await import('vosk-koffi');
  vosk = v.default || v;
  vosk.setLogLevel(-1);
  console.log('✅ [VOSK] Librería vosk-koffi cargada.');
} catch (e) {
  console.error('❌ [VOSK] Librería vosk-koffi no encontrada. Wake word desactivado.');
}

class VoskModelManager {
  constructor() {
    // Caché en memoria: langCode → vosk.Model instance
    this.loadedModels = new Map();
    // Descargas en progreso: langCode → Promise
    this.pendingDownloads = new Map();

    // Asegurar que el directorio de modelos exista
    if (!fs.existsSync(VOSK_MODEL_DIR)) {
      fs.mkdirSync(VOSK_MODEL_DIR, { recursive: true });
    }
  }

  /**
   * Devuelve el catálogo de idiomas disponibles para el frontend.
   */
  getCatalog() {
    return Object.entries(VOSK_CATALOG).map(([code, info]) => ({
      code,
      name: info.name,
    }));
  }

  /**
   * Verifica si un código de idioma es válido en el catálogo.
   */
  isValidLang(langCode) {
    return VOSK_CATALOG.hasOwnProperty(langCode);
  }

  /**
   * Devuelve true si la librería vosk está disponible.
   */
  isAvailable() {
    return vosk !== null;
  }

  /**
   * Devuelve la instancia de vosk (para crear Recognizers externamente).
   */
  getVosk() {
    return vosk;
  }

  /**
   * Obtiene un modelo Vosk cargado en memoria.
   * Si no está en memoria pero sí en disco, lo carga.
   * Si no está en disco, lo descarga automáticamente.
   * Devuelve null si vosk no está disponible o el idioma no es válido.
   */
  async getModel(langCode) {
    if (!vosk) return null;
    if (!this.isValidLang(langCode)) {
      console.error(`⚠️ [VOSK] Idioma '${langCode}' no existe en el catálogo.`);
      return null;
    }

    // 1. Si ya está en memoria, devolverlo directamente
    if (this.loadedModels.has(langCode)) {
      return this.loadedModels.get(langCode);
    }

    const catalogEntry = VOSK_CATALOG[langCode];
    const modelPath = path.join(VOSK_MODEL_DIR, catalogEntry.model);

    // 2. Si está en disco pero no en memoria, cargarlo
    if (fs.existsSync(modelPath)) {
      try {
        const model = new vosk.Model(modelPath);
        this.loadedModels.set(langCode, model);
        console.log(`✅ [VOSK] Modelo '${catalogEntry.name}' (${langCode}) cargado desde disco.`);
        return model;
      } catch (e) {
        console.error(`❌ [VOSK] Error al cargar modelo '${langCode}' desde disco:`, e.message);
        return null;
      }
    }

    // 3. Si hay una descarga en progreso para este idioma, esperar a que termine
    if (this.pendingDownloads.has(langCode)) {
      console.log(`⏳ [VOSK] Ya hay una descarga en progreso para '${langCode}', esperando...`);
      return this.pendingDownloads.get(langCode);
    }

    // 4. Descargar el modelo
    const downloadPromise = this._downloadAndLoad(langCode);
    this.pendingDownloads.set(langCode, downloadPromise);

    try {
      const model = await downloadPromise;
      return model;
    } finally {
      this.pendingDownloads.delete(langCode);
    }
  }

  /**
   * Descarga un modelo zip, lo descomprime y lo carga en memoria.
   */
  async _downloadAndLoad(langCode) {
    const entry = VOSK_CATALOG[langCode];
    const zipPath = path.join(VOSK_MODEL_DIR, `${entry.model}.zip`);

    console.log(`📥 [VOSK] Descargando modelo '${entry.name}' (${langCode})...`);
    console.log(`   URL: ${entry.url}`);

    try {
      // Descargar el archivo ZIP
      await this._downloadFile(entry.url, zipPath);
      console.log(`📦 [VOSK] Descarga completa. Descomprimiendo '${entry.model}'...`);

      // Descomprimir con unzip del sistema
      execSync(`unzip -o -q "${zipPath}" -d "${VOSK_MODEL_DIR}"`, { timeout: 120000 });

      // Eliminar el ZIP para ahorrar espacio
      fs.unlinkSync(zipPath);

      const modelPath = path.join(VOSK_MODEL_DIR, entry.model);
      if (!fs.existsSync(modelPath)) {
        throw new Error(`La carpeta del modelo '${entry.model}' no se encontró después de descomprimir.`);
      }

      // Cargar el modelo en memoria
      const model = new vosk.Model(modelPath);
      this.loadedModels.set(langCode, model);
      console.log(`✅ [VOSK] Modelo '${entry.name}' (${langCode}) listo para usar.`);
      return model;
    } catch (e) {
      console.error(`❌ [VOSK] Error al descargar/instalar modelo '${langCode}':`, e.message);
      // Limpiar archivo ZIP si quedó a medias
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
      return null;
    }
  }

  /**
   * Descarga un archivo desde una URL (sigue redirecciones).
   */
  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);

      const request = protocol.get(url, (response) => {
        // Seguir redirecciones (301, 302, 303, 307, 308)
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return this._downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`HTTP ${response.statusCode} al descargar ${url}`));
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;
        let lastPercent = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize) {
            const percent = Math.floor((downloaded / totalSize) * 100);
            if (percent >= lastPercent + 25) {
              console.log(`   📥 [VOSK] Progreso: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
              lastPercent = percent;
            }
          }
        });

        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      });

      request.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        reject(err);
      });

      // Timeout de 5 minutos para la descarga
      request.setTimeout(300000, () => {
        request.destroy();
        reject(new Error('Timeout de descarga (5 min)'));
      });
    });
  }
}

export default new VoskModelManager();
