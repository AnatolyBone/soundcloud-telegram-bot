const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const {
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756;

const app = express();
const bot = new Telegraf(BOT_TOKEN);

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

setInterval(() => {
  const cutoff = Date.now() - 7 * 86400_000;
  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  });
}, 3600_000);

// Тексты
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню', upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки', help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...',
    error: '❌ Ошибка', timeout: '⏱ Слишком долго...', limitReached: '🚫 Лимит достигнут.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты жми “Подтвердить оплату”',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:'
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu', upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks', help: 'ℹ️ Help',
    downloading: '🎧 Downloading...', cached: '🔁 From cache...',
    error: '❌ Error', timeout: '⏱ Timeout...', limitReached: '🚫 Limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Donate: https://boosty.to/anatoly_bone/donate\n✉️ After payment press “Confirm payment”',
    helpInfo: 'ℹ️ Just send a SoundCloud link to get mp3.\n🔓 Upgrade — pay and confirm.\n🎵 My tracks — list of today\'s downloads.\n📋 Menu — change language.',
    chooseLang: '🌐 Choose language:'
  }
};

const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help]
]).resize();

// Команды
bot.start(ctx => {
  const user = getUser(
    ctx.from.id,
    ctx.from.username || '',
    ctx.from.first_name || ''
  );
  ctx.reply(texts[user.lang].start, kb(user.lang));
});

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(\w+)/, ctx => {
  const lang = ctx.match[1];
  updateUserField(ctx.from.id, 'lang', lang);
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

bot.hears([texts.ru.upgrade, texts.en.upgrade], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].upgradeInfo);
});

bot.hears([texts.ru.help, texts.en.help], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].helpInfo);
});

bot.hears([texts.ru.mytracks, texts.en.mytracks], ctx => {
  const u = getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (list.length === 0) return ctx.reply('Сегодня нет треков.');
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

// Команда администратора
bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = getAllUsers();
  const btns = users.map(u => {
    const name = u.username ? '@' + u.username : u.id;
    const label = `${name} | ${u.downloads_today}/${u.premium_limit}`;
    return Markup.button.callback(label, `user_${u.id}`);
  });
  ctx.reply('👥 Пользователи:', Markup.inlineKeyboard(btns, { columns: 1 }));
});

bot.action(/user_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  ctx.reply('💳 Выбери тариф:', Markup.inlineKeyboard([
    Markup.button.callback('Plus (50)', `plan_${id}_50`),
    Markup.button.callback('Pro (100)', `plan_${id}_100`),
    Markup.button.callback('Unlimited (∞)', `plan_${id}_1000`)
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, lim] = ctx.match;
  setPremium(id, parseInt(lim));
  ctx.reply(`✅ Пользователю ${id} установлен лимит: ${lim}`);
});

// Получение ссылки
bot.on('text', async ctx => {
  const text = ctx.message.text;
  if (!text.includes('soundcloud.com') && !text.includes('on.soundcloud.com')) return;

  const user = getUser(ctx.from.id, ctx.from.username);

  if (ctx.from.id !== ADMIN_ID && user.downloads_today >= user.premium_limit)
    return ctx.reply(texts[user.lang].limitReached);

  await ctx.reply(texts[user.lang].downloading);

  try {
    const info = await ytdl(text, { dumpSingleJson: true });
    const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
    const fp = path.join(cacheDir, `${title}.mp3`);

    if (!fs.existsSync(fp)) {
      await ytdl(text, { extractAudio: true, audioFormat: 'mp3', output: fp });
    }

    incrementDownloads(ctx.from.id, title);

    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${title}.mp3` });
  } catch (err) {
    console.error(err);
    ctx.reply(texts[user.lang].error);
  }
});

// Webhook
(async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log('✅ Webhook установлен');
  } catch (e) {
    console.error('❌ Webhook error:', e.description || e.message);
  }
})();
app.use(express.json());
app.post('/telegram', (req, res) => {
  bot.handleUpdate(req.body).catch(console.error);
  res.sendStatus(200);
});
app.get('/', (_, res) => res.send('✅ OK'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));