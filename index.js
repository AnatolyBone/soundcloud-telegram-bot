// index.js
const { Telegraf, Markup } = require('telegraf');

const compression = require('compression');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const ytdl = require('youtube-dl-exec');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { Parser } = require('json2csv');
const playlistTracker = new Map();

const {
  createUser,
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers,
  resetDailyStats,
  addReview,
  saveTrackForUser,
  hasLeftReview,
  getLatestReviews,
  resetDailyLimitIfNeeded,
  getRegistrationsByDate,
  getDownloadsByDate,
  getActiveUsersByDate,
  getExpiringUsers
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
  fs.readdir(cacheDir, (err, files) => {
    if (err) {
      console.error('Ошибка чтения кеша:', err);
      return;
    }
    files.forEach(file => {
      const filePath = path.join(cacheDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error('Ошибка stat файла:', err);
          return;
        }
        if (stats.mtimeMs < cutoff) {
          fs.unlink(filePath, err => {
            if (err) console.error('Ошибка удаления файла кеша:', err);
            else console.log(`🗑 Удалён кеш: ${file}`);
          });
        }
      });
    });
  });
}, 3600 * 1000);

// Сброс статистики раз в сутки
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

const MAX_CONCURRENT_DOWNLOADS = 5; // можно подстроить под возможности сервера
let globalQueue = [];
let activeDownloadsCount = 0;
// const queues = {};
// const processing = {};
// const userStates = {};// для флага остановки загрузки

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

