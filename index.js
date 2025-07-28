// index.js

import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from 'redis';
import pgSessionFactory from 'connect-pg-simple';
import json2csv from 'json-2-csv';

import {
    pool, supabase, getFunnelData, getUser, updateUserField, setPremium, getAllUsers,
    resetDailyStats, addReview, saveTrackForUser, hasLeftReview, getLatestReviews,
    resetDailyLimitIfNeeded, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate,
    getExpiringUsers, getReferralSourcesStats, markSubscribedBonusUsed, getUserActivityByDayHour,
    logUserActivity, getUserById, getExpiringUsersCount, cacheTrack,
    findCachedTracksByUrls, logEvent
} from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
    console.error('❌ Отсутствуют необходимые переменные окружения!');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
let redisClient = null;

export function getRedisClient() {
    if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
    return redisClient;
}

async function cleanupCache(directory, maxAgeMinutes = 60) {
    try {
        const now = Date.now();
        const files = await fs.promises.readdir(directory);
        let cleanedCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(directory, file);
                const stat = await fs.promises.stat(filePath);
                if ((now - stat.mtimeMs) / 60000 > maxAgeMinutes) {
                    await fs.promises.unlink(filePath);
                    cleanedCount++;
                }
            } catch (fileError) {}
        }
        if (cleanedCount > 0) console.log(`[Cache Cleanup] Удалено ${cleanedCount} старых файлов.`);
    } catch (dirError) {
        if (dirError.code !== 'ENOENT') {
            console.error('[Cache Cleanup] Ошибка:', dirError);
        }
    }
}

export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    error: '❌ Ошибка',
    noTracks: 'Сегодня нет треков.',
    limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.\n\n🎁 Бонус\n📣 Подпишись на наш новостной канал @SCM_BLOG и получи 7 дней тарифа Plus бесплатно!`,
    upgradeInfo: `🚀 Хочешь больше треков?\n\n🆓 Free — 10 🟢  \nPlus — 50 🎯 (59₽)  \nPro — 100 💪 (119₽)  \nUnlimited — 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate  \n✉️ После оплаты напиши: @anatolybone\n\n📣 Новости и фишки: @SCM_BLOG`,
    helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  \n🔓 Расширить — оплати и подтверди.  \n🎵 Мои треки — список за сегодня.  \n📋 Меню — тариф, лимиты, рефералы.  \n📣 Канал: @SCM_BLOG`,
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

