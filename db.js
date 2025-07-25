// db.js

import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import json2csv from 'json-2-csv';
const { json2csvAsync } = json2csv;

// --- Инициализация клиентов ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Ошибка: SUPABASE_URL или SUPABASE_KEY не заданы. Проверь конфигурацию окружения.');
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
  // Исправлено: убран ON CONFLICT, который вызывал ошибку
  await query(
    'INSERT INTO user_activity_logs (user_id, activity_time) VALUES ($1, NOW())',
    [userId]
  );
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

// db.js

// ... (ваши текущие функции) ...

export async function findCachedTrack(soundcloudUrl) {
  const { rows } = await pool.query('SELECT telegram_file_id FROM track_cache WHERE soundcloud_url = $1', [soundcloudUrl]);
  return rows[0]?.telegram_file_id || null;
}

export async function cacheTrack(soundcloudUrl, fileId, title) {
  await pool.query(
    'INSERT INTO track_cache (soundcloud_url, telegram_file_id, title) VALUES ($1, $2, $3) ON CONFLICT (soundcloud_url) DO UPDATE SET telegram_file_id = $2, title = $3',
    [soundcloudUrl, fileId, title]
  );
}

export async function incrementDownloads(id, trackName = 'track', url = null) { // <-- Добавляем url как параметр
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
    // Передаем url в logDownload
    await logDownload(id, trackName, url); 
    return res.rows[0];
  }
  return null;
}
export async function saveTrackForUser(id, title, fileId) {
  const user = await getUser(id);
  let current = [];
  try {
    if (user.tracks_today) current = JSON.parse(user.tracks_today);
  } catch {
    current = [];
  }
  current.push({ title, fileId });
  await query('UPDATE users SET tracks_today = $1 WHERE id = $2', [JSON.stringify(current), id]);
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

export async function markSubscribedBonusUsed(userId) {
  await updateUserField(userId, 'subscribed_bonus_used', true);
}

export async function resetDailyLimitIfNeeded(userId) {
  const { rows } = await query('SELECT last_reset_date FROM users WHERE id = $1', [userId]);
  if (!rows.length) return;
  const lastReset = rows[0].last_reset_date;
  const today = new Date().toISOString().slice(0, 10);
  if (!lastReset || new Date(lastReset).toISOString().slice(0, 10) !== today) {
    await query(`
      UPDATE users
      SET downloads_today = 0, tracks_today = '[]', last_reset_date = CURRENT_DATE
      WHERE id = $1
    `, [userId]);
  }
}

export async function resetDailyStats() {
  await query(`UPDATE users SET downloads_today = 0, tracks_today = '[]', last_reset_date = CURRENT_DATE`);
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

export async function logDownload(userId, trackTitle) {
  await supabase.from('downloads_log').insert([{ user_id: userId, track_title: trackTitle }]);
}

// Добавлено: недостающая функция для downloadManager
export async function logEvent(userId, event) {
  try {
    const { error } = await supabase.from('events').insert([{ user_id: userId, event }]);
    if (error) console.error(`❌ Ошибка логирования события "${event}":`, error.message);
  } catch (e) {
    console.error(`❌ Критическая ошибка вызова Supabase для logEvent:`, e.message);
  }
}

// Восстановлено: ваши функции, которые я пропустил
export async function getTrackMetadata(url) {
  const res = await query('SELECT metadata, updated_at FROM track_metadata WHERE url = $1', [url]);
  if (!res.rows.length) return null;
  
  const row = res.rows[0];
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  if (ageMs > 7 * 86400000) return null; // Кэш на 7 дней
  
  return row.metadata;
}

export async function saveTrackMetadata(url, metadata) {
  await query(`
    INSERT INTO track_metadata (url, metadata, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (url) DO UPDATE
    SET metadata = EXCLUDED.metadata,
        updated_at = NOW()
  `, [url, JSON.stringify(metadata)]);
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
  const { rows } = await query(`SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(*) as count FROM users WHERE last_active >= CURRENT_DATE - INTERVAL '30 days' GROUP BY date ORDER BY date`);
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

export async function getExpiringUsersPaginated(limit = 10, offset = 0) {
  const { rows } = await query(`
    SELECT id, username, first_name, premium_until FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
    ORDER BY premium_until ASC LIMIT $1 OFFSET $2
    `, [limit, offset]);
  return rows;
}

export const getExpiringUsers = getExpiringUsersPaginated;

export async function getExpiringUsersCount() {
  const { rows } = await query(`
    SELECT COUNT(*) AS count FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
    `);
  return parseInt(rows[0].count, 10);
}

export async function exportUsersToCSV() {
  const users = await getAllUsers(true);
  return json2csvAsync(users, { keys: ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'premium_until', 'created_at', 'last_active', 'active', 'referral_source', 'referrer_id'] });
}