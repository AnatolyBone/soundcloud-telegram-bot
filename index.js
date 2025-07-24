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
}
    const requireAuth = (req, res, next) => {
        if (req.session.authenticated && req.session.userId === ADMIN_ID) {
            return next();
        }
        res.redirect('/admin');
    };

    // === МАРШРУТЫ EXPRESS (АДМИНКА) ===
    // Здесь полностью сохранен ваш код для админ-панели

    app.get('/health', (req, res) => res.send('OK'));
   app.get('/admin', (req, res) => {
    if (req.session.authenticated && req.session.userId === ADMIN_ID) {
        return res.redirect('/dashboard');
    }
    res.locals.page = 'admin';
    res.render('login', { title: 'Вход в админку', error: null });
});

app.post('/admin', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
        req.session.authenticated = true;
        req.session.userId = ADMIN_ID;
        res.redirect('/dashboard');
    } else {
        res.locals.page = 'admin';
        res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
    }
});
    app.get('/health', (req, res) => res.send('OK'));
app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        res.locals.page = 'dashboard';
        
        const showInactive = req.query.showInactive === 'true';
        const period = req.query.period || '30';
        const expiringLimit = parseInt(req.query.expiringLimit) || 10;
        const expiringOffset = parseInt(req.query.expiringOffset) || 0;
        
        const expiringSoon = await getExpiringUsersPaginated(expiringLimit, expiringOffset);
        const expiringCount = await getExpiringUsersCount();
        const users = await getAllUsers(showInactive);
        
        const downloadsByDateRaw = await getDownloadsByDate();
        const registrationsByDateRaw = await getRegistrationsByDate();
        const activeByDateRaw = await getActiveUsersByDate();
        
        const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
        const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
        const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);
        
        const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);
        
        const stats = {
            totalUsers: users.length,
            totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
            free: users.filter(u => u.premium_limit === 5).length,
            plus: users.filter(u => u.premium_limit === 25).length,
            pro: users.filter(u => u.premium_limit === 50).length,
            unlimited: users.filter(u => u.premium_limit >= 1000).length,
            registrationsByDate: filteredRegistrations,
            downloadsByDate: filteredDownloads,
            activeByDate: filteredActive
        };
        
        const activityByDayHour = await getUserActivityByDayHour();
        const activityByHour = computeActivityByHour(activityByDayHour);
        const activityByWeekday = computeActivityByWeekday(activityByDayHour);
        
        const referralStats = await getReferralSourcesStats();
        
        const { from: fromDate, to: toDate } = getFromToByPeriod(period);
        const funnelCounts = await getFunnelData(fromDate.toISOString(), toDate.toISOString());
        
        const chartDataFunnel = {
            labels: ['Зарегистрировались', 'Скачали', 'Оплатили'],
            datasets: [{
                label: 'Воронка пользователей',
                data: [
                    funnelCounts.registrationCount || 0,
                    funnelCounts.firstDownloadCount || 0,
                    funnelCounts.subscriptionCount || 0
                ],
                backgroundColor: ['#2196f3', '#4caf50', '#ff9800']
            }]
        };
        
        const chartDataHourActivity = {
            labels: [...Array(24).keys()].map(h => `${h}:00`),
            datasets: [{
                label: 'Активность по часам',
                data: activityByHour,
                backgroundColor: 'rgba(54, 162, 235, 0.7)',
            }]
        };
        
        const chartDataWeekdayActivity = {
            labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
            datasets: [{
                label: 'Активность по дням недели',
                data: activityByWeekday,
                backgroundColor: 'rgba(255, 206, 86, 0.7)',
            }]
        };
        
        const chartDataDownloads = {
            labels: chartDataCombined.labels,
            datasets: [chartDataCombined.datasets[1]] // Только "Загрузки"
        };
        
        const lastMonths = getLastMonths(6);
        const retentionResult = await pool.query(`
  WITH cohorts AS (
    SELECT
      id AS user_id,
      DATE(created_at) AS cohort_date
    FROM users
    WHERE created_at IS NOT NULL
  ),
  activities AS (
    SELECT DISTINCT
      user_id,
      DATE(downloaded_at) AS activity_day
    FROM downloads_log
  ),
  cohort_activity AS (
    SELECT
      c.cohort_date,
      a.activity_day,
      COUNT(DISTINCT c.user_id) AS active_users
    FROM cohorts c
    JOIN activities a ON c.user_id = a.user_id
    WHERE a.activity_day >= c.cohort_date
    GROUP BY c.cohort_date, a.activity_day
  ),
  cohort_sizes AS (
    SELECT
      cohort_date,
      COUNT(*) AS cohort_size
    FROM cohorts
    GROUP BY cohort_date
  ),
  retention AS (
    SELECT
      ca.cohort_date,
      (ca.activity_day - ca.cohort_date) AS days_since_signup,
      ca.active_users,
      cs.cohort_size,
      ROUND((ca.active_users::decimal / cs.cohort_size) * 100, 2) AS retention_percent
    FROM cohort_activity ca
    JOIN cohort_sizes cs ON ca.cohort_date = cs.cohort_date
    WHERE (ca.activity_day - ca.cohort_date) IN (0, 1, 3, 7, 14)
    ORDER BY ca.cohort_date, days_since_signup
  )
  SELECT * FROM retention;
`);
        const retentionRows = retentionResult.rows;
        
        const cohortsMap = {};
        retentionRows.forEach(row => {
            const date = row.cohort_date.toISOString().split('T')[0];
            if (!cohortsMap[date]) {
                cohortsMap[date] = { label: date, data: { 0: null, 1: null, 3: null, 7: null, 14: null } };
            }
            cohortsMap[date].data[row.days_since_signup] = row.retention_percent;
        });
        
        const chartDataRetention = {
            labels: ['Day 0', 'Day 1', 'Day 3', 'Day 7', 'Day 14'],
            datasets: Object.values(cohortsMap).map(cohort => ({
                label: cohort.label,
                data: [cohort.data[0], cohort.data[1], cohort.data[3], cohort.data[7], cohort.data[14]],
                fill: false,
                borderColor: `hsl(${Math.random() * 360}, 70%, 60%)`,
                tension: 0.1
            }))
        };
        res.render('dashboard', {
            title: 'Панель управления',
            stats,
            users,
            referralStats,
            expiringSoon,
            expiringCount,
            expiringOffset,
            expiringLimit,
            activityByHour,
            activityByWeekday,
            chartDataCombined,
            chartDataHourActivity,
            chartDataWeekdayActivity,
            showInactive,
            period,
            retentionData: [],
            funnelData: funnelCounts,
            chartDataFunnel,
            chartDataRetention,
            chartDataUserFunnel: {},
            chartDataDownloads,
            lastMonths,
            customStyles: '',
            customScripts: '',
            chartDataHeatmap: {}
        });
        
    } catch (e) {
        console.error('❌ Ошибка при загрузке dashboard:', e);
        res.status(500).send('Внутренняя ошибка сервера');
    }
});
    // Выход
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin');
    });
});

