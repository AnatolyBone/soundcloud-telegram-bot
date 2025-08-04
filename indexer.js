// indexer.js

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs/promises'; // Используем промисы для асинхронности
import { fileURLToPath } from 'url';
import { cacheTrack, findCachedTrack, pool } from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

// Проверка переменных окружения
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

// Получение списка URL для индексации
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
    return rows.map(row => row.url);
  } catch (err) {
    console.error('[Indexer] Ошибка при запросе URL:', err);
    return [];
  }
}

// Обработка одного URL
async function processUrl(url) {
  let tempFilePath = null;
  try {
    // Проверка кэша
    const cached = await findCachedTrack(url);
    if (cached) {
      console.log(`[Indexer] Пропуск: ${url} уже в кэше с file_id: ${cached.file_id}`);
      return 'cached';
    }

    console.log(`[Indexer] Индексирую: ${url}`);
    const info = await withTimeout(
      ytdl(url, { dumpSingleJson: true }),
      30000, // Таймаут 30 секунд
      `Таймаут получения информации для ${url}`
    );

    if (!info || info._type === 'playlist' || Array.isArray(info.entries)) {
      console.log(`[Indexer] Пропуск: ${url} — это плейлист`);
      return 'skipped';
    }

    // Обработка метаданных
    const rawTitle = (info.title || '').trim() || 'Без названия';
    const rawUploader = (info.uploader || '').trim() || 'Без исполнителя';
    const titleHasUploader = rawTitle.toLowerCase().includes(rawUploader.toLowerCase());
    const trackName = rawTitle.slice(0, 100);
    const uploader = titleHasUploader ? '' : rawUploader.slice(0, 100);

    // Создание временного файла
    await fs.mkdir(cacheDir, { recursive: true });
    tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);

    await withTimeout(
      ytdl(url, {
        output: tempFilePath,
        extractAudio: true,
        audioFormat: 'mp3',
        embedMetadata: true,
        postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`,
      }),
      60000, // Таймаут 60 секунд
      `Таймаут загрузки для ${url}`
    );

    const fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
    if (!fileExists) throw new Error('Файл не создан');

    // Отправка в Telegram
    const message = await withTimeout(
      bot.telegram.sendAudio(
        STORAGE_CHANNEL_ID,
        { source: await fs.open(tempFilePath, 'r') },
        { title: trackName, ...(uploader ? { performer: uploader } : {}) }
      ),
      30000,
      `Таймаут отправки для ${url}`
    );

    if (!message?.audio?.file_id) throw new Error('Telegram не вернул file_id');

    // Кэширование
    await cacheTrack(url, message.audio.file_id, trackName);
    console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
    return 'success';
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.message || err);
    return 'error';
  } finally {
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(err =>
        console.warn(`⚠️ Не удалось удалить ${tempFilePath}:`, err)
      );
    }
  }
}

// Ограничение параллельных задач
async function processBatch(urls, concurrency = 3) {
  const results = { cached: 0, success: 0, failed: 0 };
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(url => processUrl(url)));
    batchResults.forEach(result => {
      if (result === 'cached') results.cached++;
      else if (result === 'success') results.success++;
      else results.failed++;
    });
  }
  return results;
}

// Главный цикл
async function main() {
  console.log('🚀 Запуск Бота-Индексатора...');
  await fs.mkdir(cacheDir, { recursive: true });

  while (true) {
    try {
      const urls = await getUrlsToIndex();
      if (urls.length === 0) {
        console.log('[Indexer] Новых треков для индексации нет.');
      } else {
        console.log(`[Indexer] Найдено ${urls.length} треков для индексации.`);
        const stats = await processBatch(urls, 3); // Обрабатываем по 3 URL параллельно
        console.log(`📊 [Цикл завершён]
Всего URL:     ${urls.length}
В кэше:        ${stats.cached}
Успешно:       ${stats.success}
Ошибок:        ${stats.failed}`);
      }
    } catch (err) {
      console.error('[Indexer] Ошибка в основном цикле:', err);
    }
    console.log('[Indexer] Пауза на 1 час...');
    await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
  }
}

main().catch(err => {
  console.error('🔴 Критическая ошибка:', err);
  process.exit(1);
});