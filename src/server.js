const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const MONGODB_URI = process.env.MONGODB_URI || '';
if (!MONGODB_URI) { console.error("❌ MONGODB_URI env var is not set!"); process.exit(1); }
const DB_NAME = 'studyforge';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── MONGODB ──────────────────────────────────────────────────────────────────
let db, users, challenge, deletedIPs;
let ready = false;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { tls: true, tlsAllowInvalidCertificates: false, serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(DB_NAME);
  users      = db.collection('users');
  challenge  = db.collection('challenge');
  deletedIPs = db.collection('deletedIPs');

  // Ensure challenge doc exists
  const existing = await challenge.findOne({ _id: 'config' });
  if (!existing) {
    await challenge.insertOne({ _id: 'config', active: false, startDate: null, durationDays: 7 });
  }

  ready = true;
  console.log('✅ MongoDB connected');
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

  // Check banned IP
  const banned = await deletedIPs.findOne({ ip });
  if (banned && !allowRejoin)
    return res.status(403).json({ error: 'removed' });

  if (allowRejoin) await deletedIPs.deleteOne({ ip });

  // Block same IP different username
  const conflict = await users.findOne({ ip, username: { $ne: name } });
  if (conflict)
    return res.status(409).json({ error: 'ip_conflict', existing: conflict.username });

  // Upsert user — update today's ms and lastSeen
  await users.updateOne(
    { username: name },
    {
      $set:         { ip, lastSeen: new Date().toISOString(), [`dailyMs.${today}`]: timeSpentMs },
      $setOnInsert: { username: name, joinedAt: new Date().toISOString() },
    },
    { upsert: true }
  );

  res.json({ success: true });
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const today = getTodayIST();
  const cfg   = await challenge.findOne({ _id: 'config' });

  const all = await users.find({}).toArray();
  const list = all
    .map(u => ({
      username:  u.username,
      todayMs:   u.dailyMs?.[today] || 0,
      dailyMs:   u.dailyMs || {},
      lastSeen:  u.lastSeen,
      joinedAt:  u.joinedAt,
    }))
    .filter(u => u.todayMs > 0)
    .sort((a, b) => b.todayMs - a.todayMs);

  res.json({ users: list, today, challenge: cfg || {} });
});

// ─── GET /api/studywar ────────────────────────────────────────────────────────
app.get('/api/studywar', async (req, res) => {
  const cfg = await challenge.findOne({ _id: 'config' });
  if (!cfg?.active || !cfg.startDate)
    return res.json({ active: false, users: [], challenge: cfg || {} });

  const start      = new Date(cfg.startDate);
  const dur        = cfg.durationDays || 7;
  const today      = new Date();
  const daysPassed = Math.min(Math.floor((today - start) / 86400000) + 1, dur);
  const endDate    = new Date(start);
  endDate.setDate(endDate.getDate() + dur);

  const all = await users.find({}).toArray();

  const list = all.map(u => {
    let totalMs = 0, daysCompleted = 0, daysAttempted = 0, dailyBreakdown = [];
    for (let d = 0; d < daysPassed; d++) {
      const date    = new Date(start);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const ms      = u.dailyMs?.[dateStr] || 0;
      const hours   = ms / 3600000;
      totalMs += ms;
      if (ms > 0)     daysAttempted++;
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

  res.json({ active: true, users: list, challenge: cfg, daysPassed, startDate: cfg.startDate, endDate: endDate.toISOString().split('T')[0], kingOfDay });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: adminToken() });
  else res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
  const today = getTodayIST();
  const all   = await users.find({}).toArray();
  res.json({
    users: all.map(u => ({
      username: u.username,
      ip:       u.ip,
      todayMs:  u.dailyMs?.[today] || 0,
      joinedAt: u.joinedAt,
    }))
  });
});

app.delete('/api/admin/user/:username', verifyAdmin, async (req, res) => {
  const u = await users.findOne({ username: req.params.username });
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.ip && u.ip !== 'unknown') {
    await deletedIPs.updateOne({ ip: u.ip }, { $set: { ip: u.ip } }, { upsert: true });
  }
  await users.deleteOne({ username: req.params.username });
  res.json({ success: true });
});

app.post('/api/admin/challenge', verifyAdmin, async (req, res) => {
  const { active, startDate, durationDays } = req.body;
  const update = {
    active:      !!active,
    startDate:   startDate   || null,
    durationDays: durationDays || 7,
  };
  await challenge.updateOne({ _id: 'config' }, { $set: update }, { upsert: true });
  res.json({ success: true, challenge: update });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ─── START ────────────────────────────────────────────────────────────────────
connectDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`)))
  .catch(e => { console.error("DB connect failed:", e.message); console.error("Full error:", JSON.stringify(e, null, 2)); process.exit(1); });
