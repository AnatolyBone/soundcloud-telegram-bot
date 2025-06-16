const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const {
  getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756;

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// --- Cache ---
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

function cleanCache() {
  const cutoff = Date.now() - 7 * 86400_000;
  const today = new Date().toISOString().split('T')[0];
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    const st = fs.statSync(fp);
    const mday = st.mtime.toISOString().split('T')[0];
    if (st.mtimeMs < cutoff && mday !== today) fs.unlinkSync(fp);
  });
}
setInterval(cleanCache, 3600_000);
cleanCache();

// --- Texts & Keyboards ---
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню', upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки', help: 'ℹ️ Help',
    downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...',
    error: '❌ Ошибка', timeout: '⏱ Долго...',
    limitReached: '🚫 Лимит достигнут.',
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
    error: '❌ Error', timeout: '⏱ Too long...',
    limitReached: '🚫 Limit reached.',
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

// --- Очередь загрузки ---
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

// --- Handlers ---
bot.start(ctx => {
  const user = getUser(ctx.from.id, ctx.from.username || '');
  ctx.reply(texts[user.lang].start, kb(user.lang));
});

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(.+)/, ctx => {
  const lang = ctx.match[1];
  updateUserField(ctx.from.id, 'lang', lang);
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

bot.hears([texts.ru.upgrade, texts.en.upgrade], ctx => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].upgradeInfo);
});

bot.hears([texts.ru.help, texts.en.help], ctx => {
  const user = getUser(ctx.from.id);
  ctx.reply(texts[user.lang].helpInfo);
});

bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const user = getUser(ctx.from.id);
  const trackNames = user.tracks_today?.split(',').filter(Boolean) || [];
  if (trackNames.length === 0) return ctx.reply(user.lang === 'ru' ? 'Сегодня нет треков.' : 'No tracks today.');
  const media = trackNames.map(n => {
    const fp = path.join(cacheDir, `${n}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  if (!media.length) return ctx.reply(user.lang === 'ru' ? 'Файлы не найдены.' : 'Files not found.');
  for (let i = 0; i < media.length; i += 10) {
    await ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

// --- Админка ---
bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = getAllUsers();
  const total = users.reduce((s, u) => s + u.total_downloads, 0);
  const cacheFiles = fs.readdirSync(cacheDir);
  const cacheSize = cacheFiles.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);

  const buttons = users.map(u => {
    const name = u.username ? '@' + u.username : u.id;
    return Markup.button.callback(`${name} | ${u.downloads_today}/${u.premium_limit}`, `edit_${u.id}`);
  });

  const summary =
    `👥 Users: ${users.length}\n🎵 Total downloads: ${total}\n📁 Cache: ${cacheFiles.length} files, ${(cacheSize / 1024 / 1024).toFixed(1)} MB\n\nВыбери пользователя:`;

  ctx.reply(summary, Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/edit_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  ctx.reply(`Выбери тариф:`, Markup.inlineKeyboard([
    Markup.button.callback('50 🎯 Plus', `plan_${id}_50`),
    Markup.button.callback('100 💪 Pro', `plan_${id}_100`),
    Markup.button.callback('∞ Unlimited', `plan_${id}_1000`)
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, lim] = ctx.match;
  setPremium(+id, +lim);
  ctx.answerCbQuery('Обновлено');
});

// --- Загрузка треков ---
const recent = new Set();
bot.on('text', ctx => {
  const url = ctx.message.text;
  if (!url.includes('soundcloud.com')) return;
  const key = `${ctx.from.id}_${ctx.message.message_id}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);

  const user = getUser(ctx.from.id, ctx.from.username || '');
  addToQueue(ctx.from.id, async () => {
    if (user.downloads_today >= user.premium_limit && ctx.from.id !== ADMIN_ID) {
      return ctx.reply(texts[user.lang].limitReached);
    }

    await ctx.reply(texts[user.lang].downloading);
    try {
      const info = await youtubedl(url, { dumpSingleJson: true });
      const title = (info.title || 'track').replace(/[<>:"/\\|?*]+/g, '');
      const fp = path.join(cacheDir, `${title}.mp3`);
      if (!fs.existsSync(fp)) {
        await youtubedl(url, {
          extractAudio: true, audioFormat: 'mp3', output: fp
        });
      }

      incrementDownloads(ctx.from.id, title);
      await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${title}.mp3` });

    } catch (err) {
      console.error(err);
      ctx.reply(err.message.includes('timeout') ? texts[user.lang].timeout : texts[user.lang].error);
    }
  });
});

// --- Webhook ---
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