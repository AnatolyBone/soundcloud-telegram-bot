const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs').promises;
const path = require('path');
const ytdl = require('youtube-dl-exec');

const {
  createUser, getUser, incrementDownloads, saveTrackForUser,
  setPremium, getAllUsers, resetDailyStats, addReview,
  hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded,
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

// Очистка кеша старше 7 дней
async function cleanCache() {
  try {
    const files = await fs.readdir(cacheDir);
    const cutoff = Date.now() - 7 * 86400 * 1000;
    await Promise.all(files.map(async file => {
      const fp = path.join(cacheDir, file);
      const stat = await fs.stat(fp);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(fp);
      }
    }));
  } catch (e) {
    console.error('Ошибка очистки кеша:', e);
  }
}
setInterval(cleanCache, 3600 * 1000);

// Тексты, клавиатуры (пример для ru)
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

const reviewMode = new Set();

const queues = {};
const processing = {};

// Обёртка с таймаутом
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function processTrack(userId, url) {
  const u = await getUser(userId);
  const lang = getLang(u);

  try {
    await bot.telegram.sendMessage(userId, texts[lang].downloading);

    let info = await getTrackMetadata(url);
    if (!info) {
      info = await withTimeout(ytdl(url, { dumpSingleJson: true }), 15000);
      await saveTrackMetadata(url, info);
    }

    let name = (info.title || 'track')
      .replace(/[^\w\s\-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);

    const fp = path.join(cacheDir, `${name}.mp3`);

    let needDownload = true;
    try {
      const stat = await fs.stat(fp);
      if (Date.now() - stat.mtimeMs < 7 * 86400 * 1000) needDownload = false;
    } catch {}

    if (needDownload) {
      await withTimeout(ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: fp }), 120000);
    }

    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);

    await bot.telegram.sendAudio(userId, { source: await fs.readFile(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('Ошибка обработки трека:', e);
    await bot.telegram.sendMessage(userId, texts[lang].error);
  }
}

async function enqueue(userId, url) {
  if (!queues[userId]) queues[userId] = [];
  queues[userId].push(url);

  if (processing[userId]) return;

  processing[userId] = true;

  while (queues[userId].length > 0) {
    const nextUrl = queues[userId].shift();
    await processTrack(userId, nextUrl);
  }

  processing[userId] = false;
}

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
    [texts[lang].menu, '✍️ Оставить отзыв']
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
  await ctx.reply(texts[lang].queuePosition(queues[ctx.from.id].length));
});

// Остальной код по админке, webhook, express, и т.п. без изменений

app.use(bot.webhookCallback('/telegram'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));

// ... остальные роуты и сервер ...

const PORT = process.env.PORT || 3000;

bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен:', WEBHOOK_URL))
  .catch(err => console.error('❌ Webhook error:', err));

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));