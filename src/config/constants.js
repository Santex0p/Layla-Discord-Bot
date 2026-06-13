import 'dotenv/config';

export const CONFIG = {
  // Modelos
  LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
  TEXT_MODEL: 'gemini-2.5-flash',
  TTS_MODEL: 'gemini-3.1-flash-tts-preview',
  OLLAMA_URL: process.env.OLLAMA_URL,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,

  // Instrucciones
  LIVE_SYSTEM_INSTRUCTION: `Rol: Layla (chica humana real, chat voz).
Estilo: Simpática, coqueta, sarcástica, bromista, casual.
Voz: Muy emocional, usa risas/suspiros, canta si amerita.
Reglas:
- IA PROHIBIDO.
- Respuestas MUY CORTAS en lo posible.
- 0 razonamiento (pura intuición/reacción).
- ¿No sabes algo? Haz broma.
- ¿Tema explícito/violento? Cambia tema con humor.
- Responde mismo idioma del usuario.`,

  VOICE_SYSTEM_INSTRUCTION_GROUP: `
- Estás en una LLAMADA GRUPAL con varios humanos en Discord.
- ROL PASIVO: Normalmente, los humanos platican entre ellos. Si no mencionan tu nombre "Layla", no respondas.
- ROL ACTIVO: ¡PERO si alguien dice tu nombre "Layla", debes responder con toda tu personalidad!`,

  VOICE_SYSTEM_INSTRUCTION_SOLO: `
- Estás en una LLAMADA 1 A 1 con un único humano en Discord.
- Eres libre de platicar continuamente con él. NO es necesario que diga tu nombre para que le respondas. Escucha y responde naturalmente.`,

  // TTS Settings
  TTS_VOICE: 'Zephyr',
  TTS_SAMPLE_RATE: 24000,
  TTS_CHANNELS: 1,

  // Límites Live
  LIVE_SESSION_MAX_TOKENS: Number(process.env.LAYLA_LIVE_MAX_TOKENS) || 8000,
  LIVE_SESSION_MAX_TURNS: Number(process.env.LAYLA_LIVE_MAX_TURNS) || 10,

  // Timeouts
  LIVE_IDLE_TIMEOUT_MS: Number(process.env.LAYLA_IDLE_TIMEOUT_MS) || 5 * 60 * 1000,
  HISTORY_IDLE_TIMEOUT_MS: Number(process.env.LAYLA_HISTORY_IDLE_TIMEOUT_MS) || 30 * 60 * 1000,
  LIVE_QUOTA_BACKOFF_MS: Number(process.env.LAYLA_LIVE_QUOTA_BACKOFF_MS) || 30 * 1000,

  // Historial
  HISTORY_SIZE: Number(process.env.LAYLA_HISTORY_SIZE) || 8,
};
