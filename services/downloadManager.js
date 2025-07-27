// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { performance } from 'perf_hooks';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts, bot } from '../index.js';
import {
    getUser, resetDailyLimitIfNeeded, saveTrackForUser, logEvent,
    incrementDownloads, updateUserField, findCachedTracksByUrls, cacheTrack
} from '../db.js';

const CONFIG = {
    TELEGRAM_FILE_LIMIT_MB: 49,
    MAX_PLAYLIST_TRACKS_FREE: 10,
    TRACK_TITLE_LIMIT: 100,
    MAX_CONCURRENT_DOWNLOADS: 2,
    YTDL_RETRIES: 3,
    SOCKET_TIMEOUT: 120,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

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
    const stderr = err.stderr || '';
    if (stderr.includes('Unsupported URL')) return 'Неподдерживаемая ссылка.';
    if (stderr.includes('Video unavailable')) return 'Трек недоступен.';
    if (stderr.includes('404')) return 'Трек не найден (ошибка 404).';
    if (err.message.includes('timed out')) return 'Сервис отвечает слишком долго.';
    return 'Не удалось обработать ссылку.';
}

async function trackDownloadProcessor(task) {
    const { userId, url, trackName, uploader, playlistUrl } = task;
    const startTime = performance.now();
    console.log(`[Worker] Начинаю стриминг: "${trackName}"`);

    try {
        const ytdlProcess = ytdl.exec(url, {
            quiet: true, // <<< ИСПРАВЛЕНО: Отключаем лог-спам от yt-dlp
            output: '-',
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
            retries: CONFIG.YTDL_RETRIES,
            "socket-timeout": CONFIG.SOCKET_TIMEOUT,
        });

        let stderrOutput = '';
        ytdlProcess.stderr.on('data', (data) => stderrOutput += data.toString());

        const [sentMessage] = await Promise.all([
            bot.telegram.sendAudio(userId,
                { source: ytdlProcess.stdout },
                { caption: trackName, title: trackName, performer: uploader || 'SoundCloud' }
            ),
            new Promise((resolve, reject) => {
                ytdlProcess.on('close', (code) => {
                    if (code === 0) {
                        const duration = (performance.now() - startTime).toFixed(0);
                        console.log(`[Worker] Стриминг "${trackName}" успешно завершен за ${duration} мс.`);
                        resolve();
                    } else {
                        reject(new Error(`yt-dlp exited with code ${code}. Stderr: ${stderrOutput}`));
                    }
                });
                ytdlProcess.on('error', reject);
            }),
        ]);

        if (sentMessage?.audio?.file_id) {
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
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
        const duration = (performance.now() - startTime).toFixed(0);
        console.error(`❌ Ошибка воркера после ${duration} мс для "${trackName}":`, err.message || err);
        await safeSendMessage(userId, `❌ Не удалось обработать трек: "${trackName}"`);
    }
}

export const downloadQueue = new TaskQueue({
    maxConcurrent: CONFIG.MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor
});

async function getTracksInfo(url) {
    const info = await ytdl(url, {
        dumpSingleJson: true,
        retries: CONFIG.YTDL_RETRIES,
        "socket-timeout": CONFIG.SOCKET_TIMEOUT,
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
    if (tracks.length === 0) throw new Error("Не удалось найти треки для загрузки.");
    return { tracks, isPlaylist };
}

function applyUserLimits(tracks, user, isPlaylist) {
    let limitedTracks = [...tracks];
    if (isPlaylist && user.premium_limit <= 10 && limitedTracks.length > CONFIG.MAX_PLAYLIST_TRACKS_FREE) {
        safeSendMessage(user.id, `ℹ️ Бесплатный тариф: можно скачать до ${CONFIG.MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
        limitedTracks = limitedTracks.slice(0, CONFIG.MAX_PLAYLIST_TRACKS_FREE);
    }
    return limitedTracks;
}

async function sendCachedTracks(tracks, userId) {
    const urls = tracks.map(t => t.url);
    const cachedTracksMap = await findCachedTracksByUrls(urls);
    const tasksToDownload = [];
    let sentFromCacheCount = 0;
    for (const track of tracks) {
        const cached = cachedTracksMap.get(track.url);
        if (cached) {
            try {
                await bot.telegram.sendAudio(userId, cached.fileId, { caption: track.trackName, title: track.trackName });
                await saveTrackForUser(userId, track.trackName, cached.fileId);
                await incrementDownloads(userId);
                sentFromCacheCount++;
            } catch (err) {
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    tasksToDownload.push(track);
                } else {
                    console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            }
        } else {
            tasksToDownload.push(track);
        }
    }
    if (sentFromCacheCount > 0) {
        await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
    }
    return tasksToDownload;
}

async function queueRemainingTracks(tracks, userId, isPlaylist, originalUrl) {
    if (tracks.length === 0) return;
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;
    if (remainingLimit <= 0) {
        return safeSendMessage(userId, '🚫 Ваш лимит был исчерпан треками, отправленными из кэша.');
    }
    let finalTasks = tracks;
    if (tracks.length > remainingLimit) {
        await safeSendMessage(userId, `⚠️ Ваш лимит: ${remainingLimit}. Добавляю в очередь только доступное количество треков.`);
        finalTasks = tracks.slice(0, remainingLimit);
    }
    if (finalTasks.length > 0) {
        await safeSendMessage(userId, `⏳ Добавлено в очередь ${finalTasks.length} трек(ов). Вы получите их по мере готовности.`);
        if (isPlaylist) {
            const redisClient = getRedisClient();
            const playlistKey = `playlist:${userId}:${originalUrl}`;
            await redisClient.setEx(playlistKey, 3600, finalTasks.length.toString());
            await logEvent(userId, 'download_playlist', { url: originalUrl });
        }
        for (const track of finalTasks) {
            downloadQueue.add({
                userId, ...track,
                playlistUrl: isPlaylist ? originalUrl : null,
                priority: user.premium_limit
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
            await safeSendMessage(userId, texts.limitReached);
            return;
        }
        const { tracks, isPlaylist } = await getTracksInfo(url);
        const limitedTracks = applyUserLimits(tracks, user, isPlaylist);
        const tasksToDownload = await sendCachedTracks(limitedTracks, userId);
        await queueRemainingTracks(tasksToDownload, userId, isPlaylist, url);
    } catch (err) {
        console.error(`❌ Глобальная ошибка в enqueue для userId ${userId}:`, err.stderr || err.message || err);
        const userFriendlyError = getYtdlErrorMessage(err);
        await safeSendMessage(userId, `❌ Ошибка: ${userFriendlyError}`);
    } finally {
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        }
    }
}