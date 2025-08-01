// db.js

import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import json2csv from 'json-2-csv';
const { json2csvAsync } = json2csv;

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

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД (pg):', e.message, { query: text });
    throw e;
  }
}

export async function getUser(id, first_name = '', username = '') {
  const { rows } = await query(
    'UPDATE users SET last_active = NOW() WHERE id = $1 AND active = TRUE RETURNING *',
    [id]
  );
  if (rows.length > 0) return rows[0];

  await query(`
    INSERT INTO users (id, username, first_name, last_reset_date, created_at, last_active)
    VALUES ($1, $2, $3, CURRENT_DATE, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET 
      last_active = NOW(),
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      active = TRUE;
  `, [id, username || '', first_name || '']);

  const newUserResult = await query('SELECT * FROM users WHERE id = $1', [id]);
  return newUserResult.rows[0];
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

const allowedUserFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'referral_source', 'has_reviewed', 'referrer_id',
  'promo_1plus1_used'
]);

export async function updateUserField(id, field, value) {
  if (!allowedUserFields.has(field)) {
    throw new Error(`Недопустимое поле для обновления: ${field}`);
  }
  const sql = `UPDATE users SET ${field} = $1 WHERE id = $2`;
  return (await query(sql, [value, id])).rowCount;
}

export async function incrementDownloads(id) {
  const res = await pool.query(`
    UPDATE users 
    SET downloads_today = downloads_today + 1, total_downloads = total_downloads + 1
    WHERE id = $1 AND downloads_today < premium_limit
    RETURNING *
  `, [id]);
  if (res.rowCount > 0) {
    logEvent(id, 'download').catch(console.error);
    return res.rows[0];
  }
  return null;
}

export async function saveTrackForUser(userId, title, fileId) {
  const trackInfo = { title, fileId };
  await query(
    `UPDATE users
     SET tracks_today = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify([trackInfo]), userId]
  );
}

export async function resetDailyLimitIfNeeded(userId) {
  const { rows } = await query('SELECT last_reset_date FROM users WHERE id = $1', [userId]);
  if (!rows.length) return;
  const lastReset = new Date(rows[0].last_reset_date).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (lastReset !== today) {
    await query(`
      UPDATE users
      SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE
      WHERE id = $1
    `, [userId]);
  }
}

export async function setPremium(id, limit, days = null) {
  const { rows } = await query('SELECT premium_until, promo_1plus1_used FROM users WHERE id = $1', [id]);
  if (rows.length === 0) return false;
  let extraDays = 0;
  let bonusApplied = false;
  if (days && !rows[0].promo_1plus1_used) {
    extraDays = days;
    bonusApplied = true;
    await updateUserField(id, 'promo_1plus1_used', true);
  }
  const totalDays = (days || 0) + extraDays;
  const until = new Date(Date.now() + totalDays * 86400000).toISOString();
  await updateUserField(id, 'premium_limit', limit);
  await updateUserField(id, 'premium_until', until);
  return bonusApplied;
}

export async function cacheTrack(url, fileId, trackName) {
  // В вашей таблице поле называется soundcloud_url, а не url
  const { error } = await supabase
    .from('track_cache')
    .upsert({ soundcloud_url: url, file_id: fileId, track_name: trackName }, { onConflict: 'soundcloud_url' });
  if (error) console.error('❌ Ошибка кэширования трека:', error);
}

// <<< НАЧАЛО: ДОБАВЛЕННАЯ ФУНКЦИЯ >>>
/**
 * Проверяет, закэширован ли трек по URL.
 * Используется "пауком" для предотвращения дублирующей работы.
 * @param {string} soundcloudUrl - URL трека на SoundCloud.
 * @returns {Promise<object|null>} - Объект с данными кэша или null.
 */
export async function findCachedTrack(soundcloudUrl) {
    try {
        const { data, error } = await supabase
            .from('track_cache')
            .select('file_id, track_name')
            .eq('soundcloud_url', soundcloudUrl)
            .single();

        // PGRST116 = 'no rows found', это не ошибка для нас, а нормальный результат
        if (error && error.code !== 'PGRST116') { 
            console.error('Ошибка при поиске в кэше (findCachedTrack):', error.message);
            return null;
        }
        return data;
    } catch (e) {
        console.error('Критическая ошибка findCachedTrack:', e.message);
        return null;
    }
}
// <<< КОНЕЦ: ДОБАВЛЕННАЯ ФУНКЦИЯ >>>

export async function findCachedTracksByUrls(urls) {
  if (!urls || urls.length === 0) return new Map();
  // В вашей таблице поле называется soundcloud_url, а не url
  const { data, error } = await supabase.from('track_cache').select('soundcloud_url, file_id, track_name').in('soundcloud_url', urls);
  if (error) {
    console.error('❌ Ошибка массового поиска в кэше:', error);
    return new Map();
  }
  const cacheMap = new Map();
  for (const track of data) {
    cacheMap.set(track.soundcloud_url, { fileId: track.file_id, trackName: track.track_name });
  }
  return cacheMap;
}

export async function logUserActivity(userId) {
  const { error } = await supabase.from('user_activity_logs').insert({ user_id: userId, activity_time: new Date() });
  if (error) console.error(`❌ Ошибка логирования активности:`, error.message);
}

export async function logEvent(userId, event_type, metadata = {}) {
  const { error } = await supabase.from('events').insert({ user_id: userId, event_type, metadata });
  if (error) console.error(`❌ Ошибка логирования события "${event_type}":`, error.message);
}

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

export async function markSubscribedBonusUsed(userId) {
  await updateUserField(userId, 'subscribed_bonus_used', true);
}

export async function resetDailyStats() {
  await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]'::jsonb, last_reset_date = CURRENT_DATE`);
}

