const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    job_title TEXT,
    workplace TEXT,
    package_amount INTEGER,
    expiry_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    auth TEXT,
    p256dh TEXT
  );
`);

const adminExists = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');

if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
  console.log('Created default admin user: admin / admin123');
} else {
  console.log('Admin user already exists.');
}

db.close();