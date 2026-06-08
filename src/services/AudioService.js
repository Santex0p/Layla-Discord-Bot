import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { CONFIG } from '../config/constants.js';
import fs from 'node:fs/promises';

class AudioService {
  /**
   * Convierte audio PCM crudo a MP3 en memoria usando ffmpeg.
   */
  async pcm16ToMp3Buffer(pcmBuffer, sampleRate = CONFIG.TTS_SAMPLE_RATE, channels = CONFIG.TTS_CHANNELS) {
    if (!ffmpegPath) throw new Error('ffmpeg-static no devolvio una ruta ejecutable.');

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-f', 's16le',
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-i', 'pipe:0',
        '-f', 'mp3',
        '-codec:a', 'libmp3lame',
        '-b:a', '128k',
        'pipe:1',
      ]);

      const outputChunks = [];
      const errorChunks = [];

      ffmpeg.stdout.on('data', (chunk) => outputChunks.push(chunk));
      ffmpeg.stderr.on('data', (chunk) => errorChunks.push(chunk));
      ffmpeg.on('error', (error) => reject(error));

      ffmpeg.on('close', (code) => {
        if (code === 0) return resolve(Buffer.concat(outputChunks));
        const ffmpegError = Buffer.concat(errorChunks).toString('utf8').trim();
        reject(new Error(`ffmpeg fallo al codificar MP3 (exit ${code}): ${ffmpegError}`));
      });

      ffmpeg.stdin.on('error', (error) => reject(error));
      ffmpeg.stdin.end(pcmBuffer);
    });
  }

  /**
   * Genera un MP4 super ligero con una imagen estática y el audio MP3
   */
  async createMp4WithStaticImage(mp3Path, mp4Path, imagePath = '/app/layla-media/audios/background.png') {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-loop', '1',
        '-i', imagePath,
        '-i', mp3Path,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-c:a', 'copy',
        '-vf', "scale='min(600,iw):-2',format=yuv420p",
        '-shortest',
        '-movflags', '+faststart',
        mp4Path
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Error al crear MP4 (exit code ${code})`));
      });

      ffmpeg.on('error', (err) => reject(err));
    });
  }

  /**
   * Elimina un archivo si existe, manejando silenciosamente errores como ENOENT
   */
  async cleanupFile(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[AudioService] Error al intentar limpiar el archivo ${filePath}:`, err.message);
      }
    }
  }
}

export default new AudioService();
