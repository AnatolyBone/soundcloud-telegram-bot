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
import { pool, getUser, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;

function sanitizeFilename(name) { return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim(); }

async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        console.log(`[Worker] Анализ: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });
        if (!info) throw new Error('Не удалось получить метаданные');

        // --- Обработка плейлиста ---
        if (Array.isArray(info.entries)) {
            console.log(`[Worker] Обнаружен плейлист с ${info.entries.length} треками.`);
            let trackInfos = info.entries.filter(e => e?.webpage_url);
            
            const user = await getUser(userId);
            let remainingLimit = user.premium_limit - user.downloads_today;

            if (user.premium_limit <= 10 && trackInfos.length > MAX_PLAYLIST_TRACKS_FREE) {
                await ctx.telegram.sendMessage(userId, `ℹ️ Доступно до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
                trackInfos = trackInfos.slice(0, MAX_PLAYLIST_TRACKS_FREE);
            }
            if (trackInfos.length > remainingLimit) {
                await ctx.telegram.sendMessage(userId, `⚠️ Ваш лимит ${remainingLimit}. Добавляю только доступное количество.`);
                trackInfos = trackInfos.slice(0, remainingLimit);
            }

            if (trackInfos.length > 0) {
                 await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Добавляю ${trackInfos.length} треков в очередь...`);
                 for (const entry of trackInfos) {
                    // Просто добавляем треки в очередь. Лимит для них спишется, когда
                    // воркер возьмет их на обработку как одиночные треки.
                    downloadQueue.add({ ctx, userId, url: entry.webpage_url, priority });
                 }
            }
            return;
        }
        
        // --- Обработка одиночного трека (ЕДИНАЯ ТОЧКА ДЛЯ ВСЕХ ТРЕКОВ) ---
        
        // Атомарно проверяем лимит и списываем его
        const updatedUser = await incrementDownloads(userId, info.title);
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }
        
        const trackUrl = info.webpage_url || url;
        const trackName = sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT);
        const fileIdKey = `fileId:${trackUrl}`;
        const cachedFileId = await redisClient.get(fileIdKey);

        if (cachedFileId) {
            console.log(`⚡️ Отправка из кэша: ${trackName}`);
            try {
                await ctx.telegram.sendAudio(userId, cachedFileId);
                await saveTrackForUser(userId, trackName, cachedFileId);
            } catch (err) {
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    console.warn(`-- Невалидный file_id для ${trackUrl}. Скачиваю заново.`);
                    await redisClient.del(fileIdKey);
                    await trackDownloadProcessor({ ...task, priority: priority + 1 }); // Рекурсивный вызов для перезаливки
                }
            }
            return;
        }
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        const trackId = info.id || trackName.replace(/\s/g, '');
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(trackUrl, { /* ... опции ... */ });
        // ... (проверки файла) ...

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

    } catch (err) {
        // ... (обработка ошибок) ...
    } finally {
        // ... (очистка) ...
    }
}

// --- Инициализация очереди ---
export const downloadQueue = new TaskQueue({ /* ... */ });

// --- Быстрая enqueue ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        
        // Просто проверяем, есть ли хотя бы ОДИН свободный слот.
        const user = await getUser(userId);
        if (user.downloads_today >= user.premium_limit) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }

        downloadQueue.add({
            ctx,
            userId,
            url,
            priority: user.premium_limit,
        });

        await ctx.reply(`✅ Ссылка принята! Позиция в очереди: ~${downloadQueue.size}.`);
    } catch (e) {
        // ...
    }
}