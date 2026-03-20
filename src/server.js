const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── POSTGRES ─────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || '';
console.log('DB URL host:', DB_URL.split('@')[1]?.split('/')[0] || 'NOT SET');
const pool = new Pool({
  connectionString: DB_URL,
  family: 4,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

let ready = false;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      ip TEXT,
      daily_ms JSONB DEFAULT '{}',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS challenge (
      id TEXT PRIMARY KEY DEFAULT 'config',
      active BOOLEAN DEFAULT FALSE,
      start_date TEXT,
      duration_days INT DEFAULT 7
    );
    CREATE TABLE IF NOT EXISTS deleted_ips (
      ip TEXT PRIMARY KEY
    );
    INSERT INTO challenge (id) VALUES ('config') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS chat (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      reply_to INT REFERENCES chat(id) ON DELETE SET NULL,
      reactions JSONB DEFAULT '{}',
      edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE chat ADD COLUMN IF NOT EXISTS reply_to INT REFERENCES chat(id) ON DELETE SET NULL;
    ALTER TABLE chat ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}';
    ALTER TABLE chat ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE;
  `);
  ready = true;
  console.log('✅ Postgres ready');

  async function cleanOldChat() {
    try {
      const r = await pool.query("DELETE FROM chat WHERE created_at < NOW() - INTERVAL '2 days'");
      if (r.rowCount > 0) console.log(`🗑️  Deleted ${r.rowCount} old chat messages`);
    } catch(e) { console.warn('Chat cleanup failed:', e.message); }
  }
  cleanOldChat();
  setInterval(cleanOldChat, 60 * 60 * 1000);
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api') && !ready)
    return res.status(503).json({ error: 'DB loading, retry in a moment' });
  next();
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
}
function getTodayIST() {
  const now = new Date();
  const istMs  = now.getTime() + (5.5 * 60 * 60 * 1000);
  const resetMs = istMs - (5 * 60 * 60 * 1000);
  return new Date(resetMs).toISOString().split('T')[0];
}
function adminToken() {
  return Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64');
}
function verifyAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === adminToken()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── POST /api/submit ─────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { username, timeSpentMs, allowRejoin } = req.body;
  if (!username?.trim() || timeSpentMs === undefined)
    return res.status(400).json({ error: 'username and timeSpentMs required' });
  const ip    = getIP(req);
  const today = getTodayIST();
  const name  = username.trim();
  const banned = await pool.query('SELECT ip FROM deleted_ips WHERE ip=$1', [ip]);
  if (banned.rows.length && !allowRejoin)
    return res.status(403).json({ error: 'removed' });
  if (allowRejoin) await pool.query('DELETE FROM deleted_ips WHERE ip=$1', [ip]);
  const conflict = await pool.query('SELECT username FROM users WHERE ip=$1 AND username!=$2', [ip, name]);
  if (conflict.rows.length)
    return res.status(409).json({ error: 'ip_conflict', existing: conflict.rows[0].username });
  await pool.query(`
    INSERT INTO users (username, ip, daily_ms, last_seen)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (username) DO UPDATE
      SET ip=$2, daily_ms = users.daily_ms || $3, last_seen = NOW()
  `, [name, ip, JSON.stringify({ [today]: timeSpentMs })]);
  res.json({ success: true });
});

// ─── POST /api/rename ─────────────────────────────────────────────────────────
app.post('/api/rename', async (req, res) => {
  const { oldUsername, newUsername } = req.body;
  if (!oldUsername?.trim() || !newUsername?.trim())
    return res.status(400).json({ error: 'oldUsername and newUsername required' });
  const oldName = oldUsername.trim();
  const newName = newUsername.trim();
  const ip = getIP(req);
  if (oldName === newName) return res.json({ success: true });
  const oldUser = await pool.query('SELECT * FROM users WHERE username=$1', [oldName]);
  if (!oldUser.rows.length)
    return res.status(404).json({ error: 'old_user_not_found' });
  const storedIp = oldUser.rows[0].ip;
  if (storedIp && storedIp !== 'unknown' && ip !== 'unknown' && storedIp !== ip)
    return res.status(403).json({ error: 'ip_mismatch' });
  const taken = await pool.query('SELECT username FROM users WHERE username=$1', [newName]);
  if (taken.rows.length)
    return res.status(409).json({ error: 'username_taken' });
  const dailyMs  = oldUser.rows[0].daily_ms || {};
  const joinedAt = oldUser.rows[0].joined_at;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (username, ip, daily_ms, joined_at, last_seen) VALUES ($1, $2, $3, $4, NOW())`,
      [newName, storedIp, JSON.stringify(dailyMs), joinedAt]
    );
    await client.query('DELETE FROM users WHERE username=$1', [oldName]);
    await client.query('UPDATE chat SET username=$1 WHERE username=$2', [newName, oldName]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('Rename failed:', e.message);
    res.status(500).json({ error: 'rename_failed' });
  } finally {
    client.release();
  }
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const today = getTodayIST();
  const cfg   = await pool.query('SELECT * FROM challenge WHERE id=$1', ['config']);
  const all   = await pool.query('SELECT username, daily_ms, last_seen, joined_at FROM users');
  const now = Date.now();
  const list = all.rows
    .map(u => {
      const lastSeen = u.last_seen ? new Date(u.last_seen).getTime() : 0;
      const isOnline = (now - lastSeen) < 3 * 60 * 1000;
      return {
        username: u.username,
        todayMs:  u.daily_ms?.[today] || 0,
        dailyMs:  u.daily_ms || {},
        lastSeen: u.last_seen,
        joinedAt: u.joined_at,
        isOnline,
      };
    })
    .sort((a, b) => b.todayMs - a.todayMs);
  res.json({ users: list, today, challenge: cfg.rows[0] || {} });
});

