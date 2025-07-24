import path from 'path';
import fs from 'fs';
import util from 'util';
import NodeID3 from 'node-id3';
import ytdl from 'youtube-dl-exec';

import { TaskQueue } from '../lib/TaskQueue.js';
import { pool, getUser, logUserActivity, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser } from '../db.js';
import { getRedisClient } from '../index.js'; // Импортируем функцию-геттер из index.js
import { texts } from '../index.js'; // Тексты тоже можно вынести, но пока импортируем из index
import { Markup } from 'telegraf';

// --- Константы и утилиты, относящиеся к загрузкам ---

const writeID3 = util.promisify(NodeID3.write);
const playlistTracker = new Map();

// ESM-совместимый __dirname
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename)); // Поднимаемся на уровень выше, в корень проекта
const cacheDir = path.join(__dirname, 'cache');


// --- Основная функция-обработчик для ОДНОГО трека ---

/**
 * Скачивает, тегирует, отправляет пользователю ОДИН трек и кэширует file_id.
 * Эта функция является "воркером" для нашей очереди.
 * @param {object} task - Объект задачи { ctx, userId, url, playlistUrl }
 */
async function trackDownloadProcessor(task) {
  const { ctx, userId, url, playlistUrl } = task;
  const redisClient = getRedisClient();
  const start = Date.now();
  let trackName = 'track';

  console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] 🚀 Старт: ${url}`);

  try {
    // 1. Проверяем кэш file_id в Redis
    const fileIdKey = `fileId:${url}`;
    const cachedFileId = await redisClient.get(fileIdKey);

    if (cachedFileId) {
      console.log(`🎯 Кэш file_id найден для ${url}. Отправка.`);
      await ctx.telegram.sendAudio(userId, cachedFileId);
      await incrementDownloads(userId, 'cached_track'); // Учитываем загрузку
      await saveTrackForUser(userId, 'cached_track', cachedFileId); // Сохраняем в историю
      return;
    }

    // 2. Если в кэше нет, получаем информацию и скачиваем
    const info = await ytdl(url, { dumpSingleJson: true });
    trackName = (info.title || 'track').replace(/[\\/:*?"<>|]/g, '').slice(0, 64);
    const filePath = path.join(cacheDir, `${trackName}_${Date.now()}.mp3`);

    await ytdl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filePath,
      preferFreeFormats: true,
      noCheckCertificates: true,
    });
    
    await writeID3({ title: trackName, artist: 'SoundCloud' }, filePath);

    // 3. Отправляем файл пользователю
    const message = await ctx.telegram.sendAudio(
      userId,
      { source: fs.createReadStream(filePath) },
      { title: trackName, performer: 'SoundCloud' }
    );
    
    // 4. Обновляем статистику и кэшируем file_id
    if (message?.audio?.file_id) {
        const fileId = message.audio.file_id;
        await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, fileId); // Кэш на 30 дней
        await incrementDownloads(userId, trackName);
        await saveTrackForUser(userId, trackName, fileId);
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Трек ${trackName} обработан за ${duration} сек.`);

    // 5. Очистка
    await fs.promises.unlink(filePath);

    // 6. Обновление прогресса плейлиста
    if (playlistUrl) {
      const playlistKey = `${userId}:${playlistUrl}`;
      if (playlistTracker.has(playlistKey)) {
        let remaining = playlistTracker.get(playlistKey) - 1;
        if (remaining <= 0) {
          await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
          playlistTracker.delete(playlistKey);
        } else {
          playlistTracker.set(playlistKey, remaining);
        }
      }
    }

  } catch (err) {
    console.error(`❌ Ошибка обработки ${url} для userId ${userId}:`, err);
    try {
      // Уведомляем пользователя о проблеме
      await ctx.telegram.sendMessage(userId, `❌ Ошибка при загрузке трека: ${url}\nПричина: ${err.message.slice(0, 100)}`);
    } catch (sendErr) {
      console.error(`⚠️ Не удалось отправить сообщение об ошибке пользователю ${userId}:`, sendErr);
    }
    // Пробрасываем ошибку, чтобы TaskQueue мог ее залогировать
    throw err;
  }
}


// --- Инициализация очереди ---

export const downloadQueue = new TaskQueue({
  maxConcurrent: 8,
  taskProcessor: trackDownloadProcessor,
});


// --- Функция добавления задач в очередь (вызывается из index.js) ---

/**
 * Добавляет задачу в очередь загрузки с валидацией и лимитами.
 * @param {object} ctx - Telegram-контекст
 * @param {number} userId - ID пользователя
 * @param {string} url - Ссылка на трек или плейлист
 */
export async function enqueue(ctx, userId, url) {
  try {
    // 1. Проверка пользователя и лимитов
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;

    if (remainingLimit <= 0) {
      await ctx.telegram.sendMessage(
        userId,
        texts.limitReached,
        Markup.inlineKeyboard([Markup.button.callback('✅ Я подписался', 'check_subscription')])
      );
      return;
    }

    // 2. Получение информации о ссылке (трек или плейлист)
    // Этот вызов ytdl здесь - компромисс. Он нужен, чтобы заранее узнать
    // количество треков в плейлисте и проверить лимиты.
    await ctx.reply('🔍 Анализирую ссылку...');
    const info = await ytdl(url, { dumpSingleJson: true });
    
    const isPlaylist = Array.isArray(info.entries);
    let entries = [];

    if (isPlaylist) {
      entries = info.entries.filter(e => e?.webpage_url).map(e => ({ url: e.webpage_url, title: e.title }));
      
      const playlistKey = `${userId}:${url}`;
      playlistTracker.set(playlistKey, entries.length);

      if (entries.length > remainingLimit) {
        await ctx.telegram.sendMessage(
          userId,
          `⚠️ В плейлисте ${entries.length} треков, но вам доступно только ${remainingLimit}. Загружаю первые ${remainingLimit}.`
        );
        entries = entries.slice(0, remainingLimit);
      }
      await ctx.reply(`Добавляю ${entries.length} треков из плейлиста в очередь...`);
    } else {
      entries = [{ url, title: info.title }];
    }
    
    // 3. Добавление задач в очередь
    for (const entry of entries) {
      downloadQueue.add({
        ctx,
        userId,
        url: entry.url,
        playlistUrl: isPlaylist ? url : null,
        priority: user.premium_limit // Премиум пользователи получают более высокий приоритет
      });
    }

    await ctx.telegram.sendMessage(
      userId,
      `✅ Готово! ${entries.length} трек(ов) добавлено в очередь. \nТекущая позиция: ~${downloadQueue.size}.`
    );

  } catch (e) {
    console.error(`❌ Ошибка в enqueue для userId ${userId}:`, e);
    await ctx.reply(texts.error + '\nВозможно, ссылка недействительна или сервис недоступен.');
  }
}