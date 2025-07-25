// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';
import { fileTypeFromFile } from 'file-type';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts, bot } from '../index.js';
import {
    pool,
    getUser,
    resetDailyLimitIfNeeded,
    saveTrackForUser,
    logEvent,
    logUserActivity,
    incrementDownloads
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

// --- Основной обработчик одной задачи ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, trackName, trackId, uploader, playlistUrl } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        console.log(`[Worker] Скачивание: ${trackName}`);

        const fileIdKey = `fileId:${url}`;
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);

        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}"`,
            retries: 3
        });

        const stats = await fs.promises.stat(tempFilePath);
        const fileSizeInMB = stats.size / (1024 * 1024);

        if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
            await bot.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} МБ).`);
            return;
        }

        const message = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title: trackName,
            performer: uploader
        });

        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

        if (playlistUrl) {
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await bot.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }

    } catch (err) {
        if (err.response?.error_code === 403) {
            console.warn(`[UserDisconnected] Пользователь ${userId} заблокировал бота.`);
        } else {
            console.error(`❌ Ошибка загрузки "${trackName}":`, err.stderr || err.message);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
    }
}

// --- Очередь задач ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: 8,
    taskProcessor: trackDownloadProcessor
});

// --- Основной входной метод ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        const redisClient = getRedisClient();

        await ctx.reply('🔍 Анализирую ссылку...');

        let info;
        const metaKey = `meta:${url}`;
        const cachedMeta = await redisClient.get(metaKey);

        if (cachedMeta) {
            info = JSON.parse(cachedMeta);
            console.log(`[Cache] Метаданные получены из Redis: ${url}`);
        } else {
            info = await ytdl(url, { dumpSingleJson: true, retries: 2 });
            if (info) {
                try {
                    await redisClient.setEx(metaKey, 300, JSON.stringify(info));
                } catch (e) {
                    console.warn(`⚠️ Не удалось сохранить метаданные в Redis: ${e.message}`);
                }
            }
        }

        if (!info) throw new Error('Не удалось получить метаданные');

        const isPlaylist = Array.isArray(info.entries);
        let tracks = [];

        if (isPlaylist) {
            tracks = info.entries
                .filter(e => e?.webpage_url)
                .map(e => ({
                    url: e.webpage_url,
                    trackId: e.id || e.title.replace(/\s/g, ''),
                    trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
                    uploader: e.uploader || 'SoundCloud'
                }));
        } else {
            tracks = [{
                url: info.webpage_url || url,
                trackId: info.id || info.title.replace(/\s/g, ''),
                trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: info.uploader || 'SoundCloud'
            }];
        }

        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([]));
        }

        if (isPlaylist && user.premium_limit <= 10 && tracks.length > MAX_PLAYLIST_TRACKS_FREE) {
            await ctx.telegram.sendMessage(userId, `ℹ️ Бесплатный тариф: максимум ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            tracks = tracks.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }

        if (tracks.length > remainingLimit) {
            await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${tracks.length} треков, но ваш лимит: ${remainingLimit}. Добавляю доступные.`);
            tracks = tracks.slice(0, remainingLimit);
        }

        const tasksFromCache = [];
        const tasksToDownload = [];

        for (const track of tracks) {
            const cachedFileId = await redisClient.get(`fileId:${track.url}`);
            if (cachedFileId) {
                tasksFromCache.push({ ...track, fileId: cachedFileId });
            } else {
                tasksToDownload.push(track);
            }
        }

        // Отправляем из кэша
        for (const track of tasksFromCache) {
            try {
                await bot.telegram.sendAudio(userId, track.fileId, {
                    title: track.trackName,
                    performer: track.uploader
                });
                await saveTrackForUser(userId, track.trackName, track.fileId);
                await incrementDownloads(userId, track.trackName, track.url);
            } catch (err) {
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    await redisClient.del(`fileId:${track.url}`);
                    tasksToDownload.push(track);
                } else {
                    console.warn(`⚠️ Ошибка отправки из кэша: ${err.message}`);
                }
            }
        }

        // Отправляем в очередь
        if (tasksToDownload.length > 0) {
            await ctx.telegram.sendMessage(userId, `⏳ ${tasksToDownload.length} трек(ов) добавлено в очередь.`);

            if (isPlaylist) {
                const playlistKey = `playlist:${userId}:${url}`;
                await redisClient.setEx(playlistKey, 3600, tasksToDownload.length.toString());
                await logEvent(userId, 'download_playlist');
            }

            for (const track of tasksToDownload) {
                await incrementDownloads(userId, track.trackName, track.url);
                downloadQueue.add({
                    ctx,
                    userId,
                    ...track,
                    playlistUrl: isPlaylist ? url : null,
                    priority: user.premium_limit
                });
                await logEvent(userId, 'download');
            }
        }

        if (tasksFromCache.length > 0) {
            await ctx.telegram.sendMessage(userId, `✅ ${tasksFromCache.length} трек(ов) отправлено мгновенно из кэша.`);
        }

    } catch (err) {
        console.error(`❌ enqueue error: ${err.message}`);
        await ctx.reply(texts.error);
    }
}