const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN || '...твой токен...';
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

// Кеш
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очередь по каждому пользователю
const userQueues = new Map();
const userProcessing = new Set();

function addToUserQueue(userId, task) {
  if (!userQueues.has(userId)) userQueues.set(userId, []);
  userQueues.get(userId).push(task);
  processUserQueue(userId);
}

async function processUserQueue(userId) {
  if (userProcessing.has(userId)) return;

  const queue = userQueues.get(userId);
  if (!queue || queue.length === 0) return;

  userProcessing.add(userId);
  const task = queue.shift();

  try {
    await task();
  } catch (err) {
    console.error(`Ошибка в очереди пользователя ${userId}:`, err.message);
  }

  userProcessing.delete(userId);
  if (queue.length > 0) processUserQueue(userId);
}

// 🛡 Защита от дубликатов
const recentMessages = new Set();

// Тексты
const texts = {
  ru: {
    start: '👋 Отправь ссылку на трек с SoundCloud, и я пришлю тебе файл!',
    menu: '📋 Меню',
    chooseLang: '🌐 Выберите язык:',
    downloading: '🎧 Загружаю трек...',
    cached: '🔁 Отправляю из кеша...',
    error: '❌ Не удалось скачать трек.',
    timeout: '⏱ Слишком долго. Попробуй позже.'
  },
  en: {
    start: '👋 Send a SoundCloud track link and I’ll send you the file!',
    menu: '📋 Menu',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading the track...',
    cached: '🔁 Sending from cache...',
    error: '❌ Failed to download track.',
    timeout: '⏱ Took too long. Try again later.'
  }
};

// /start
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].start, Markup.keyboard([[texts[user.lang].menu]]).resize());
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
  getUser(id).lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// Обработка ссылок
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const msgId = ctx.message.message_id;
  const url = ctx.message.text;
  const lang = getUser(id).lang;

  const uniqueKey = `${id}_${msgId}`;
  if (recentMessages.has(uniqueKey)) return;
  recentMessages.add(uniqueKey);
  setTimeout(() => recentMessages.delete(uniqueKey), 60000);
  if (!url.includes('soundcloud.com')) return;

  addToUserQueue(id, async () => {
    await ctx.reply(texts[lang].downloading);

    try {
      const info = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        flatPlaylist: true,
        execOptions: { timeout: 300000 }
      });

      const safeTitle = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const filename = path.resolve(cacheDir, `${safeTitle}.mp3`);

      if (fs.existsSync(filename)) {
        await ctx.reply(texts[lang].cached);
        await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename: safeTitle });
        return;
      }

      await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: filename,
        execOptions: { timeout: 300000 }
      });

      users[id].downloads += 1;
      saveUsers();

      await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename: safeTitle });
    } catch (err) {
      console.error('yt-dlp error:', err.message);
      if (err.message.includes('timed out')) {
        ctx.reply(texts[lang].timeout);
      } else {
        ctx.reply(texts[lang].error);
      }
    }
  });
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);
app.post('/telegram', express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));