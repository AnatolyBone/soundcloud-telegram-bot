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
  saveTrackForUser, hasLeftReview, getLatestReviews, resetDailyLimitIfNeeded
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
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  });
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

const queues = {};
const processing = {};
const userStates = {}; // Хранит состояние загрузки (например, флаг остановки)
const reviewMode = new Set();

const texts = {
  start: '👋 Пришли ссылку на трек с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  downloading: '🎧 Загружаю...',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  // reviewAsk: '✍️ Напиши отзыв о боте. За это — тариф Plus на 30 дней!',
// reviewThanks: '✅ Спасибо! Тариф Plus выдан на 30 дней.',
// alreadyReviewed: 'Ты уже оставил отзыв 😊',
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
    // ['✍️ Оставить отзыв']  <-- убрать эту строку
  ]).resize();

const isSubscribed = async userId => {
  try {
    const res = await bot.telegram.getChatMember('@BAZAproject', userId);
    return ['member', 'creator', 'administrator'].includes(res.status);
  } catch {
    return false;
  }
};

async function enqueue(userId, url) {
  if (!queues[userId]) queues[userId] = [];

  try {
    const u = await getUser(userId);
    const info = await ytdl(url, { dumpSingleJson: true });
    const isPlaylist = Array.isArray(info.entries);

    const entries = isPlaylist ? info.entries.map(e => e.webpage_url) : [url];

    const remainingLimit = u.premium_limit - u.downloads_today;
    if (remainingLimit <= 0) {
      return bot.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ]));
    }

    if (entries.length > remainingLimit) {
      await bot.telegram.sendMessage(userId,
        `⚠️ В плейлисте ${entries.length} треков, но тебе доступно только ${remainingLimit}. Будет загружено только первые ${remainingLimit}.`);
    }

    const limitedEntries = entries.slice(0, remainingLimit);
    queues[userId].push(...limitedEntries);
    userStates[userId] = { abort: false };

    if (processing[userId]) return;
    processing[userId] = true;

    for (let i = 0; i < queues[userId].length; i++) {
      if (userStates[userId].abort) break;

      const trackUrl = queues[userId][i];
      await bot.telegram.sendMessage(userId, `🎵 Загружаю ${i + 1} из ${queues[userId].length}`, Markup.inlineKeyboard([
        Markup.button.callback('⏹️ Остановить', `stop_${userId}`)
      ]));

      try {
        await Promise.race([
          processTrackByUrl(userId, trackUrl),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 180000))
        ]);
      } catch (e) {
        console.error('Ошибка при загрузке трека:', e);
        await bot.telegram.sendMessage(userId, texts.error);
      }
    }

    queues[userId] = [];
    processing[userId] = false;
    delete userStates[userId];

    await bot.telegram.sendMessage(userId, '✅ Загрузка завершена.');

  } catch (err) {
    console.error('Ошибка в enqueue:', err);
    await bot.telegram.sendMessage(userId, texts.error);
  }
}
async function processTrackByUrl(userId, url) {
  await bot.telegram.sendMessage(userId, texts.downloading);
  try {
    const info = await ytdl(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
      noCheckCertificates: true
    });

    let name = (info.title || 'track')
      .replace(/[^\w\s\-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);

    const fp = path.join(cacheDir, `${name}.mp3`);
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
    await bot.telegram.sendAudio(userId, { source: fs.createReadStream(fp), filename: `${name}.mp3` });
  } catch (e) {
    console.error('Ошибка при загрузке трека:', e);
    await bot.telegram.sendMessage(userId, texts.error);
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

bot.hears(texts.menu, async ctx => {
  const u = await getUser(ctx.from.id);
  const now = new Date();
  const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;
  const refLink = `https://t.me/SCloudMusicBot?start=${ctx.from.id}`;

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
  if (userStates[targetId]) userStates[targetId].abort = true;
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

  // if (reviewMode.has(ctx.from.id)) {
  //   reviewMode.delete(ctx.from.id);
  //   await addReview(ctx.from.id, ctx.message.text);
  //   await setPremium(ctx.from.id, 50, 30);
  //   return ctx.reply(texts.reviewThanks, kb());
  // }

  const url = ctx.message.text.trim();
  if (!url.includes('soundcloud.com')) return;

  await resetDailyLimitIfNeeded(ctx.from.id);
  const u = await getUser(ctx.from.id);

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached, Markup.inlineKeyboard([
      Markup.button.callback('✅ Я подписался', 'check_subscription')
    ]));
  }

  await enqueue(ctx.from.id, url);
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

app.post('/admin/login', (req, res) => {
  if (req.body.username === process.env.ADMIN_LOGIN && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Неверные данные' });
});
app.post('/broadcast', requireAuth, async (req, res) => {
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
  const users = showInactive
    ? await pool.query('SELECT * FROM users ORDER BY created_at DESC')
    : await pool.query('SELECT * FROM users WHERE active = true ORDER BY created_at DESC');
  res.render('dashboard', { stats, users: users.rows, reviews, showInactive });
  const totalDownloads = users.rows.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  const registrations = await pool.query(`
    SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date, COUNT(*) AS count
    FROM users GROUP BY date ORDER BY date
  `);
  const downloads = await pool.query(`
    SELECT TO_CHAR(last_active::date, 'YYYY-MM-DD') AS date, SUM(downloads_today) AS count
    FROM users GROUP BY date ORDER BY date
  `);

  const registrationsByDate = Object.fromEntries(registrations.rows.map(r => [r.date, parseInt(r.count)]));
  const downloadsByDate = Object.fromEntries(downloads.rows.map(r => [r.date, parseInt(r.count)]));

  const stats = {
    totalUsers: users.length,
    totalDownloads,
    free: users.filter(u => u.premium_limit === 10).length,
    plus: users.filter(u => u.premium_limit === 50).length,
    pro: users.filter(u => u.premium_limit === 100).length,
    unlimited: users.filter(u => u.premium_limit >= 1000).length,
    registrationsByDate,
    downloadsByDate
  };

  const reviews = await getLatestReviews(10);
  res.render('dashboard', { stats, users, reviews });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
  const cleanWebhookUrl = WEBHOOK_URL.replace(/\/$/, '') + WEBHOOK_PATH;
  bot.telegram.setWebhook(cleanWebhookUrl)
    .then(() => bot.telegram.getWebhookInfo())
    .then(info => {
      console.log(`✅ Webhook: ${info.url} | Pending: ${info.pending_update_count}`);
    })
    .catch(err => console.error('❌ Ошибка webhook:', err));
});