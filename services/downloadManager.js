// services/downloadManager.js (Исправленная гибридная версия)

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

function sanitizeFilename(name) { return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim(); }

// --- Воркер, который делает ТОЛЬКО медленную работу: скачивает и пополняет кэш ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url } = task;
    let tempFilePath = null;
    
    try {
        console.log(`[Worker] Скачивание (промах кэша): ${url}`);
        
        const info = await ytdl(url, { dumpSingleJson: true });
        if (!info || Array.isArray(info.entries)) return; // Воркер не обрабатывает плейлисты
        
        const trackName = sanitizeFilename(info.title).slice(0, config.TRACK_TITLE_LIMIT);
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);
        
        // Скачиваем файл ОДНИМ вызовом ytdl
        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
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
            // ГЛАВНЫЙ МОМЕНТ: Пополняем глобальный кэш для будущих пользователей
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

// --- "Умная" enqueue с двумя контурами ---
export async function enqueue(ctx, userId, url) {
    try {
        const user = await getUser(userId);
        if (user.downloads_today >= user.premium_limit) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }
        
        // --- КОНТУР 1: БЫСТРЫЙ ПУТЬ (проверка глобального кэша) ---
        const cachedFileId = await findCachedTrack(url);
        if (cachedFileId) {
            console.log(`⚡️ Мгновенная отправка из БД-кэша: ${url}`);
            const updatedUser = await incrementDownloads(userId, "трек из кэша", url);
            if (!updatedUser) return ctx.telegram.sendMessage(userId, texts.limitReached);
            
            await ctx.telegram.sendAudio(userId, cachedFileId);
            await saveTrackForUser(userId, "трек из кэша", cachedFileId);
            return;
        }
        
        // --- КОНТУР 2: МЕДЛЕННЫЙ ПУТЬ (обработка ссылки) ---
        
        // Обработка плейлиста
        if (url.includes('/sets/')) {
            await ctx.reply('⏳ Анализирую плейлист...');
            const info = await ytdl(url, { flatPlaylist: true, dumpSingleJson: true });
            if (!info.entries) throw new Error('Не удалось проанализировать плейлист');
            
            const currentUser = await getUser(userId); // Получаем свежие данные по лимитам
            let tracksToProcess = info.entries.slice(0, currentUser.premium_limit - currentUser.downloads_today);
            
            if (tracksToProcess.length < info.entries.length) {
                await ctx.reply(`ℹ️ Ваш лимит позволяет добавить только ${tracksToProcess.length} треков из этого плейлиста.`);
            }
            if (tracksToProcess.length === 0) {
                return ctx.reply(`🚫 Ваш дневной лимит исчерпан.`);
            }
            
            await ctx.reply(`✅ Добавляю ${tracksToProcess.length} треков. Они будут обработаны в фоновом режиме.`);
            
            // Отправляем каждый трек плейлиста на обработку через ту же enqueue
            for (const entry of tracksToProcess) {
                // Вызываем enqueue для каждого трека, чтобы он прошел через проверку кэша
                // Это не рекурсия, а просто повторный вызов
                await enqueue(ctx, userId, entry.url);
            }
            return;
        }
        
        // Обработка одиночного трека (которого нет в кэше)
        const updatedUser = await incrementDownloads(userId, "неизвестный трек", url);
        if (!updatedUser) {
            return ctx.telegram.sendMessage(userId, texts.limitReached);
        }
        await ctx.reply(`✅ Трек добавлен в очередь на скачивание. Позиция: ~${downloadQueue.size}`);
        downloadQueue.add({ ctx, userId, url, priority: user.premium_limit });
        
    } catch (e) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, e);
        await ctx.reply(texts.error);
    }
}