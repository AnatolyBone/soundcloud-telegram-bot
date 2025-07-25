// services/downloadManager.js (Упрощенная и быстрая версия)

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';

import { config } from '../config.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { getUser, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

// --- Константы из конфига ---
const { telegramFileLimitMb, maxPlaylistTracksFree, trackTitleLimit, maxConcurrentDownloads, rateLimit, fileIdCacheSeconds, metadataCacheSeconds } = config;

// --- Утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

function sanitizeFilename(name) { return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim(); }


async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        console.log(`[Worker] Анализ: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });
        if (!info) throw new Error('Не удалось получить метаданные');

        // Обработка плейлиста
        if (Array.isArray(info.entries)) {
            let trackInfos = info.entries.filter(e => e?.webpage_url);
            const user = await getUser(userId);
            // Простая проверка без сложных откатов
            if (user.premium_limit <= 10 && trackInfos.length > maxPlaylistTracksFree) {
                trackInfos = trackInfos.slice(0, maxPlaylistTracksFree);
            }
            if (trackInfos.length > 0) {
                 await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Добавляю ${trackInfos.length} треков в очередь...`);
                 for (const entry of trackInfos) {
                    downloadQueue.add({ ctx, userId, url: entry.webpage_url, priority });
                 }
            }
            return;
        }
        
        // Обработка одиночного трека
        const trackUrl = info.webpage_url || url;
        const trackName = sanitizeFilename(info.title).slice(0, trackTitleLimit);
        
        // Лимит уже списан в enqueue
        
        const fileIdKey = `fileId:${trackUrl}`;
        const cachedFileId = await redisClient.get(fileIdKey);

        if (cachedFileId) {
            console.log(`⚡️ Отправка из кэша: ${trackName}`);
            try {
                await ctx.telegram.sendAudio(userId, cachedFileId);
                await saveTrackForUser(userId, trackName, cachedFileId);
                return;
            } catch (err) {
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    console.warn(`-- Невалидный file_id для ${trackUrl}. Скачиваю заново.`);
                    await redisClient.del(fileIdKey);
                } else { throw err; }
            }
        }
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        const trackId = info.id || trackName.replace(/\s/g, '');
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${trackId}-${Date.now()}.mp3`); // Упростили имя файла
        
        await ytdl(trackUrl, { extractAudio: true, audioFormat: 'mp3', output: tempFilePath, embedMetadata: true, postprocessorArgs: `-metadata artist="${uploader}"`, retries: 3 });
        
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`ytdl не создал файл для трека: ${trackName}`);
        }
        
        if ((await fs.promises.stat(tempFilePath)).size / (1024*1024) > telegramFileLimitMb) {
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (>50МБ).`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        
        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, fileIdCacheSeconds, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

    } catch (err) {
        console.error(`❌ Ошибка в воркере для ${url}:`, err.stderr || err.message || err);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: maxConcurrentDownloads,
    taskProcessor: trackDownloadProcessor,
});

export async function enqueue(ctx, userId, url) {
    const redisClient = getRedisClient();
    
    const rateLimitKey = `rate-limit:${userId}`;
    const currentUserRequests = await redisClient.incr(rateLimitKey);
    if (currentUserRequests === 1) {
        await redisClient.expire(rateLimitKey, Math.floor(rateLimit.windowMs / 1000));
    }
    if (currentUserRequests > rateLimit.max) {
        return; 
    }

    try {
        await logUserActivity(userId);
        
        // УПРОЩЕННАЯ ЛОГИКА: Списываем лимит сразу.
        // Это быстро и просто. Да, если скачивание не удастся, лимит "сгорит",
        // но это приемлемый компромисс для простоты и скорости.
        const updatedUser = await incrementDownloads(userId, url);
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }

        downloadQueue.add({
            ctx,
            userId,
            url,
            priority: updatedUser.premium_limit,
        });

        await ctx.reply(`✅ Ссылка принята! Позиция в очереди: ~${downloadQueue.size}.`);
    } catch (e) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}