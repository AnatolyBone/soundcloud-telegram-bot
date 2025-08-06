// indexer.js

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import retry from 'async-retry';
import pLimit from 'p-limit';
import { createClient } from 'redis';
import { cacheTrack, findCachedTrack, pool } from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const REDIS_URL = process.env.REDIS_URL;
const PARALLEL_LIMIT = 4;
const RETRY_COUNT = 3;
const CYCLE_PAUSE_MS = 60 * 60 * 1000;
const MAX_PLAYLIST_TRACKS = 10;

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

const withTimeout = (promise, ms, errorMsg) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms)),
  ]);

async function checkBotPermissions() {
try {
const chat = await bot.telegram.getChat(STORAGE_CHANNEL_ID);
const member = await bot.telegram.getChatMember(chat.id, bot.botInfo.id);

console.log(`✅ Бот имеет доступ к каналу ${STORAGE_CHANNEL_ID}`);
console.log("Права бота:", {
can_send_messages: member.can_send_messages,
can_send_media_messages: member.can_send_media_messages,
});

if (!member.can_send_messages || !member.can_send_media_messages) {
throw new Error("Бот не имеет прав на отправку сообщений/медиа");
}
} catch (err) {
console.error(`❌ Ошибка доступа: ${err.message}`);
process.exit(1);
}
}

async function getUrlsToIndex() {
  console.log('[Indexer] Получаю список популярных треков...');
  try {
    const { rows } = await pool.query(`
      SELECT url, COUNT(url) as download_count
      FROM downloads_log
      WHERE url NOT IN (SELECT url FROM track_cache)
      AND url LIKE '%soundcloud.com%'
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

function parseMetadata(info) {
  let rawTitle = (info.title || info.track?.title || '').trim().replace(/```math
.*?```/gi, '').slice(0, 100) || 'Без названия';
  let rawUploader = (info.uploader || info.user?.username || '').trim().slice(0, 100) || 'Без исполнителя';
  const trackName = rawTitle;
  const uploader = rawTitle.toLowerCase().includes(rawUploader.toLowerCase()) ? '' : rawUploader;
  return { trackName, uploader };
}

async function processUrl(url, depth = 0) {
  if (depth > 1) return 'skipped';
  let tempFilePath = null;

  return retry(async () => {
    try {
      const cached = await findCachedTrack(url);
      if (cached) {
        console.log(`[Indexer] Пропуск (кэш): ${url}`);
        return 'cached';
      }

      console.log(`[Indexer] Индексирую: ${url}`);
      const info = await withTimeout(
        ytdl(url, { dumpSingleJson: true, noPlaylist: true, format: 'bestaudio' }),
        45000,
        `Таймаут info для ${url}`
      );

      console.log(`[Indexer] Info: _type=${info._type}, entries=${info.entries?.length || 0}, duration=${info.duration}`);

      if (info._type === 'playlist' || Array.isArray(info.entries) && info.entries.length > 0) {
        console.log(`[Indexer] Плейлист: ${url} с ${info.entries.length} треками. Обработка...`);
        const limit = pLimit(PARALLEL_LIMIT);
        const tasks = info.entries.slice(0, MAX_PLAYLIST_TRACKS).map(entry => 
          limit(() => processUrl(entry.url || entry.webpage_url || entry.original_url, depth + 1))
        );
        const results = await Promise.all(tasks);
        const successCount = results.filter(r => r === 'success').length;
        console.log(`[Indexer] Успешно обработано ${successCount} треков из плейлиста`);
        return successCount > 0 ? 'success' : 'skipped';
      }

      if (!info || !info.url) {
        console.log(`[Indexer] Пропуск: Нет валидной info/URL для ${url}`);
        return 'skipped';
      }

      const { trackName, uploader } = parseMetadata(info);

      await fs.mkdir(cacheDir, { recursive: true });
      tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);

      let fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
      if (!fileExists) {
        await withTimeout(
          ytdl(info.url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            audioQuality: 0,
          }),
          120000,
          `Таймаут скачивания для ${url}`
        );
        fileExists = await fs.access(tempFilePath).then(() => true).catch(() => false);
      }

      if (!fileExists || (await fs.stat(tempFilePath)).size === 0) throw new Error('Файл не создан или пустой');

      const message = await retry(async () => {
        return withTimeout(
          bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { source: await fs.open(tempFilePath, 'r') }, { title: trackName, performer: uploader }),
          45000,
          `Таймаут отправки для ${url}`
        );
      }, { retries: RETRY_COUNT, minTimeout: 5000 });

      if (!message?.audio?.file_id) throw new Error('Нет file_id от Telegram');

      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Закэшировано и отправлено: ${trackName} от ${uploader}`);
      return 'success';
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('таймаут')) {
        console.warn(`[Indexer] Пропуск URL ${url} из-за ошибки: ${err.message}`);
        return 'skipped';
      }
      throw err;
    }
  }, { retries: RETRY_COUNT, minTimeout: 5000 }).finally(async () => {
    if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {});
  });
}

async function main() {
  await redis.connect();
  console.log('🚀 Запуск Индексатора...');
  await checkBotPermissions();
  await fs.mkdir(cacheDir, { recursive: true });

  const shutdown = async () => {
    console.log('[Indexer] Завершение...');
    await fs.rm(cacheDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
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
        console.log(`[Indexer] Жду ${Math.ceil(waitMs / 60000)} мин до следующего цикла.`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const urls = await getUrlsToIndex();
      if (urls.length === 0) {
        console.log('[Indexer] Нет новых URL.');
        continue;
      }

      console.log(`[Indexer] Обработка ${urls.length} URL.`);
      const limit = pLimit(PARALLEL_LIMIT);
      const tasks = urls.map(url => limit(() => processUrl(url)));
      const results = await Promise.all(tasks);

      const stats = results.reduce((acc, res) => ({ ...acc, [res]: (acc[res] || 0) + 1 }), { total: urls.length });
      console.log(`📊 Результаты: ${JSON.stringify(stats)}`);

      await redis.set('indexer_last_cycle', now);
    } catch (err) {
      console.error('[Indexer] Ошибка:', err);
    } finally {
      await new Promise(resolve => setTimeout(resolve, CYCLE_PAUSE_MS));
    }
  }
}

main().catch(err => {
  console.error('🔴 Критическая ошибка:', err);
  process.exit(1);
});