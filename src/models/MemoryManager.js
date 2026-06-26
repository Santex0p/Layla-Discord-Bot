import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import embeddingService, { cosineSimilarity } from '../services/EmbeddingService.js';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const RELATIONSHIPS_FILE = path.join(DATA_DIR, 'relationships.json');
const GLOBAL_RELATIONSHIPS_FILE = path.join(DATA_DIR, 'global_relationships.json');
const MEMORIES_FILE = path.join(DATA_DIR, 'memories.json');

// Umbrales
const SIMILARITY_THRESHOLD = 0.65;   // Mínimo para inyectar un recuerdo
const DUPLICATE_THRESHOLD = 0.90;    // Máximo para considerar un recuerdo como duplicado
const MAX_INJECTED_MEMORIES = 3;     // Máximo de recuerdos inyectados por mensaje
const EXTRACTION_INTERVAL = 15;      // Cada cuántos mensajes se extraen memorias

class MemoryManager {
  constructor() {
    this.relationships = {};        // { guildId: { userId: { name, relationship } } }
    this.globalRelationships = {};  // { userId: { name, relationship } }
    this.memories = {};             // { guildId: { userId: [ { id, text, embedding, createdAt } ] } }
    this.messageCounters = new Map(); // guildId:userId → count
    this._loadRelationships();
    this._loadGlobalRelationships();
    this._loadMemories();
  }

  // ==================== PERSISTENCIA ====================

  _loadRelationships() {
    try {
      if (fs.existsSync(RELATIONSHIPS_FILE)) {
        const data = fs.readFileSync(RELATIONSHIPS_FILE, 'utf8');
        this.relationships = JSON.parse(data);
      }
    } catch (e) {
      console.error('[MemoryManager] Error leyendo relationships.json:', e.message);
      this.relationships = {};
    }
  }

  _saveRelationships() {
    fs.promises.writeFile(RELATIONSHIPS_FILE, JSON.stringify(this.relationships, null, 2), 'utf8')
      .catch(e => console.error('[MemoryManager] Error guardando relationships.json:', e.message));
  }

  _loadGlobalRelationships() {
    try {
      if (fs.existsSync(GLOBAL_RELATIONSHIPS_FILE)) {
        const data = fs.readFileSync(GLOBAL_RELATIONSHIPS_FILE, 'utf8');
        this.globalRelationships = JSON.parse(data);
      }
    } catch (e) {
      console.error('[MemoryManager] Error leyendo global_relationships.json:', e.message);
      this.globalRelationships = {};
    }
  }

  _saveGlobalRelationships() {
    fs.promises.writeFile(GLOBAL_RELATIONSHIPS_FILE, JSON.stringify(this.globalRelationships, null, 2), 'utf8')
      .catch(e => console.error('[MemoryManager] Error guardando global_relationships.json:', e.message));
  }

  _loadMemories() {
    try {
      if (fs.existsSync(MEMORIES_FILE)) {
        const data = fs.readFileSync(MEMORIES_FILE, 'utf8');
        this.memories = JSON.parse(data);
      }
    } catch (e) {
      console.error('[MemoryManager] Error leyendo memories.json:', e.message);
      this.memories = {};
    }
  }

  _saveMemories() {
    fs.promises.writeFile(MEMORIES_FILE, JSON.stringify(this.memories, null, 2), 'utf8')
      .catch(e => console.error('[MemoryManager] Error guardando memories.json:', e.message));
  }

  // ==================== RELACIONES (Capa 1) ====================

  getRelationship(guildId, userId) {
    if (!guildId || !userId) return null;
    return this.relationships[guildId]?.[userId] || null;
  }

  getAllRelationships(guildId) {
    if (!guildId) return {};
    return this.relationships[guildId] || {};
  }

  setRelationship(guildId, userId, name, relationship) {
    if (!guildId || !userId) return false;
    if (!this.relationships[guildId]) {
      this.relationships[guildId] = {};
    }
    this.relationships[guildId][userId] = { name, relationship };
    this._saveRelationships();
    console.log(`[MemoryManager] Relación guardada: ${name} (${userId}) en servidor ${guildId}`);
    return true;
  }

  deleteRelationship(guildId, userId) {
    if (!guildId || !userId) return false;
    if (this.relationships[guildId]?.[userId]) {
      delete this.relationships[guildId][userId];
      this._saveRelationships();
      return true;
    }
    return false;
  }

  // ==================== RELACIONES GLOBALES ====================

  getGlobalRelationship(userId) {
    if (!userId) return null;
    return this.globalRelationships[userId] || null;
  }

  getAllGlobalRelationships() {
    return this.globalRelationships;
  }

  setGlobalRelationship(userId, name, relationship) {
    if (!userId) return false;
    this.globalRelationships[userId] = { name, relationship };
    this._saveGlobalRelationships();
    console.log(`[MemoryManager] Relación Global guardada: ${name} (${userId})`);
    return true;
  }

  deleteGlobalRelationship(userId) {
    if (!userId) return false;
    if (this.globalRelationships[userId]) {
      delete this.globalRelationships[userId];
      this._saveGlobalRelationships();
      return true;
    }
    return false;
  }

  /**
   * Construye el texto de inyección de relación para el prompt.
   * Se inyecta SIEMPRE que ese usuario habla.
   * Combina relación global y de servidor si ambas existen.
   */
  buildRelationshipContext(guildId, userId) {
    const globalRel = this.getGlobalRelationship(userId);
    const localRel = this.getRelationship(guildId, userId);

    if (!globalRel && !localRel) return '';

    let context = '(Recuerda: Estás hablando con este usuario:';
    if (globalRel) {
      context += ` A nivel global es tu administrador Supremo: ${globalRel.name}. ${globalRel.relationship}.`;
    }
    if (localRel) {
      context += ` En este servidor le apodan ${localRel.name}. ${localRel.relationship}.`;
    }
    context += ')';
    
    return context;
  }

