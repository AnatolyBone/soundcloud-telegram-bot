const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN || 'ТВОЙ_ТОКЕН_ЗДЕСЬ';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';

const bot = new Telegraf(BOT_TOKEN);

// Простая база пользователей в памяти
let users = {};

const saveUsers = () => {
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
};

const loadUsers = () => {
  if (fs.existsSync('users.json')) {
    users = JSON.parse(fs.readFileSync('users.json'));
  }
};

loadUsers();

const texts = {
  ru: {
    start: '👋 Отправь ссылку на трек с SoundCloud, и я пришлю тебе файл!',
    menu: '📋 Меню',
    chooseLang: '🌐 Выберите язык:',
    downloading: '🎧 Загружаю трек...',
    error: '❌ Не удалось скачать трек.',
    downloaded: (n) => `📊 Скачано треков: ${n}`,
  },
  en: {
    start: '👋 Send me a SoundCloud track link and I’ll send you the file!',
    menu: '📋 Menu',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading track...',
    error: '❌ Failed to download track.',
    downloaded: (n) => `📊 Tracks downloaded: ${n}`,
  },
};

// /start
bot.start((ctx) => {
  const id = ctx.from.id;
  if (!users[id]) {
    users[id] = { lang: ctx.from.language_code.startsWith('ru') ? 'ru' : 'en', downloads: 0 };
    saveUsers();
  }
  const lang = users[id].lang;
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка меню
bot.hears(/📋 Меню|Menu/, (ctx) => {
  const lang = users[ctx.from.id]?.lang || 'en';
  ctx.reply(texts[lang].chooseLang,
    Markup.inlineKeyboard([
      Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
      Markup.button.callback('🇬🇧 English', 'lang_en'),
    ])
  );
});

// Обработка выбора языка
bot.action(/lang_(.+)/, (ctx) => {
  const lang = ctx.match[1];
  const id = ctx.from.id;
  if (!users[id]) users[id] = { lang, downloads: 0 };
  users[id].lang = lang;
  saveUsers();

  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка SoundCloud ссылок
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  const id = ctx.from.id;

  if (!url.includes('soundcloud.com')) return;

  const user = users[id] || { lang: 'en', downloads: 0 };
  users[id] = user;

  const lang = user.lang;
  await ctx.reply(texts[lang].downloading);

  try {
    // Получаем название трека
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true
    });

    const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
    const filename = path.resolve(__dirname, `${title}.mp3`);

    // Скачиваем
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filename,
    });

    user.downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename });
    fs.unlinkSync(filename);
  } catch (err) {
    console.error('yt-dlp error:', err.message);
    ctx.reply(texts[lang].error);
  }
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(bot.webhookCallback('/telegram'));

app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(3000, () => console.log('🚀 Сервер запущен на порту 3000'));