export async function getAllUsers(includeInactive = false) {
  let sql = 'SELECT * FROM users';
  if (!includeInactive) sql += ' WHERE active = TRUE';
  sql += ' ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function getReferralSourcesStats() {
  const { rows } = await query(`
    SELECT referral_source, COUNT(*) as count FROM users
    WHERE referral_source IS NOT NULL GROUP BY referral_source ORDER BY count DESC
  `);
  return rows.map(row => ({ source: row.referral_source, count: parseInt(row.count, 10) }));
}

export async function addReview(userId, text) {
  await supabase.from('reviews').insert([{ user_id: userId, text, time: new Date().toISOString() }]);
  await updateUserField(userId, 'has_reviewed', true);
}

export async function hasLeftReview(userId) {
  const user = await getUserById(userId);
  return user?.has_reviewed;
}

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase.from('reviews').select('*').order('time', { ascending: false }).limit(limit);
  return data || [];
}

export async function getRegistrationsByDate() {
  const { rows } = await query(`SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count FROM users GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByDate() {
  const { rows } = await query(`SELECT TO_CHAR(last_reset_date, 'YYYY-MM-DD') as date, SUM(downloads_today) as count FROM users WHERE last_reset_date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getActiveUsersByDate() {
  const { rows } = await query(`SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(DISTINCT id) as count FROM users WHERE last_active >= CURRENT_DATE - INTERVAL '30 days' GROUP BY date ORDER BY date`);
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getUserActivityByDayHour(days = 30) {
  const { rows } = await query(`
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') AS day, EXTRACT(HOUR FROM last_active) AS hour, COUNT(*) AS count
    FROM users WHERE last_active >= CURRENT_DATE - INTERVAL '${days} days'
    GROUP BY day, hour ORDER BY day, hour
  `);
  const activity = {};
  rows.forEach(row => {
    if (!activity[row.day]) activity[row.day] = Array(24).fill(0);
    activity[row.day][parseInt(row.hour, 10)] = parseInt(row.count, 10);
  });
  return activity;
}

export async function getExpiringUsers(limit = 10, offset = 0) {
  const { rows } = await query(`
    SELECT id, username, first_name, premium_until FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
    ORDER BY premium_until ASC LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function getExpiringUsersCount() {
  const { rows } = await query(`
    SELECT COUNT(*) AS count FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
  `);
  return parseInt(rows[0].count, 10);
}

export async function getExpiringUsersPaginated(limit = 10, offset = 0) {
  const { rows } = await query(`
    SELECT id, username, premium_until
    FROM users
    WHERE premium_until IS NOT NULL AND premium_until > NOW()
    ORDER BY premium_until ASC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function getExpiringUsersPaginatedCount() {
  const { rows } = await query(`
    SELECT COUNT(*) FROM users WHERE premium_until IS NOT NULL AND premium_until > NOW()
  `);
  return parseInt(rows[0].count, 10);
}
export async function getLastMonths(n = 6) {
  const months = [];
  const now = new Date();

  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    months.unshift(label);
  }

  return months;
}
export async function exportUsersToCSV() {
  const users = await getAllUsers(true);
  return json2csvAsync(users, { keys: ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'premium_until', 'created_at', 'last_active', 'active', 'referral_source', 'referrer_id'] });
}