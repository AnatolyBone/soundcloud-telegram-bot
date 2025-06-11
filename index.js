const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN || '…твой токен…';
const ADMIN_ID = 2018254756; // <— твой Telegram ID
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const PORT = process.env.PORT || 3000;

// Настройка бота
const bot = new Telegraf(BOT_TOKEN);

// Данные пользователей
const usersFile = './users.json';
let users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : {};
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
const todayStr = () => new Date().toISOString().split('T')[0];
const getUser = id => {
  if (!users[id]) {
    users[id] = {
      lang: 'ru',
      downloads: 0,
      premiumLimit: 10,      // текущий лимит
      date: todayStr(),
      count: 0,
      tracksToday: []
    };
  }
  return users[id];
};

// Кеш директория
const cacheDir = path.resolve(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша (7 дней)
function cleanCache() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  fs.readdirSync(cacheDir).forEach(fn => {
    const fp = path.join(cacheDir, fn);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  });
}
setInterval(cleanCache, 3600000);
cleanCache();

// Очереди по пользователям
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
  if (!q || q.length === 0) return;
  userProcessing.add(uid);
  const task = q.shift();
  try { await task(); }
  catch (e) { console.error(`Queue error ${uid}:`, e.message); }
  userProcessing.delete(uid);
  processQueue(uid);
}

// Анти-дубликаты
const recent = new Set();

// Тексты
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню',
    upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки',
    help: 'ℹ️ Help',
    chooseLang: '🌐 Выберите язык:',
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
      'Unlimited – безлимит 💎 (199₽)\n\n' +
      'Оплата через Boosty: https://boosty.to/ТВОЙ_АККАУНТ\n' +
      'После оплаты пришли мне в лс твой Telegram.',
    helpInfo:
      '❓ *Функции бота:*\n' +
      '- Автоматически скачивает треки с SoundCloud\n' +
      '- Лимит бесплатно – 10 треков/день\n' +
      '- Можно расширить лимит кнопкой “🔓 Расширить лимит”\n' +
      '- Кнопка “🎵 Мои треки” покажет все треки за сегодня\n' +
      '- Язык через “📋 Меню”\n' +
      '- Админ может выдать лимит через `/setlimit`\n' +
      '\n💡 После оплаты лимит будет автоматически увеличен.',
    setByAdmin: id => `🛠 Лимит пользователя ${id} установлен вручную.`
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu',
    upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks',
    help: 'ℹ️ Help',
    chooseLang: '🌐 Choose language:',
    downloading: '🎧 Downloading track...',
    cached: '🔁 Sending from cache...',
    error: '❌ Failed to download.',
    timeout: '⏱ Too long. Try later.',
    limitReached: '🚫 You reached 10 tracks today.',
    upgradeInfo:
      '🚀 Want more?\n\n' +
      '🆓 Free – 10 🟢\n' +
      'Plus – 50 🎯 (59₽)\n' +
      'Pro – 100 💪 (119₽)\n' +
      'Unlimited – Infinite 💎 (199₽)\n\n' +
      'Pay via Boosty: https://boosty.to/YOUR_ACCOUNT\n' +
      'After payment, message me your Telegram.',
    helpInfo:
      '❓ *Bot features:*\n' +
      '- Auto-downloads SoundCloud tracks\n' +
      '- Free limit – 10 tracks/day\n' +
      '- Upgrade via “🔓 Upgrade limit”\n' +
      '- “🎵 My tracks” shows today’s downloads\n' +
      '- Language switch via “📋 Menu”\n' +
      '- Admin can set limits with `/setlimit`\n' +
      '\n💡 Limit increases after payment.',
    setByAdmin: id => `🛠 User ${id} limit set manually.`
  }
};

// Клавиатура (4 кнопки)
function getMainKeyboard(lang) {
  return Markup.keyboard([
    [texts[lang].menu, texts[lang].upgrade],
    [texts[lang].mytracks, texts[lang].help]
  ]).resize();
}

// Start
bot.start(ctx => {
  const usr = getUser(ctx.from.id);
  ctx.reply(texts[usr.lang].start, getMainKeyboard(usr.lang));
});

// Язык
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
  const id = ctx.from.id, lang = ctx.match[1];
  getUser(id).lang = lang;
  saveUsers();
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, getMainKeyboard(lang));
});

// Upgrade лимит
bot.hears(texts.ru.upgrade, ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].upgradeInfo, { parse_mode: 'Markdown' });
});
bot.hears(texts.en.upgrade, ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].upgradeInfo, { parse_mode: 'Markdown' });
});

// My tracks
bot.hears(texts.ru.mytracks, ctx => {
  const u = getUser(ctx.from.id);
  const list = u.tracksToday.join('\n') || '—';
  ctx.reply(`🎵 Сегодня скачано:\n${list}`);
});
bot.hears(texts.en.mytracks, ctx => {
  const u = getUser(ctx.from.id);
  const list = u.tracksToday.join('\n') || '—';
  ctx.reply(`🎵 Today's downloads:\n${list}`);
});

// Help
bot.hears(texts.ru.help, ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].helpInfo, { parse_mode: 'Markdown' });
});
bot.hears(texts.en.help, ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].helpInfo, { parse_mode: 'Markdown' });
});

// Статистика
bot.command('stats', ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(`📊 Всего скачано: ${u.downloads}, сегодня: ${u.count}`);
});

// Админ команда /setlimit <id> <count>
bot.command('setlimit', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, uid, cnt] = ctx.message.text.split(' ');
  if (!uid || !cnt || !users[uid]) return ctx.reply('Usage: /setlimit <userId> <count>');
  users[uid].premiumLimit = +cnt;
  saveUsers();
  ctx.reply(texts['ru'].setByAdmin(uid));
});

// Загрузка треков
bot.on('text', ctx => {
  const id = ctx.from.id, mId = ctx.message.message_id;
  const url = ctx.message.text, u = getUser(id);
  const lang = u.lang;

  const key = `${id}_${mId}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 60000);

  if (!url.includes('soundcloud.com')) return;

  addToQueue(id, async () => {
    if (u.date !== todayStr()) {
      u.date = todayStr();
      u.count = 0;
      u.tracksToday = [];
    }

    if (id !== ADMIN_ID && u.count >= u.premiumLimit) {
      return ctx.reply(texts[lang].limitReached);
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
      const filePath = path.join(cacheDir, `${title}.mp3`);

      if (fs.existsSync(filePath)) {
        await ctx.reply(texts[lang].cached);
      } else {
        await youtubedl(url, {
          extractAudio: true,
          audioFormat: 'mp3',
          output: filePath,
          execOptions: { timeout: 300000 }
        });
        u.downloads++;
      }

      u.count++;
      u.tracksToday.push(title);
      saveUsers();

      await ctx.replyWithAudio({
        source: fs.createReadStream(filePath),
        filename: title
      });
    } catch (e) {
      console.error(e.message);
      ctx.reply(e.message.includes('timed out') ? texts[lang].timeout : texts[lang].error);
    }
  });
});

// Webhook
bot.telegram.setWebhook(WEBHOOK_URL);
app.use(express.json());
app.post('/telegram', (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(console.error);
});
app.get('/', (req, res) => res.send('✅ OK'));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));