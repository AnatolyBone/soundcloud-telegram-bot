// index.js

// Core
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Middleware
import compression from 'compression';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';

// Telegram
import { Telegraf, Markup } from 'telegraf';

// Storage
import { createClient } from 'redis';
import pgSessionFactory from 'connect-pg-simple';

// Utils
import json2csv from 'json-2-csv';
import ytdl from 'youtube-dl-exec';

// Database logic
import {
  pool,
  supabase,
  getFunnelData,
  getUser,
  updateUserField,
  setPremium,
  getAllUsers,
  resetDailyStats,
  addReview,
  saveTrackForUser,
  hasLeftReview,
  getLatestReviews,
  resetDailyLimitIfNeeded,
  getRegistrationsByDate,
  getDownloadsByDate,
  getActiveUsersByDate,
  getExpiringUsers,
  getReferralSourcesStats,
  markSubscribedBonusUsed,
  getUserActivityByDayHour,
  getLastMonths,
  logUserActivity,
  getUserById,
  getExpiringUsersCount,
  getExpiringUsersPaginated,
  cacheTrack,
  findCachedTracksByUrls,
  findUsersToNotify,
  markAsNotified,
  getDashboardStats,
  findCachedTrack,
  logEvent
} from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { initNotifier, startNotifier } from './services/notifier.js';

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
initNotifier(bot);
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

// index.js

export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    error: '❌ Ошибка',
    noTracks: 'Сегодня нет треков.',
    limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.`,
    // <<< ИСПРАВЛЕНО: Простой Markdown >>>
    upgradeInfo: `🚀 *Обновленные тарифы!*\n\n` +
        `💡 Платные тарифы получают *приоритет в очереди* и обрабатываются первыми.\n\n` +
        `🆓 *Free* — 5 треков/день\n` +
        `🎯 *Plus* — 30 треков/день — *119₽/мес.*\n` +
        `💪 *Pro* — 100 треков/день, полные плейлисты — *199₽/мес.*\n` +
        `💎 *Unlimited* — Безлимитные загрузки — *299₽/мес.*\n\n` +
        `👉 [Для покупки](https://boosty.to/anatoly_bone/donate)\n` + // Синтаксис ссылки для простого Markdown
        `✉️ После оплаты пришлите чек: @anatolybone\n\n` +
        `📣 Новости и фишки: @SCM_BLOG`,
    helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  \n🔓 Расширить — оплати и подтверди.  \n🎵 Мои треки — список за сегодня.  \n📋 Меню — тариф, лимиты, рефералы.  \n📣 Канал: @SCM_BLOG`,
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

function getTariffName(limit) {
    if (limit >= 1000) return 'Unlimited (∞/день)';
    if (limit === 100) return 'Pro (100/день)';
    if (limit === 30) return 'Plus (30/день)';
    return 'Free (5/день)';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

async function getUrlsToIndex() {
    try {
        const { rows } = await pool.query(`
            SELECT url, COUNT(url) as download_count
            FROM downloads_log
            WHERE url IS NOT NULL AND url LIKE '%soundcloud.com%' AND url NOT IN (SELECT url FROM track_cache)
            GROUP BY url
            ORDER BY download_count DESC
            LIMIT 10;
        `);
        return rows.map(row => row.url);
    } catch (e) {
        console.error('[Indexer] Ошибка получения URL для индексации:', e);
        return [];
    }
}

// index.js

async function processUrlForIndexing(url) {
    let tempFilePath = null;
    try {
        const isCached = await findCachedTrack(url);
        if (isCached) {
            console.log(`[Indexer] Пропуск: ${url} уже в кэше.`);
            return; // Возвращаемся, если уже закэшировано
        }

        console.log(`[Indexer] Индексирую: ${url}`);
        const info = await ytdl(url, { dumpSingleJson: true });

        // <<< НАЧАЛО ИСПРАВЛЕНИЯ: Улучшенная проверка на плейлист >>>
        if (!info || info._type === 'playlist') {
            console.log(`[Indexer] Пропуск: ${url} является плейлистом.`);
            return; // Явно пропускаем плейлисты
        }
        // <<< КОНЕЦ ИСПРАВЛЕНИЯ >>>

        const trackName = (info.title || 'track').slice(0, 100);
        const uploader = info.uploader || 'SoundCloud';
        tempFilePath = path.join(cacheDir, `indexer_${info.id || Date.now()}.mp3`);
        
        await ytdl(url, {
            output: tempFilePath,
            extractAudio: true,
            audioFormat: 'mp3',
            embedMetadata: true,
            postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`
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
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }
}
async function startIndexer() {
    console.log('🚀 Запуск фонового индексатора...');
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    while (true) {
        try {
            const urls = await getUrlsToIndex();
            if (urls.length > 0) {
                console.log(`[Indexer] Найдено ${urls.length} треков для упреждающего кэширования.`);
                for (const url of urls) {
                    await processUrlForIndexing(url);
                    await new Promise(resolve => setTimeout(resolve, 30 * 1000));
                }
            }
            console.log('[Indexer] Пауза на 1 час.');
            await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
        } catch (err) {
            console.error("🔴 Критическая ошибка в цикле индексатора, перезапуск через 5 минут:", err);
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        }
    }
}

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

        startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе, не удалось запустить:", err));
        startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));

    } catch (err) {
        console.error('🔴 Критическая ошибка при запуске приложения:', err);
        process.exit(1);
    }
}

