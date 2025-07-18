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
import { pool } from './db.js';
import { json2csv } from 'json-2-csv';
import { supabase } from './db.js'; // указывай расширение!
import expressLayouts from 'express-ejs-layouts';
import https from 'https';
import { getFunnelData } from './db.js';  // или путь к твоему модулю с функциями
import Redis from 'ioredis';

// Получаем топ 2 трека по количеству загрузок
async function getTopStatistics() {
  const result = await pool.query(`
    SELECT track_title as name, COUNT(*) as count
    FROM downloads_log
    WHERE downloaded_at >= CURRENT_DATE
    GROUP BY track_title
    ORDER BY count DESC
    LIMIT 2
  `);
  return { topTracks: result.rows };
}

// Системные метрики — память, нагрузка, uptime
async function getSystemMetrics() {
  return {
    memoryUsage: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),  // в MB
    cpuLoad: (process.cpuUsage().user / 1000000).toFixed(2),            // примерное значение в процентах
    uptime: Math.floor(process.uptime()),                              // в секундах
  };
}
const metrics = {
  track: (event, data) => {
    console.log(`METRICS track: ${event}`, data);
  },
  increment: (event) => {
    console.log(`METRICS increment: ${event}`);
  }
};
const DASHBOARD_URL = 'https://soundcloud-telegram-bot.onrender.com/admin';

const redis = new Redis(process.env.REDIS_URL); 

const upload = multer({ dest: 'uploads/' });

const playlistTracker = new Map();

// Утилиты
const writeID3 = util.promisify(NodeID3.write);
async function getCachedAdmins() {
  return [2018254756];
}

async function sendEmergencyAlert(message) {
  console.warn('EMERGENCY ALERT:', message);
}
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

async function setAdminCommandCooldown(userId) {
  const cooldownKey = `admin_command_cooldown:${userId}`;
  const ttlSeconds = 60; // 1 минута

  const exists = await redis.exists(cooldownKey);
  if (exists) {
    throw new Error('Команда в ожидании. Подождите перед следующим вызовом.');
  }
  await redis.set(cooldownKey, '1', 'EX', ttlSeconds);
}
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

💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.

🆓 Free — 5 🟢
🎯 Plus — 20 (59₽)
💪 Pro — 50 (119₽)
💎 Unlimited — безлимит (199₽)

👉 Донат: boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

📣 Подпишись на канал с новостями:
@SCM_BLOG

🎁 Бонус: подпишись на @bazaproject и получи 7 дней тарифа Plus бесплатно!`,
  upgradeInfo: `🚀 Хочешь больше треков?

🆓 Free — 5 🟢  
Plus — 20 🎯 (59₽)  
Pro — 50 💪 (119₽)  
Unlimited — 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate  
✉️ После оплаты напиши: @anatolybone

📣 Новости и фишки: @SCM_BLOG`,
  helpInfo: `ℹ️ Просто пришли ссылку и получишь mp3.  
