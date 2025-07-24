// === Встроенные и сторонние библиотеки ===
import express from 'express';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import util from 'util';
import multer from 'multer';
import ejs from 'ejs';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import ytdl from 'youtube-dl-exec';
import NodeID3 from 'node-id3';
import { createClient } from 'redis';
import pgSessionFactory from 'connect-pg-simple';
import json2csv from 'json-2-csv';

// === Импорты собственного проекта ===
import { pool, supabase, getFunnelData } from './db.js'; // объединённый импорт из одного файла
import {
  createUser,
  getUser,
  logUserActivity,
  resetDailyStats,
  resetDailyLimitIfNeeded,
  // ... другие DB-функции
} from './db.js';

import { enqueue } from './services/downloadManager.js'; // наш метод загрузки
// === Константы и конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
// ... другие константы

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ESM-совместимый __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  createUser, getUser, updateUserField, incrementDownloads, setPremium,
  getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview,
  getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate,
  getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats,
  markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById,
  getExpiringUsersCount, getExpiringUsersPaginated
} from './db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
// Настройка Redis
// Инициализация Redis в отдельном блоке
// Инициализация Redis в отдельном блоке
(async () => {
  try {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.error('❌ Переменная окружения REDIS_URL не найдена!');
      process.exit(1);
    }
    
    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 10000,
        retryStrategy: (times) => {
          if (times > 5) return null;
          return Math.min(times * 1000, 3000);
        }
      }
    });
    
    client.on('error', (err) => {
      console.error('Ошибка подключения к Redis:', err);
    });
    
    await client.connect();
    console.log('✅ Redis подключён');
    
    global.redisClient = client;
    
    setInterval(async () => {
      try {
        await global.redisClient.ping();
        console.log('🔍 Redis доступен');
      } catch (err) {
        console.warn('⚠️ Потеряно соединение с Redis:', err);
      }
    }, 60000);
    
  } catch (err) {
    console.error('Ошибка инициализации Redis:', err);
    process.exit(1);
  }
})();
// Теперь используем глобальный клиент Redis
async function getTrackInfo(url) {
  try {
    const cached = await global.redisClient.get(url);
    if (cached) return JSON.parse(cached);
    
    const info = await ytdl(url, { dumpSingleJson: true });
    await global.redisClient.setEx(url, 3600, JSON.stringify(info));
    return info;
  } catch (err) {
    console.error('Ошибка работы с Redis:', err);
    throw err;
  }
}
// === Глобальные переменные и утилиты ===
let redisClient = null;

// Функция-геттер для доступа к Redis из других модулей
export function getRedisClient() {
  if (!redisClient) {
    throw new Error('Redis клиент ещё не инициализирован');
  }
  return redisClient;
}

async function resolveRedirect(url) {
  try {
    const response = await axios.head(url, { maxRedirects: 5 });
    return response.request?.res?.responseUrl || url;
  } catch (err) {
    console.warn('Ошибка при разворачивании ссылки:', err.message);
    return url;
  }
}

// === Тексты и клавиатуры (лучше вынести в отдельный файл constants.js) ===
export const texts = {
  start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  limitReached: `🚫 Лимит достигнут ❌...`, // ваш текст
  // ... другие тексты
};

const kb = () => Markup.keyboard([[texts.menu, texts.upgrade], [texts.mytracks, texts.help]]).resize();

// === Инициализация ===
(async () => {
  // 1. Инициализация Redis
  try {
    const client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 10000 } });
    client.on('error', (err) => console.error('Ошибка Redis:', err));
    await client.connect();
    redisClient = client;
    console.log('✅ Redis подключён');
  } catch (err) {
    console.error('❌ Критическая ошибка инициализации Redis:', err);
    process.exit(1);
  }

  // 2. Создание папки для кэша
  const cacheDir = path.join(__dirname, 'cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

  // 3. Запуск периодических задач
  setInterval(async () => {
    try {
      const files = await fs.promises.readdir(cacheDir);
      const cutoff = Date.now() - 7 * 86400 * 1000;
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs < cutoff) await fs.promises.unlink(filePath);
      }
    } catch (err) { console.error('⚠️ Ошибка очистки кэша:', err); }
  }, 3600 * 1000);

  setInterval(resetDailyStats, 24 * 3600 * 1000);

})();

