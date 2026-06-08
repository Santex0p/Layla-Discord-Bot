export default {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(`✅ [CONEXIÓN] ¡Bot Layla conectado con éxito como ${client.user.tag}!`);
    try {
      const appId = client.application?.id || (client.application && client.application.id) || process.env.APP_ID || 'desconocido';
      console.log(`🔎 [APP] Application ID: ${appId}`);
    } catch (e) {
      console.warn('No se pudo obtener client.application.id:', e);
    }
  }
};
