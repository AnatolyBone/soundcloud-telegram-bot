const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const { exec } = require('child_process');
const {
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers
} = require('./db');

// --- Google Drive API ---
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const KEYFILEPATH = path.join(__dirname, 'service-account.json');

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

async function uploadBackup(filename, filepath) {
  try {
    const response = await drive.files.create({
      requestBody: {
        name: filename,
        parents: ['1FjRTVO4rLCsKdeIg452M4-1MjpmfuChG'], // ВАЖНО: твой ID папки на Google Drive
      },
      media: {
        body: fs.createReadStream(filepath),
      },
    });
    console.log('Backup uploaded, file ID:', response.data.id);
  } catch (error) {
    console.error('Failed to upload backup:', error);
  }
}

// --- Конфигурация бота ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';
const ADMIN_ID = 2018254756;

const app = express();
const bot = new Telegraf(BOT_TOKEN);

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Автоочистка кэша
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400_000;
  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  });
}, 3600_000);

// --- Автоматический бэкап раз в 24 часа ---
setInterval(async () => {
  try {
    const src = path.join(__dirname, 'database.sqlite');
    if (!fs.existsSync(src)) {
      console.warn('❗ Файл базы данных не найден для бэкапа:', src);
      return;
    }

    const backupName = `backup_${Date.now()}.sqlite`;
    const backupPath = path.join(__dirname, backupName);

    fs.copyFileSync(src, backupPath);
    console.log('Backup created:', backupName);

    await uploadBackup(backupName, backupPath);

    fs.unlinkSync(backupPath);
  } catch (err) {
    console.error('Backup error:', err);
  }
}, 24 * 3600 * 1000); // каждые 24 часа

// --- Тексты и клавиатура ---
const texts = {
  ru: {
    start: '👋 Пришли ссылку на трек с SoundCloud.',
    menu: '📋 Меню', upgrade: '🔓 Расширить лимит',
    mytracks: '🎵 Мои треки', help: 'ℹ️ Помощь',
    downloading: '🎧 Загружаю...', cached: '🔁 Из кеша...',
    error: '❌ Ошибка', timeout: '⏱ Слишком долго...', limitReached: '🚫 Лимит достигнут.',
    upgradeInfo:
      '🚀 Хочешь больше треков?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Донат: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты жми “Подтвердить оплату”',
    helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
    chooseLang: '🌐 Выберите язык:',
    backupError: '❌ Ошибка бэкапа',
    backupDone: '✅ Бэкап выполнен'
  },
  en: {
    start: '👋 Send a SoundCloud track link.',
    menu: '📋 Menu', upgrade: '🔓 Upgrade limit',
    mytracks: '🎵 My tracks', help: 'ℹ️ Help',
    downloading: '🎧 Downloading...', cached: '🔁 From cache...',
    error: '❌ Error', timeout: '⏱ Timeout...', limitReached: '🚫 Limit reached.',
    upgradeInfo:
      '🚀 Want more tracks?\n\n🆓 Free – 10 🟢\nPlus – 50 🎯 (59₽)\nPro – 100 💪 (119₽)\nUnlimited – 💎 (199₽)\n\n👉 Donate: https://boosty.to/anatoly_bone/donate\n✉️ After payment press “Confirm payment”',
    helpInfo: 'ℹ️ Just send a SoundCloud link to get mp3.\n🔓 Upgrade — pay and confirm.\n🎵 My tracks — list of today\'s downloads.\n📋 Menu — change language.',
    chooseLang: '🌐 Choose language:',
    backupError: '❌ Backup error',
    backupDone: '✅ Backup done'
  }
};

const kb = lang => Markup.keyboard([
  [texts[lang].menu, texts[lang].upgrade],
  [texts[lang].mytracks, texts[lang].help]
]).resize();

// --- Команды и обработчики ---
bot.start(ctx => {
  const user = getUser(
    ctx.from.id,
    ctx.from.username || '',
    ctx.from.first_name || ''
  );
  ctx.reply(texts[user.lang].start, kb(user.lang));
});

