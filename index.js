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
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded,
  getTrackMetadata, saveTrackMetadata
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

setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  });
}, 3600 * 1000);

setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

const queues = {};
const processing = {};
const reviewMode = new Set();

const texts = {
  ru: {
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
  }
};

const kb = lang =>
  Markup.keyboard([
    [texts[lang].menu, texts[lang].upgrade],
    [texts[lang].mytracks, texts[lang].help],
    ['✍️ Оставить отзыв']
  ]).resize();

const getLang = u => u?.lang || 'ru';

async function enqueue(userId, url) {
  if (!queues[userId]) queues[userId] = [];
  queues[userId].push(url);
  if (processing[userId]) return;

  processing[userId] = true;
  while (queues[userId].length > 0) {
    const trackUrl = queues[userId].shift();
    try {
      // Логируем позицию в очереди
      await bot.telegram.sendMessage(userId, texts.ru.queuePosition(queues[userId].length + 1));
      await processTrackByUrl(userId, trackUrl);
    } catch (err) {
      console.error(`Ошибка в очереди пользователя ${userId}:`, err);
      await bot.telegram.sendMessage(userId, texts.ru.error);
    }
  }
  processing[userId] = false;
}

async function processTrackByUrl(userId, url) {
  const u = await getUser(userId);
  const lang = getLang(u);
  console.log(`Начинаем загрузку трека для ${userId}: ${url}`);
  await bot.telegram.sendMessage(userId, texts[lang].downloading);

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
    await bot.telegram.sendMessage(userId, texts[lang].error);
  }
}

// Обработчики Telegram

bot.start(async ctx => {
  console.log('/start от', ctx.from.id);
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

bot.hears(texts.ru.menu, async ctx => {
  console.log('Меню от', ctx.from.id);
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);

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

  ctx.reply(msg, kb(lang));
});

bot.hears(texts.ru.upgrade, async ctx => {
  console.log('Запрос расширения лимита от', ctx.from.id);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});

bot.hears(texts.ru.help, async ctx => {
  console.log('Запрос помощи от', ctx.from.id);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});

bot.hears('✍️ Оставить отзыв', async ctx => {
  console.log('Запрос оставить отзыв от', ctx.from.id);
  if (await hasLeftReview(ctx.from.id)) {
    return ctx.reply(texts.ru.alreadyReviewed);
  }
  ctx.reply(texts.ru.reviewAsk);
  reviewMode.add(ctx.from.id);
});

bot.on('text', async ctx => {
  console.log('Текст от', ctx.from.id, ':', ctx.message.text);

  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30);
    return ctx.reply(texts.ru.reviewThanks, kb('ru'));
  }

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) {
    console.log('Не SoundCloud ссылка, игнорируем');
    return;
  }

  await resetDailyLimitIfNeeded(ctx.from.id);
  const u = await getUser(ctx.from.id);
  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts[getLang(u)].limitReached);
  }

  await enqueue(ctx.from.id, url);
});

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  console.log('Админ запрос статистики от', ctx.from.id);
  const users = await getAllUsers();
  const downloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  const msg = `📊 Пользователей: ${users.length}\n📥 Загрузок: ${downloads}`;
  ctx.reply(msg + texts.ru.adminCommands);
});

bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  console.log('Админ запрос отзывов от', ctx.from.id);
  const reviews = await getLatestReviews(10);
  for (const r of reviews) {
    await ctx.reply(`📝 ${r.text}\n🕒 ${r.time}`);
  }
});

bot.hears(texts.ru.mytracks, async ctx => {
  console.log('Запрос моих треков от', ctx.from.id);
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply(texts.ru.noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  console.log('🟢 Получен update от Telegram:', req.body.update_id);
  bot.handleUpdate(req.body)
    .then(() => {
      console.log('✅ Update обработан:', req.body.update_id);
      res.sendStatus(200);
    })
    .catch(err => {
      console.error('❌ Ошибка в handleUpdate:', err);
      res.sendStatus(500);
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
  const reviews = await getLatestReviews(10);
  const stats = {
    totalUsers: users.length,
    totalDownloads
  };
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