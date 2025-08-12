// index.js (ФИНАЛЬНАЯ ОБЪЕДИНЕННАЯ ВЕРСИЯ)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import rateLimit from 'express-rate-limit';

// Наши модули
import { bot } from './src/bot.js';
import redisService from './services/redisService.js';
import BotService from './services/botService.js';
import { setupAdmin } from './routes/admin.js';
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';
import { cleanupCache, startIndexer } from './src/utils.js';
import { resetDailyStats } from './db.js';
import { initNotifier, startNotifier } from './services/notifier.js';
import {
  ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT,
  SESSION_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD, STORAGE_CHANNEL_ID, NODE_ENV
} from './src/config.js';

// ===== Инициализация =====
initNotifier(bot);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, 'cache');
const botService = new BotService(bot);

// ===== Настройка Express =====
app.set('trust proxy', 1);
app.use(express.json());
app.get('/health', (_req, res) => res.status(200).send('OK'));
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

// ===== Основная функция запуска =====
async function startApp() {
  try {
    await loadTexts();
    await redisService.connect();
    console.log('✅ Redis подключён');

    if (!fs.existsSync(cacheDir)) {
      await fs.promises.mkdir(cacheDir, { recursive: true });
    }
    
    // Настраиваем админку
    setupAdmin({
      app,
      bot,
      __dirname,
      redis: redisService.getClient(),
      ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, SESSION_SECRET
    });
    
    // Настраиваем бота
    botService.setupTelegramBot();

    // <<< НАЧАЛО ИСПРАВЛЕНИЯ: Возвращаем мониторинг и вебхук из старого кода >>>

    // Запускаем фоновые задачи
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    // Мониторинг очереди здесь, чтобы избежать циклических зависимостей
    setInterval(() => {
        if (downloadQueue) {
            console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.active} в работе.`);
        }
    }, 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);

    // Запускаем сервер
    if (NODE_ENV === 'production') {
        // Используем старый, но надежный метод createWebhook
        app.use(await bot.createWebhook({ domain: WEBHOOK_URL, path: WEBHOOK_PATH }));
        app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch();
      console.log('✅ Бот запущен в режиме long-polling.');
    }
    
    // <<< КОНЕЦ ИСПРАВЛЕНИЯ >>>

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
  if (bot.polling?.isRunning()) {
    bot.stop(signal);
  }
  setTimeout(() => process.exit(0), 500);
};

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));

startApp();