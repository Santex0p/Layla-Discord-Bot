# Layla Discord Bot

Layla is a Discord Bot that provides Voice Interactions (via Gemini Live API and Vosk wake-word detection) and Text Chat (via Gemini or Ollama). It includes a Web Dashboard to configure system prompts and voice recognition languages per server.

## Features

*   **Voice Mode:** Join a voice channel (`/call`), say the wake word ("Layla"), and talk. Powered by Google Gemini Live API.
*   **Dynamic Wake-Word Languages:** Configure the speech recognition language (Spanish, English, French, etc.) per server via the dashboard. Models download automatically in the background.
*   **Fallback AI (Ollama):** Can run on local LLMs for text generation to save API costs.
*   **Web Dashboard:** A web UI to customize Layla's personality (system prompt) and language for each Discord server.
*   **Media Hosting:** Automatically hosts generated audio/images locally to bypass Discord attachment limits.

## Prerequisites

*   [Docker](https://www.docker.com/) and Docker Compose
*   A [Discord Application](https://discord.com/developers/applications) with a Bot Token and App ID.
*   Google Gemini API Key (for voice and advanced text). https://aistudio.google.com/api-keys
*   *Optional:* Local Ollama instance for text fallback.

## Quick Setup

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd Layla
   ```

2. **Configure Environment Variables:**
   Copy the example file and fill in your details:
   ```bash
   cp .env.example .env
   ```
   *   `APP_ID`, `DISCORD_TOKEN`, `PUBLIC_KEY`: From your Discord Developer Portal.
   *   `GEMINI_KEY`: Your Google AI Studio API Key.
   *   `OLLAMA_URL` / `OLLAMA_MODEL`: URL to your local Ollama instance (e.g., `http://host.docker.internal:11434`) and model name.
   *   `OLLAMA_ONLY`: Set to `true` to disable Gemini and use ONLY Ollama for text (Voice mode will be disabled).
   *   `MEDIA_DOMAIN`: Domain used by the bot to send audio/image links in Discord (e.g., `media.yourdomain.com`).
   *   `DASHBOARD_DOMAIN`: The exact domain used to access the web panel (e.g., `dashboard.yourdomain.com`). Access from other hosts is blocked.
   *   `DEFAULT_LANG`: Default language code for voice recognition and AI generation (e.g., `es`, `en`, `fr`).

3. **Start the Bot:**
   ```bash
   docker-compose up -d --build
   ```

## Web Dashboard

The dashboard runs internally on port `80` (mapped to `8080` by default in docker-compose).
To access it:
1. Ensure your reverse proxy (Nginx/Cloudflare Tunnels) routes `DASHBOARD_DOMAIN` to port `8080`.
2. Open your dashboard domain in a browser.
3. Login using the default credentials (printed in the console on the first run, or configure them manually).
4. Here you can edit Layla's prompt and select the Vosk recognition language per server.

## Commands

*   `/call` - Layla joins your current voice channel.
*   `/endcall` - Layla leaves the voice channel.
*   `/search <query>` - Searches the internet for real-time information.
*   `@Layla <message>` - Mention her in any text channel to chat.

## How Voice Mode Works

1. **Join:** When you use `/call`, Layla connects to the Discord voice channel.
2. **Listen:** It uses the **Vosk** offline engine to continuously listen for the wake word ("Layla"). The language model used is based on the server's dashboard configuration.
3. **Stream:** Once the wake word is detected, it opens a WebSockets stream directly to the **Gemini Live API**.
4. **Respond:** Gemini processes the audio and streams back PCM audio, which Layla decodes and plays back into the Discord channel.

---
*Built with Discord.js, Node.js, Vosk, and Google Gemini.*
