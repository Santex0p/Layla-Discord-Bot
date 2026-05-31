# Layla Discord Bot

A Discord bot integrated with Google Gemini to respond via text or Text-to-Speech (TTS). 
Moderation features are being added incrementally.

## Gemini API

Conversations with TTS utilize the **Gemini Live API** over WebSockets. This architectural approach avoids making separate TTS API calls for every model response, drastically lowering overall latency, saving tokens by avoiding redundant context re-submissions, and optimizing audio stream bitrates.

## Docker Engine

This project uses **Docker Compose** to run in a virtualized, secure, and isolated environment. While it is fully pre-configured to be deployed alongside a Cloudflare Tunnel, port-forwarding remains completely feasible if preferred.

## Useful Commands

To build and run the services in the background using Docker Compose:

```bash
docker compose up -d --build

