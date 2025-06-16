// db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
}

// Пример функции: получить пользователя по id
async function getUser(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}

// Обновить поле пользователя
async function updateUserField(id, field, value) {
  const res = await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
  return res.rowCount;
}

// Увеличить счётчик загрузок
async function incrementDownloads(id, trackTitle) {
  // Здесь логика добавления трека и увеличения счётчика
  // Сделаем упрощённо:
  await query(`UPDATE users SET downloads_today = downloads_today + 1 WHERE id = $1`, [id]);
  // Добавь, если нужно, обновление списка треков и total_downloads
}

// Установить тариф
async function setPremium(id, limit) {
  await query(`UPDATE users SET premium_limit = $1 WHERE id = $2`, [limit, id]);
}

// Получить всех пользователей (для админа)
async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

module.exports = {
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers,
};