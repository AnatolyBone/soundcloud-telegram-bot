const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756;

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// --- Users storage ---
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const todayStr = () => new Date().toISOString().split('T')[0];

function getUser(id) {
  const uid = id.toString();
  if (!users[uid]) {
    users[uid] = {
      lang: 'ru', downloads: 0, premiumLimit: 10,
      date: todayStr(), count: 0, tracksToday: [], username: null
    };
  }
  return users[uid];
}

// --- Logger ---
const logFile = './logs.json';
function logEvent(data) {
  const logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : [];
  logs.push({ time: new Date().toISOString(), ...data });
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

// --- Queue ---
const queues = new Map(), processing = new Set();
function addToQueue(uid, task) {
  if (!queues.has(uid)) queues.set(uid, []);
  queues.get(uid).push(task);
  processQueue(uid);
}
async function processQueue(uid) {
  if (processing.has(uid)) return;
  const q = queues.get(uid);
  if (!q?.length) return;
  processing.add(uid);
  const fn = q.shift();
  try { await fn(); }
  catch (e) { console.error('Queue error:', e); }
  processing.delete(uid);
  processQueue(uid);
}

// --- Cache ---
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
function cleanCache() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const today = todayStr();
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    const st = fs.statSync(fp);
    const mday = st.mtime.toISOString().split('T')[0];
    if (st.mtimeMs < cutoff && mday !== today) fs.unlinkSync(fp);
  });
}
setInterval(cleanCache, 3600_000);
cleanCache();

// --- Texts & keyboards ---
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню', upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки', help: 'ℹ️ Help',
    downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...',
    error: '❌ Ошибка', timeout: '⏱ Долго...', limitReached: '🚫 Лимит достигнут.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Оплата: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты жми “Подтвердить оплату”',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплатить и подтвердить.\n🎵 Мои треки — все треки за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:'
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu', upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks', help: 'ℹ️ Help',
    downloading: '🎧 Downloading...', cached: '🔁 From cache...',
    error: '❌ Error', timeout: '⏱ Too long...', limitReached: '🚫 Limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Donate: https://boosty.to/anatoly_bone/donate\n✉️ After payment press “Confirm payment”',
    helpInfo: 'ℹ️ Just send link and get mp3.\n🔓 Upgrade — pay and confirm.\n🎵 My tracks — all tracks today.\n📋 Menu — change language.',
    chooseLang: '🌐 Choose language:'
  }
};
const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help]
]).resize();

const tierName = (lim) => {
  if (lim >= 1000) return 'Unlimited 💎';
  if (lim >= 100) return 'Pro';
  if (lim >= 50) return 'Plus';
  return 'Free 🆓';
};

// --- Bot handlers ---
bot.start(ctx => {
  const u = getUser(ctx.from.id);
  if (!u.username) u.username = ctx.from.username;
  saveUsers();
  ctx.reply(texts[u.lang].start, kb(u.lang));
});

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
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

bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const u = getUser(ctx.from.id);
  if (u.tracksToday.length === 0) return ctx.reply(u.lang === 'ru' ? 'Сегодня нет треков.' : 'No tracks today.');
  const media = u.tracksToday.map(n => {
    const fp = path.join(cacheDir, `${n}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp }, title: n } : null;
  }).filter(Boolean);
  if (media.length === 0) return ctx.reply(u.lang === 'ru' ? 'Файлы не найдены.' : 'Files not found.');
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const ids = Object.keys(users);
  const totalDownloads = ids.reduce((s, id) => s + users[id].downloads, 0);
  const files = fs.readdirSync(cacheDir);
  const cacheSize = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);

  const btns = ids.map(id => {
    const u = users[id];
    const name = u.username ? '@'+u.username : id;
    return Markup.button.callback(`${name}: ${u.count} | ${tierName(u.premiumLimit)}`, `choose_${id}`);
  });

  const summary = 
    `👥 Users: ${ids.length}\n🎵 Total downloads: ${totalDownloads}\n📁 Cache: ${files.length} files, ${(cacheSize/1024/1024).toFixed(1)} MB\n\n` +
    `Выбери пользователя, чтобы обновить лимит:`;

  ctx.reply(summary, Markup.inlineKeyboard(btns, { columns: 1 }));
});

bot.action(/choose_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  const u = users[id];
  if (!u) return ctx.answerCbQuery('Пользователь не найден.');

  ctx.reply(`Установи тариф для ${u.username ? '@'+u.username : id}:`, Markup.inlineKeyboard([
    Markup.button.callback('50 🎯 Plus', `plan_${id}_50`),
    Markup.button.callback('100 💪 Pro', `plan_${id}_100`),
    Markup.button.callback('∞ Unlimited', `plan_${id}_1000`)
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, val] = ctx.match;
  const u = users[id];
  if (!u) return ctx.answerCbQuery('Пользователь не найден.');

  u.premiumLimit = parseInt(val, 10);
  saveUsers();
  ctx.answerCbQuery('Лимит обновлён');
  ctx.reply(`✅ @${u.username || id} теперь имеет лимит: ${tierName(u.premiumLimit)}`);
});

// --- Main logic ---
const recent = new Set();
bot.on('text', ctx => {
  const text = ctx.message.text;
  if (!text.includes('soundcloud.com')) return;
  const key = `${ctx.from.id}_${ctx.message.message_id}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);

  const u = getUser(ctx.from.id);
  addToQueue(ctx.from.id, async () => {
    if (u.date !== todayStr()) {
      u.date = todayStr(); u.count = 0; u.tracksToday = [];
    }

    if (ctx.from.id !== ADMIN_ID && u.count >= u.premiumLimit) {
      ctx.reply(texts[u.lang].limitReached);
      logEvent({ user_id: ctx.from.id, username: ctx.from.username, result: 'limit', url: text });
      return;
    }

    await ctx.reply(texts[u.lang].downloading);

    try {
      const info = await youtubedl(text, { dumpSingleJson: true });
      const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const fp = path.join(cacheDir, `${title}.mp3`);
      if (!fs.existsSync(fp)) {
        await youtubedl(text, { extractAudio: true, audioFormat: 'mp3', output: fp });
      }

      u.tracksToday.push(title);
      u.count++; u.downloads++;
      saveUsers();
      logEvent({ user_id: ctx.from.id, username: ctx.from.username, result: 'success', title });

      await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${title}.mp3` });

    } catch (e) {
      console.error(e);
      ctx.reply(e.message.includes('timeout') ? texts[u.lang].timeout : texts[u.lang].error);
      logEvent({ user_id: ctx.from.id, username: ctx.from.username, result: 'error', error: e.message });
    }
  });
});

// --- Webhook setup ---
(async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log('✅ Webhook установлен');
  } catch (e) {
    console.warn('⚠️ Webhook error:', e.description || e.message);
  }
})();
app.use(express.json());
app.post('/telegram', (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (_, res) => res.send('✅ OK'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 Bot started'));