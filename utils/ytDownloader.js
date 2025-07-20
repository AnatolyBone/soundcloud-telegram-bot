import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

// Только если ты работаешь с ESM (что у тебя и есть)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function downloadWithYtDlp(url, outDir = './downloads') {
  return new Promise((resolve, reject) => {
    const filename = `${randomUUID()}.mp3`;
    const fullOutDir = path.resolve(__dirname, outDir);

    if (!existsSync(fullOutDir)) {
      mkdirSync(fullOutDir, { recursive: true });
    }

    const filepath = path.join(fullOutDir, filename);
    const command = `yt-dlp -x --audio-format mp3 -o "${filepath}" "${url}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp error:', stderr || error.message);
        return reject(stderr || error.message);
      }

      // Иногда yt-dlp пишет в stderr прогресс — не пугайся
      if (stderr) console.warn('yt-dlp warnings:', stderr.trim());

      resolve(filepath);
    });
  });
}