🔓 Расширить — оплати и подтверди.  
🎵 Мои треки — список за сегодня.  
📋 Меню — тариф, лимиты, рефералы.  
📣 Канал: @SCM_BLOG`,
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
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
    const message = await ctx.telegram.sendAudio(
      userId,
      {
        source: fs.createReadStream(filePath),
        filename: `${title}.mp3`
      },
      {
        title,
        performer: 'SoundCloud'
      }
    );
    return message.audio.file_id;
  } catch (e) {
    console.error(`❌ Ошибка отправки аудио пользователю ${userId}:`, e);

    if (e.description === 'Forbidden: bot was blocked by the user') {
      console.warn(`🚫 Пользователь ${userId} заблокировал бота. Помечаем как inactive.`);
      await pool.query('UPDATE users SET active = false WHERE telegram_id = $1', [userId]);
    } else {
      try {
        await ctx.telegram.sendMessage(userId, 'Произошла ошибка при отправке трека.');
      } catch (innerErr) {
        console.error(`Не удалось отправить сообщение об ошибке пользователю ${userId}:`, innerErr);
      }
    }

    return null;
  }
}
async function processTrackByUrl(ctx, userId, url, playlistUrl = null) {
  const start = Date.now();
  let fp = null;
  
  try {
    // Разрешаем редиректы
    try {
      url = await resolveRedirect(url);
    } catch (e) {
      throw new Error(`Ошибка разрешения URL: ${e.message}`);
    }
    
    // Гарантируем наличие кеш-директории
    if (!fs.existsSync(cacheDir)) {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      console.log(`Создана директория кеша: ${cacheDir}`);
    }
    
    const info = await ytdl(url, { dumpSingleJson: true });
    
    let name = info.title || 'track';
    name = sanitizeFilename(name);
    if (name.length > 255) name = name.slice(0, 255);
    
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
    await ctx.telegram.sendMessage(userId, '❌ Ошибка при загрузке трека.');
  } finally {
    if (fp && fs.existsSync(fp)) {
      try {
        await fs.promises.unlink(fp);
        console.log(`🗑 Удалён файл кэша: ${path.basename(fp)}`);
      } catch (err) {
        console.warn(`⚠️ Не удалось удалить файл ${path.basename(fp)}:`, err);
      }
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
  try {
    // 1. Разрешаем редирект, получаем окончательный URL
    url = await resolveRedirect(url);
    if (!url) throw new Error('Неверный URL после редиректа');
    
    // 2. Логируем активность пользователя, сбрасываем лимит, если нужно
    await logUserActivity(userId);
    await resetDailyLimitIfNeeded(userId);
    
    // 3. Получаем пользователя из базы
    const user = await getUser(userId);
    if (!user) {
      await ctx.telegram.sendMessage(userId, '❌ Пользователь не найден.');
      return;
    }
    
    // 4. Проверяем подписку
    const now = new Date();
    if (!user.premium_until || new Date(user.premium_until) < now) {
      await ctx.telegram.sendMessage(userId, '🔒 Ваша подписка истекла.');
      return;
    }
    
    // 5. Проверяем лимит загрузок на сегодня
    const remainingLimit = user.premium_limit - user.downloads_today;
    if (remainingLimit <= 0) {
      await ctx.telegram.sendMessage(userId, '🔒 Вы достигли лимита загрузок на сегодня.',
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Я подписался', 'check_subscription')
        ])
      );
      return;
    }
    
    // 6. Получаем информацию о треке или плейлисте
    const info = await ytdl(url, { dumpSingleJson: true });
    const isPlaylist = Array.isArray(info.entries);
    let entries = [];
    
    if (isPlaylist) {
      entries = info.entries.filter(e => e && e.webpage_url).map(e => e.webpage_url);
      
      if (entries.length > 200) {
        await ctx.telegram.sendMessage(userId, `⚠️ Плейлист слишком большой (${entries.length} треков).`);
        return;
      }
      
      if (entries.length > remainingLimit) {
        await ctx.telegram.sendMessage(userId,
          `⚠️ В плейлисте ${entries.length} треков, но вам доступно только ${remainingLimit}. Будет загружено первые ${remainingLimit}.`);
        entries = entries.slice(0, remainingLimit);
      }
      
      await ctx.telegram.sendMessage(userId, `📥 Загружаю плейлист из ${entries.length} треков...`);
      await logEvent(userId, 'download_playlist');
    } else {
      entries = [url];
      await ctx.telegram.sendMessage(userId, '🔄 Загружаю трек... Это может занять пару минут.');
    }
    
    // 7. Добавляем задачи в очередь
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
    
    // 8. Уведомляем о позиции в очереди
    await ctx.telegram.sendMessage(userId, texts.queuePosition(
      globalQueue.filter(task => task.userId === userId).length
    ));
    
    // 9. Запускаем очередь
    processNextInQueue();
    
  } catch (e) {
    console.error('Ошибка в enqueue:', e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}
// Рассылка сообщений ботом
async function broadcastMessage(bot, pool, message) {
  try {
    const users = await getAllUsers();
    if (!users || users.length === 0) {
      throw new Error('Список пользователей пуст');
    }
    
    let successCount = 0;
    let errorCount = 0;
    let messagesSent = 0;
    const MAX_MESSAGES_PER_MINUTE = 30;
    
    for (const user of users) {
      if (!user.active) continue;
      
      try {
        if (messagesSent >= MAX_MESSAGES_PER_MINUTE) {
          await new Promise(r => setTimeout(r, 60_000));
          messagesSent = 0;
        }
        
        await bot.telegram.sendMessage(user.id, message);
        successCount++;
        messagesSent++;
        
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.log(`❌ Ошибка при отправке пользователю ${user.id}:`, e.description || e.message);
        errorCount++;
        try {
          await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [user.id]);
        } catch (err) {
          console.error('Ошибка при обновлении статуса пользователя:', err);
        }
      }
    }
    
    console.log(`📣 Рассылка завершена. Успешно: ${successCount}, Ошибок: ${errorCount}`);
    return { successCount, errorCount };
    
  } catch (e) {
    console.error('🔥 Критическая ошибка при рассылке:', e);
    return { successCount: 0, errorCount: 0 };
  }
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
  if (!user || typeof user.premium_limit !== 'number') {
    return '⚠️ Ошибка: данные пользователя отсутствуют или некорректны.';
  }
  
  const tariffName = getTariffName(user.premium_limit);
  const activeUntil = user.premium_until ?
    new Date(user.premium_until).toLocaleDateString() :
    '—';
  const bonusUsed = user.subscribed_bonus_used ? '✅ Да' : '❌ Нет';
  
  return `