async function sendAudioSafe(ctx, userId, filePath, filename) {
  try {
    await ctx.telegram.sendAudio(userId, { source: fs.createReadStream(filePath), filename });
  } catch (e) {
    console.error(`Ошибка отправки аудио ${filename} пользователю ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}
  
// --- Функция для скачивания и отправки одного трека ---
async function processTrackByUrl(ctx, userId, url) {
  const start = Date.now();
await processTrackByUrl(ctx, userId, url, playlistUrl);
  try {
    const info = await ytdl(url, { dumpSingleJson: true });
await processTrackByUrl(ctx, userId, url, playlistUrl);
    // Обработка названия трека
    let name = info.title || 'track';
    name = name.replace(/[\\/:*?"<>|]+/g, ''); // убираем опасные символы
    name = name.trim().replace(/\s+/g, '_');   // пробелы в _
    name = name.replace(/__+/g, '_');          // двойные подчёркивания в одиночные
    if (name.length > 64) name = name.slice(0, 64);

    // Путь к кешу
    const fp = path.join(cacheDir, `${name}.mp3`);

    if (!fs.existsSync(fp)) {
      // Скачиваем аудио
      await ytdl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: fp,
        preferFreeFormats: true,
        noCheckCertificates: true
      });
    }

    // Обновляем статистику
    await incrementDownloads(userId, name);
    await saveTrackForUser(userId, name);
await pool.query('INSERT INTO downloads_log (user_id, track_title) VALUES ($1, $2)', [userId, name]);
    // Отправляем аудио пользователю
    await sendAudioSafe(ctx, userId, fp, `${name}.mp3`);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Трек ${name} загружен за ${duration} сек.`);
const playlistKey = playlistUrl ? `${userId}:${playlistUrl}` : null;
if (playlistKey && playlistTracker.has(playlistKey)) {
  let remaining = playlistTracker.get(playlistKey) - 1;
  if (remaining <= 0) {
    await ctx.telegram.sendMessage(userId, '✅ Все треки из плейлиста загружены.');
    playlistTracker.delete(playlistKey);
  } else {
    playlistTracker.set(playlistKey, remaining);
  }
}
  } catch (e) {
    console.error(`Ошибка при загрузке ${url}:`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
  }
}

// --- Функция управления очередью загрузок ---
function addToGlobalQueue(task) {
  globalQueue.push(task);
  // Сортируем по приоритету (чем выше premium_limit — тем выше приоритет)
  globalQueue.sort((a, b) => b.priority - a.priority);
}

async function processNextInQueue() {
  if (activeDownloadsCount >= MAX_CONCURRENT_DOWNLOADS) return;
  if (globalQueue.length === 0) return;

  const task = globalQueue.shift();
  activeDownloadsCount++;

  const { ctx, userId, url } = task;

  try {
    await processTrackByUrl(ctx, userId, url);
  } catch (e) {
    console.error(`Ошибка при загрузке трека ${url} для пользователя ${userId}:`, e);
    await ctx.telegram.sendMessage(userId, '❌ Ошибка при загрузке трека.');
  }

  activeDownloadsCount--;
  processNextInQueue();
}

  const u = await getUser(userId);

  const remainingLimit = u.premium_limit - u.downloads_today;
  if (remainingLimit <= 0) {
    return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([
      Markup.button.callback('✅ Я подписался', 'check_subscription')
    ]));
  }

  addToGlobalQueue({ ctx, userId, url, priority: u.premium_limit });

  const position = globalQueue.findIndex(task => task.userId === userId && task.url === url) + 1;

  await ctx.telegram.sendMessage(userId, texts.queuePosition(position));

  processNextInQueue();
}
    // Важно: здесь не вызываем createUser/getUser, т.к. уже сделано в обработчике

   async function enqueue(ctx, userId, url) {
  try {
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - user.downloads_today;

    if (remainingLimit <= 0) {
      return ctx.telegram.sendMessage(userId, texts.limitReached, Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ]));
    }

    const info = await ytdl(url, { dumpSingleJson: true });
    const isPlaylist = Array.isArray(info.entries);

    let entries = [];

    if (isPlaylist) {
      entries = info.entries
        .filter(e => e && e.webpage_url)
        .map(e => e.webpage_url);
const playlistKey = `${user.id}:${url}`;
playlistTracker.set(playlistKey, entries.length);
      if (entries.length > remainingLimit) {
        await ctx.telegram.sendMessage(userId,
          `⚠️ В плейлисте ${entries.length} треков, но тебе доступно только ${remainingLimit}. Будет загружено первые ${remainingLimit}.`);
        entries = entries.slice(0, remainingLimit);
      }
    } else {
      entries = [url];
    }

    for (const entryUrl of entries) {
            addToGlobalQueue({
        ctx,
        userId,
        url: entryUrl,
        playlistUrl: isPlaylist ? url : null,
        priority: user.premium_limit
      });

      const position = globalQueue.findIndex(task => task.userId === userId && task.url === entryUrl) + 1;
      await ctx.telegram.sendMessage(userId, texts.queuePosition(position));
    }

    processNextInQueue();
  } catch (e) {
    console.error('Ошибка в enqueue:', e);
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
bot.start(async ctx => {
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  await ctx.replyWithMarkdown(`👋 Добро пожаловать, *${ctx.from.first_name}*!

🎵 Этот бот качает **треки и плейлисты** с SoundCloud в MP3.

📌 Просто пришли ссылку — и получи MP3.

🎁 Подпишись на канал @BAZAproject — получи *7 дней тарифа Plus бесплатно*.

📋 Нажми кнопку «Меню», чтобы:
— узнать свой тариф и лимит,
— посмотреть треки за сегодня,
— получить реферальную ссылку,
— расширить лимит.`, kb());
});
// Хендлеры бота

bot.hears(texts.menu, async ctx => {
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

  const u = await getUser(ctx.from.id);
  const now = new Date();
  const premiumUntil = u.premium_until ? new Date(u.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;
  const refLink = `https://t.me/SCloudMusicBot?start=${ctx.from.id}`;

  console.log(`DEBUG getUser: id=${ctx.from.id}, from DB:`, u);

  // Обновляем тариф, если пользователь привёл рефералов
  if (u.referred_count > 0 && daysLeft <= 0 && u.premium_limit < 50) {
    await setPremium(ctx.from.id, 50, u.referred_count);
  }

  const tariffName =
    u.premium_limit === 10 ? 'Free (10/день)' :
    u.premium_limit === 50 ? 'Plus (50/день)' :
    u.premium_limit === 100 ? 'Pro (100/день)' :
    'Unlimited';

  const baseInfo = `👋 Привет, ${u.first_name}!

📥 Бот качает **треки и целые плейлисты** с SoundCloud в MP3.
Просто пришли ссылку — и всё 🧙‍♂️

💼 Тариф: ${tariffName}
⏳ Осталось дней: ${daysLeft > 0 ? daysLeft : '0'}

🎧 Сегодня скачано: ${u.downloads_today || 0} из ${u.premium_limit}
`;

  const promo = `🎁 Хочешь больше?

Подпишись на канал @BAZAproject — получи **7 дней тарифа Plus бесплатно**.
Нажми «🔓 Расширить лимит», чтобы получить бонус.`;

  const referrals = `👫 Приглашено: ${u.referred_count || 0}
🎁 Дней Plus: ${u.referred_count || 0}
🔗 Твоя реферальная ссылка:
${refLink}`;

  const message = [baseInfo, promo, referrals].join('\n\n');

// Отправляем сообщение с кнопкой подписки
  await ctx.replyWithMarkdown(message, {
    ...kb(),
    reply_markup: {
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Я подписался', 'check_subscription')
      ]).reply_markup
    }
  });
}); 