// Рассылка
app.get('/broadcast', requireAuth, (req, res) => {
    res.locals.page = 'broadcast';
    res.render('broadcast-form', { title: 'Рассылка', error: null });
});
    async function safeTelegramCall(method, ...args) {
  try {
    return await bot.telegram[method](...args);
  } catch (err) {
    const chatId = args?.[0];
    if (err?.response?.error_code === 403) {
      console.warn(`🚫 Пользователь ${chatId} заблокировал бота`);
      return null;
    }
    console.error(`❌ Ошибка при ${method} ${chatId}:`, err.message);
    return null;
  }
}
app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
  const { message } = req.body;
  const audio = req.file;

  if (!message && !audio) {
    res.locals.page = 'broadcast';
    return res.status(400).render('broadcast-form', { error: 'Текст или файл обязательны' });
  }

  const users = await getAllUsers();
  let success = 0, error = 0;
  let audioBuffer = null;

  if (audio) {
    try {
      audioBuffer = fs.readFileSync(audio.path);
    } catch (err) {
      console.error('❌ Ошибка чтения аудиофайла:', err);
      res.locals.page = 'broadcast';
      return res.status(500).render('broadcast-form', { error: 'Ошибка при чтении файла' });
    }
  }

  for (const u of users) {
    if (!u.active) continue;

    let sent = null;
    if (audioBuffer) {
      sent = await safeTelegramCall('sendAudio', u.id, {
        source: audioBuffer,
        filename: audio.originalname
      }, { caption: message || '' });
    } else {
      sent = await safeTelegramCall('sendMessage', u.id, message);
    }

    if (sent) {
      success++;
    } else {
      error++;
      try {
        await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [u.id]);
      } catch (err) {
        console.error('Ошибка обновления статуса пользователя:', err);
      }
    }

    await new Promise(r => setTimeout(r, 150)); // антиперебор
  }

