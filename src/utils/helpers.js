
export function isPcmMimeType(mimeType) {
  if (!mimeType) return false;
  const normalizedMime = mimeType.toLowerCase();
  return normalizedMime.startsWith('audio/pcm') || normalizedMime.startsWith('audio/l16');
}

export function extractTextFromParts(parts = []) {
  return parts
    .map((part) => part?.text?.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function extractInlineAudioData(part) {
  if (!part?.inlineData?.data) return null;
  if (Buffer.isBuffer(part.inlineData.data)) return part.inlineData.data;
  if (part.inlineData.data instanceof Uint8Array) return Buffer.from(part.inlineData.data);
  if (typeof part.inlineData.data === 'string') return Buffer.from(part.inlineData.data, 'base64');
  return null;
}

export function extractResponseText(response) {
  if (typeof response?.text === 'string' && response.text.trim()) return response.text.trim();
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const text = extractTextFromParts(candidate?.content?.parts || []);
    if (text) return text;
  }
  return '';
}

export function extractAudioPartFromResponse(response) {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (!part?.inlineData?.mimeType?.startsWith('audio/')) continue;
      const audioBuffer = extractInlineAudioData(part);
      if (audioBuffer) return { audioBuffer, mimeType: part.inlineData.mimeType };
    }
  }
  return null;
}

export function shouldDisableLive(error) {
  const message = String(error?.message || error || '').toLowerCase();
  // 400 = Bad Request (Usually malformed input, invalid API key, etc)
  // 404 = Model Not Found (Wrong model name in config)
  // Eliminamos 1008 porque son cierres forzosos transitorios de Google o limites de seguridad.
  return message.includes('400') || message.includes('404');
}

export function isQuotaError(error) {
  if (error?.status === 429) return true;
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('429')
    || msg.includes('quota')
    || msg.includes('cuota')
    || msg.includes('rate limit')
    || msg.includes('resource_exhausted')
    || msg.includes('resource exhausted')
    || msg.includes('too many requests');
}

export function isInterruptedTurnError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('interrumpio el turno');
}

export function isMissingAudioError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('no devolvio audio en el turno');
}

export function resolveMentionsInContent(message) {
  if (!message || typeof message.content !== 'string') return '';
  let content = message.content;

  try {
    const users = message.mentions?.users || new Map();
    users.forEach((user) => {
      const member = message.guild?.members?.cache?.get(user.id) || null;
      const name = (member && member.displayName) || user.username || 'usuario';
      const userRegex = new RegExp(`<@!?${user.id}>`, 'g');
      content = content.replace(userRegex, `${name}`);
    });

    const roles = message.mentions?.roles || new Map();
    roles.forEach((role) => {
      const roleRegex = new RegExp(`<@&${role.id}>`, 'g');
      content = content.replace(roleRegex, `${role.name}`);
    });

    const channels = message.mentions?.channels || new Map();
    channels.forEach((ch) => {
      const chRegex = new RegExp(`<#${ch.id}>`, 'g');
      content = content.replace(chRegex, `#${ch.name}`);
    });
  } catch (e) {
    return message.content;
  }

  return content;
}
