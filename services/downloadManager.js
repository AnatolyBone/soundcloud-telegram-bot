// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
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
    // <<< ИЗМЕНЕНИЕ: findCachedTrack больше не нужен здесь, используем массовый
    findCachedTracksByUrls, 
    cacheTrack
} from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

// <<< ИЗМЕНЕНИЕ: выносим константы наверх для удобства
const TELEGRAM_FILE_LIMIT_MB = 49;
const MAX_PLAYLIST_TRACKS_FREE = 10;
const TRACK_TITLE_LIMIT = 100;
const MAX_CONCURRENT_DOWNLOADS = 8; // Конфигурация очереди

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, TRACK_TITLE_LIMIT);
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

// --- Воркер (`trackDownloadProcessor`) ---
// <<< ИЗМЕНЕНИЕ: Значительно упрощен. Нет лишних API-вызовов.
async function trackDownloadProcessor(task) {
    const { userId, url, trackName, uploader, playlistUrl } = task;
    const tempFilename = `${sanitizeFilename(trackName)}-${crypto.randomUUID()}.mp3`;
    const tempFilePath = path.join(cacheDir, tempFilename);

    try {
        console.log(`[Worker] Начинаю скачивание: ${trackName}`);
        
        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
            retries: 3,
            "socket-timeout": 120
        });

        if (!fs.existsSync(tempFilePath)) {
            throw new Error(`Файл не был создан после скачивания: ${tempFilePath}`);
        }

        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size / (1024 * 1024) > TELEGRAM_FILE_LIMIT_MB) {
            throw new Error(`Трек слишком большой, пропущен: ${trackName}`);
        }
        
        const sentMessage = await bot.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            caption: trackName,
            title: trackName,
            performer: uploader || 'SoundCloud'
        });
        
        // Манипуляции с базой данных ТОЛЬКО ПОСЛЕ УСПЕШНОЙ отправки
        if (sentMessage?.audio?.file_id) {
            console.log(`[Worker] Трек "${trackName}" отправлен, кэширую...`);
            await cacheTrack(url, sentMessage.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
            await incrementDownloads(userId);
        }
        
        // Логика завершения плейлиста остается, она эффективна
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
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`❌ Ошибка воркера при обработке "${trackName}":`, err.stderr || err.message || err);
            await safeSendMessage(userId, `❌ Не удалось обработать трек: "${trackName}"`);
        }
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(e => console.error(`Не удалось удалить временный файл ${tempFilePath}:`, e));
        }
    }
}

// --- Очередь задач ---
export const downloadQueue = new TaskQueue({
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    taskProcessor: trackDownloadProcessor
});

// --- Вспомогательные функции для `enqueue` ---

async function getTracksInfo(url) {
    const info = await ytdl(url, { dumpSingleJson: true, retries: 2, "socket-timeout": 120 });
    if (!info) throw new Error('Не удалось получить метаданные по ссылке.');

    const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
    let tracksToProcess = [];

    if (isPlaylist) {
        tracksToProcess = info.entries
            .filter(e => e?.webpage_url && e?.id)
            .map(e => ({
                url: e.webpage_url,
                trackName: sanitizeFilename(e.title),
                uploader: e.uploader || 'SoundCloud'
            }));
    } else {
        tracksToProcess = [{
            url: info.webpage_url || url,
            trackName: sanitizeFilename(info.title),
            uploader: info.uploader || 'SoundCloud'
        }];
    }
    
    return { tracks: tracksToProcess, isPlaylist };
}

