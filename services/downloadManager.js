// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';
import { fileTypeFromFile } from 'file-type';

// === ИСПРАВЛЕНИЕ ЗДЕСЬ ===
import { config } from '../config.js'; // Сначала импортируем config
import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { pool, getUser, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

// А потом деструктурируем его
const {
    telegramFileLimitMb,
    maxPlaylistTracksFree,
    trackTitleLimit,
    maxConcurrentDownloads,
    rateLimit,
    fileIdCacheSeconds,
    playlistTrackerSeconds
} = config;
// =========================

// --- Утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

// --- "Умный" обработчик задач ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        console.log(`[Worker] Анализ: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });
        if (!info) throw new Error(`Не удалось получить метаданные для ${url}`);

        if (Array.isArray(info.entries)) {
            let trackInfos = info.entries.filter(e => e?.webpage_url);
            const user = await getUser(userId);
            const { rows } = await pool.query('SELECT downloads_today, premium_limit FROM users WHERE id = $1', [userId]);
            let remainingLimit = rows[0].premium_limit - rows[0].downloads_today;

            if (user.premium_limit <= 10 && trackInfos.length > maxPlaylistTracksFree) {
                await ctx.telegram.sendMessage(userId, `ℹ️ На бесплатном тарифе можно добавить до ${maxPlaylistTracksFree} треков из плейлиста.`);
                trackInfos = trackInfos.slice(0, maxPlaylistTracksFree);
            }
            if (trackInfos.length > remainingLimit) {
                await ctx.telegram.sendMessage(userId, `⚠️ Ваш лимит ${remainingLimit}. Добавляю только доступное количество.`);
                trackInfos = trackInfos.slice(0, remainingLimit);
            }
            if (trackInfos.length > 0) {
                 await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Добавляю ${trackInfos.length} треков в очередь...`);
                 for (const entry of trackInfos) {
                    downloadQueue.add({ ctx, userId, url: entry.webpage_url, priority });
                 }
            }
            return;
        }
        
        const updatedUser = await incrementDownloads(userId, info.title);
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached).catch(() => {});
        }
        
        const trackUrl = info.webpage_url || url;
        const trackName = sanitizeFilename(info.title).slice(0, trackTitleLimit);
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
                    await trackDownloadProcessor({ ...task, priority: priority + 1 });
                    return;
                } else {
                    await pool.query('UPDATE users SET downloads_today = downloads_today - 1, total_downloads = total_downloads - 1 WHERE id = $1', [userId]);
                    throw err;
                }
            }
        }
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        const trackId = info.id || trackName.replace(/\s/g, '');
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(trackUrl, { extractAudio: true, audioFormat: 'mp3', output: tempFilePath, embedMetadata: true, postprocessorArgs: `-metadata artist="${uploader}"`, retries: 3 });
        
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`ytdl не создал файл для трека: ${trackName}`);
        }

        const fileType = await fileTypeFromFile(tempFilePath);
        if (fileType?.mime !== 'audio/mpeg') {
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" имеет неверный формат.`);
            await pool.query('UPDATE users SET downloads_today = downloads_today - 1, total_downloads = total_downloads - 1 WHERE id = $1', [userId]);
            return;
        }
        
        if ((await fs.promises.stat(tempFilePath)).size / (1024 * 1024) > telegramFileLimitMb) {
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (>50МБ).`);
            await pool.query('UPDATE users SET downloads_today = downloads_today - 1, total_downloads = total_downloads - 1 WHERE id = $1', [userId]);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        
        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, fileIdCacheSeconds, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

    } catch (err) {
        if (err.stderr?.includes('404')) {
            await ctx.telegram.sendMessage(userId, `❌ Трек по ссылке не найден.`).catch(() => {});
        } else {
            console.error(`❌ Ошибка в воркере для ${url}:`, err.stderr || err.message || err);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
    }
}

// --- Инициализация очереди ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: maxConcurrentDownloads,
    taskProcessor: trackDownloadProcessor,
});

// --- Быстрая enqueue ---
export async function enqueue(ctx, userId, url) {
    const redisClient = getRedisClient();
    
    const rateLimitKey = `rate-limit:${userId}`;
    const currentUserRequests = await redisClient.incr(rateLimitKey);
    if (currentUserRequests === 1) {
        await redisClient.expire(rateLimitKey, rateLimit.windowMs / 1000);
    }
    if (currentUserRequests > rateLimit.max) {
        console.warn(`[RateLimit] Пользователь ${userId} превысил лимит запросов.`);
        return; 
    }

    try {
        await logUserActivity(userId);
        
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
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}