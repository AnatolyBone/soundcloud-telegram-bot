import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Telegraf } from 'telegraf';

// Services
import { initNotifier, startNotifier } from './services/notifier.js';
import RedisService from './services/redisService.js';
import BotService from './services/botService.js';

// Routes
import { setupAdmin } from './routes/admin.js';

// Configuration and utilities
import { loadTexts } from './config/texts.js';
import { downloadQueue } from './services/downloadManager.js';
import { cleanupCache, startIndexer } from './src/utils.js';
import { resetDailyStats } from './db.js';

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
  console.error('вќЊ РћС‚СЃСѓС‚СЃС‚РІСѓСЋС‚ РЅРµРѕР±С…РѕРґРёРјС‹Рµ РїРµСЂРµРјРµРЅРЅС‹Рµ РѕРєСЂСѓР¶РµРЅРёСЏ!');
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
app.use(express.json()); // JSON POST РґР»СЏ Р°РґРјРёРЅРєРё/СЂР°СЃСЃС‹Р»РєРё

// health-check РґР»СЏ Render
app.get('/health', (_req, res) => res.type('text').send('OK'));
app.get('/', (_req, res) => res.type('text').send('OK'));

// СЃС‚Р°С‚РёРєР° РґР»СЏ Р°РґРјРёРЅРєРё
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

// Redis Client
const redisService = new RedisService();
let redisClient = null;

// Р”РѕСЃС‚СѓРїРЅРѕ РёР· РґСЂСѓРіРёС… РјРѕРґСѓР»РµР№
function getRedisClient() {
  if (!redisClient) throw new Error('Redis РєР»РёРµРЅС‚ РµС‰С‘ РЅРµ РёРЅРёС†РёР°Р»РёР·РёСЂРѕРІР°РЅ');
  return redisClient;
}

// ===== РЈС‚РёР»РёС‚С‹ =====
async function startApp() {
  try {
    // Р›РѕРіРёСЂСѓРµРј СЃС‚Р°СЂС‚ РїСЂРёР»РѕР¶РµРЅРёСЏ
    console.log('Р—Р°РїСѓСЃРє РїСЂРёР»РѕР¶РµРЅРёСЏ...');

    // РџРѕРґРіСЂСѓР¶Р°РµРј С‚РµРєСЃС‚С‹ РёР· Р‘Р” РґРѕ СЂРµРіРёСЃС‚СЂР°С†РёРё С…РµРЅРґР»РµСЂРѕРІ
    await loadTexts();
    console.log('вњ… РўРµРєСЃС‚С‹ Р·Р°РіСЂСѓР¶РµРЅС‹');

    // Redis
    redisClient = await redisService.connect();
    console.log('вњ… Redis РїРѕРґРєР»СЋС‡С‘РЅ');

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    console.log(`вњ… Р”РёСЂРµРєС‚РѕСЂРёСЏ РєСЌС€Р°: ${cacheDir}`);

    // РђРґРјРёРЅРєР°
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

    // РўРµР»РµРіСЂР°Рј-Р±РѕС‚
    botService.setupTelegramBot();
    console.log('вњ… Р‘РѕС‚ РЅР°СЃС‚СЂРѕРµРЅ');

    // РџР»Р°РЅРѕРІС‹Рµ Р·Р°РґР°С‡Рё
    setInterval(() => resetDailyStats(), 24 * 3600 * 1000);
    setInterval(() => console.log(`[Monitor] РћС‡РµСЂРµРґСЊ: ${downloadQueue.size} РІ РѕР¶РёРґР°РЅРёРё, ${downloadQueue.active} РІ СЂР°Р±РѕС‚Рµ.`), 60 * 1000);
    setInterval(() => cleanupCache(cacheDir, 60), 30 * 60 * 1000);
    cleanupCache(cacheDir, 60);

    if (process.env.NODE_ENV === 'production') {
      // Р›РѕРіРёСЂСѓРµРј Р·Р°РїСѓСЃРє РІ РїСЂРѕРґР°РєС€РЅ-СЂРµР¶РёРјРµ
      console.log('Р—Р°РїСѓСЃРє РІ РїСЂРѕРґР°РєС€РЅ-СЂРµР¶РёРјРµ...');

      // Rate limit С‚РѕР»СЊРєРѕ РЅР° РІРµР±С…СѓРє
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

      app.listen(PORT, () => console.log(`вњ… РЎРµСЂРІРµСЂ Р·Р°РїСѓС‰РµРЅ РЅР° РїРѕСЂС‚Сѓ ${PORT}.`));
    } else {
      await bot.launch();
      console.log('вњ… Р‘РѕС‚ Р·Р°РїСѓС‰РµРЅ РІ СЂРµР¶РёРјРµ long-polling.');
    }

    // Р¤РѕРЅРѕРІС‹Рµ СЃРµСЂРІРёСЃС‹
    startIndexer().catch(err => console.error("рџ”ґ РљСЂРёС‚РёС‡РµСЃРєР°СЏ РѕС€РёР±РєР° РІ РёРЅРґРµРєСЃР°С‚РѕСЂРµ, РЅРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РїСѓСЃС‚РёС‚СЊ:", err));
    startNotifier().catch(err => console.error("рџ”ґ РљСЂРёС‚РёС‡РµСЃРєР°СЏ РѕС€РёР±РєР° РІ РїР»Р°РЅРёСЂРѕРІС‰РёРєРµ:", err));

  } catch (err) {
    console.error('рџ”ґ РљСЂРёС‚РёС‡РµСЃРєР°СЏ РѕС€РёР±РєР° РїСЂРё Р·Р°РїСѓСЃРєРµ РїСЂРёР»РѕР¶РµРЅРёСЏ:', err);
    process.exit(1);
  }
}

// РљРѕСЂСЂРµРєС‚РЅРѕРµ Р·Р°РІРµСЂС€РµРЅРёРµ
const stopBot = (signal) => {
  console.log(`РџРѕР»СѓС‡РµРЅ СЃРёРіРЅР°Р» ${signal}. Р—Р°РІРµСЂС€РµРЅРёРµ СЂР°Р±РѕС‚С‹...`);
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

// Р­РєСЃРїРѕСЂС‚ РґР»СЏ РґСЂСѓРіРёС… РјРѕРґСѓР»РµР№
export { app, bot, getRedisClient };