const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

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

// SQL утилита
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// ✅ Создание пользователя
async function createUser(id, first_name = '', username = '') {
  console.log(`DEBUG createUser: id=${id}, name=${first_name}, username=${username}`);
  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed, last_reset_date, referred_count, created_at, last_active)
    VALUES ($1, $2, $3, 0, 10, 0, false, CURRENT_DATE, 0, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `, [id, username || '', first_name || '']);
}

// ✅ Получение пользователя с автоматическим созданием
async function getUser(id, first_name = '', username = '') {
  const res = await query('SELECT * FROM users WHERE id = $1 AND active = true', [id]);
  if (res.rows.length === 0) {
    await createUser(id, first_name, username);
    const newUser = await query('SELECT * FROM users WHERE id = $1 AND active = true', [id]);
    return newUser.rows[0];
  }
  await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
  return res.rows[0];
}

// ✅ Обновление произвольного поля
async function updateUserField(id, field, value) {
  return (await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id])).rowCount;
}

// ✅ Инкремент загрузок
async function incrementDownloads(id, trackTitle) {
  await query(`
    UPDATE users SET 
      downloads_today = downloads_today + 1,
      total_downloads = total_downloads + 1
    WHERE id = $1
  `, [id]);
}

// ✅ Сохранение трека за день
async function saveTrackForUser(id, title) {
  const user = await getUser(id);
  let updated = user.tracks_today || '';
  updated = updated ? `${updated},${title}` : title;
  await query('UPDATE users SET tracks_today = $1 WHERE id = $2', [updated, id]);
}

// ✅ Установка тарифа и срока
async function setPremium(id, limit, days = null) {
  await query('UPDATE users SET premium_limit = $1 WHERE id = $2', [limit, id]);
  if (days) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await query('UPDATE users SET premium_until = $1 WHERE id = $2', [until, id]);
  }
}

// ✅ Сброс лимита по дате
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

// ✅ Массовый сброс лимитов
async function resetDailyStats() {
  await query(`
    UPDATE users
    SET downloads_today = 0,
        tracks_today = '',
        last_reset_date = CURRENT_DATE
  `);
  console.log('🕛 Суточные лимиты сброшены у всех');
}

// ✅ Все пользователи
// db.js
async function getAllUsers(includeInactive = false) {
  let sql = 'SELECT * FROM users';
  const params = [];

  if (!includeInactive) {
    sql += ' WHERE active = TRUE';
  }
  sql += ' ORDER BY created_at DESC';

  const res = await query(sql, params);
  return res.rows;
}

// ✅ Добавление отзыва
async function addReview(userId, text) {
  const time = new Date().toISOString();

  const { error } = await supabase
    .from('reviews')
    .insert([{ user_id: userId, text, time }]);

  if (error) {
    console.error('❌ Supabase review error:', error);
  }

  await query('UPDATE users SET has_reviewed = true WHERE id = $1', [userId]);
}

// ✅ Проверка отзыва
async function hasLeftReview(userId) {
  const res = await query('SELECT has_reviewed FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.has_reviewed;
}

// ✅ Получение отзывов
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

// ✅ Метаданные трека (кеш)
async function getTrackMetadata(url) {
  const res = await query('SELECT metadata, updated_at FROM track_metadata WHERE url = $1', [url]);
  if (!res.rows.length) return null;

  const row = res.rows[0];
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  if (ageMs > 7 * 86400000) return null;

  return row.metadata;
}

// ✅ Сохранение метаданных трека
async function saveTrackMetadata(url, metadata) {
  await query(`
    INSERT INTO track_metadata (url, metadata, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (url) DO UPDATE
    SET metadata = EXCLUDED.metadata,
        updated_at = NOW()
  `, [url, metadata]);
}

// ✅ Получение количества регистраций по датам
async function getRegistrationsByDate() {
  const res = await query(`
    SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count
    FROM users
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => {
    result[row.date] = parseInt(row.count, 10);
  });
  return result;
}

// ✅ Получение количества загрузок по датам
async function getDownloadsByDate() {
  const res = await query(`
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, SUM(downloads_today) as count
    FROM users
    GROUP BY date
    ORDER BY date
  `);
  const result = {};
  res.rows.forEach(row => {
    result[row.date] = parseInt(row.count, 10);
  });
  return result;
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
  getTrackMetadata,
  saveTrackMetadata,
  getRegistrationsByDate,
  getDownloadsByDate
};