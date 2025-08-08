// config/texts.js
import { supabase } from '../db.js';

const defaults = {
  start: '👋 Пришли ссылку на трек или плейлист с SoundCloud.',
  menu: '📋 Меню',
  upgrade: '🔓 Расширить лимит',
  mytracks: '🎵 Мои треки',
  help: 'ℹ️ Помощь',
  error: '❌ Ошибка',
  noTracks: 'Сегодня нет треков.',
  limitReached: '🚫 Лимит достигнут ❌\n\n💡 Чтобы качать больше треков, переходи на тариф Plus или выше и качай без ограничений.',
  upgradeInfo:
    '🚀 Обновленные тарифы!\n\n🆓 Free — 5 треков/день\n🎯 Plus — 30 треков/день — 119₽/мес\n💪 Pro — 100 треков/день, плейлисты — 199₽/мес\n💎 Unlimited — безлимит — 299₽/мес\n\n👉 Покупка: https://boosty.to/anatoly_bone/donate\n✉️ После оплаты: @anatolybone\n📣 Новости: @SCM_BLOG',
  helpInfo:
    'ℹ️ Пришли ссылку — получишь mp3.\n🔓 «Расширить» — оплата тарифа.\n🎵 «Мои треки» — список за сегодня.\n📣 Канал: @SCM_BLOG',
};

let cache = { ...defaults };
let lastLoad = 0;
const TTL_MS = 60 * 1000; // раз в минуту можно обновлять кэш

export async function loadTexts(force = false) {
  const now = Date.now();
  if (!force && now - lastLoad < TTL_MS) return cache;

  const { data, error } = await supabase.from('bot_texts').select('key,value');
  if (error) {
    console.error('[texts] Ошибка загрузки из Supabase:', error.message);
    return cache;
  }
  const map = { ...defaults };
  for (const row of data || []) {
    if (row?.key && typeof row.value === 'string') map[row.key] = row.value;
  }
  cache = map;
  lastLoad = now;
  return cache;
}

export function T(key) {
  // sync доступ к кэшу (если нужно, снаружи вызывай loadTexts() периодически)
  return cache[key] ?? defaults[key] ?? '';
}

export function allTextsSync() {
  return { ...cache };
}

export async function setText(key, value) {
  if (!key) throw new Error('key is required');
  const { error } = await supabase
    .from('bot_texts')
    .upsert({ key, value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  cache[key] = value;
  lastLoad = 0; // чтобы следующая loadTexts обновила из БД при необходимости
  return true;
}