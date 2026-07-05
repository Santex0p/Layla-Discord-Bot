/**
 * Módulo de Esteganografía para Discord (Versión Optimizada)
 * Oculta texto usando un enlace Markdown invisible con Base64
 * para evitar el límite de 2000/4000 caracteres de Discord.
 */

/**
 * Convierte texto normal a un enlace Markdown invisible en Base64.
 * @param {string} text - El texto a ocultar
 * @returns {string} - Cadena con el enlace invisible
 */
export function encodeZeroWidth(text) {
  if (!text) return '';
  // Convertir a Base64
  const base64 = Buffer.from(text).toString('base64');
  // Usar Braille Pattern Blank (\u2800) que Discord reconoce como letra pero es invisible
  return ` [\u2800](https://layla.hidden/?d=${base64})`;
}

/**
 * Extrae texto normal desde el enlace oculto en Base64.
 * @param {string} text - El mensaje de Discord
 * @returns {string} - El texto decodificado
 */
export function decodeZeroWidth(text) {
  if (!text) return '';
  
  // Buscar el parámetro Base64 en el enlace
  const match = text.match(/https:\/\/layla\.hidden\/\?d=([A-Za-z0-9+/=]+)/);
  if (match && match[1]) {
    try {
      return Buffer.from(match[1], 'base64').toString('utf-8');
    } catch (e) {
      return '';
    }
  }
  return '';
}
