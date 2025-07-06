const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const playlistTracker = new Map();
const { supabase } = require('./db');
const expressLayouts = require('express-ejs-layouts');
const {
  createUser, getUser, updateUserField, incrementDownloads, setPremium,
  getAllUsers, resetDailyStats, addReview, saveTrackForUser, hasLeftReview,
  getLatestReviews, resetDailyLimitIfNeeded, getRegistrationsByDate,
  getDownloadsByDate, getActiveUsersByDate, getExpiringUsers, getReferralSourcesStats,
  markSubscribedBonusUsed, getUserActivityByDayHour, logUserActivity, getUserById,
  getExpiringUsersCount, getExpiringUsersPaginated
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT || 3000;

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

// Кеш треков
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша старше 7 дней
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdir(cacheDir, (err, files) => {
    if (err) {
      console.error('Ошибка чтения кеша:', err);
      return;
    }
    files.forEach(file => {
      const filePath = path.join(cacheDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error('Ошибка stat файла:', err);
          return;
        }
        if (stats.mtimeMs < cutoff) {
          fs.unlink(filePath, err => {
            if (err) console.error('Ошибка удаления файла кеша:', err);
            else console.log(`🗑 Удалён кеш: ${file}`);
          });
        }
      });
    });
  });
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

// Константы и тексты
const MAX_CONCURRENT_DOWNLOADS = 5;

let globalQueue = [];
let activeDownloadsCount = 0;

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

🔔 Получи 7 дней Plus!
Подпишись на канал @BAZAproject и нажми кнопку ниже, чтобы получить бонус.`,
  upgradeInfo: `🚀 Хочешь больше треков?

🆓 Free — 10 🟢
Plus — 50 🎯 (59₽)
Pro — 100 💪 (119₽)
Unlimited — 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

👫 Пригласи друзей и получи 1 день тарифа Plus за каждого.`,
  helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
adminCommands: '\n\n📋 Команды админа:\n/admin — статистика'
};

const kb = () =>
  Markup.keyboard([
    [texts.menu, texts.upgrade],
    [texts.mytracks, texts.help]
  ]).resize();

// Проверка подписки на канал
const isSubscribed = async userId => {
  try {
    const res = await bot.telegram.getChatMember('@BAZAproject', userId);
    return ['member', 'creator', 'administrator'].includes(res.status);
  } catch {
    return false;
  }
};

// Отправка аудио с защитой
async function sendAudioSafe(ctx, userId, filePath, filename) {
  try {
    await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(filePath), filename });
  } catch (e) {
    console.error(`Ошибка отправки аудио ${filename} пользователю ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

// Основная функция загрузки и отправки трека
async function processTrackByUrl(ctx, userId, url, playlistUrl = null) {
  const start = Date.now();
  try {
    const info = await ytdl(url, { dumpSingleJson: true });

    let name = info.title || 'track';
    name = name.replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '_').replace(/__+/g, '_');
    if (name.length > 64) name = name.slice(0, 64);

    const fp = path.join(cacheDir, `${name}.mp3`);

    if (!fs.existsSync(fp)) {
      await ytdl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: fp,
        preferFreeFormats: true,
        noCheckCertificates: true
      });
    }

    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);
    await pool.query('INSERT INTO downloads_log (user_id, track_title) VALUES ($1, $2)', [userId, name]);

    await sendAudioSafe(ctx, userId, fp, `${name}.mp3`);

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
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

// Управление глобальной очередью загрузок
function addToGlobalQueue(task) {
  globalQueue.push(task);
  globalQueue.sort((a, b) => b.priority - a.priority);
}

async function processNextInQueue() {
  while (activeDownloadsCount < MAX_CONCURRENT_DOWNLOADS && globalQueue.length > 0) {
    const task = globalQueue.shift();
    activeDownloadsCount++;
    const { ctx, userId, url, playlistUrl } = task;

    try {
      await processTrackByUrl(ctx, userId, url, playlistUrl);
    } catch (e) {
      console.error(`Ошибка при загрузке трека ${url} для пользователя ${userId}:`, e);
      try {
        await ctx.telegram.sendMessage(userId, '❌ Ошибка при загрузке трека.');
      } catch {}
    }

    activeDownloadsCount--;
    processNextInQueue();
  }
}

