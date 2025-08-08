// routes/admin.js
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';

import { getAllUsers, supabase } from '../db.js';
import { loadTexts, allTextsSync, setText } from '../config/texts.js';
import setupAdminUsers from './admin-users.js';

export default function setupAdmin(opts = {}) {
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
        maxAge: 7 * 24 * 3600 * 1000,
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
    res.send(`<!doctype html><html lang="ru"><head>
      <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Админ — вход</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:40px;background:#0b0c10;color:#eaf0f1}
        .card{max-width:420px;margin:0 auto;background:#14161b;border:1px solid #2a2f36;border-radius:14px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.3)}
        h1{font-size:20px;margin:0 0 12px}
        label{display:block;margin:12px 0 4px}
        input{width:100%;padding:10px;border-radius:10px;border:1px solid #2a2f36;background:#0f1115;color:#eaf0f1}
        button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
        .muted{color:#9aa4b2;font-size:13px;margin-top:8px}
      </style>
    </head><body>
      <div class="card">
        <h1>Вход в админку</h1>
        <form method="post" action="/admin/login">
          <label>Логин</label><input name="login" required>
          <label>Пароль</label><input name="password" type="password" required>
          <button type="submit">Войти</button>
        </form>
        <div class="muted">Доступ только у владельца.</div>
      </div>
    </body></html>`);
  });

  // Login / Logout
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

      res.send(`<!doctype html><html lang="ru"><head>
        <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Админ — дашборд</title>
        <style>
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:24px;background:#0b0c10;color:#eaf0f1}
          .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
          .card{background:#14161b;border:1px solid #2a2f36;border-radius:14px;padding:16px}
          .k{color:#9aa4b2;font-size:13px}
          h1{margin:0 0 16px}
          table{width:100%;border-collapse:collapse}
          th,td{padding:10px;border-bottom:1px solid #232a32;font-size:14px}
          th{text-align:left;color:#9aa4b2}
          .topbar{display:flex;gap:8px;align-items:center;margin-bottom:16px}
          .btn{display:inline-block;padding:8px 12px;border-radius:10px;background:#2a2f36;color:#eaf0f1;text-decoration:none}
          .btn-primary{background:#4f46e5}
          form{display:inline}
        </style>
      </head><body>
        <div class="topbar">
          <a class="btn" href="/dashboard">Дашборд</a>
          <a class="btn" href="/admin/users">Пользователи</a>
          <a class="btn" href="/admin/texts">Тексты бота</a>
          <a class="btn" href="/admin/broadcast">Рассылка</a>
          <form method="post" action="/admin/logout"><button class="btn btn-primary">Выйти</button></form>
        </div>

        <h1>Сводка</h1>
        <div class="row">
          <div class="card"><div class="k">Пользователей всего</div><div style="font-size:28px;font-weight:700">${totalUsers}</div></div>
          <div class="card"><div class="k">Активных всего</div><div style="font-size:28px;font-weight:700">${activeUsers}</div></div>
          <div class="card"><div class="k">Активных сегодня</div><div style="font-size:28px;font-weight:700">${activeToday}</div></div>
          <div class="card"><div class="k">Загрузок за всё время</div><div style="font-size:28px;font-weight:700">${totalDownloads}</div></div>
        </div>

        <div class="card">
          <div class="k">Последние 20 пользователей</div>
          <table>
            <thead><tr><th>ID</th><th>Имя</th><th>Юзернейм</th><th>Создан</th><th>Последняя активность</th><th>Премиум до</th><th>Лимит/день</th><th>Всего загрузок</th></tr></thead>
            <tbody>
              ${lastUsers.map(u => `
                <tr>
                  <td>${u.id}</td>
                  <td>${u.first_name ?? ''}</td>
                  <td>${u.username ? '@'+u.username : '—'}</td>
                  <td>${formatDate(u.created_at)}</td>
                  <td>${formatDate(u.last_active)}</td>
                  <td>${formatDate(u.premium_until)}</td>
                  <td>${u.premium_limit ?? 0}</td>
                  <td>${u.total_downloads ?? 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </body></html>`);
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

      res.send(`<!doctype html><html lang="ru"><head>
        <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Админ — тексты бота</title>
        <style>
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:24px;background:#0b0c10;color:#eaf0f1}
          .topbar{display:flex;gap:8px;align-items:center;margin-bottom:16px}
          .btn{display:inline-block;padding:8px 12px;border-radius:10px;background:#2a2f36;color:#eaf0f1;text-decoration:none}
          .btn-primary{background:#4f46e5}
          table{width:100%;border-collapse:collapse}
          th,td{padding:10px;border-bottom:1px solid #232a32;vertical-align:top}
          th{text-align:left;color:#9aa4b2}
          .card{background:#14161b;border:1px solid #2a2f36;border-radius:14px;padding:16px}
        </style>
      </head><body>
        <div class="topbar">
          <a class="btn" href="/dashboard">Дашборд</a>
          <a class="btn" href="/admin/users">Пользователи</a>
          <a class="btn btn-primary" href="/admin/texts">Тексты бота</a>
          <a class="btn" href="/admin/broadcast">Рассылка</a>
          <form method="post" action="/admin/logout"><button class="btn">Выйти</button></form>
        </div>

        <div class="card">
          <h2 style="margin-top:0">Редактор текстов</h2>
          <form method="post" action="/admin/texts">
            <table>
              <thead><tr><th>Ключ</th><th>Значение</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <div style="margin-top:12px">
              <button class="btn btn-primary" type="submit">Сохранить</button>
            </div>
          </form>
        </div>
      </body></html>`);
    } catch (e) {
      console.error('[admin] /admin/texts GET error:', e);
      res.status(500).send('Ошибка загрузки текстов');
    }
  });

  app.post('/admin/texts', requireAdmin, async (req, res) => {
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

  // --- Рассылка (без EJS) ---
  app.get('/admin/broadcast', requireAdmin, (_req, res) => {
    res.send(`<!doctype html><html lang="ru"><head>
      <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Админ — рассылка</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;margin:24px;background:#0b0c10;color:#eaf0f1}
        .topbar{display:flex;gap:8px;align-items:center;margin-bottom:16px}
        .btn{display:inline-block;padding:8px 12px;border-radius:10px;background:#2a2f36;color:#eaf0f1;text-decoration:none}
        .btn-primary{background:#4f46e5}
        .card{background:#14161b;border:1px solid #2a2f36;border-radius:14px;padding:16px;max-width:720px}
        textarea{width:100%;min-height:160px;padding:10px;border-radius:10px;border:1px solid #2a2f36;background:#0f1115;color:#eaf0f1}
      </style>
    </head><body>
      <div class="topbar">
        <a class="btn" href="/dashboard">Дашборд</a>
        <a class="btn" href="/admin/users">Пользователи</a>
        <a class="btn" href="/admin/texts">Тексты бота</a>
        <a class="btn btn-primary" href="/admin/broadcast">Рассылка</a>
        <form method="post" action="/admin/logout"><button class="btn">Выйти</button></form>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Массовая рассылка</h2>
        <form method="post" action="/admin/broadcast">
          <label>Сообщение (HTML разрешён)</label>
          <textarea name="message" placeholder="Текст..."></textarea>
          <div style="margin-top:12px">
            <label><input type="checkbox" name="only_active" value="1" checked> Только активным пользователям</label>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-primary" type="submit">Отправить</button>
            <a class="btn" href="/dashboard">Отмена</a>
          </div>
        </form>
      </div>
    </body></html>`);
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