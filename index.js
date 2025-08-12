// index.js

// Core
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Server
import express from 'express';
import session from 'express-session';
import pgSessionFactory from 'connect-pg-simple';
import expressLayouts from 'express-ejs-layouts';
import multer from 'multer';

// Telegram
import { Telegraf, Markup } from 'telegraf';

// Storage & Utils
import { createClient } from 'redis';
import ytdl from 'youtube-dl-exec';

// Database & Config
import { pool, supabase, getUser, updateUserField, setPremium, getAllUsers, resetDailyStats, saveTrackForUser, getUserById, findCachedTrack, cacheTrack, getExpiringUsersPaginated, getExpiringUsersCount, getReferralSourcesStats, getFunnelData, getDashboardStats, logEvent, resetDailyLimitIfNeeded } from './db.js';
import { T, loadTexts } from './config/texts.js';
import { ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT, SESSION_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD, STORAGE_CHANNEL_ID, NODE_ENV } from './config.js';
import { initNotifier, startNotifier } from './services/notifier.js';
import { TaskQueue } from './src/lib/TaskQueue.js';

// ===== Инициализация =====
const bot = new Telegraf(process.env.BOT_TOKEN);
initNotifier(bot);

const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
let redisClient = null;

export const getRedisClient = () => redisClient;

// ================================================================
// ===                   Вспомогательные утилиты                 ===
// ================================================================

function sanitizeFilename(name) {
    return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, 100);
}

const extractUrl = (text = '') => {
    const regex = /(https?:\/\/[^\s]+)/g;
    const matches = text.match(regex);
    return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

async function cleanupCache(directory, maxAgeMinutes = 60) {
    try {
        const now = Date.now();
        const files = await fs.promises.readdir(directory);
        let cleaned = 0;
        for (const file of files) {
            try {
                const filePath = path.join(directory, file);
                const stat = await fs.promises.stat(filePath);
                if ((now - stat.mtimeMs) / 60000 > maxAgeMinutes) {
                    await fs.promises.unlink(filePath);
                    cleaned++;
                }
            } catch {}
        }
        if (cleaned > 0) console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов.`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('[Cache Cleanup] Ошибка:', e);
    }
}

// ================================================================
// ===                   Логика загрузки (Worker)               ===
// ================================================================

async function trackDownloadProcessor(task) {
    const { ctx, userId, url, trackName, uploader } = task;
    const tempFilePath = path.join(cacheDir, `${sanitizeFilename(trackName)}-${Date.now()}.mp3`);

    try {
        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            postprocessorArgs: [`-metadata`, `artist=${uploader}`, `-metadata`, `title=${trackName}`]
        });

        if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');

        const message = await bot.telegram.sendAudio(
            userId,
            { source: fs.createReadStream(tempFilePath) },
            { title: trackName, performer: uploader }
        );
        
        if (message?.audio?.file_id) {
            await cacheTrack(url, message.audio.file_id, trackName);
            await saveTrackForUser(userId, trackName, message.audio.file_id);
            await incrementDownloads(userId, trackName, url);
        }
    } catch (err) {
        console.error(`❌ Ошибка воркера для ${trackName}:`, err.stderr || err.message);
        await ctx.reply(`❌ Не удалось обработать трек: "${trackName}"`);
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}

const downloadQueue = new TaskQueue({
    maxConcurrent: 1,
    taskProcessor: trackDownloadProcessor
});

async function enqueue(ctx, userId, url) {
    try {
        await resetDailyLimitIfNeeded(userId);
        const user = await getUser(userId);
        if (user.downloads_today >= user.premium_limit) {
            return ctx.reply(T('limitReached'));
        }

        const info = await ytdl(url, { dumpSingleJson: true, 'no-playlist': true });
        if (!info) return ctx.reply('Не удалось получить информацию о треке.');
        
        const trackName = sanitizeFilename(info.title);
        const uploader = info.uploader || 'SoundCloud';

        const cached = await findCachedTrack(url);
        if (cached?.fileId) {
            await bot.telegram.sendAudio(userId, cached.fileId, { title: trackName, performer: uploader });
            await saveTrackForUser(userId, trackName, cached.fileId);
            await incrementDownloads(userId, trackName, url);
            return;
        }

        downloadQueue.add({ ctx, userId, url, trackName, uploader });
        await ctx.reply(`⏳ Трек "${trackName}" добавлен в очередь.`);

    } catch (err) {
        console.error(`❌ Ошибка в enqueue для ${userId}:`, err.message);
        await ctx.reply(T('error'));
    }
}

// ================================================================
// ===                   Логика "Паука" (Indexer)               ===
// ================================================================

async function getUrlsToIndexForIndexer() {
    const { rows } = await pool.query(`
        SELECT url FROM downloads_log
        WHERE url IS NOT NULL AND url LIKE '%soundcloud.com%' AND url NOT IN (SELECT url FROM track_cache)
        GROUP BY url ORDER BY COUNT(url) DESC LIMIT 10
    `);
    return rows.map(row => row.url);
}

async function processUrlForIndexer(url) {
    let tempFilePath = null;
    try {
        const info = await ytdl(url, { dumpSingleJson: true, 'no-playlist': true });
        if (!info) return;

        const trackName = sanitizeFilename(info.title);
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `indexer_${info.id || Date.now()}.mp3`);

        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            postprocessorArgs: [`-metadata`, `artist=${uploader}`, `-metadata`, `title=${trackName}`]
        });

        if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');
        
        const message = await bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: fs.createReadStream(tempFilePath) },
            { title: trackName, performer: uploader }
        );

        if (message?.audio?.file_id) {
            await cacheTrack(url, message.audio.file_id, trackName);
            console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
        }
    } catch (err) {
        console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.stderr || err.message);
    } finally {
        if (tempFilePath) await fs.promises.unlink(tempFilePath).catch(() => {});
    }
}

async function startIndexer() {
    console.log('🚀 Запуск фонового индексатора...');
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    while (true) {
        try {
            if (downloadQueue.active > 0) {
                console.log('[Indexer] Есть активные задания, пауза 2 мин.');
                await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
                continue;
            }

            const urls = await getUrlsToIndexForIndexer();
            if (urls.length > 0) {
                console.log(`[Indexer] Найдено ${urls.length} треков для кэширования.`);
                for (const url of urls) {
                    await processUrlForIndexer(url);
                    await new Promise(resolve => setTimeout(resolve, 15 * 1000));
                }
            } else {
                 console.log('[Indexer] Новых треков нет, пауза 10 мин.');
                 await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
            }
        } catch (err) {
            console.error("🔴 Критическая ошибка в индексаторе, пауза 5 минут:", err);
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        }
    }
}

// ================================================================
// ===                  Настройка и запуск                      ===
// ================================================================

async function startApp() {
  try {
    // 1. Загружаем тексты
    await loadTexts();

    // 2. Подключаемся к Redis
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
    await client.connect();
    redisClient = client;
    console.log('✅ Redis подключён');

    // 3. Создаем кэш-директорию
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    
    // 4. Настраиваем админку
    setupAdmin({ app, bot, __dirname, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET, redis: redisClient });

    // 5. Настраиваем бота
    setupTelegramBot();

    // 6. Запускаем плановые и фоновые задачи
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));
    startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));

    // 7. Запускаем сервер
    if (NODE_ENV === 'production') {
      const webhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
      app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}. Вебхук установлен.`));
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch();
      console.log('✅ Бот запущен в режиме long-polling.');
    }
  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске приложения:', err);
    process.exit(1);
  }
}

