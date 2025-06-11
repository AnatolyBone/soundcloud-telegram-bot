const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const scdl = require('soundcloud-downloader').default;
const ytdl = require('youtube-dl-exec');
const { getUser, updateUserField, incrementDownloads, setPremium, getAllUsers } = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || 'https://soundcloud-telegram-bot.onrender.com';
const PORT = process.env.PORT || 3000;
const ADMIN_ID = 2018254756;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const LANG = {
  ru: {
    start: '👋 Отправь ссылку на трек SoundCloud, и я пришлю тебе mp3 файл!',
    menu: '📋 Меню',
    choose_lang: '🌐 Выберите язык:',
    limit_reached: '⛔️ Лимит достигнут. Нажми "🔓 Расширить лимит"',
    help: 'ℹ️ Отправь ссылку на трек SoundCloud и получи mp3. Бесплатный лимит — 10 треков в день.',
    expand: '🔓 Расширить лимит',
    my_tracks: '🎶 Мои треки',
  },
  en: {
    start: '👋 Send me a SoundCloud link and I'll return the mp3 file!',
    menu: '📋 Menu',
    choose_lang: '🌐 Choose language:',
    limit_reached: '⛔️ Daily limit reached. Tap "🔓 Upgrade"',
    help: 'ℹ️ Send a SoundCloud link and get the mp3 file. Free plan: 10 tracks per day.',
    expand: '🔓 Upgrade',
    my_tracks: '🎶 My tracks',
  }
};

bot.start(ctx => {
  const user = getUser(ctx.from.id, ctx.from.username);
  const t = LANG[user.lang || 'ru'];
  ctx.reply(t.start, Markup.keyboard([[t.menu]]).resize());
});

bot.hears(/📋 Меню|📋 Menu/, ctx => {
  const user = getUser(ctx.from.id);
  const t = LANG[user.lang];
  ctx.reply(t.choose_lang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(ru|en)/, ctx => {
  updateUserField(ctx.from.id, 'lang', ctx.match[1]);
  const t = LANG[ctx.match[1]];
  ctx.editMessageText(t.start);
});

bot.hears(/🔓/, ctx => {
  ctx.reply('🚀 Хочешь больше треков?

🆓 Free – 10 🟢
Plus – 50 🎯 (59₽)
Pro – 100 💪 (119₽)
Unlimited – 💎 (199₽)

Оплата: https://boosty.to/anatoly_bone/donate
После оплаты напиши: @AnatolyBone');
});

bot.hears(/ℹ️ Help|ℹ️ Помощь/, ctx => {
  const user = getUser(ctx.from.id);
  ctx.reply(LANG[user.lang].help);
});

bot.hears(/🎶/, ctx => {
  const user = getUser(ctx.from.id);
  const tracks = user.tracks_today?.split(',') || [];
  if (tracks.length === 0) return ctx.reply('Сегодня вы ещё ничего не скачивали.');
  const batches = [];

  for (let i = 0; i < tracks.length; i += 10) {
    batches.push(tracks.slice(i, i + 10));
  }

  batches.forEach((batch, idx) => {
    ctx.reply(`🎧 Треки [${idx + 1}]:
` + batch.map(t => `• ${t}`).join('
'));
  });
});

bot.on('text', async ctx => {
  const url = ctx.message.text;
  if (!url.includes('soundcloud.com') && !url.includes('on.soundcloud.com')) return;

  const user = getUser(ctx.from.id, ctx.from.username);
  const t = LANG[user.lang];

  if (user.downloads_today >= user.premium_limit) {
    return ctx.reply(t.limit_reached);
  }

  try {
    await ctx.reply('🎵 Загружаю трек...');
    const info = await scdl.getInfo(url);
    const stream = await scdl.download(url);

    await ctx.replyWithAudio({ source: stream, filename: `${info.title}.mp3` });
    incrementDownloads(ctx.from.id, info.title);
  } catch (e) {
    try {
      const output = await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: '-' });
      await ctx.replyWithAudio({ source: output, filename: 'track.mp3' });
      incrementDownloads(ctx.from.id, 'track.mp3');
    } catch (err) {
      console.error(err);
      ctx.reply('❌ Не удалось скачать трек.');
    }
  }
});

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = getAllUsers();
  const buttons = users.map(u => Markup.button.callback(
    `@${u.username || u.id}: ${u.downloads_today}/${u.premium_limit}`, `choose_${u.id}`
  ));
  ctx.reply('👥 Пользователи:', Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/choose_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  ctx.reply(`Выбери тариф для ${id}:`, Markup.inlineKeyboard([
    Markup.button.callback('50 🎯 Plus','plan_'+id+'_50'),
    Markup.button.callback('100 💪 Pro','plan_'+id+'_100'),
    Markup.button.callback('∞ Unlimited','plan_'+id+'_1000')
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, val] = ctx.match;
  setPremium(parseInt(id), parseInt(val));
  ctx.answerCbQuery('✅ Тариф применён!');
});

bot.telegram.setWebhook(`${DOMAIN}/telegram`);
app.use(bot.webhookCallback('/telegram'));
app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(PORT, () => console.log('🚀 Listening on', PORT));