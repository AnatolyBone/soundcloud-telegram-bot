// services/downloadManager.js (с "ленивым" анализом)

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';

import { config } from '../config.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { pool, getUser, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

function sanitizeFilename(name) { return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim(); }


async function trackDownloadProcessor(task) {
    const { ctx, userId, url, priority, isPlaylistExtraction } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    try {
        // --- ШАГ 1: БЫСТРАЯ РАСПАКОВКА ПЛЕЙЛИСТА ---
        if (isPlaylistExtraction) {
            console.log(`[Worker] Быстрый анализ плейлиста: ${url}`);
            const playlistInfo = await ytdl(url, {
                flatPlaylist: true, // Получаем только список URL, это очень быстро
                dumpSingleJson: true,
            });

            if (!playlistInfo.entries || playlistInfo.entries.length === 0) return;

            await ctx.telegram.sendMessage(userId, `✅ Плейлист принят. Найдено ${playlistInfo.entries.length} треков. Добавляю в очередь...`);
            for (const entry of playlistInfo.entries) {
                // Добавляем уже как обычные задачи
                downloadQueue.add({ ctx, userId, url: entry.url, priority });
            }
            return;
        }

        // --- ШАГ 2: ОБРАБОТКА ОДИНОЧНОГО ТРЕКА ---
        console.log(`[Worker] Анализ трека: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true, retries: 3 });
        if (!info || Array.isArray(info.entries)) return; // Игнорируем плейлисты на этом этапе

        const trackUrl = info.webpage_url || url;
        const trackName = sanitizeFilename(info.title).slice(0, config.TRACK_TITLE_LIMIT);
        const fileIdKey = `fileId:${trackUrl}`;
        const cachedFileId = await redisClient.get(fileIdKey);

        if (cachedFileId) {
            console.log(`⚡️ Отправка из кэша: ${trackName}`);
            await ctx.telegram.sendAudio(userId, cachedFileId);
            await saveTrackForUser(userId, trackName, cachedFileId);
            return;
        }
        
        console.log(`[Worker] Скачивание: ${trackName}`);
        const trackId = info.id || trackName.replace(/\s/g, '');
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${trackId}-${Date.now()}.mp3`);
        
        await ytdl(trackUrl, { extractAudio: true, audioFormat: 'mp3', output: tempFilePath, embedMetadata: true, postprocessorArgs: `-metadata artist="${uploader}"`, retries: 3 });
        
        if (!fs.existsSync(tempFilePath)) throw new Error(`ytdl не создал файл`);
        if ((await fs.promises.stat(tempFilePath)).size / (1024*1024) > config.TELEGRAM_FILE_LIMIT_MB) {
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
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: config.MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor,
});

export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        
        const updatedUser = await incrementDownloads(userId, url);
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([/*...*/]));
        }

        // Просто определяем тип задачи по URL
        const isPlaylist = url.includes('/sets/');
        
        downloadQueue.add({
            ctx,
            userId,
            url,
            priority: updatedUser.premium_limit,
            isPlaylistExtraction: isPlaylist, // Добавляем флаг для воркера
        });

        await ctx.reply(`✅ Ссылка принята! Позиция в очереди: ~${downloadQueue.size}.`);
    } catch (e) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}