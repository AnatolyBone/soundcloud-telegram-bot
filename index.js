const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');

const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, resetDailyStats, addReview,
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded
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

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша старше 7 дней
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  });
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

const queues = {};
const processing = {};
const reviewMode = new Set();

// Только русский язык — убрал мульти-язык
const texts = {
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  cached: '🔁 Из кеша...',
  error: '❌ Ошибка',
  timeout: '⏱ Слишком долго...',
  limitReached: '🚫 Лимит достигнут.',
  upgradeInfo: `🚀 Хочешь больше треков?

🆓 Free — 10 🟢
Plus — 50 🎯 (59₽)
Pro — 100 💪 (119₽)
Unlimited — 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

👫 Пригласи друзей и получи 1 день тарифа Plus за каждого.`,
  helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
  reviewAsk: '✍️ Напиши отзыв о боте. За это — тариф Plus на 30 дней!',
  reviewThanks: '✅ Спасибо! Тариф Plus выдан на 30 дней.',
  alreadyReviewed: 'Ты уже оставил отзыв 😊',
  noTracks: 'Сегодня нет треков.',
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  adminCommands: '\n\n📋 Команды админа:\n/admin — статистика\n/testdb — мои данные\n/backup — резервная копия\n/reviews — отзывы'
};

// Клавиатура всегда русская, фиксированная
const kb = () =>
  Markup.keyboard([
    [texts.menu, texts.upgrade],
    [texts.mytracks, texts.help],
    ['✍️ Оставить отзыв']
  ]).resize();

async function enqueue(userId, url) {
  if (!queues[userId]) queues[userId] = [];
  queues[userId].push(url);
  if (processing[userId]) return;

  processing[userId] = true;
  while (queues[userId].length > 0) {
    const trackUrl = queues[userId].shift();
    try {
      await bot.telegram.sendMessage(userId, texts.queuePosition(queues[userId].length + 1));
      await Promise.race([
        processTrackByUrl(userId, trackUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 180000))
      ]);
    } catch (err) {
      console.error(`Ошибка в очереди пользователя ${userId}:`, err);
      await bot.telegram.sendMessage(userId, texts.error);
    }
  }
  processing[userId] = false;
}

async function processTrackByUrl(userId, url) {
  console.log(`Начинаем загрузку трека для ${userId}: ${url}`);
  await bot.telegram.sendMessage(userId, texts.downloading);

  try {
    const info = await ytdl(url, { dumpSingleJson: true });
    let name = (info.title || 'track')
      .replace(/[^\w\s\-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);

    const fp = path.join(cacheDir, `${name}.mp3`);
    if (!fs.existsSync(fp)) {
      await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: fp });
    }

    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);

    await bot.telegram.sendAudio(userId, { source: fs.createReadStream(fp), filename: `${name}.mp3` });
    console.log(`Трек успешно отправлен пользователю ${userId}: ${name}`);
  } catch (e) {
    console.error('Ошибка при загрузке трека:', e);
    await bot.telegram.sendMessage(userId, texts.error);
  }
}

bot.start(async ctx => {
  console.log('/start от', ctx.from.id);
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(texts.start, kb());
});

bot.hears(texts.menu, async ctx => {
  const u = await getUser(ctx.from.id);

  const now = new Date();
  const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;
  const refLink = `https://t.me/SCloudMusicBot?start=${ctx.from.id}`;

  const msg = `👋 Добро пожаловать, ${u.first_name}!\n\n` +
              `💼 Тариф: ${u.premium_limit === 10 ? 'Free' :
                        u.premium_limit === 50 ? 'Plus' :
                        u.premium_limit === 100 ? 'Pro' : 'Unlimited'}\n` +
              `⏳ Осталось дней: ${daysLeft > 0 ? daysLeft : '0'}\n\n` +
              `👫 Приглашено: ${u.referred_count || 0}\n🎁 Дней Plus: ${u.referred_count || 0}\n\n` +
              `🔗 Твоя ссылка:\n${refLink}`;

  ctx.reply(msg, kb());
});

bot.hears(texts.upgrade, async ctx => {
  ctx.reply(texts.upgradeInfo);
});

bot.hears(texts.help, async ctx => {
  ctx.reply(texts.helpInfo);
});

bot.hears('✍️ Оставить отзыв', async ctx => {
  if (await hasLeftReview(ctx.from.id)) {
    return ctx.reply(texts.alreadyReviewed);
  }
  ctx.reply(texts.reviewAsk);
  reviewMode.add(ctx.from.id);
});

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const downloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  const msg = `📊 Пользователей: ${users.length}\n📥 Загрузок: ${downloads}`;
  ctx.reply(msg + texts.adminCommands);
});

bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const reviews = await getLatestReviews(10);
  for (const r of reviews) {
    await ctx.reply(`📝 ${r.text}\n🕒 ${r.time}`);
  }
});

bot.hears(texts.mytracks, async ctx => {
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply(texts.noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

// Обрабатываем текст — игнорируем команды (начинающиеся с '/')
bot.on('text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;

  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30);
    return ctx.reply(texts.reviewThanks, kb());
  }

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) return;

  await resetDailyLimitIfNeeded(ctx.from.id);
  const u = await getUser(ctx.from.id);
  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached);
  }

  await enqueue(ctx.from.id, url);
});

// Вебхук — сразу 200, потом обработка update
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => {
    console.error('Ошибка в handleUpdate:', err);
  });
});

app.use(express.urlencoded({ extended: true }));
app.use(compression());

app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_LOGIN &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Неверные данные' });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const users = await getAllUsers();

  const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);

  // Запрос регистрации по датам:
  const registrationsResult = await pool.query(`
    SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date, COUNT(*) AS count
    FROM users
    GROUP BY date
    ORDER BY date
  `);

  // Преобразуем результат в объект для шаблона
  const registrationsByDate = {};
  registrationsResult.rows.forEach(row => {
    registrationsByDate[row.date] = parseInt(row.count, 10);
  });

  // Для скачиваний — если у тебя нет подробной таблицы, пока оставим пустым
  // Или сделай аналогичный запрос, если есть данные по датам скачиваний
  const downloadsByDate = {}; 

  // Считаем тарифы для статистики
  const freeCount = users.filter(u => u.premium_limit === 10).length;
  const plusCount = users.filter(u => u.premium_limit === 50).length;
  const proCount = users.filter(u => u.premium_limit === 100).length;
  const unlimitedCount = users.filter(u => u.premium_limit >= 1000).length;

  const stats = {
    totalUsers: users.length,
    totalDownloads,
    free: freeCount,
    plus: plusCount,
    pro: proCount,
    unlimited: unlimitedCount,
    registrationsByDate,
    downloadsByDate
  };

  const reviews = await getLatestReviews(10);

  res.render('dashboard', { stats, users, reviews });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);

  const cleanWebhookUrl = WEBHOOK_URL.replace(/\/$/, '') + WEBHOOK_PATH;

  bot.telegram.setWebhook(cleanWebhookUrl)
    .then(() => {
      console.log(`✅ Webhook установлен: ${cleanWebhookUrl}`);
      return bot.telegram.getWebhookInfo();
    })
    .then(info => {
      console.log('📡 Webhook info:');
      console.log(`   URL: ${info.url}`);
      console.log(`   Pending updates: ${info.pending_update_count}`);
      console.log(`   Last error: ${info.last_error_message || 'Нет'}`);
    })
    .catch(err => console.error('❌ Ошибка установки webhook:', err));
});