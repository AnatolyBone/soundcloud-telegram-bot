const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');

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

🆓 Free – 10
Plus – 50 (59₽)
Pro – 100 (119₽)
Unlimited – 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

👫 Приглашай друзей и получай 1 день тарифа Plus за каждого.`,
  helpInfo: 'ℹ️ Пришли ссылку и получи mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — твоя статистика.',
  reviewAsk: '✍️ Напиши отзыв. После этого ты получишь тариф Plus на 30 дней.',
  reviewThanks: '✅ Спасибо за отзыв! Выдан тариф Plus на 30 дней.',
  alreadyReviewed: 'Ты уже оставлял отзыв. Спасибо!',
  noTracks: 'Сегодня нет треков.',
  queuePosition: pos => `⏳ Трек в очереди (#${pos})`,
  adminCommands: '\n\nКоманды админа:\n/admin\n/testdb\n/reviews\n/backup'
};

const kb = Markup.keyboard([
  [texts.menu, texts.upgrade],
  [texts.mytracks, texts.help],
  ['✍️ Оставить отзыв']
]).resize();

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
  try {
    await ctx.reply(texts.downloading);
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
    await ctx.reply(texts.error);
  }
}

// Telegram бот
bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  ctx.reply(texts.start, kb);
});

bot.hears(texts.menu, async ctx => {
  const u = await getUser(ctx.from.id);
  const now = new Date();
  const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / (1000 * 60 * 60 * 24)) : 0;
  const refLink = `https://t.me/SCloudMusicBot?start=${ctx.from.id}`;

  const msg = `👋 Рады видеть вас снова, ${u.first_name}!\n\n` +
              `💼 Ваш тариф: ${u.premium_limit === 10 ? 'Free' :
                            u.premium_limit === 50 ? 'Plus' :
                            u.premium_limit === 100 ? 'Pro' : 'Unlimited'}\n` +
              `⏳ Дней до окончания тарифа: ${daysLeft > 0 ? daysLeft : '0'}\n\n` +
              `👫 Приглашено друзей: ${u.referred_count || 0}\n` +
              `🎁 Начислено дней Plus: ${u.referred_count || 0}\n\n` +
              `🔗 Ваша реферальная ссылка:\n${refLink}`;

  ctx.reply(msg, Markup.keyboard([
    [texts.mytracks, texts.upgrade],
    ['✍️ Оставить отзыв']
  ]).resize());
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

bot.on('text', async ctx => {
  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30);
    return ctx.reply(texts.reviewThanks, kb);
  }

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) return;

  await resetDailyLimitIfNeeded(ctx.from.id);

  const u = await getUser(ctx.from.id);
  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached);
  }

  await enqueue(ctx.from.id, async () => {
    await ctx.reply(texts.queuePosition(queues[ctx.from.id].length));
    await processTrack(ctx, url);
  });
});

// Webhook
app.use(bot.webhookCallback('/telegram'));

// Админка и остальные express-роуты (login, dashboard и т.п.) оставляем без изменений

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

app.post('/broadcast', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).send('Пустое сообщение');
  try {
    const users = await getAllUsers();
    let count = 0;
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.id, `📢 ${message}`);
        count++;
      } catch (err) {
        console.error(`Не удалось отправить сообщение ${user.id}`, err.message);
      }
    }
    console.log(`✅ Рассылка отправлена ${count} пользователям`);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('❌ Ошибка рассылки:', e);
    res.status(500).send('Ошибка рассылки');
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