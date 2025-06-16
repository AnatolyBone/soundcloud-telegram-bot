// db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
}

// Создать пользователя, если его ещё нет
async function createUser(id, username, first_name) {
  const text = `
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit)
    VALUES ($1, $2, $3, 0, 0)
    ON CONFLICT (id) DO NOTHING
  `;
  await query(text, [id, username, first_name]);
}

// Получить пользователя по id
async function getUser(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}

// Обновить любое поле пользователя (предполагаем, что поле существует и безопасно)
async function updateUserField(id, field, value) {
  const res = await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id]);
  return res.rowCount;
}

// Увеличить счетчик загрузок пользователя
async function incrementDownloads(id, trackTitle) {
  // Можно добавить логику с trackTitle, сейчас просто увеличим счётчик
  await query(`UPDATE users SET downloads_today = downloads_today + 1 WHERE id = $1`, [id]);
}

// Установить тариф (лимит премиума)
async function setPremium(id, limit) {
  await query(`UPDATE users SET premium_limit = $1 WHERE id = $2`, [limit, id]);
}

// Получить всех пользователей
async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

module.exports = {
  createUser,
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers,
};