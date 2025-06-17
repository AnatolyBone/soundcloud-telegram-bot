const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const { google } = require('googleapis');

const {
  createUser,
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = 'https://soundcloud-telegram-bot.onrender.com/telegram';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'service-account.json'),
  scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

async function uploadBackup(filename, filepath) {
  try {
    await drive.files.create({
      requestBody: {
        name: filename,
        parents: ['1FjRTVO4rLCsKdeIg452M4-1MjpmfuChG']
      },
      media: {
        body: fs.createReadStream(filepath),
      },
    });
    console.log('✅ Backup uploaded:', filename);
  } catch (err) {
    console.error('❌ Backup upload failed:', err);
  }
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша старше 7 дней
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const fp = path.join(cacheDir, file);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  });
}, 3600 * 1000);

// Бэкап базы раз в сутки
setInterval(async () => {
  const src = path.join(__dirname, 'database.sqlite');
  if (!fs.existsSync(src)) {
    console.warn('❗ No database.sqlite found for backup');
    return;
  }
  const fname = `backup_${Date.now()}.sqlite`;
  const dst = path.join(__dirname, fname);
  fs.copyFileSync(src, dst);
  console.log('📁 Backup file created:', fname);
  await uploadBackup(fname, dst);
  fs.unlinkSync(dst);
}, 24 * 3600 * 1000);

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

const kb = lang =>
  Markup.keyboard([
    [texts[lang].menu, texts[lang].upgrade],
    [texts[lang].mytracks, texts[lang].help],
    ['✍️ Оставить отзыв']
  ]).resize();

const getLang = (u) => (u?.lang || 'ru');

bot.start(async (ctx) => {
  const { id, username, first_name } = ctx.from;
  await createUser(id, username, first_name);
  const u = await getUser(id);
  ctx.reply(texts[getLang(u)].start, kb(getLang(u)));
});

bot.hears([texts.ru.menu, texts.en.menu], async (ctx) => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].chooseLang, Markup.inlineKeyboard([
    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
    Markup.button.callback('🇬🇧 English', 'lang_en')
  ]));
});

bot.action(/lang_(\w+)/, async (ctx) => {
  const lang = ctx.match[1];
  await updateUserField(ctx.from.id, 'lang', lang);
  ctx.editMessageText(texts[lang].chooseLang + ' ✅');
  ctx.reply(texts[lang].start, kb(lang));
});

bot.hears([texts.ru.upgrade, texts.en.upgrade], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].upgradeInfo);
});
bot.hears([texts.ru.help, texts.en.help], async ctx => {
  const u = await getUser(ctx.from.id);
  ctx.reply(texts[getLang(u)].helpInfo);
});

bot.hears([texts.ru.mytracks, texts.en.mytracks], async ctx => {
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply('Сегодня нет треков.');
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 10) {
    ctx.replyWithMediaGroup(media.slice(i, i + 10));
  }
});

