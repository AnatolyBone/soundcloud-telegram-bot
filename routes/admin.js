// routes/admin.js

import express from 'express';
import session from 'express-session';
import pgSessionFactory from 'connect-pg-simple';
import csrf from 'csurf';

import { pool, supabase, getAllUsers } from '../db.js';
import { loadTexts, allTextsSync, setText } from '../config/texts.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET, NODE_ENV } from '../src/config.js';
import setupAdminUsers from './admin-users.js';

export function setupAdmin(opts = {}) {
  const { app, bot } = opts;

  if (!app) throw new Error('setupAdmin: app is required');

  // Парсеры форм
  app.use(express.urlencoded({ extended: true }));

  // <<< НАЧАЛО ИСПРАВЛЕНИЯ: Настройка сессий и CSRF здесь >>>
  const pgSession = pgSessionFactory(session);
  app.use(
    session({
      name: 'scm_admin',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
      cookie: {
        httpOnly: true, sameSite: 'lax',
        secure: NODE_ENV === 'production',
        maxAge: 7 * 24 * 3600 * 1000,
      },
    })
  );

  const csrfProtection = csrf({ cookie: true });
  app.use(csrfProtection);
  // <<< КОНЕЦ ИСПРАВЛЕНИЯ >>>

  app.use(['/admin', '/dashboard'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });

  const requireAdmin = (req, res, next) => (req.session?.isAdmin ? next() : res.redirect('/admin/login'));

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

  setupAdminUsers(app);

  app.get('/dashboard', requireAdmin, async (_req, res, next) => {
    try {
        const users = await getAllUsers(true);
        // ... (остальная логика дашборда)
        res.render('dashboard', { /* ... */ });
    } catch (e) { next(e); }
  });

  // ... (остальные маршруты админки: /texts, /broadcast и т.д.)
}