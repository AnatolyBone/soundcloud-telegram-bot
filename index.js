const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const { google } = require('googleapis');
const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, addReview, saveTrackForUser
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша раз в час
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  });
}, 3600 * 1000);

const { resetDailyStats } = require('./db');

// Ежедневный сброс статистики (раз в сутки)
setInterval(async () => {
  try {
    await resetDailyStats();
    console.log('✅ Daily stats reset');
  } catch (err) {
    console.error('❌ Failed to reset daily stats:', err);
  }
}, 24 * 60 * 60 * 1000); // раз в 24 часа
// Очередь загрузки: ID пользователя → массив задач
const queues = {};

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
    reviewAsk: '✍️ Напиши свой отзыв о боте. После этого ты получишь тариф Plus на 30 дней.',
    reviewThanks: '✅ Спасибо за отзыв! Тебе выдан тариф Plus (50 треков/день) на 30 дней.',
    noTracks: 'Сегодня нет треков.',
    queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu', upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks', help: 'ℹ️ Help',
    downloading: '🎧 Downloading...', cached: '🔁 From cache...',
    error: '❌ Error', timeout: '⏱ Timeout...', limitReached: '🚫 Limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Donate: https://boosty.to/anatoly_bone/donate\n✉️ After payment message: @anatolybone',
    helpInfo: 'ℹ️ Just send a SoundCloud link to get mp3.\n🔓 Upgrade — pay and confirm.\n🎵 My tracks — list of today\'s downloads.\n📋 Menu — change language.',
    chooseLang: '🌐 Choose language:',
    reviewAsk: '✍️ Write your review about the bot. You will receive Plus plan (50 tracks/day) for 30 days.',
    reviewThanks: '✅ Thank you! You’ve got Plus (50 tracks/day) for 30 days.',
    noTracks: 'No tracks today.',
    queuePosition: pos => `⏳ Added to queue (#${pos})`,
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
  const u = ctx.from;
  await createUser(u.id, u.username, u.first_name);
  const user = await getUser(u.id);
  ctx.reply(texts[getLang(user)].start, kb(getLang(user)));
});

// Меню
bot.hears([texts.ru.menu, texts.en.menu], async ctx => {
  const user = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(user)].chooseLang, Markup.inlineKeyboard([
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

// Апгрейд / помощь
bot.hears([texts.ru.upgrade, texts.en.upgrade], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});
bot.hears([texts.ru.help, texts.en.help], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});

// Отзывы
const reviewMode = new Set();
bot.hears('✍️ Оставить отзыв', async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].reviewAsk);
  reviewMode.add(ctx.from.id);
});
bot.on('text', async ctx => {
  if (reviewMode.has(ctx.from.id)) {
    reviewMode.delete(ctx.from.id);
    await addReview(ctx.from.id, ctx.message.text);
    await setPremium(ctx.from.id, 50, 30); // 30 дней тарифа Plus
    const u = await getUser(ctx.from.id);
    return ctx.reply(texts[getLang(u)].reviewThanks, kb(getLang(u)));
  }

  const url = ctx.message.text;
  if (!url.includes('soundcloud.com')) return;

  const user = await getUser(ctx.from.id);
  const lang = getLang(user);
  if (user.downloads_today >= user.premium_limit) return ctx.reply(texts[lang].limitReached);

  if (!queues[ctx.from.id]) queues[ctx.from.id] = [];
  const pos = queues[ctx.from.id].length + 1;
  ctx.reply(texts[lang].queuePosition(pos));
  queues[ctx.from.id].push(() => processTrack(ctx, url));
  if (queues[ctx.from.id].length === 1) processNext(ctx.from.id);
});

async function processNext(userId) {
  if (!queues[userId] || queues[userId].length === 0) return;
  const job = queues[userId][0];
  await job();
  queues[userId].shift();
  if (queues[userId].length > 0) processNext(userId);
}

async function processTrack(ctx, url) {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  try {
    await ctx.reply(texts[lang].downloading);
    const info = await ytdl(url, { dumpSingleJson: true });
    const name = (info.title || 'track').replace(/[^\w\d]/g, '_').slice(0, 50);
    const fp = path.join(cacheDir, `${name}.mp3`);
    if (!fs.existsSync(fp)) {
      await ytdl(url, {
        extractAudio: true, audioFormat: 'mp3', output: fp
      });
    }
    await incrementDownloads(ctx.from.id, name);
    await saveTrackForUser(ctx.from.id, name);
    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('❌', e);
    ctx.reply(texts[lang].error);
  }
}

// Мои треки
bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply(texts[getLang(u)].noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

app.use(bot.webhookCallback('/telegram'));
app.get('/', (_, res) => res.send('✅ OK'));

bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен'))
  .catch(err => console.error('❌ Webhook error', err));

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));