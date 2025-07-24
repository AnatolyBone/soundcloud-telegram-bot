// index.js

// === Встроенные и сторонние библиотеки ===
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

// === Импорты модулей НАШЕГО приложения ===
import { pool, supabase, getFunnelData, createUser, getUser, updateUserField, setPremium, getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats, markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById, getExpiringUsersCount, getExpiringUsersPaginated } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';

// === Константы и конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL) {
    console.error('❌ Отсутствуют необходимые переменные окружения!');
    process.exit(1);
}

// === Глобальные экземпляры и утилиты ===
const bot = new Telegraf(BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let redisClient = null;

export function getRedisClient() {
    if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
    return redisClient;
}

export const texts = {
    start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...',
    error: '❌ Ошибка',
    noTracks: 'Сегодня нет треков.',
    limitReached: `🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.\n\n🎁 Бонус\n📣 Подпишись на наш новостной канал @SCM_BLOG и получи 7 дней тарифа Plus бесплатно!`,
    upgradeInfo: `🚀 Хочешь больше треков?\n\n🆓 Free — 5 🟢  \nPlus — 20 🎯 (59₽)  \nPro — 50 💪 (119₽)  \nUnlimited — 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate  \n✉️ После оплаты напиши: @anatolybone\n\n📣 Новости и фишки: @SCM_BLOG`,
    helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  \n🔓 Расширить — оплати и подтверди.  \n🎵 Мои треки — список за сегодня.  \n📋 Меню — тариф, лимиты, рефералы.  \n📣 Канал: @SCM_BLOG`,
    adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// =================================================================
// ===                    ОСНОВНАЯ ЛОГИКА                       ===
// =================================================================

async function startApp() {
    try {
        const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
        client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
        await client.connect();
        redisClient = client;
        console.log('✅ Redis подключён');

        const cacheDir = path.join(__dirname, 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        setupExpress();
        setupTelegramBot();
        
        setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
        setInterval(() => {
            console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`);
        }, 60000);

        if (process.env.NODE_ENV === 'production') {
            app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH, secret_token: SESSION_SECRET }));
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
    // === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ АДМИНКИ ===

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

    function getLastMonths(count = 6) {
        const months = [];
        const now = new Date();
        for (let i = 0; i < count; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ value: d.toISOString().slice(0, 7), label: d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }) });
        }
        return months;
    }

    function getFromToByPeriod(period) {
        const now = new Date();
        if (!period || period === 'all') return { from: new Date('2000-01-01'), to: now };
        if (/^\d+$/.test(period)) return { from: new Date(now.getTime() - parseInt(period) * 86400000), to: now };
        if (/^\d{4}-\d{2}$/.test(period)) {
            const [year, month] = period.split('-').map(Number);
            return { from: new Date(year, month - 1, 1), to: new Date(year, month, 0) };
        }
        throw new Error('Некорректный формат периода');
    }

    function computeActivityByHour(activityByDayHour) {
        const hours = Array(24).fill(0);
        for (const day in activityByDayHour) {
            const hoursData = activityByDayHour[day];
            for (let h = 0; h < 24; h++) {
                hours[h] += hoursData[h] || 0;
            }
        }
        return hours;
    }

    function computeActivityByWeekday(activityByDayHour) {
        const weekdays = Array(7).fill(0);
        for (const dayStr in activityByDayHour) {
            const dayTotal = Object.values(activityByDayHour[dayStr]).reduce((a, b) => a + b, 0);
            weekdays[new Date(dayStr).getDay()] += dayTotal;
        }
        return weekdays;
    }

    // === НАСТРОЙКА MIDDLEWARE ===
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
    
    // === МАРШРУТЫ EXPRESS ===
    app.get('/health', (req, res) => res.send('OK'));
    
    app.get('/admin', (req, res) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) return res.redirect('/dashboard');
        res.locals.page = 'admin';
        res.render('login', { title: 'Вход в админку', error: null });
    });

    app.post('/admin', (req, res) => {
        const { username, password } = req.body;
        if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
            req.session.authenticated = true;
            req.session.userId = ADMIN_ID;
            res.redirect('/dashboard');
        } else {
            res.locals.page = 'admin';
            res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
        }
    });

    app.get('/dashboard', requireAuth, async (req, res) => {
        try {
            res.locals.page = 'dashboard';
            const { showInactive = 'false', period = '30', expiringLimit = '10', expiringOffset = '0' } = req.query;
            const expiringSoon = await getExpiringUsersPaginated(parseInt(expiringLimit), parseInt(expiringOffset));
            const expiringCount = await getExpiringUsersCount();
            const users = await getAllUsers(showInactive === 'true');
            const downloadsByDateRaw = await getDownloadsByDate();
            const registrationsByDateRaw = await getRegistrationsByDate();
            const activeByDateRaw = await getActiveUsersByDate();
            const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
            const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
            const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);
            const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);
            const activityByDayHour = await getUserActivityByDayHour();
            const referralStats = await getReferralSourcesStats();
            const { from: fromDate, to: toDate } = getFromToByPeriod(period);
            const funnelCounts = await getFunnelData(fromDate.toISOString(), toDate.toISOString());

            res.render('dashboard', {
                title: 'Панель управления',
                stats: {
                    totalUsers: users.length,
                    totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
                    free: users.filter(u => u.premium_limit === 5).length,
                    plus: users.filter(u => u.premium_limit === 25).length,
                    pro: users.filter(u => u.premium_limit === 50).length,
                    unlimited: users.filter(u => u.premium_limit >= 1000).length,
                },
                users,
                referralStats,
                expiringSoon,
                expiringCount,
                expiringOffset: parseInt(expiringOffset),
                expiringLimit: parseInt(expiringLimit),
                activityByHour: computeActivityByHour(activityByDayHour),
                activityByWeekday: computeActivityByWeekday(activityByDayHour),
                chartDataCombined,
                funnelData: funnelCounts,
                lastMonths: getLastMonths(6),
                showInactive: showInactive === 'true',
                period,
            });
        } catch (e) {
            console.error('❌ Ошибка при загрузке dashboard:', e);
            res.status(500).send('Внутренняя ошибка сервера');
        }
    });

    app.get('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/admin'));
    });

    app.get('/broadcast', requireAuth, (req, res) => {
        res.locals.page = 'broadcast';
        res.render('broadcast-form', { title: 'Рассылка', error: null, success: null });
    });

    app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
        const { message } = req.body;
        const audio = req.file;
        if (!message && !audio) return res.status(400).render('broadcast-form', { error: 'Текст или файл обязательны' });

        const users = await getAllUsers();
        let success = 0, error = 0;
        for (const u of users) {
            if (!u.active) continue;
            try {
                if (audio) {
                    await bot.telegram.sendAudio(u.id, { source: audio.path }, { caption: message });
                } else {
                    await bot.telegram.sendMessage(u.id, message);
                }
                success++;
            } catch (e) {
                error++;
                if (e.response?.error_code === 403) await updateUserField(u.id, 'active', false);
            }
            await new Promise(r => setTimeout(r, 150));
        }
        if (audio) fs.unlinkSync(audio.path);
        await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена\n✅ Успешно: ${success}\n❌ Ошибок: ${error}`);
        res.render('broadcast-form', { title: 'Рассылка', success, error });
    });
    
    app.get('/export', requireAuth, async (req, res) => {
        const users = await getAllUsers(true);
        const { json2csv } = json2csv;
        const csv = await json2csv(users, {});
        res.header('Content-Type', 'text/csv');
        res.attachment('users.csv');
        return res.send(csv);
    });

    app.get('/expiring-users', requireAuth, async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const perPage = 10;
        const total = await getExpiringUsersCount();
        const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);
        res.render('expiring-users', { users, page, totalPages: Math.ceil(total / perPage), title: 'Истекающие подписки' });
    });
    
    app.post('/set-tariff', requireAuth, async (req, res) => {
        const { userId, limit, days } = req.body;
        await setPremium(userId, parseInt(limit), parseInt(days));
        res.redirect('/dashboard');
    });
    
    app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => {
        await updateUserField(req.params.id, 'promo_1plus1_used', false);
        res.redirect('/dashboard');
    });
}

function setupTelegramBot() {
    // === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ БОТА ===
    const isSubscribed = async (userId) => {
        try {
            const res = await bot.telegram.getChatMember('@SCM_BLOG', userId);
            return ['member', 'creator', 'administrator'].includes(res.status);
        } catch { return false; }
    };

    // === ФРАГМЕНТ ФАЙЛА index.js ДЛЯ ЗАМЕНЫ ===

// Вспомогательные функции
const extractUrl = (text = '') => {
    const regex = /(https?:\/\/[^\s]+)/g;
    const matches = text.match(regex);
    return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

function getTariffName(limit) {
    if (limit >= 1000) return 'Unlim (∞/день)';
    if (limit >= 100) return 'Pro (100/день)';
    if (limit >= 50) return 'Plus (50/день)';
    return 'Free (10/день)';
}

function getDaysLeft(premiumUntil) {
    if (!premiumUntil) return 0;
    const diff = new Date(premiumUntil) - new Date();
    return Math.max(Math.ceil(diff / 86400000), 0);
}

// ИСПРАВЛЕНИЕ №1: Функция теперь принимает 'ctx'
function formatMenuMessage(user, ctx) {
    const tariffLabel = getTariffName(user.premium_limit);
    const downloadsToday = user.downloads_today || 0;
    const invited = user.invited_count || 0;
    const bonusDays = user.bonus_days || 0;
    // Теперь эта строка будет работать, т.к. 'ctx' доступен
    const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
    const daysLeft = getDaysLeft(user.premium_until);
    
    return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3.  
Просто пришли ссылку — и всё 🧙‍♂️

📣 Хочешь быть в курсе новостей, фишек и бонусов?
Подпишись на наш канал 👉 @SCM_BLOG

🎁 Бонус: 7 дней тарифа PLUS бесплатно
(только для новых пользователей)

🔄 При отправке ссылки ты увидишь свою позицию в очереди.  
🎯 Платные тарифы идут с приоритетом — их треки загружаются первыми.  
📥 Бесплатные пользователи тоже получают треки — просто чуть позже.

💼 Тариф: ${tariffLabel}  
⏳ Осталось дней: ${daysLeft}

🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

👫 Приглашено: ${invited}  
🎁 Получено дней Plus по рефералам: ${bonusDays}

🔗 Твоя реферальная ссылка:  
${refLink}
        `.trim();
}

