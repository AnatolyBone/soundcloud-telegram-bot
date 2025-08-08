// routes/admin.js
import path from 'path';
import express from 'express';
import session from 'express-session';
import compression from 'compression';
import expressLayouts from 'express-ejs-layouts';
import multer from 'multer';
import pgSessionFactory from 'connect-pg-simple';
import fs from 'fs';

import {
  pool,
  supabase,
  getDashboardStats,
  getDownloadsByDate,
  getRegistrationsByDate,
  getActiveUsersByDate,
  getUserActivityByDayHour,
  getExpiringUsersPaginated,
  getExpiringUsersCount,
  getReferralSourcesStats,
  getFunnelData,
  getLastMonths,
  getAllUsers,
  getUserById,
  updateUserField,
} from '../db.js';

// ==== helpers для графиков ====
function convertObjToArray(dataObj) {
  if (!dataObj) return [];
  return Object.entries(dataObj).map(([date, count]) => ({
    date,
    count: Number(count) || 0,
  }));
}

function filterStatsByPeriod(data, period) {
  if (!Array.isArray(data)) return [];
  const now = new Date();

  // Число = последние N дней
  if (!isNaN(period)) {
    const days = parseInt(period);
    const cutoff = new Date(now.getTime() - days * 86400000);
    return data.filter(item => !isNaN(new Date(item.date)) && new Date(item.date) >= cutoff);
  }

  // Формат YYYY-MM — фильтр по месяцу
  if (/^\d{4}-\d{2}$/.test(period)) {
    return data.filter(item => item.date && item.date.startsWith(period));
  }

  return data;
}

function prepareChartData(registrations, downloads, active) {
  const dateSet = new Set([
    ...registrations.map(r => r.date),
    ...downloads.map(d => d.date),
    ...active.map(a => a.date),
  ]);
  const dates = Array.from(dateSet).sort();

  const regMap = new Map(registrations.map(r => [r.date, Number(r.count) || 0]));
  const dlMap  = new Map(downloads.map(d => [d.date, Number(d.count) || 0]));
  const actMap = new Map(active.map(a => [a.date, Number(a.count) || 0]));

  return {
    labels: dates,
    datasets: [
      { label: 'Регистрации',           data: dates.map(d => regMap.get(d) || 0), fill: false },
      { label: 'Загрузки',              data: dates.map(d => dlMap.get(d)  || 0), fill: false },
      { label: 'Активные пользователи', data: dates.map(d => actMap.get(d) || 0), fill: false },
    ],
  };
}

function computeActivityByHour(activityByDayHour) {
  const hours = Array(24).fill(0);
  if (!activityByDayHour) return hours;

  for (const day in activityByDayHour) {
    const hoursData = activityByDayHour[day];
    if (Array.isArray(hoursData)) {
      for (let h = 0; h < 24; h++) {
        hours[h] += Number(hoursData[h]) || 0;
      }
    }
  }
  return hours;
}

function computeActivityByWeekday(activityByDayHour) {
  const weekdays = Array(7).fill(0); // 0=Вс ... 6=Сб
  if (!activityByDayHour) return weekdays;

  for (const dayStr in activityByDayHour) {
    const arr = activityByDayHour[dayStr];
    const dayTotal = (Array.isArray(arr) ? arr : Object.values(arr || {}))
      .reduce((a, b) => a + (Number(b) || 0), 0);
    const dow = new Date(dayStr);
    if (!isNaN(dow)) {
      weekdays[dow.getDay()] += dayTotal;
    }
  }
  return weekdays;
}

