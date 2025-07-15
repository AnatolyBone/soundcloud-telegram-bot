// ESM
import { Telegraf, Markup } from 'telegraf';
import compression from 'compression';
import express from 'express';
import session from 'express-session';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import ytdl from 'youtube-dl-exec';
import multer from 'multer';
import axios from 'axios';
import util from 'util';
import NodeID3 from 'node-id3';
import pgSessionFactory from 'connect-pg-simple';
import pkg from 'pg';
import * as json2csv from '@json2csv/node';
import { supabase } from './db.js'; // указывай расширение!
import expressLayouts from 'express-ejs-layouts';
import https from 'https';
import { getFunnelData } from './db.js';  // или путь к твоему модулю с функциями
import tariffTexts from './src/texts/tariff.js';

// Инициализация сессии для pg
const pgSession = pgSessionFactory(session);

const { Pool } = pkg;

const upload = multer({ dest: 'uploads/' });

const playlistTracker = new Map();

// Утилиты
const writeID3 = util.promisify(NodeID3.write);

async function resolveRedirect(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400
    });
    return response.request?.res?.responseUrl || url;
  } catch (err) {
    console.warn('Ошибка при разворачивании ссылки:', err.message);
    return url;
  }
}

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

if (!BOT_TOKEN || !ADMIN_ID || !process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.error('❌ Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}

if (isNaN(ADMIN_ID)) {
  console.error('❌ ADMIN_ID должен быть числом');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Кеш треков — для ESM используем import.meta.url
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

async function cleanCache() {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  
  try {
    const files = await fs.promises.readdir(cacheDir);
    
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
          console.log(`🗑 [cache-cleaner] Удалён файл: ${file}`);
        }
      } catch (err) {
        console.warn(`⚠️ [cache-cleaner] Ошибка при обработке файла ${file}:`, err);
      }
    }
  } catch (err) {
    console.error('⚠️ [cache-cleaner] Ошибка при чтении каталога кеша:', err);
  }
}

setInterval(cleanCache, 3600 * 1000);
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

async function logEvent(userId, event) {
  try {
    await supabase.from('events').insert([
      {
        user_id: userId,
        event,
        created_at: new Date().toISOString()
      }
    ]);
  } catch (error) {
    console.error('Ошибка при логировании события:', error);
  }
}

const texts = {
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached: `🚫 Лимит достигнут ❌

💡 Чтобы качать больше треков, выбери подходящий тариф:

🆓 Free — 5 🟢
💳 Plus — 20 🎯 (59₽)
💳 Pro — 50 💪 (119₽)
💎 Unlimited — безлимит (199₽)

👉 Донат: boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

🎁 Бонус: Получи 7 дней тарифа Plus за подписку:
👉 @bazaproject

📣 А чтобы не пропускать обновления и подарки:
👉 @SCM_BLOGOG`,
upgradeInfo: `🚀 Хочешь больше треков?
🆓 Free — 5 треков в день  
🎯 Plus — 20 треков (59₽)  
💪 Pro — 50 треков (119₽)  
💎 Unlimited — безлимит (199₽)  

🎁 Акция: 1+1 — оплачиваешь тариф, получаешь в 2 раза дольше!

👉 Донат: boosty.to/anatoly_bone/donate  
✉️ После оплаты напиши: @anatolybone  

🎁 Бонус: 7 дней тарифа Plus за подписку — @bazaproject  
📣 Новости, подарки и обновления — @SCM_BLOG`,
};

const kb = () =>
  Markup.keyboard([
    [texts.menu, texts.upgrade],
    [texts.mytracks, texts.help]
  ]).resize();

const isSubscribed = async userId => {
  try {
    const res = await bot.telegram.getChatMember('@BAZAproject', userId);
    return ['member', 'creator', 'administrator'].includes(res.status);
  } catch {
    return false;
  }
};

async function sendAudioSafe(ctx, userId, filePath, title) {
  try {
    const message = await ctx.telegram.sendAudio(userId, {
      source: fs.createReadStream(filePath),
      filename: `${title}.mp3`
    }, {
      title,
      performer: 'SoundCloud'
    });
    return message.audio.file_id;
  } catch (e) {
    console.error(`Ошибка отправки аудио пользователю ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, 'Произошла ошибка при отправке трека.');
    return null;
  }
}
async function processTrackByUrl(ctx, userId, url, playlistUrl = null) {
  const start = Date.now();
  let fp = null;
  
  try {
    url = await resolveRedirect(url);
    
    const info = await ytdl(url, { dumpSingleJson: true });
    
    let name = info.title || 'track';
    name = sanitizeFilename(name);
    if (name.length > 64) name = name.slice(0, 64);
    
    fp = path.join(cacheDir, `${name}.mp3`);
    
    if (!fs.existsSync(fp)) {
      await ytdl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: fp,
        preferFreeFormats: true,
        noCheckCertificates: true,
      });
      
      try {
        await writeID3({ title: name, artist: 'SoundCloud' }, fp);
        console.log(`🎵 ID3 теги записаны для ${name}`);
      } catch (err) {
        console.warn(`⚠️ Ошибка записи ID3 тегов для ${name}:`, err);
      }
    }
    
    await incrementDownloads(userId, name);
    
    const fileId = await sendAudioSafe(ctx, userId, fp, name);
    
    if (fileId) {
      await saveTrackForUser(userId, name, fileId);
      await pool.query(
        'INSERT INTO downloads_log (user_id, track_title) VALUES ($1, $2)',
        [userId, name]
      );
    } else {
      console.warn(`Не удалось получить fileId для трека ${name}`);
    }
    
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Трек ${name} загружен за ${duration} сек.`);
    
    if (playlistUrl) {
      const playlistKey = `${userId}:${playlistUrl}`;
      if (playlistTracker.has(playlistKey)) {
        let remaining = playlistTracker.get(playlistKey) - 1;
        if (remaining <= 0) {
          await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
          playlistTracker.delete(playlistKey);
        } else {
          playlistTracker.set(playlistKey, remaining);
        }
      }
    }
  } catch (e) {
    console.error(`Ошибка при загрузке ${url}:`, e);
    await ctx.telegram.sendMessage(userId, 'Произошла ошибка при загрузке трека.');
  } finally {
    // 🧹 Удаление файла безопасно и в самом конце
    if (fp) {
      fs.promises.unlink(fp).then(() => {
        console.log(`🗑 Удалён кеш: ${path.basename(fp)}`);
      }).catch(err => {
        if (err.code !== 'ENOENT') {
          console.warn(`⚠️ Ошибка удаления файла ${fp}:`, err);
        }
      });
    }
  }
}

