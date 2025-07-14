// src/app.js
import express from 'express';
import compression from 'compression';
import session from 'express-session';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { fileURLToPath } from 'url';
import pgSession from './database/sessionStore.js';
import { pool } from './database/pool.js';
import { localsMiddleware } from './middlewares/locals.js';
import { authMiddleware } from './middlewares/auth.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: pgSession(pool),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 86400 * 1000 }
}));
app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');

app.use(localsMiddleware);
app.use(authMiddleware);

export default app;