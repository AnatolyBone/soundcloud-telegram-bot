import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Telegraf } from 'telegraf';
import { createClient } from 'redis';
import { initNotifier } from './services/notifier.js';
import RedisService from './services/redisService.js';
import BotService from './services/botService.js';
import { setupAdmin } from './routes/admin.js';
import { loadTexts, T } from './config/texts.js';
import { getUser, updateUserField, setPremium, cacheTrack, findCachedTrack } from './db.js';
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { getTariffName, getDaysLeft, extractUrl, isSubscribed, formatMenuMessage, cleanupCache, startIndexer } from './src/utils.js';

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_PATH = '/telegram';
const PORT = process.env.PORT ?? 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'a-very-secret-key-for-session';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}

// ===== App/Bot =====
const bot = new Telegraf(BOT_TOKEN);
initNotifier(bot);

const botService = new BotService(bot);

// ===== App =====
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');

app.set('trust proxy', 1);
app.use(express.json()); // JSON POST для админки/рассылки

// health-check для Render
app.get('/health', (_req, res) => res.type('text').send('OK'));
app.get('/', (_req, res) => res.type('text').send('OK'));

// статика для админки
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

// Redis Client
const redisService = new RedisService();
let redisClient = null;

// Доступно из других модулей
function getRedisClient() {
  if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
  return redisClient;
}

// ===== Утилиты =====
async function startApp() {
  try {
    // Логируем старт приложения
    console.log('Запуск приложения...');

    // Подгружаем тексты из БД до регистрации хендлеров
    await loadTexts();
    console.log('✅ Тексты загружены');

    // Redis
    redisClient = await redisService.connect();
    console.log('✅ Redis подключён');

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    console.log(`✅ Директория кэша: ${cacheDir}`);

    // Админка
    setupAdmin({
      app,
      bot,
      __dirname,
      ADMIN_ID,
      ADMIN_LOGIN,
      ADMIN_PASSWORD,
      SESSION_SECRET,
      STORAGE_CHANNEL_ID,
      redis: redisClient,
    });

    // Телеграм-бот
    botService.setupTelegramBot();
    console.log('✅ Бот настроен');

    // Плановые задачи
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    cleanupCache(cacheDir, 60);

    if (process.env.NODE_ENV === 'production') {
      // Логируем запуск в продакшн-режиме
      console.log('Запуск в продакшн-режиме...');

      // Rate limit только на вебхук
      const webhookLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        trustProxy: true,
      });
      app.use(WEBHOOK_PATH, webhookLimiter);

      app.use(await bot.createWebhook({
        domain: WEBHOOK_URL,
        path: WEBHOOK_PATH,
      }));

      app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
    } else {
      await bot.launch();
      console.log('✅ Бот запущен в режиме long-polling.');
    }

    // Фоновые сервисы
    startIndexer().catch(err => console.error("🔴 Критическая ошибка в индексаторе, не удалось запустить:", err));
    startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));

  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске приложения:', err);
    process.exit(1);
  }
}

// Корректное завершение
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

// Экспорт для других модулей
export { app, bot, getRedisClient };