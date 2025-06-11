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

// Пользователи
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const getUser = (id) => {
  if (!users[id]) users[id] = { lang: 'ru', downloads: 0 };
  return users[id];
};

// 🛡 Защита от дубликатов
const recentMessages = new Set();

// Языковые сообщения
const texts = {
  ru: {
    start: '👋 Отправь ссылку на трек с SoundCloud, и я пришлю тебе файл!',
    menu: '📋 Меню',
    chooseLang: '🌐 Выберите язык:',
    downloading: '🎧 Загружаю трек...',
    error: '❌ Не удалось скачать трек.',
    timeout: '⏱ Трек слишком долго загружается. Попробуй позже или другой трек.',
    downloaded: (n) => `📊 Скачано треков: ${n}`
  },
  en: {
    start: '👋 Send me a SoundCloud track link and I’ll send you the file!',
    menu: '📋 Menu',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading the track...',
    error: '❌ Failed to download track.',
    timeout: '⏱ The track took too long to download. Try again later or use a different link.',
    downloaded: (n) => `📊 Tracks downloaded: ${n}`
  }
};

// Команда /start
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  const lang = user.lang;
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Меню
bot.hears([texts.ru.menu, texts.en.menu], (ctx) => {
  const lang = getUser(ctx.from.id).lang;
  ctx.reply(texts[lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});

// Смена языка
bot.action(/lang_(.+)/, (ctx) => {
  const id = ctx.from.id;
  const lang = ctx.match[1];
  const user = getUser(id);
  user.lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка ссылок
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const messageId = ctx.message.message_id;
  const url = ctx.message.text;
  const lang = getUser(id).lang;

  const uniqueKey = `${id}_${messageId}`;
  if (recentMessages.has(uniqueKey)) return;
  recentMessages.add(uniqueKey);
  setTimeout(() => recentMessages.delete(uniqueKey), 60000);

  if (!url.includes('soundcloud.com')) return;

  await ctx.reply(texts[lang].downloading);

  try {
    // Получение информации
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true,
      execOptions: { timeout: 300000 } // ✅ 5 минут
    });

    const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
    const filename = path.resolve(__dirname, `${title}.mp3`);

    // Загрузка аудио
    await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filename,
      execOptions: { timeout: 300000 } // ✅ 5 минут
    });

    users[id].downloads += 1;
    saveUsers();

    await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename });
    fs.unlinkSync(filename);
  } catch (err) {
    console.error('yt-dlp error:', err.message);

    if (err.message && err.message.includes('timed out')) {
      ctx.reply(texts[lang].timeout);
    } else {
      ctx.reply(texts[lang].error);
    }
  }
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);

app.post('/telegram', express.json(), (req, res) => {
  res.sendStatus(200); // мгновенный ответ
  bot.handleUpdate(req.body).catch((err) => {
    console.error('Ошибка при обработке update:', err);
  });
});

app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));