😎 Привет!
Этот бот — не стартап и не команда разработчиков.
Я делаю его один — чтобы был простой, честный и удобный инструмент.
Без рекламы, без слежки, без наворотов — всё по-человечески.

👤 <b>Ваш тариф:</b> ${tariffName}
🎚 <b>Лимит:</b> ${user.premium_limit} треков/день
📅 <b>До:</b> ${activeUntil}
🎁 <b>Бонус за подписку:</b> ${bonusUsed}

⚠️ В ближайшее время лимиты немного сократим, чтобы бот продолжал работать стабильно.
Проект держится на моих личных ресурсах — иногда приходится идти на такие шаги.
Спасибо за понимание 🙏

🎁 Сейчас идёт акция 1+1 на все тарифы — оплачиваешь месяц, получаешь два.
Действует до 20 июля. Подробности: @SCM_BLOG
  `.trim();
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
        res.locals.user = user;  // важно для ejs
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
if (audio && audio.path) {
  try {
    // Проверяем существование файла
    await fs.promises.access(audio.path);
    
    // Удаляем файл с диска
    await fs.promises.unlink(audio.path);
    console.log(`🗑 Удалён файл рассылки: ${path.basename(audio.originalname)}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Файл уже удален или не существует
      console.warn(`Файл ${audio.originalname} уже удален`);
    } else {
      console.error('Ошибка удаления аудио:', err);
    }
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
  
  // Проверка формата параметров
  if (typeof userId !== 'string' || typeof limit !== 'string') {
    return res.status(400).send('Неверный формат параметров');
  }
  
  const userIdNum = parseInt(userId);
  const limitNum = parseInt(limit);
  
  if (isNaN(userIdNum) || isNaN(limitNum)) {
    return res.status(400).send('Неверный формат ID или лимита');
  }
  
  if (![10, 50, 100, 1000].includes(limitNum)) {
    return res.status(400).send('Неизвестный тариф');
  }
  
  try {
    console.log(`Установка тарифа для пользователя ${userIdNum}: ${limitNum}`);
    
    const user = await getUserById(userIdNum);
    if (!user) {
      throw new Error('Пользователь не найден');
    }
    
    const bonusApplied = await setPremium(userIdNum, limitNum, 30);
    
    let msg = '✅ Подписка активирована на 30 дней.\n';
    if (bonusApplied) msg += '🎁 +30 дней в подарок! Акция 1+1 применена.';
    await bot.telegram.sendMessage(userIdNum, msg);
    
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});
app.post('/admin/reset-promo/:id', requireAuth, async (req, res) => {
  const userId = req.params.id;
  
  try {
    const userIdNum = parseInt(userId);
    if (isNaN(userIdNum)) {
      throw new Error('Неверный формат ID');
    }
    
    const user = await getUserById(userIdNum);
    if (!user) {
      throw new Error('Пользователь не найден');
    }
    
    await updateUserField(userIdNum, 'promo_1plus1_used', false);
    
    console.log(`🔄 Сброс промокода для пользователя ${userIdNum} выполнен администратором`);
    
    res.redirect('/dashboard?success=Промокод%20сброшен');
  } catch (e) {
    console.error('❌ Ошибка сброса промокода:', e);
    res.redirect('/dashboard?error=Ошибка%20при%20сбросе%20промокода');
  }
});
// Команды бота

