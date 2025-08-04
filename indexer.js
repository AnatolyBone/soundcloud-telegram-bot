// indexer.js

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import retry from 'async-retry';
import pLimit from 'p-limit';
import { createClient } from 'redis'; // Или ваш Redis клиент (настройте)
import { cacheTrack, findCachedTrack, pool } from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const REDIS_URL = process.env.REDIS_URL; // Из вашего env
const PARALLEL_LIMIT = 4;
const RETRY_COUNT = 3;
const CYCLE_PAUSE_MS = 60 * 60 * 1000; // 1 час
const MAX_PLAYLIST_TRACKS = 5; // Макс. треков из плейлиста

const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('❌ Redis ошибка:', err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

if (!BOT_TOKEN || !STORAGE_CHANNEL_ID || !REDIS_URL) {
  console.error('❌ Отсутствуют необходимые переменные окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Утилита для таймаута (без изменений)
const withTimeout = (promise, ms, errorMsg) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms)),
  ]);

// Проверка прав (без изменений)
async function checkBotPermissions() {
  try {
    await bot.telegram.getChat(STORAGE_CHANNEL_ID);
    console.log(`✅ Бот имеет доступ к каналу ${STORAGE_CHANNEL_ID}`);
  } catch (err) {
    console.error(`❌ Ошибка доступа к каналу:`, err.message);
    process.exit(1);
  }
}

// Получение URL (без изменений)
async function getUrlsToIndex() {
  console.log('[Indexer] Получаю список популярных треков...');
  try {
    const { rows } = await pool.query(`
      SELECT url, COUNT(url) as download_count
      FROM downloads_log
      WHERE url NOT IN (SELECT url FROM track_cache)
      GROUP BY url
      ORDER BY download_count DESC
      LIMIT 20;
    `);
    console.log(`[Indexer] Получено ${rows.length} URL.`);
    return rows.map(row => row.url);
  } catch (err) {
    console.error('[Indexer] Ошибка запроса URL:', err);
    return [];
  }
}

// Парсинг метаданных (с SoundCloud-полями)
function parseMetadata(info) {
  let rawTitle = (info.title || info.track?.title || '').trim().replace(/```math
Official```/gi, '').slice(0, 100) || 'Без названия';
  let rawUploader = (info.uploader || info.channel || info.user?.username || '').trim().slice(0, 100) || 'Без исполнителя';
  const trackName = rawTitle;
  const uploader = rawTitle.toLowerCase().includes(rawUploader.toLowerCase()) ? '' : rawUploader;
  return { trackName, uploader };
}

// Обработка URL (с полной обработкой плейлистов)
async function processUrl(url, depth = 0) {
  if (depth > 1) return 'skipped'; // Избегать глубокой рекурсии
  let tempFilePath = null;

  return retry(async (bail) => {
    try {
      const cached = await findCachedTrack(url);
      if (cached) {
        console.log(`[Indexer] Пропуск (кэш): ${url}`);
        return 'cached';
      }

      console.log(`[Indexer] Индексирую: ${url}`);
      const info = await withTimeout(
        ytdl(url, { dumpSingleJson: true, format: 'bestaudio' }), // SoundCloud-оптимизация
        30000,
        `Таймаут info для ${url}`
      );

      console.log(`[Indexer] Info для ${url}: _type=${info._type}, entries=${info.entries?.length || 0}`);

      if (info._type === 'playlist' || Array.isArray(info.entries)) {
        console.log(`[Indexer] Плейлист: ${url} с ${info.entries?.length} треками. Обработка...`);
        const limit = pLimit(PARALLEL_LIMIT);
        const tasks = (info.entries || []).slice(0, MAX_PLAYLIST_TRACKS).map(entry => 
          limit(() => processUrl(entry.url || entry.webpage_url, depth + 1))
        );
        const results = await Promise.all(tasks);
        const successCount = results.filter(r => r === 'success').length;
        console.log(`[Indexer] Обработано ${successCount} треков из плейлиста ${url}`);
        return successCount > 0 ? 'success' : 'skipped';
      }

      if (!info) throw new Error('Нет info');

      const { trackName, uploader } = parseMetadata(info);

      await fs.mkdir(cacheDir, { recursive: true });
      tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);

      let fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
      if (!fileExists) {
        await withTimeout(
          ytdl(url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`,
          }),
          90000, // Увеличен таймаут для SoundCloud
          `Таймаут скачивания для ${url}`
        );
        fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
      } else {
        console.log(`[Indexer] Локальный кэш: ${url}`);
      }

      if (!fileExists) throw new Error('Файл не создан');

      const stats = await fs.stat(tempFilePath);
      if (stats.size > 50 * 1024 * 1024) throw new Error('Файл >50MB');

      const message = await retry(async () => {
        return withTimeout(
          bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { source: await fs.open(tempFilePath, 'r') }, { title: trackName, performer: uploader }),
          30000,
          `Таймаут отправки для ${url}`
        );
      }, { retries: RETRY_COUNT });

      if (!message?.audio?.file_id) throw new Error('Нет file_id');

      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Закэшировано и отправлено: ${trackName}`);
      return 'success';
    } catch (err) {
      console.error(`❌ Ошибка ${url}:`, err.message);
      throw err;
    }
  }, { retries: RETRY_COUNT }).finally(async () => {
    if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {});
  });
}

// Главный цикл с Redis-состоянием
async function main() {
  await redis.connect();
  console.log('🚀 Запуск Индексатора...');
  await checkBotPermissions();
  await fs.mkdir(cacheDir, { recursive: true });

  const shutdown = async () => {
    console.log('[Indexer] Завершение...');
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    await redis.quit();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (true) {
    try {
      const lastCycle = await redis.get('indexer_last_cycle');
      const now = Date.now();
      if (lastCycle && now - Number(lastCycle) < CYCLE_PAUSE_MS) {
        const waitMs = CYCLE_PAUSE_MS - (now - Number(lastCycle));
        console.log(`[Indexer] Жду ${Math.ceil(waitMs / 60000)} мин (состояние из Redis).`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const urls = await getUrlsToIndex();
      if (urls.length === 0) continue;

      console.log(`[Indexer] Найдено ${urls.length} URL.`);
      const limit = pLimit(PARALLEL_LIMIT);
      const tasks = urls.map(url => limit(() => processUrl(url)));
      const results = await Promise.all(tasks);

      const stats = results.reduce((acc, res) => ({ ...acc, [res]: (acc[res] || 0) + 1 }), { total: urls.length });
      console.log(`📊 Цикл: ${JSON.stringify(stats)}`);

      await redis.set('indexer_last_cycle', now);
    } catch (err) {
      console.error('[Indexer] Ошибка цикла:', err);
    } finally {
      console.log('[Indexer] Пауза на 1 час...');
      await new Promise(resolve => setTimeout(resolve, CYCLE_PAUSE_MS));
    }
  }
}

main().catch(err => console.error('🔴 Ошибка:', err) && process.exit(1));