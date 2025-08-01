// indexer.js

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { cacheTrack, findCachedTrack, pool } from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют BOT_TOKEN или STORAGE_CHANNEL_ID');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Получает список URL'ов для индексации
async function getUrlsToIndex() {
  console.log('[Indexer] Получаю список популярных треков из логов...');
  const { rows } = await pool.query(`
    SELECT url, COUNT(url) as download_count
    FROM downloads_log
    WHERE url NOT IN (SELECT url FROM track_cache)
    GROUP BY url
    ORDER BY download_count DESC
    LIMIT 20;
  `);
  return rows.map(row => row.url);
}

// Обрабатывает один URL
async function processUrl(url) {
  let tempFilePath = null;

  try {
    const isCached = await findCachedTrack(url);
    if (isCached) {
      console.log(`[Indexer] Пропуск: ${url} уже в кэше.`);
      return 'cached';
    }

    console.log(`[Indexer] Индексирую: ${url}`);
    const info = await ytdl(url, { dumpSingleJson: true });

    if (!info || info._type === 'playlist' || Array.isArray(info.entries)) {
      console.log(`[Indexer] Пропуск: ${url} — это плейлист.`);
      return 'skipped';
    }

    const trackName = (info.title || 'track').slice(0, 100);
    const uploader = info.uploader || 'SoundCloud';

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);

    await ytdl(url, {
      output: tempFilePath,
      extractAudio: true,
      audioFormat: 'mp3',
      embedMetadata: true,
      postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`
    });

    if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');

    const message = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(tempFilePath) },
      {
        title: trackName,
        performer: uploader
      }
    );

    if (message?.audio?.file_id) {
      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
      return 'success';
    } else {
      console.warn(`⚠️ [Indexer] Telegram не вернул file_id для ${url}`);
      return 'error';
    }
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err?.stderr || err?.stack || err);
    return 'error';
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
}

// Главный цикл индексатора
async function main() {
  console.log('🚀 Запуск Бота-Индексатора...');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  while (true) {
    try {
      const urls = await getUrlsToIndex();

      const stats = {
        total: urls.length,
        cached: 0,
        success: 0,
        failed: 0
      };

      if (urls.length > 0) {
        console.log(`[Indexer] Найдено ${urls.length} новых треков для индексации.`);

        for (const url of urls) {
          const result = await processUrl(url);

          if (result === 'cached') stats.cached++;
          else if (result === 'success') stats.success++;
          else stats.failed++;

          await new Promise(resolve => setTimeout(resolve, 5000)); // пауза 5 сек
        }

        console.log(`📊 [Цикл завершён]
Всего URL:     ${stats.total}
В кэше:        ${stats.cached}
Успешно:       ${stats.success}
Ошибок:        ${stats.failed}`);
      } else {
        console.log('[Indexer] Новых популярных треков для индексации нет.');
      }
    } catch (e) {
      console.error('[Indexer] Ошибка в основном цикле:', e);
    }

    console.log('[Indexer] Пауза на 1 час перед следующим проходом.');
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000)); // 1 час
  }
}

main().catch(err => {
  console.error('🔴 Критическая ошибка в главном цикле индексатора:', err?.stack || err);
  process.exit(1);
});