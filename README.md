# Layla Discord Bot

Bot de Discord con integracion a Gemini para responder por texto o TTS
Poco a poco se estan agregando funciones de moderacion 

# API GEMINI

La conversaciones con el TTS se hacen usando Live API para no hacer tts de las mismas respuestas y asi ahorrar tokens. El bitrate tambien esta optimizado

# Docker engine

Este proyecto usa docker compose para correr en un entorno virtual y seguro. Esta pensado para usar un tunel de cloudflare pero es totalmente posible abrir puertos si es necesario

# Comandos utiles 

Si desea continuar usando docker compose:

`doocker compose up -d --build`


