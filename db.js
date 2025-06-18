const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
}

async function createUser(id, username, first_name) {
  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed)
    VALUES ($1, $2, $3, 0, 10, 0, false)
    ON CONFLICT (id) DO NOTHING
  `, [id, username, first_name]);
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
  await query(`UPDATE users SET tracks_today = $1 WHERE id = $2`, [updated, id]);
}

async function setPremium(id, limit, days = null) {
  await query(`UPDATE users SET premium_limit = $1 WHERE id = $2`, [limit, id]);
  if (days) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await query(`UPDATE users SET premium_until = $1 WHERE id = $2`, [until, id]);
  }
}

async function resetDailyStats() {
  const now = new Date().toISOString();
  await query(`UPDATE users SET downloads_today = 0, tracks_today = ''`);
  await query(`
    UPDATE users
    SET premium_limit = 10, premium_until = NULL
    WHERE premium_until IS NOT NULL AND premium_until < $1
  `, [now]);
}

async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

async function addReview(userId, text) {
  const filePath = path.join(__dirname, 'reviews.json');
  let data = [];

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(content);
    } catch (e) {
      console.error('❌ Ошибка чтения reviews.json', e);
    }
  }

  data.push({ userId, text, time: new Date().toISOString() });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  await query('UPDATE users SET has_reviewed = true WHERE id = $1', [userId]);
}

async function hasLeftReview(userId) {
  const res = await query('SELECT has_reviewed FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.has_reviewed;
}

async function getReviews() {
  const filePath = path.join(__dirname, 'reviews.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error('❌ Ошибка чтения reviews.json', e);
    return [];
  }
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
  getReviews
};