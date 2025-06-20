if (!queues[userId]) queues[userId] = [];
  queues[userId].push(job);
  if (!processing[userId]) {
    processing[userId] = true;
    while (queues[userId].length > 0) {
      const task = queues[userId].shift();
      try {
        await task();
      } catch (err) {
        console.error('Ошибка при выполнении задачи в очереди:', err);
      }
    }
    processing[userId] = false;
  }
}
async function processTrack(ctx, url) {
  const u = await getUser(ctx.from.id);
  const lang = getLang(u);
  try {
    await ctx.reply(texts[lang].downloading);
    const info = await ytdl(url, { dumpSingleJson: true });

    // Чистим название — разрешаем только буквы, цифры, пробелы, дефисы и подчёркивания
    let nameRaw = (info.title || 'track')
      .replace(/[^\w\s\-]/g, '') // оставляем буквы, цифры, пробелы, дефисы, подчёркивания
      .trim()
      .replace(/\s+/g, '_')      // пробелы заменяем на подчёркивания
      .slice(0, 50);

    const name = nameRaw; // Убираем добавление чисел/времени

    const fp = path.join(cacheDir, `${name}.mp3`);

    if (!fs.existsSync(fp)) {
      await ytdl(url, { extractAudio: true, audioFormat: 'mp3', output: fp });
    }

    await incrementDownloads(ctx.from.id, name);
    await saveTrackForUser(ctx.from.id, name);
    await ctx.replyWithAudio({ source: fs.createReadStream(fp), filename: ${name}.mp3 });

  } catch (e) {
    console.error('❌ Ошибка при обработке трека:', e);
    await ctx.reply(texts[lang].error);
  }
}

// Настройка webhook
app.use(bot.webhookCallback('/telegram'));

// Веб-админка

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_LOGIN &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Неверные данные' });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const users = await getAllUsers();
  const totalDownloads = users.reduce((sum, u) => sum + (u.downloads_today || 0), 0);

  const stats = {
    totalUsers: users.length,
    totalDownloads,
    free: users.filter(u => u.premium_limit === 10).length,
    plus: users.filter(u => u.premium_limit === 50).length,
    pro: users.filter(u => u.premium_limit === 100).length,
    unlimited: users.filter(u => u.premium_limit >= 1000).length
  };

  const reviews = await getLatestReviews(10);

  res.render('dashboard', { users, stats, reviews });
});

// ====== Добавлен маршрут для установки тарифа пользователю ======

app.post('/set-tariff', requireAuth, async (req, res) => {
  const { userId, limit } = req.body;

  if (!userId || !limit) {
    return res.status(400).send('Missing data');
  }

  const parsedLimit = parseInt(limit, 10);
  if (![10, 50, 100, 1000].includes(parsedLimit)) {
    return res.status(400).send('Invalid limit');
  }

  try {
    await setPremium(userId, parsedLimit);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Server error');
  }
});

// Выход из админки
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

// Простая проверка работоспособности
app.get('/', (_, res) => res.send('✅ OK'));

// Запуск сервера
const PORT = process.env.PORT || 3000;
bot.telegram.setWebhook(WEBHOOK_URL)
  .then(() => console.log('✅ Webhook установлен:', WEBHOOK_URL))
  .catch(err => console.error('❌ Webhook error:', err));

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));