// === MIDDLEWARE БОТА ===
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
        let user = await getUser(userId, ctx.from.first_name, ctx.from.username);
        ctx.state.user = user;
    } catch (error) { console.error(`Ошибка в мидлваре для userId ${userId}:`, error); }
    return next();
});

// === ОБРАБОТЧИКИ КОМАНД БОТА ===
bot.start(async (ctx) => {
    await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username, ctx.startPayload || null);
    const fullUser = await getUser(ctx.from.id);
    // ИСПРАВЛЕНИЕ №2: Передаем 'ctx' в функцию
    await ctx.reply(formatMenuMessage(fullUser, ctx), kb());
});

bot.hears(texts.menu, async (ctx) => {
    const user = await getUser(ctx.from.id);
    // ИСПРАВЛЕНИЕ №3: Передаем 'ctx' в функцию
    await ctx.reply(formatMenuMessage(user, ctx), kb());
});

bot.hears(texts.mytracks, async (ctx) => {
    const user = await getUser(ctx.from.id);
    let tracks = [];
    try { if (user.tracks_today) tracks = JSON.parse(user.tracks_today); } catch {}
    if (!tracks.length) return ctx.reply(texts.noTracks);
    for (let i = 0; i < tracks.length; i += 5) {
        const chunk = tracks.slice(i, i + 5).filter(t => t.fileId);
        if (chunk.length > 0) {
            try {
                await ctx.replyWithMediaGroup(chunk.map(t => ({ type: 'audio', media: t.fileId })));
            } catch (e) { console.error('Ошибка отправки MediaGroup:', e); }
        }
    }
});

