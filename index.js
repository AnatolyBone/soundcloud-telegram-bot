// index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

// Наши модули
import { bot } from './src/bot.js';
import redisService from './services/redisService.js';
import { setupAdmin } from './routes/admin.js';
import BotService from './services/botService.js'; // Предполагая, что вы его используете
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';
import { cleanupCache, startIndexer } from './src/utils.js';
import { resetDailyStats } from './db.js';
import { initNotifier, startNotifier } from './services/notifier.js';

// ===== Конфигурация =====
const {
  ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT = 3000,
  SESSION_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD, STORAGE_CHANNEL_ID
} = process.env;

if (!ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD || !WEBHOOK_URL || !STORAGE_CHANNEL_ID) {
  console.error('❌ Отсутствуют обязательные переменные окружения!');
  process.exit(1);
}

// ===== Инициализация =====
initNotifier(bot);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
const botService = new BotService(bot); // botService теперь использует импортированный bot

// ===== Основная функция запуска =====
async function startApp() {
  try {
    await loadTexts();
    await redisService.connect();
    console.log('✅ Redis подключён');

    if (!fs.existsSync(cacheDir)) {
      await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    app.set('trust proxy', 1);
    app.use(express.json());
    app.get('/health', (_req, res) => res.type('text').send('OK'));
    app.get('/', (_req, res) => res.type('text').send('OK'));
    app.use('/static', express.static(path.join(__dirname, 'public', 'static')));
    
    setupAdmin({ app, bot, __dirname, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET });

    botService.setupTelegramBot(); // Здесь должны быть ваши bot.on, bot.hears и т.д.

    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    
    startIndexer(bot, STORAGE_CHANNEL_ID).catch(err => console.error("🔴 Критическая ошибка в индексаторе:", err));
    startNotifier().catch(err => console.error("🔴 Критическая ошибка в планировщике:", err));
    
    if (process.env.NODE_ENV === 'production') {
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