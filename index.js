// index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Telegraf } from 'telegraf';

// Наши сервисы и модули
import redisService from './services/redisService.js';
import BotService from './services/botService.js';
import { setupAdmin } from './routes/admin.js';
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';
import { cleanupCache, startIndexer } from './src/utils.js';
import { resetDailyStats } from './db.js';

// ===== Конфигурация =====
const {
  BOT_TOKEN, ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT = 3000,
  SESSION_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD, STORAGE_CHANNEL_ID
} = process.env;

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют обязательные переменные окружения!');
  process.exit(1);
}

// ===== Инициализация =====
const bot = new Telegraf(BOT_TOKEN);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
const botService = new BotService(bot);

// ===== Основная функция запуска =====
async function startApp() {
  try {
    // 1. Загружаем тексты
    await loadTexts();

    // 2. Подключаемся к Redis
    await redisService.connect();
    console.log('✅ Redis подключён');

    // 3. Создаем директорию для кэша
    if (!fs.existsSync(cacheDir)) {
      await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    // 4. Настраиваем Express и Админку
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/health', (_req, res) => res.type('text').send('OK'));
    app.use('/static', express.static(path.join(__dirname, 'public', 'static')));
    setupAdmin({ app, bot, __dirname, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET });

    // 5. Настраиваем и запускаем бота
    botService.setupTelegramBot();

    // 6. Запускаем фоновые и плановые задачи
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    startIndexer(bot, STORAGE_CHANNEL_ID).catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));
    
    // 7. Запускаем сервер
    if (process.env.NODE_ENV === 'production') {
      const webhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
      await bot.telegram.setWebhook(webhookUrl);
      app.post(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res));
      app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}. Вебхук: ${webhookUrl}`));
    } else {
        bot.launch();
        console.log('✅ Бот запущен в режиме long-polling.');
    }
  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске приложения:', err);
    process.exit(1);
  }
}

// ===== Корректное завершение =====
const stopBot = (signal) => {
  console.log(`Получен сигнал ${signal}. Завершение работы...`);
  if (bot.polling?.isRunning()) {
    bot.stop(signal);
  }
  setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();

export { bot };