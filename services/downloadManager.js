// services/downloadManager.js

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { getUser, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser, logEvent, logUserActivity } from '../db.js';

// --- Константы и утилиты ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
const TELEGRAM_FILE_LIMIT_MB = 49;

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim();
}

// --- Обработчик для ОДНОГО трека (медленный путь) ---
async function trackDownloadProcessor(task) {
    const { ctx, userId, url, playlistUrl, trackName, trackId, uploader } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] 🚀 Скачивание: ${trackName}`);

    try {
        const fileIdKey = `fileId:${url}`;
        tempFilePath = path.join(cacheDir, `${trackName}_${trackId}_${Date.now()}.mp3`);

        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            embedMetadata: true,
            // Добавляем аргументы для ffmpeg, чтобы записать правильного артиста
            postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}"`
        });
        
        const stats = await fs.promises.stat(tempFilePath);
        const fileSizeInMB = stats.size / (1024 * 1024);

        if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
            console.warn(`⚠️ Файл "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} MB).`);
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" не может быть отправлен, так как его размер (${fileSizeInMB.toFixed(2)} МБ) превышает лимит Telegram в 50 МБ.`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, {
            title: trackName,
            performer: uploader || 'SoundCloud'
        });
        
        if (message?.audio?.file_id) {
            const fileId = message.audio.file_id;
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, fileId); // Кэшируем на 30 дней
            await saveTrackForUser(userId, trackName, fileId);
        }

        // Логика трекера плейлистов
        if (playlistUrl) {
            const playlistKey = `playlist:${userId}:${playlistUrl}`;
            const remaining = await redisClient.decr(playlistKey);
            if (remaining <= 0) {
                await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
                await redisClient.del(playlistKey);
            }
        }
    } catch (err) {
        if (err.response?.error_code === 403) {
            console.warn(`[UserDisconnectedError] Пользователь ${userId} заблокировал бота во время отправки.`);
        } else {
            console.error(`❌ Ошибка обработки "${trackName}":`, err);
            try {
                await ctx.telegram.sendMessage(userId, `❌ Ошибка при загрузке трека: ${trackName}`);
            } catch (sendErr) { /* ignore if can't send */ }
        }
        throw err;
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

// --- Основная функция, обрабатывающая запрос пользователя ---
export async function enqueue(ctx, userId, url) {
    try {
        // Получаем актуального пользователя и его лимиты
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        const user = await getUser(userId);
        let remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            await ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([Markup.button.callback('✅ Я подписался', 'check_subscription')]));
            return;
        }

        await ctx.reply('🔍 Анализирую ссылку, ищу треки в кэше...');
        
        const info = await ytdl(url, { dumpSingleJson: true });
        
        const isPlaylist = Array.isArray(info.entries);
        let trackInfos = [];

        if (isPlaylist) {
            trackInfos = info.entries
                .filter(e => e?.webpage_url)
                .map(e => ({
                    url: e.webpage_url,
                    trackId: e.id || e.title.replace(/\s/g, ''),
                    trackName: sanitizeFilename(e.title).slice(0, 64),
                    uploader: e.uploader || 'SoundCloud'
                }));
            if (trackInfos.length > remainingLimit) {
                await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но вам доступно только ${remainingLimit}. Обрабатываю первые ${remainingLimit}.`);
                trackInfos = trackInfos.slice(0, remainingLimit);
            }
        } else {
            trackInfos = [{
                url: info.webpage_url || url,
                trackId: info.id || info.title.replace(/\s/g, ''),
                trackName: sanitizeFilename(info.title).slice(0, 64),
                uploader: info.uploader || 'SoundCloud'
            }];
        }

        const redisClient = getRedisClient();
        let tasksForQueue = []; 
        let sentFromCacheCount = 0;

        // "Быстрый путь" - отправка из кэша
        for (const track of trackInfos) {
            const fileIdKey = `fileId:${track.url}`;
            const cachedFileId = await redisClient.get(fileIdKey);

            if (cachedFileId) {
                // Атомарно проверяем лимит и инкрементируем счетчик
                const updatedUser = await incrementDownloads(userId, track.trackName);
                if (!updatedUser) {
                    console.log(`Лимит для ${userId} исчерпан при отправке из кэша.`);
                    continue; // Пропускаем трек, если лимит исчерпан
                }
                
                try {
                    await ctx.telegram.sendAudio(userId, cachedFileId, { title: track.trackName, performer: track.uploader });
                    await saveTrackForUser(userId, track.trackName, cachedFileId);
                    sentFromCacheCount++;
                } catch (e) {
                    if (e.response?.error_code === 400 && e.description.includes('FILE_REFERENCE_EXPIRED')) {
                         console.warn(`⚠️ Невалидный file_id для ${track.url}. Отправляю на перезалив.`);
                         await redisClient.del(fileIdKey);
                         tasksForQueue.push(track);
                    } else {
                        throw e;
                    }
                }
            } else {
                tasksForQueue.push(track);
            }
        }

        if (sentFromCacheCount > 0) {
             await ctx.reply(`✅ ${sentFromCacheCount} трек(ов) отправлено мгновенно из кэша!`);
        }
        
        // "Медленный путь" - постановка в очередь на скачивание
        if (tasksForQueue.length > 0) {
            if (isPlaylist) {
                const playlistKey = `playlist:${userId}:${url}`;
                await redisClient.setEx(playlistKey, 3600, tasksForQueue.length); // TTL 1 час
                await logEvent(userId, 'download_playlist');
            }

            let addedToQueueCount = 0;
            for (const track of tasksForQueue) {
                // Атомарно инкрементируем перед постановкой в очередь
                const updatedUser = await incrementDownloads(userId, track.trackName);
                if (!updatedUser) {
                    console.log(`Лимит для ${userId} исчерпан. Добавление в очередь остановлено.`);
                    break;
                }
                
                downloadQueue.add({
                    ctx, userId, ...track,
                    playlistUrl: isPlaylist ? url : null,
                    priority: user.premium_limit,
                });
                await logEvent(userId, 'download');
                addedToQueueCount++;
            }

            if (addedToQueueCount > 0) {
                 await ctx.telegram.sendMessage(userId, `⏳ ${addedToQueueCount} трек(ов) добавлено в очередь на скачивание.`);
            } else if (sentFromCacheCount > 0 && tasksForQueue.length > 0) {
                // Если что-то отправили из кэша, но в очередь ничего не добавили из-за лимита
                await ctx.reply('🚫 Ваш дневной лимит исчерпан. Остальные треки не были добавлены в очередь.');
            }
        }

    } catch (e) {
        console.error(`❌ Ошибка в enqueue для userId ${userId}:`, e);
        await ctx.reply(texts.error + '\nВозможно, ссылка недействительна или защищена от скачивания.');
    }
}