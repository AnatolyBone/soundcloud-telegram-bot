const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const crypto = require('crypto');

const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, resetDailyStats, addReview,
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://soundcloud-telegram-bot.onrender.com/telegram';

if (!BOT_TOKEN || !ADMIN_ID || !process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.error('❌ Ошибка: не заданы обязательные переменные окружения!');
  process.exit(1);
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша старше 7 дней, каждый час
setInterval(() => {
  try {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    fs.readdirSync(cacheDir).forEach(file => {
      const fp = path.join(cacheDir, file);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    });
  } catch (err) {
    console.error('Ошибка очистки кеша:', err);
  }
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(async () => {
  try {
    await resetDailyStats();
    console.log('✅ Ежедневная статистика сброшена');
  } catch (err) {
    console.error('❌ Ошибка сброса статистики:', err);
  }
}, 24 * 3600 * 1000);

// Очереди пользователей
const queues = {};
const processing = {};
const reviewMode = new Set();

// Языковые тексты
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
    upgradeInfo: '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты напиши: @anatolybone',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:',
    reviewAsk: '✍️ Напиши свой отзыв о боте. После этого ты получишь тариф Plus на 30 дней.',
    reviewThanks: '✅ Спасибо за отзыв! Тебе выдан тариф Plus (50 треков/день) на 30 дней.',
    alreadyReviewed: 'Ты уже оставил отзыв 😊 Спасибо!',
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

async function enqueue(userId, job) {
  if (!queues[userId]) queues[userId] = [];
  queues[userId].push(job);
  if (!processing[userId]) {
    processing[userId] = true;
    while (queues[userId].length > 0) {
      const task = queues[userId].shift();
      try {
        await task();
      } catch (err) {
        console.error('Ошибка в очереди:', err);
      }
    }
    processing[userId] = false;
  }
}

async function processTrack(ctx, url) {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  try {
    await ctx.reply(texts[lang].downloading);
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

    await incrementDownloads(ctx.from.id, name);
    await saveTrackForUser(ctx.from.id, name);
    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('Ошибка обработки трека:', e);
    await ctx.reply(texts[lang].error);
  }
}

// Telegram бот
bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

bot.hears(texts.ru.menu, async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(\w+)/, async ctx => {
  const lang = ctx.match[1];
  await updateUserField(ctx.from.id, 'lang', lang);
  await ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

bot.hears(texts.ru.upgrade, async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});

bot.hears(texts.ru.help, async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});

bot.hears('✍️ Оставить отзыв', async ctx => {
  if (await hasLeftReview(ctx.from.id)) {
    const u = await getUser(ctx.from.id);
    return ctx.reply(texts[getLang(u)].alreadyReviewed);
  }
  ctx.reply(texts.ru.reviewAsk);
  reviewMode.add(ctx.from.id);
});

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const users = await getAllUsers();
  const files = fs.readdirSync(cacheDir);
  const size = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);
  const downloads = users.reduce((s, u) => s + u.total_downloads, 0);
  const stats = {
    free: users.filter(u => u.premium_limit === 10).length,
    plus: users.filter(u => u.premium_limit === 50).length,
    pro: users.filter(u => u.premium_limit === 100).length,
    unlimited: users.filter(u => u.premium_limit >= 1000).length
  };

  const u = await getUser(ctx.from.id);
  const lang = getLang(u);

  const msg = `📊 Пользователей: ${users.length}\n📥 Загрузок всего: ${downloads}\n📁 Кеш: ${files.length} файлов, ${(size / 1024 / 1024).toFixed(1)} MB\n\n` +
              `Тарифы:\n🆓 Free: ${stats.free}\n🔓 Plus: ${stats.plus}\n🔥 Pro: ${stats.pro}\n💎 Unlimited: ${stats.unlimited}`;

  await ctx.reply(msg + texts[lang].adminCommands);
});

bot.command('testdb', async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(`ID: ${u.id}\nСегодня: ${u.downloads_today}/${u.premium_limit}`);
});

bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const reviews = await getLatestReviews(20);
    if (!reviews.length) return ctx.reply('❌ Нет отзывов.');
    for (const r of reviews) {
      await ctx.reply(`📝 ${r.text}\n🕒 ${r.time}`);
    }
  } catch {
    ctx.reply('❌ Ошибка при получении отзывов');
  }
});

bot.hears(texts.ru.mytracks, async ctx => {
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply(texts[getLang(u)].noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

bot.on('text', async ctx => {
  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30);
    const u = await getUser(ctx.from.id);
    return ctx.reply(texts[getLang(u)].reviewThanks, kb(getLang(u)));
  }

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) return;
  await resetDailyLimitIfNeeded(ctx.from.id);
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts[lang].limitReached);
  }

  await enqueue(ctx.from.id, async () => {
    await ctx.reply(texts[lang].queuePosition(queues[ctx.from.id].length));
    await processTrack(ctx, url);
  });
});

// Webhook
app.use(bot.webhookCallback('/telegram'));

// Админка
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));

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

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.get('/', (_, res) => res.send('✅ OK'));

const PORT = process.env.PORT || 3000;
bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен:', WEBHOOK_URL))
  .catch(err => console.error('❌ Webhook error:', err));

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));