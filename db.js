import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { parse } from '@json2csv/node';

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Ошибка: SUPABASE_URL или SUPABASE_KEY не заданы. Проверь конфигурацию окружения.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== Базовые функции ====================

async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (e) {
    console.error('Ошибка запроса к БД:', e);
    throw e;
  }
}

async function getUserById(id) {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function createUser(id, first_name = '', username = '', referral_source = null, referrer_id = null) {
  await query(`
    INSERT INTO users (
      id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed, last_reset_date,
      referred_count, created_at, last_active, referral_source, referrer_id, active
    )
    VALUES ($1, $2, $3, 0, 10, 0, false, CURRENT_DATE, 0, NOW(), NOW(), $4, $5, TRUE)
    ON CONFLICT (id) DO NOTHING
  `, [id, username || '', first_name || '', referral_source, referrer_id]);
}

async function getUser(id, first_name = '', username = '', referral_source = null, referrer_id = null) {
  const res = await query('SELECT * FROM users WHERE id = $1 AND active = TRUE', [id]);
  if (res.rows.length === 0) {
    await createUser(id, first_name, username, referral_source, referrer_id);
    const newUser = await query('SELECT * FROM users WHERE id = $1 AND active = TRUE', [id]);
    return newUser.rows[0];
  }
  await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
  return res.rows[0];
}

async function logUserActivity(userId) {
  await pool.query(
    'INSERT INTO user_activity_logs (user_id, activity_time) VALUES ($1, NOW())',
    [userId]
  );
}

const allowedFields = new Set([
  'premium_limit',
  'downloads_today',
  'total_downloads',
  'first_name',
  'username',
  'premium_until',
  'subscribed_bonus_used',
  'tracks_today',
  'last_reset_date',
  'active',
  'referred_count',
  'referral_source',
  'has_reviewed',
  'referrer_id',
]);

async function updateUserField(id, field, value) {
  if (!allowedFields.has(field)) {
    throw new Error(`Недопустимое поле для обновления: ${field}`);
  }
  const sql = `UPDATE users SET ${field} = $1 WHERE id = $2`;
  return (await query(sql, [value, id])).rowCount;
}
const funnelCache = new Map();

function getCacheKey(from, to) {
  return `${from}_${to}`;
}

async function getFunnelData(from, to) {
  const key = getCacheKey(from, to);
  const cached = funnelCache.get(key);

  // Если есть свежий кеш — вернуть его
  if (cached && Date.now() - cached.timestamp < 60 * 1000) {
    return cached.data;
  }

  // Выполняем три запроса параллельно
  const [registrations, firstDownloads, subscriptions] = await Promise.all([
    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', from)
      .lte('created_at', to),

    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gt('total_downloads', 0)
      .gte('created_at', from)
      .lte('created_at', to),

    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gte('premium_limit', 20)
      .gte('created_at', from)
      .lte('created_at', to)
  ]);

  if (registrations.error || firstDownloads.error || subscriptions.error) {
    console.error('❌ Ошибка при получении данных воронки:', {
      registrationsError: registrations.error,
      downloadsError: firstDownloads.error,
      subscriptionsError: subscriptions.error,
    });
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
async function incrementDownloads(id) {
  await query(`
    UPDATE users SET 
      downloads_today = downloads_today + 1,
      total_downloads = total_downloads + 1
    WHERE id = $1
  `, [id]);
}

async function saveTrackForUser(id, title, fileId) {
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

async function setPremium(id, limit, days = null) {
  await query('UPDATE users SET premium_limit = $1 WHERE id = $2', [limit, id]);

  if (typeof days === 'number' && days > 0) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await query('UPDATE users SET premium_until = $1 WHERE id = $2', [until, id]);
  } else if (days === null) {
    await query('UPDATE users SET premium_until = NULL WHERE id = $1', [id]);
  }
}

async function markSubscribedBonusUsed(userId) {
  await query('UPDATE users SET subscribed_bonus_used = TRUE WHERE id = $1', [userId]);
}

async function resetDailyLimitIfNeeded(userId) {
  const res = await query('SELECT last_reset_date FROM users WHERE id = $1', [userId]);
  if (!res.rows.length) return;

  const lastReset = res.rows[0].last_reset_date;
  const today = new Date().toISOString().slice(0, 10);

  if (!lastReset || lastReset.toISOString().slice(0, 10) !== today) {
    await query(`
      UPDATE users
      SET downloads_today = 0,
          tracks_today = '',
          last_reset_date = CURRENT_DATE
      WHERE id = $1
    `, [userId]);
  }
}

async function resetDailyStats() {
  await query(`
    UPDATE users
    SET downloads_today = 0,
        tracks_today = '',
        last_reset_date = CURRENT_DATE
  `);
}

async function getAllUsers(includeInactive = false) {
  let sql = 'SELECT * FROM users';
  if (!includeInactive) sql += ' WHERE active = TRUE';
  sql += ' ORDER BY created_at DESC';
  const res = await query(sql);
  return res.rows;
}

async function getReferralSourcesStats() {
  const res = await query(`
    SELECT referral_source, COUNT(*) as count
    FROM users
    WHERE referral_source IS NOT NULL
    GROUP BY referral_source
    ORDER BY count DESC
  `);
  return res.rows.map(row => ({
    source: row.referral_source,
    count: parseInt(row.count, 10)
  }));
}

async function addReview(userId, text) {
  const time = new Date().toISOString();
  const { error } = await supabase.from('reviews').insert([{ user_id: userId, text, time }]);
  if (error) console.error('❌ Supabase review error:', error);
  await query('UPDATE users SET has_reviewed = true WHERE id = $1', [userId]);
}

async function hasLeftReview(userId) {
  const res = await query('SELECT has_reviewed FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.has_reviewed;
}

async function getLatestReviews(limit = 10) {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .order('time', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('❌ Ошибка Supabase:', error);
    return [];
  }

  return data;
}

async function logDownload(userId, trackTitle) {
  const { error } = await supabase
    .from('downloads_log')
    .insert([{ user_id: userId, track_title: trackTitle }]);

  if (error) console.error('❌ Ошибка записи лога загрузки:', error);
}

async function getTrackMetadata(url) {
  const res = await query('SELECT metadata, updated_at FROM track_metadata WHERE url = $1', [url]);
  if (!res.rows.length) return null;

  const row = res.rows[0];
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  if (ageMs > 7 * 86400000) return null;

  return row.metadata;
}

async function saveTrackMetadata(url, metadata) {
  await query(`
    INSERT INTO track_metadata (url, metadata, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (url) DO UPDATE
    SET metadata = EXCLUDED.metadata,
        updated_at = NOW()
  `, [url, metadata]);
}

async function getRegistrationsByDate() {
  const res = await query(`
    SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count
    FROM users
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => result[row.date] = parseInt(row.count, 10));
  return result;
}

async function getDownloadsByDate() {
  const res = await query(`
    SELECT TO_CHAR(last_reset_date, 'YYYY-MM-DD') as date, SUM(downloads_today) as count
    FROM users
    WHERE last_reset_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => result[row.date] = parseInt(row.count, 10));
  return result;
}

async function getActiveUsersByDate() {
  const res = await query(`
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(*) as count
    FROM users
    WHERE last_active >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => result[row.date] = parseInt(row.count, 10));
  return result;
}

async function getActivityByHour() {
  const res = await query(`
    SELECT EXTRACT(HOUR FROM last_active) AS hour, COUNT(*) AS count
    FROM users
    WHERE last_active IS NOT NULL
    GROUP BY hour
    ORDER BY hour
  `);
  const counts = Array(24).fill(0);
  res.rows.forEach(row => {
    counts[parseInt(row.hour, 10)] = parseInt(row.count, 10);
  });
  return counts;
}

async function getActivityByWeekday() {
  const res = await query(`
    SELECT EXTRACT(DOW FROM last_active) AS weekday, COUNT(*) AS count
    FROM users
    WHERE last_active IS NOT NULL
    GROUP BY weekday
    ORDER BY weekday
  `);
  const counts = Array(7).fill(0);
  res.rows.forEach(row => {
    counts[parseInt(row.weekday, 10)] = parseInt(row.count, 10);
  });
  return counts;
}

async function getUserActivityByDayHour(days = 30) {
  const res = await query(`
    SELECT
      TO_CHAR(last_active, 'YYYY-MM-DD') AS day,
      EXTRACT(HOUR FROM last_active) AS hour,
      COUNT(*) AS count
    FROM users
    WHERE last_active >= CURRENT_DATE - INTERVAL '${days} days'
    GROUP BY day, hour
    ORDER BY day, hour
  `);

  const activity = {};
  res.rows.forEach(row => {
    const day = row.day;
    const hour = parseInt(row.hour, 10);
    const count = parseInt(row.count, 10);
    if (!activity[day]) activity[day] = Array(24).fill(0);
    activity[day][hour] = count;
  });

  return activity;
}

async function getExpiringUsersPaginated(limit = 10, offset = 0) {
  const res = await query(`
    SELECT id, username, first_name, premium_until
    FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
    ORDER BY premium_until ASC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return res.rows;
}

async function getExpiringUsers(limit = 10, offset = 0) {
  return getExpiringUsersPaginated(limit, offset);
}

async function getExpiringUsersCount() {
  const res = await query(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE premium_until IS NOT NULL AND premium_until BETWEEN NOW() AND NOW() + INTERVAL '3 days'
  `);
  return parseInt(res.rows[0].count, 10);
}

async function exportUsersToCSV() {
  const users = await getAllUsers(true);
  const parser = new Parser({ fields: ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'premium_until', 'created_at', 'last_active', 'active', 'referral_source', 'referrer_id'] });
  return parser.parse(users);
}

// ==================== Экспорт ====================

export {
  supabase,
  createUser,
  getUser,
  getUserById,
  updateUserField,
  incrementDownloads,
  saveTrackForUser,
  setPremium,
  resetDailyLimitIfNeeded,
  resetDailyStats,
  getAllUsers,
  addReview,
  hasLeftReview,
  getLatestReviews,
  logDownload,
  getTrackMetadata,
  saveTrackMetadata,
  getRegistrationsByDate,
  getDownloadsByDate,
  getActiveUsersByDate,
  getActivityByHour,
  getActivityByWeekday,
  getUserActivityByDayHour,
  getExpiringUsers,
  getExpiringUsersPaginated,
  getExpiringUsersCount,
  exportUsersToCSV,
  getReferralSourcesStats,
  markSubscribedBonusUsed,
  getFunnelData,
  logUserActivity
};