  // ==================== MEMORIAS (Capa 2) ====================

  getAllMemories(guildId) {
    if (!guildId) return {};
    return this.memories[guildId] || {};
  }

  getUserMemories(guildId, userId) {
    if (!guildId || !userId) return [];
    return this.memories[guildId]?.[userId] || [];
  }

  /**
   * Añade una memoria manualmente (desde Dashboard) o automáticamente.
   * Convierte el texto a embedding y lo almacena.
   * Retorna true si se guardó, false si es duplicado.
   */
  async addMemory(guildId, userId, text) {
    if (!guildId || !userId || !text) return false;

    try {
      const embedding = await embeddingService.getEmbedding(text);

      // Verificar duplicados
      const existingMemories = this.getUserMemories(guildId, userId);
      for (const mem of existingMemories) {
        const similarity = cosineSimilarity(embedding, mem.embedding);
        if (similarity >= DUPLICATE_THRESHOLD) {
          console.log(`[MemoryManager] Memoria duplicada descartada (similitud ${(similarity * 100).toFixed(1)}%): "${text}"`);
          return false;
        }
      }

      // Guardar
      if (!this.memories[guildId]) this.memories[guildId] = {};
      if (!this.memories[guildId][userId]) this.memories[guildId][userId] = [];

      this.memories[guildId][userId].push({
        id: crypto.randomUUID(),
        text,
        embedding,
        createdAt: Date.now(),
      });

      this._saveMemories();
      console.log(`🧠 [MEMORIA] Nueva memoria guardada para ${userId} en ${guildId}: "${text}"`);
      return true;
    } catch (error) {
      console.warn(`[MemoryManager] Error creando embedding para memoria:`, error.message);
      return false;
    }
  }

  deleteMemory(guildId, userId, memoryId) {
    if (!guildId || !userId || !memoryId) return false;
    const userMems = this.memories[guildId]?.[userId];
    if (!userMems) return false;

    const index = userMems.findIndex(m => m.id === memoryId);
    if (index === -1) return false;

    userMems.splice(index, 1);
    this._saveMemories();
    return true;
  }

  /**
   * Busca las memorias más relevantes para un mensaje dado.
   * Convierte el mensaje a embedding y busca por similitud del coseno.
   * Retorna un array de strings (los textos de los recuerdos relevantes).
   */
  async getRelevantMemories(guildId, userId, messageText) {
    if (!guildId || !userId || !messageText) return [];

    const userMems = this.getUserMemories(guildId, userId);
    if (userMems.length === 0) return [];

    try {
      const queryEmbedding = await embeddingService.getEmbedding(messageText);

      const scored = userMems
        .map(mem => ({
          text: mem.text,
          score: cosineSimilarity(queryEmbedding, mem.embedding),
        }))
        .filter(m => m.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_INJECTED_MEMORIES);

      return scored.map(m => m.text);
    } catch (error) {
      // Si el embedding falla (rate limit, etc.), simplemente no inyectamos memorias
      console.warn(`[MemoryManager] Error buscando memorias relevantes:`, error.message);
      return [];
    }
  }

  /**
   * Construye el texto de inyección de memorias para el prompt.
   */
  buildMemoryContext(relevantMemories) {
    if (!relevantMemories || relevantMemories.length === 0) return '';
    return `(Recuerdos sobre este usuario: ${relevantMemories.join('. ')})`;
  }

  // ==================== EXTRACCIÓN AUTOMÁTICA ====================

  /**
   * Incrementa el contador de mensajes de un usuario en un servidor.
   * Retorna true si se alcanzó el umbral de extracción.
   */
  incrementMessageCount(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const current = (this.messageCounters.get(key) || 0) + 1;
    this.messageCounters.set(key, current);

    if (current >= EXTRACTION_INTERVAL) {
      this.messageCounters.set(key, 0);
      return true; // Toca extraer
    }
    return false;
  }

  /**
   * Procesa una lista de hechos extraídos por la IA y los guarda como memorias.
   * Incluye un filtro de seguridad para rechazar hechos que intenten redefinir relaciones.
   * @param {string} guildId 
   * @param {string} userId 
   * @param {Array<{text: string}>} facts 
   */
  async processExtractedFacts(guildId, userId, facts) {
    if (!Array.isArray(facts) || facts.length === 0) return;

    // Patrones de relación que NUNCA deben guardarse como memoria automática
    const relationshipPatterns = /\b(soy tu|es (mi|su|tu) |es el |es la |mi (padre|madre|novio|novia|esposo|esposa|pareja|creador|dueño|jefe|hermano|hermana|hijo|hija|papi|mami|papa|mama|daddy|mommy|owner|creator|boyfriend|girlfriend|husband|wife))\b/i;

    let saved = 0;
    for (const fact of facts) {
      const text = typeof fact === 'string' ? fact : fact.text;
      if (!text || text.length < 5) continue;

      // Filtro de seguridad: rechazar hechos con patrones de relación
      if (relationshipPatterns.test(text)) {
        console.log(`🛡️ [MEMORIA] Hecho rechazado (intento de relación): "${text}"`);
        continue;
      }

      const didSave = await this.addMemory(guildId, userId, text);
      if (didSave) saved++;
    }

    if (saved > 0) {
      console.log(`🧠 [MEMORIA] ${saved} nuevos recuerdos extraídos para ${userId} en ${guildId}.`);
    }
  }
}

export default new MemoryManager();
