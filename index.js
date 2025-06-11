const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756;  // твой Telegram ID

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// ——— Пользователи ———
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const todayStr = () => new Date().toISOString().split('T')[0];
const getUser = id => {
  if (!users[id]) {
    users[id] = { lang: 'ru', downloads: 0, premiumLimit: 10, date: todayStr(), count: 0, tracksToday: [] };
  }
  return users[id];
};

// ——— Очереди ———
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
  const task = q.shift();
  try { await task(); } catch (e) { console.error(`Queue error ${uid}:`, e); }
  userProcessing.delete(uid);
  processQueue(uid);
}

// ——— Кеш ———
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
function cleanCache() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  });
}
setInterval(cleanCache, 3600000);
cleanCache();

// ——— Тексты и кнопки ———
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
    limitReached: '🚫 Лимит 10 треков сегодня достигнут.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n' +
      '🆓 Free – 10 🟢\n' +
      'Plus – 50 🎯 (59₽)\n' +
      'Pro – 100 💪 (119₽)\n' +
      'Unlimited – 💎 (199₽)\n\n' +
      '👉 Оплата: https://boosty.to/anatoly_bone/donate\n' +
      '✉️ После оплаты напиши: @AnatolyBone',
    helpInfo:
      'ℹ️ Просто пришли ссылку на трек — бот скачает mp3.\n' +
      '🔓 «Расширить лимит» – выбрать тариф.\n' +
      '🎵 «Мои треки» – список скачанного за день.\n' +
      '📋 «Меню» – смена языка.',
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
    timeout: '⏱ Took too long. Try again later.',
    limitReached: '🚫 You reached 10 tracks today.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n' +
      '🆓 Free – 10\n' +
      'Plus – 50 (59₽)\n' +
      'Pro – 100 (119₽)\n' +
      'Unlimited – 💎 (199₽)\n\n' +
      '👉 Donate: https://boosty.to/anatoly_bone/donate\n' +
      '✉️ After payment, message me: @AnatolyBone',
    helpInfo:
      'ℹ️ Just send a track link — bot will download mp3.\n' +
      '🔓 "Upgrade limit" — choose your plan.\n' +
      '🎵 "My tracks" — your downloads today.\n' +
      '📋 "Menu" — change language.',
    chooseLang: '🌐 Choose language:'
  }
};
const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help]
]).resize();

// ——— Обработка ———
bot.start(ctx => { const u = getUser(ctx.from.id); ctx.reply(texts[u.lang].start, kb(u.lang)); });

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});
bot.action(/lang_(.+)/, ctx => {
  const lang = ctx.match[1], u = getUser(ctx.from.id);
  u.lang = lang; saveUsers();
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
bot.hears([texts.ru.mytracks, texts.en.mytracks], ctx => {
  const u = getUser(ctx.from.id);
  const list = u.tracksToday.join('\n') || '—';
  ctx.reply(`🎵 ${u.lang === 'ru' ? 'Сегодня скачано' : 'Today downloaded'}:\n${list}`);
});

bot.command('stats', ctx => { const u = getUser(ctx.from.id); ctx.reply(`📊 Всего скачано: ${u.downloads}\n📅 Сегодня: ${u.count}`); });

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const all = Object.keys(users);
  const totalDownloads = all.reduce((s, id) => s + (users[id].downloads || 0), 0);
  const files = fs.readdirSync(cacheDir);
  const cacheSize = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);
  const last = all.slice(-5).map(id => `• ${id} — ${users[id].count}/${users[id].premiumLimit}`).join('\n') || '—';
  ctx.reply(
    `👥 Пользователей: ${all.length}\n` +
    `🎵 Всего треков: ${totalDownloads}\n` +
    `📁 Кеш: ${files.length} файлов, ${(cacheSize/1024/1024).toFixed(1)} MB\n\n` +
    `🕵️ Последние: \n${last}`
  );
});

bot.command('setlimit', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, uid, cnt] = ctx.message.text.split(' ');
  if (!uid || !cnt || !users[uid]) return ctx.reply('Usage: /setlimit <userId> <count>');
  users[uid].premiumLimit = +cnt; saveUsers();
  ctx.reply(`🛠 Лимит пользователя ${uid} установлен на ${cnt}`);
});

bot.command('reset', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, uid] = ctx.message.text.split(' ');
  if (!uid || !users[uid]) return ctx.reply('Usage: /reset <userId>');
  const u = users[uid];
  u.count = 0; u.tracksToday = []; u.date = todayStr();
  saveUsers();
  ctx.reply(`♻️ Счетчик пользователя ${uid} сброшен`);
});

const recent = new Set();
bot.on('text', ctx => {
  const id = ctx.from.id, text = ctx.message.text;
  if (!text.includes('soundcloud.com')) return;
  const key = `${id}_${ctx.message.message_id}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);

  const u = getUser(id);
  addToQueue(id, async () => {
    if (u.date !== todayStr()) {
      u.date = todayStr(); u.count = 0; u.tracksToday = [];
    }
    if (id !== ADMIN_ID && u.count >= u.premiumLimit) {
      return ctx.reply(texts[u.lang].limitReached);
    }

    await ctx.reply(texts[u.lang].downloading);
    try {
      const info = await youtubedl(text, { dumpSingleJson: true });
      const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const filePath = path.join(cacheDir, `${title}.mp3`);
      if (!fs.existsSync(filePath)) {
        await youtubedl(text, { extractAudio: true, audioFormat: 'mp3', output: filePath });
      }
      u.count++; u.downloads++; u.tracksToday.push(title);
      saveUsers();
      await ctx.replyWithAudio({ source: fs.createReadStream(filePath), filename: title + '.mp3' });
    } catch (e) {
      console.error(e);
      ctx.reply(e.message.includes('timeout') ? texts[u.lang].timeout : texts[u.lang].error);
    }
  });
});

(async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log('✅ Webhook установлен');
  } catch (err) {
    console.warn('⚠️ Не удалось установить webhook:', err.description || err.message);
  }
})();
app.use(express.json());
app.post('/telegram', (req, res) => { res.sendStatus(200); bot.handleUpdate(req.body).catch(console.error); });
app.get('/', (_, res) => res.send('✅ OK'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 Сервер запущен'));