bot.hears(texts.upgrade, ctx => ctx.reply(texts.upgradeInfo));
bot.hears(texts.help, ctx => ctx.reply(texts.helpInfo));

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

function extractUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  if (!matches) return null;
  return matches.find(u => u.includes('soundcloud.com')) || null;
}

bot.on('text', async ctx => {
  if (ctx.message.text.startsWith('/')) return;

  const url = extractUrl(ctx.message.text);
  if (!url) return;

  await resetDailyLimitIfNeeded(ctx.from.id);
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const u = await getUser(ctx.from.id);

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached, Markup.inlineKeyboard([
      Markup.button.callback('✅ Я подписался', 'check_subscription')
    ]));
  }

  ctx.reply('⏳ Загрузка началась. Это может занять до 5 минут...');
  enqueue(ctx, ctx.from.id, url).catch(e => {
    console.error('Ошибка в enqueue:', e);
    ctx.telegram.sendMessage(ctx.from.id, '❌ Произошла ошибка при загрузке.');
  });
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

app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
  const { message } = req.body;
  const audio = req.file;
  if (!message && !audio) return res.status(400).send('Сообщение или файл обязательно');

  const users = await getAllUsers();

  let success = 0, error = 0;
  for (const u of users) {
    try {
      if (audio) {
        await bot.telegram.sendAudio(u.id, {
          source: fs.createReadStream(audio.path),
          filename: audio.originalname
        }, { caption: message || '' });
      } else {
        await bot.telegram.sendMessage(u.id, message);
      }
      success++;
    } catch (e) {
      error++;
      try {
        await pool.query('UPDATE users SET active = FALSE WHERE id = $1', [u.id]);
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (audio) fs.unlink(audio.path, () => {});
  res.send(`✅ Успешно: ${success}, ошибок: ${error}`);
});
app.get('/export', requireAuth, async (req, res) => {
  try {
    const users = await getAllUsers(true); // получаем всех (включая неактивных)

    const fields = ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'created_at', 'last_active'];
    const opts = { fields };
    const parser = new Parser(opts);
    const csv = parser.parse(users);

    res.header('Content-Type', 'text/csv');
    res.attachment('users.csv');
    return res.send(csv);
  } catch (err) {
    console.error('Ошибка экспорта CSV:', err);
    res.status(500).send('Ошибка сервера');
  }
});
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const users = await getAllUsers(showInactive);

const stats = {
  totalUsers: users.length,
  totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
  free: users.filter(u => u.premium_limit === 10).length,
  plus: users.filter(u => u.premium_limit === 50).length,
  pro: users.filter(u => u.premium_limit === 100).length,
  unlimited: users.filter(u => u.premium_limit >= 1000).length,
  registrationsByDate: await getRegistrationsByDate(),
  downloadsByDate: await getDownloadsByDate(),
  activeByDate: await getActiveUsersByDate()
};
    const expiringSoon = await getExpiringUsers();

    res.render('dashboard', {
      users,
      stats,
      expiringSoon,
      showInactive
    });
  } catch (e) {
    console.error('Ошибка при загрузке /dashboard:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});
app.post('/set-tariff', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { userId, limit } = req.body;

  if (!userId || !limit) {
    return res.status(400).send('Missing parameters');
  }

  let limitNum;
  switch(limit) {
    case '10': limitNum = 10; break;
    case '50': limitNum = 50; break;
    case '100': limitNum = 100; break;
    case '1000': limitNum = 1000; break;
    default:
      return res.status(400).send('Unknown tariff');
  }

  try {
    await setPremium(parseInt(userId), limitNum, 0);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка при смене тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});
// Запуск сервера и бота

(async () => {
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);
    app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
    console.log('🤖 Бот ожидает обновления...');
  } catch (e) {
    console.error('Ошибка при старте:', e);
    process.exit(1);
  }
})();