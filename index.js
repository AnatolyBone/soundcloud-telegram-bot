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
  logEvent
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
    // === Вспомогательные функции для дашборда (из старой версии) ===
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
        const weekdays = Array(7).fill(0); // 0=Воскресенье
        for (const dayStr in activityByDayHour) {
            const dayTotal = Object.values(activityByDayHour[dayStr] || {}).reduce((a, b) => a + b, 0);
            weekdays[new Date(dayStr).getDay()] += dayTotal;
        }
        return weekdays;
    }

    // === Основная настройка Express ===
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
    
    // === Маршруты (Routes) ===
    app.get('/health', (req, res) => res.send('OK'));
    
    app.get('/admin', (req, res) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return res.redirect('/dashboard');
        res.render('login', { title: 'Вход в админку', error: null, layout: false }); // Отключаем layout для страницы входа
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

    // === API роуты для дашборда (из старой версии) ===
    app.get('/api/dashboard-data', requireAuth, async (req, res, next) => {
        try {
            const { period = '30' } = req.query;
            const users = await getAllUsers(true);
            const [
                downloadsByDateRaw, registrationsByDateRaw, activeByDateRaw, 
                activityByDayHour
            ] = await Promise.all([
                getDownloadsByDate(), getRegistrationsByDate(), getActiveUsersByDate(),
                getUserActivityByDayHour()
            ]);
            const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
            const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
            const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);
    
            res.json({
                stats: {
                    totalUsers: users.length,
                    totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
                    free: users.filter(u => u.premium_limit <= 10).length,
                    plus: users.filter(u => u.premium_limit > 10 && u.premium_limit <= 50).length,
                    pro: users.filter(u => u.premium_limit > 50 && u.premium_limit < 1000).length,
                    unlimited: users.filter(u => u.premium_limit >= 1000).length,
                },
                chartDataCombined: prepareChartData(filteredRegistrations, filteredDownloads, filteredActive),
                chartDataHourActivity: {
                    labels: [...Array(24).keys()].map(h => `${h}:00`),
                    datasets: [{ label: 'Активность по часам', data: computeActivityByHour(activityByDayHour), backgroundColor: 'rgba(54, 162, 235, 0.7)' }]
                },
                chartDataWeekdayActivity: {
                    labels: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
                    datasets: [{ label: 'Активность по дням недели', data: computeActivityByWeekday(activityByDayHour), backgroundColor: 'rgba(255, 206, 86, 0.7)' }]
                },
            });
        } catch (e) {
            next(e); // Передаем ошибку в глобальный обработчик
        }
    });

    app.get('/api/users', requireAuth, async (req, res, next) => {
        try {
            const { showInactive = 'false', registrationDate } = req.query;
            let queryText = 'SELECT id, username, first_name, total_downloads, premium_limit, created_at, last_active, active, referral_source, promo_1plus1_used FROM users';
            const queryParams = [];
            const whereClauses = [];
            if (showInactive !== 'true') {
                whereClauses.push('active = TRUE');
            }
            if (registrationDate) {
                queryParams.push(registrationDate);
                whereClauses.push(`DATE(created_at) = $${queryParams.length}`);
            }
            if (whereClauses.length > 0) {
                queryText += ' WHERE ' + whereClauses.join(' AND ');
            }
            queryText += ' ORDER BY created_at DESC';
            const { rows } = await pool.query(queryText, queryParams);
            res.json(rows);
        } catch (e) {
            next(e); // Передаем ошибку в глобальный обработчик
        }
    });

    // === Основные страницы админки ===
    // index.js, около строки 330
app.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
        const { period = '30', showInactive = 'false' } = req.query; // Достаем showInactive из запроса
        const lastMonths = await getLastMonths(6);
        const funnelCounts = await getFunnelData(new Date('2000-01-01').toISOString(), new Date().toISOString());
        
        res.render('dashboard', {
            title: 'Панель управления',
            page: 'dashboard',
            period,
            lastMonths,
            funnelData: funnelCounts,
            showInactive: showInactive === 'true', // Передаем showInactive в шаблон
            stats: { totalUsers: '...', totalDownloads: '...', free: '...', plus: '...', pro: '...', unlimited: '...' }
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
            next(e); // Передаем ошибку в глобальный обработчик
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
            next(e); // Передаем ошибку в глобальный обработчик
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
            next(e); // Передаем ошибку в глобальный обработчик
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
            next(e); // Передаем ошибку в глобальный обработчик
        }
    });
    
    app.post('/set-tariff', requireAuth, async (req, res, next) => {
        try {
            const { userId, limit, days } = req.body;
            await setPremium(userId, parseInt(limit), parseInt(days) || 30);
            res.redirect(req.get('referer') || '/dashboard');
        } catch (e) {
            next(e); // Передаем ошибку в глобальный обработчик
        }
    });

    // Глобальный обработчик ошибок. Должен быть в самом конце!
    app.use((err, req, res, next) => {
        console.error('🔴 Необработанная ошибка:', err);
        
        const statusCode = err.status || 500;
        const message = err.message || 'Внутренняя ошибка сервера';

        res.status(statusCode);
        
        // Отдаем JSON, если запрос был на API
        if (req.originalUrl.startsWith('/api/')) {
            return res.json({ error: message });
        }

        // Рендерим страницу ошибки для обычных запросов
        res.render('error', {
            title: `Ошибка ${statusCode}`,
            message: message,
            statusCode: statusCode,
            error: err,
            page: 'error',
            layout: 'layout' 
        });
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
        
        const escapeMarkdown = (text) => {
          if (typeof text !== 'string') return '';
          return text.replace(/[_*[```()~`>#+\-=|{}.!]/g, '\\$&');
        };

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