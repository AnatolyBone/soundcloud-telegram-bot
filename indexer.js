// indexer.js (Бот-паук)

import { Telegraf } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { cacheTrack, findCachedTrack, pool } from './db.js'; // Импортируем наши DB-функции

// --- Конфигурация ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID; // ID вашего приватного канала
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

if (!BOT_TOKEN || !STORAGE_CHANNEL_ID) {
    console.error('❌ Отсутствуют BOT_TOKEN или STORAGE_CHANNEL_ID');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- Основная логика ---

/**
 * Получает список URL'ов треков для индексации.
 */
async function getUrlsToIndex() {
    console.log('[Indexer] Получаю список популярных треков из логов...');
    const { rows } = await pool.query(`
        SELECT url, COUNT(url) as download_count
        FROM downloads_log
        WHERE url NOT IN (SELECT url FROM track_cache)
        GROUP BY url
        ORDER BY download_count DESC
        LIMIT 20;
    `);
    return rows.map(row => row.url);
}

/**
 * Обрабатывает один URL: скачивает, отправляет в хранилище, сохраняет file_id.
 */
async function processUrl(url) {
    let tempFilePath = null;
    try {
        const isCached = await findCachedTrack(url);
        if (isCached) {
            console.log(`[Indexer] Пропуск: ${url} уже в кэше.`);
            return;
        }

        console.log(`[Indexer] Индексирую: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true });
        if (!info || Array.isArray(info.entries)) return; // Пропускаем плейлисты

        // <<< ИЗМЕНЕНИЕ 1: Получаем и имя, и исполнителя >>>
        const trackName = (info.title || 'track').slice(0, 100);
        const uploader = info.uploader || 'SoundCloud'; // Получаем имя исполнителя
        
        tempFilePath = path.join(cacheDir, `${info.id || Date.now()}.mp3`);
        
        // <<< ИЗМЕНЕНИЕ 2: Встраиваем метаданные в MP3-файл (хорошая практика) >>>
        await ytdl(url, { 
            output: tempFilePath, 
            extractAudio: true, 
            audioFormat: 'mp3',
            embedMetadata: true, // Включаем встраивание метаданных
            postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`
        });

        if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');

        // <<< ИЗМЕНЕНИЕ 3: Отправляем аудио с правильными метаданными >>>
        const message = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID, 
            { source: fs.createReadStream(tempFilePath) }, // Используем stream для эффективности
            { // Добавляем метаданные для Telegram
                title: trackName,
                performer: uploader
                // Мы НЕ добавляем 'caption', чтобы избежать дублирования
            }
        );

        if (message?.audio?.file_id) {
            await cacheTrack(url, message.audio.file_id, trackName);
            console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
        }
    } catch (err) {
        console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.stderr || err.message);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

/**
 * Главный цикл работы индексатора.
 */
async function main() {
    console.log('🚀 Запуск Бота-Индексатора...');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

    while (true) {
        const urls = await getUrlsToIndex();
        if (urls.length > 0) {
            console.log(`[Indexer] Найдено ${urls.length} новых треков для индексации.`);
            for (const url of urls) {
                await processUrl(url);
                // Небольшая пауза, чтобы не перегружать API
                await new Promise(resolve => setTimeout(resolve, 5000)); // 5 секунд
            }
        } else {
            console.log('[Indexer] Новых популярных треков для индексации нет.');
        }

        console.log('[Indexer] Пауза на 1 час перед следующим проходом.');
        await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000)); // Пауза 1 час
    }
}

main().catch(err => {
    console.error("🔴 Критическая ошибка в главном цикле индексатора:", err);
    process.exit(1);
});