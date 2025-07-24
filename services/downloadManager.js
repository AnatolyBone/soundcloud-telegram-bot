// services/downloadManager.js (ОПТИМИЗИРОВАННАЯ ВЕРСИЯ)

import path from 'path';
import fs from 'fs';
import util from 'util';
import NodeID3 from 'node-id3';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import { Markup } from 'telegraf';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient, texts } from '../index.js';
import { getUser, logUserActivity, resetDailyLimitIfNeeded, incrementDownloads, saveTrackForUser, logEvent } from '../db.js';

// --- Константы и утилиты ---
const writeID3 = util.promisify(NodeID3.write);
const playlistTracker = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');
const TELEGRAM_FILE_LIMIT_MB = 49;

function sanitizeFilename(name) {
    if (!name) return 'track';
    return name.replace(/[<>:"/\\|?*]+/g, '').trim();
}

// --- Оптимизированный обработчик для ОДНОГО трека ---
async function trackDownloadProcessor(task) {
    // Получаем все данные из задачи, включая pre-fetched метаданные
    const { ctx, userId, url, playlistUrl, trackName, trackId } = task;
    const redisClient = getRedisClient();
    let tempFilePath = null;

    console.log(`[Queue: ${downloadQueue.active}/${downloadQueue.maxConcurrent}] 🚀 Старт: ${trackName}`);

    try {
        const fileIdKey = `fileId:${url}`;
        const cachedFileId = await redisClient.get(fileIdKey);

        if (cachedFileId) {
            console.log(`🎯 Кэш file_id найден для "${trackName}". Отправка.`);
            await ctx.telegram.sendAudio(userId, cachedFileId);
            await incrementDownloads(userId, 'cached_track');
            return;
        }

        // БОЛЬШЕ НЕ НУЖНО ВЫЗЫВАТЬ ytdl для информации, она уже есть
        // const info = await ytdl(url, { dumpSingleJson: true });

        tempFilePath = path.join(cacheDir, `${trackName}_${trackId}_${Date.now()}.mp3`);

        await ytdl(url, {
            extractAudio: true,
            audioFormat: 'mp3',
            output: tempFilePath,
            preferFreeFormats: true,
            noCheckCertificates: true,
        });
        
        await writeID3({ title: trackName, artist: 'SoundCloud' }, tempFilePath);
        
        const stats = await fs.promises.stat(tempFilePath);
        const fileSizeInMB = stats.size / (1024 * 1024);

        if (fileSizeInMB > TELEGRAM_FILE_LIMIT_MB) {
            console.warn(`⚠️ Файл "${trackName}" слишком большой (${fileSizeInMB.toFixed(2)} MB).`);
            await ctx.telegram.sendMessage(userId, `❌ Трек "${trackName}" не может быть отправлен, так как его размер (${fileSizeInMB.toFixed(2)} МБ) превышает лимит Telegram в 50 МБ.`);
            return;
        }

        const message = await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(tempFilePath) }, { title: trackName, performer: 'SoundCloud' });
        
        if (message?.audio?.file_id) {
            const fileId = message.audio.file_id;
            await redisClient.setEx(fileIdKey, 30 * 24 * 60 * 60, fileId);
            await incrementDownloads(userId, trackName);
            await saveTrackForUser(userId, trackName, fileId);
        }

        if (playlistUrl) {
            const playlistKey = `${userId}:${playlistUrl}`;
            if (playlistTracker.has(playlistKey)) {
                let remaining = playlistTracker.get(playlistKey) - 1;
                if (remaining <= 0) {
                    await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
                    playlistTracker.delete(playlistKey);
                } else {
                    playlistTracker.set(playlistKey, remaining);
                }
            }
        }
    } catch (err) {
        console.error(`❌ Ошибка обработки "${trackName}" для userId ${userId}:`, err);
        try {
            await ctx.telegram.sendMessage(userId, `❌ Ошибка при загрузке трека: ${trackName}`);
        } catch (sendErr) {
            console.error(`⚠️ Не удалось уведомить пользователя ${userId}:`, sendErr);
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

// --- Оптимизированная функция добавления задач в очередь ---
export async function enqueue(ctx, userId, url) {
    try {
        await logUserActivity(userId);
        await resetDailyLimitIfNeeded(userId);
        const user = await getUser(userId);
        const remainingLimit = user.premium_limit - user.downloads_today;

        if (remainingLimit <= 0) {
            await ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([Markup.button.callback('✅ Я подписался', 'check_subscription')]));
            return;
        }

        await ctx.reply('🔍 Анализирую ссылку и получаю информацию о треках...');
        
        // ВЫЗЫВАЕМ YTDL ТОЛЬКО ОДИН РАЗ ЗДЕСЬ
        const info = await ytdl(url, { dumpSingleJson: true });
        
        const isPlaylist = Array.isArray(info.entries);
        let trackInfos = [];

        if (isPlaylist) {
            // Сразу собираем всю нужную информацию
            trackInfos = info.entries
                .filter(e => e?.webpage_url)
                .map(e => ({
                    url: e.webpage_url,
                    trackName: sanitizeFilename(e.title).slice(0, 64),
                    trackId: e.id
                }));
            
            const playlistKey = `${userId}:${url}`;
            playlistTracker.set(playlistKey, trackInfos.length);
            
            if (trackInfos.length > remainingLimit) {
                await ctx.telegram.sendMessage(userId, `⚠️ В плейлисте ${trackInfos.length} треков, но вам доступно только ${remainingLimit}. Загружаю первые ${remainingLimit}.`);
                trackInfos = trackInfos.slice(0, remainingLimit);
            }
            await logEvent(userId, 'download_playlist');
        } else {
            // Собираем информацию для одного трека
            trackInfos = [{
                url: info.webpage_url || url,
                trackName: sanitizeFilename(info.title).slice(0, 64),
                trackId: info.id
            }];
        }
        
        for (const track of trackInfos) {
            // Создаем задачу, уже обогащенную данными
            downloadQueue.add({
                ctx,
                userId,
                url: track.url,
                playlistUrl: isPlaylist ? url : null,
                priority: user.premium_limit,
                // Передаем pre-fetched метаданные
                trackName: track.trackName,
                trackId: track.trackId
            });
            await logEvent(userId, 'download');
        }

        await ctx.telegram.sendMessage(userId, `✅ Добавлено в очередь ${trackInfos.length} трек(ов). Ваша позиция: ~${downloadQueue.size}.`);

    } catch (e) {
        console.error(`❌ Ошибка в enqueue для userId ${userId}:`, e);
        await ctx.reply(texts.error + '\nВозможно, ссылка недействительна или защищена от скачивания.');
    }
}