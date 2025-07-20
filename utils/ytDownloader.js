import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';

export function downloadWithYtDlp(url, outDir = './downloads') {
  return new Promise((resolve, reject) => {
    const filename = `${randomUUID()}.mp3`;
    const filepath = path.join(outDir, filename);
    const command = `yt-dlp -x --audio-format mp3 -o "${filepath}" "${url}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr);
        return reject(stderr);
      }

      resolve(filepath);
    });
  });
}