bot.command('testdb', async ctx => {
  const u = await getUser(ctx.from.id);
  if (u) {
    ctx.reply(`ID: ${u.id}\nСегодня: ${u.downloads_today}/${u.premium_limit}`);
  } else ctx.reply('Пользователь не найден');
});

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const files = fs.readdirSync(cacheDir);
  const totalSize = files.reduce((s, f) => s + fs.statSync(path.join(cacheDir, f)).size, 0);
  const free = users.filter(u => u.premium_limit === 10).length;
  const plus = users.filter(u => u.premium_limit === 50).length;
  const pro = users.filter(u => u.premium_limit === 100).length;
  const unlimited = users.filter(u => u.premium_limit >= 1000).length;
  const totalDownloads = users.reduce((s, u) => s + u.total_downloads, 0);
  const summary = `📊 Пользователи: ${users.length}\n📥 Загрузок: ${totalDownloads}\n📁 Кеш: ${files.length} файлов, ${(totalSize/1024/1024).toFixed(1)} MB\n\n🆓 Free: ${free}\n🎯 Plus: ${plus}\n💪 Pro: ${pro}\n💎 Unlimited: ${unlimited}`;
  ctx.reply(summary);
  const buttons = users.map(u => {
    const name = u.username ? '@' + u.username : u.id;
    return Markup.button.callback(`${name} | ${u.downloads_today}/${u.premium_limit}`, `user_${u.id}`);
  });
  ctx.reply('👥 Пользователи:', Markup.inlineKeyboard(buttons, { columns: 1 }));
});
bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const file = path.join(__dirname, 'reviews.json');
  if (!fs.existsSync(file)) return ctx.reply('❌ Отзывов пока нет.');
  const reviews = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!reviews.length) return ctx.reply('❌ Отзывов пока нет.');

  for (const r of reviews.slice(-10).reverse()) {
    const user = r.username ? `@${r.username}` : `${r.name || r.id}`;
    await ctx.reply(`🗣 ${user}\n🕒 ${new Date(r.date).toLocaleString()}\n\n${r.text}`);
  }
});
bot.action(/user_(\d+)/, async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = ctx.match[1];
  ctx.reply('💳 Выберите тариф:', Markup.inlineKeyboard([
    Markup.button.callback('Plus (50)', `plan_${id}_50`),
    Markup.button.callback('Pro (100)', `plan_${id}_100`),
    Markup.button.callback('Unlimited (∞)', `plan_${id}_1000`)
  ]));
});

bot.action(/plan_(\d+)_(\d+)/, async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, id, limit] = ctx.match;
  await updateUserField(+id, 'premium_limit', +limit);
  await updateUserField(+id, 'premium_end', Date.now() + 30 * 86400 * 1000);
  ctx.reply('✅ Тариф изменён');
});

let queue = [];

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;
  const u = await getUser(userId);
  const lang = getLang(u);

  // Проверяем, что это ссылка SoundCloud
  if (!text.startsWith('https://soundcloud.com/')) {
    return ctx.reply(texts[lang].start);
  }

  // Проверка лимита
  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts[lang].limitReached);
  }

  // Добавляем в очередь
  queue.push({ text, ctx });
  ctx.reply(`⏳ Трек добавлен в очередь (#${queue.length})`);

  // Обработка очереди (если ещё не обрабатывается)
  if (queue.length === 1) {
    while (queue.length > 0) {
      const item = queue[0];
      const { text: trackUrl, ctx: trackCtx } = item;

      try {
        await trackCtx.reply(texts[lang].downloading);

        // Получаем инфо о треке
        const info = await ytdl(trackUrl, { dumpSingleJson: true });
        if (!info || !info.title) throw new Error('No info');
        const name = info.title.replace(/[^\w\d]/g, '_').slice(0, 50);
        const fp = path.join(cacheDir, `${name}.mp3`);

        if (fs.existsSync(fp)) {
          await trackCtx.reply(texts[lang].cached);
        } else {
          await ytdl(trackUrl, {
            '--extract-audio': true,
            '--audio-format': 'mp3',
            '-o': fp,
            '--no-warnings': true,
            '--no-check-certificate': true,
            '--prefer-free-formats': true,
            '--youtube-skip-dash-manifest': true,
          });
        }

        await incrementDownloads(userId, name);

        await trackCtx.replyWithAudio({ source: fs.createReadStream(fp), filename: `${name}.mp3` });
      } catch (e) {
        console.error('Download error:', e);
        await trackCtx.reply(texts[lang].error);
      }

      queue.shift();
    }
  }
});

bot.launch({
  webhook: {
    domain: 'soundcloud-telegram-bot.onrender.com',
    port: process.env.PORT || 3000,
    hookPath: '/telegram',
  }
});

app.use(bot.webhookCallback('/telegram'));
app.get('/', (req, res) => res.send('SoundCloud Telegram Bot is running.'));
app.listen(process.env.PORT || 3000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));