async function processTracksFromCache(userId, tracks) {
    const urls = tracks.map(t => t.url);
    const cachedTracksMap = await findCachedTracksByUrls(urls);

    const tasksToDownload = [];
    let sentFromCacheCount = 0;

    for (const track of tracks) {
        const cached = cachedTracksMap.get(track.url);
        if (cached) {
            try {
                // Отправляем из кэша
                await bot.telegram.sendAudio(userId, cached.fileId, { caption: track.trackName, title: track.trackName });
                await saveTrackForUser(userId, track.trackName, cached.fileId);
                await incrementDownloads(userId);
                sentFromCacheCount++;
            } catch (err) {
                if (err.response?.error_code === 403) {
                    await updateUserField(userId, 'active', false);
                    return { tasksToDownload: [], sentFromCacheCount, wasBlocked: true };
                }
                if (err.description?.includes('FILE_REFERENCE_EXPIRED')) {
                    // Если ссылка на файл истекла, добавляем на повторную загрузку
                    tasksToDownload.push(track);
                } else {
                    console.error(`⚠️ Ошибка отправки из кэша для ${userId}: ${err.message}`);
                }
            }
        } else {
            // Если в кэше нет - добавляем на загрузку
            tasksToDownload.push(track);
        }
    }

    if (sentFromCacheCount > 0) {
        await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша.`);
    }

    return { tasksToDownload, sentFromCacheCount, wasBlocked: false };
}


// --- Основной входной метод ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);

        const processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
        
        const { tracks, isPlaylist } = await getTracksInfo(url);
        
        if (processingMessage) {
            await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        }

        if (tracks.length === 0) {
            return await safeSendMessage(userId, 'Не удалось найти треки для загрузки.');
        }

        // <<< ИЗМЕНЕНИЕ: Единая, более чистая проверка лимитов
        let user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            return await safeSendMessage(userId, texts.limitReached);
        }
        
        let tracksToProcess = tracks;
        
        if (isPlaylist && user.premium_limit <= 10 && tracksToProcess.length > MAX_PLAYLIST_TRACKS_FREE) {
            await safeSendMessage(userId, `ℹ️ Бесплатный тариф: можно скачать до ${MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
            tracksToProcess = tracksToProcess.slice(0, MAX_PLAYLIST_TRACKS_FREE);
        }
        
        // <<< ИЗМЕНЕНИЕ: Отделяем логику обработки кэша
        const { tasksToDownload, wasBlocked } = await processTracksFromCache(userId, tracksToProcess);
        
        if (wasBlocked) return; // Пользователь заблокировал бота, выходим
        if (tasksToDownload.length === 0) return; // Все треки были в кэше

        // <<< ИЗМЕНЕНИЕ: Перепроверяем лимит ПОСЛЕ отправки из кэша
        user = await getUser(userId); // Важно! Получаем актуальные данные после инкремента счетчиков
        remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            return await safeSendMessage(userId, '🚫 Ваш лимит был исчерпан треками, отправленными из кэша.');
        }

        const finalTasks = tasksToDownload.slice(0, remainingLimit);

        if (finalTasks.length < tasksToDownload.length) {
            await safeSendMessage(userId, `⚠️ Ваш лимит: ${remainingLimit}. Добавляю в очередь только доступное количество треков.`);
        }
        
        if (finalTasks.length > 0) {
            await safeSendMessage(userId, `⏳ Добавлено в очередь ${finalTasks.length} трек(ов). Вы получите их по мере готовности.`);
            
            if (isPlaylist) {
                const redisClient = getRedisClient();
                const playlistKey = `playlist:${userId}:${url}`;
                // Устанавливаем счетчик в Redis для отслеживания завершения плейлиста
                await redisClient.setEx(playlistKey, 3600, finalTasks.length.toString());
                await logEvent(userId, 'download_playlist');
            }
            
            for (const track of finalTasks) {
                downloadQueue.add({
                    userId,
                    ...track,
                    playlistUrl: isPlaylist ? url : null,
                    priority: user.premium_limit // Премиум пользователи имеют более высокий приоритет
                });
                await logEvent(userId, 'download');
            }
        }

    } catch (err) {
        if (err.message.includes('timed out')) {
            console.error(`❌ TimeoutError в enqueue для userId ${userId}:`, err.message);
            await safeSendMessage(userId, '❌ Ошибка: SoundCloud (или другой сервис) отвечает слишком долго. Попробуйте позже.');
        } else {
            console.error(`❌ Глобальная ошибка в enqueue для userId ${userId}:`, err.stderr || err.message || err);
            await safeSendMessage(userId, texts.error + ' Не удалось обработать ссылку.');
        }
    }
}