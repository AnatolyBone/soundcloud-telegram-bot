import path from 'path';
import fs from 'fs';
// Use the correct relative path when importing the database module. This file lives
// inside the "src" folder, so "../db.js" resolves to the project root. Without
// adjusting the path, the application would fail to start because the module
// cannot be found.
import { supabase } from '../db.js';

// Функция для получения названия тарифа
export function getTariffName(limit) {
  if (limit >= 1000) return 'Unlimited (∞/день)';
  if (limit === 100) return 'Pro (100/день)';
  if (limit === 30) return 'Plus (30/день)';
  return 'Free (5/день)';
}

// Функция для вычисления оставшихся дней премиум подписки
export function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

// Функция для извлечения ссылки с SoundCloud из текста
export const extractUrl = (text = '') => {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

// Функция для проверки подписки пользователя на канал
export const isSubscribed = async (userId, channelUsername, bot) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (e) {
    console.error(`Ошибка при проверке подписки пользователя ${userId} на ${channelUsername}:`, e.message);
    return false;
  }
};

// Функция для формирования сообщения в меню для пользователя
export function formatMenuMessage(user, ctx) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
  const daysLeft = getDaysLeft(user.premium_until);

  let message = `
🔹 Привет, ${user.first_name || user.username || 'Пользователь'}!

📈 Бот качает треки и преводит их в MP3 — быстро и удобно с SoundCloud.

🔔 Новости, тексты и бонусы: @SCM_BLOG

🌍 Тариф: ${tariffLabel}
⏳ Осталось дней: ${daysLeft > 999 ? '∞' : daysLeft}
🔋 Скачано сегодня: ${downloadsToday} из ${user.premium_limit}

🛠 Ваша реферальная ссылка:(в разработке)
${refLink}
`.trim();

  if (!user.subscribed_bonus_used) {
    message += `

💥 Бонус! Подпишитесь на @SCM_BLOG и получите 7 дней Plus бесплатно.`;
  }

  return message;
}

// ===== Очистка кеша =====
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

// Индексация
// В utils.js
export async function startIndexer() {
    console.log('🚀 Запуск фонового индексатора...');
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    while (true) {
        try {
            const urls = await getUrlsToIndex();
            if (urls.length > 0) {
                console.log(`[Indexer] Найдено ${urls.length} треков для упреждающего кэширования.`);
                for (const url of urls) {
                    await processUrlForIndexing(url);
                    await new Promise(resolve => setTimeout(resolve, 30 * 1000));
                }
            }
            console.log('[Indexer] Пауза на 1 час.');
            await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
        } catch (err) {
            console.error("🔴 Критическая ошибка в цикле индексатора, перезапуск через 5 минут:", err);
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        }
    }
}