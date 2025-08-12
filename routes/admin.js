// routes/admin.js

import express from 'express';
import session from 'express-session';
import pgSessionFactory from 'connect-pg-simple';
import csrf from 'csurf';

// Импортируем все необходимое из централизованных модулей
import { pool, supabase, getAllUsers } from '../db.js';
import { loadTexts, allTextsSync, setText } from '../config/texts.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET, NODE_ENV } from '../src/config.js';
import setupAdminUsers from './admin-users.js';

export function setupAdmin(opts = {}) {
  const { app, bot } = opts;

  if (!app) throw new Error('setupAdmin: app is required');

  // Парсеры форм
  app.use(express.urlencoded({ extended: true }));

  // Настройка сессий и CSRF
  const pgSession = pgSessionFactory(session);
  app.use(
    session({
      name: 'scm_admin',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: NODE_ENV === 'production',
        maxAge: 7 * 24 * 3600 * 1000, // 7 дней
      },
    })
  );

  const csrfProtection = csrf({ cookie: true });
  app.use(csrfProtection);

  // No-cache middleware
  app.use(['/admin', '/dashboard'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  const requireAdmin = (req, res, next) => (req.session?.isAdmin ? next() : res.redirect('/admin/login'));

  // Маршруты
  app.get('/admin/login', (req, res) => {
    if (req.session?.isAdmin) return res.redirect('/dashboard');
    res.render('login', { csrfToken: req.csrfToken() });
  });

  app.post('/admin/login', (req, res) => {
    const { login, password } = req.body || {};
    if (login === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
      req.session.isAdmin = true;
      return res.redirect('/dashboard');
    }
    res.status(401).send(`<!doctype html><meta charset="utf-8"/><script>alert('Неверные данные');location.href='/admin/login'</script>`);
  });

  app.post('/admin/logout', requireAdmin, (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  // Подключаем модуль для управления пользователями
  setupAdminUsers(app);

  // Dashboard
  app.get('/dashboard', requireAdmin, async (_req, res, next) => {
    try {
      const users = await getAllUsers(true);
      const totalUsers = users.length;
      const activeUsers = users.filter(u => u.active).length;
      const now = new Date();
      const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;
      const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);

      const lastUsers = users.slice(0, 20);

      const formatDate = (val) => val ? new Date(val).toLocaleString('ru-RU') : '—';

      res.render('dashboard', {
        totalUsers,
        activeUsers,
        activeToday,
        totalDownloads,
        lastUsers,
        formatDate,
        csrfToken: req.csrfToken()
      });
    } catch (e) {
      next(e);
    }
  });

  // Редактор текстов
  app.get('/admin/texts', requireAdmin, async (req, res) => {
    try {
      await loadTexts();
      const texts = allTextsSync();
      const rows = Object.entries(texts).map(([key, val]) => `
        <tr>
          <td style="vertical-align:top"><code>${key}</code></td>
          <td><textarea name="${key}" rows="4" style="width:100%;padding:8px;border-radius:10px;border:1px solid #2a2f36;background:#0f1115;color:#eaf0f1">${escapeHtml(val)}</textarea></td>
        </tr>
      `).join('');

      res.render('texts', { rows, csrfToken: req.csrfToken() });
    } catch (e) {
      console.error('[admin] /admin/texts GET error:', e);
      res.status(500).send('Ошибка загрузки текстов');
    }
  });

  app.post('/admin/texts', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      for (const [key, value] of Object.entries(body)) {
        if (key === '_csrf') continue;
        await setText(key, String(value ?? ''));
      }
      await loadTexts(true);
      res.redirect('/admin/texts');
    } catch (e) {
      console.error('[admin] /admin/texts POST error:', e);
      res.status(500).send('Ошибка сохранения текстов');
    }
  });

  // Рассылка
  app.get('/admin/broadcast', requireAdmin, (req, res) => {
    res.render('broadcast', { csrfToken: req.csrfToken() });
  });

  app.post('/admin/broadcast', requireAdmin, async (req, res) => {
    if (!bot) return res.status(500).send('Бот недоступен для рассылки.');
    const text = String(req.body?.message ?? '').trim();
    const onlyActive = !!req.body?.only_active;
    if (!text) return res.status(400).send('Пустое сообщение. <a href="/admin/broadcast">Назад</a>');

    try {
      let q = supabase.from('users').select('id, active', { count: 'exact' });
      const { data: users, error } = await q.limit(50000);
      if (error) throw error;

      let list = users || [];
      if (onlyActive) list = list.filter(u => u.active);

      let sent = 0, failed = 0;
      for (const u of list) {
        try {
          await bot.telegram.sendMessage(u.id, text, { parse_mode: 'HTML' });
          sent++;
        } catch (e) {
          failed++;
          if (e?.response?.error_code === 403) {
            await supabase.from('users').update({ active: false }).eq('id', u.id);
          }
        }
        await new Promise(r => setTimeout(r, 35));
      }
      res.send(`<!doctype html><meta charset="utf-8">
        Готово: отправлено ${sent}, ошибок ${failed}. <a href="/dashboard">Назад</a>`);
    } catch (e) {
      console.error('[admin/broadcast] error:', e);
      res.status(500).send('Ошибка рассылки: ' + (e.message || e));
    }
  });

  // Вспомогательная функция
  function escapeHtml(str = '') {
    return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }
}