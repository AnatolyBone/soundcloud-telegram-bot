import { exec } from 'child_process';
import { basename } from 'path';
import { randomUUID } from 'crypto';

export function downloadWithYtDlp(url, outDir = './downloads') {
  return new Promise((resolve, reject) => {
    const filename = `${randomUUID()}.%(ext)s`;
    const output = `${outDir}/${filename}`;
    const command = `yt-dlp -x --audio-format mp3 -o "${output}" "${url}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr);
        return reject(stderr);
      }

      // yt-dlp покажет путь, но нам нужно найти итоговый файл
      const match = stdout.match(/Destination: (.+\.mp3)/);
      if (match) {
        resolve(match[1]); // путь к mp3
      } else {
        reject('Файл не найден в выводе yt-dlp');
      }
    });
  });
}