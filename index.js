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
const { supabase } = require('./db'); // или путь, где у тебя инициализация supabase клиента

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
  getExpiringUsers,
  getReferralSourcesStats,
  markSubscribedBonusUsed,
  getUserActivityByDayHour,
  logUserActivity
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
async function processTrackByUrl(ctx, userId, url, playlistUrl = null) {
  const start = Date.now();
  try {
    const info = await ytdl(url, { dumpSingleJson: true });
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
  while (activeDownloadsCount < MAX_CONCURRENT_DOWNLOADS && globalQueue.length > 0) {
    const task = globalQueue.shift();
    activeDownloadsCount++;
    const { ctx, userId, url, playlistUrl } = task;
    try {
      await processTrackByUrl(ctx, userId, url, playlistUrl);
    } catch (e) {
    console.error(`Ошибка при загрузке трека ${url} для пользователя ${userId}:`, e);
    try {
      await ctx.telegram.sendMessage(userId, '❌ Ошибка при загрузке трека.');
    } catch {}
  }

  activeDownloadsCount--;
    processNextInQueue();
  }
} 

    // Важно: здесь не вызываем createUser/getUser, т.к. уже сделано в обработчике

   async function enqueue(ctx, userId, url) {
  try {
    await logUserActivity(userId)
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
} // ← ЭТОТ ЗАКРЫВАЮЩИЙ `}` ОБЯЗАТЕЛЕН

// Отправляем одно сообщение
await ctx.telegram.sendMessage(userId, texts.queuePosition(
  globalQueue.filter(task => task.userId === userId).length
));

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
async function addOrUpdateUserInSupabase(id, first_name, username, referralSource) {
  if (!id) return;
  if (!supabase) {
    console.error('Supabase клиент не инициализирован');
    return;
  }
  try {
    const { error } = await supabase
      .from('users')
      .upsert([{ id, first_name, username, referred_by: referralSource || null }]);
    if (error) {
      console.error('Ошибка upsert в Supabase:', error);
    }
  } catch (e) {
    console.error('Ошибка Supabase:', e);
  }
}
bot.start(async ctx => {
  const referralSource = ctx.startPayload || null; // вытаскиваем параметр из ссылки /start ref_id
  
  // Добавляем/обновляем пользователя в Supabase с рефералом
  await addOrUpdateUserInSupabase(ctx.from.id, ctx.from.first_name, ctx.from.username, referralSource);

  // Создаём пользователя в Postgres (если нужна твоя текущая логика)
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
  const user = await getUser(ctx.from.id);

  const now = new Date();
  const premiumUntil = user.premium_until ? new Date(user.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;

  if (user.referred_count > 0 && daysLeft <= 0 && user.premium_limit < 50) {
    await setPremium(ctx.from.id, 50, user.referred_count);
  }

  // Формируем сообщение
  const message = formatMenuMessage(user);

  // Отправляем его с кнопкой
  await ctx.reply(message, Markup.inlineKeyboard([
    Markup.button.callback('✅ Я подписался', 'check_subscription')
  ]));
});

bot.action('check_subscription', async ctx => {
  const user = await getUser(ctx.from.id);

  if (user.subscribed_bonus_used) {
    return ctx.answerCbQuery('⚠️ Бонус уже был активирован ранее.', { show_alert: true });
  }

  if (await isSubscribed(ctx.from.id)) {
    await setPremium(ctx.from.id, 50, 7);
    await markSubscribedBonusUsed(ctx.from.id);

    await ctx.editMessageReplyMarkup(); // убирает кнопку
    return ctx.reply('✅ Подписка подтверждена! Тариф Plus активирован на 7 дней.', kb());
  } else {
    return ctx.answerCbQuery('❌ Сначала подпишись на канал', { show_alert: true });
  }
});
  function formatMenuMessage(user) {
  const now = new Date();
  const premiumUntil = user.premium_until ? new Date(user.premium_until) : null;
  const daysLeft = premiumUntil ? Math.ceil((premiumUntil - now) / 86400000) : 0;

  const tariffName =
    user.premium_limit === 10 ? 'Free (10/день)' :
    user.premium_limit === 50 ? 'Plus (50/день)' :
    user.premium_limit === 100 ? 'Pro (100/день)' :
    'Unlimited';

  const refLink = `https://t.me/SCloudMusicBot?start=${user.id}`;


return `
👋 Привет, ${user.first_name}!

📥 Бот качает треки и целые плейлисты с SoundCloud в MP3.  
Просто пришли ссылку — и всё 🧙‍♂️

🔄 При отправке ссылки ты увидишь свою позицию в очереди.  
🎯 Платные тарифы (Plus / Pro / Unlimited) идут с приоритетом — их треки загружаются первыми.  
📥 Бесплатные пользователи тоже получают треки — просто чуть позже. Всё честно.

💼 Тариф: ${tariffName}  
⏳ Осталось дней: ${daysLeft > 0 ? daysLeft : '0'}

🎧 Сегодня скачано: ${user.downloads_today || 0} из ${user.premium_limit}

🎁 Хочешь больше?

Подпишись на канал @BAZAproject — получи 7 дней тарифа Plus бесплатно.

Нажми «✅ Я подписался», чтобы получить бонус.

👫 Приглашено: ${user.referred_count || 0}  
🎁 Получено дней Plus по рефералам: ${user.referred_count || 0}

🔗 Твоя реферальная ссылка:  
${refLink}
`;
}

bot.hears(texts.upgrade, ctx => ctx.reply(texts.upgradeInfo));
bot.hears(texts.help, ctx => ctx.reply(texts.helpInfo));

bot.command('admin', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await getAllUsers();
  const downloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);
  ctx.reply(`📊 Пользователей: ${users.length}\n📥 Загрузок: ${downloads}${texts.adminCommands}`);
});
bot.command('testdb', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const user = await getUser(ctx.from.id);
  ctx.reply(JSON.stringify(user, null, 2));
});
bot.command('reviews', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const reviews = await getLatestReviews(10);
  for (const r of reviews) {
    await ctx.reply(`📝 ${r.text}\n🕒 ${r.time}`);
  }
});

