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

// --- Новый, "умный" обработчик задач ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority } = task; // Задача теперь очень простая
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        // --- ШАГ 1: ПОЛУЧЕНИЕ МЕТАДАННЫХ (теперь здесь) ---
        console.log(`[Worker] Анализ: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });

        // --- ШАГ 2: ОБРАБОТКА ПЛЕЙЛИСТА ---
        if (Array.isArray(info.entries)) {
            console.log(`[Worker] Обнаружен плейлист с ${info.entries.length} треками.`);
            let trackInfos = info.entries.filter(e => e?.webpage_url);
            
            const user = await getUser(userId); // Нужен для проверки лимитов
            let remainingLimit = user.premium_limit - user.downloads_today;
            
            if (user.premium_limit <= 10 && trackInfos.length > MAX_PLAYLIST_TRACKS_FREE) {
                await ctx.telegram.sendMessage(userId, `ℹ️ На бесплатном тарифе можно добавить до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
                trackInfos = trackInfos.slice(0, MAX_PLAYLIST_TRACKS_FREE);
            }
            if (trackInfos.length > remainingLimit) {
                await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но ваш лимит ${remainingLimit}. Добавляю только доступное количество.`);
                trackInfos = trackInfos.slice(0, remainingLimit);
            }

            if (trackInfos.length > 0) {
                 await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Добавляю ${trackInfos.length} треков в очередь...`);
                 // Рекурсивно добавляем каждую песню как отдельную, атомарную задачу
                 for (const entry of trackInfos) {
                    // Атомарно инкрементируем счетчик перед добавлением
                    const updatedUser = await incrementDownloads(userId, entry.title || 'Трек из плейлиста');
                    if (!updatedUser) {
                        await ctx.telegram.sendMessage(userId, `🚫 Ваш лимит исчерпан. Не все треки из плейлиста были добавлены.`);
                        break; // Прерываем добавление, если лимит кончился
                    }
                    downloadQueue.add({ ctx, userId, url: entry.webpage_url, priority });
                 }
            }
            return; // Завершаем обработку "мастер-задачи" плейлиста
        }

        // --- ШАГ 3: ОБРАБОТКА ОДИНОЧНОГО ТРЕКА ---
        const trackUrl = info.webpage_url || url;
        const trackName = sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT);
        const trackId = info.id || trackName.replace(/\s/g, '');
        const uploader = info.uploader || 'SoundCloud';

        const fileIdKey = `fileId:${trackUrl}`;
        const cachedFileId = await redisClient.get(fileIdKey);
        if (cachedFileId) {
            console.log(`⚡️ Отправка из кэша (в воркере): ${trackName}`);
            await ctx.telegram.sendAudio(userId, cachedFileId);
            await saveTrackForUser(userId, trackName, cachedFileId);
            return;
        }
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        await ytdl(trackUrl, {
            extractAudio: true, audioFormat: 'mp3', output: tempFilePath,
            embedMetadata: true, postprocessorArgs: `-metadata artist="${uploader}"`, retries: 3,
        });
        
        const fileType = await fileTypeFromFile(tempFilePath);
        if (fileType?.mime !== 'audio/mpeg') throw new Error('Скачанный файл не является MP3');

        if ((await fs.promises.stat(tempFilePath)).size / (1024*1024) > TELEGRAM_FILE_LIMIT_MB) {
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (>50МБ).`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        
        if (message?.audio?.file_id) {
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, message.audio.file_id);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }

    } catch (err) {
        if (err.stderr?.includes('404')) {
            await ctx.telegram.sendMessage(userId, `❌ Не удалось найти трек по ссылке. Возможно, он удален или приватный.`);
        } else {
            console.error(`❌ Ошибка в воркере для ${url}:`, err);
        }
        // Не пробрасываем ошибку, чтобы не засорять логи Telegraf'а
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

// --- НОВАЯ, СУПЕР-БЫСТРАЯ enqueue ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        
        // Атомарно проверяем лимит и инкрементируем счетчик
        const updatedUser = await incrementDownloads(userId, url); // Передаем URL как временное имя
        if (!updatedUser) {
            // Если инкремент не удался (лимит исчерпан), сообщаем и выходим
            return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([/*...*/]));
        }

        // Мгновенно ставим задачу в очередь
        downloadQueue.add({
            ctx,
            userId,
            url,
            priority: updatedUser.premium_limit,
        });

        // Мгновенно отвечаем пользователю
        await ctx.reply(`✅ Ваша ссылка принята! Позиция в очереди: ~${downloadQueue.size}. Обработка начнется в фоновом режиме.`);

    } catch (e) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}