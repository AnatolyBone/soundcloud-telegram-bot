// index.js

const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');

const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const {
  createUser, getUser, updateUserField, incrementDownloads,
  setPremium, getAllUsers, resetDailyStats, addReview,
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded,
  getRegistrationsByDate, getDownloadsByDate
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !ADMIN_ID || !process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.error('❌ Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}
if (isNaN(ADMIN_ID)) {
  console.error('❌ ADMIN_ID должен быть числом');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// Очистка кеша старше 7 дней
setInterval(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  fs.readdirSync(cacheDir).forEach(file => {
    const filePath = path.join(cacheDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑 Удалён кеш: ${file}`);
      } catch (e) {
        console.error('Ошибка при удалении файла кеша:', e);
      }
    }
  });
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

const queues = {};
const processing = {};
const userStates = {}; // Хранит состояние загрузки (например, флаг остановки)
// const reviewMode = new Set(); // пока не используется

const texts = {
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached: `🚫 Лимит достигнут ❌

🔔 Получи 7 дней Plus!
Подпишись на канал @BAZAproject и нажми кнопку ниже, чтобы получить бонус.`,
  upgradeInfo: `🚀 Хочешь больше треков?

🆓 Free — 10 🟢
Plus — 50 🎯 (59₽)
Pro — 100 💪 (119₽)
Unlimited — 💎 (199₽)

👉 Донат: https://boosty.to/anatoly_bone/donate
✉️ После оплаты напиши: @anatolybone

👫 Пригласи друзей и получи 1 день тарифа Plus за каждого.`,
  helpInfo: 'ℹ️ Просто пришли ссылку и получишь mp3.\n🔓 Расширить — оплати и подтверди.\n🎵 Мои треки — список за сегодня.\n📋 Меню — смена языка.',
  queuePosition: pos => `⏳ Трек добавлен в очередь (#${pos})`,
  adminCommands: '\n\n📋 Команды админа:\n/admin — статистика\n/testdb — мои данные\n/backup — резервная копия\n/reviews — отзывы'
};

const kb = () =>
  Markup.keyboard([
    [texts.menu, texts.upgrade],
    [texts.mytracks, texts.help]
  ]).resize();

const isSubscribed = async userId => {
  try {
    const res = await bot.telegram.getChatMember('@BAZAproject', userId);
    return ['member', 'creator', 'administrator'].includes(res.status);
  } catch {
    return false;
  }
};

// Вспомогательная функция: безопасная отправка аудио с логированием ошибок
async function sendAudioSafe(ctx, userId, filePath, filename) {
  try {
    await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(filePath), filename });
  } catch (e) {
    console.error(`Ошибка отправки аудио ${filename} пользователю ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

async function enqueue(ctx, userId, url) {
  if (!queues[userId]) queues[userId] = [];

  try {
    // Создаём пользователя при необходимости (если нет в базе)
    await createUser(userId, ctx.from.first_name, ctx.from.username);

    const u = await getUser(userId);
    const info = await ytdl(url, { dumpSingleJson: true });
    const isPlaylist = Array.isArray(info.entries);

    const entries = isPlaylist ? info.entries.map(e => e.webpage_url) : [url];

    const remainingLimit = u.premium_limit - u.downloads_today;
    if (remainingLimit <= 0) {
      return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ]));
    }

    if (entries.length > remainingLimit) {
      await ctx.telegram.sendMessage(userId,
        `⚠️ В плейлисте ${entries.length} треков, но тебе доступно только ${remainingLimit}. Будет загружено только первые ${remainingLimit}.`);
    }

    const limitedEntries = entries.slice(0, remainingLimit);
    queues[userId].push(...limitedEntries);
    userStates[userId] = { abort: false };

    if (processing[userId]) return;
    processing[userId] = true;

    for (let i = 0; i < queues[userId].length; i++) {
      if (userStates?.[userId]?.abort) {
        queues[userId] = [];
        break;
      }

      const trackUrl = queues[userId][i];
      await ctx.telegram.sendMessage(userId, `🎵 Загружаю ${i + 1} из ${queues[userId].length}`, Markup.inlineKeyboard([
        Markup.button.callback('⏹️ Остановить', `stop_${userId}`)
      ]));

      try {
        await Promise.race([
          processTrackByUrl(ctx, userId, trackUrl),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 300000))
        ]);
      } catch (e) {
        console.error(`Ошибка при загрузке трека ${trackUrl}:`, e);
        await ctx.telegram.sendMessage(userId, texts.error);
      }
    }

    queues[userId] = [];
    processing[userId] = false;
    delete userStates[userId];

    await ctx.telegram.sendMessage(userId, '✅ Загрузка завершена.');

  } catch (err) {
    console.error('Ошибка в enqueue:', err);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

async function processTrackByUrl(ctx, userId, url) {
  await ctx.telegram.sendMessage(userId, texts.downloading);
  const start = Date.now(); // ← вот это добавляем

  try {
    const info = await ytdl(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
      noCheckCertificates: true
    });

    // ... (обработка названия и пути к файлу)

    if (!fs.existsSync(fp)) {
      await ytdl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: fp,
        preferFreeFormats: true,
        noCheckCertificates: true
      });
    }

    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);
    await sendAudioSafe(ctx, userId, fp, `${name}.mp3`);

    const duration = ((Date.now() - start) / 1000).toFixed(1); // ← и это
    console.log(`✅ Трек ${name} загружен за ${duration} сек.`);
  } catch (e) {
    console.error(`Ошибка при загрузке ${url}:`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

async function broadcastMessage(bot, pool, message) {
  const users = await getAllUsers();
  let successCount = 0;
  let errorCount = 0;

  for (const user of users) {
    if (!user.active) continue;

    try {
      await bot.telegram.sendMessage(user.id, message);
      successCount++;
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.log(`Ошибка при отправке пользователю ${user.id}:`, e.description || e.message);
      errorCount++;
      try {
        await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [user.id]);
      } catch (err) {
        console.error('Ошибка при обновлении статуса пользователя:', err);
      }
    }
  }

  return { successCount, errorCount };
}

// Хендлеры бота

bot.hears(texts.menu, async ctx => {
  // Создаём/обновляем пользователя на всякий случай
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  const u = await getUser(ctx.from.id);
  const now = new Date();
  const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;
  const refLink = `https://t.me/SCloudMusicBot?start=${ctx.from.id}`;
  
  console.log(`DEBUG getUser: id=${ctx.from.id}, from DB:`, u);

  // Не занижаем тариф — выдаём Plus только если текущий тариф ниже
  if (u.referred_count > 0 && daysLeft <= 0 && u.premium_limit < 50) {
    await setPremium(ctx.from.id, 50, u.referred_count);
  }

  ctx.reply(
    `👋 Добро пожаловать, ${u.first_name}!\n\n` +
    `💼 Тариф: ${u.premium_limit === 10 ? 'Free' : u.premium_limit === 50 ? 'Plus' : u.premium_limit === 100 ? 'Pro' : 'Unlimited'}\n` +
    `⏳ Осталось дней: ${daysLeft > 0 ? daysLeft : '0'}\n\n` +
    `👫 Приглашено: ${u.referred_count || 0}\n🎁 Дней Plus: ${u.referred_count || 0}\n\n` +
    `🔗 Твоя ссылка:\n${refLink}`,
    kb()
  );
});

bot.hears(texts.upgrade, ctx => ctx.reply(texts.upgradeInfo));
bot.hears(texts.help, ctx => ctx.reply(texts.helpInfo));

// bot.hears('✍️ Оставить отзыв', async ctx => {
//   if (await hasLeftReview(ctx.from.id)) return ctx.reply(texts.alreadyReviewed);
//   ctx.reply(texts.reviewAsk);
//   reviewMode.add(ctx.from.id);
// });

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const downloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  ctx.reply(`📊 Пользователей: ${users.length}\n📥 Загрузок: ${downloads}${texts.adminCommands}`);
});

bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const reviews = await getLatestReviews(10);
  for (const r of reviews) {
    await ctx.reply(`📝 ${r.text}\n🕒 ${r.time}`);
  }
});

bot.action('check_subscription', async ctx => {
  if (await isSubscribed(ctx.from.id)) {
    await setPremium(ctx.from.id, 50, 7);
    await ctx.editMessageReplyMarkup(); // удаляет кнопку
    return ctx.reply('✅ Подписка подтверждена! Тариф Plus активирован на 7 дней.', kb());
  } else {
    return ctx.answerCbQuery('❌ Сначала подпишись на канал', { show_alert: true });
  }
});

bot.action(/^stop_(\d+)$/, async ctx => {
  const targetId = parseInt(ctx.match[1]);
  if (ctx.from.id !== targetId) return ctx.answerCbQuery('⛔️ Это не ваша загрузка');
  if (userStates?.[targetId]) userStates[targetId].abort = true;
  await ctx.editMessageReplyMarkup();
  await ctx.reply('⏹️ Загрузка остановлена.');
});

bot.hears(texts.mytracks, async ctx => {
  const u = await getUser(ctx.from.id);
  const list = u.tracks_today?.split(',').filter(Boolean) || [];
  if (!list.length) return ctx.reply(texts.noTracks);
  const media = list.map(name => {
    const fp = path.join(cacheDir, `${name}.mp3`);
    return fs.existsSync(fp) ? { type: 'audio', media: { source: fp } } : null;
  }).filter(Boolean);
  for (let i = 0; i < media.length; i += 5) {
    const chunk = media.slice(i, i + 5);
    try {
      await ctx.replyWithMediaGroup(chunk);
    } catch (error) {
      console.error('Ошибка при отправке части треков:', error);
      await ctx.reply('❌ Не удалось отправить часть треков. Возможно, один из файлов повреждён.');
    }
  }
});

bot.on('text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) return;

  await resetDailyLimitIfNeeded(ctx.from.id);
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const u = await getUser(ctx.from.id);

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached, Markup.inlineKeyboard([
      Markup.button.callback('✅ Я подписался', 'check_subscription')
    ]));
  }

  // Ответ сразу, обработка в фоне
  ctx.reply('⏳ Загрузка началась. Это может занять до 5 минут...');
  enqueue(ctx, ctx.from.id, url).catch(e => {
    console.error('Ошибка в enqueue:', e);
    ctx.telegram.sendMessage(ctx.from.id, '❌ Произошла ошибка при загрузке.');
  });
});

  await enqueue(ctx, ctx.from.id, url);
});

