// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { pool, getUser, resetDailyLimitIfNeeded, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

// --- Константы и утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
const TELEGRAM_FILE_LIMIT_MB = 49;

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
        tempFilePath = path.join(cacheDir, `${trackName}_${trackId}_${Date.now()}.mp3`);

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
            const fileId = message.audio.file_id;
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, fileId);
            await saveTrackForUser(userId, trackName, fileId);
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
            console.warn(`[UserDisconnectedError] Пользователь ${userId} заблокировал бота во время отправки.`);
        } else {
            console.error(`❌ Ошибка обработки "${trackName}":`, err);
            try {
                await ctx.telegram.sendMessage(userId, `❌ Ошибка при загрузке трека: ${trackName}`);
            } catch (sendErr) { /* ignore */ }
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
            console.log(`[Cache] Метаданные для ${url} взяты из кэша Redis.`);
            info = JSON.parse(cachedInfo);
        } else {
            info = await ytdl(url, { dumpSingleJson: true });
            await redisClient.setEx(infoKey, 300, JSON.stringify(info)); // Кэш на 5 минут
        }
        
        const isPlaylist = Array.isArray(info.entries);
        let trackInfos = [];

        if (isPlaylist) {
            trackInfos = info.entries.filter(e => e?.webpage_url).map(e => ({
                url: e.webpage_url,
                trackId: e.id || e.title.replace(/\s/g, ''),
                trackName: sanitizeFilename(e.title).slice(0, 64),
                uploader: e.uploader || 'SoundCloud'
            }));
        } else {
            trackInfos = [{ url: info.webpage_url || url, trackId: info.id || info.title.replace(/\s/g, ''), trackName: sanitizeFilename(info.title).slice(0, 64), uploader: info.uploader || 'SoundCloud' }];
        }
        
        if (trackInfos.length > remainingLimit) {
            await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но вам доступно только ${remainingLimit}. Обрабатываю первые ${remainingLimit}.`);
            trackInfos = trackInfos.slice(0, remainingLimit);
        }

        const tasksForQueue = []; 
        const tasksFromCache = [];

        await Promise.all(trackInfos.map(async (track) => {
            const fileIdKey = `fileId:${track.url}`;
            const cachedFileId = await redisClient.get(fileIdKey);
            if (cachedFileId) {
                tasksFromCache.push({ ...track, fileId: cachedFileId });
            } else {
                tasksForQueue.push(track);
            }
        }));

        if (tasksFromCache.length > 0) {
            console.log(`⚡️ Найдено в кэше: ${tasksFromCache.length} треков.`);
            
            await pool.query(
                `UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`,
                [tasksFromCache.length, userId]
            );
            
            const CHUNK_SIZE = 10;
            for (let i = 0; i < tasksFromCache.length; i += CHUNK_SIZE) {
                const chunk = tasksFromCache.slice(i, i + CHUNK_SIZE);
                const mediaGroup = chunk.map(track => ({ type: 'audio', media: track.fileId, title: track.trackName, performer: track.uploader }));
                
                try {
                    await ctx.telegram.sendMediaGroup(userId, mediaGroup);
                } catch (e) {
                    console.warn(`⚠️ Ошибка MediaGroup: ${e.message}. Пробую отправить по одному.`);
                    for (const track of chunk) {
                        try {
                            await ctx.telegram.sendAudio(userId, track.fileId, { title: track.trackName, performer: track.uploader });
                        } catch (err) {
                            if (err.description?.includes('FILE_REFERENCE_EXPIRED') || err.description?.includes('file reference')) {
                                console.warn(`-- Невалидный file_id для ${track.url}. Отправляю на перезалив.`);
                                await redisClient.del(`fileId:${track.url}`);
                                tasksForQueue.push(track);
                            } else {
                                console.error(`-- Не удалось отправить трек ${track.trackName} по другой причине.`, err);
                            }
                        }
                    }
                }
            }
            
            tasksFromCache.forEach(track => {
                saveTrackForUser(userId, track.trackName, track.fileId).catch(err => console.warn(`Ошибка фонового сохранения истории:`, err));
            });
            await ctx.reply(`✅ ${tasksFromCache.length} трек(ов) отправлено мгновенно из кэша!`);
        }
        
        if (tasksForQueue.length > 0) {
            if (isPlaylist) {
                const playlistKey = `playlist:${userId}:${url}`;
                await redisClient.setEx(playlistKey, 3600, tasksForQueue.length);
                await logEvent(userId, 'download_playlist');
            }

            await pool.query(
                `UPDATE users SET downloads_today = downloads_today + $1, total_downloads = total_downloads + $1 WHERE id = $2`,
                [tasksForQueue.length, userId]
            );

            for (const track of tasksForQueue) {
                downloadQueue.add({
                    ctx, userId, ...track,
                    playlistUrl: isPlaylist ? url : null,
                    priority: user.premium_limit,
                });
                await logEvent(userId, 'download');
            }
            
            await ctx.telegram.sendMessage(userId, `⏳ ${tasksForQueue.length} трек(ов) добавлено в очередь на скачивание.`);
        }

    } catch (e) {
        console.error(`❌ Ошибка в enqueue для userId ${userId}:`, e);
        await ctx.reply(texts.error + '\nВозможно, ссылка недействительна или защищена от скачивания.');
    }
}