bot.action('check_subscription', async ctx => {
  const user = await getUser(ctx.from.id);

  if (user.subscribed_bonus_used) {
    return ctx.answerCbQuery('⚠️ Бонус уже был активирован ранее.', { show_alert: true });
  }

  if (await isSubscribed(ctx.from.id)) {
    // Активируем тариф Plus на 7 дней и лимит 50 треков
    await setPremium(ctx.from.id, 50, 7);
    await markSubscribedBonusUsed(ctx.from.id);

    await ctx.editMessageReplyMarkup(); // убираем кнопку
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
  
await logUserActivity(ctx.from.id);
  await resetDailyLimitIfNeeded(ctx.from.id);
  await createUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const u = await getUser(ctx.from.id);

  if (u.downloads_today >= u.premium_limit) {
    return ctx.reply(texts.limitReached, Markup.inlineKeyboard([
      Markup.button.callback('✅ Я подписался', 'check_subscription')
    ]));
  }

  ctx.reply('⏳ Загрузка началась. Это может занять до 5 минут...');
  await enqueue(ctx, ctx.from.id, url).catch(e => {
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

app.get('/broadcast', requireAuth, (req, res) => {
  res.render('broadcast-form'); // Просто отображаем форму
});

app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
  const { message } = req.body;
  const audio = req.file;

  if (!message && !audio) {
    return res.status(400).send('Сообщение или файл обязательно');
  }

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
      } catch (err) {
        console.error(`Ошибка при обновлении статуса пользователя ${u.id}:`, err);
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (audio) {
    fs.unlink(audio.path, err => {
      if (err) console.error('Ошибка удаления файла аудио рассылки:', err);
    });
  }

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
app.get('', requireAuth, async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';

    // Парсим параметры
    const expiringLimit = req.query.expiringLimit ? parseInt(req.query.expiringLimit, 10) : 10;
    const expiringOffset = req.query.expiringOffset ? parseInt(req.query.expiringOffset, 10) : 0;

    // Сначала получаем expiringSoon из базы
    const expiringSoon = await getExpiringUsers();

    // Теперь можно получить количество
    const expiringCount = expiringSoon.length;

    // Получаем всех пользователей (уже после)
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

    const referralStats = await getReferralSourcesStats();
    const activityByDayHour = await getUserActivityByDayHour();

    res.render('dashboard', {
      users,
      stats,
      expiringSoon,
      showInactive,
      referralStats,
      activityByDayHour,
      expiringLimit,
      expiringOffset,
      expiringCount
    });
  } catch (e) {
    console.error('Ошибка при загрузке :', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

app.get('/expiring-users', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 10;

  try {
    const total = await getExpiringUsersCount();
    const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);

    const totalPages = Math.ceil(total / perPage);

    res.render('expiring-users', {
      users,
      page,
      perPage,
      totalPages
    });
  } catch (e) {
    console.error('Ошибка загрузки expiring-users:', e);
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
    res.redirect('');
  } catch (e) {
    console.error('Ошибка при смене тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});
// Запуск сервера и бота
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}`, err);
});
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