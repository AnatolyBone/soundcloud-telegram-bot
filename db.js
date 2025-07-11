import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { Parser } from '@json2csv/node';

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Ошибка: SUPABASE_URL или SUPABASE_KEY не заданы. Проверь конфигурацию окружения.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Основные функции работы с базой
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

async function updateUserField(id, field, value) {
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
  if (!allowedFields.has(field)) {
    throw new Error(`Недопустимое поле для обновления: ${field}`);
  }
  const sql = `UPDATE users SET ${field} = $1 WHERE id = $2`;
  return (await query(sql, [value, id])).rowCount;
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

async function exportUsersToCSV() {
  const users = await getAllUsers(true);
  const parser = new Parser({
    fields: [
      'id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'premium_until', 
      'created_at', 'last_active', 'active', 'referral_source', 'referrer_id'
    ]
  });
  return parser.parse(users);
}

// ... и остальные функции из твоего кода ...

// Экспорт функций
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
  exportUsersToCSV,
  // остальные функции по необходимости
};