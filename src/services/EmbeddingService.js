import { GoogleGenAI } from '@google/genai';

/**
 * EmbeddingService — Proveedor de embeddings abstraído.
 */
class GeminiEmbeddingProvider {
  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_KEY });
    this.model = 'gemini-embedding-001';
    this._lastCallMs = 0;
    this._minDelayMs = 4200; // ~14 RPM safe (free tier = 15 RPM)
  }

  /**
   * Convierte un texto en un vector numérico (embedding).
   * Incluye rate-limit interno para no saturar la API.
   * @param {string} text 
   * @returns {Promise<number[]>}
   */
  async getEmbedding(text) {
    // Rate-limit interno
    const now = Date.now();
    const elapsed = now - this._lastCallMs;
    if (elapsed < this._minDelayMs) {
      await new Promise(r => setTimeout(r, this._minDelayMs - elapsed));
    }
    this._lastCallMs = Date.now();

    const response = await this.ai.models.embedContent({
      model: this.model,
      contents: text,
    });

    return response.embeddings[0].values;
  }
}

/**
 * Calcula la similitud del coseno entre dos vectores.
 * Retorna un valor entre -1 y 1 (1 = idénticos, 0 = sin relación).
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

// Singleton — El proveedor se puede cambiar aquí en el futuro
const embeddingService = new GeminiEmbeddingProvider();
export default embeddingService;