function setupExpress() {
    // Вспомогательные функции для дашборда
    function convertObjToArray(dataObj) {
        if (!dataObj) return [];
        return Object.entries(dataObj).map(([date, count]) => ({ date, count }));
    }

    function filterStatsByPeriod(data, period) {
        if (!Array.isArray(data)) return [];
        const now = new Date();
        if (!isNaN(period)) {
            const days = parseInt(period);
            const cutoff = new Date(now.getTime() - days * 86400000);
            return data.filter(item => new Date(item.date) >= cutoff);
        }
        if (/^\d{4}-\d{2}$/.test(period)) {
            return data.filter(item => item.date && item.date.startsWith(period));
        }
        return data;
    }

    function prepareChartData(registrations, downloads, active) {
        const dateSet = new Set([...registrations.map(r => r.date), ...downloads.map(d => d.date), ...active.map(a => a.date)]);
        const dates = Array.from(dateSet).sort();
        const regMap = new Map(registrations.map(r => [r.date, r.count]));
        const dlMap = new Map(downloads.map(d => [d.date, d.count]));
        const actMap = new Map(active.map(a => [a.date, a.count]));
        return {
            labels: dates,
            datasets: [
                { label: 'Регистрации', data: dates.map(d => regMap.get(d) || 0), borderColor: 'rgba(75, 192, 192, 1)', fill: false },
                { label: 'Загрузки', data: dates.map(d => dlMap.get(d) || 0), borderColor: 'rgba(255, 99, 132, 1)', fill: false },
                { label: 'Активные пользователи', data: dates.map(d => actMap.get(d) || 0), borderColor: 'rgba(54, 162, 235, 1)', fill: false }
            ]
        };
    }

    function computeActivityByHour(activityByDayHour) {
        const hours = Array(24).fill(0);
        for (const day in activityByDayHour) {
            const hoursData = activityByDayHour[day];
            if(hoursData) {
                for (let h = 0; h < 24; h++) {
                    hours[h] += hoursData[h] || 0;
                }
            }
        }
        return hours;
    }

    function computeActivityByWeekday(activityByDayHour) {
        const weekdays = Array(7).fill(0);
        for (const dayStr in activityByDayHour) {
            const dayTotal = Object.values(activityByDayHour[dayStr] || {}).reduce((a, b) => a + b, 0);
            weekdays[new Date(dayStr).getDay()] += dayTotal;
        }
        return weekdays;
    }

    // Основная настройка Express
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
    
    // Маршруты
    app.get('/health', (req, res) => res.send('OK'));
    
    app.get('/admin', (req, res) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return res.redirect('/dashboard');
        res.render('login', { title: 'Вход в админку', error: null, layout: false });
    });

    app.post('/admin', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль', layout: false });
        }
    });

    // <<< ФИНАЛЬНАЯ ВЕРСИЯ МАРШРУТА /dashboard >>>
    app.get('/dashboard', requireAuth, async (req, res, next) => {
        try {
            const { period = '30', showInactive = 'false', expiringLimit = '10', expiringOffset = '0' } = req.query;

            // ШАГ 1: Собираем ВСЕ данные для страницы параллельно
            const [
                stats,
                downloadsByDateRaw, 
                registrationsByDateRaw, 
                activeByDateRaw, 
                activityByDayHour,
                expiringSoon,
                expiringCount,
                referralStats,
                funnelCounts,
                lastMonths,
                users
            ] = await Promise.all([
                getDashboardStats(),
                getDownloadsByDate(), 
                getRegistrationsByDate(), 
                getActiveUsersByDate(),
                getUserActivityByDayHour(),
                getExpiringUsersPaginated(parseInt(expiringLimit), parseInt(expiringOffset)),
                getExpiringUsersCount(),
                getReferralSourcesStats(),
                getFunnelData(new Date('2000-01-01').toISOString(), new Date().toISOString()),
                getLastMonths(6),
                getAllUsers(showInactive === 'true')
            ]);

            // ШАГ 2: Готовим данные для графиков
            const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
            const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
            const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);

            const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);
            const chartDataHourActivity = {
                labels: [...Array(24).keys()].map(h => `${h}:00`),
                datasets: [{ label: 'Активность по часам', data: computeActivityByHour(activityByDayHour), backgroundColor: 'rgba(54, 162, 235, 0.7)' }]
            };
            const chartDataWeekdayActivity = {
                labels: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
                datasets: [{ label: 'Активность по дням недели', data: computeActivityByWeekday(activityByDayHour), backgroundColor: 'rgba(255, 206, 86, 0.7)' }]
            };

            // ШАГ 3: Отправляем ВСЕ в шаблон
            res.render('dashboard', {
                title: 'Панель управления',
                page: 'dashboard',
                user: req.user,
                period,
                showInactive: showInactive === 'true',
                stats,
                users,
                expiringSoon,
                expiringCount,
                referralStats,
                funnelData: funnelCounts,
                lastMonths,
                expiringLimit: parseInt(expiringLimit),
                expiringOffset: parseInt(expiringOffset),
                chartDataCombined,
                chartDataHourActivity,
                chartDataWeekdayActivity
            });
        } catch (e) {
            next(e);
        }
    });

    app.get('/user/:id', requireAuth, async (req, res, next) => {
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
                title: `Профиль: ${user.first_name || user.username}`,
                user,
                downloads: downloadsResult.data || [],
                referrals: referralsResult.rows,
                page: 'user-profile'
            });
        } catch (e) {
            next(e);
        }
    });

    app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/admin')); });

    app.get('/broadcast', requireAuth, (req, res) => { res.render('broadcast-form', { title: 'Рассылка', error: null, success: null, page: 'broadcast' }); });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res, next) => {
        try {
            const { message } = req.body;
            const audio = req.file;
            if (!message && !audio) {
                return res.status(400).render('broadcast-form', { title: 'Рассылка', error: 'Текст или аудиофайл обязательны', success: null, page: 'broadcast' });
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
            res.render('broadcast-form', { title: 'Рассылка', success: `Отправлено ${successCount} сообщений.`, error: `Ошибок: ${errorCount}.`, page: 'broadcast' });
        } catch (e) {
            next(e);
        }
    });
    
    app.get('/export', requireAuth, async (req, res, next) => {
        try {
            const users = await getAllUsers(true);
            const csv = await json2csv.json2csv(users, {});
            res.header('Content-Type', 'text/csv');
            res.attachment('users.csv');
            return res.send(csv);
        } catch (e) {
            next(e);
        }
    });

    app.get('/expiring-users', requireAuth, async (req, res, next) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const perPage = 10;
            const total = await getExpiringUsersCount();
            const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);
            res.render('expiring-users', { users, page, totalPages: Math.ceil(total / perPage), title: 'Истекающие подписки', page: 'expiring-users' });
        } catch (e) {
            next(e);
        }
    });
    
    app.post('/set-tariff', requireAuth, async (req, res, next) => {
        try {
            const { userId, limit, days } = req.body;
            const parsedLimit = parseInt(limit);
            const parsedDays = parseInt(days) || 30;
            
            await setPremium(userId, parsedLimit, parsedDays);
            
            const tariffName = getTariffName(parsedLimit);
            const message = `🎉 Ваш тариф был изменен!\n\n` +
                `✨ Новый тариф: **${tariffName}**\n` +
                `⏳ Срок действия: **${parsedDays} дней**\n\n` +
                `Спасибо, что пользуетесь нашим ботом!`;
            
            try {
                await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
                console.log(`[Admin] Отправлено уведомление о смене тарифа пользователю ${userId}`);
            } catch (telegramError) {
                console.error(`[Admin] Не удалось отправить уведомление пользователю ${userId}:`, telegramError.message);
            }
            
            res.redirect(req.get('referer') || '/dashboard');
        } catch (e) {
            next(e);
        }
    });

    // Глобальный обработчик ошибок
    app.use((err, req, res, next) => {
        console.error('🔴 Необработанная ошибка:', err);
        const statusCode = err.status || 500;
        const message = err.message || 'Внутренняя ошибка сервера';
        res.status(statusCode);
        if (req.originalUrl.startsWith('/api/')) {
            return res.json({ error: message });
        }
        // Указываем правильное имя файла 'errors.ejs'
        res.render('errors', {
            title: `Ошибка ${statusCode}`,
            message,
            statusCode,
            error: err,
            page: 'error',
            layout: 'layout' 
        });
    });
}