async function startApp() {
    try {
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ Redis подключён');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        setupExpress();
        setupTelegramBot();
        
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
        setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
        cleanupCache(cacheDir, 60);

        if (process.env.NODE_ENV === 'production') {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
        } else {
            await bot.launch();
            console.log('✅ Бот запущен в режиме long-polling.');
        }
    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

function setupExpress() {
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(expressLayouts);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.set('layout', 'layout');
    
    const pgSession = pgSessionFactory(session);
    app.use(session({
        store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));

    app.use(async (req, res, next) => {
        res.locals.user = null;
        res.locals.page = '';
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            try {
                req.user = await getUserById(req.session.userId);
                res.locals.user = req.user;
            } catch(e) { console.error(e); }
        }
        next();
    });

    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
        res.redirect('/admin');
    };
    
    app.get('/health', (req, res) => res.send('OK'));
    
    app.get('/admin', (req, res) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return res.redirect('/dashboard');
        res.render('login', { title: 'Вход в админку', error: null });
    });

    app.post('/admin', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
        }
    });

    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            const [users, expiringSoon, expiringCount, referralStats, funnelData] = await Promise.all([
                getAllUsers(true),
                getExpiringUsers(),
                getExpiringUsersCount(),
                getReferralSourcesStats(),
                getFunnelData(new Date('2000-01-01').toISOString(), new Date().toISOString())
            ]);
            res.render('dashboard', {
                title: 'Панель управления', page: 'dashboard',
                users, expiringSoon, expiringCount, referralStats, funnelData, user: req.user
            });
        } catch (e) {
            console.error('❌ Ошибка при загрузке dashboard:', e);
            res.status(500).send('Внутренняя ошибка сервера: ' + e.message);
        }
    });

    app.get('/user/:id', requireAuth, async (req, res) => {
        try {
            const userId = parseInt(req.params.id);
            if (isNaN(userId)) return res.status(400).send('Неверный ID');
            const user = await getUserById(userId);
            if (!user) return res.status(404).send('Пользователь не найден');
            const [downloadsResult, referralsResult] = await Promise.all([
                supabase.from('events').select('*').eq('user_id', userId).eq('event_type', 'download_start').order('created_at', { ascending: false }).limit(100),
                pool.query('SELECT id, first_name, username, created_at FROM users WHERE referrer_id = $1', [userId])
            ]);
            res.render('user-profile', {
                title: `Профиль: ${user.first_name || user.username}`, user,
                downloads: downloadsResult.data || [], referrals: referralsResult.rows, page: 'user-profile'
            });
        } catch (e) {
            console.error(e);
            res.status(500).send('Ошибка сервера');
        }
    });

    app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin')); });

    app.get('/broadcast', requireAuth, (req, res) => { res.render('broadcast-form', { title: 'Рассылка', error: null, success: null, page: 'broadcast' }); });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
        const { message } = req.body;
        const audio = req.file;
        if (!message && !audio) {
            return res.status(400).render('broadcast-form', { error: 'Текст или аудиофайл обязательны', success: null, page: 'broadcast' });
        }
        const users = await getAllUsers(false);
        let successCount = 0, errorCount = 0;
        for (const user of users) {
            try {
                if (audio) {
                    await bot.telegram.sendAudio(user.id, { source: fs.createReadStream(audio.path) }, { caption: message });
                } else {
                    await bot.telegram.sendMessage(user.id, message);
                }
                successCount++;
            } catch (e) {
                errorCount++;
                if (e.response?.error_code === 403) await updateUserField(user.id, 'active', false);
            }
            await new Promise(r => setTimeout(r, 100));
        }
        if (audio) fs.unlinkSync(audio.path);
        try {
            await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена:\n✅ Успешно: ${successCount}\n❌ Ошибок: ${errorCount}`);
        } catch (adminError) {
            console.error('Не удалось отправить отчет админу:', adminError.message);
        }
        res.render('broadcast-form', { success: `Отправлено ${successCount} сообщений.`, error: `Ошибок: ${errorCount}.`, page: 'broadcast' });
    });
    
    app.get('/export', requireAuth, async (req, res) => {
        const users = await getAllUsers(true);
        const csv = await json2csv.json2csv(users, {});
        res.header('Content-Type', 'text/csv');
        res.attachment('users.csv');
        return res.send(csv);
    });

    app.get('/expiring-users', requireAuth, async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const perPage = 10;
        const total = await getExpiringUsersCount();
        const users = await getExpiringUsers(perPage, (page - 1) * perPage);
        res.render('expiring-users', { users, page, totalPages: Math.ceil(total / perPage), title: 'Истекающие подписки' });
    });
    
    app.post('/set-tariff', requireAuth, async (req, res) => {
        const { userId, limit, days } = req.body;
        await setPremium(userId, parseInt(limit), parseInt(days) || 30);
        res.redirect(req.get('referer') || '/dashboard');
    });
}

function setupTelegramBot() {
    const handleSendMessageError = async (error, userId) => {
        if (error.response?.error_code === 403) {
            console.log(`Пользователь ${userId} заблокировал бота. Отключаем его.`);
            await updateUserField(userId, 'active', false);
        } else {
            console.error(`Ошибка при отправке сообщения для ${userId}:`, error.message);
        }
    };

    const extractUrl = (text = '') => {
        const regex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(regex);
        return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
    };

    function getTariffName(limit) {
        if (limit >= 1000) return 'Unlimited (∞/день)';
        if (limit >= 100) return 'Pro (100/день)';
        if (limit >= 50) return 'Plus (50/день)';
        return 'Free (10/день)';
    }

    function getDaysLeft(premiumUntil) {
        if (!premiumUntil) return 0;
        const diff = new Date(premiumUntil) - new Date();
        return Math.max(Math.ceil(diff / 86400000), 0);
    }

    function formatMenuMessage(user, ctx) {
        const tariffLabel = getTariffName(user.premium_limit);
        const downloadsToday = user.downloads_today || 0;
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
        const daysLeft = getDaysLeft(user.premium_until);
        return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3. Просто пришли ссылку.

📣 Новости, фишки и бонусы в нашем канале 👉 @SCM_BLOG

💼 Тариф: ${tariffLabel}
⏳ Осталось дней: ${daysLeft > 999 ? '∞' : daysLeft}

🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

🔗 Твоя реферальная ссылка (пока в разработке):
${refLink}
        `.trim();
    }

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

    bot.start(async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
            await ctx.reply(formatMenuMessage(user, ctx), kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.menu, async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            await ctx.reply(formatMenuMessage(user, ctx), kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });

    bot.hears(texts.mytracks, async (ctx) => {
    try {
        const user = ctx.state.user || await getUser(ctx.from.id);
        
        let tracks = [];
        if (Array.isArray(user.tracks_today)) {
            tracks = user.tracks_today;
        } else if (typeof user.tracks_today === 'string') {
            try {
                tracks = JSON.parse(user.tracks_today);
            } catch (e) {
                tracks = [];
            }
        }
        
        const validTracks = tracks.filter(t => t && t.fileId);
        
        if (!validTracks.length) {
            return await ctx.reply(texts.noTracks || 'У вас пока нет треков за сегодня.');
        }
        
        // Отправка пачками по 5 аудиофайлов
        for (let i = 0; i < validTracks.length; i += 5) {
            const chunk = validTracks.slice(i, i + 5);
            await ctx.replyWithMediaGroup(chunk.map(track => ({
                type: 'audio',
                media: track.fileId,
                title: track.title,
            })));
        }
        
    } catch (err) {
        console.error('Ошибка в /mytracks:', err);
        await ctx.reply('Произошла ошибка при получении треков.');
    }
});

    bot.hears(texts.help, async (ctx) => {
        try { await ctx.reply(texts.helpInfo, kb()); } 
        catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });

    bot.hears(texts.upgrade, async (ctx) => {
        try { await ctx.reply(texts.upgradeInfo, kb()); } 
        catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });

    bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const users = await getAllUsers(true);
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        
        // Функция экранирования MarkdownV2
        const escapeMarkdown = (text) => text.replace(/[_*[\]()`~>#+=|{}.!-]/g, '\\$&');
        const escapedUrl = escapeMarkdown(`${WEBHOOK_URL.replace(/\/$/, '')}/dashboard`);
        
        const message = `
📊 *Статистика Бота*

👤 *Пользователи:*
   \\- Всего: *${totalUsers}*
   \\- Активных: *${activeUsers}*

📥 *Загрузки:*
   \\- Всего за все время: *${totalDownloads}*

⚙️ *Очередь сейчас:*
   \\- В работе: *${downloadQueue.active}*
   \\- В ожидании: *${downloadQueue.size}*

🔗 [Открыть админ\\-панель](${escapedUrl})
        `.trim();
        
        await ctx.reply(message, { parse_mode: 'MarkdownV2' });
    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        try {
            await ctx.reply('⚠️ Произошла ошибка при получении статистики.');
        } catch {}
    }
});
    bot.on('text', async (ctx) => {
        try {
            const url = extractUrl(ctx.message.text);
            if (url) {
                await enqueue(ctx, ctx.from.id, url);
            } else if (!Object.values(texts).includes(ctx.message.text)) {
                await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист SoundCloud.');
            }
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });
}

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

export { app, bot };