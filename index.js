const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = '8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};

const texts = {
  ru: {
    start: 'Привет! Пришли ссылку на трек SoundCloud, и я вышлю тебе файл.',
    downloading: '🎵 Скачиваю трек через yt-dlp...',
    error: '❌ Не удалось скачать. Попробуй другую ссылку.',
    chooseLang: '🌐 Выберите язык:',
    menu: 'Меню'
  },
  en: {
    start: 'Hello! Send me a SoundCloud track link and I will send you the file.',
    downloading: '🎵 Downloading the track using yt-dlp...',
    error: '❌ Failed to download. Try another link.',
    chooseLang: '🌐 Choose your language:',
    menu: 'Menu'
  }
};

function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}
function getUser(id) {
  if (!users[id]) users[id] = { downloads: 0, lang: 'ru' };
  return users[id];
}

// Команда /start
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  saveUsers();
  ctx.reply(texts[user.lang].start, Markup.keyboard([[texts[user.lang].menu]]).resize());
});

// Меню и выбор языка
bot.hears([texts.ru.menu, texts.en.menu], (ctx) => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});
bot.action(/lang_(.+)/, async (ctx) => {
  const lang = ctx.match[1];
  const user = getUser(ctx.from.id);
  user.lang = lang;
  saveUsers();
  await ctx.answerCbQuery();
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка SoundCloud ссылок
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  const user = getUser(ctx.from.id);
  if (!url.includes('soundcloud.com')) return;

  await ctx.reply(texts[user.lang].downloading);

  try {
    const filename = path.resolve(__dirname, `track_${Date.now()}.mp3`);
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filename
    });

    user.downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename: path.basename(filename) });
    fs.unlinkSync(filename);
  } catch (err) {
    console.error('yt-dlp error:', err.message);
    ctx.reply(texts[user.lang].error);
  }
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(bot.webhookCallback('/telegram'));

app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));