// Управление глобальной очередью загрузок
const globalQueue = [];
let activeDownloadsCount = 0;
const MAX_CONCURRENT_DOWNLOADS = 3;

// Добавление задачи в очередь с сортировкой по приоритету
function addToGlobalQueue(task) {
  globalQueue.push(task);
  globalQueue.sort((a, b) => b.priority - a.priority);
}

// Обработка одного таска
async function processTask(task) {
  const { ctx, userId, url, playlistUrl } = task;
  try {
    await processTrackByUrl(ctx, userId, url, playlistUrl);
  } catch (e) {
    console.error(`Ошибка при загрузке трека ${url} для пользователя ${userId}:`, e);
    try {
      await ctx.telegram.sendMessage(userId, '❌ Ошибка при загрузке трека.');
    } catch {}
  }
}

// Основной цикл обработки очереди
async function processNextInQueue() {
  while (activeDownloadsCount < MAX_CONCURRENT_DOWNLOADS && globalQueue.length > 0) {
    const task = globalQueue.shift();
    activeDownloadsCount++;

    // Не await, чтобы не блокировать цикл
    processTask(task).finally(() => {
      activeDownloadsCount--;
      processNextInQueue();
    });
  }
}

// Функция добавления задач в очередь с проверками лимитов
async function enqueue(ctx, userId, url) {
  url = await resolveRedirect(url);

  try {
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);

    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;
    if (remainingLimit <= 0) {
      return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ]));
    }

    const info = await ytdl(url, { dumpSingleJson: true });
    const isPlaylist = Array.isArray(info.entries);
    let entries = [];

    if (isPlaylist) {
      entries = info.entries.filter(e => e && e.webpage_url).map(e => e.webpage_url);
      const playlistKey = `${user.id}:${url}`;
      playlistTracker.set(playlistKey, entries.length);

      if (entries.length > remainingLimit) {
        await ctx.telegram.sendMessage(userId,
          `⚠️ В плейлисте ${entries.length} треков, но тебе доступно только ${remainingLimit}. Будет загружено первые ${remainingLimit}.`);
        entries = entries.slice(0, remainingLimit);
      }
      await logEvent(userId, 'download_playlist');
    } else {
      entries = [url];
    }

    for (const entryUrl of entries) {
      addToGlobalQueue({
        ctx,
        userId,
        url: entryUrl,
        playlistUrl: isPlaylist ? url : null,
        priority: user.premium_limit
      });
      await logEvent(userId, 'download');
    }

    await ctx.telegram.sendMessage(userId, texts.queuePosition(
      globalQueue.filter(task => task.userId === userId).length
    ));

    processNextInQueue();

  } catch (e) {
    console.error('Ошибка в enqueue:', e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

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
  
  return `Привет, ${user.first_name}!

😎 Этот бот — не стартап и не команда разработчиков.  
Я делаю его сам, просто потому что хочется удобный и честный инструмент.  
Без рекламы, без сбора данных — всё по-простому.

Если пользуешься — круто. Рад, что зашло.  
Спасибо, что ты тут 🙌

💼 Текущий тариф: ${tariffName}

⚠️ Скоро немного снизим лимиты, чтобы бот продолжал работать стабильно.  
Проект держится на моих ресурсах, и иногда приходится идти на такие меры.

Надеюсь на понимание. 🙏`;
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
        res.locals.user = user;  // важно для ejs partials
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
function getFromToByPeriod(period) {
  const now = new Date();
  if (!isNaN(period)) {
    const days = parseInt(period);
    return {
      from: new Date(now.getTime() - days * 86400000),
      to: now
    };
  } else if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split('-').map(Number);
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);
    return { from, to };
  } else {
    throw new Error('Некорректный формат периода');
  }
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

  // Читаем файл один раз в память
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

  // Удаляем файл после загрузки в память
  if (audio) {
    fs.unlink(audio.path, err => {
      if (err) console.error('Ошибка удаления аудио:', err);
      else console.log(`🗑 Удалён файл рассылки: ${audio.originalname}`);
    });
  }

  // Отправляем администратору отчет
  try {
    await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена\n✅ Успешно: ${success}\n❌ Ошибок: ${error}`);
  } catch (err) {
    console.error('Ошибка отправки уведомления админу:', err);
  }

  // Отдаем страницу с результатом
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
    const parser = new Parser({ fields });
    const csv = parser.parse(filteredUsers);

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

bot.command('limit', ctx => {
  ctx.reply(tariffTexts.limitReached);
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
    await ctx.reply('Пожалуйста, подпишись на канал @BAZAproject и нажми кнопку ещё раз.');
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
    app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
    console.log('🤖 Бот запущен и ожидает обновлений...');
  } catch (e) {
    console.error('Ошибка при старте:', e);
    process.exit(1);
  }
})();
