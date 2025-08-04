// indexer.js

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs/promises'; // Асинхронный fs
import { fileURLToPath } from 'url';
import retry from 'async-retry'; // Для ретраев
import pLimit from 'p-limit'; // Для лимита параллелизма
import { cacheTrack, findCachedTrack, pool } from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const PARALLEL_LIMIT = 4; // Увеличено для ускорения, но не слишком (rate limits)
const RETRY_COUNT = 3; // Кол-во ретраев
const CYCLE_PAUSE_MS = 60 * 60 * 1000; // 1 час

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют BOT_TOKEN или STORAGE_CHANNEL_ID');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Утилита для таймаута промисов
const withTimeout = (promise, ms, errorMsg) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms)),
  ]);

// Проверка прав бота в канале
async function checkBotPermissions() {
  try {
    await bot.telegram.getChat(STORAGE_CHANNEL_ID);
    console.log(`✅ Бот имеет доступ к каналу ${STORAGE_CHANNEL_ID}`);
  } catch (err) {
    console.error(`❌ Ошибка доступа к каналу ${STORAGE_CHANNEL_ID}:`, err.message);
    console.error('Проверьте: бот должен быть админом в канале с правами на отправку медиа.');
    process.exit(1);
  }
}

// Получение списка URL
async function getUrlsToIndex() {
  console.log('[Indexer] Получаю список популярных треков из логов...');
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
    console.error('[Indexer] Ошибка при запросе URL:', err);
    return [];
  }
}

// Улучшенный парсинг метаданных
function parseMetadata(info) {
  let rawTitle = (info.title || info.track?.title || '').trim().replace(/```math
Official Video```/gi, '').replace(/KATEX_INLINE_OPENAudioKATEX_INLINE_CLOSE/gi, '').slice(0, 100) || 'Без названия';
  let rawUploader = (info.uploader || info.channel || info.track?.user?.username || '').trim().slice(0, 100) || 'Без исполнителя';

  const titleHasUploader = rawTitle.toLowerCase().includes(rawUploader.toLowerCase());
  const trackName = rawTitle;
  const uploader = titleHasUploader ? '' : rawUploader;

  return { trackName, uploader };
}

// Обработка одного URL
async function processUrl(url) {
  let tempFilePath = null;

  return retry(async (bail) => {
    try {
      const cached = await findCachedTrack(url);
      if (cached) {
        console.log(`[Indexer] Пропуск: ${url} уже в кэше с file_id: ${cached.file_id}`);
        return 'cached';
      }

      console.log(`[Indexer] Индексирую: ${url}`);
      const info = await withTimeout(
        ytdl(url, { dumpSingleJson: true }),
        30000,
        `Таймаут получения информации для ${url}`
      );

      console.log(`[Indexer] Тип info для ${url}: _type=${info._type}, entries=${Array.isArray(info.entries) ? info.entries.length : 'none'}`);

      // Улучшенная проверка: если плейлист с 1 треком, используем его
      let trackInfo = info;
      if (info._type === 'playlist' && Array.isArray(info.entries) && info.entries.length === 1) {
        trackInfo = info.entries[0];
        console.log(`[Indexer] Обработка плейлиста с 1 треком как одиночного: ${url}`);
      } else if (info._type === 'playlist' || Array.isArray(info.entries)) {
        console.log(`[Indexer] Пропуск: ${url} — это плейлист с >1 треком`);
        return 'skipped';
      }

      if (!trackInfo) throw new Error('Нет валидной информации о треке');

      const { trackName, uploader } = parseMetadata(trackInfo);

      await fs.mkdir(cacheDir, { recursive: true });
      tempFilePath = path.join(cacheDir, `${trackInfo.id || Date.now()}.mp3`);

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
          60000,
          `Таймаут загрузки для ${url}`
        );
        fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
      } else {
        console.log(`[Indexer] Использую локальный кэш-файл для ${url}`);
      }

      if (!fileExists) throw new Error('Файл не создан');

      const stats = await fs.stat(tempFilePath);
      if (stats.size === 0) throw new Error('Файл пустой');
      if (stats.size > 50 * 1024 * 1024) throw new Error('Файл слишком большой (>50MB)');

      // Ретрай для sendAudio
      const message = await retry(async () => {
        return withTimeout(
          bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: await fs.open(tempFilePath, 'r') },
            { title: trackName, ...(uploader ? { performer: uploader } : {}) }
          ),
          30000,
          `Таймаут отправки для ${url}`
        );
      }, { retries: RETRY_COUNT, minTimeout: 2000, factor: 2 });

      if (!message?.audio?.file_id) throw new Error('Telegram не вернул file_id');

      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Успешно закэширован и отправлен в чат: ${trackName}`);
      return 'success';
    } catch (err) {
      console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.message || err);
      if (err.message.includes('permanent')) bail(err);
      throw err;
    }
  }, { retries: RETRY_COUNT, minTimeout: 2000, factor: 2 }).finally(async () => {
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(err => console.warn(`⚠️ Не удалось удалить ${tempFilePath}:`, err));
    }
  });
}

// Главный цикл
async function main() {
  console.log('🚀 Запуск Бота-Индексатора...');
  await checkBotPermissions();
  await fs.mkdir(cacheDir, { recursive: true });

  // Graceful shutdown для SIGTERM и SIGINT
  const shutdown = async () => {
    console.log('[Indexer] Получен сигнал завершения. Очистка...');
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    // Здесь можно закрыть Redis, pool и т.д., если нужно
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (true) {
    try {
      const urls = await getUrlsToIndex();
      if (urls.length === 0) {
        console.log('[Indexer] Новых треков для индексации нет.');
        continue;
      }

      console.log(`[Indexer] Найдено ${urls.length} треков для индексации.`);
      const limit = pLimit(PARALLEL_LIMIT);
      const tasks = urls.map(url => limit(() => processUrl(url)));
      const results = await Promise.all(tasks);

      const stats = results.reduce((acc, res) => {
        acc[res] = (acc[res] || 0) + 1;
        return acc;
      }, { total: urls.length, cached: 0, success: 0, failed: 0, skipped: 0 });

      console.log(`📊 [Цикл завершён]
Всего URL:     ${stats.total}
В кэше:        ${stats.cached}
Успешно:       ${stats.success}
Пропущено:     ${stats.skipped || 0}
Ошибок:        ${stats.failed || 0}`);
    } catch (err) {
      console.error('[Indexer] Ошибка в основном цикле:', err);
    } finally {
      console.log('[Indexer] Пауза на 1 час...');
      await new Promise(resolve => setTimeout(resolve, CYCLE_PAUSE_MS));
    }
  }
}

main().catch(err => {
  console.error('🔴 Критическая ошибка:', err.stack || err);
  process.exit(1);
});