const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN || '8119729959:AAETYnCygCDclelR_Y5P1O7xIP0cbHkQuVQ';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);

// Хранилище пользователей
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const getUser = (id) => {
  if (!users[id]) users[id] = { lang: 'ru', downloads: 0 };
  return users[id];
};

// 🛡 Кэш сообщений для анти-дубликата
const recentMessages = new Set();

// Мультиязычные сообщения
const texts = {
  ru: {
    start: '👋 Отправь ссылку на трек с SoundCloud, и я пришлю тебе файл!',
    menu: '📋 Меню',
    chooseLang: '🌐 Выберите язык:',
    downloading: '🎧 Загружаю трек...',
    error: '❌ Не удалось скачать трек.',
    downloaded: (n) => `📊 Скачано треков: ${n}`
  },
  en: {
    start: '👋 Send me a SoundCloud track link and I’ll send you the file!',
    menu: '📋 Menu',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading the track...',
    error: '❌ Failed to download track.',
    downloaded: (n) => `📊 Tracks downloaded: ${n}`
  }
};

// Команда /start
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  const lang = user.lang;
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка кнопки меню
bot.hears([texts.ru.menu, texts.en.menu], (ctx) => {
  const lang = getUser(ctx.from.id).lang;
  ctx.reply(texts[lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});

// Выбор языка
bot.action(/lang_(.+)/, (ctx) => {
  const id = ctx.from.id;
  const lang = ctx.match[1];
  const user = getUser(id);
  user.lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка сообщений
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const messageId = ctx.message.message_id;
  const url = ctx.message.text;
  const lang = getUser(id).lang;

  // 🛡 Защита от повторной обработки
  const uniqueKey = `${id}_${messageId}`;
  if (recentMessages.has(uniqueKey)) return;
  recentMessages.add(uniqueKey);
  setTimeout(() => recentMessages.delete(uniqueKey), 60000);

  if (!url.includes('soundcloud.com')) return;

  await ctx.reply(texts[lang].downloading);

  try {
    // Получение названия
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true
    });
    const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
    const filename = path.resolve(__dirname, `${title}.mp3`);

    // Скачивание
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filename
    });

    users[id].downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename });
    fs.unlinkSync(filename);
  } catch (err) {
    console.error('yt-dlp error:', err.message);
    ctx.reply(texts[lang].error);
  }
});

// ✅ Устанавливаем Webhook
bot.telegram.setWebhook(WEBHOOK_URL);

// ✅ Обрабатываем Webhook вручную (чтобы ответить мгновенно!)
app.post('/telegram', express.json(), (req, res) => {
  res.sendStatus(200); // моментальный ответ Telegram
  bot.handleUpdate(req.body).catch((err) => {
    console.error('Ошибка при обработке update:', err);
  });
});

// Статус страницы
app.get('/', (req, res) => res.send('✅ Бот работает!'));

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});