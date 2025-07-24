// === Встроенные и сторонние библиотеки ===
import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import multer from 'multer';
import ejs from 'ejs';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from 'redis';
import pgSessionFactory from 'connect-pg-simple';
import json2csv from 'json-2-csv';

// === Импорты собственного проекта ===
import { pool, supabase, getFunnelData, createUser, getUser, updateUserField, incrementDownloads, setPremium, getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats, markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById, getExpiringUsersCount, getExpiringUsersPaginated } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

// === Константы и конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

// === Глобальные переменные и утилиты ===
let redisClient = null;

export function getRedisClient() {
    if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
    return redisClient;
}

export const texts = { /* ... Ваш объект texts ... */
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached: `🚫 Лимит достигнут ❌...`, // ваш текст
  upgradeInfo: `🚀 Хочешь больше треков?...`,
  helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3....`,
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// === Инициализация приложения ===
(async () => {
    try {
        // 1. Redis
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ Redis подключён');

        // 2. Папка кэша
        const cacheDir = path.join(__dirname, 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        // 3. Периодические задачи
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => {
            console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`);
        }, 30000);

        // 4. Express
        setupExpress();

        // 5. Telegram Bot
        setupTelegramBot();

        // 6. Запуск сервера
        if (process.env.NODE_ENV === 'production' && WEBHOOK_URL) {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
        } else {
            bot.launch().then(() => console.log('✅ Бот запущен в режиме long-polling'));
        }

    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
})();

// === Настройка Express ===
function setupExpress() {
    // ... Ваш код для `app.use`, `app.set` ...
    // Например:
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
        secret: process.env.SESSION_SECRET || 'supersecret',
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));

    // === Маршруты Express (ваша админка) ===
    // Middleware для добавления user в locals
    app.use(async (req, res, next) => {
        res.locals.user = null;
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            try {
                req.user = await getUserById(req.session.userId);
                res.locals.user = req.user;
            } catch(e) { console.error(e); }
        }
        next();
    });

    function requireAuth(req, res, next) {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            return next();
        }
        res.redirect('/admin');
    }

    app.get('/admin', (req, res) => { /* ... ваш код ... */ });
    app.post('/admin', (req, res) => { /* ... ваш код ... */ });
    app.get('/dashboard', requireAuth, async (req, res) => { /* ... ваш ОЧЕНЬ большой код для дашборда ... */ });
    app.get('/logout', (req, res) => { /* ... ваш код ... */ });
    app.get('/broadcast', requireAuth, (req, res) => { /* ... ваш код ... */ });
    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => { /* ... ваш код ... */ });
    app.get('/export', requireAuth, async (req, res) => { /* ... ваш код ... */ });
    app.get('/expiring-users', requireAuth, async (req, res) => { /* ... ваш код ... */ });
    app.post('/set-tariff', requireAuth, async (req, res) => { /* ... ваш код ... */ });
    app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => { /* ... ваш код ... */ });
    app.get('/health', (req, res) => res.send('OK'));
}

// === Настройка Telegraf Bot ===
function setupTelegramBot() {
    // Мидлвар для создания/получения пользователя
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return;
        try {
            let user = await getUser(userId);
            if (!user) {
                user = await createUser(userId, ctx.from.username, ctx.from.first_name);
            }
            ctx.state.user = user;
        } catch (error) {
            console.error(`Ошибка в мидлваре для userId ${userId}:`, error);
        }
        return next();
    });
    
    // Вспомогательная функция для извлечения URL
    function extractUrl(text) {
        const regex = /(https?:\/\/[^\s]+)/g;
        const matches = text.match(regex);
        return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
    }

    // Обработчик ссылок
    bot.on('text', async (ctx) => {
        const url = extractUrl(ctx.message.text);
        if (url) {
            // Вся логика теперь в одной функции
            await enqueue(ctx, ctx.from.id, url);
        } else {
            // Обработка текстовых команд меню
            switch (ctx.message.text) {
                case texts.menu:
                    // ваш код для меню
                    break;
                case texts.mytracks:
                    // ваш код для mytracks
                    break;
                // ... другие команды
            }
        }
    });

    // ... Остальные ваши обработчики: bot.start, bot.hears, bot.command, bot.action ...
    bot.start(async ctx => { /* ... ваш код ... */ });
    bot.hears(texts.menu, async ctx => { /* ... ваш код ... */ });
    bot.command('admin', async ctx => { /* ... ваш код ... */ });
    bot.action('check_subscription', async ctx => { /* ... ваш код ... */ });
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));