const logCommand = async (userId, command) => {
  try {
    await logEvent(userId, `command_${command}`);
  } catch (e) {
    console.error('Ошибка логирования команды:', e);
  }
};

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*+]+/g, '').trim();
}

bot.start(async ctx => {
  const user = ctx.from;
  logCommand(user.id, 'start');
  
  try {
    const existingUser = await getUser(user.id);
    if (existingUser) {
      return ctx.reply('Привет! Ты уже зарегистрирован.').catch(console.error);
    }
    
    await createUser(user.id, user.first_name, user.username);
    await addOrUpdateUserInSupabase(user.id, user.first_name, user.username);
    await logEvent(user.id, 'registered');
    
   const fullUser = await getUser(user.id);

if (!fullUser || typeof fullUser.premium_limit !== 'number') {
  await ctx.reply('⚠️ Не удалось загрузить данные пользователя. Попробуйте позже.');
  return;
}

await ctx.reply(getPersonalMessage(fullUser), { parse_mode: 'HTML' }).catch(console.error);
    
    await ctx.replyWithChatAction('typing');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await ctx.reply(formatMenuMessage(fullUser), kb()).catch(console.error);
  } catch (e) {
    console.error('Ошибка при старте:', e);
    ctx.reply('Произошла ошибка при регистрации.').catch(console.error);
  }
});

bot.hears(texts.menu, async ctx => {
  logCommand(ctx.from.id, 'menu');
  
  try {
    const user = await getUser(ctx.from.id);
    await ctx.reply(formatMenuMessage(user), kb()).catch(console.error);
    
    if (!user.subscribed_bonus_used) {
      await ctx.reply(
        'Нажми кнопку ниже, чтобы получить бонус после подписки:',
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Я подписался', 'check_subscription')
        ])
      ).catch(console.error);
    }
  } catch (e) {
    console.error('Ошибка в команде menu:', e);
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(console.error);
  }
});

bot.hears(texts.help, async ctx => {
  logCommand(ctx.from.id, 'help');
  
  try {
    await ctx.reply(texts.helpInfo, kb()).catch(console.error);
  } catch (e) {
    console.error('Ошибка в команде help:', e);
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(console.error);
  }
});

bot.hears(texts.upgrade, async ctx => {
  logCommand(ctx.from.id, 'upgrade');
  
  try {
    await ctx.reply(texts.upgradeInfo, kb()).catch(console.error);
  } catch (e) {
    console.error('Ошибка в команде upgrade:', e);
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(console.error);
  }
});

