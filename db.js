import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';

// --- Инициализация клиентов ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Ошибка: SUPABASE_URL или SUPABASE_KEY не заданы.');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== Базовые функции ====================

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД:', e.message, { query: text });
    throw e;
  }
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser(id, first_name = '', username = '', referral_source = null, referrer_id = null) {
  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed, last_reset_date, referred_count, created_at, last_active, referral_source, referrer_id, active)
    VALUES ($1, $2, $3, 0, 10, 0, false, CURRENT_DATE, 0, NOW(), NOW(), $4, $5, TRUE)
    ON CONFLICT (id) DO NOTHING;
  `, [id, username || '', first_name || '', referral_source, referrer_id]);
}

export async function getUser(id, first_name = '', username = '') {
  const { rows } = await query('SELECT * FROM users WHERE id = $1 AND active = TRUE', [id]);
  if (rows.length > 0) {
    query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]).catch(e => console.error(e));
    return rows[0];
  }
  await createUser(id, first_name, username);
  const newUserResult = await query('SELECT * FROM users WHERE id = $1', [id]);
  return newUserResult.rows[0];
}

export async function logUserActivity(userId) {
  await query('INSERT INTO user_activity_logs (user_id, activity_time) VALUES ($1, NOW())', [userId]);
}

const allowedFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'referral_source', 'has_reviewed', 'referrer_id',
  'promo_1plus1_used'
]);

export async function updateUserField(id, field, value) {
  if (!allowedFields.has(field)) {
    throw new Error(`Недопустимое поле для обновления: ${field}`);
  }
  const sql = `UPDATE users SET ${field} = $1 WHERE id = $2`;
  return (await query(sql, [value, id])).rowCount;
}

// Функция для получения пользователей, у которых скоро истечет подписка
export async function findUsersToNotify(days) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);

  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, premium_until')
    .lte('premium_until', targetDate.toISOString())  // подписка истекает в ближайшие 'days' дней
    .gt('premium_until', new Date().toISOString())  // подписка ещё не истекла
    .is('expiration_notified_at', null)  // уведомление ещё не отправлено
    .eq('active', true);  // только активные пользователи

  if (error) {
    console.error('❌ Ошибка при поиске пользователей для уведомлений:', error);
    return [];
  }
  return data;
}

// Функция для обновления статуса уведомления
export async function markAsNotified(userId) {
  const { error } = await supabase
    .from('users')
    .update({ expiration_notified_at: new Date().toISOString() })  // обновляем дату уведомления
    .eq('id', userId);

  if (error) {
    console.error(`❌ Не удалось обновить статус уведомления для пользователя ${userId}:`, error);
  }
}

// Вставка или обновление трека в кэш
export async function cacheTrack(soundcloudUrl, fileId, trackName) {
  const { error } = await supabase
    .from('track_cache')
    .upsert({ url: soundcloudUrl, file_id: fileId, track_name: trackName }, { onConflict: 'url' });
  if (error) console.error('❌ Ошибка кэширования трека:', error);
}

// Поиск трека в кэше по URL
export async function findCachedTrack(soundcloudUrl) {
  try {
    const { data, error } = await supabase
      .from('track_cache')
      .select('file_id, track_name')
      .eq('url', soundcloudUrl)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 - это "not found", это не ошибка
      console.error('Ошибка поиска в кэше Supabase:', error);
      return null;
    }

    if (data) {
      return {
        fileId: data.file_id,
        trackName: data.track_name
      };
    }

    return null;

  } catch (e) {
    console.error('Критическая ошибка в findCachedTrack:', e);
    return null;
  }
}

// Поиск нескольких треков в кэше по URL
export async function findCachedTracksByUrls(urls) {
  if (!urls || urls.length === 0) return new Map();
  const { data, error } = await supabase.from('track_cache').select('url, file_id, track_name').in('url', urls);
  if (error) {
    console.error('❌ Ошибка массового поиска треков в кэше:', error);
    return new Map();
  }
  const cacheMap = new Map();
  for (const track of data) {
    cacheMap.set(track.url, { fileId: track.file_id, trackName: track.track_name });
  }
  return cacheMap;
}

// Обработка события "скачивания"
export async function logDownload(userId, trackTitle, url) {
  await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle, url: url }]);
}

export async function incrementDownloads(id, trackName = 'track', url = null) {
  const res = await pool.query(`
    UPDATE users   
    SET   
      downloads_today = downloads_today + 1,  
      total_downloads = total_downloads + 1  
    WHERE   
      id = $1 AND downloads_today < premium_limit  
    RETURNING *  
  `, [id]);

  if (res.rowCount > 0) {
    await logDownload(id, trackName, url);   
    return res.rows[0];
  }
  return null;
}

// Функция для сброса статистики скачивания (ежедневный лимит)
export async function resetDailyStats() {
  await query(`
    UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE
  `);
}

// Функция для обновления статистики воронки (счётчики регистрации, скачиваний, подписок)
const funnelCache = new Map();

export async function getFunnelData(from, to) {
  const key = `${from}_${to}`;
  if (funnelCache.has(key) && (Date.now() - funnelCache.get(key).timestamp < 60000)) {
    return funnelCache.get(key).data;
  }
  const [registrations, firstDownloads, subscriptions] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).gte('created_at', from).lte('created_at', to),
    supabase.from('users').select('id', { count: 'exact', head: true }).gt('total_downloads', 0).gte('created_at', from).lte('created_at', to),
    supabase.from('users').select('id', { count: 'exact', head: true }).gte('premium_limit', 20).gte('created_at', from).lte('created_at', to)
  ]);
  if (registrations.error || firstDownloads.error || subscriptions.error) {
    console.error('❌ Ошибка Supabase воронки');
    throw new Error('Ошибка Supabase при получении данных воронки');
  }
  const result = {
    registrationCount: registrations.count || 0,
    firstDownloadCount: firstDownloads.count || 0,
    subscriptionCount: subscriptions.count || 0,
  };
  funnelCache.set(key, { data: result, timestamp: Date.now() });
  return result;
}

export async function logEvent(userId, event) {
  try {
    const { error } = await supabase.from('events').insert([{ user_id: userId, event }]);
    if (error) console.error(`❌ Ошибка логирования события "${event}":`, error.message);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logEvent:`, e.message);
  }
}