// Webhook
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('Ошибка в handleUpdate:', err));
});

app.use(express.urlencoded({ extended: true }));
app.use(compression());

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => res.render('login', { error: null }));

app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.username === process.env.ADMIN_LOGIN && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Неверные данные' });
});

app.post('/broadcast', requireAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const message = req.body.message;
  if (!message) {
    return res.status(400).send('Сообщение не может быть пустым');
  }

  try {
    const { successCount, errorCount } = await broadcastMessage(bot, pool, message);
    res.send(`Рассылка завершена. Отправлено: ${successCount}, ошибок: ${errorCount}`);
  } catch (e) {
    console.error('Ошибка рассылки:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const showInactive = req.query.showInactive === 'true';

  const usersQuery = showInactive
    ? 'SELECT * FROM users ORDER BY created_at DESC'
    : 'SELECT * FROM users WHERE active = true ORDER BY created_at DESC';

  const users = await pool.query(usersQuery);

  const totalDownloads = users.rows.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  const registrations = await getRegistrationsByDate();
  const downloadsByDate = await getDownloadsByDate();

  res.render('dashboard', {
    users: users.rows,
    totalDownloads,
    registrations,
    downloadsByDate,
    showInactive
  });
});

// Вместо app.listen(...)
const server = app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// Запуск бота с использованием уже созданного express сервера
bot.launch({
  webhook: {
    domain: WEBHOOK_URL,
    hookPath: WEBHOOK_PATH,
    server: server,
  }
}).then(() => console.log('🤖 Бот запущен через webhook'));

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));