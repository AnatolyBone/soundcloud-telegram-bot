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
  'promo_1plus1_used', 'expiration_notified_at' // Добавляем новое поле в разрешенные
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
  // Сбрасываем флаг уведомления при смене тарифа
  await updateUserField(id, 'expiration_notified_at', null); 
  return bonusApplied;
}

export async function cacheTrack(url, fileId, trackName) {
  const { error } = await supabase
    .from('track_cache')
    .upsert({ url: url, file_id: fileId, track_name: trackName }, { onConflict: 'url' });
  if (error) console.error('❌ Ошибка кэширования трека:', error);
}

export async function findCachedTrack(url) {
    try {
        const { data, error } = await supabase
            .from('track_cache')
            .select('file_id, track_name')
            .eq('url', url)
            .single();

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

export async function findCachedTracksByUrls(urls) {
  if (!urls || urls.length === 0) return new Map();
  const { data, error } = await supabase.from('track_cache').select('url, file_id, track_name').in('url', urls);
  if (error) {
    console.error('❌ Ошибка массового поиска в кэше:', error);
    return new Map();
  }
  const cacheMap = new Map();
  for (const track of data) {
    cacheMap.set(track.url, { fileId: track.file_id, trackName: track.track_name });
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

export async function getDownloadsByDate(days = 30) {
  // Берём события по типу загрузки за последние N дней и считаем по датам
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('events')
    .select('created_at, event_type')
    .gte('created_at', since)
    .in('event_type', ['download', 'download_start', 'download_success']);
  
  if (error) {
    console.error('❌ Ошибка Supabase в getDownloadsByDate:', error.message);
    return {};
  }
  
  const byDate = {};
  for (const ev of data || []) {
    const d = new Date(String(ev.created_at).replace(' ', 'T').replace(/Z?$/, 'Z'));
    if (isNaN(d)) continue;
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    byDate[key] = (byDate[key] || 0) + 1;
  }
  return byDate; // { '2025-08-08': 12, ... }
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

export async function getDashboardStats() {
  const { rows } = await query(`
    SELECT 
      COUNT(*) AS total_users,
      SUM(total_downloads) AS total_downloads,
      COUNT(*) FILTER (WHERE premium_limit <= 10 OR premium_limit IS NULL) AS free,
      COUNT(*) FILTER (WHERE premium_limit = 30) AS plus,
      COUNT(*) FILTER (WHERE premium_limit = 100) AS pro,
      COUNT(*) FILTER (WHERE premium_limit >= 1000) AS unlimited,
      COUNT(*) FILTER (WHERE DATE(last_active) = CURRENT_DATE) AS active_today
    FROM users
    WHERE active = TRUE
  `);
  
  const r = rows[0] || {};
  return {
    // ↓↓↓ ИМЕНА ПОЛЕЙ — как в dashboard.ejs
    total_users: parseInt(r.total_users || 0, 10),
    total_downloads: parseInt(r.total_downloads || 0, 10),
    active_today: parseInt(r.active_today || 0, 10),
    free: parseInt(r.free || 0, 10),
    plus: parseInt(r.plus || 0, 10),
    pro: parseInt(r.pro || 0, 10),
    unlimited: parseInt(r.unlimited || 0, 10),
  };
}

export async function findUsersToNotify(days) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);

  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, premium_until')
    .lte('premium_until', targetDate.toISOString())
    .gt('premium_until', new Date().toISOString())
    .is('expiration_notified_at', null)
    .eq('active', true);

  if (error) {
    console.error('❌ Ошибка при поиске пользователей для уведомления:', error);
    return [];
  }
  return data;
}

export async function markAsNotified(userId) {
  const { error } = await supabase
    .from('users')
    .update({ expiration_notified_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    console.error(`❌ Не удалось обновить статус уведомления для пользователя ${userId}:`, error);
  }
}

export async function resetAllSubscriptionBonuses() {
  try {
    const { count, error } = await supabase
      .from('users')
      .update({ subscribed_bonus_used: false })
      .neq('subscribed_bonus_used', false);

    if (error) {
      console.error('❌ Ошибка при массовом сбросе бонусов:', error);
      return { success: false, error };
    }
    
    console.log(`[Admin] Успешно сброшен бонус за подписку для ${count || 0} пользователей.`);
    return { success: true, count: count || 0 };
  } catch (e) {
    console.error('🔴 Критическая ошибка при массовом сбросе бонусов:', e);
    return { success: false, error: e };
  }
}