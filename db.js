// db.js

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
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

// Утилита для SQL-запросов
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
}

// Создание пользователя
async function createUser(id, username, first_name) {
  await query(`
    INSERT INTO users (id, username, first_name, downloads_today, premium_limit, total_downloads, has_reviewed)
    VALUES ($1, $2, $3, 0, 10, 0, false)
    ON CONFLICT (id) DO NOTHING
  `, [id, username, first_name]);
}

// Получение пользователя
async function getUser(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}

// Обновление произвольного поля
async function updateUserField(id, field, value) {
  return (await query(`UPDATE users SET ${field} = $1 WHERE id = $2`, [value, id])).rowCount;
}

// Инкремент загрузок и общего счётчика
async function incrementDownloads(id, trackTitle) {
  await query(`
    UPDATE users SET 
      downloads_today = downloads_today + 1,
      total_downloads = total_downloads + 1
    WHERE id = $1
  `, [id]);
}

// Сохранение трека в поле tracks_today
async function saveTrackForUser(id, title) {
  const user = await getUser(id);
  let updated = user.tracks_today || '';
  updated = updated ? `${updated},${title}` : title;
  await query('UPDATE users SET tracks_today = $1 WHERE id = $2', [updated, id]);
}

// Назначение тарифа с опциональным сроком
async function setPremium(id, limit, days = null) {
  await query('UPDATE users SET premium_limit = $1 WHERE id = $2', [limit, id]);
  if (days) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await query('UPDATE users SET premium_until = $1 WHERE id = $2', [until, id]);
  }
}

// Сброс лимитов и проверка окончания тарифа
async function resetDailyLimitIfNeeded(userId) {
  const { rows } = await pool.query('SELECT downloads_today, last_checked FROM users WHERE id = $1', [userId]);
  if (!rows.length) return;

  const user = rows[0];
  const now = new Date();
  const lastChecked = new Date(user.last_checked);

  const hoursPassed = (now - lastChecked) / (1000 * 60 * 60);

  if (hoursPassed >= 24) {
    await pool.query(`
      UPDATE users
      SET downloads_today = 0,
          tracks_today = $1,
          last_checked = NOW()
      WHERE id = $2
    `, [JSON.stringify([]), userId]);
    console.log(`🕛 Суточный лимит сброшен для пользователя ${userId}`);
  }
};

// Получение всех пользователей
async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

// Добавление отзыва
async function addReview(userId, text) {
  const time = new Date().toISOString();

  const { error } = await supabase
    .from('reviews')
    .insert([{ user_id: userId, text, time }]);

  if (error) {
    console.error('❌ Ошибка при сохранении отзыва в Supabase:', error);
  }

  await query('UPDATE users SET has_reviewed = true WHERE id = $1', [userId]);
}

// Проверка: оставлял ли отзыв
async function hasLeftReview(userId) {
  const res = await query('SELECT has_reviewed FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.has_reviewed;
}

// Получение отзывов из Supabase
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
  resetDailyLimitIfNeeded
};