bot.hears(texts.mytracks, async ctx => {
  logCommand(ctx.from.id, 'mytracks');
  
  try {
    const user = await getUser(ctx.from.id);
    if (!user) {
      return ctx.reply('Ошибка получения данных пользователя.').catch(console.error);
    }
    
    let tracks = [];
    try {
      tracks = user.tracks_today ? JSON.parse(user.tracks_today) : [];
    } catch (e) {
      console.warn('Ошибка парсинга tracks_today:', e);
      return ctx.reply('❌ Ошибка чтения треков. Попробуй позже.').catch(console.error);
    }
    
    if (!tracks.length) {
      return ctx.reply('Сегодня ты ещё ничего не скачивал.').catch(console.error);
    }
    
    await ctx.reply(`Скачано сегодня ${tracks.length} из ${user.premium_limit || 10}`).catch(console.error);
    
    // Разбиваем на пачки по 5
    for (let i = 0; i < tracks.length; i += 5) {
      const chunk = tracks.slice(i, i + 5);
      
      // Формируем mediaGroup для каждой пачки
      const mediaGroup = chunk
        .filter(t => t.fileId) // отправляем только те, у кого уже есть fileId
        .map(t => ({
          type: 'audio',
          media: t.fileId,
          title: t.name || 'Трек',
          performer: t.artist || undefined,
        }));
      
      try {
        await ctx.replyWithMediaGroup(mediaGroup);
      } catch (e) {
        console.error('Ошибка отправки аудио-пачки:', e);
        await handleFailedMediaGroup(ctx, chunk); // пробуем по одному
      }
    }
    
  } catch (e) {
    console.error('Ошибка в команде mytracks:', e);
    ctx.reply('Произошла ошибка. Попробуйте позже.').catch(console.error);
  }
});

// Вынесение сложной логики в отдельные функции
async function handleFailedMediaGroup(ctx, chunk) {
  for (const t of chunk) {
    try {
      await attemptSendWithFileId(ctx, t);
    } catch (error) {
      await handleFileIdError(ctx, t, error);
    }
  }
}

async function attemptSendWithFileId(ctx, track) {
 try {
 await ctx.replyWithAudio(track.fileId);
 } catch (e) {
 console.warn(`Ошибка отправки по fileId (${track.title}):`, e);
 throw new Error('FileId failed'); // Пробрасываем ошибку дальше
 }
}

async function handleFileIdError(ctx, track) {
 const filePath = path.join(cacheDir, `${sanitizeFilename(track.title)}.mp3`);
 
 try {
 // Асинхронная проверка существования файла
 await fs.promises.access(filePath, fs.constants.R_OK);
 
 const msg = await ctx.replyWithAudio({ 
 source: fs.createReadStream(filePath),
 filename: sanitizeFilename(track.title)
 });
 
 await updateTrackFileId(ctx.from.id, track.title, msg.audio.file_id);
 logSuccess(track.title, ctx.from.id);

 } catch (fileError) {
 await handleMissingFile(ctx, track.title, fileError);
 }
}

async function updateTrackFileId(userId, title, fileId) {
 try {
 await saveTrackForUser(userId, title, fileId);
 } catch (dbError) {
 console.error('Ошибка обновления fileId:', dbError);
 throw new Error('Database update failed');
 }
}

function logSuccess(title, userId) {
 console.log(`Успешно обновлен fileId для "${title}" (пользователь ${userId})`);
 metrics.track('fileId_updated', { userId, title });
}

async function handleMissingFile(ctx, title, error) {
 console.warn(`Файл "${title}" не найден:`, error);
 await ctx.reply(`⚠️ Трек "${truncateTitle(title)}" временно недоступен. Мы уже работаем над исправлением!`);
 metrics.track('file_missing', { title, userId: ctx.from.id });
}

function truncateTitle(title, maxLength = 35) {
 return title.length > maxLength 
 ? `${title.slice(0, maxLength)}...` 
 : title;
}