function setupTelegramBot() {
    const handleSendMessageError = async (error, userId) => {
        if (error.response?.error_code === 403) {
            console.log(`Пользователь ${userId} заблокировал бота. Отключаем его.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`Ошибка при отправке для ${userId}:`, error.response?.description || error.message);
        }
    };

    const isSubscribed = async (userId, channelUsername) => {
        try {
            const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
            return ['creator', 'administrator', 'member'].includes(chatMember.status);
        } catch (e) {
            console.error(`Ошибка проверки подписки для ${userId} на ${channelUsername}:`, e.message);
            return false;
        }
    };
    
    function formatMenuMessage(user, ctx) {
        const tariffLabel = getTariffName(user.premium_limit);
        const downloadsToday = user.downloads_today || 0;
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
        const daysLeft = getDaysLeft(user.premium_until);
        
        let message = `
👋 Привет, ${user.first_name || user.username || 'друг'}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3 — просто пришли ссылку.

📣 Новости, фишки и бонусы: @SCM_BLOG

💼 Тариф: ${tariffLabel}
⏳ Осталось дней: ${daysLeft > 999 ? '∞' : daysLeft}
🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

🔗 Твоя реферальная ссылка:
${refLink}
        `.trim();
        
        if (!user.subscribed_bonus_used) {
            message += `\n\n🎁 Бонус! Подпишись на @SCM_BLOG и получи 7 дней тарифа Plus бесплатно.`;
        }
        
        return message;
    }

    const getBonusKeyboard = (user) => {
        const keyboard = [];
        if (!user.subscribed_bonus_used) {
            keyboard.push([{ text: '✅ Я подписался, получить бонус!', callback_data: 'check_subscription' }]);
        }
        return Markup.inlineKeyboard(keyboard);
    };

    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();
        try {
            ctx.state.user = await getUser(userId, ctx.from.first_name, ctx.from.username);
        } catch (error) { 
            console.error(`Ошибка в мидлваре для userId ${userId}:`, error); 
        }
        return next();
    });

    bot.action('check_subscription', async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            if (user.subscribed_bonus_used) {
                return await ctx.answerCbQuery('Вы уже получали этот бонус. Спасибо!', { show_alert: true });
            }
            const channel = '@SCM_BLOG';
            if (await isSubscribed(ctx.from.id, channel)) {
                await setPremium(ctx.from.id, 30, 7);
                await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
                
                await ctx.editMessageText('🎉 Поздравляем! Вам начислен бонус: 7 дней тарифа Plus. Нажмите /menu, чтобы увидеть статус.');
            } else {
                await ctx.answerCbQuery('Кажется, вы ещё не подписаны на канал.', { show_alert: true });
                await ctx.reply(`Пожалуйста, подпишитесь на канал ${channel}, затем нажмите кнопку ещё раз.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➡️ Перейти в канал', url: 'https://t.me/SCM_BLOG' }],
                            [{ text: '✅ Я подписался!', callback_data: 'check_subscription' }]
                        ]
                    }
                });
            }
        } catch (e) {
            console.error('Ошибка в check_subscription:', e);
            await ctx.answerCbQuery('Произошла ошибка, попробуйте позже.', { show_alert: true });
        }
    });

    bot.start(async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
            const textMsg = formatMenuMessage(user, ctx);
            await ctx.reply(textMsg, getBonusKeyboard(user));
            await ctx.reply('Выберите действие:', kb());
        } catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });

    bot.hears(T('menu'), async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            const textMsg = formatMenuMessage(user, ctx);
            await ctx.reply(textMsg, getBonusKeyboard(user));
        } catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });
    
    bot.hears(T('mytracks'), async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            let tracks = [];
            if (Array.isArray(user.tracks_today)) tracks = user.tracks_today;
            else if (typeof user.tracks_today === 'string') {
                try { tracks = JSON.parse(user.tracks_today); } catch { tracks = []; }
            }
            const validTracks = (tracks || []).filter(t => t && t.fileId);
            if (!validTracks.length) {
                return await ctx.reply(T('noTracks'));
            }
            for (let i = 0; i < validTracks.length; i += 5) {
                const chunk = validTracks.slice(i, i + 5);
                await ctx.replyWithMediaGroup(chunk.map(track => ({ type: 'audio', media: track.fileId, title: track.title })));
            }
        } catch (err) {
            console.error('Ошибка в /mytracks:', err);
            await ctx.reply('Произошла ошибка при получении треков.');
        }
    });

    bot.hears(T('help'), (ctx) => ctx.reply(T('helpInfo'), kb()));
    bot.hears(T('upgrade'), (ctx) => ctx.reply(T('upgradeInfo'), { parse_mode: 'Markdown' }));

    bot.command('admin', async (ctx) => {
        if (ctx.from.id.toString() !== ADMIN_ID.toString()) return;
        try {
            const stats = await getDashboardStats();
            const dashboardUrl = WEBHOOK_URL.replace(/\/$/, '');
            const message = `
📊 <b>Статистика Бота</b>
👤 Всего: <i>${stats.totalUsers}</i> | Активных сегодня: <i>${stats.activeToday}</i>
📥 Загрузок: <i>${stats.totalDownloads}</i>
⚙️ Очередь: <i>${downloadQueue.active} / ${downloadQueue.size}</i>
🔗 <a href="${dashboardUrl}/dashboard">Открыть админ-панель</a>`;
            await ctx.replyWithHTML(message.trim());
        } catch (e) {
            console.error('❌ Ошибка в /admin:', e);
        }
    });

    bot.on('text', async (ctx) => {
        const commandTexts = Object.values(T());
        if (commandTexts.includes(ctx.message.text)) return; // Игнорируем текстовые команды

        try {
            const url = extractUrl(ctx.message.text);
            if (url) {
                await enqueue(ctx, ctx.from.id, url);
            } else {
                await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист SoundCloud.');
            }
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });
}

// ===== Корректное завершение =====
const stopBot = (signal) => {
    console.log(`Получен сигнал ${signal}. Завершение работы...`);
    if (bot.polling?.isRunning()) {
        bot.stop(signal);
    }
    setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();

export { bot };