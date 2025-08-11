// index.js (ФИНАЛЬНАЯ ВЕРСИЯ С ПРАВИЛЬНЫМИ ПУТЯМИ)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import session from 'express-session';
import pgSessionFactory from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';

// Импорты с правильными путями
import { bot } from './src/bot.js';
import { pool, resetDailyStats } from './db.js'; // db.js в корне
import redisService from './services/redisService.js'; // services/ в корне
import BotService from './services/botService.js';     // services/ в корне
import { setupAdmin } from './routes/admin.js';      // routes/ в корне
import { loadTexts } from './config/texts.js';       // config/ в корне
import { downloadQueue } from './services/downloadManager.js'; // services/ в корне
import { cleanupCache, startIndexer } from './src/utils.js'; // utils.js в src/
import { initNotifier, startNotifier } from './services/notifier.js'; // services/ в корне
import {
  ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT, SESSION_SECRET,
  ADMIN_LOGIN, ADMIN_PASSWORD, STORAGE_CHANNEL_ID, NODE_ENV
} from './config.js'; // config.js в корне

// Проверка переменных
if (!ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID || !WEBHOOK_PATH) {
  console.error('❌ Отсутствуют обязательные переменные окружения!');
  process.exit(1);
}

// ===== Инициализация =====
initNotifier(bot);
const botService = new BotService(bot);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache'); // папка cache в корне

// ===== Настройка Express =====
app.set('trust proxy', 1);
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public', 'static'))); // папка public в корне
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.get('/', (_req, res) => res.status(200).send('Bot is running'));

// ===== Основная функция запуска =====
async function startApp() {
  try {
    await loadTexts();
    await redisService.connect();
    console.log('✅ Redis подключён');

    if (!fs.existsSync(cacheDir)) {
      await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    const pgSession = pgSessionFactory(session);
    app.use(session({
        store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
    }));

    setupAdmin({ app, bot, __dirname, redis: redisService.getClient() });
    botService.setupTelegramBot();

    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);

    if (NODE_ENV === 'production') {
      const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
      app.use(WEBHOOK_PATH, webhookLimiter);
      const webhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      await bot.telegram.setWebhook(webhookUrl);
      
      app.post(WEBHOOK_PATH, (req, res) => {
        bot.handleUpdate(req.body, res);
        return res.sendStatus(200);
      });
      
      app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}. Вебхук: ${webhookUrl}`));
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch();
      console.log('✅ Бот запущен в режиме long-polling.');
    }

    startIndexer(bot, STORAGE_CHANNEL_ID).catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));
    startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));

  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске приложения:', err);
    process.exit(1);
  }
}

// ===== Корректное завершение =====
const stopBot = (signal) => {
  console.log(`Получен сигнал ${signal}. Завершение работы...`);
  try {
    if (bot.polling?.isRunning()) {
      bot.stop(signal);
    }
  } catch {}
  setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();