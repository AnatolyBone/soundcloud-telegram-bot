// indexer-coop.js
import fs from 'fs';
import path from 'path';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { bot } from './index.js';
import {
  cacheTrack,
  findCachedTrack,
  getUrlsToIndex,
  downloadQueue
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

let shuttingDown = false;
process.once('SIGTERM', () => { shuttingDown = true; });
process.once('SIGINT',  () => { shuttingDown = true; });

async function processOneUrl(url, STORAGE_CHANNEL_ID) {
  let tempFilePath = null;
  try {
    const isCached = await findCachedTrack(url);
    if (isCached) {
      console.log(`[Indexer] Пропуск: уже в кэше: ${url}`);
      return;
    }

    console.log(`[Indexer] Индексирую: ${url}`);
    let info = await ytdl(url, { dumpSingleJson: true, 'no-playlist': true });

    if (!info) {
      console.log(`[Indexer] Нет информации для: ${url}`);
      return;
    }

    // fallback: если пришёл плейлист — возьмём первый трек
    if (info._type === 'playlist' || Array.isArray(info.entries)) {
      if (Array.isArray(info.entries) && info.entries.length >= 1) {
        info = info.entries[0];
      } else {
        console.log(`[Indexer] Пропуск: плейлист без элементов: ${url}`);
        return;
      }
    }

    const trackName = (info.title || 'track').slice(0, 100);
    const uploader  = info.uploader || 'SoundCloud';
    tempFilePath = path.join(cacheDir, `indexer_${info.id || Date.now()}.mp3`);

    await ytdl(url, {
      output: tempFilePath,
      extractAudio: true,
      audioFormat: 'mp3',
      embedMetadata: true,
      'no-playlist': true,
      postprocessorArgs: [
        '-metadata', `artist=${uploader}`,
        '-metadata', `title=${trackName}`
      ],
    });

    const fileExists = await fs.promises
      .access(tempFilePath)
      .then(() => true)
      .catch(() => false);
    if (!fileExists) throw new Error('Файл не создан');

    const message = await bot.telegram.sendAudio(
      process.env.STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(tempFilePath) },
      { title: trackName, performer: uploader }
    );

    if (message?.audio?.file_id) {
      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Закэширован: ${trackName}`);
    }
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка ${url}:`,
      err.response?.description || err.stderr || err.message || err);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch(() => {
        console.warn(`[Indexer] Не удалён временный файл: ${tempFilePath}`);
      });
    }
  }
}

export async function startIndexer() {
  console.log('🚀 Запуск фонового индексатора (кооперативный режим)...');

  async function tick() {
    if (shuttingDown) return;

    try {
      // если есть активные пользовательские скачивания — индексатор подождёт
      if (downloadQueue?.active > 0) {
        console.log('[Indexer] Есть активные задания пользователей. Пауза 2 мин.');
        return setTimeout(tick, 2 * 60 * 1000);
      }

      const urls = await getUrlsToIndex(); // до 10 URL
      if (urls.length === 0) {
        console.log('[Indexer] Ничего не найдено. Пауза 10 минут.');
        return setTimeout(tick, 10 * 60 * 1000);
      }

      // обрабатываем максимум 2 за цикл
      const batch = urls.slice(0, 2);
      for (const url of batch) {
        if (shuttingDown) break;
        await processOneUrl(url, process.env.STORAGE_CHANNEL_ID);
        await new Promise(r => setTimeout(r, 5000)); // даём вебу подышать
      }

      setTimeout(tick, 60 * 1000); // следующий прогон
    } catch (err) {
      console.error('🔴 Индексатор: критическая ошибка. Рестарт через 5 минут:', err);
      setTimeout(tick, 5 * 60 * 1000);
    }
  }

  // старт через минуту, чтобы веб успел подняться
  setTimeout(tick, 60 * 1000);
}