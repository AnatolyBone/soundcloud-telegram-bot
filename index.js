// index.js
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, addReview, saveTrackForUser,
  resetDailyStats, getAllReviews
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  });
}, 3600 * 1000);

// Сброс лимитов
setInterval(async () => {
  try {
    await resetDailyStats();
    console.log('✅ Daily stats reset');
  } catch (e) {
    console.error('❌ Reset stats error:', e);
  }
}, 24 * 3600 * 1000);

// Очереди
const queues = {};
const reviewMode = new Set();

// Тексты
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню', upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки', help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...',
    error: '❌ Ошибка', timeout: '⏱ Слишком долго...', limitReached: '🚫 Лимит достигнут.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты напиши: @anatolybone',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:',
    reviewAsk: '✍️ Напиши отзыв о боте. После этого получишь тариф Plus на 30 дней.',
    reviewThanks: '✅ Спасибо! Тариф Plus (50 треков/день) активирован на 30 дней.',
    alreadyReviewed: '🔒 Ты уже оставлял отзыв.',
    noTracks: 'Сегодня нет треков.',
    queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
    adminCommands:
      '\n\n📋 Команды админа:\n' +
      '/admin — статистика\n/testdb — проверить профиль\n/reviews — отзывы'
  },
  en: {
    start: '👋 Send a SoundCloud link.',
    menu: '📋 Menu', upgrade: '🔓 Upgrade',
    mytracks: '🎵 My tracks', help: 'ℹ️ Help',
    downloading: '🎧 Downloading...', cached: '🔁 From cache...',
    error: '❌ Error', timeout: '⏱ Timeout...', limitReached: '🚫 Limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Donate: https://boosty.to/anatoly_bone/donate\n✉️ After payment: @anatolybone',
    helpInfo: 'ℹ️ Just send a SoundCloud link.\n🔓 Upgrade — pay and confirm.\n🎵 My tracks — list of downloads.\n📋 Menu — change language.',
    chooseLang: '🌐 Choose language:',
    reviewAsk: '✍️ Write your review to get Plus (50/day) for 30 days.',
    reviewThanks: '✅ Thank you! Plus (50/day) is activated for 30 days.',
    alreadyReviewed: '🔒 You already submitted a review.',
    noTracks: 'No tracks today.',
    queuePosition: pos => `⏳ Added to queue (#${pos})`,
    adminCommands:
      '\n\n📋 Admin commands:\n' +
      '/admin — stats\n/testdb — check profile\n/reviews — see reviews'
  }
};

const kb = lang =>
  Markup.keyboard([
    [texts[lang].menu, texts[lang].upgrade],
    [texts[lang].mytracks, texts[lang].help],
    ['✍️ Оставить отзыв']
  ]).resize();

const getLang = u => u?.lang || 'ru';

// /start
bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

// Смена языка
bot.hears([texts.ru.menu, texts.en.menu], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});
bot.action(/lang_(\w+)/, async ctx => {
  const lang = ctx.match[1];
  await updateUserField(ctx.from.id, 'lang', lang);
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

// Кнопки
bot.hears([texts.ru.upgrade, texts.en.upgrade], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});
bot.hears([texts.ru.help, texts.en.help], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});
bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
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

// Отзывы
bot.hears('✍️ Оставить отзыв', async ctx => {
  const u = await getUser(ctx.from.id);
  if (u.reviewed) return ctx.reply(texts[getLang(u)].alreadyReviewed);
  ctx.reply(texts[getLang(u)].reviewAsk);
  reviewMode.add(ctx.from.id);
});
bot.on('text', async ctx => {
  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30);
    await updateUserField(ctx.from.id, 'reviewed', true);
    const u = await getUser(ctx.from.id);
    return ctx.reply(texts[getLang(u)].reviewThanks, kb(getLang(u)));
  }

  const url = ctx.message.text;
  if (!url.includes('soundcloud.com')) return;
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  if (u.downloads_today >= u.premium_limit) return ctx.reply(texts[lang].limitReached);
  if (!queues[ctx.from.id]) queues[ctx.from.id] = [];
  const pos = queues[ctx.from.id].length + 1;
  ctx.reply(texts[lang].queuePosition(pos));
  queues[ctx.from.id].push(() => processTrack(ctx, url));
  if (queues[ctx.from.id].length === 1) processNext(ctx.from.id);
});

// Очередь
async function processNext(userId) {
  if (!queues[userId]?.length) return;
  const job = queues[userId][0];
  await job();
  queues[userId].shift();
  if (queues[userId].length > 0) processNext(userId);
}

// Загрузка
async function processTrack(ctx, url) {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  try {
    await ctx.reply(texts[lang].downloading);
    const info = await ytdl(url, { dumpSingleJson: true });
    const name = (info.title || 'track').replace(/[^\w\d]/g, '_').slice(0, 50);
    const fp = path.join(cacheDir, `${name}.mp3`);
    if (!fs.existsSync(fp)) {
      await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: fp });
    }
    await incrementDownloads(ctx.from.id);
    await saveTrackForUser(ctx.from.id, name);
    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('❌', e);
    ctx.reply(texts[lang].error);
  }
}

// Команды админа
bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const files = fs.readdirSync(cacheDir);
  const size = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);
  const stats = {
    free: users.filter(u => u.premium_limit === 10).length,
    plus: users.filter(u => u.premium_limit === 50).length,
    pro: users.filter(u => u.premium_limit === 100).length,
    unlimited: users.filter(u => u.premium_limit >= 1000).length
  };
  const downloads = users.reduce((s, u) => s + u.total_downloads, 0);
  const lang = getLang(await getUser(ctx.from.id));
  const text = `📊 Пользователи: ${users.length}\n📥 Загрузок: ${downloads}\n📁 Кеш: ${files.length} файлов, ${(size / 1024 / 1024).toFixed(1)} MB\n\n🆓 Free: ${stats.free}\n🎯 Plus: ${stats.plus}\n💪 Pro: ${stats.pro}\n💎 Unlimited: ${stats.unlimited}`;
  ctx.reply(text + texts[lang].adminCommands);
});

bot.command('testdb', async ctx => {
  const u = await getUser(ctx.from.id);
  if (!u) return ctx.reply('Нет данных');
  ctx.reply(`ID: ${u.id}\nСкачано сегодня: ${u.downloads_today}/${u.premium_limit}`);
});

bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const reviews = await getAllReviews();
  if (!reviews.length) return ctx.reply('Нет отзывов.');
  for (const r of reviews.slice(-10)) {
    await ctx.reply(`📝 ${r.text}\n👤 ${r.userId}\n📅 ${r.time}`);
  }
});

// Webhook
app.use(bot.webhookCallback('/telegram'));
app.get('/', (_, res) => res.send('✅ OK'));

bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен'))
  .catch(err => console.error('❌ Webhook error', err));

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));