// Удаляем файл после рассылки
if (audio) {
  try {
    // Удаляем файл с диска
    fs.unlink(audio.path, err => {
      if (err) console.error('Ошибка удаления аудио:', err);
      else console.log(`🗑 Удалён файл рассылки: ${audio.originalname}`);
    });
  } catch (err) {
    console.error('Ошибка при удалении файла:', err);
  }
}

  try {
    await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена\n✅ Успешно: ${success}\n❌ Ошибок: ${error}`);
  } catch (err) {
    console.error('Ошибка отправки уведомления админу:', err);
  }

  res.locals.page = 'broadcast';
  res.render('broadcast-form', {
    title: 'Рассылка',
    success,
    error,
    errorMessage: null,
  });
});
// Экспорт пользователей CSV
app.get('/export', requireAuth, async (req, res) => {
  try {
    res.locals.page = 'export';
    const allUsers = await getAllUsers(true);
    const period = req.query.period || 'all';
    
    const filteredUsers = allUsers.filter(user => {
      if (period === 'all') return true;
      if (period === '7' || period === '30') {
        const from = new Date(Date.now() - parseInt(period) * 86400000);
        return new Date(user.created_at) >= from;
      }
      if (period.startsWith('month:')) {
        const ym = period.split(':')[1]; // 'YYYY-MM'
        return user.created_at.startsWith(ym);
      }
      return true;
    });
    
    const fields = ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'created_at', 'last_active'];
    
    const csv = await json2csv(filteredUsers, {
      keys: fields,
      expandNestedObjects: true,
      wrap: '"',
      eol: '\n',
    });
    
    res.header('Content-Type', 'text/csv');
    res.attachment(`users_${period}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('Ошибка экспорта CSV:', e);
    res.status(500).send('Ошибка сервера');
  }
});
// Пользователи с истекающим тарифом
app.get('/expiring-users', requireAuth, async (req, res) => {
  res.locals.page = 'expiring-users';
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 10;

  try {
    const total = await getExpiringUsersCount();
    const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);
    const totalPages = Math.ceil(total / perPage);

    res.render('expiring-users', {
      title: 'Истекающие подписки',
      users,
      page,
      perPage,
      totalPages
    });
  } catch (e) {
    console.error('Ошибка загрузки expiring-users:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

app.post('/set-tariff', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { userId, limit } = req.body;
  if (!userId || !limit) return res.status(400).send('Отсутствуют параметры');

  let limitNum = parseInt(limit);
  if (![10, 50, 100, 1000].includes(limitNum)) {
    return res.status(400).send('Неизвестный тариф');
  }

  try {
    // Например, здесь всегда 30 дней — можно кастомизировать
    const bonusApplied = await setPremium(userId, limitNum, 30);

    // (Опционально) можно уведомить пользователя о подарке:
    const user = await getUserById(userId);
    if (user) {
      let msg = '✅ Подписка активирована на 30 дней.\n';
      if (bonusApplied) msg += '🎁 +30 дней в подарок! Акция 1+1 применена.';
      await bot.telegram.sendMessage(userId, msg);
    }

    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});
// === Telegraf бот ===
app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => {
  const userId = req.params.id;
  await updateUserField(userId, 'promo_1plus1_used', false);
  res.redirect('/dashboard');
});
// Команды бота
bot.start(async ctx => {
  const user = ctx.from;

  // Создание и обновление пользователя
  await createUser(user.id, user.first_name, user.username);
  await addOrUpdateUserInSupabase(user.id, user.first_name, user.username);

  // Логируем событие "регистрация"
  await logEvent(user.id, 'registered');

  const fullUser = await getUser(user.id);

  await ctx.reply(getPersonalMessage(fullUser));

  // ⏳ Добавляем задержку ~1.5 секунды
  await ctx.replyWithChatAction('typing');
  await new Promise(resolve => setTimeout(resolve, 2000));

  await ctx.reply(formatMenuMessage(fullUser), kb());
});

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
    
    bot.start(async ctx => {
  const user = ctx.from;
  
  // Создание и обновление пользователя
  await createUser(user.id, user.first_name, user.username);
  await addOrUpdateUserInSupabase(user.id, user.first_name, user.username);
  
  // Логируем событие "регистрация"
  await logEvent(user.id, 'registered');
  
  const fullUser = await getUser(user.id);
  
  await ctx.reply(getPersonalMessage(fullUser));
  
  // ⏳ Добавляем задержку ~1.5 секунды
  await ctx.replyWithChatAction('typing');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await ctx.reply(formatMenuMessage(fullUser), kb());
});

bot.hears(texts.menu, async ctx => {
  const user = await getUser(ctx.from.id);
  await ctx.reply(formatMenuMessage(user), kb());
  
  // Добавляем inline-кнопку, если бонус ещё не использован
  if (!user.subscribed_bonus_used) {
    await ctx.reply(
      'Нажми кнопку ниже, чтобы получить бонус после подписки:',
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ])
    );
  }
});

