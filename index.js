const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756; // Замените на свой Telegram ID

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// === Пользователи ===
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const todayStr = () => new Date().toISOString().split('T')[0];

function getUser(id) {
  if (!users[id]) {
    users[id] = {
      lang: 'ru',
      downloads: 0,
      premiumLimit: 10,
      date: todayStr(),
      count: 0,
      tracksToday: []
    };
  }
  return users[id];
}

// === Очереди ===
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
  if (!q?.length) return;
  userProcessing.add(uid);
  const t = q.shift();
  try { await t(); }
  catch (e) { console.error(`Queue error for ${uid}:`, e); }
  userProcessing.delete(uid);
  processQueue(uid);
}

// === Кеш ===
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

function cleanCache() {
  const now = Date.now();
  const cutoff = now - 7 * 24 * 3600 * 1000;
  const today = todayStr();

  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    const stats = fs.statSync(filePath);
    const mtime = stats.mtime.toISOString().split('T')[0];

    if (stats.mtimeMs < cutoff && mtime !== today) {
      fs.unlinkSync(filePath);
    }
  });
}
setInterval(cleanCache, 3600_000);
cleanCache();

// === Тексты ===
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Help',
    downloading: '🎧 Загружаю трек...',
    cached: '🔁 Отправляю из кеша...',
    error: '❌ Не удалось скачать трек.',
    timeout: '⏱ Слишком долго. Попробуй позже.',
    limitReached: '🚫 Достигнут лимит треков сегодня.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n' +
      '🆓 Free – 10 🟢\n' +
      'Plus – 50 🎯 (59₽)\n' +
      'Pro – 100 💪 (119₽)\n' +
      'Unlimited – 💎 (199₽)\n\n' +
      '👉 Оплата: https://boosty.to/anatoly_bone/donate\n' +
      '✉️ После оплаты напиши: @AnatolyBone',
    helpInfo:
      'ℹ️ Просто пришли ссылку на трек — и получишь mp3.\n' +
      '🔓 Расширить лимит — выбрать тариф и оплатить.\n' +
      '🎵 Мои треки — получить все треки за сегодня.\n' +
      '📋 Меню — переключение языка.',
    chooseLang: '🌐 Выберите язык:'
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu',
    upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks',
    help: 'ℹ️ Help',
    downloading: '🎧 Downloading...',
    cached: '🔁 Sending from cache...',
    error: '❌ Failed to download.',
    timeout: '⏱ Took too long. Try later.',
    limitReached: '🚫 Daily download limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n' +
      '🆓 Free – 10\n' +
      'Plus – 50 🎯 (59₽)\n' +
      'Pro – 100 💪 (119₽)\n' +
      'Unlimited – 💎 (199₽)\n\n' +
      '👉 Donate: https://boosty.to/anatoly_bone/donate\n' +
      '✉️ After payment, DM me: @AnatolyBone',
    helpInfo:
      'ℹ️ Just send a track link — receive mp3.\n' +
      '🔓 Upgrade limit — pick a plan and pay.\n' +
      '🎵 My tracks — get all today’s downloads.\n' +
      '📋 Menu — switch language.',
    chooseLang: '🌐 Choose language:'
  }
};

const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help]
]).resize();

// === Команды ===
bot.start(ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].start, kb(u.lang));
});

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].chooseLang,
    Markup.inlineKeyboard([
      Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
      Markup.button.callback('🇬🇧 English', 'lang_en')
    ])
  );
});

bot.action(/lang_(.+)/, ctx => {
  const lang = ctx.match[1];
  const u = getUser(ctx.from.id);
  u.lang = lang;
  saveUsers();
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

// === Мои треки — отправка mp3 пачками по 10 ===
bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const u = getUser(ctx.from.id);
  if (u.tracksToday.length === 0) {
    return ctx.reply(u.lang === 'ru' ? 'Сегодня ничего не скачано.' : 'No downloads today.');
  }

  const media = u.tracksToday.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp }, title: name } : null;
  }).filter(Boolean);

  if (media.length === 0) {
    return ctx.reply(u.lang === 'ru' ? 'Файлы не найдены в кеше.' : 'Files not found in cache.');
  }

  for (let i = 0; i < media.length; i += 10) {
    const chunk = media.slice(i, i + 10);
    await ctx.replyWithMediaGroup(chunk);
  }
});

// === Статистика ===
bot.command('stats', ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(`📊 Total downloaded: ${u.downloads}\n📅 Today: ${u.count}`);
});

// === Админ-панель ===
const formatSizeMB = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const ids = Object.keys(users);
  const totalDownloads = ids.reduce((sum, id) => sum + users[id].downloads, 0);
  const files = fs.readdirSync(cacheDir);
  const cacheBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(cacheDir, f)).size, 0);
  const last = ids.slice(-5).map(id => `• ${id} — ${users[id].count}/${users[id].premiumLimit}`).join('\n') || '—';

  ctx.reply(
    `👥 Users: ${ids.length}\n` +
    `🎵 Total tracks: ${totalDownloads}\n` +
    `📁 Cache: ${files.length} files, ${formatSizeMB(cacheBytes)}\n\n` +
    `🕵️ Recent users:\n${last}`
  );
});

bot.command('setlimit', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [cmd, uid, cnt] = ctx.message.text.split(' ');
  if (!uid || !cnt || !users[uid]) return ctx.reply('Usage: /setlimit <userId> <count>');
  users[uid].premiumLimit = +cnt;
  saveUsers();
  ctx.reply(`🛠 Set user ${uid} limit to ${cnt}`);
});

bot.command('reset', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [cmd, uid] = ctx.message.text.split(' ');
  if (!uid || !users[uid]) return ctx.reply('Usage: /reset <userId>');
  const u = users[uid];
  u.count = 0;
  u.tracksToday = [];
  u.date = todayStr();
  saveUsers();
  ctx.reply(`♻️ Reset stats for ${uid}`);
});

// === Обработка ссылок ===
const recent = new Set();
bot.on('text', ctx => {
  const text = ctx.message.text;
  if (!text.includes('soundcloud.com')) return;
  const u = getUser(ctx.from.id);
  const key = `${ctx.from.id}_${ctx.message.message_id}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);

  addToQueue(ctx.from.id, async () => {
    if (u.date !== todayStr()) {
      u.date = todayStr();
      u.count = 0;
      u.tracksToday = [];
    }
    if (ctx.from.id !== ADMIN_ID && u.count >= u.premiumLimit) {
      return ctx.reply(texts[u.lang].limitReached);
    }

    await ctx.reply(texts[u.lang].downloading);
    try {
      const info = await youtubedl(text, { dumpSingleJson: true });
      const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const fp = path.join(cacheDir, `${title}.mp3`);
      if (!fs.existsSync(fp)) {
        await youtubedl(text, { extractAudio: true, audioFormat: 'mp3', output: fp });
      }
      u.count++;
      u.downloads++;
      u.tracksToday.push(title);
      saveUsers();

      await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${title}.mp3` });
    } catch (e) {
      console.error(e);
      ctx.reply(e.message.includes('timeout') ? texts[u.lang].timeout : texts[u.lang].error);
    }
  });
});

// === Webhook ===
(async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log('✅ Webhook установлен');
  } catch (err) {
    console.warn('⚠️ Webhook setup failed:', err.description || err.message);
  }
})();
app.use(express.json());
app.post('/telegram', (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (req, res) => res.send('✅ OK'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 Bot started'));