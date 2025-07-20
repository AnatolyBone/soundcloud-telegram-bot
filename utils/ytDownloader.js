import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import YTDlpWrap from 'yt-dlp-wrap';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ytdlpWrap = new YTDlpWrap(); // автоматом подтянет бинарник

export function downloadWithYtDlp(url, outDir = './downloads') {
  return new Promise((resolve, reject) => {
    const filename = `${randomUUID()}.mp3`;
    const fullOutDir = path.resolve(__dirname, outDir);

    if (!existsSync(fullOutDir)) {
      mkdirSync(fullOutDir, { recursive: true });
    }

    const filepath = path.join(fullOutDir, filename);

    const args = [
      url,
      '-x',
      '--audio-format', 'mp3',
      '-o', filepath,
    ];

    let stderr = '';

    ytdlpWrap
      .exec(args)
      .on('error', (err) => {
        reject(stderr || err.message);
      })
      .on('stderr', (data) => {
        stderr += data.toString();
      })
      .on('close', () => {
        resolve(filepath);
      });
  });
}