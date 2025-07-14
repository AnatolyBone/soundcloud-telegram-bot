import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import adminRoutes from './admin/routes.js';
import csrfMiddleware from './middleware/csrf.js';
import { loginLimiter } from './middleware/auth.js';
import './config/env.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Настройки
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Парсеры
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Сессии
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // для https поставить true
  })
);

// Статика
app.use(express.static(path.join(__dirname, '../public')));

// CSRF
app.use(csrfMiddleware);

// Admin
app.use('/admin', loginLimiter, adminRoutes);

// Telegram Webhook можно подключить позже

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});