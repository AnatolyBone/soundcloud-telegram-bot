// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';
import { fileTypeFromFile } from 'file-type';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { pool, getUser, resetDailyLimitIfNeeded, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

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

// --- Обработчик для ОДНОГО трека (медленный путь) ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, playlistUrl, trackName, trackId, uploader } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] 🚀 Скачивание: ${trackName}`);

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
            console.warn(`⚠️ Файл "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} MB).`);
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" не может быть отправлен, так как его размер (${fileSizeInMB.toFixed(2)} МБ) превышает лимит Telegram в 50 МБ.`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title: trackName,
            performer: uploader || 'SoundCloud'
        });
        
        if (message?.audio?.file_id) {
            // Redis-клиент v4 ожидает (key: string, seconds: number, value: string)
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
            console.warn(`[UserDisconnectedError] Пользователь ${userId} заблокировал бота.`);
        } else {
            console.error(`❌ Ошибка обработки "${trackName}":`, err.stderr || err.message);
        }
        throw err;
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
    }
}

// --- Инициализация очереди ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: 8,
    taskProcessor: trackDownloadProcessor,
});

// --- Основная функция, обрабатывающая запрос пользователя ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([/*...*/]));
        }

        await ctx.reply('🔍 Анализирую ссылку, ищу треки в кэше...');
        
        const redisClient = getRedisClient();
        const infoKey = `meta:${url}`;
        let info;
        const cachedInfo = await redisClient.get(infoKey);

        if (cachedInfo) {
            console.log(`[Cache] Метаданные для ${url} взяты из Redis.`);
            info = JSON.parse(cachedInfo);
        } else {
            info = await ytdl(url, { dumpSingleJson: true });
            if (info) {
                let infoString;
                try {
                    infoString = JSON.stringify(info);
                } catch (e) {
                    console.error(`[Cache] Ошибка JSON.stringify для ${url}:`, e);
                    infoString = null;
                }
                if (infoString && infoString !== '{}') {
                    // TTL - число, значение - строка. Все по сигнатуре.
                    await redisClient.setEx(infoKey, 300, infoString);
                }
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
            trackInfos = [{ url: info.webpage_url || url, trackId: info.id || info.title.replace(/\s/g, ''), trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT), uploader: info.uploader || 'SoundCloud' }];
        }
        
        if (isPlaylist && user.premium_limit <= 10 && trackInfos.length > MAX_PLAYLIST_TRACKS_FREE) {
            await ctx.telegram.sendMessage(userId, `ℹ️ Бесплатные пользователи могут добавлять до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            trackInfos = trackInfos.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        if (trackInfos.length > remainingLimit) {
            await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но вам доступно только ${remainingLimit}.`);
            trackInfos = trackInfos.slice(0, remainingLimit);
        }

        const tasksForQueue = []; 
        const tasksFromCache = [];

        await Promise.all(trackInfos.map(async (track) => {
            const cachedFileId = await redisClient.get(`fileId:${track.url}`);
            if (cachedFileId) {
                tasksFromCache.push({ ...track, fileId: cachedFileId });
            } else {
                tasksForQueue.push(track);
            }
        }));

        if (tasksFromCache.length > 0) {
            await pool.query(`UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`, [tasksFromCache.length, userId]);
            
            const CHUNK_SIZE = 10;
            for (let i = 0; i < tasksFromCache.length; i += CHUNK_SIZE) {
                const chunk = tasksFromCache.slice(i, i + CHUNK_SIZE);
                const mediaGroup = chunk.map(track => ({ type: 'audio', media: track.fileId, title: track.trackName, performer: track.uploader }));
                try {
                    await ctx.telegram.sendMediaGroup(userId, mediaGroup);
                } catch (e) {
                    for (const track of chunk) {
                        try {
                            await ctx.telegram.sendAudio(userId, track.fileId, { title: track.trackName, performer: track.uploader });
                        } catch (err) {
                            if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                                await redisClient.del(`fileId:${track.url}`);
                                tasksForQueue.push(track);
                            }
                        }
                    }
                }
            }
            
            tasksFromCache.forEach(track => saveTrackForUser(userId, track.trackName, track.fileId).catch(console.warn));
            await ctx.reply(`✅ ${tasksFromCache.length} трек(ов) отправлено мгновенно из кэша!`);
        }
        
        if (tasksForQueue.length > 0) {
            if (isPlaylist) {
                const playlistKey = `playlist:${userId}:${url}`;
                // ИСПРАВЛЕНО: Приводим значение к строке для Redis v4
                await redisClient.setEx(playlistKey, 3600, tasksForQueue.length.toString());
                await logEvent(userId, 'download_playlist');
            }
            await pool.query(`UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`, [tasksForQueue.length, userId]);
            for (const track of tasksForQueue) {
                downloadQueue.add({ ctx, userId, ...track, playlistUrl: isPlaylist ? url : null, priority: user.premium_limit });
                await logEvent(userId, 'download');
            }
            await ctx.telegram.sendMessage(userId, `⏳ ${tasksForQueue.length} трек(ов) добавлено в очередь на скачивание.`);
        }

    } catch (e) {
        console.error(`❌ Ошибка в enqueue:`, e);
        await ctx.reply(texts.error);
    }
}