bot.command('admin', async (ctx) => {
  try {
    const [basicStats, topData, systemInfo] = await Promise.all([
      getDatabaseStats(),
      getTopStatistics(),
      getSystemMetrics()
    ]);
    
    const message = `
📊 *Расширенная статистика бота* 📊

*👥 Пользователи:*
- Всего: ${basicStats.total_users}
- Активных (24ч): ${basicStats.active24h}
- Новых сегодня: ${basicStats.newToday}

*📥 Загрузки:*
- Всего: ${basicStats.total_downloads}
- За сегодня: ${basicStats.downloadsToday}
- Топ треков:
  1. ${topData.topTracks[0]?.name || '—'} (${topData.topTracks[0]?.count || 0})
  2. ${topData.topTracks[1]?.name || '—'} (${topData.topTracks[1]?.count || 0})

*⚙️ Система:*
- Память: ${systemInfo.memoryUsage} MB
- Нагрузка: ${systemInfo.cpuLoad}%
- Uptime: ${Math.floor(systemInfo.uptime / 60)} мин

*🔗 Панель управления:* [Перейти](${DASHBOARD_URL})`;
    
    await ctx.replyWithMarkdown(message);
    
    await setAdminCommandCooldown(ctx.from.id);
    //await logAdminActivity({
      //userId: ctx.from.id,
     // command: 'admin_stats',
      //details: basicStats
   // });
    
  } catch (e) {
    console.error(`ADMIN COMMAND ERROR: ${e.stack}`);
    await ctx.reply(`⚠️ Критическая ошибка: ${e.message.slice(0,50)}...`);
    await sendEmergencyAlert({
      error: e,
      context: ctx.update,
      userId: ctx.from.id
    });
    metrics.increment('admin.command_errors');
  }
});

// Вспомогательная функция — отдельно, вне обработчика
async function validateAdmin(userId) {
  const admins = await getCachedAdmins();
  return admins.includes(userId);
}

async function getDatabaseStats() {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_users,
      COUNT(last_active >= NOW() - INTERVAL '24 HOURS') as active24h,
      COUNT(created_at >= CURRENT_DATE) as newToday,
      SUM(total_downloads) as total_downloads,
      SUM(downloads_today) as downloadsToday
    FROM users
  `);
  return result.rows[0];
}

// Проверка подписки и выдача бонуса
bot.action('check_subscription', async (ctx) => {
  try {
    const userId = ctx.from.id;

    const [isSubscribed, user] = await Promise.all([
      checkChannelSubscriptionWithCache(userId),
      getUser(userId)
    ]);

    if (!isSubscribed) {
      await ctx.replyWithMarkdown(
        `📢 Для получения бонуса:\n\n1. Подпишись на [наш канал](${CHANNEL_URL})\n2. Нажми кнопку "✅ Я подписался"`,
        Markup.inlineKeyboard([
          Markup.button.url('📲 Перейти в канал', CHANNEL_URL),
          Markup.button.callback('✅ Я подписался', 'check_subscription')
        ])
      );
      return ctx.answerCbQuery('❌ Подписка не обнаружена');
    }

    if (user.subscribed_bonus_used) {
      await ctx.editMessageText(
        '🎁 Вы уже получили бонус за подписку',
        Markup.inlineKeyboard([])
      );
      return ctx.answerCbQuery();
    }

    const success = await setPremiumWithCheck(userId, {
      days: 7,
      limit: 50,
      bonusType: 'subscription'
    });

    if (!success) throw new Error('Ошибка обновления подписки');

    await ctx.editMessageText(
      `🎉 *Бонус активирован!*\n\nТеперь у вас:\n• 7 дней доступа\n• Лимит: 50 треков/день`,
      { parse_mode: 'Markdown' }
    );

    await Promise.all([
      logEvent(userId, 'premium_activated', { source: 'subscription' }),
      notifyAdmin(`👤 Пользователь @${ctx.from.username} активировал бонус подписки`)
    ]);

  } catch (e) {
    console.error(`Ошибка подписки: ${e.stack}`);
    await ctx.answerCbQuery('⚠️ Ошибка. Попробуйте позже.');
    if (typeof handleCriticalError === 'function') {
      await handleCriticalError(e, ctx);
    }
  }
});

// Подключение к Redis через переменную окружения

/**
 * Проверяет лимит запросов пользователя по ключу и интервалу
 * @param {number} userId - ID пользователя
 * @param {string} key - уникальный ключ лимита (например, 'download_requests')
 * @param {number} windowSeconds - время в секундах, например 600 (10 минут)
 * @param {number} maxCount - максимально допустимое число запросов (по умолчанию 5)
 * @returns {Promise<boolean>} - true, если лимит превышен, иначе false
 */
async function checkRateLimit(userId, key, windowSeconds, maxCount = 5) {
  const redisKey = `ratelimit:${userId}:${key}`;
  try {
    const current = await redis.incr(redisKey);
    if (current === 1) {
      await redis.expire(redisKey, windowSeconds);
    }
    return current > maxCount;
  } catch (e) {
    console.error('Ошибка в checkRateLimit:', e);
    // Чтобы не блокировать пользователей из-за ошибок Redis
    return false;
  }
}

// --- Обработчик сообщений: извлечение ссылок и вызов enqueue ---
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const text = ctx.message.text;
    const urls = extractSoundCloudUrls(text);
    
    const { isValid, error } = await validateUrls(urls);
    if (!isValid) return ctx.reply(`❌ Ошибка: ${error}`);
    
    const user = await getUser(userId);
    if (!user) return ctx.reply('❌ Пользователь не найден.');
    
    if (user.downloads_today >= user.premium_limit) {
      return ctx.reply('🔒 Вы достигли лимита загрузок на сегодня.');
    }
    
    for (const url of urls) {
      await enqueue(ctx, userId, url);
    }
    
  } catch (e) {
    console.error('Ошибка обработки сообщения:', e);
    await ctx.reply('⚠️ Ошибка при обработке запроса. Попробуйте позже.');
  }
});
// Вспомогательные функции
async function checkChannelSubscriptionWithCache(userId) {
  const cacheKey = `substatus:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached === 'true';

  const status = await bot.telegram.getChatMember(CHANNEL_ID, userId);
  const result = ['member', 'administrator', 'creator'].includes(status.status);

  await redis.setex(cacheKey, 300, result.toString());
  return result;
}