export default function setupAdmin({
  app,
  bot,
  __dirname,
  ADMIN_ID,
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  STORAGE_CHANNEL_ID,
}) {
  // важное для Render и rate-limit / реального IP
  app.set('trust proxy', true);

  // базовые middlewares
  app.use(compression());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // шаблоны
  app.use(expressLayouts);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('layout', 'layout');

  // статика
  app.use('/static', express.static(path.join(__dirname, 'public')));

  // сессии (pg)
  const PgSession = pgSessionFactory(session);
  app.use(session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
  }));

  // подсовываем user/query в шаблоны
  app.use(async (req, res, next) => {
    res.locals.user = null;
    res.locals.page = '';
    res.locals.query = req.query || {};
    try {
      if (req.session.authenticated && req.session.userId === ADMIN_ID) {
        req.user = await getUserById(req.session.userId);
        res.locals.user = req.user;
      }
    } catch (e) {
      console.error(e);
    }
    next();
  });

  const requireAuth = (req, res, next) => {
    if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
    res.redirect('/admin');
  };

  // health
  app.get('/health', (req, res) => res.send('OK'));

  // login
  app.get('/admin', (req, res) => {
    if (req.session.authenticated && req.session.userId === ADMIN_ID) {
      return res.redirect('/dashboard');
    }
    res.render('login', { title: 'Вход в админку', error: null, layout: false });
  });

  app.post('/admin', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
      req.session.authenticated = true;
      req.session.userId = ADMIN_ID;
      return res.redirect('/dashboard');
    }
    res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль', layout: false });
  });

  // Дашборд
  app.get('/dashboard', requireAuth, async (req, res, next) => {
    try {
      const { period = '30', showInactive = 'false', expiringLimit = '10', expiringOffset = '0' } = req.query;

      const [
        stats,
        downloadsByDateRaw,
        registrationsByDateRaw,
        activeByDateRaw,
        activityByDayHour,
        expiringSoon,
        expiringCount,
        referralStats,
        funnelCounts,
        lastMonths,
        users,
      ] = await Promise.all([
        getDashboardStats(),
        getDownloadsByDate(90), // запас по дате, дальше фильтруем
        getRegistrationsByDate(),
        getActiveUsersByDate(),
        getUserActivityByDayHour(),
        getExpiringUsersPaginated(parseInt(expiringLimit), parseInt(expiringOffset)),
        getExpiringUsersCount(),
        getReferralSourcesStats(),
        getFunnelData(new Date('2000-01-01').toISOString(), new Date().toISOString()),
        getLastMonths(6),
        getAllUsers(showInactive === 'true'),
      ]);

      // графики
      const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
      const filteredDownloads     = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw),     period);
      const filteredActive        = filterStatsByPeriod(convertObjToArray(activeByDateRaw),        period);

      const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);
      const chartDataHourActivity = {
        labels: [...Array(24).keys()].map(h => `${h}:00`),
        datasets: [{ label: 'Активность по часам', data: computeActivityByHour(activityByDayHour) }],
      };
      const chartDataWeekdayActivity = {
        labels: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
        datasets: [{ label: 'Активность по дням недели', data: computeActivityByWeekday(activityByDayHour) }],
      };

      res.render('dashboard', {
        title: 'Панель управления',
        page: 'dashboard',
        user: req.user,
        period,
        showInactive: showInactive === 'true',
        stats, // { total_users, total_downloads, active_today, ... }
        users,
        expiringSoon,
        expiringCount,
        referralStats,
        funnelData: funnelCounts,
        lastMonths,
        expiringLimit: parseInt(expiringLimit),
        expiringOffset: parseInt(expiringOffset),
        chartDataCombined,
        chartDataHourActivity,
        chartDataWeekdayActivity,
        query: req.query, // для баннера ping
      });
    } catch (e) {
      next(e);
    }
  });

  // Проверка связи со сторедж-каналом
  app.get('/admin/test-storage-send', requireAuth, async (req, res) => {
    try {
      await bot.telegram.sendMessage(STORAGE_CHANNEL_ID, 'Проверка связи админки со сторедж-каналом ✅');
      res.redirect('/dashboard?ping=ok');
    } catch (e) {
      console.error('Storage test failed:', e.message);
      res.redirect('/dashboard?ping=fail');
    }
  });

  // Список пользователей с поиском
  app.get('/users', requireAuth, async (req, res, next) => {
    try {
      const q = (req.query.q || '').trim();
      let sql = 'SELECT * FROM users';
      const params = [];
      if (q) {
        sql += ' WHERE CAST(id AS TEXT) ILIKE $1 OR username ILIKE $1 OR first_name ILIKE $1';
        params.push(`%${q}%`);
      }
      sql += ' ORDER BY last_active DESC LIMIT 200';
      const { rows } = await pool.query(sql, params);
      res.render('users', { title: 'Пользователи', page: 'users', users: rows, q });
    } catch (e) {
      next(e);
    }
  });

  // Профиль пользователя
  app.get('/user/:id', requireAuth, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) return res.status(400).send('Неверный ID');
      const user = await getUserById(userId);
      if (!user) return res.status(404).send('Пользователь не найден');

      const [downloadsResult, referralsResult] = await Promise.all([
        supabase
          .from('events')
          .select('*')
          .eq('user_id', userId)
          .eq('event_type', 'download_start')
          .order('created_at', { ascending: false })
          .limit(100),
        pool.query('SELECT id, first_name, username, created_at FROM users WHERE referrer_id = $1', [userId]),
      ]);

      res.render('user-profile', {
        title: `Профиль: ${user.first_name || user.username || user.id}`,
        user,
        downloads: downloadsResult.data || [],
        referrals: referralsResult.rows,
        page: 'user-profile',
      });
    } catch (e) {
      next(e);
    }
  });

  // смена тарифа с профиля
  app.post('/user/:id/set-tariff', requireAuth, async (req, res, next) => {
    try {
      const userId = parseInt(req.params.id);
      const limit = parseInt(req.body.premium_limit);
      if (!limit || isNaN(limit)) return res.status(400).send('Некорректный лимит');
      await updateUserField(userId, 'premium_limit', limit);
      res.redirect(`/user/${userId}`);
    } catch (e) {
      next(e);
    }
  });

  // Рассылка
  const upload = multer({ dest: path.join(__dirname, 'uploads') });
  app.get('/broadcast', requireAuth, (req, res) => {
    res.render('broadcast-form', { title: 'Рассылка', error: null, success: null, page: 'broadcast' });
  });

  app.post('/broadcast', requireAuth, upload.single('audio'), async (req, res, next) => {
    try {
      const { message } = req.body;
      const audio = req.file;
      if (!message && !audio) {
        return res.status(400).render('broadcast-form', {
          title: 'Рассылка',
          error: 'Текст или аудиофайл обязательны',
          success: null,
          page: 'broadcast',
        });
      }

      const users = await getAllUsers(false);
      let successCount = 0, errorCount = 0;

      for (const u of users) {
        try {
          if (audio) {
            await bot.telegram.sendAudio(u.id, { source: fs.createReadStream(audio.path) }, { caption: message });
          } else {
            await bot.telegram.sendMessage(u.id, message);
          }
          successCount++;
        } catch (e) {
          errorCount++;
          if (e.response?.error_code === 403) await updateUserField(u.id, 'active', false);
        }
        await new Promise(r => setTimeout(r, 100));
      }

      if (audio) fs.unlinkSync(audio.path);
      try {
        await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена:\n✅ Успешно: ${successCount}\n❌ Ошибок: ${errorCount}`);
      } catch (adminError) {
        console.error('Не удалось отправить отчет админу:', adminError.message);
      }

      res.render('broadcast-form', {
        title: 'Рассылка',
        success: `Отправлено ${successCount} сообщений.`,
        error: `Ошибок: ${errorCount}.`,
        page: 'broadcast',
      });
    } catch (e) {
      next(e);
    }
  });

  // Истекающие подписки
  app.get('/expiring-users', requireAuth, async (req, res, next) => {
    try {
      const pageNum = parseInt(req.query.page) || 1;
      const perPage = 10;
      const total = await getExpiringUsersCount();
      const users = await getExpiringUsersPaginated(perPage, (pageNum - 1) * perPage);
      res.render('expiring-users', {
        users,
        page: 'expiring-users',
        title: 'Истекающие подписки',
        totalPages: Math.ceil(total / perPage),
        currentPage: pageNum,
      });
    } catch (e) { next(e); }
  });

  // выход
  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin'));
  });

  // Глобальный обработчик ошибок
  app.use((err, req, res, next) => {
    console.error('🔴 Необработанная ошибка:', err);
    const statusCode = err.status || 500;
    const message = err.message || 'Внутренняя ошибка сервера';
    res.status(statusCode);
    if (req.originalUrl.startsWith('/api/')) {
      return res.json({ error: message });
    }
    res.render('errors', {
      title: `Ошибка ${statusCode}`,
      message,
      statusCode,
      error: err,
      page: 'error',
      layout: 'layout',
    });
  });
}