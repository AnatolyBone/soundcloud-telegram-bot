const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

async function createUser(id, username, first_name, referrer_id = null) {
  const existing = await getUser(id);
  if (existing) return;

  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed, last_reset_date, referrer_id)
    VALUES ($1, $2, $3, 0, 10, 0, false, CURRENT_DATE, $4)
  `, [id, username, first_name, referrer_id]);

  if (referrer_id) {
    await query(`
      UPDATE users
      SET referred_count = COALESCE(referred_count, 0) + 1
      WHERE id = $1
    `, [referrer_id]);

    await setPremium(referrer_id, 50, 1); // 1 день тарифа Plus
  }
}

async function getUser(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
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
    console.log(`🕛 Суточный лимит сброшен для пользователя ${userId}`);
  }
}

async function resetDailyStats() {
  await query(`
    UPDATE users
    SET downloads_today = 0,
        tracks_today = '',
        last_reset_date = CURRENT_DATE
  `);
  console.log('🕛 Суточные лимиты сброшены у всех пользователей');
}

async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

async function addReview(userId, text) {
  const time = new Date().toISOString();
  const { error } = await supabase
    .from('reviews')
    .insert([{ user_id: userId, text, time }]);

  if (error) console.error('❌ Ошибка при сохранении отзыва в Supabase:', error);

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
    console.error('Ошибка при получении отзывов:', error);
    return [];
  }

  return data;
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
    ON CONFLICT (url) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()
  `, [url, metadata]);
}

module.exports = {
  createUser,
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers,
  resetDailyStats,
  addReview,
  saveTrackForUser,
  hasLeftReview,
  getLatestReviews,
  resetDailyLimitIfNeeded,
  getTrackMetadata,
  saveTrackMetadata
};