const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = process.env.BOT_TOKEN || '...твой токен...';
const ADMIN_ID = 2018254756; // ← замени на свой телеграм id
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);

// Хранилище
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const getUser = id => {
  if (!users[id]) users[id] = { lang: 'ru', downloads: 0, date: todayStr(), count: 0 };
  return users[id];
};

// Дата в формате YYYY-MM-DD
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// Очистка кеша
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

function cleanCache() {
  const files = fs.readdirSync(cacheDir);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let total = 0, size = 0;
  files.forEach(fn => {
    const fp = path.join(cacheDir, fn);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fp);
    } else {
      total++;
      size += stat.size;
    }
  });
  return { total, size };
}
setInterval(cleanCache, 60 * 60 * 1000);
cleanCache();

// Очереди per user
const userQueues = new Map();
const userProcessing = new Set();

function addToQueue(uid, task) {
  if (!userQueues.has(uid)) userQueues.set(uid, []);
  userQueues.get(uid).push(task);
  processQueue(uid);
}
async function processQueue(uid) {
  if (userProcessing.has(uid)) return;
  const q = userQueues.get(uid);
  if (!q || !q.length) return;
  userProcessing.add(uid);
  const task = q.shift();
  try { await task(); }
  catch(err) { console.error(`User ${uid} queue error:`, err.message); }
  userProcessing.delete(uid);
  processQueue(uid);
}

// Антидуп
const recent = new Set();

// Языковые тексты
const texts = {
  ru: { start: '👋 Пришли ссылку...', menu: '📋 Меню', chooseLang: '🌐 Выберите язык:',
         downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...', error: '❌ Ошибка', 
         timeout: '⏱ Долго загружается...', limit: '🚫 Более 10 треков сегодня.' },
  en: { start: '👋 Send link...', menu: '📋 Menu', chooseLang: '🌐 Choose language:',
         downloading: '🎧 Downloading...', cached: '🔁 From cache...', error: '❌ Error',
         timeout: '⏱ Took too long...', limit: '🚫 Over 10 tracks today.' }
};

// /start
bot.start(ctx => {
  const usr = getUser(ctx.from.id);
  usr.lang = usr.lang || 'ru';
  saveUsers();
  ctx.reply(texts[usr.lang].start, Markup.keyboard([[texts[usr.lang].menu]]).resize());
});

// Меню / language
bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const usr = getUser(ctx.from.id);
  ctx.reply(texts[usr.lang].chooseLang, Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});
bot.action(/lang_(.+)/, ctx => {
  const id = ctx.from.id, lang = ctx.match[1];
  getUser(id).lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, Markup.keyboard([[texts[lang].menu]]).resize());
});

// /stats
bot.command('stats', ctx => {
  const usr = getUser(ctx.from.id);
  ctx.reply(`📊 Сегодня: ${usr.count} треков, всего: ${usr.downloads}`);
});

// /admin
bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const totalUsers = Object.keys(users).length;
  const totalDownloads = Object.values(users).reduce((a,u)=>a+u.downloads,0);
  const c = cleanCache();
  ctx.reply(
    `👤 Пользователей: ${totalUsers}\n` +
    `🎶 Треков качнуто: ${totalDownloads}\n` +
    `📂 Cache: ${c.total} файлов, ${(c.size/1024/1024).toFixed(2)} MB`
  );
});

// Треки
bot.on('text', ctx => {
  const id = ctx.from.id, msgId = ctx.message.message_id;
  const url = ctx.message.text;
  const usr = getUser(id);
  const lang = usr.lang;
  if (recent.has(`${id}_${msgId}`)) return;
  recent.add(`${id}_${msgId}`);
  setTimeout(()=>recent.delete(`${id}_${msgId}`),60000);
  if (!url.includes('soundcloud.com')) return;

  addToQueue(id, async () => {
    if (usr.date !== todayStr()) {
      usr.date = todayStr();
      usr.count = 0;
    }
    if (id !== ADMIN_ID && usr.count >= 10) {
      ctx.reply(texts[lang].limit);
      return;
    }
    await ctx.reply(texts[lang].downloading);

    try {
      const info = await youtubedl(url, {
        dumpSingleJson: true, noWarnings: true, flatPlaylist: true,
        execOptions: { timeout: 300000 }
      });
      const safe = info.title.replace(/[<>:"/\\|?*]+/g,'');
      const fn = path.resolve(cacheDir, safe + '.mp3');

      if (fs.existsSync(fn)) {
        await ctx.reply(texts[lang].cached);
        await ctx.replyWithAudio({ source: fs.createReadStream(fn), filename: safe });
      } else {
        await youtubedl(url, {
          extractAudio: true, audioFormat:'mp3',
          output: fn, execOptions: { timeout:300000 }
        });
        usr.downloads++;
        usr.count++;
        saveUsers();
        await ctx.replyWithAudio({ source: fs.createReadStream(fn), filename: safe });
      }
    } catch(err) {
      console.error('yt-dlp error:',err.message);
      ctx.reply(err.message.includes('timed out')? texts[lang].timeout : texts[lang].error);
    }
  });
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(express.json());
app.post('/telegram', (req,res)=>{
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (req,res)=>res.send('✅ OK'));
app.listen(PORT, ()=>console.log(`🚀 on ${PORT}`));