// === Мидлвары бота ===
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    let user = await getUser(userId);
    if (!user) {
      user = await createUser(userId, ctx.from.username, ctx.from.first_name);
      await ctx.reply(texts.start, kb());
    }
    ctx.state.user = user;
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);
  } catch (error) {
    console.error(`Ошибка в мидлваре для userId ${userId}:`, error);
  }
  return next();
});


// === Обработчики команд и сообщений ===

bot.start(ctx => ctx.reply(texts.start, kb()));

// ГЛАВНЫЙ ОБРАБОТЧИК ССЫЛОК
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  const userId = ctx.from.id;

  // Простая валидация ссылки
  if (url.startsWith('http')) {
    // Вся сложная логика теперь в одной функции!
    await enqueue(ctx, userId, url);
  } else {
    // Обработка других текстовых команд (меню и т.д.)
    switch (url) {
        case texts.menu:
            // ваша логика для меню
            await ctx.reply('Ваш профиль...');
            break;
        case texts.upgrade:
            // ваша логика
            await ctx.reply('Информация о тарифах...');
            break;
        // ... другие команды
        default:
            await ctx.reply('Пожалуйста, пришлите валидную ссылку на трек или плейлист.');
    }
  }
});


// ... здесь остается ваша логика для /admin, колбэков, express-сервера и т.д.
// Она не меняется, так как мы вынесли только логику загрузки.


// === Запуск ===
// Убедитесь, что эта часть кода соответствует вашему способу деплоя (webhook или polling)
app.use(bot.webhookCallback(WEBHOOK_PATH));
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  bot.telegram.setWebhook(WEBHOOK_URL);
});
// Рассылка сообщений ботом
async function broadcastMessage(bot, pool, message) {
  const users = await getAllUsers();
  let successCount = 0;
  let errorCount = 0;

  for (const user of users) {
    if (!user.active) continue;
    try {
      await bot.telegram.sendMessage(user.id, message);
      successCount++;
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.log(`Ошибка при отправке пользователю ${user.id}:`, e.description || e.message);
      errorCount++;
      try {
        await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [user.id]);
      } catch (err) {
        console.error('Ошибка при обновлении статуса пользователя:', err);
      }
    }
  }

  return { successCount, errorCount };
}

// Добавление или обновление пользователя в Supabase
async function addOrUpdateUserInSupabase(id, first_name, username, referralSource) {
  if (!id) return;
  if (!supabase) {
    console.error('Supabase клиент не инициализирован');
    return;
  }
  try {
    const { error } = await supabase
      .from('users')
      .upsert([{ id, first_name, username, referred_by: referralSource || null }]);
    if (error) {
      console.error('Ошибка upsert в Supabase:', error);
    }
  } catch (e) {
    console.error('Ошибка Supabase:', e);
  }
}

