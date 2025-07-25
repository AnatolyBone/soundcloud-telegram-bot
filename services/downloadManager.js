// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ytdl from 'youtube-dl-exec';
import { Markup } from 'telegraf';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import {
  pool,
  getUser,
  resetDailyLimitIfNeeded,
  saveTrackForUser,
  logEvent,
  logUserActivity
} from '../db.js';

// --- Константы и утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;

function sanitizeFilename(name) {
  return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

// --- Обработчик задач загрузки треков ---
async function trackDownloadProcessor(task) {
  const { ctx, userId, url, playlistUrl, trackName, trackId, uploader } = task;
  const redisClient = getRedisClient();
  let tempFilePath = null;

  console.log(`[Worker] Скачивание (промах кэша): ${url}`);

  try {
    const fileIdKey = `fileId:${url}`;
    tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);

    await ytdl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFilePath,
      embedMetadata: true,
      postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}"`
    });

    const stats = await fs.promises.stat(tempFilePath);
    const fileSizeInMB = stats.size / (1024 * 1024);

    if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
      await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} МБ) и не может быть отправлен.`);
      return;
    }

    const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
      title: trackName,
      performer: uploader || 'SoundCloud'
    });

    if (message?.audio?.file_id) {
      await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, message.audio.file_id);
      await saveTrackForUser(userId, trackName, message.audio.file_id);
    }

    if (playlistUrl) {
      const playlistKey = `playlist:${userId}:${playlistUrl}`;
      const remaining = await redisClient.decr(playlistKey);
      if (remaining <= 0) {
        await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
        await redisClient.del(playlistKey);
      }
    }
  } catch (err) {
    if (err.response?.error_code === 403) {
      console.warn(`[UserDisconnected] Пользователь ${userId} заблокировал бота.`);
    } else {
      console.error(`❌ Ошибка загрузки "${trackName}":`, err?.stderr || err?.message || err);
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath);
    }
  }
}

// --- Очередь загрузки ---
export const downloadQueue = new TaskQueue({
  maxConcurrent: 8,
  taskProcessor: trackDownloadProcessor,
});

// --- Основная функция ---
export async function enqueue(ctx, userId, url) {
  try {
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);
    let remainingLimit = user.premium_limit - user.downloads_today;

    if (remainingLimit <= 0) {
      return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([]));
    }

    await ctx.reply('🔍 Анализирую ссылку, ищу треки в кэше...');

    const redisClient = getRedisClient();
    const infoKey = `meta:${url}`;
    let info;
    const cachedInfo = await redisClient.get(infoKey);

    if (cachedInfo) {
      info = JSON.parse(cachedInfo);
      console.log(`[Cache] Метаданные из Redis: ${url}`);
    } else {
      info = await ytdl(url, { dumpSingleJson: true });
      if (info && Object.keys(info).length > 0) {
        await redisClient.setEx(infoKey, 300, JSON.stringify(info));
      }
    }

    if (!info) {
      throw new Error(`Не удалось получить метаданные для ${url}`);
    }

    const isPlaylist = Array.isArray(info.entries);
    let trackInfos = [];

    if (isPlaylist) {
      trackInfos = info.entries.filter(e => e?.webpage_url).map(e => ({
        url: e.webpage_url,
        trackId: e.id || e.title.replace(/\s/g, ''),
        trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
        uploader: e.uploader || 'SoundCloud'
      }));
    } else {
      trackInfos = [{
        url: info.webpage_url || url,
        trackId: info.id || info.title.replace(/\s/g, ''),
        trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
        uploader: info.uploader || 'SoundCloud'
      }];
    }

    if (isPlaylist && user.premium_limit <= 10 && trackInfos.length > MAX_PLAYLIST_TRACKS_FREE) {
      await ctx.telegram.sendMessage(userId, `ℹ️ Бесплатные пользователи могут скачивать до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
      trackInfos = trackInfos.slice(0, MAX_PLAYLIST_TRACKS_FREE);
    }

    if (trackInfos.length > remainingLimit) {
      await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но вам доступно только ${remainingLimit}.`);
      trackInfos = trackInfos.slice(0, remainingLimit);
    }

    const tasksForQueue = [];
    const tasksFromCache = [];

    for (const track of trackInfos) {
      const cachedFileId = await redisClient.get(`fileId:${track.url}`);
      if (cachedFileId) {
        tasksFromCache.push({ ...track, fileId: cachedFileId });
      } else {
        tasksForQueue.push(track);
      }
    }

    // Отправка из кэша
    if (tasksFromCache.length > 0) {
      await pool.query(`UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`, [tasksFromCache.length, userId]);

      for (const track of tasksFromCache) {
        try {
          await ctx.telegram.sendAudio(userId, track.fileId, {
            title: track.trackName,
            performer: track.uploader
          });
        } catch (err) {
          if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
            await redisClient.del(`fileId:${track.url}`);
            tasksForQueue.push(track);
          }
        }
      }

      for (const track of tasksFromCache) {
        saveTrackForUser(userId, track.trackName, track.fileId).catch(console.warn);
      }

      await ctx.reply(`✅ ${tasksFromCache.length} трек(ов) отправлено из кэша!`);
    }

    // Добавление в очередь
    if (tasksForQueue.length > 0) {
      if (isPlaylist) {
        const playlistKey = `playlist:${userId}:${url}`;
        await redisClient.setEx(playlistKey, 3600, tasksForQueue.length.toString());
        await logEvent(userId, 'download_playlist');
      }

      await pool.query(`UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`, [tasksForQueue.length, userId]);

      for (const track of tasksForQueue) {
        downloadQueue.add({ ctx, userId, ...track, playlistUrl: isPlaylist ? url : null, priority: user.premium_limit });
        await logEvent(userId, 'download');
      }

      await ctx.telegram.sendMessage(userId, `⏳ ${tasksForQueue.length} трек(ов) добавлено в очередь.`);
    }

  } catch (err) {
    console.error(`❌ Ошибка в enqueue():`, err);
    await ctx.reply(texts.error);
  }
}