bot.hears(texts.help, async ctx => {
  await ctx.reply(texts.helpInfo, kb());
});

bot.hears(texts.upgrade, async ctx => {
  await ctx.reply(texts.upgradeInfo, kb());
});

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]+/g, '').trim();
}

bot.hears(texts.mytracks, async ctx => {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply('Ошибка получения данных пользователя.');
  
  let tracks = [];
  try {
    tracks = user.tracks_today ? JSON.parse(user.tracks_today) : [];
  } catch (e) {
    console.warn('Ошибка парсинга tracks_today:', e);
    return ctx.reply('❌ Ошибка чтения треков. Попробуй позже.');
  }
  
  if (!tracks.length) return ctx.reply('Сегодня ты ещё ничего не скачивал.');
  
  await ctx.reply(`Скачано сегодня ${tracks.length} из ${user.premium_limit || 10}`);
  
  for (let i = 0; i < tracks.length; i += 5) {
    const chunk = tracks.slice(i, i + 5);
    
    // Фильтруем треки с валидным fileId
    const mediaGroup = chunk
      .filter(t => t.fileId && typeof t.fileId === 'string' && t.fileId.trim().length > 0)
      .map(t => ({
        type: 'audio',
        media: t.fileId
      }));
    
    if (mediaGroup.length > 0) {
      try {
        await ctx.replyWithMediaGroup(mediaGroup);
      } catch (e) {
        console.error('Ошибка отправки аудио-пачки:', e);
        
        // Если не получилось, отправляем по одному треку без caption
        for (let t of chunk) {
          try {
            await ctx.replyWithAudio(t.fileId);
          } catch {
            // Если fileId не работает — отправляем локальный файл
            const filePath = path.join(cacheDir, `${sanitizeFilename(t.title)}.mp3`);
            if (fs.existsSync(filePath)) {
              const msg = await ctx.replyWithAudio({ source: fs.createReadStream(filePath) });
              const newFileId = msg.audio.file_id;
              
              // Обновляем fileId в базе
              await saveTrackForUser(ctx.from.id, t.title, newFileId);
              
              console.log(`Обновлен fileId для трека "${t.title}" у пользователя ${ctx.from.id}`);
            } else {
              console.warn(`Файл для трека "${t.title}" не найден на диске.`);
              await ctx.reply(`⚠️ Не удалось отправить трек "${t.title}". Файл не найден.`);
            }
          }
        }
      }
    } else {
      // Если ни одного валидного fileId нет — отправляем по одному локальным файлом
      for (let t of chunk) {
        const filePath = path.join(cacheDir, `${sanitizeFilename(t.title)}.mp3`);
        if (fs.existsSync(filePath)) {
          const msg = await ctx.replyWithAudio({ source: fs.createReadStream(filePath) });
          const newFileId = msg.audio.file_id;
          
          await saveTrackForUser(ctx.from.id, t.title, newFileId);
          
          console.log(`Обновлен fileId для трека "${t.title}" у пользователя ${ctx.from.id}`);
        } else {
          console.warn(`Файл для трека "${t.title}" не найден на диске.`);
          await ctx.reply(`⚠️ Не удалось отправить трек "${t.title}". Файл не найден.`);
        }
      }
    }
  }
});

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }
  
  try {
    const users = await getAllUsers();
    const totalUsers = users.length;
    const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
    
    const activeToday = users.filter(u => {
      if (!u.last_active) return false;
      const last = new Date(u.last_active);
      const now = new Date();
      return last.toDateString() === now.toDateString();
    }).length;
    
    await ctx.reply(
      `📊 Статистика бота:

👤 Пользователей: ${totalUsers}
📥 Всего загрузок: ${totalDownloads}
🟢 Активных сегодня: ${activeToday}

🤖 Бот работает.
🧭 Панель: https://soundcloud-telegram-bot.onrender.com/dashboard`
    );
  } catch (e) {
    console.error('Ошибка в /admin:', e);
    await ctx.reply('⚠️ Ошибка получения статистики');
  }
});
bot.action('check_subscription', async ctx => {
  const subscribed = await isSubscribed(ctx.from.id);
  if (subscribed) {
    const user = await getUser(ctx.from.id);
    if (user.subscribed_bonus_used) {
      await ctx.reply('Ты уже использовал бонус подписки.');
    } else {
      const until = Date.now() + 7 * 24 * 3600 * 1000;
      await setPremium(ctx.from.id, 50, 7);
      await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
      await ctx.reply('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
    }
  } else {
    await ctx.reply('Пожалуйста, подпишись на канал @BAZAproject и нажми кнопку ещё раз.');
  }
  await ctx.answerCbQuery();
});
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