bot.hears([texts.ru.menu, texts.en.menu], ctx => {
  const u = getUser(ctx.from.id);
  ctx.reply(texts[u.lang].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(\w+)/, ctx => {
  const lang = ctx.match[1];
  updateUserField(ctx.from.id, 'lang', lang);
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
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (list.length === 0) return ctx.reply('Сегодня нет треков.');
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

bot.command('testdb', ctx => {
  const user = getUser(ctx.from.id);
  if (user) {
    ctx.reply(`User ID: ${user.id}\nDownloads today: ${user.downloads_today}\nLimit: ${user.premium_limit}`);
  } else {
    ctx.reply('Пользователь не найден в базе');
  }
});

bot.command('admin', ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const users = getAllUsers();
  const files = fs.readdirSync(cacheDir);
  const totalSize = files.reduce((sum, file) => {
    const stats = fs.statSync(path.join(cacheDir, file));
    return sum + stats.size;
  }, 0);

  const free = users.filter(u => u.premium_limit === 10).length;
  const plus = users.filter(u => u.premium_limit === 50).length;
  const pro = users.filter(u => u.premium_limit === 100).length;
  const unlimited = users.filter(u => u.premium_limit >= 1000).length;
  const totalDownloads = users.reduce((sum, u) => sum + u.total_downloads, 0);

  const summary =
    `📊 Общая статистика:\n` +
    `👥 Пользователей: ${users.length}\n` +
    `📥 Загрузок: ${totalDownloads}\n` +
    `📁 Кеш: ${files.length} файлов, ${(totalSize / 1024 / 1024).toFixed(1)} MB\n\n` +
    `🔐 Тарифы:\n` +
    `🆓 Free: ${free}\n` +
    `🎯 Plus: ${plus}\n` +
    `💪 Pro: ${pro}\n` +
    `💎 Unlimited: ${unlimited}`;

  ctx.reply(summary);

  const btns = users.map(u => {
    const name = u.username ? '@' + u.username : u.id;
    const label = `${name} | ${u.downloads_today}/${u.premium_limit}`;
    return Markup.button.callback(label, `user_${u.id}`);
  });

  ctx.reply('👥 Пользователи:', Markup.inlineKeyboard(btns, { columns: 1 }));
});

bot.action(/user_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  ctx.reply('💳 Выбери тариф:', Markup.inlineKeyboard([
    Markup.button.callback('Plus (50)', `plan_${id}_50`),
    Markup.button.callback('Pro (100)', `plan_${id}_100`),
    Markup.button.callback('Unlimited (∞)', `plan_${id}_1000`)
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, lim] = ctx.match;
  setPremium(id, parseInt(lim));
  ctx.reply(`✅ Пользователю ${id} установлен лимит: ${lim}`);
});

bot.command('backup', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const src = path.join(__dirname, 'database.sqlite');
    const backupName = `backup_manual_${Date.now()}.sqlite`;
    const backupPath = path.join(__dirname, backupName);

    fs.copyFileSync(src, backupPath);
    await uploadBackup(backupName, backupPath);
    fs.unlinkSync(backupPath);

    ctx.reply(texts[getUser(ctx.from.id).lang].backupDone);
  } catch (err) {
    console.error('Manual backup error:', err);
    ctx.reply(texts[getUser(ctx.from.id).lang].backupError);
  }
});

// --- Обработка сообщений со ссылками SoundCloud ---
bot.on('text', async ctx => {
  const user = getUser(ctx.from.id);
  const lang = user.lang;
  const text = ctx.message.text.trim();

  if (!text.includes('soundcloud.com')) return;

  if (user.downloads_today >= user.premium_limit) {
    return ctx.reply(texts[lang].limitReached);
  }

  ctx.reply(texts[lang].downloading);

  try {
    // Получаем метаданные и файл через youtube-dl
    const info = await ytdl(text, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true
    });

    if (!info || !info.title) {
      return ctx.reply(texts[lang].error);
    }

    const filename = info.title.replace(/[^\w\d]/g, '_');
    const filepath = path.join(cacheDir, filename + '.mp3');

    if (fs.existsSync(filepath)) {
      ctx.reply(texts[lang].cached);
      return ctx.replyWithAudio({ source: filepath });
    }

    await ytdl(text, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: filepath,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true
    });

    incrementDownloads(ctx.from.id, filename);

    ctx.replyWithAudio({ source: filepath });
  } catch (err) {
    console.error('Download error:', err);
    ctx.reply(texts[lang].error);
  }
});

// --- Запуск сервера и webhook ---
app.use(bot.webhookCallback('/telegram'));

app.get('/', (req, res) => {
  res.send('SoundCloud Telegram Bot is running');
});

bot.telegram.setWebhook(WEBHOOK_URL).then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log('Server started');
  });
});