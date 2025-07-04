// index.js
const { Telegraf, Markup } = require('telegraf');
const compression = require('compression');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
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
const { supabase } = require('./db'); // твой supabase клиент

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
  logUserActivity,
  getExpiringUsersCount,
  getExpiringUsersPaginated,
  getUserById
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

const MAX_CONCURRENT_DOWNLOADS = 5;
let globalQueue = [];
let activeDownloadsCount = 0;

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

// Функции processTrackByUrl, addToGlobalQueue, processNextInQueue, enqueue и т.п. — оставляем без изменений
// (для компактности не копирую, но если нужно, могу добавить)

// ------------------- Express app setup -----------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// EJS + Layouts
app.use(expressLayouts);
app.set('layout', 'layout'); // views/layout.ejs
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware авторизации
async function requireAuth(req, res, next) {
  if (req.session.authenticated && req.session.userId) {
    try {
      const user = await getUserById(req.session.userId);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (e) {
      console.error('Ошибка при получении пользователя:', e);
    }
  }
  res.redirect('/admin');
}

// Маршруты

app.get('/admin', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin', async (req, res) => {
  const { username, password } = req.body;

  if (username === process.env.ADMIN_LOGIN && password === process.env.ADMIN_PASSWORD) {
    req.session.userId = ADMIN_ID;
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Неверный логин или пароль' });
  }
});

app.get('/broadcast', requireAuth, (req, res) => {
  res.render('broadcast-form', { user: req.user });
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

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const showInactive = req.query.showInactive === 'true';
    const expiringLimit = req.query.expiringLimit ? parseInt(req.query.expiringLimit, 10) : 10;
    const expiringOffset = req.query.expiringOffset ? parseInt(req.query.expiringOffset, 10) : 0;

    const expiringSoon = await getExpiringUsers();
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
      user: req.user,
      page: 'dashboard'
    });
  } catch (e) {
    console.error('Ошибка при загрузке dashboard:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/export', requireAuth, async (req, res) => {
  try {
    const users = await getAllUsers(true);

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
      totalPages,
      user: req.user
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

  // Логика установки тарифа (не показана, дополни по необходимости)

  res.redirect('/dashboard');
});

// Webhook для Telegram бота
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('Ошибка в handleUpdate:', err));
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  if (WEBHOOK_URL) {
    bot.telegram.setWebhook(`${WEBHOOK_URL}${WEBHOOK_PATH}`).then(() => {
      console.log('Webhook установлен');
    }).catch(console.error);
  } else {
    bot.launch();
  }
});