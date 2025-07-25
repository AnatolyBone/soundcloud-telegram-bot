// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';
import crypto from 'crypto';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts, bot } from '../index.js';
import {
    pool,
    getUser,
    resetDailyLimitIfNeeded,
    saveTrackForUser,
    logEvent,
    logUserActivity,
    incrementDownloads,
    updateUserField,
    findCachedTrack, // <<< ВАЖНО: Убедись, что этот импорт есть и функция в db.js обновлена
    cacheTrack      // <<< ВАЖНО: Убедись, что этот импорт есть
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

// Вспомогательная функция для безопасной отправки сообщений
async function safeSendMessage(ctx, userId, text, extra = {}) {
    try {
        await bot.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.response?.error_code === 403) {
            console.warn(`[SafeSend] Пользователь ${userId} заблокировал бота.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`[SafeSend] Ошибка отправки сообщения для ${userId}:`, e.message);
        }
    }
}

// --- Основной обработчик одной задачи ---
async function trackDownloadProcessor(task) {
    const { userId, url, trackName, trackId, uploader, playlistUrl } = task;
    let tempFilePath = null;
    
    try {
        console.log(`[Worker] Скачивание: ${trackName}`);
        
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}"`,
            retries: 3
        });
        
        const stats = await fs.promises.stat(tempFilePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        
        if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
            await safeSendMessage(null, userId, `❌ Трек "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} МБ).`);
            return;
        }
        
        // Отправляем аудио с подписью (caption)
        const message = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName, // <<< ГЛАВНОЕ ИЗМЕНЕНИЕ
            title: trackName,
            performer: uploader || 'SoundCloud'
        });
        
        if (message?.audio?.file_id) {
            // Кэшируем в базу данных, а не в Redis!
            await cacheTrack(url, message.audio.file_id, trackName);
            await saveTrackForUser(userId, message.audio.file_id, trackName);
        }
        
        if (playlistUrl) {
            const redisClient = getRedisClient();
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await safeSendMessage(null, userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }
        
    } catch (err) {
        if (err.response?.error_code === 403) {
            console.warn(`[UserDisconnected] Пользователь ${userId} заблокировал бота.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`❌ Ошибка загрузки "${trackName}":`, err.stderr || err.message);
            await safeSendMessage(null, userId, `❌ Не удалось загрузить трек: "${trackName}"`);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
        }
    }
}

// --- Очередь задач ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: 8,
    taskProcessor: trackDownloadProcessor
});

// --- Основной входной метод ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        
        // Безопасная отправка сообщения
        await safeSendMessage(ctx, userId, '🔍 Анализирую ссылку...');
        
        // Используем ytdl для получения метаданных (без Redis кэширования, так как ytdl быстрый)
        const info = await ytdl(url, { dumpSingleJson: true, retries: 2 });
        if (!info) throw new Error('Не удалось получить метаданные');
        
        const isPlaylist = Array.isArray(info.entries);
        let tracks = [];
        
        if (isPlaylist) {
            tracks = info.entries
                .filter(e => e?.webpage_url)
                .map(e => ({
                    url: e.webpage_url,
                    trackId: e.id || e.title.replace(/\s/g, ''),
                    trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
                    uploader: e.uploader || 'SoundCloud'
                }));
        } else {
            tracks = [{
                url: info.webpage_url || url,
                trackId: info.id || info.title.replace(/\s/g, ''),
                trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: info.uploader || 'SoundCloud'
            }];
        }
        
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;
        
        if (remainingLimit <= 0) {
            return await safeSendMessage(ctx, userId, texts.limitReached, Markup.inlineKeyboard([]));
        }
        
        if (isPlaylist && user.premium_limit <= 10 && tracks.length > MAX_PLAYLIST_TRACKS_FREE) {
            await safeSendMessage(ctx, userId, `ℹ️ Бесплатный тариф: максимум ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            tracks = tracks.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        if (tracks.length > remainingLimit) {
            await safeSendMessage(ctx, userId, `⚠️ В плейлисте ${tracks.length} треков, но ваш лимит: ${remainingLimit}. Добавляю доступные.`);
            tracks = tracks.slice(0, remainingLimit);
        }
        
        const tasksFromCache = [];
        const tasksToDownload = [];
        
        // Разделяем треки на те, что есть в кэше, и те, что нужно скачать
        for (const track of tracks) {
            const cachedTrack = await findCachedTrack(track.url); // <<< Используем новую функцию
            if (cachedTrack) {
                tasksFromCache.push(cachedTrack);
            } else {
                tasksToDownload.push(track);
            }
        }
        
        // 1. Отправляем треки из кэша мгновенно
        let sentFromCacheCount = 0;
        for (const track of tasksFromCache) {
            try {
                // Отправляем с подписью!
                await bot.telegram.sendAudio(userId, track.fileId, {
                    caption: track.trackName,
                    title: track.trackName,
                    performer: track.uploader || 'SoundCloud'
                });
                await saveTrackForUser(userId, track.fileId, track.trackName);
                await incrementDownloads(userId);
                sentFromCacheCount++;
            } catch (err) {
                 if (err.response?.error_code === 403) {
                    await updateUserField(userId, 'active', false);
                    break; // Если юзер заблокировал, нет смысла продолжать
                } else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    console.warn(`[Cache Expired] Ссылка на файл для ${track.url} истекла. Отправляем на скачивание.`);
                    tasksToDownload.push(track); // Добавляем в очередь на повторное скачивание
                } else {
                    console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            }
        }
        
        if (sentFromCacheCount > 0) {
            await safeSendMessage(ctx, userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
        }
        
        // 2. Ставим оставшиеся треки в очередь на скачивание
        if (tasksToDownload.length > 0) {
            const userAfterCache = await getUser(userId);
            const currentLimit = userAfterCache.premium_limit - userAfterCache.downloads_today;

            if (currentLimit <= 0) {
                 return await safeSendMessage(ctx, userId, '🚫 Ваш лимит исчерпан треками из кэша.');
            }

            const tasksToReallyDownload = tasksToDownload.slice(0, currentLimit);
            
            if (tasksToReallyDownload.length < tasksToDownload.length) {
                 await safeSendMessage(ctx, userId, `⚠️ Ваш лимит позволяет скачать еще ${tasksToReallyDownload.length} треков. Остальные не будут добавлены.`);
            }
            
            if (tasksToReallyDownload.length > 0) {
                await safeSendMessage(ctx, userId, `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь на скачивание.`);
                
                if (isPlaylist) {
                    const redisClient = getRedisClient();
                    const playlistKey = `playlist:${userId}:${url}`;
                    await redisClient.setEx(playlistKey, 3600, tasksToReallyDownload.length.toString());
                    await logEvent(userId, 'download_playlist');
                }
                
                for (const track of tasksToReallyDownload) {
                    await incrementDownloads(userId);
                    downloadQueue.add({
                        userId,
                        ...track,
                        playlistUrl: isPlaylist ? url : null,
                        priority: user.premium_limit
                    });
                    await logEvent(userId, 'download');
                }
            }
        }
        
    } catch (err) {
        console.error(`❌ Глобальная ошибка в enqueue для userId ${userId}:`, err.message);
        await safeSendMessage(ctx, userId, texts.error);
    }
}