require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'supersecret123';
const DB_PATH = process.env.DB_PATH || './game.db';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // раздаём index.html и admin.html из корня

// ========== БД ==========
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE,
    username TEXT DEFAULT 'Игрок',
    balance_rub REAL DEFAULT 0,
    balance_usd REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    is_admin INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    upgrades TEXT DEFAULT '{}',
    autosell TEXT DEFAULT '{"enabled":false,"minRarity":"rare"}',
    safe_slots INTEGER DEFAULT 5,
    total_generated INTEGER DEFAULT 0,
    total_earned REAL DEFAULT 0,
    play_time INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    plate TEXT,
    rarity TEXT,
    country TEXT DEFAULT 'RU',
    obtained_at TEXT DEFAULT (datetime('now')),
    in_safe INTEGER DEFAULT 0,
    UNIQUE(user_id, plate)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    amount REAL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    task_key TEXT,
    task_text TEXT,
    completed INTEGER DEFAULT 0,
    reward REAL DEFAULT 100,
    task_date TEXT
  );
`);

// Первый пользователь = админ
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  db.prepare(`INSERT INTO users (device_id, username, is_admin, balance_rub) VALUES ('seed', 'Admin', 1, 10000)`).run();
  console.log('Seed admin created (id=1)');
}

// ========== Утилиты генерации ==========
const LETTERS = 'АВЕКМНОРСТУХ';
const RARE_SERIES = ['АМР', 'ЕКХ', 'ООО', 'МММ', 'ААА', 'ООО'];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generatePlate(country = 'RU') {
  // Россия: А123ВС77
  const l1 = LETTERS[randInt(0, LETTERS.length - 1)];
  const digits = String(randInt(0, 999)).padStart(3, '0');
  const l2 = LETTERS[randInt(0, LETTERS.length - 1)];
  const l3 = LETTERS[randInt(0, LETTERS.length - 1)];
  const region = String(randInt(1, 199)).padStart(2, '0');
  const plate = `${l1}${digits}${l2}${l3}${region}`;
  return { plate, country: 'RU', format: 'standard' };
}

function getRarity(plate) {
  const digits = plate.slice(1, 4);
  const series = plate.slice(4, 7);
  const region = plate.slice(7);

  // Легендарный: зеркальные А777АА + регион 77/777 и т.п.
  if (/^([А-Я])(\d)\2\2\1\1/.test(plate) || (digits === '777' && series[0] === plate[0] && series[1] === series[2])) {
    return { rarity: 'legendary', price: 50000, label: 'Легендарный' };
  }
  // Очень редкий: спецсерии
  if (RARE_SERIES.includes(series) || digits === '000' || digits === '999') {
    return { rarity: 'very_rare', price: 5000, label: 'Очень редкий' };
  }
  // Редкий: тройки цифр
  if (/(\d)\1\1/.test(digits) || digits === '123' || digits === '777') {
    return { rarity: 'rare', price: 500, label: 'Редкий' };
  }
  return { rarity: 'common', price: 50, label: 'Обычный' };
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD серверное
}

function ensureDailyTasks(userId) {
  const d = today();
  const existing = db.prepare('SELECT COUNT(*) as c FROM daily_tasks WHERE user_id=? AND task_date=?').get(userId, d).c;
  if (existing > 0) return;

  const tasks = [
    { key: 'find_a_aa', text: 'Найди номер вида А***АА', reward: 150 },
    { key: 'find_777', text: 'Найди номер с 777', reward: 300 },
    { key: 'find_rare', text: 'Найди 3 редких номера', reward: 200 },
    { key: 'generate_50', text: 'Сгенерируй 50 номеров', reward: 100 },
    { key: 'earn_1000', text: 'Заработай 1000 ₽', reward: 250 }
  ];
  const stmt = db.prepare('INSERT INTO daily_tasks (user_id, task_key, task_text, reward, task_date) VALUES (?,?,?,?,?)');
  tasks.forEach(t => stmt.run(userId, t.key, t.text, t.reward, d));
}

// ========== API ==========

// Регистрация / логин по device_id
app.post('/api/register', (req, res) => {
  const { device_id, username } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  let user = db.prepare('SELECT * FROM users WHERE device_id=?').get(device_id);
  if (user) {
    if (user.is_banned) return res.status(403).json({ error: 'banned' });
    ensureDailyTasks(user.id);
    return res.json({ id: user.id, username: user.username, is_admin: !!user.is_admin });
  }

  const info = db.prepare('INSERT INTO users (device_id, username) VALUES (?,?)').run(device_id, username || 'Игрок');
  const id = info.lastInsertRowid;
  ensureDailyTasks(id);
  res.json({ id, username: username || 'Игрок', is_admin: false });
});

// Данные игрока
app.get('/api/user/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.is_banned) return res.status(403).json({ error: 'banned' });

  const collection = db.prepare('SELECT * FROM collections WHERE user_id=? ORDER BY obtained_at DESC').all(user.id);
  const tasks = db.prepare('SELECT * FROM daily_tasks WHERE user_id=? AND task_date=?').all(user.id, today());
  const upgrades = JSON.parse(user.upgrades || '{}');
  const autosell = JSON.parse(user.autosell || '{}');

  res.json({
    id: user.id,
    username: user.username,
    balance_rub: user.balance_rub,
    balance_usd: user.balance_usd,
    is_admin: !!user.is_admin,
    collection,
    tasks,
    upgrades,
    autosell,
    safe_slots: user.safe_slots,
    total_generated: user.total_generated,
    total_earned: user.total_earned,
    play_time: user.play_time
  });
});

// Генерация
app.post('/api/generate', (req, res) => {
  const { user_id, country = 'RU' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });

  const upgrades = JSON.parse(user.upgrades || '{}');
  const rareChanceBoost = upgrades.rare_chance || 0;

  let plateData = generatePlate(country);
  let rarityInfo = getRarity(plateData.plate);

  // Увеличение шанса редких
  if (rareChanceBoost > 0 && Math.random() < rareChanceBoost / 100) {
    // форсируем редкий
    const digits = '777';
    const l1 = LETTERS[randInt(0, LETTERS.length - 1)];
    const l2 = LETTERS[randInt(0, LETTERS.length - 1)];
    const l3 = LETTERS[randInt(0, LETTERS.length - 1)];
    const region = String(randInt(1, 99)).padStart(2, '0');
    plateData.plate = `${l1}${digits}${l2}${l3}${region}`;
    rarityInfo = getRarity(plateData.plate);
  }

  // Пытаемся вставить (уникальный)
  try {
    db.prepare('INSERT INTO collections (user_id, plate, rarity, country) VALUES (?,?,?,?)')
      .run(user_id, plateData.plate, rarityInfo.rarity, country);
  } catch (e) {
    // уже есть — просто возвращаем без записи
  }

  db.prepare('UPDATE users SET total_generated = total_generated + 1 WHERE id=?').run(user_id);

  // Автопродажа
  const autosell = JSON.parse(user.autosell || '{}');
  let sold = false;
  let earned = 0;
  if (autosell.enabled) {
    const minRarityOrder = { common: 0, rare: 1, very_rare: 2, legendary: 3 };
    const min = minRarityOrder[autosell.minRarity] || 1;
    if ((minRarityOrder[rarityInfo.rarity] || 0) < min) {
      // продаём
      const inSafe = db.prepare('SELECT in_safe FROM collections WHERE user_id=? AND plate=?').get(user_id, plateData.plate);
      if (!inSafe || !inSafe.in_safe) {
        db.prepare('DELETE FROM collections WHERE user_id=? AND plate=?').run(user_id, plateData.plate);
        db.prepare('UPDATE users SET balance_rub = balance_rub + ?, total_earned = total_earned + ? WHERE id=?')
          .run(rarityInfo.price, rarityInfo.price, user_id);
        db.prepare('INSERT INTO transactions (user_id, type, amount, reason) VALUES (?,?,?,?)')
          .run(user_id, 'credit', rarityInfo.price, `Автопродажа ${plateData.plate}`);
        sold = true;
        earned = rarityInfo.price;
      }
    }
  }

  res.json({
    plate: plateData.plate,
    rarity: rarityInfo.rarity,
    label: rarityInfo.label,
    price: rarityInfo.price,
    sold,
    earned
  });
});

// Продажа
app.post('/api/sell', (req, res) => {
  const { user_id, plate } = req.body;
  const row = db.prepare('SELECT * FROM collections WHERE user_id=? AND plate=?').get(user_id, plate);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.in_safe) return res.status(400).json({ error: 'in safe' });

  const prices = { common: 50, rare: 500, very_rare: 5000, legendary: 50000 };
  const price = prices[row.rarity] || 50;

  db.prepare('DELETE FROM collections WHERE id=?').run(row.id);
  db.prepare('UPDATE users SET balance_rub = balance_rub + ?, total_earned = total_earned + ? WHERE id=?')
    .run(price, price, user_id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, reason) VALUES (?,?,?,?)')
    .run(user_id, 'credit', price, `Продажа ${plate}`);

  res.json({ success: true, earned: price });
});

// Задания
app.get('/api/tasks/:id', (req, res) => {
  ensureDailyTasks(req.params.id);
  const tasks = db.prepare('SELECT * FROM daily_tasks WHERE user_id=? AND task_date=?').all(req.params.id, today());
  res.json(tasks);
});

app.post('/api/tasks/complete', (req, res) => {
  const { user_id, task_id } = req.body;
  const task = db.prepare('SELECT * FROM daily_tasks WHERE id=? AND user_id=?').get(task_id, user_id);
  if (!task || task.completed) return res.status(400).json({ error: 'invalid' });

  db.prepare('UPDATE daily_tasks SET completed=1 WHERE id=?').run(task_id);
  db.prepare('UPDATE users SET balance_rub = balance_rub + ? WHERE id=?').run(task.reward, user_id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, reason) VALUES (?,?,?,?)')
    .run(user_id, 'credit', task.reward, `Задание: ${task.task_text}`);

  res.json({ success: true, reward: task.reward });
});

// Улучшения
app.post('/api/upgrade', (req, res) => {
  const { user_id, upgrade } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  if (!user) return res.status(404).json({ error: 'not found' });

  const prices = {
    rare_chance: 1000,
    gen_speed: 800,
    autosell_limit: 1500,
    safe_slot: 2000
  };
  const price = prices[upgrade];
  if (!price || user.balance_rub < price) return res.status(400).json({ error: 'not enough money' });

  const upgrades = JSON.parse(user.upgrades || '{}');
  if (upgrade === 'safe_slot') {
    db.prepare('UPDATE users SET balance_rub = balance_rub - ?, safe_slots = safe_slots + 1 WHERE id=?')
      .run(price, user_id);
  } else {
    upgrades[upgrade] = (upgrades[upgrade] || 0) + 5;
    db.prepare('UPDATE users SET balance_rub = balance_rub - ?, upgrades=? WHERE id=?')
      .run(price, JSON.stringify(upgrades), user_id);
  }

  res.json({ success: true });
});

// Сейф
app.post('/api/safe', (req, res) => {
  const { user_id, plate, action } = req.body; // action: add / remove
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(user_id);
  const row = db.prepare('SELECT * FROM collections WHERE user_id=? AND plate=?').get(user_id, plate);
  if (!row) return res.status(404).json({ error: 'not found' });

  if (action === 'add') {
    const inSafeCount = db.prepare('SELECT COUNT(*) as c FROM collections WHERE user_id=? AND in_safe=1').get(user_id).c;
    if (inSafeCount >= user.safe_slots) return res.status(400).json({ error: 'no slots' });
    db.prepare('UPDATE collections SET in_safe=1 WHERE id=?').run(row.id);
  } else {
    db.prepare('UPDATE collections SET in_safe=0 WHERE id=?').run(row.id);
  }
  res.json({ success: true });
});

// Автопродажа настройки
app.post('/api/autosell', (req, res) => {
  const { user_id, enabled, minRarity } = req.body;
  db.prepare('UPDATE users SET autosell=? WHERE id=?')
    .run(JSON.stringify({ enabled: !!enabled, minRarity: minRarity || 'rare' }), user_id);
  res.json({ success: true });
});

// ========== АДМИН ==========
function checkAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.body.password;
  if (pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'wrong password' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(403).json({ error: 'wrong' });
});

app.get('/api/admin/users', checkAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, balance_rub, balance_usd, created_at, is_admin, is_banned, total_generated, total_earned FROM users ORDER BY id').all();
  const stats = {
    total_users: users.length,
    total_money: users.reduce((s, u) => s + u.balance_rub, 0),
    active_today: db.prepare(`SELECT COUNT(DISTINCT user_id) as c FROM collections WHERE date(obtained_at)=date('now')`).get().c
  };
  res.json({ users, stats });
});

app.post('/api/admin/grant', checkAdmin, (req, res) => {
  const { user_id, amount, plate, rarity } = req.body;
  if (amount) {
    db.prepare('UPDATE users SET balance_rub = balance_rub + ? WHERE id=?').run(amount, user_id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, reason) VALUES (?,?,?,?)')
      .run(user_id, 'credit', amount, 'Админ выдача');
  }
  if (plate) {
    const r = rarity || getRarity(plate).rarity;
    try {
      db.prepare('INSERT INTO collections (user_id, plate, rarity) VALUES (?,?,?)').run(user_id, plate, r);
    } catch (e) {}
  }
  res.json({ success: true });
});

app.post('/api/admin/ban', checkAdmin, (req, res) => {
  const { user_id, ban } = req.body;
  db.prepare('UPDATE users SET is_banned=? WHERE id=?').run(ban ? 1 : 0, user_id);
  res.json({ success: true });
});

app.post('/api/admin/make-admin', checkAdmin, (req, res) => {
  const { user_id } = req.body;
  db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(user_id);
  res.json({ success: true });
});

// Статика
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
