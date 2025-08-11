// src/utils.js

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ytdl from 'youtube-dl-exec';
import { pool, findCachedTrack, cacheTrack } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

// ================================================================
// ===                   Вспомогательные утилиты                 ===
// ================================================================

export function getTariffName(limit) {
  if (limit >= 1000) return 'Unlimited (∞/день)';
  if (limit === 100) return 'Pro (100/день)';
  if (limit === 30) return 'Plus (30/день)';
  return 'Free (5/день)';
}

export function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

export const extractUrl = (text = '') => {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

export const isSubscribed = async (userId, channelUsername, bot) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (e) {
    console.error(`Ошибка при проверке подписки пользователя ${userId} на ${channelUsername}:`, e.message);
    return false;
  }
};

export function formatMenuMessage(user, ctx, texts) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
  const daysLeft = getDaysLeft(user.premium_until);

  let message = texts.menu
    .replace('{firstName}', user.first_name || user.username || 'Пользователь')
    .replace('{tariffLabel}', tariffLabel)
    .replace('{daysLeft}', daysLeft > 999 ? '∞' : daysLeft)
    .replace('{downloadsToday}', downloadsToday)
    .replace('{premiumLimit}', user.premium_limit)
    .replace('{refLink}', refLink);

  if (!user.subscribed_bonus_used) {
    message += texts.bonus;
  }
  return message;
}

export async function cleanupCache(directory, maxAgeMinutes = 60) {
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

// ================================================================
// ===                   Логика "Паука" (Indexer)               ===
// ================================================================

async function getUrlsToIndex() {
  console.log('[Indexer] Получаю URL-ы для индексации...');
  try {
    const { rows } = await pool.query(`
      SELECT url, COUNT(url) as download_count
      FROM downloads_log
      WHERE url IS NOT NULL 
        AND url LIKE '%soundcloud.com%' 
        AND url NOT IN (SELECT url FROM track_cache)
      GROUP BY url
      ORDER BY download_count DESC
      LIMIT 10;
    `);
    return rows.map(row => row.url);
  } catch (e) {
    console.error('Ошибка при получении URL-ов для индексации:', e);
    return [];
  }
}

async function processUrlForIndexing(url, bot, storageChannelId) {
  let tempFilePath = null;
  try {
    const isCached = await findCachedTrack(url);
    if (isCached) return;

    console.log(`[Indexer] Индексирую: ${url}`);
    const info = await ytdl(url, { dumpSingleJson: true });
    if (!info || info._type === 'playlist') return;

    const trackName = (info.title || 'track').slice(0, 100);
    const uploader = info.uploader || 'SoundCloud';
    tempFilePath = path.join(cacheDir, `indexer_${info.id || Date.now()}.mp3`);

    await ytdl(url, {
        output: tempFilePath, extractAudio: true, audioFormat: 'mp3',
        embedMetadata: true,
        postprocessorArgs: `-metadata artist="${uploader}" -metadata title="${trackName}"`
    });

    if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан');
    
    const message = await bot.telegram.sendAudio(
        storageChannelId,
        { source: fs.createReadStream(tempFilePath) },
        { title: trackName, performer: uploader }
    );

    if (message?.audio?.file_id) {
        await cacheTrack(url, message.audio.file_id, trackName);
        console.log(`✅ [Indexer] Успешно закэширован: ${trackName}`);
    }
  } catch (err) {
    console.error(`❌ [Indexer] Ошибка при обработке ${url}:`, err.stderr || err.message);
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
}

export async function startIndexer(bot, storageChannelId) {
  console.log('🚀 Запуск фонового индексатора...');
  await new Promise(resolve => setTimeout(resolve, 60 * 1000));
  while (true) {
    try {
      const urls = await getUrlsToIndex();
      if (urls.length > 0) {
        console.log(`[Indexer] Найдено ${urls.length} треков для кэширования.`);
        for (const url of urls) {
          await processUrlForIndexing(url, bot, storageChannelId);
          await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
      } else {
        console.log('[Indexer] Новых треков для кэширования нет.');
      }
      console.log('[Indexer] Пауза на 1 час.');
      await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    } catch (err) {
      console.error("🔴 Критическая ошибка в цикле индексатора, перезапуск через 5 минут:", err);
      await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
    }
  }
}