// ─── GET /api/studywar ────────────────────────────────────────────────────────
app.get('/api/studywar', async (req, res) => {
  const cfgRes = await pool.query('SELECT * FROM challenge WHERE id=$1', ['config']);
  const cfg    = cfgRes.rows[0];
  if (!cfg?.active || !cfg.start_date)
    return res.json({ active: false, users: [], challenge: cfg || {} });
  const start      = new Date(cfg.start_date);
  const dur        = cfg.duration_days || 7;
  const today      = new Date();
  const daysPassed = Math.min(Math.floor((today - start) / 86400000) + 1, dur);
  const endDate    = new Date(start);
  endDate.setDate(endDate.getDate() + dur);
  const all = await pool.query('SELECT username, daily_ms FROM users');
  const list = all.rows.map(u => {
    let totalMs = 0, daysCompleted = 0, daysAttempted = 0, dailyBreakdown = [];
    for (let d = 0; d < daysPassed; d++) {
      const date    = new Date(start);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const ms      = u.daily_ms?.[dateStr] || 0;
      const hours   = ms / 3600000;
      totalMs += ms;
      if (ms > 0)      daysAttempted++;
      if (hours >= 10) daysCompleted++;
      dailyBreakdown.push({ date: dateStr, ms, hours: Math.round(hours * 10) / 10, completed: hours >= 10 });
    }
    const totalHours = Math.round((totalMs / 3600000) * 10) / 10;
    const eliminated = daysPassed > 1 && daysAttempted < daysPassed;
    let rank = null;
    if (daysCompleted >= 7)      rank = 'gold';
    else if (daysCompleted >= 5) rank = 'silver';
    else if (daysCompleted >= 3) rank = 'bronze';
    return { username: u.username, totalMs, totalHours, daysCompleted, eliminated, rank, dailyBreakdown };
  });
  list.sort((a, b) => b.totalMs - a.totalMs);
  const todayStr = getTodayIST();
  let kingOfDay = null, kingMs = 0;
  list.forEach(u => {
    const day = u.dailyBreakdown.find(d => d.date === todayStr);
    if (day && day.ms > kingMs) { kingMs = day.ms; kingOfDay = u.username; }
  });
  res.json({ active: true, users: list, challenge: cfg, daysPassed, startDate: cfg.start_date, endDate: endDate.toISOString().split('T')[0], kingOfDay });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: adminToken() });
  else res.status(401).json({ error: 'Wrong password' });
});
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  const today = getTodayIST();
  const all   = await pool.query('SELECT username, ip, daily_ms, joined_at FROM users');
  res.json({ users: all.rows.map(u => ({ username: u.username, ip: u.ip, todayMs: u.daily_ms?.[today] || 0, joinedAt: u.joined_at })) });
});
app.delete('/api/admin/user/:username', verifyAdmin, async (req, res) => {
  const u = await pool.query('SELECT ip FROM users WHERE username=$1', [req.params.username]);
  if (!u.rows.length) return res.status(404).json({ error: 'Not found' });
  const ip = u.rows[0].ip;
  if (ip && ip !== 'unknown')
    await pool.query('INSERT INTO deleted_ips (ip) VALUES ($1) ON CONFLICT DO NOTHING', [ip]);
  await pool.query('DELETE FROM users WHERE username=$1', [req.params.username]);
  res.json({ success: true });
});
app.post('/api/admin/challenge', verifyAdmin, async (req, res) => {
  const { active, startDate, durationDays } = req.body;
  await pool.query(`UPDATE challenge SET active=$1, start_date=$2, duration_days=$3 WHERE id='config'`, [!!active, startDate || null, durationDays || 7]);
  res.json({ success: true });
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.get('/api/chat', async (req, res) => {
  const since = req.query.since || 0;
  const rows = await pool.query(
    'SELECT id, username, message, reply_to, reactions, edited, created_at FROM chat WHERE id > $1 ORDER BY created_at ASC LIMIT 100',
    [since]
  );
  res.json({ messages: rows.rows });
});

app.post('/api/chat', async (req, res) => {
  const { username, message, reply_to } = req.body;
  if (!username?.trim() || !message?.trim())
    return res.status(400).json({ error: 'username and message required' });
  if (message.trim().length > 300)
    return res.status(400).json({ error: 'Message too long (max 300 chars)' });
  const result = await pool.query(
    'INSERT INTO chat (username, message, reply_to) VALUES ($1, $2, $3) RETURNING id, username, message, reply_to, reactions, edited, created_at',
    [username.trim(), message.trim(), reply_to || null]
  );
  res.json({ success: true, message: result.rows[0] });
});

// Edit own message
app.put('/api/chat/:id', async (req, res) => {
  const { username, message } = req.body;
  if (!username?.trim() || !message?.trim())
    return res.status(400).json({ error: 'username and message required' });
  if (message.trim().length > 300)
    return res.status(400).json({ error: 'Message too long' });
  const msg = await pool.query('SELECT username FROM chat WHERE id=$1', [req.params.id]);
  if (!msg.rows.length) return res.status(404).json({ error: 'Not found' });
  if (msg.rows[0].username !== username.trim())
    return res.status(403).json({ error: 'Not your message' });
  const result = await pool.query(
    'UPDATE chat SET message=$1, edited=TRUE WHERE id=$2 RETURNING id, username, message, reply_to, reactions, edited, created_at',
    [message.trim(), req.params.id]
  );
  res.json({ success: true, message: result.rows[0] });
});

// Delete own message (or admin)
app.delete('/api/chat/:id', async (req, res) => {
  const { username } = req.body;
  const adminTok = req.headers['x-admin-token'];
  const msg = await pool.query('SELECT username FROM chat WHERE id=$1', [req.params.id]);
  if (!msg.rows.length) return res.status(404).json({ error: 'Not found' });
  if (adminTok !== adminToken() && msg.rows[0].username !== username?.trim())
    return res.status(403).json({ error: 'Not your message' });
  await pool.query('DELETE FROM chat WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// React to a message (toggle)
app.post('/api/chat/:id/react', async (req, res) => {
  const { username, emoji } = req.body;
  if (!username?.trim() || !emoji)
    return res.status(400).json({ error: 'username and emoji required' });
  const msg = await pool.query('SELECT reactions FROM chat WHERE id=$1', [req.params.id]);
  if (!msg.rows.length) return res.status(404).json({ error: 'Not found' });
  const reactions = msg.rows[0].reactions || {};
  if (!reactions[emoji]) reactions[emoji] = [];
  const idx = reactions[emoji].indexOf(username.trim());
  if (idx >= 0) reactions[emoji].splice(idx, 1); // toggle off
  else reactions[emoji].push(username.trim());    // toggle on
  if (reactions[emoji].length === 0) delete reactions[emoji];
  const result = await pool.query(
    'UPDATE chat SET reactions=$1 WHERE id=$2 RETURNING id, username, message, reply_to, reactions, edited, created_at',
    [JSON.stringify(reactions), req.params.id]
  );
  res.json({ success: true, message: result.rows[0] });
});

app.delete('/api/admin/chat/:id', verifyAdmin, async (req, res) => {
  await pool.query('DELETE FROM chat WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── START ────────────────────────────────────────────────────────────────────
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
