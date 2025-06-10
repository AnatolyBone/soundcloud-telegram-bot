const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const scdl = require('soundcloud-downloader').default;
const youtubedl = require('youtube-dl-exec');
const path = require('path');

const BOT_TOKEN = '8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram'; // поменяй на свой URL
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};

// Тексты на двух языках
const texts = {
  ru: {
    start: 'Привет! Пришли ссылку на трек SoundCloud, и я вышлю тебе файл.',
    downloading: '🎵 Пытаюсь скачать трек...',
    error: '❌ Не удалось скачать трек. Попробуй другую ссылку.',
    chooseLang: '🌐 Выберите язык:',
    menu: 'Меню',
  },
  en: {
    start: 'Hello! Send me a SoundCloud track link and I will send you the file.',
    downloading: '🎵 Trying to download the track...',
    error: '❌ Failed to download the track. Try another link.',
    chooseLang: '🌐 Choose your language:',
    menu: 'Menu',
  }
};

// Сохраняем и загружаем пользователей с языком и статистикой
function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}
function getUser(id) {
  if (!users[id]) users[id] = { downloads: 0, lang: 'ru' };
  return users[id];
}

// --- Команда /start ---
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  saveUsers();
  ctx.reply(texts[user.lang].start, Markup.keyboard([[texts[user.lang].menu]]).resize());
});

// --- Обработка выбора языка через callback ---
bot.action(/lang_(.+)/, async (ctx) => {
  const lang = ctx.match[1];
  const user = getUser(ctx.from.id);
  user.lang = lang;
  saveUsers();

  await ctx.answerCbQuery(); // убирает "часики"
  await ctx.editMessageText(texts[lang].chooseLang, {
    reply_markup: {
      inline_keyboard: [
        [{ text: lang === 'ru' ? '🇷🇺 Русский' : '🇷🇺 Russian', callback_data: 'lang_ru' }],
        [{ text: lang === 'en' ? '🇬🇧 English' : '🇬🇧 Английский', callback_data: 'lang_en' }]
      ]
    }
  });
});

// --- Кнопка меню ---
bot.hears([texts.ru.menu, texts.en.menu], (ctx) => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});

// --- Обработка SoundCloud-ссылок ---
bot.on('text', async (ctx) => {
  const url = ctx.message.text;
  const user = getUser(ctx.from.id);

  // Если это кнопка меню, уже обработали выше, значит тут только ссылки
  if (!url.includes('soundcloud.com')) return;

  await ctx.reply(texts[user.lang].downloading);

  try {
    // Попытка через soundcloud-downloader
    const info = await scdl.getInfo(url);
    const stream = await scdl.download(url);

    user.downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: stream, filename: `${info.title}.mp3` });
  } catch (scdlErr) {
    console.warn('SCDL не сработал, пробуем yt-dlp...', scdlErr.message);

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
      fs.unlinkSync(filename); // удаляем файл после отправки
    } catch (ytErr) {
      console.error('yt-dlp тоже не сработал:', ytErr.message);
      ctx.reply(texts[user.lang].error);
    }
  }
});

// --- Webhook ---
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(bot.webhookCallback('/telegram'));

app.get('/', (req, res) => res.send('✅ Бот работает!'));

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});