function getPersonalMessage(user) {
  const tariffName = getTariffName(user.premium_limit);
  
  return `
😎 Привет!
Этот бот — не стартап и не команда разработчиков.
Я делаю его один — чтобы был простой, честный и удобный инструмент.
Без рекламы, без слежки, без наворотов — всё по-человечески.

💼 Твой тариф: ${tariffName}

⚠️ В ближайшее время лимиты немного сократим, чтобы бот продолжал работать стабильно.
Проект держится на моих личных ресурсах — иногда приходится идти на такие шаги.
Спасибо за понимание 🙏

🎁 Сейчас идёт акция 1+1 на все тарифы — оплачиваешь месяц, получаешь два.
Действует до 20 июля. Подробности: @SCM_BLOG`;
}
function getTariffName(limit) {
  if (limit >= 1000) return 'Unlim (∞/день)';
  if (limit >= 100) return 'Pro (100/день)';
  if (limit >= 50) return 'Plus (50/день)';
  return 'Free (10/день)';
}
function getReferralLink(userId) {
  return `https://t.me/SCloudMusicBot?start=${userId}`;
}
function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const now = new Date();
  const until = new Date(premiumUntil);
  const diff = until - now;
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 0);
}
// Формат меню пользователя
function formatMenuMessage(user) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const invited = user.invited_count || 0;
  const bonusDays = user.bonus_days || 0;
  const refLink = getReferralLink(user.id);
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
// Вспомогательная функция извлечения ссылки SoundCloud из текста
function extractUrl(text) {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  if (!matches) return null;
  return matches.find(url => url.includes('soundcloud.com')) || matches[0];
}
// // === Настройка Express ===
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.page = null;        // по умолчанию пусто
  res.locals.title = 'Админка';
  next();
});

app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(expressLayouts); // Используем layout
app.set('view engine', 'ejs'); // Указываем движок шаблонов
app.set('views', path.join(__dirname, 'views')); // Папка с шаблонами
app.set('layout', 'layout');
const pgSession = pgSessionFactory(session);

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use(async (req, res, next) => {
  if (req.session.authenticated && req.session.userId === ADMIN_ID) {
    try {
      const user = await getUserById(req.session.userId);
      if (user) {
        req.user = user;
        res.locals.user = user;  // важно для ejs import { Parser } from '@json2csv/node';tials
      } else {
        res.locals.user = null;
      }
    } catch (e) {
      console.error('Ошибка загрузки пользователя для шаблонов:', e);
      res.locals.user = null;
    }
  } else {
    res.locals.user = null;
  }
  next();
});
// Middleware авторизации админки
async function requireAuth(req, res, next) {
  if (req.session.authenticated && req.session.userId === ADMIN_ID) {
    return next();
  }
  res.redirect('/admin');
}
// activityByDayHour — объект вида { "2025-07-01": {0: 5, 1: 3, ...}, "2025-07-02": {...} }
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
  const weekdays = Array(7).fill(0); // Воскресенье = 0, понедельник = 1 и т.д.
  for (const dayStr in activityByDayHour) {
    const date = new Date(dayStr);
    const weekday = date.getDay();
    const hoursData = activityByDayHour[dayStr];
    const dayTotal = Object.values(hoursData).reduce((a,b) => a+b, 0);
    weekdays[weekday] += dayTotal;
  }
  return weekdays;
}
// === Маршруты Express ===

// Вход в админку
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
// ===== Утилиты для фильтрации статистики =====

// Конвертация объекта {date: count, ...} в массив [{date, count}, ...]
function convertObjToArray(dataObj) {
  if (!dataObj) return [];
  return Object.entries(dataObj).map(([date, count]) => ({ date, count }));
}

// Фильтрация массива статистики по периоду (число дней или 'YYYY-MM')
function filterStatsByPeriod(data, period) {
  if (!Array.isArray(data)) return [];

  const now = new Date();

  // Если period — число дней
  if (!isNaN(period)) {
    const days = parseInt(period);
    const cutoff = new Date(now.getTime() - days * 86400000);
    return data.filter(item => new Date(item.date) >= cutoff);
  }

  // Если period — формат 'YYYY-MM'
  if (/^\d{4}-\d{2}$/.test(period)) {
    return data.filter(item => item.date && item.date.startsWith(period));
  }

  // Иначе возвращаем все данные
  return data;
}