// --- Настройка Telegraf ---
// index.js

// index.js

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

    const isSubscribed = async (userId, channelUsername) => {
        try {
            const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
            return ['creator', 'administrator', 'member'].includes(chatMember.status);
        } catch (e) {
            console.error(`Ошибка проверки подписки для user ${userId} на канал ${channelUsername}:`, e.message);
            return false;
        }
    };

    function formatMenuMessage(user, ctx) {
        const tariffLabel = getTariffName(user.premium_limit);
        const downloadsToday = user.downloads_today || 0;
        const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
        const daysLeft = getDaysLeft(user.premium_until);
        
        let message = `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3. Просто пришли ссылку.

📣 Новости, фишки и бонусы в нашем канале 👉 @SCM_BLOG

💼 Тариф: *${tariffLabel}*
⏳ Осталось дней: *${daysLeft > 999 ? '∞' : daysLeft}*

🎧 Сегодня скачано: *${downloadsToday}* из *${user.premium_limit}*

🔗 Твоя реферальная ссылка (пока в разработке):
\`${refLink}\`
        `.trim();
        
        if (!user.subscribed_bonus_used) {
            message += `\n\n🎁 *Бонус!*\nПодпишись на наш новостной канал @SCM_BLOG и получи *7 дней тарифа Plus* бесплатно!`;
        }
        
        return message;
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

    const getBonusKeyboard = (user) => {
        const keyboard = [];
        if (!user.subscribed_bonus_used) {
            keyboard.push([{ text: '✅ Я подписался, получить бонус!', callback_data: 'check_subscription' }]);
        }
        return { inline_keyboard: keyboard };
    };

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
                
                await ctx.editMessageText(
                    '🎉 *Поздравляем!*\n\nВаша подписка на канал подтверждена. ' +
                    'Вам начислен бонус: *7 дней тарифа Plus*.\n\n' +
                    'Чтобы увидеть обновленный статус, нажмите /menu.',
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.answerCbQuery('Кажется, вы еще не подписаны на канал.', { show_alert: true });
                await ctx.reply(`Пожалуйста, сначала подпишитесь на канал ${channel}, а затем нажмите кнопку еще раз.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➡️ Перейти в канал', url: 'https://t.me/SCM_BLOG' }],
                            [{ text: '✅ Я подписался!', callback_data: 'check_subscription' }]
                        ]
                    }
                });
            }
        } catch (e) {
            console.error('Ошибка в обработчике check_subscription:', e);
            await ctx.answerCbQuery('Произошла ошибка, попробуйте позже.', { show_alert: true });
        }
    });
    
    bot.start(async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
            const messageText = formatMenuMessage(user, ctx);
            await ctx.reply(messageText, { parse_mode: 'Markdown', reply_markup: getBonusKeyboard(user) });
            await ctx.reply('Выберите действие:', kb());
        } catch (e) {
            await handleSendMessageError(e, ctx.from.id);
        }
    });
    
    bot.hears(texts.menu, async (ctx) => {
        try {
            const user = ctx.state.user || await getUser(ctx.from.id);
            const messageText = formatMenuMessage(user, ctx);
            await ctx.reply(messageText, { parse_mode: 'Markdown', reply_markup: getBonusKeyboard(user) });
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
                try { tracks = JSON.parse(user.tracks_today); } catch (e) { tracks = []; }
            }
            const validTracks = tracks.filter(t => t && t.fileId);
            if (!validTracks.length) {
                return await ctx.reply(texts.noTracks || 'У вас пока нет треков за сегодня.');
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

    bot.hears(texts.help, async (ctx) => {
        try { await ctx.reply(texts.helpInfo, kb()); } 
        catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });

    bot.hears(texts.upgrade, async (ctx) => {
        try { 
            await ctx.replyWithMarkdown(texts.upgradeInfo, { disable_web_page_preview: true });
        } 
        catch (e) { await handleSendMessageError(e, ctx.from.id); }
    });

    bot.command('admin', async (ctx) => {
        if (ctx.from.id !== ADMIN_ID) return;
        try {
            const users = await getAllUsers(true);
            const totalUsers = users.length;
            const activeUsers = users.filter(u => u.active).length;
            const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
            const now = new Date();
            const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;
            
            const dashboardUrl = `${WEBHOOK_URL.replace(/\/$/, '')}/dashboard`;
            
            const message = `
📊 <b>Статистика Бота</b>

👤 <b>Пользователи:</b>
   - Всего: <i>${totalUsers}</i>
   - Активных всего: <i>${activeUsers}</i>
   - Активных сегодня: <i>${activeToday}</i>

📥 <b>Загрузки:</b>
   - Всего за все время: <i>${totalDownloads}</i>

⚙️ <b>Очередь сейчас:</b>
   - В работе: <i>${downloadQueue.active}</i>
   - В ожидании: <i>${downloadQueue.size}</i>

🔗 <a href="${dashboardUrl}">Открыть админ-панель</a>`;
            
            await ctx.replyWithHTML(message.trim());
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
// --- Запуск приложения ---
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