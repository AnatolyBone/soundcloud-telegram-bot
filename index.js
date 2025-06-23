const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs/promises');      // асинхронный fs
const fsSync = require('fs');           // синхронный fs для existsSync и createReadStream
const ytdl = require('youtube-dl-exec');

const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, resetDailyStats, addReview,
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded,
  getTrackMetadata, saveTrackMetadata
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
(async () => {
  try {
    await fs.access(cacheDir);
  } catch {
    await fs.mkdir(cacheDir);
  }
})();

// Асинхронная очистка кеша старше 7 дней каждый час
setInterval(async () => {
  try {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    const files = await fs.readdir(cacheDir);

    for (const file of files) {
      const fp = path.join(cacheDir, file);
      const stat = await fs.stat(fp);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(fp);
      }
    }
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

// Очереди и обработка треков — отдельно для каждого пользователя
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

Если вы хотите скачивать больше треков в день, можете воспользоваться одним из тарифов ниже:

🆓 Free – 10 🟢
Plus – 50 🎯 (59₽)
Pro – 100 💪 (119₽)
Unlimited – 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

👫 Пригласите друзей в наш сервис и получите 1 день тарифа “Plus” на баланс за каждого друга.`,
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

// Основная функция добавления задачи в очередь
async function enqueue(userId, url) {
  if (!queues[userId]) queues[userId] = [];
  queues[userId].push(url);

  if (processing[userId]) return;

  processing[userId] = true;

  while (queues[userId].length > 0) {
    const trackUrl = queues[userId].shift();
    try {
      // Сообщаем позицию, 1 — потому что только что вытащили из очереди
      await bot.telegram.sendMessage(userId, texts.ru.queuePosition(queues[userId].length + 1));
      await processTrackByUrl(userId, trackUrl);
    } catch (err) {
      console.error(`Ошибка в очереди пользователя ${userId}:`, err);
      await bot.telegram.sendMessage(userId, texts.ru.error);
    }
  }

  processing[userId] = false;
}

// Обработка трека с кешем метаданных
async function processTrackByUrl(userId, url) {
  const u = await getUser(userId);
  const lang = getLang(u);

  try {
    await bot.telegram.sendMessage(userId, texts[lang].downloading);

    // Пробуем получить метаданные из кеша
    let info = await getTrackMetadata(url);

    if (!info) {
      // Если нет — запрашиваем через ytdl
      info = await ytdl(url, { dumpSingleJson: true });
      await saveTrackMetadata(url, info);
    }

    // Формируем имя файла
    let name = (info.title || 'track')
      .replace(/[^\w\s\-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);

    const fp = path.join(cacheDir, `${name}.mp3`);

    if (!fsSync.existsSync(fp)) {
      // Загружаем трек
      await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: fp });
    }

    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);

    // Отправляем аудио
    await bot.telegram.sendAudio(userId, { source: fsSync.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('Ошибка обработки трека:', e);
    await bot.telegram.sendMessage(userId, texts[lang].error);
  }
}

// Обработчики команд и сообщений

bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

bot.hears(texts.ru.menu, async ctx => {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);

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
    [texts[lang].mytracks, texts[lang].upgrade],
    ['📋 Меню', '✍️ Оставить отзыв']
  ]).resize());
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

  await enqueue(ctx.from.id, url);
});

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const users = await getAllUsers();
  const files = await fs.readdir(cacheDir);
  const size = files.reduce((s, f) => s + fsSync.statSync(path.join(cacheDir, f)).size, 0);
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
  if (ctx.from.id !== ADMIN_ID) return;
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
    return fsSync.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

// Webhook
app.use(bot.webhookCallback('/telegram'));

// Админка на express + ejs (твой существующий код, без изменений)

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
  if (![10, 50, 100, 1000].includes(parsedLimit)) return res.status(400).send('Invalid limit');

  await setPremium(userId, parsedLimit);
  res.redirect('/dashboard');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Бот запущен');
});

// Запуск бота на webhook
bot.launch({
  webhook: {
    domain: WEBHOOK_URL,
    port: process.env.PORT || 3000,
    hookPath: '/telegram'
  }
});