// Подготовка данных для графиков Chart.js из трёх массивов с датами и значениями
function prepareChartData(registrations, downloads, active) {
  const dateSet = new Set([
    ...registrations.map(r => r.date),
    ...downloads.map(d => d.date),
    ...active.map(a => a.date)
  ]);
  const dates = Array.from(dateSet).sort();

  const regMap = new Map(registrations.map(r => [r.date, r.count]));
  const dlMap = new Map(downloads.map(d => [d.date, d.count]));
  const actMap = new Map(active.map(a => [a.date, a.count]));

  return {
    labels: dates,
    datasets: [
      {
        label: 'Регистрации',
        data: dates.map(d => regMap.get(d) || 0),
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        fill: false,
      },
      {
        label: 'Загрузки',
        data: dates.map(d => dlMap.get(d) || 0),
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
        fill: false,
      },
      {
        label: 'Активные пользователи',
        data: dates.map(d => actMap.get(d) || 0),
        borderColor: 'rgba(54, 162, 235, 1)',
        backgroundColor: 'rgba(54, 162, 235, 0.2)',
        fill: false,
      }
    ]
  };
}

// Получение последних N месяцев в виде [{value: 'YYYY-MM', label: 'Месяц Год'}, ...]
function getLastMonths(count = 6) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = d.toISOString().slice(0, 7); // 'YYYY-MM'
    const label = d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    months.push({ value, label });
  }
  return months;
}

// Получение диапазона дат по периоду (число дней или 'YYYY-MM')
// Получение диапазона дат по периоду (число дней или 'YYYY-MM')
function getFromToByPeriod(period) {
  const now = new Date();
  
  if (!period) {
    console.warn('[getFromToByPeriod] Период не указан. Используется "all"');
    return { from: new Date('2000-01-01'), to: now };
  }
  
  if (period === 'all') {
    return { from: new Date('2000-01-01'), to: now };
  }
  
  if (/^\d+$/.test(period)) {
    const days = parseInt(period, 10);
    if (days <= 0 || days > 3650) {
      throw new Error(`Неверное количество дней: ${days}`);
    }
    return {
      from: new Date(now.getTime() - days * 86400000),
      to: now
    };
  }
  
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split('-').map(Number);
    if (year < 2000 || month < 1 || month > 12) {
      throw new Error(`Неверный формат месяца: ${period}`);
    }
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);
    return { from, to };
  }
  
  console.error('[getFromToByPeriod] Некорректный формат:', period);
  throw new Error('Некорректный формат периода. Используй "all", число дней или YYYY-MM');
}
// Дашборд
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
      chartDataHeatmap: {},
      taskLogs: []
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
// ✅ Универсальный безопасный вызов Telegram API
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
    await ctx.reply('Пожалуйста, подпишись на канал @SCM_BLOG и нажми кнопку ещё раз.');
  }
  await ctx.answerCbQuery();
});
bot.on('text', async ctx => {
  const url = extractUrl(ctx.message.text);
  if (!url) {
    await ctx.reply('Пожалуйста, отправь ссылку на трек или плейлист SoundCloud.');
    return;
  }

  try {
    await ctx.reply('🔄 Загружаю трек... Это может занять пару минут.');
  } catch (e) {
    console.error('Ошибка при отправке сообщения:', e);
  }

  enqueue(ctx, ctx.from.id, url).catch(async e => {
    console.error('Ошибка в enqueue:', e);
    try {
      await bot.telegram.sendMessage(ctx.chat.id, '❌ Ошибка при обработке ссылки.');
    } catch {}
  });
});
// Telegram webhook
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('Ошибка handleUpdate:', err));
});

// Запуск сервера и webhook бота
(async () => {
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);
    
    app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на порту ${PORT}`);
      console.log('🤖 Бот запущен и ожидает обновлений...');
      
      // Мониторинг очереди
      setInterval(() => {
        console.log(`⏳ Очередь: ${globalQueue.length} задач`);
      }, 30000);
    });
    
  } catch (e) {
    console.error('Ошибка при старте:', e);
    process.exit(1);
  }
})();