// index.js

// ===== Core =====
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ===== Server =====
import express from 'express';
import rateLimit from 'express-rate-limit';

// ===== Telegram =====
import { Telegraf, Markup } from 'telegraf';

// ===== Redis =====
import { createClient } from 'redis';

// ===== yt-dlp exec wrapper =====
import ytdl from 'youtube-dl-exec';

// ===== Админка =====
import setupAdmin from './routes/admin.js';

// ===== Тексты (из БД) =====
import { loadTexts, T } from './config/texts.js';

// ===== БД/Логика =====
import {
  supabase,          // нужен для индексатора
  getUser,
  updateUserField,
  setPremium,
  getAllUsers,
  resetDailyStats,
  cacheTrack,
  findCachedTrack,
} from './db.js';

// ВАЖНО: импорт ниже оставляем, он использует bot/getRedisClient во время работы, а не при загрузке модуля
import { enqueue, downloadQueue } from './services/downloadManager.js';
import { initNotifier, startNotifier } from './services/notifier.js';

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const WEBHOOK_URL = process.env.WEBHOOK_URL;       // например: https://yourapp.onrender.com
const WEBHOOK_PATH = '/telegram';                   // путь вебхука (должен совпадать с Render)
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

// parse_mode=HTML по умолчанию
bot.use(async (ctx, next) => {
  if (ctx.reply) {
    const origReply = ctx.reply.bind(ctx);
    ctx.reply = (text, extra = {}) => origReply(text, { parse_mode: 'HTML', ...extra });
  }
  if (ctx.editMessageText) {
    const origEdit = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = (text, extra = {}) => origEdit(text, { parse_mode: 'HTML', ...extra });
  }
  return next();
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json()); // JSON POST для админки/рассылки

// health-check для Render
app.get('/health', (_req, res) => res.type('text').send('OK'));
app.get('/', (_req, res) => res.type('text').send('OK'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// статика для админки
app.use('/static', express.static(path.join(__dirname, 'public', 'static')));

const cacheDir = path.join(__dirname, 'cache');
let redisClient = null;

// Доступно из других модулей
function getRedisClient() {
  if (!redisClient) throw new Error('Redis клиент ещё не инициализирован');
  return redisClient;
}

// ===== Утилиты =====
async function cleanupCache(directory, maxAgeMinutes = 60) {
  try {
    const now = Date.now();
    const files = await fs.promises.readdir(directory);
    let cleaned = 0;
    for (const file of files) {
      try {
        const filePath = path.join(directory, file);
        const stat = await fs.promises.stat(filePath);
        if ((now - stat.mtimeMs) / 60000 > maxAgeMinutes) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch {}
    }
    if (cleaned > 0) console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Cache Cleanup] Ошибка:', e);
  }
}

function getTariffName(limit) {
  if (limit >= 1000) return 'Unlimited (∞/день)';
  if (limit === 100) return 'Pro (100/день)';
  if (limit === 30) return 'Plus (30/день)';
  return 'Free (5/день)';
}

function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

const extractUrl = (text = '') => {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

const isSubscribed = async (userId, channelUsername) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (e) {
    console.error(`Ошибка проверки подписки для ${userId} на ${channelUsername}:`, e.message);
    return false;
  }
};

function formatMenuMessage(user, ctx) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
  const daysLeft = getDaysLeft(user.premium_until);

  let message = `
👋 Привет, ${user.first_name || user.username || 'друг'}!

📥 Бот качает треки и плейлисты с SoundCloud в MP3 — просто пришли ссылку.

📣 Новости, фишки и бонусы: @SCM_BLOG

💼 Тариф: ${tariffLabel}
⏳ Осталось дней: ${daysLeft > 999 ? '∞' : daysLeft}
🎧 Сегодня скачано: ${downloadsToday} из ${user.premium_limit}

🔗 Твоя реферальная ссылка:
${refLink}
`.trim();

  if (!user.subscribed_bonus_used) {
    message += `

🎁 Бонус! Подпишись на @SCM_BLOG и получи 7 дней тарифа Plus бесплатно.`;
  }

  return message;
}

// ==========================
// Индексатор (кооперативный)
// ==========================
async function getUrlsToIndex() {
  try {
    const { data, error } = await supabase
      .from('track_cache')
      .select('url, file_id')
      .is('file_id', null)
      .not('url', 'is', null)
      .limit(20);

    if (error) {
      console.error('[Indexer] Ошибка выборки track_cache:', error.message);
      return [];
    }

    const urls = (data || [])
      .map(r => r.url)
      .filter(u => typeof u === 'string' && u.includes('soundcloud.com'));

    return Array.from(new Set(urls));
  } catch (e) {
    console.error('[Indexer] Критическая ошибка в getUrlsToIndex:', e);
    return [];
  }
}

let shuttingDown = false;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });

async function processUrlForIndexing(url) {
  let tempFilePath = null;
  try {
    const isCached = await findCachedTrack(url);
    if (isCached && isCached.file_id) {
      console.log(`[Indexer] Пропуск: ${url} уже в кэше.`);
      return;
    }

    console.log(`[Indexer] Индексирую: ${url}`);
    let info = await ytdl(url, { dumpSingleJson: true, 'no-playlist': true });
    if (!info) {
      console.log(`[Indexer] Пропуск: ${url} — нет информации.`);
      return;
    }

    if (info._type === 'playlist' || Array.isArray(info.entries)) {
      if (Array.isArray(info.entries) && info.entries.length >= 1) {
        info = info.entries[0];
      } else {
        console.log(`[Indexer] Пропуск: ${url} является плейлистом без элементов.`);
        return;
      }
    }

    const trackName = (info.title || 'track').slice(0, 100);
    const uploader = info.uploader || 'SoundCloud';
    const fileName = `indexer_${info.id || Date.now()}.mp3`;
    tempFilePath = path.join(cacheDir, fileName);

    await ytdl(url, {
      output: tempFilePath,
      extractAudio: true,
      audioFormat: 'mp3',
      addMetadata: true,
      embedMetadata: true,
      'no-playlist': true,
    });

    const fileExists = await fs.promises.access(tempFilePath).then(() => true).catch(() => false);
    if (!fileExists) throw new Error('Файл не создан');

    const message = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(tempFilePath) },
      { title: trackName, performer: uploader }
    );

    if (message?.audio?.file_id) {
      await cacheTrack(url, message.audio.file_id, trackName);
      console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
    }
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.response?.description || err.stderr || err.message || err);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch(() => {
        console.warn(`[Indexer] Не удалось удалить временный файл: ${temp