// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pLimit from 'p-limit';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts, bot } from '../index.js';
import {
    getUser, resetDailyLimitIfNeeded, saveTrackForUser, logEvent,
    incrementDownloads, updateUserField, findCachedTracksByUrls, cacheTrack
} from '../db.js';

// --- Конфигурация ---

const CONFIG = {
    TELEGRAM_FILE_LIMIT_MB: 49,
    MAX_PLAYLIST_TRACKS_FREE: 10,
    TRACK_TITLE_LIMIT: 100,
    MAX_CONCURRENT_DOWNLOADS: 5, // чуть больше параллелизма
    YTDL_TIMEOUT: 180,
    YTDL_RETRIES: 3,
    SOCKET_TIMEOUT: 120,
    MAX_CACHE_SEND_CONCURRENCY: 5, // параллельно отправляем аудио из кеша
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, CONFIG.TRACK_TITLE_LIMIT);
}

async function safeSendMessage(userId, text, extra = {}) {
    try {
        return await bot.telegram.sendMessage(userId, text, extra);
    } catch (e) {
        if (e.response?.error_code === 403) {
            console.warn(`[SafeSend] Пользователь ${userId} заблокировал бота.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`[SafeSend] Ошибка отправки сообщения для ${userId}:`, e.message);
        }
        return null;
    }
}

function getYtdlErrorMessage(err) {
    if (err.stderr) {
        if (err.stderr.includes('Unsupported URL')) return 'Неподдерживаемая ссылка.';
        if (err.stderr.includes('Video unavailable')) return 'Трек недоступен.';
        if (err.stderr.includes('404')) return 'Трек не найден (ошибка 404).';
    }
    if (err.message.includes('timed out')) return 'Сервис отвечает слишком долго.';
    return 'Не удалось получить метаданные.';
}

// --- Воркеры ---

async function trackDownloadProcessor(task) {
    const { userId, url, trackName, uploader, playlistUrl } = task;
    const tempFilename = `${sanitizeFilename(trackName)}-${crypto.randomUUID()}.mp3`;
    const tempFilePath = path.join(cacheDir, tempFilename);

    try {
        console.log(`[Worker] Скачиваю: ${trackName}`);
        
        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
            retries: CONFIG.YTDL_RETRIES,
            "socket-timeout": CONFIG.SOCKET_TIMEOUT,
        });

        if (!fs.existsSync(tempFilePath)) throw new Error(`Файл не создан: ${tempFilePath}`);

        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size / (1024 * 1024) > CONFIG.TELEGRAM_FILE_LIMIT_MB) {
            await safeSendMessage(userId, `⚠️ Трек "${trackName}" слишком большой, пропущен.`);
            return;
        }
        
        const sent = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName, title: trackName, performer: uploader || 'SoundCloud'
        });

        if (sent?.audio?.file_id) {
            await cacheTrack(url, sent.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sent.audio.file_id);
            await incrementDownloads(userId);
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
        await safeSendMessage(userId, `❌ Ошибка при обработке трека: "${trackName}"`);
        console.error(`[Worker Error] ${trackName}:`, err.stderr || err.message || err);
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: CONFIG.MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor
});

// --- Обработка входящего URL ---

async function getTracksInfo(url) {
    const info = await ytdl(url, {
        dumpSingleJson: true,
        retries: CONFIG.YTDL_RETRIES,
        "socket-timeout": CONFIG.SOCKET_TIMEOUT
    });

    const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;

    const tracks = isPlaylist
        ? info.entries.filter(e => e?.webpage_url && e?.id).map(e => ({
            url: e.webpage_url,
            trackName: sanitizeFilename(e.title),
            uploader: e.uploader || 'SoundCloud'
          }))
        : [{
            url: info.webpage_url || url,
            trackName: sanitizeFilename(info.title),
            uploader: info.uploader || 'SoundCloud'
          }];
    
    if (tracks.length === 0) throw new Error("Треки не найдены.");
    return { tracks, isPlaylist };
}

function applyUserLimits(tracks, user, isPlaylist) {
    let limitedTracks = [...tracks];
    if (isPlaylist && user.premium_limit <= CONFIG.MAX_PLAYLIST_TRACKS_FREE && limitedTracks.length > CONFIG.MAX_PLAYLIST_TRACKS_FREE) {
        safeSendMessage(user.id, `ℹ️ Бесплатный тариф: максимум ${CONFIG.MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
        limitedTracks = limitedTracks.slice(0, CONFIG.MAX_PLAYLIST_TRACKS_FREE);
    }
    return limitedTracks;
}

async function sendCachedTracks(tracks, userId) {
    const limit = pLimit(CONFIG.MAX_CACHE_SEND_CONCURRENCY);
    const urls = tracks.map(t => t.url);
    const cachedTracksMap = await findCachedTracksByUrls(urls);
    let sentFromCacheCount = 0;

    const tasks = tracks.map(track => limit(async () => {
        const cached = cachedTracksMap.get(track.url);
        if (!cached) return track;

        try {
            await bot.telegram.sendAudio(userId, cached.fileId, { caption: track.trackName, title: track.trackName });
            await saveTrackForUser(userId, track.trackName, cached.fileId);
            await incrementDownloads(userId);
            sentFromCacheCount++;
            return null;
        } catch (err) {
            if (err.description?.includes('FILE_REFERENCE_EXPIRED')) return track;
            console.error(`[CacheSend] Ошибка для ${userId}:`, err.message);
            return null;
        }
    }));

    const results = await Promise.all(tasks);

    if (sentFromCacheCount > 0) {
        safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено из кеша.`).catch(() => {});
    }
    return results.filter(Boolean);
}

async function queueRemainingTracks(tracks, userId, isPlaylist, originalUrl) {
    if (tracks.length === 0) return;

    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;

    if (remainingLimit <= 0) {
        return safeSendMessage(userId, '🚫 Лимит скачиваний исчерпан.');
    }

    let finalTasks = tracks;
    if (tracks.length > remainingLimit) {
        await safeSendMessage(userId, `⚠️ Лимит: ${remainingLimit}. В очередь добавлено столько треков.`);
        finalTasks = tracks.slice(0, remainingLimit);
    }

    if (finalTasks.length > 0) {
        await safeSendMessage(userId, `⏳ Добавлено в очередь ${finalTasks.length} трек(ов).`);
        if (isPlaylist) {
            const redisClient = getRedisClient();
            const playlistKey = `playlist:${userId}:${originalUrl}`;
            await redisClient.setEx(playlistKey, 3600, finalTasks.length.toString());
            await logEvent(userId, 'download_playlist', { url: originalUrl });
        }
        for (const track of finalTasks) {
            downloadQueue.add({
                userId,
                ...track,
                playlistUrl: isPlaylist ? originalUrl : null,
                priority: user.premium_limit,
            });
            await logEvent(userId, 'download_start', { url: track.url, title: track.trackName });
        }
    }
}

export async function enqueue(ctx, userId, url) {
    const processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
    try {
        await resetDailyLimitIfNeeded(userId);
        const user = await getUser(userId);

        if ((user.premium_limit - user.downloads_today) <= 0) {
            return safeSendMessage(userId, texts.limitReached);
        }

        const { tracks, isPlaylist } = await getTracksInfo(url);
        const limitedTracks = applyUserLimits(tracks, user, isPlaylist);
        const tasksToDownload = await sendCachedTracks(limitedTracks, userId);
        await queueRemainingTracks(tasksToDownload, userId, isPlaylist, url);

    } catch (err) {
        console.error(`[Enqueue] Ошибка для userId ${userId}:`, err.message);
        const userFriendlyError = getYtdlErrorMessage(err);
        await safeSendMessage(userId, `❌ Ошибка: ${userFriendlyError}`);
    } finally {
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        }
    }
}