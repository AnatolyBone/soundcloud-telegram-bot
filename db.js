const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { Parser } = require('json2csv');

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function createUser(id, first_name = '', username = '', referral_source = null) {
  console.log(`DEBUG createUser: id=${id}, name=${first_name}, username=${username}, referral_source=${referral_source}`);
  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed, last_reset_date, referred_count, created_at, last_active, referral_source)
    VALUES ($1, $2, $3, 0, 10, 0, false, CURRENT_DATE, 0, NOW(), NOW(), $4)
    ON CONFLICT (id) DO NOTHING
  `, [id, username || '', first_name || '', referral_source]);
}

async function getUser(id, first_name = '', username = '', referral_source = null) {
  const res = await query('SELECT * FROM users WHERE id = $1 AND active = true', [id]);
  if (res.rows.length === 0) {
    await createUser(id, first_name, username, referral_source);
    const newUser = await query('SELECT * FROM users WHERE id = $1 AND active = true', [id]);
    return newUser.rows[0];
  }
  await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
  return res.rows[0];
}

async function updateUserField(id, field, value) {
  return (await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id])).rowCount;
}

async function incrementDownloads(id, trackTitle) {
  await query(`
    UPDATE users SET 
      downloads_today = downloads_today + 1,
      total_downloads = total_downloads + 1
    WHERE id = $1
  `, [id]);
}

async function saveTrackForUser(id, title) {
  const user = await getUser(id);
  let updated = user.tracks_today || '';
  updated = updated ? `${updated},${title}` : title;
  await query('UPDATE users SET tracks_today = $1 WHERE id = $2', [updated, id]);
}

async function setPremium(id, limit, days = null) {
  await query('UPDATE users SET premium_limit = $1 WHERE id = $2', [limit, id]);
  if (days) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await query('UPDATE users SET premium_until = $1 WHERE id = $2', [until, id]);
  }
}

async function markSubscribedBonusUsed(userId) {
  await pool.query('UPDATE users SET subscribed_bonus_used = TRUE WHERE id = $1', [userId]);
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
    console.log(`🕛 Лимит сброшен: ${userId}`);
  }
}

async function resetDailyStats() {
  await query(`
    UPDATE users
    SET downloads_today = 0,
        tracks_today = '',
        last_reset_date = CURRENT_DATE
  `);
  console.log('🕛 Суточные лимиты сброшены у всех');
}

async function getAllUsers(includeInactive = false) {
  let sql = 'SELECT * FROM users';
  if (!includeInactive) {
    sql += ' WHERE active = TRUE';
  }
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
  return res.rows;
}
async function addReview(userId, text) {
  const time = new Date().toISOString();

  const { error } = await supabase
    .from('reviews')
    .insert([{ user_id: userId, text, time }]);

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
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, SUM(downloads_today) as count
    FROM users
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
    WHERE last_active IS NOT NULL
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => result[row.date] = parseInt(row.count, 10));
  return result;
}

async function getExpiringUsers(days = 3) {
  const res = await query(`
    SELECT id, username, first_name, premium_until
    FROM users
    WHERE premium_until IS NOT NULL AND premium_until <= NOW() + INTERVAL '${days} days'
    ORDER BY premium_until ASC
  `);
  return res.rows;
}

async function exportUsersToCSV() {
  const users = await getAllUsers(true);
  const parser = new Parser({ fields: ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'premium_until', 'created_at', 'last_active', 'active', 'referral_source'] });
  return parser.parse(users);
}

module.exports = {
  createUser,
  getUser,
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
  getExpiringUsers,
  exportUsersToCSV,
  markSubscribedBonusUsed
};