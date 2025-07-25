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
    getUser,
    resetDailyLimitIfNeeded,
    saveTrackForUser,
    logEvent,
    logUserActivity,
    incrementDownloads,
    updateUserField,
    findCachedTrack,
    cacheTrack
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

async function safeSendMessage(userId, text, extra = {}) {
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
        console.log(`[Worker] Начинаю скачивание: ${trackName}`);
        
        tempFilePath = path.join(cacheDir, `${trackId}-${crypto.randomUUID()}.mp3`);
        
        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
            retries: 3
        });
        
        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`Файл не был создан после скачивания: ${tempFilePath}`);
        }
        
        const stats = await fs.promises.stat(tempFilePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        
        if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
            await safeSendMessage(userId, `❌ Трек "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} МБ).`);
            return;
        }
        
        const message = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName,
            title: trackName,
            performer: uploader || 'SoundCloud'
        });
        
        if (message?.audio?.file_id) {
            console.log(`[Worker] Трек "${trackName}" отправлен, кэширую...`);
            // Кэшируем в базу данных
            await cacheTrack(url, message.audio.file_id, trackName);
            // Сохраняем в историю пользователя. ПРАВИЛЬНЫЙ ПОРЯДОК АРГУМЕНТОВ!
            await saveTrackForUser(userId, trackName, message.audio.file_id);
        }
        
        if (playlistUrl) {
            const redisClient = getRedisClient();
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await safeSendMessage(userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }
        
    } catch (err) {
        if (err.response?.error_code === 403) {
            console.warn(`[UserDisconnected] Пользователь ${userId} заблокировал бота.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`❌ Ошибка воркера при обработке "${trackName}":`, err.stderr || err.message || err);
            await safeSendMessage(userId, `❌ Не удалось загрузить трек: "${trackName}"`);
        }
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(e => console.error(`Не удалось удалить временный файл ${tempFilePath}:`, e));
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
        
        await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        const info = await ytdl(url, { dumpSingleJson: true, retries: 2 });
        if (!info) throw new Error('Не удалось получить метаданные по ссылке.');
        
        const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
        let tracks = [];
        
        if (isPlaylist) {
            tracks = info.entries
                .filter(e => e?.webpage_url)
                .map(e => ({
                    url: e.webpage_url,
                    trackId: e.id,
                    trackName: sanitizeFilename(e.title).slice(0, TRACK_TITLE_LIMIT),
                    uploader: e.uploader || 'SoundCloud'
                }));
        } else {
            tracks = [{
                url: info.webpage_url || url,
                trackId: info.id,
                trackName: sanitizeFilename(info.title).slice(0, TRACK_TITLE_LIMIT),
                uploader: info.uploader || 'SoundCloud'
            }];
        }
        
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;
        
        if (remainingLimit <= 0) {
            return await safeSendMessage(userId, texts.limitReached, Markup.inlineKeyboard([]));
        }
        
        if (isPlaylist && user.premium_limit <= 10 && tracks.length > MAX_PLAYLIST_TRACKS_FREE) {
            await safeSendMessage(userId, `ℹ️ Бесплатный тариф: можно скачать до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            tracks = tracks.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        if (tracks.length > remainingLimit) {
            await safeSendMessage(userId, `⚠️ В плейлисте ${tracks.length} треков, но ваш лимит: ${remainingLimit}. Добавляю доступное количество.`);
            tracks = tracks.slice(0, remainingLimit);
        }

        if (tracks.length === 0) {
            return await safeSendMessage(userId, 'Не удалось найти треки для загрузки по этой ссылке.');
        }
        
        const tasksFromCache = [];
        const tasksToDownload = [];
        
        for (const track of tracks) {
            const cachedTrack = await findCachedTrack(track.url);
            if (cachedTrack) {
                tasksFromCache.push({ ...track, ...cachedTrack });
            } else {
                tasksToDownload.push(track);
            }
        }
        
        let sentFromCacheCount = 0;
        if (tasksFromCache.length > 0) {
            for (const track of tasksFromCache) {
                try {
                    await bot.telegram.sendAudio(userId, track.fileId, {
                        caption: track.trackName,
                        title: track.trackName,
                        performer: track.uploader || 'SoundCloud'
                    });
                    await saveTrackForUser(userId, track.trackName, track.fileId);
                    await incrementDownloads(userId);
                    sentFromCacheCount++;
                } catch (err) {
                    if (err.response?.error_code === 403) {
                        await updateUserField(userId, 'active', false);
                        return; // Если юзер заблокировал, нет смысла продолжать
                    } else if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                        console.warn(`[Cache Expired] Ссылка для ${track.url} истекла. Отправляем на скачивание.`);
                        tasksToDownload.push(track);
                    } else {
                        console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                    }
                }
            }
            if (sentFromCacheCount > 0) {
                 await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
            }
        }
        
        if (tasksToDownload.length > 0) {
            const userAfterCache = await getUser(userId);
            const currentLimit = userAfterCache.premium_limit - userAfterCache.downloads_today;
            if (currentLimit <= 0) {
                 return await safeSendMessage(userId, '🚫 Ваш лимит исчерпан треками из кэша.');
            }
            const tasksToReallyDownload = tasksToDownload.slice(0, currentLimit);
            if (tasksToReallyDownload.length < tasksToDownload.length) {
                 await safeSendMessage(userId, `⚠️ Ваш лимит позволяет скачать еще ${tasksToReallyDownload.length} треков. Остальные не будут добавлены.`);
            }
            if (tasksToReallyDownload.length > 0) {
                await safeSendMessage(userId, `⏳ ${tasksToReallyDownload.length} трек(ов) добавлено в очередь на скачивание. Вы получите их по мере готовности.`);
                if (isPlaylist) {
                    const redisClient = getRedisClient();
                    const playlistKey = `playlist:${userId}:${url}`;
                    await redisClient.setEx(playlistKey, 3600, tasksToReallyDownload.length.toString());
                    await logEvent(userId, 'download_playlist');
                }
                for (const track of tasksToReallyDownload) {
                    await incrementDownloads(userId);
                    downloadQueue.add({ userId, ...track, playlistUrl: isPlaylist ? url : null, priority: user.premium_limit });
                    await logEvent(userId, 'download');
                }
            }
        }
    } catch (err) {
        console.error(`❌ Глобальная ошибка в enqueue для userId ${userId}:`, err.stderr || err.message || err);
        await safeSendMessage(userId, texts.error + ' Не удалось обработать ссылку.');
    }
}