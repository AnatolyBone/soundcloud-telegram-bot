const Database = require('better-sqlite3');
const db = new Database('db.sqlite');

// Создание таблицы
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  lang TEXT DEFAULT 'ru',
  premium_limit INTEGER DEFAULT 10,
  premium_until TEXT,
  downloads_today INTEGER DEFAULT 0,
  total_downloads INTEGER DEFAULT 0,
  last_reset TEXT,
  tracks_today TEXT DEFAULT ''
);
`);

// Получить пользователя (или создать)
function getUser(id, username = '') {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    db.prepare('INSERT INTO users (id, username, last_reset) VALUES (?, ?, ?)')
      .run(id, username, today());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  // Сброс лимита если новый день
  if (user.last_reset !== today()) {
    db.prepare('UPDATE users SET downloads_today = 0, tracks_today = ?, last_reset = ? WHERE id = ?')
      .run('', today(), id);
    user.downloads_today = 0;
    user.tracks_today = '';
    user.last_reset = today();
  }

  // Сброс тарифа, если срок истёк
  if (user.premium_until && new Date(user.premium_until) < new Date()) {
    db.prepare('UPDATE users SET premium_limit = 10, premium_until = NULL WHERE id = ?').run(id);
    user.premium_limit = 10;
    user.premium_until = null;
  }

  return user;
}

function updateUserField(id, field, value) {
  db.prepare(\`UPDATE users SET \${field} = ? WHERE id = ?\`).run(value, id);
}

function incrementDownloads(id, title) {
  const user = getUser(id);
  const titles = user.tracks_today ? user.tracks_today.split(',') : [];
  titles.push(title);
  db.prepare('UPDATE users SET downloads_today = downloads_today + 1, total_downloads = total_downloads + 1, tracks_today = ? WHERE id = ?')
    .run(titles.join(','), id);
}

function setPremium(id, limit, days = 30) {
  const until = new Date(Date.now() + days * 86400 * 1000).toISOString();
  db.prepare('UPDATE users SET premium_limit = ?, premium_until = ? WHERE id = ?')
    .run(limit, until, id);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

function today() {
  return new Date().toISOString().split('T')[0];
}

module.exports = {
  getUser,
  updateUserField,
  incrementDownloads,
  setPremium,
  getAllUsers
};
