const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Normaliza IDs de WhatsApp a @c.us para evitar duplicados entre @c.us y @s.whatsapp.net
function normalizeId(id) {
  return id.split('@')[0] + '@c.us';
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      balance    INTEGER DEFAULT 20000,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id         SERIAL PRIMARY KEY,
      number     INTEGER,
      color      TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at   TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS bets (
      id       SERIAL PRIMARY KEY,
      round_id INTEGER REFERENCES rounds(id),
      user_id  TEXT    REFERENCES users(id),
      amount   INTEGER,
      bet_type TEXT,
      won      BOOLEAN,
      payout   INTEGER
    );
    CREATE TABLE IF NOT EXISTS spells (
      id           SERIAL PRIMARY KEY,
      nombre       TEXT UNIQUE,
      lvl          INTEGER NOT NULL DEFAULT 0,
      casting_time TEXT,
      componentes  TEXT,
      escuela      TEXT,
      rango        TEXT,
      save         TEXT,
      dano         TEXT,
      efecto       TEXT,
      objetivo     TEXT,
      descripcion  TEXT,
      modificado_dm BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getOrCreateUser(userId, name) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [normalizeId(userId), name]
  );
  return rows[0];
}

async function getBalance(userId) {
  const { rows } = await pool.query('SELECT balance FROM users WHERE id = $1', [normalizeId(userId)]);
  return rows[0] ? rows[0].balance : 0;
}

async function updateBalance(userId, delta) {
  await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [delta, normalizeId(userId)]);
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY balance DESC');
  return rows;
}

async function giveWeeklyPoints() {
  await pool.query('UPDATE users SET balance = balance + 20000');
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  return parseInt(rows[0].count);
}

async function createRound(number, color) {
  const { rows } = await pool.query(
    'INSERT INTO rounds (number, color) VALUES ($1, $2) RETURNING id',
    [number, color]
  );
  return rows[0].id;
}

async function closeRound(roundId) {
  await pool.query('UPDATE rounds SET ended_at = NOW() WHERE id = $1', [roundId]);
}

async function saveBet(roundId, userId, amount, betType, won, payout) {
  await pool.query(
    'INSERT INTO bets (round_id, user_id, amount, bet_type, won, payout) VALUES ($1,$2,$3,$4,$5,$6)',
    [roundId, normalizeId(userId), amount, betType, won, payout]
  );
}

async function userExists(userId) {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [normalizeId(userId)]);
  return rows.length > 0;
}

async function findUserByName(name) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE LOWER(name) LIKE '%' || LOWER($1) || '%' LIMIT 1",
    [name]
  );
  return rows[0] || null;
}

async function saveSpell(fields) {
  await pool.query(
    `INSERT INTO spells (nombre, lvl, casting_time, componentes, escuela, rango, save, dano, efecto, objetivo, descripcion, modificado_dm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (nombre) DO UPDATE SET
       lvl           = EXCLUDED.lvl,
       casting_time  = EXCLUDED.casting_time,
       componentes   = EXCLUDED.componentes,
       escuela       = EXCLUDED.escuela,
       rango         = EXCLUDED.rango,
       save          = EXCLUDED.save,
       dano          = EXCLUDED.dano,
       efecto        = EXCLUDED.efecto,
       objetivo      = EXCLUDED.objetivo,
       descripcion   = EXCLUDED.descripcion,
       modificado_dm = EXCLUDED.modificado_dm`,
    [fields.nombre, fields.lvl ?? 0, fields.casting_time, fields.componentes, fields.escuela, fields.rango,
     fields.save, fields.dano, fields.efecto, fields.objetivo, fields.descripcion, fields.modificado_dm]
  );
}

async function getSpell(nombre) {
  const { rows } = await pool.query(
    "SELECT * FROM spells WHERE LOWER(nombre) = LOWER($1)",
    [nombre]
  );
  return rows[0] || null;
}

async function searchSpells(query) {
  const { rows } = await pool.query(
    "SELECT nombre FROM spells WHERE LOWER(nombre) LIKE '%' || LOWER($1) || '%' ORDER BY nombre LIMIT 10",
    [query]
  );
  return rows;
}

module.exports = { init, getOrCreateUser, getBalance, updateBalance, getAllUsers, giveWeeklyPoints, createRound, closeRound, saveBet, findUserByName, userExists, saveSpell, getSpell, searchSpells };
