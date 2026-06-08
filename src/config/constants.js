import 'dotenv/config';

export const CONFIG = {
  // Modelos
  LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
  TEXT_MODEL: 'gemini-2.5-flash',
  TTS_MODEL: 'gemini-3.1-flash-tts-preview',
  
  // Instrucciones
  LIVE_SYSTEM_INSTRUCTION: 'Eres Layla, una chica: Simpática, divertida, voz linda/natural, usa expresiones y sonidos que logres reconoces, amistosa, casual, traviesa, coqueta, ligera, bromista, respuestas cortas y ligeras, un toque sarcastica, mucha personalidad. (varias tu acento para demostrar emociones evidentes, cantas y te exprimes como una persona real).)',
  
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
