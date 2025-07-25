// services/downloadManager.js (ГИБРИДНАЯ ВЕРСИЯ)

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { config } from '../config.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { getUser, incrementDownloads, saveTrackForUser, findCachedTrack, cacheTrack } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

// --- Воркер, который делает ТОЛЬКО медленную работу ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url } = task;
    let tempFilePath = null;

    try {
        console.log(`[Worker] Скачивание (промах кэша): ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true });
        
        const trackName = (info.title || 'track').slice(0, 100);
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);

        await ytdl(url, { output: tempFilePath, extractAudio: true, audioFormat: 'mp3', embedMetadata: true, postprocessorArgs: `-metadata artist="${uploader}"` });

        if (!fs.existsSync(tempFilePath)) throw new Error('ytdl не создал файл');
        if ((await fs.promises.stat(tempFilePath)).size / (1024*1024) > config.TELEGRAM_FILE_LIMIT_MB) {
            return ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" слишком большой (>50МБ).`);
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: uploader });
        
        if (message?.audio?.file_id) {
            // ГЛАВНЫЙ МОМЕНТ: Сохраняем в наш глобальный кэш для будущих пользователей
            await cacheTrack(url, message.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }
    } catch (err) {
        console.error(`❌ Ошибка в воркере для ${url}:`, err.stderr || err.message);
        await ctx.telegram.sendMessage(userId, '❌ Ошибка при скачивании трека.').catch(() => {});
    } finally {
        if (tempFilePath) await fs.promises.unlink(tempFilePath).catch(() => {});
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: config.MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor,
});

// --- НОВАЯ enqueue С ДВУМЯ КОНТУРАМИ ---
export async function enqueue(ctx, userId, url) {
    try {
        const user = await getUser(userId);
        if (user.downloads_today >= user.premium_limit) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }

        // --- КОНТУР 1: БЫСТРЫЙ ПУТЬ ---
        const cachedFileId = await findCachedTrack(url);
        if (cachedFileId) {
            console.log(`⚡️ Мгновенная отправка из БД-кэша: ${url}`);
            await incrementDownloads(userId, "трек из кэша");
            await ctx.telegram.sendAudio(userId, cachedFileId);
            await saveTrackForUser(userId, "трек из кэша", cachedFileId);
            return;
        }

        // --- КОНТУР 2: МЕДЛЕННЫЙ ПУТЬ ---
        // Обработка плейлиста
        if (url.includes('/sets/')) {
            await ctx.reply('⏳ Анализирую плейлист...');
            const info = await ytdl(url, { flatPlaylist: true, dumpSingleJson: true });
            if (!info.entries) throw new Error('Не удалось проанализировать плейлист');

            let tracksToQueue = info.entries.slice(0, user.premium_limit - user.downloads_today);
            if (tracksToQueue.length < info.entries.length) {
                await ctx.reply(`ℹ️ Ваш лимит позволяет добавить только ${tracksToQueue.length} треков из плейлиста.`);
            }

            for (const entry of tracksToQueue) {
                const updatedUser = await incrementDownloads(userId, entry.title || 'трек из плейлиста');
                if (!updatedUser) break;
                // Сразу проверяем кэш и для треков плейлиста
                const cachedTrack = await findCachedTrack(entry.url);
                if (cachedTrack) {
                    await ctx.telegram.sendAudio(userId, cachedTrack);
                    await saveTrackForUser(userId, entry.title || "трек из кэша", cachedTrack);
                } else {
                    downloadQueue.add({ ctx, userId, url: entry.url, priority: user.premium_limit });
                }
            }
            await ctx.reply(`✅ Добавлено ${tracksToQueue.length} треков. Они будут обработаны в фоновом режиме.`);
            return;
        }

        // Обработка одиночного трека
        await incrementDownloads(userId, url);
        await ctx.reply(`✅ Трек добавлен в очередь на скачивание. Позиция: ~${downloadQueue.size}`);
        downloadQueue.add({ ctx, userId, url, priority: user.premium_limit });

    } catch (e) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}