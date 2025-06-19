// index.js — Часть 1: Импорты, переменные, инициализация

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const crypto = require('crypto');
const { Parser } = require('json2csv');

const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, resetDailyStats, addReview,
  saveTrackForUser, hasLeftReview, getLatestReviews
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://soundcloud-telegram-bot.onrender.com/telegram';

if (!BOT_TOKEN || !ADMIN_ID || !process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.error('❌ Обязательные переменные окружения не заданы!');
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
// index.js — Часть 2: Очистка кеша, очередь, Telegram-бот, sanitize

// Лог очистки кеша
function logCacheCleanup(count) {
  const log = `[${new Date().toISOString()}] 🧹 Удалено из кеша: ${count} файлов\n`;
  fs.appendFileSync('logs/cache_cleanup.log', log);
}

// Очистка кеша старше 7 дней
function clearOldCache() {
  try {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    const files = fs.readdirSync(cacheDir);
    let removed = 0;
    files.forEach(file => {
      const fp = path.join(cacheDir, file);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    });
    logCacheCleanup(removed);
    return removed;
  } catch (err) {
    console.error('Ошибка очистки кеша:', err);
    return 0;
  }
}
setInterval(clearOldCache, 3600 * 1000);

// Сброс суточных лимитов
setInterval(async () => {
  try {
    await resetDailyStats();
    console.log('✅ Суточные лимиты сброшены');
  } catch (err) {
    console.error('❌ Ошибка сброса лимитов:', err);
  }
}, 24 * 3600 * 1000);

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
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты напиши: @anatolybone',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:',
    reviewAsk: '✍️ Напиши свой отзыв. Тебе будет выдан тариф Plus (50 треков) на 30 дней.',
    reviewThanks: '✅ Спасибо! Тариф Plus выдан на 30 дней.',
    alreadyReviewed: 'Ты уже оставил отзыв 😊 Спасибо!',
    noTracks: 'Сегодня нет треков.',
    queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
    adminCommands: '\n\n📋 Команды админа:\n/admin — статистика\n/testdb — мои данные\n/backup — резерв\n/reviews — отзывы'
  }
};
const getLang = u => u?.lang || 'ru';
const kb = lang =>
  Markup.keyboard([
    [texts[lang].menu, texts[lang].upgrade],
    [texts[lang].mytracks, texts[lang].help],
    ['✍️ Оставить отзыв']
  ]).resize();

function sanitizeTitle(str) {
  return str
    .replace(/[\[\]{}()]/g, '')          // удаляем скобки
    .replace(/[^a-zA-Zа-яА-Я0-9\s-]/g, '') // оставляем буквы/цифры/пробелы/дефисы
    .replace(/\s+/g, ' ')                // множественные пробелы
    .trim()
    .slice(0, 50)
    .replace(/\s/g, '_');
}
// processTrack: скачивание и отправка трека
async function processTrack(ctx, url) {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);

  try {
    await ctx.reply(texts[lang].downloading);
    const info = await ytdl(url, { dumpSingleJson: true });
    const rawTitle = info.title || 'track';
    const name = sanitizeTitle(rawTitle);
    const fp = path.join(cacheDir, `${name}.mp3`);

    if (!fs.existsSync(fp)) {
      await ytdl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: fp
      });
    }

    await incrementDownloads(ctx.from.id, name);
    await saveTrackForUser(ctx.from.id, name);
    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('❌ Ошибка при обработке трека:', e);
    await ctx.reply(texts[lang].error);
  }
}

// Обработка очереди
async function processNext(userId) {
  if (!queues[userId]?.length) {
    processing[userId] = false;
    return;
  }
  if (processing[userId]) return;
  processing[userId] = true;

  while (queues[userId].length > 0) {
    const job = queues[userId][0];
    try {
      await job();
    } catch (e) {
      console.error('Ошибка в job очереди:', e);
    }
    queues[userId].shift();
  }
  processing[userId] = false;
}

});
// ===== Express / Webhook =====
app.use(bot.webhookCallback('/telegram'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin');
}

// ===== Admin Login =====
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

// ===== Admin Dashboard =====
app.get('/dashboard', requireAuth, async (req, res) => {
  const users = await getAllUsers();
  const totalDownloads = users.reduce((sum, u) => sum + (u.downloads_today || 0), 0);

  const stats = {
    totalUsers: users.length,
    totalDownloads,
    free: users.filter(u => u.premium_limit === 10).length,
    plus: users.filter(u => u.premium_limit === 50).length,
    pro: users.filter(u => u.premium_limit === 100).length,
    unlimited: users.filter(u => u.premium_limit >= 1000).length
  };

  const reviews = await getLatestReviews(10);

  res.render('dashboard', { users, stats, reviews });
});

// Смена тарифа
app.post('/set-tariff', requireAuth, async (req, res) => {
  const { userId, limit } = req.body;
  if (!userId || !limit) return res.status(400).send('Missing data');

  const parsedLimit = parseInt(limit, 10);
  if (![10, 50, 100, 1000].includes(parsedLimit)) {
    return res.status(400).send('Invalid limit');
  }

  try {
    await setPremium(userId, parsedLimit);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Server error');
  }
});

// ===== Прочее =====
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

app.get('/', (_, res) => res.send('✅ OK'));
// Обработка сообщений — треки или отзывы
bot.on('text', async ctx => {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  const text = ctx.message.text.trim();

  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, text);
    await setPremium(ctx.from.id, 50, 30);
    return ctx.reply(texts[lang].reviewThanks, kb(lang));
  }

  if (!text.includes('soundcloud.com')) return;

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts[lang].limitReached);
  }

  if (!queues[ctx.from.id]) queues[ctx.from.id] = [];
  queues[ctx.from.id].push(() => processTrack(ctx, text));
  ctx.reply(texts[lang].queuePosition(queues[ctx.from.id].length));

  await processNext(ctx.from.id);
// Запуск
const PORT = process.env.PORT || 3000;
bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен:', WEBHOOK_URL))
  .catch(err => console.error('❌ Webhook error:', err));

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));