async function setPremiumWithCheck(userId, options) {
  return db.transaction(async trx => {
    const user = await trx('users').where({ id: userId }).forUpdate().first();
    if (user.subscribed_bonus_used) return false;

    await trx('users').where({ id: userId }).update({
      premium_until: db.raw(`NOW() + INTERVAL '${options.days} days'`),
      premium_limit: options.limit,
      subscribed_bonus_used: true
    });

    return true;
  });
}
// ================== Утилиты ==================

function extractSoundCloudUrls(text) {
  const regex = /https?:\/\/(soundcloud\.com|on\.soundcloud\.com)\/[^\s]+/g;
  return text.match(regex) || [];
}

async function validateUrls(urls) {
  if (!urls.length) return { isValid: false, error: 'Ссылки не найдены' };
  if (urls.some(url => !url.startsWith('http'))) {
    return { isValid: false, error: 'Некорректный формат ссылок' };
  }
  return { isValid: true };
}

async function handleCriticalError(error, ctx) {
  console.error('Критическая ошибка:', error);
  try {
    await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Ошибка у пользователя ${ctx.from?.username || ctx.from?.id}:\n\n${error.message}`);
  } catch (err) {
    console.error('Ошибка при уведомлении админа:', err);
  }
}

async function enqueueDownload({ userId, urls, priority = 'normal' }) {
  // Заглушка для постановки в очередь
  const jobId = Math.floor(Math.random() * 1000000);
  // Тут должна быть твоя логика очереди/записи в БД
  return { id: jobId };
}

async function trackDownloadProgress(jobId, ctx) {
  // Заглушка для отслеживания прогресса
  console.log(`Трекинг загрузки задачи #${jobId}`);
}

async function notifyAdmin(message) {
  try {
    await bot.telegram.sendMessage(ADMIN_ID, `🔔 ${message}`);
  } catch (e) {
    console.error('Ошибка уведомления админа:', e);
  }
}
// Telegram webhook
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('Ошибка handleUpdate:', err));
});


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