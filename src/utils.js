import path from 'path';
import fs from 'fs';
// Use the correct relative path when importing the database module.  This file lives
// inside the "src" folder, so "../db.js" resolves to the project root.  Without
// adjusting the path the application would fail to start because the module
// cannot be found.
import { supabase } from '../db.js';

// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РїРѕР»СѓС‡РµРЅРёСЏ РЅР°Р·РІР°РЅРёСЏ С‚Р°СЂРёС„Р°
export function getTariffName(limit) {
  if (limit >= 1000) return 'Unlimited (в€ћ/РґРµРЅСЊ)';
  if (limit === 100) return 'Pro (100/РґРµРЅСЊ)';
  if (limit === 30) return 'Plus (30/РґРµРЅСЊ)';
  return 'Free (5/РґРµРЅСЊ)';
}

// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РІС‹С‡РёСЃР»РµРЅРёСЏ РѕСЃС‚Р°РІС€РёС…СЃСЏ РґРЅРµР№ РїСЂРµРјРёСѓРјР°
export function getDaysLeft(premiumUntil) {
  if (!premiumUntil) return 0;
  const diff = new Date(premiumUntil) - new Date();
  return Math.max(Math.ceil(diff / 86400000), 0);
}

// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РёР·РІР»РµС‡РµРЅРёСЏ СЃСЃС‹Р»РєРё РёР· С‚РµРєСЃС‚Р°
export const extractUrl = (text = '') => {
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(regex);
  return matches ? matches.find(url => url.includes('soundcloud.com')) : null;
};

// Р¤СѓРЅРєС†РёСЏ РґР»СЏ РїСЂРѕРІРµСЂРєРё РїРѕРґРїРёСЃРєРё РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РЅР° РєР°РЅР°Р»
export const isSubscribed = async (userId, channelUsername, bot) => {
  try {
    const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
    return ['creator', 'administrator', 'member'].includes(chatMember.status);
  } catch (e) {
    console.error(`РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё РїРѕРґРїРёСЃРєРё РґР»СЏ ${userId} РЅР° ${channelUsername}:`, e.message);
    return false;
  }
};

// Р¤СѓРЅРєС†РёСЏ РґР»СЏ С„РѕСЂРјР°С‚РёСЂРѕРІР°РЅРёСЏ СЃРѕРѕР±С‰РµРЅРёСЏ РјРµРЅСЋ
export function formatMenuMessage(user, ctx) {
  const tariffLabel = getTariffName(user.premium_limit);
  const downloadsToday = user.downloads_today || 0;
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${user.id}`;
  const daysLeft = getDaysLeft(user.premium_until);

  let message = `
рџ‘‹ РџСЂРёРІРµС‚, ${user.first_name || user.username || 'РґСЂСѓРі'}!

рџ“Ґ Р‘РѕС‚ РєР°С‡Р°РµС‚ С‚СЂРµРєРё Рё РїР»РµР№Р»РёСЃС‚С‹ СЃ SoundCloud РІ MP3 вЂ” РїСЂРѕСЃС‚Рѕ РїСЂРёС€Р»Рё СЃСЃС‹Р»РєСѓ.

рџ“Ј РќРѕРІРѕСЃС‚Рё, С„РёС€РєРё Рё Р±РѕРЅСѓСЃС‹: @SCM_BLOG

рџ’ј РўР°СЂРёС„: ${tariffLabel}
вЏі РћСЃС‚Р°Р»РѕСЃСЊ РґРЅРµР№: ${daysLeft > 999 ? 'в€ћ' : daysLeft}
рџЋ§ РЎРµРіРѕРґРЅСЏ СЃРєР°С‡Р°РЅРѕ: ${downloadsToday} РёР· ${user.premium_limit}

рџ”— РўРІРѕСЏ СЂРµС„РµСЂР°Р»СЊРЅР°СЏ СЃСЃС‹Р»РєР°:
${refLink}
`.trim();

  if (!user.subscribed_bonus_used) {
    message += `

рџЋЃ Р‘РѕРЅСѓСЃ! РџРѕРґРїРёС€РёСЃСЊ РЅР° @SCM_BLOG Рё РїРѕР»СѓС‡Рё 7 РґРЅРµР№ С‚Р°СЂРёС„Р° Plus Р±РµСЃРїР»Р°С‚РЅРѕ.`;
  }

  return message;
}

// ===== РћС‡РёСЃС‚РєР° РєРµС€Р° =====
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
    if (cleaned > 0) console.log(`[Cache Cleanup] РЈРґР°Р»РµРЅРѕ ${cleaned} СЃС‚Р°СЂС‹С… С„Р°Р№Р»РѕРІ.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Cache Cleanup] РћС€РёР±РєР°:', e);
  }
}

// РРЅРґРµРєСЃР°С‚РѕСЂ
export async function getUrlsToIndex() {
  try {
    const { data, error } = await supabase
      .from('track_cache')
      .select('url, file_id')
      .is('file_id', null)
      .not('url', 'is', null)
      .limit(20);

    if (error) {
      console.error('[Indexer] РћС€РёР±РєР° РІС‹Р±РѕСЂРєРё track_cache:', error.message);
      return [];
    }

    const urls = (data || [])
      .map(r => r.url)
      .filter(u => typeof u === 'string' && u.includes('soundcloud.com'));

    return Array.from(new Set(urls));
  } catch (e) {
    console.error('[Indexer] РљСЂРёС‚РёС‡РµСЃРєР°СЏ РѕС€РёР±РєР° РІ getUrlsToIndex:', e);
    return [];
  }
}