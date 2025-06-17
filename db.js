const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
}

async function createUser(id, username, first_name) {
  const text = `
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, tracks_today)
    VALUES ($1, $2, $3, 0, 10, '')
    ON CONFLICT (id) DO NOTHING
  `;
  await query(text, [id, username, first_name]);
}

async function getUser(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}

async function updateUserField(id, field, value) {
  const res = await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
  return res.rowCount;
}

async function incrementDownloads(id, trackTitle) {
  // Увеличиваем количество скачек и добавляем имя трека в список
  const user = await getUser(id);
  const updatedList = user.tracks_today ? `${user.tracks_today},${trackTitle}` : trackTitle;
  await query(`
    UPDATE users
    SET downloads_today = downloads_today + 1,
        tracks_today = $1
    WHERE id = $2
  `, [updatedList, id]);
}

async function setPremium(id, limit) {
  await query(`UPDATE users SET premium_limit = $1 WHERE id = $2`, [limit, id]);
}

async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

async function resetDailyStats() {
  await query(`UPDATE users SET downloads_today = 0, tracks_today = ''`);
}

module.exports = {
  createUser,
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers,
  resetDailyStats
};