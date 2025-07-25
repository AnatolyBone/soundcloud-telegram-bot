// services/downloadManager.js (Упрощенная версия)

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';

import { config } from '../config.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { getUser, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

function sanitizeFilename(name) { return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim(); }

// --- Простой и надежный обработчик задач ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        console.log(`[Worker] Начинаю обработку: ${url}`);
        
        // --- ШАГ 1: Проверка кэша file_id (самая важная оптимизация) ---
        const fileIdKey = `fileId:${url}`;
        const cachedFileId = await redisClient.get(fileIdKey);
        if (cachedFileId) {
            console.log(`⚡️ Отправка из кэша: ${url}`);
            try {
                await ctx.telegram.sendAudio(userId, cachedFileId);
                await saveTrackForUser(userId, "трек из кэша", cachedFileId);
                return;
            } catch (err) {
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    console.warn(`-- Невалидный file_id для ${url}. Скачиваю заново.`);
                    await redisClient.del(fileIdKey); // Удаляем старый ключ
                } else { throw err; }
            }
        }

        // --- ШАГ 2: Скачивание (если в кэше нет) ---
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });
        if (!info) throw new Error('Не удалось получить метаданные');

        // Обработка плейлиста
        if (Array.isArray(info.entries)) {
            await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Добавляю ${info.entries.length} треков в очередь...`);
            for (const entry of info.entries) {
                if (entry.webpage_url) {
                    // Просто добавляем обратно в очередь, лимит уже списан в enqueue
                    downloadQueue.add({ ctx, userId, url: entry.webpage_url, priority });
                }
            }
            return; // Завершаем "мастер-задачу" плейлиста
        }

        // Обработка одиночного трека
        const trackName = sanitizeFilename(info.title).slice(0, config.TRACK_TITLE_LIMIT);
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader}"`
        });

        if (!fs.existsSync(tempFilePath)) throw new Error('ytdl не создал файл');

        if ((await fs.promises.stat(tempFilePath)).size / (1024 * 1024) > config.TELEGRAM_FILE_LIMIT_MB) {
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (>50МБ).`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        
        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, config.FILE_ID_CACHE_SECONDS, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

    } catch (err) {
        console.error(`❌ Ошибка в воркере для ${url}:`, err.stderr || err.message);
        await ctx.telegram.sendMessage(userId, `❌ Произошла ошибка при обработке трека.`).catch(() => {});
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

// --- Инициализация очереди ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: config.MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor,
});

// --- Простая и быстрая enqueue ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        
        const updatedUser = await incrementDownloads(userId, url); // Атомарно списываем лимит
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([/*...*/]));
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