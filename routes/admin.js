import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import csrf from 'csurf';
import { getAllUsers, supabase } from '../db.js';
import { loadTexts, allTextsSync, setText } from '../config/texts.js';
import setupAdminUsers from './admin-users.js';
export function setupAdmin(opts = {}) {
  const {
    app,
    ADMIN_LOGIN,
    ADMIN_PASSWORD,
    SESSION_SECRET = 'dev-secret',
    redis,
    bot, // для рассылки
  } = opts;

  if (!app) throw new Error('setupAdmin: app is required');

  // Парсеры форм
  app.use(express.urlencoded({ extended: true }));

  // CSRF защита
  const csrfProtection = csrf({ cookie: true });

  // Сессии
  const store = redis ? new RedisStore({ client: redis, prefix: 'sess:' }) : undefined;
  app.use(
    session({
      name: 'scm_admin',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 3600 * 1000, // 7 дней
      },
    })
  );

  // No-cache
  app.use(['/admin', '/dashboard'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  const requireAdmin = (req, res, next) => (req.session?.isAdmin ? next() : res.redirect('/admin/login'));

  // Login page
  app.get('/admin/login', (req, res) => {
    if (req.session?.isAdmin) return res.redirect('/dashboard');
    res.render('login', { csrfToken: req.csrfToken() });
  });

  // Login / Logout
  app.post('/admin/login', csrfProtection, (req, res) => {
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

  // Подключаем список пользователей (пагинация/CSV/тарифы)
  setupAdminUsers(app);

  // Dashboard
  app.get('/dashboard', requireAdmin, async (_req, res) => {
    try {
      const users = await getAllUsers(true);
      const totalUsers = users.length;
      const activeUsers = users.filter(u => u.active).length;
      const now = new Date();
      const activeToday = users.filter(u => u.last_active && new Date(u.last_active).toDateString() === now.toDateString()).length;
      const totalDownloads = users.reduce((sum, u) => sum + (u.total_downloads || 0), 0);

      const lastUsers = users
        .slice()
        .sort((a, b) => new Date(b.created_at || b.id) - new Date(a.created_at || a.id))
        .slice(0, 20);

      const formatDate = (val) => val ? new Date(val).toLocaleString('ru-RU') : '—';

      res.render('dashboard', { totalUsers, activeUsers, activeToday, totalDownloads, lastUsers, formatDate });
    } catch (e) {
      console.error('[admin] /dashboard error:', e);
      res.status(500).send('Ошибка загрузки дашборда');
    }
  });

  // Редактор текстов
  app.get('/admin/texts', requireAdmin, async (_req, res) => {
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

  app.post('/admin/texts', requireAdmin, csrfProtection, async (req, res) => {
    try {
      const body = req.body || {};
      for (const [key, value] of Object.entries(body)) {
        if (!key) continue;
        await setText(key, String(value ?? ''));
      }
      await loadTexts(true);
      res.redirect('/admin/texts');
    } catch (e) {
      console.error('[admin] /admin/texts POST error:', e);
      res.status(500).send('Ошибка сохранения текстов');
    }
  });

  // --- Рассылка ---
  app.get('/admin/broadcast', requireAdmin, (_req, res) => {
    res.render('broadcast', { csrfToken: req.csrfToken() });
  });

  app.post('/admin/broadcast', requireAdmin, csrfProtection, async (req, res) => {
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
        await new Promise(r => setTimeout(r, 35)); // троттлинг
      }
      res.send(`<!doctype html><meta charset="utf-8">
        Готово: отправлено ${sent}, ошибок ${failed}. <a href="/dashboard">Назад</a>`);
    } catch (e) {
      console.error('[admin/broadcast] error:', e);
      res.status(500).send('Ошибка рассылки: ' + (e.message || e));
    }
  });

  // helper to escape HTML в textarea
  function escapeHtml(str = '') {
    return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }
}