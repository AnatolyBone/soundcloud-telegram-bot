const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express(); // <--- ЭТА СТРОКА БЫЛА ОТСУТСТВУЮЩЕЙ

const BOT_TOKEN = process.env.BOT_TOKEN || '...твой токен...';
const ADMIN_ID = 2018254756; // ← замени на свой Telegram ID
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);

// === USERS ===
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const todayStr = () => new Date().toISOString().split('T')[0];
const getUser = (id) => {
  if (!users[id]) users[id] = { lang: 'ru', downloads: 0, date: todayStr(), count: 0 };
  return users[id];
};

// === CACHE ===
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

function cleanCache() {
  const files = fs.readdirSync(cacheDir);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let total = 0, size = 0;
  files.forEach(file => {
    const filePath = path.join(cacheDir, file);
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
    } else {
      total++;
      size += stats.size;
    }
  });
  return { total, size };
}
setInterval(cleanCache, 60 * 60 * 1000);
cleanCache();

// === QUEUE ===
const userQueues = new Map();
const userProcessing = new Set();
function addToQueue(userId, task) {
  if (!userQueues.has(userId)) userQueues.set(userId, []);
  userQueues.get(userId).push(task);
  processQueue(userId);
}
async function processQueue(userId) {
  if (userProcessing.has(userId)) return;
  const queue = userQueues.get(userId);
  if (!queue?.length) return;
  userProcessing.add(userId);
  const task = queue.shift();
  try { await task(); } catch (e) { console.error(e.message); }
  userProcessing.delete(userId);
  processQueue(userId);
}

// === TEXTS ===
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud, и я пришлю тебе файл!',
    menu: '📋 Меню',
    chooseLang: '🌐 Выберите язык:',
    downloading: '🎧 Загружаю трек...',
    cached: '🔁 Отправляю из кеша...',
    error: '❌ Не удалось скачать трек.',
    timeout: '⏱ Слишком долго. Попробуй позже.',
    limit: '🚫 Лимит 10 треков в день достигнут.'
  },
  en: {
    start: '👋 Send a SoundCloud track link and I’ll send you the file!',
    menu: '📋 Menu',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading the track...',
    cached: '🔁 Sending from cache...',
    error: '❌ Failed to download track.',
    timeout: '⏱ Took too long. Try again later.',
    limit: '🚫 Daily limit of 10 tracks reached.'
  }
};

// === BOT ===
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].start, Markup.keyboard([[texts[user.lang].menu]]).resize());
});
bot.hears([texts.ru.menu, texts.en.menu], (ctx) => {
  const lang = getUser(ctx.from.id).lang;
  ctx.reply(texts[lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')],
  ]));
});
bot.action(/lang_(.+)/, (ctx) => {
  const id = ctx.from.id;
  const lang = ctx.match[1];
  getUser(id).lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// === /stats ===
bot.command('stats', (ctx) => {
  const u = getUser(ctx.from.id);
  ctx.reply(`📊 Скачано: ${u.downloads}\n📅 Сегодня: ${u.count}`);
});

// === /admin ===
bot.command('admin', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const totalUsers = Object.keys(users).length;
  const totalDownloads = Object.values(users).reduce((sum, u) => sum + u.downloads, 0);
  const c = cleanCache();
  const mb = (c.size / 1024 / 1024).toFixed(2);
  ctx.reply(`👥 Пользователей: ${totalUsers}\n🎵 Всего треков: ${totalDownloads}\n📁 Кеш: ${c.total} файлов / ${mb} MB`);
});

// === TRACK DOWNLOAD ===
const recent = new Set();
bot.on('text', (ctx) => {
  const id = ctx.from.id;
  const msgId = ctx.message.message_id;
  const url = ctx.message.text;
  const user = getUser(id);
  const lang = user.lang;

  const key = `${id}_${msgId}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);
  if (!url.includes('soundcloud.com')) return;

  addToQueue(id, async () => {
    if (user.date !== todayStr()) {
      user.date = todayStr();
      user.count = 0;
    }

    if (id !== ADMIN_ID && user.count >= 10) {
      return ctx.reply(texts[lang].limit);
    }

    await ctx.reply(texts[lang].downloading);
    try {
      const info = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        flatPlaylist: true,
        execOptions: { timeout: 300000 }
      });

      const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const filename = path.resolve(cacheDir, `${title}.mp3`);

      if (fs.existsSync(filename)) {
        await ctx.reply(texts[lang].cached);
        await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename: title });
      } else {
        await youtubedl(url, {
          extractAudio: true,
          audioFormat: 'mp3',
          output: filename,
          execOptions: { timeout: 300000 }
        });

        user.downloads++;
        user.count++;
        saveUsers();
        await ctx.replyWithAudio({ source: fs.createReadStream(filename), filename: title });
      }
    } catch (e) {
      console.error('yt-dlp error:', e.message);
      ctx.reply(e.message.includes('timed out') ? texts[lang].timeout : texts[lang].error);
    }
  });
});

// === WEBHOOK ===
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(express.json());
app.post('/telegram', (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (req, res) => res.send('✅ Бот работает!'));
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));