bot.hears(texts.help, async (ctx) => { await ctx.reply(texts.helpInfo, kb()); });
bot.hears(texts.upgrade, async (ctx) => { await ctx.reply(texts.upgradeInfo, kb()); });

// СТАЛО (правильно и полно):
bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return; // Молча выходим, если это не админ
    }

    try {
        const users = await getAllUsers(true); // Получаем всех, включая неактивных
        const totalUsers = users.length;
        const activeUsers = users.filter(u => u.active).length;
        
        const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
        
        // Активные сегодня (те, у кого last_active сегодня)
        const now = new Date();
        const activeToday = users.filter(u => {
            if (!u.last_active) return false;
            const lastActiveDate = new Date(u.last_active);
            return lastActiveDate.toDateString() === now.toDateString();
        }).length;

        const statsMessage = `
📊 **Статистика Бота**

👤 **Пользователи:**
   - Всего: *${totalUsers}*
   - Активных (в целом): *${activeUsers}*
   - Активных сегодня: *${activeToday}*

📥 **Загрузки:**
   - Всего за все время: *${totalDownloads}*

⚙️ **Очередь сейчас:**
   - В работе: *${downloadQueue.active}*
   - В ожидании: *${downloadQueue.size}*

🔗 **Админ-панель:**
[Открыть дашборд](${WEBHOOK_URL.replace(/\/$/, '')}/dashboard)
        `.trim();

        await ctx.replyWithMarkdown(statsMessage);

    } catch (e) {
        console.error('❌ Ошибка в команде /admin:', e);
        await ctx.reply('⚠️ Произошла ошибка при получении статистики. Подробности в логах сервера.');
    }
});

bot.action('check_subscription', async (ctx) => {
    if (await isSubscribed(ctx.from.id)) {
        await setPremium(ctx.from.id, 50, 7);
        await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
        await ctx.reply('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
    } else {
        await ctx.reply('Пожалуйста, подпишись на канал @SCM_BLOG и нажми кнопку ещё раз.');
    }
    await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
    const url = extractUrl(ctx.message.text);
    if (url) {
        await enqueue(ctx, ctx.from.id, url);
    } else {
        const knownCommands = [texts.menu, texts.mytracks, texts.help, texts.upgrade];
        if (!knownCommands.includes(ctx.message.text)) {
            await ctx.reply('Пожалуйста, пришлите ссылку на трек или плейлист.');
        }
    }
});
}

// === ЗАПУСК ПРИЛОЖЕНИЯ ===
startApp();
// Стало (более надежный вариант):
const stopBot = (signal) => {
    console.log(`Получен сигнал ${signal}. Завершение работы...`);
    // Проверяем, есть ли у bot.context.botInfo, что косвенно говорит о том, что бот был запущен
    if (bot.context.botInfo) {
        bot.stop(signal);
        console.log('Бот остановлен.');
    } else {
        console.log('Бот не был запущен, просто выходим.');
    }
    process.exit(0);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));