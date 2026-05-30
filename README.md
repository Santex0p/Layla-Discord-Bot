# Layla Discord Bot

Bot de Discord con integracion a Gemini para responder por texto y adjuntar una version hablada de la respuesta.

## Estado actual

Layla ahora usa un enfoque hibrido:

1. Intenta abrir una sesion persistente con Gemini Live API.
2. Si la cuenta o el modelo no soportan alguna capacidad Live, cae automaticamente a `generateContent() + TTS`.
3. En ambos casos devuelve audio, lo convierte a `.mp3` y lo manda como adjunto en Discord.

Ese cambio mantiene la optimizacion cuando Live funciona, pero evita que el bot se rompa cuando la API responde con cierres tipo `1008` por capacidades no habilitadas.

## Por que se hizo asi

El flujo previo hacia dos cosas por cada mensaje:

1. Generar texto con `generateContent()`.
2. Reenviar ese texto a un modelo TTS.

Eso duplicaba trabajo, tokens y latencia. Con Live API, la misma sesion hace el turno conversacional y devuelve audio nativo dentro del mismo canal WebSocket.

La diferencia conceptual queda asi:

- `Chat/Text generation`: generar la respuesta escrita.
- `TTS`: leer un texto ya generado con una voz elegida.
- `Live API`: conversacion de audio bidireccional y en tiempo real por WebSocket.

La repo de referencia `Mark-XXXIX` usa el tercer caso. Este proyecto ahora prioriza `Live API`, aunque todavia lo hace sobre mensajes de chat y no dentro de un canal de voz de Discord. Si Live no esta disponible, vuelve temporalmente al segundo caso sin interrumpir la experiencia.

## Flujo implementado

El flujo principal vive en `app.js`:

1. El usuario escribe en Discord cuando `!layla on` esta activo.
2. `ensureLiveSession()` abre o reutiliza una sesion Live persistente con config minima.
3. `enqueueLiveTurn()` serializa los mensajes y manda un turno estructurado (`role + parts`).
4. `handleLiveMessage()` junta audio, transcripcion y metadata hasta completar el turno.
5. Si Live falla por cierre o capacidad no soportada, `generateVoiceReplyFallback()` genera texto con `generateContent()` y luego audio con un modelo TTS dedicado.
6. `pcm16ToMp3Buffer()` convierte el PCM a MP3.
7. Discord recibe el texto transcripto y el archivo `layla_voice.mp3`.

## Detalles de la sesion Live

- El modelo configurado es `gemini-2.5-flash-native-audio-preview-12-2025`.
- La voz configurada sigue siendo `Zephyr`.
- La configuracion Live se redujo a lo minimo posible para evitar cierres `1008` por features preview no habilitadas.
- La sesion solo intenta `sessionResumption` si ya existe un handle valido de una sesion anterior.
- Los mensajes se procesan de a uno para no mezclar audio entre usuarios o entre turnos seguidos.
- Si Live se declara incompatible durante la ejecucion, el bot marca la sesion como deshabilitada y usa fallback en los siguientes turnos.

## Modelos usados

- `gemini-2.5-flash-native-audio-preview-12-2025`: generar la respuesta conversacional y el audio nativo en la misma sesion.
- `gemini-2.5-flash`: generar texto cuando hay que degradar a modo fallback.
- `gemini-3.1-flash-tts-preview`: sintetizar voz cuando Live no esta disponible.
- `Zephyr`: voz predefinida elegida para la salida de audio.

Estos valores estan definidos al inicio de `app.js` para que puedas cambiarlos rapido.

## Funciones importantes

- `pcm16ToMp3Buffer()`: usa `ffmpeg-static` para codificar el PCM crudo de Gemini a MP3.
- `extractInlineAudioData()`: normaliza los bytes devueltos por el SDK a un `Buffer` de Node.js.
- `generateVoiceReplyFallback()`: resuelve texto + TTS cuando Live no esta disponible.
- `ensureLiveSession()`: crea o reutiliza la sesion Live.
- `enqueueLiveTurn()`: serializa y envia cada turno del chat.
- `handleLiveMessage()`: junta audio, transcripcion y metadata hasta cerrar el turno actual.

## Limitaciones actuales

- No entra a canales de voz de Discord.
- No reproduce audio en tiempo real.
- Usa `Live API` solo para mensajes de texto y no transmite audio directo a un voice channel de Discord.
- El usuario sigue escribiendo texto; no hay captura de microfono ni audio entrante.
- Los turnos se serializan sobre una sola sesion, asi que no es un bot multi-canal de voz todavia.
- La conversion a MP3 depende de que `ffmpeg-static` quede instalado correctamente con `npm install`.
- Cuando Live queda deshabilitado por incompatibilidad de cuenta o modelo, el bot pierde la ventaja de contexto persistente hasta reiniciarse.

## Si quieres llegar al modo "Jarvis"

Para acercarte al comportamiento de la repo de referencia, faltaria otra capa tecnica:

1. Unirse a un canal de voz con `@discordjs/voice`.
2. Capturar y/o enviar audio en tiempo real.
3. Reusar esta misma sesion con Gemini `Live API` para audio entrante y saliente en streaming.
4. Convertir el PCM de salida a un stream reproducible por Discord.
5. Manejar interrupciones, latencia, colas de audio y reconexion.

Eso ya no es solo Live por texto. Es una integracion de voz en tiempo real dentro de Discord.

## Variables de entorno

Se esperan estas variables:

- `DISCORD_TOKEN` o `TOKEN`
- `GEMINI_KEY`

## Comandos utiles

```powershell
npm install
node app.js
node commands.js
node --check app.js
```

## Siguiente paso recomendado

Si quieres mantener el bot simple, este enfoque hibrido te deja usar Live cuando existe soporte real y conservar una salida estable cuando no lo hay.

Si quieres voz en canal con comportamiento parecido a `Mark-XXXIX`, el siguiente trabajo es integrar `@discordjs/voice` sobre esta base Live ya migrada.
