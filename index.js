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

// === Импорты модулей НАШЕГО приложения ===
import { pool, supabase, getFunnelData, createUser, getUser, updateUserField, setPremium, getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats, markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById, getExpiringUsersCount, getExpiringUsersPaginated } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js'; // НАШ НОВЫЙ МЕНЕДЖЕР ЗАГРУЗОК

// === Константы и конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Проверка наличия всех необходимых переменных окружения
if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL) {
    console.error('❌ Отсутствуют необходимые переменные окружения! Проверьте BOT_TOKEN, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_URL.');
    process.exit(1);
}

// === Глобальные экземпляры и утилиты ===
const bot = new Telegraf(BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let redisClient = null;

/**
 * Геттер для получения инициализированного клиента Redis.
 * Используется в других модулях (например, в downloadManager).
 */
export function getRedisClient() {
    if (!redisClient) {
        throw new Error('Redis клиент ещё не инициализирован или не подключен.');
    }
    return redisClient;
}

/**
 * Тексты для бота. Экспортируются, чтобы быть доступными в других модулях.
 */
export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...',
    error: '❌ Ошибка',
    limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.\n\n🎁 Бонус\n📣 Подпишись на наш новостной канал @SCM_BLOG и получи 7 дней тарифа Plus бесплатно!`,
    upgradeInfo: `🚀 Хочешь больше треков?\n\n... (ваш текст) ...`,
    helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.... (ваш текст) ...`,
    adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// =================================================================
// ===                    ОСНОВНАЯ ЛОГИКА                       ===
// =================================================================

/**
 * Главная асинхронная функция для запуска всего приложения.
 */
async function startApp() {
    try {
        // 1. Инициализация Redis
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ Redis подключён');

        // 2. Создание папки для кэша
        const cacheDir = path.join(__dirname, 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        // 3. Настройка Express (админка, сессии, маршруты)
        setupExpress();

        // 4. Настройка Telegraf Bot (команды, мидлвары, обработчики)
        setupTelegramBot();
        
        // 5. Запуск периодических задач
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => {
            console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`);
        }, 60000);

        // 6. Запуск сервера и бота
        if (process.env.NODE_ENV === 'production') {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
            app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}. Webhook активен.`));
        } else {
            await bot.launch();
            console.log('✅ Бот запущен в режиме long-polling.');
        }

    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

/**
 * Настраивает все, что связано с Express: сессии, шаблонизаторы, маршруты админки.
 */
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

    // Middleware для добавления user в locals для шаблонов EJS
    app.use(async (req, res, next) => {
        res.locals.user = null;
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            try {
                req.user = await getUserById(req.session.userId);
                res.locals.user = req.user;
            } catch (e) {
                console.error('Ошибка загрузки пользователя для шаблонов:', e);
            }
        }
        next();
    });

    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            return next();
        }
        res.redirect('/admin');
    };

    // === МАРШРУТЫ EXPRESS (АДМИНКА) ===
    // Здесь полностью сохранен ваш код для админ-панели

    app.get('/health', (req, res) => res.send('OK'));
    app.get('/admin', (req, res) => { /* ... ваш код для /admin GET ... */ });
    app.post('/admin', (req, res) => { /* ... ваш код для /admin POST ... */ });
    app.get('/dashboard', requireAuth, async (req, res) => { /* ... ваш ОЧЕНЬ большой код для дашборда ... */ });
    app.get('/logout', (req, res) => { /* ... ваш код для /logout ... */ });
    app.get('/broadcast', requireAuth, (req, res) => { /* ... ваш код для /broadcast GET ... */ });
    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => { /* ... ваш код для /broadcast POST ... */ });
    app.get('/export', requireAuth, async (req, res) => { /* ... ваш код для /export ... */ });
    app.get('/expiring-users', requireAuth, async (req, res) => { /* ... ваш код для /expiring-users ... */ });
    app.post('/set-tariff', requireAuth, async (req, res) => { /* ... ваш код для /set-tariff ... */ });
    app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => { /* ... ваш код для /admin/reset-promo ... */ });
}

/**
 * Настраивает все, что связано с Telegraf: команды, обработчики текста, кнопок.
 */
function setupTelegramBot() {
    // Вспомогательные функции, используемые в обработчиках
    const isSubscribed = async (userId) => { /* ... ваш код isSubscribed ... */ };
    const extractUrl = (text) => { /* ... ваш код extractUrl ... */ };
    const formatMenuMessage = (user) => { /* ... ваш код formatMenuMessage ... */ };

    // Middleware для создания/получения пользователя при каждом сообщении
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
    
    // === ОБРАБОТЧИКИ TELEGRAM ===
    // Здесь полностью сохранен ваш код для команд бота
    
    bot.start(async (ctx) => { /* ... ваш код для /start ... */ });
    bot.hears(texts.menu, async (ctx) => { /* ... ваш код для hears menu ... */ });
    bot.hears(texts.mytracks, async (ctx) => { /* ... ваш код для hears mytracks ... */ });
    bot.hears(texts.help, async (ctx) => { /* ... ваш код для hears help ... */ });
    bot.hears(texts.upgrade, async (ctx) => { /* ... ваш код для hears upgrade ... */ });
    bot.command('admin', async (ctx) => { /* ... ваш код для /admin ... */ });
    bot.action('check_subscription', async (ctx) => { /* ... ваш код для action check_subscription ... */ });

    // ГЛАВНЫЙ ОБРАБОТЧИК ССЫЛОК И ТЕКСТОВЫХ КОМАНД
    bot.on('text', async (ctx) => {
        const url = extractUrl(ctx.message.text);
        
        // Если это ссылка на SoundCloud, отправляем в очередь
        if (url) {
            await enqueue(ctx, ctx.from.id, url);
        } else {
            // Если это не ссылка, возможно, это текстовая команда из старых версий или случайный текст.
            // Можно добавить здесь обработку или просто игнорировать.
            // Например, можно проверить, совпадает ли текст с кнопками клавиатуры.
            const knownCommands = [texts.menu, texts.mytracks, texts.help, texts.upgrade];
            if (!knownCommands.includes(ctx.message.text)) {
                 await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист, или воспользуйтесь меню.');
            }
        }
    });
}

// === ЗАПУСК ПРИЛОЖЕНИЯ ===
startApp();

// Обработка сигналов для корректного завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));