// Добавление задачи загрузки в очередь с проверками лимита
async function enqueue(ctx, userId, url) {
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

// Формат меню пользователя
function formatMenuMessage(user) {
  const now = new Date();
  const premiumUntil = user.premium_until ? new Date(user.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;

  const tariffName =
    user.premium_limit === 10 ? 'Free (10/день)' :
    user.premium_limit === 50 ? 'Plus (50/день)' :
    user.premium_limit === 100 ? 'Pro (100/день)' :
    'Unlimited';

  const refLink = `https://t.me/SCloudMusicBot?start=${user.id}`;

  return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и целые плейлисты с SoundCloud в MP3.  
Просто пришли ссылку — и всё 🧙‍♂️

🔄 При отправке ссылки ты увидишь свою позицию в очереди.  
🎯 Платные тарифы (Plus / Pro / Unlimited) идут с приоритетом — их треки загружаются первыми.  
📥 Бесплатные пользователи тоже получают треки — просто чуть позже. Всё честно.

💼 Тариф: ${tariffName}  
⏳ Осталось дней: ${daysLeft > 0 ? daysLeft : '0'}

🎧 Сегодня скачано: ${user.downloads_today || 0} из ${user.premium_limit}

🎁 Хочешь больше?

Подпишись на канал @BAZAproject — получи 7 дней тарифа Plus бесплатно.

Нажми «✅ Я подписался», чтобы получить бонус.

👫 Приглашено: ${user.referred_count || 0}  
🎁 Получено дней Plus по рефералам: ${user.referred_count || 0}

🔗 Твоя реферальная ссылка:  
${refLink}
`;
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

function getLastMonths(n = 6) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = d.toISOString().slice(0, 7); // 'YYYY-MM'
    const display = d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    months.push({ value: `month:${ym}`, label: display });
  }
  return months;
}
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
function filterStatsByPeriod(data, period) {
  if (!Array.isArray(data)) return [];

  if (period === '7') {
    const fromYMD = toYMD(new Date(Date.now() - 7 * 86400000));
    return data.filter(item => item.date >= fromYMD);
  } 
  if (period === '30') {
    const fromYMD = toYMD(new Date(Date.now() - 30 * 86400000));
    return data.filter(item => item.date >= fromYMD);
  } 
  if (/^\d{4}-\d{2}$/.test(period)) {  // формат 'YYYY-MM'
    return data.filter(item => item.date && item.date.startsWith(period));
  }

  return data; // если ничего не подошло — вернуть все данные
}

// Дашборд
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    res.locals.page = 'dashboard';

    const showInactive = req.query.showInactive === 'true';
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const period = `${year}-${month.toString().padStart(2, '0')}`;
    const expiringLimit = parseInt(req.query.expiringLimit) || 10;
    const expiringOffset = parseInt(req.query.expiringOffset) || 0;

    console.log('📌 Параметры запроса:', { period, showInactive, expiringLimit, expiringOffset });

    const expiringSoon = await getExpiringUsers();
    const expiringCount = expiringSoon.length;
    console.log('🕓 expiringSoon:', expiringSoon.length);

    const users = await getAllUsers(showInactive);
    console.log('👥 Всего пользователей:', users.length);

    const downloadsByDateRaw = await getDownloadsByDate();
    const registrationsByDateRaw = await getRegistrationsByDate();
    const activeByDateRaw = await getActiveUsersByDate();

    console.log('📊 Сырые данные:');
    console.log('Загрузки:', downloadsByDateRaw);
    console.log('Регистрации:', registrationsByDateRaw);
    console.log('Активные:', activeByDateRaw);

    // Функция для конвертации объекта { 'date': count, ... } в массив [{date, count}, ...]
    function convertObjToArray(dataObj) {
      if (!dataObj) return [];
      return Object.entries(dataObj).map(([date, count]) => ({ date, count }));
    }

    // Конвертируем сырые данные в массивы перед фильтрацией
    const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
    const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
    const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);

    console.log('📅 После фильтрации:');
    console.log('Регистрации:', filteredRegistrations);
    console.log('Загрузки:', filteredDownloads);
    console.log('Активные:', filteredActive);

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

      const regData = dates.map(date => regMap.get(date) || 0);
      const dlData = dates.map(date => dlMap.get(date) || 0);
      const actData = dates.map(date => actMap.get(date) || 0);

      return {
        labels: dates,
        datasets: [
          {
            label: 'Регистрации',
            data: regData,
            borderColor: 'rgba(75, 192, 192, 1)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            fill: false,
          },
          {
            label: 'Загрузки',
            data: dlData,
            borderColor: 'rgba(255, 99, 132, 1)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            fill: false,
          },
          {
            label: 'Активные пользователи',
            data: actData,
            borderColor: 'rgba(75, 192, 192, 1)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            fill: false,
          }
        ]
      };
    }

    const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);
    console.log('📈 chartDataCombined:', chartDataCombined);

    const stats = {
      totalUsers: users.length,
      totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
      free: users.filter(u => u.premium_limit === 10).length,
      plus: users.filter(u => u.premium_limit === 50).length,
      pro: users.filter(u => u.premium_limit === 100).length,
      unlimited: users.filter(u => u.premium_limit >= 1000).length,
      registrationsByDate: filteredRegistrations,
      downloadsByDate: filteredDownloads,
      activeByDate: filteredActive
    };
    console.log('📦 stats:', stats);

    const activityByDayHour = await getUserActivityByDayHour();
    const activityByHour = computeActivityByHour(activityByDayHour);
    const activityByWeekday = computeActivityByWeekday(activityByDayHour);

    console.log('⏱ activityByHour:', activityByHour);
    console.log('📅 activityByWeekday:', activityByWeekday);

    const referralStats = await getReferralSourcesStats();
    console.log('🔗 referralStats:', referralStats);

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

    const lastMonths = getLastMonths(6);
    console.log('📆 lastMonths:', lastMonths);

    const chartDataHourActivity = {
  labels: [...Array(24).keys()].map(h => `${h}:00`),
  datasets: [{
    label: 'Активность по часам',
    data: activityByHour,
    backgroundColor: 'rgba(54, 162, 235, 0.7)',
  }],
};

const chartDataWeekdayActivity = {
  labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  datasets: [{
    label: 'Активность по дням недели',
    data: activityByWeekday,
    backgroundColor: 'rgba(255, 206, 86, 0.7)',
  }],
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
  chartDataHourActivity,       // <--- вот они добавлены
  chartDataWeekdayActivity,    // <--- вот они добавлены
  showInactive,
  period,
  retentionData: [],
  funnelData: [],
  customStyles: '',
  customScripts: '',
  chartDataHeatmap: {},
  chartDataFunnel: {},
  lastMonths
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

app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
  const { message } = req.body;
  const audio = req.file;

  if (!message && !audio) {
    return res.status(400).render('broadcast-form', { error: 'Текст или файл обязательны' });
  }

  const users = await getAllUsers();
  let success = 0, error = 0;

  for (const u of users) {
    if (!u.active) continue;
    try {
      if (audio) {
        await bot.telegram.sendAudio(u.id, {
          source: fs.createReadStream(audio.path),
          filename: audio.originalname
        }, { caption: message || '' });
      } else {
        await bot.telegram.sendMessage(u.id, message);
      }
      success++;
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      error++;
      try {
        await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [u.id]);
      } catch (err) {
        console.error('Ошибка обновления статуса пользователя:', err);
      }
    }
  }

  if (audio) {
    fs.unlink(audio.path, err => {
      if (err) console.error('Ошибка удаления аудио:', err);
    });
  }

  res.send(`✅ Успешно: ${success}, ошибок: ${error}`);
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

// Установка тарифа пользователю
app.post('/set-tariff', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { userId, limit } = req.body;
  if (!userId || !limit) return res.status(400).send('Отсутствуют параметры');

  let limitNum = parseInt(limit);
  if (![10, 50, 100, 1000].includes(limitNum)) {
    return res.status(400).send('Неизвестный тариф');
  }

  try {
    await setPremium(userId, limitNum, 0);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});
// === Telegraf бот ===

// Команды бота
bot.start(async ctx => {
  const user = ctx.from;
  await createUser(user.id, user.first_name, user.username);
  await addOrUpdateUserInSupabase(user.id, user.first_name, user.username);
  await ctx.reply(texts.start, kb());
  await ctx.reply(formatMenuMessage(await getUser(user.id)), kb());
});

bot.hears(texts.menu, async ctx => {
  await ctx.reply(formatMenuMessage(await getUser(ctx.from.id)), kb());
});

bot.hears(texts.help, async ctx => {
  await ctx.reply(texts.helpInfo, kb());
});

bot.hears(texts.upgrade, async ctx => {
  await ctx.reply(texts.upgradeInfo, kb());
});

bot.hears(texts.mytracks, async ctx => {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply('Пользователь не найден');
  // Загрузка списка треков, здесь пример простого ответа:
  await ctx.reply(`Твои треки сегодня: ${user.total_downloads || 0}`);
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
      await setPremium(ctx.from.id, 50, until);
      await updateUserField(ctx.from.id, 'subscribed_bonus_used', true);
      await ctx.reply('Поздравляю! Тебе начислен бонус: 7 дней Plus.');
    }
  } else {
    await ctx.reply('Пожалуйста, подпишись на канал @BAZAproject и нажми кнопку ещё раз.');
  }
  await ctx.answerCbQuery();
});

// Обработка сообщений с ссылками
bot.on('text', async ctx => {
  const url = extractUrl(ctx.message.text);
  if (!url) {
    await ctx.reply('Пожалуйста, отправь ссылку на трек или плейлист SoundCloud.');
    return;
  }
  ctx.reply('🔄 Загружаю трек... Это может занять пару минут.');

  // Асинхронная обработка — не ждем выполнения
  enqueue(ctx, ctx.from.id, url).catch(e => {
    console.error('Ошибка в enqueue:', e);
    ctx.reply('❌ Ошибка при обработке ссылки.');
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
