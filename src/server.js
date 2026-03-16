const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── SIMPLE DATA STORE ────────────────────────────────────────────────────────
// { users: { "username": { username, ip, dailyMs: {"2026-03-16": ms}, lastSeen } } }
// { challenge: { active, startDate, durationDays } }
// { deletedIPs: [] }

let db = { users: {}, challenge: { active: false, startDate: null, durationDays: 7 }, deletedIPs: [] };

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log('✅ Data loaded');
    }
  } catch (e) { console.warn('Load failed, fresh start'); }
}

function saveDB() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.warn('Save failed:', e.message); }
}

loadDB();

// ─── UTILS ────────────────────────────────────────────────────────────────────
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
}

// Get current IST date string (resets at 5am IST = 11:30pm UTC prev day)
function getTodayIST() {
  // IST = UTC + 5:30, reset at 5am IST = 23:30 UTC previous day
  const now = new Date();
  // Shift by IST offset (5.5 hours) then subtract 5 hours for 5am reset
  // Effective: date changes at 5am IST = UTC 23:30 of previous day
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000); // shift to IST
  const resetMs = istMs - (5 * 60 * 60 * 1000);          // subtract 5h for 5am reset
  return new Date(resetMs).toISOString().split('T')[0];
}

// ─── POST /api/submit ─────────────────────────────────────────────────────────
app.post('/api/submit', (req, res) => {
  const { username, timeSpentMs, allowRejoin } = req.body;

  if (!username?.trim() || timeSpentMs === undefined)
    return res.status(400).json({ error: 'username and timeSpentMs required' });

  const ip = getIP(req);
  const today = getTodayIST();

  // Check if IP was banned
  if (db.deletedIPs?.includes(ip) && !allowRejoin)
    return res.status(403).json({ error: 'removed' });

  // Lift ban if rejoining
  if (allowRejoin)
    db.deletedIPs = (db.deletedIPs || []).filter(i => i !== ip);

  // Block same IP with different username
  const conflict = Object.values(db.users).find(u => u.ip === ip && u.username !== username.trim());
  if (conflict)
    return res.status(409).json({ error: 'ip_conflict', existing: conflict.username });

  const name = username.trim();

  if (!db.users[name]) {
    db.users[name] = { username: name, ip, dailyMs: {}, joinedAt: new Date().toISOString() };
  }

  db.users[name].ip = ip;
  db.users[name].dailyMs[today] = timeSpentMs;
  db.users[name].lastSeen = new Date().toISOString();

  saveDB();
  res.json({ success: true });
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const today = getTodayIST();

  const users = Object.values(db.users)
    .map(u => ({
      username: u.username,
      todayMs: u.dailyMs[today] || 0,
      dailyMs: u.dailyMs,
      lastSeen: u.lastSeen,
      joinedAt: u.joinedAt,
    }))
    .filter(u => u.todayMs > 0)
    .sort((a, b) => b.todayMs - a.todayMs);

  res.json({ users, today, challenge: db.challenge });
});

// ─── GET /api/studywar ────────────────────────────────────────────────────────
app.get('/api/studywar', (req, res) => {
  const { challenge } = db;
  if (!challenge.active || !challenge.startDate)
    return res.json({ active: false, users: [] });

  const start = new Date(challenge.startDate);
  const today = new Date();
  const daysPassed = Math.min(
    Math.floor((today - start) / 86400000) + 1,
    challenge.durationDays || 7
  );
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + (challenge.durationDays || 7));

  const users = Object.values(db.users).map(u => {
    let totalMs = 0, daysCompleted = 0, daysAttempted = 0, dailyBreakdown = [];

    for (let d = 0; d < daysPassed; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const ms = u.dailyMs[dateStr] || 0;
      const hours = ms / 3600000;
      totalMs += ms;
      if (ms > 0) daysAttempted++;
      if (hours >= 10) daysCompleted++;
      dailyBreakdown.push({ date: dateStr, ms, hours: Math.round(hours * 10) / 10, completed: hours >= 10 });
    }

    const totalHours = Math.round((totalMs / 3600000) * 10) / 10;
    const eliminated = daysPassed > 1 && daysAttempted < daysPassed;
    let rank = null;
    if (daysCompleted >= 7) rank = 'gold';
    else if (daysCompleted >= 5) rank = 'silver';
    else if (daysCompleted >= 3) rank = 'bronze';

    return { username: u.username, totalMs, totalHours, daysCompleted, eliminated, rank, dailyBreakdown };
  });

  users.sort((a, b) => b.totalMs - a.totalMs);

  // King of today
  const todayStr = getTodayIST();
  let kingOfDay = null, kingMs = 0;
  users.forEach(u => {
    const day = u.dailyBreakdown.find(d => d.date === todayStr);
    if (day && day.ms > kingMs) { kingMs = day.ms; kingOfDay = u.username; }
  });

  res.json({ active: true, users, challenge, daysPassed, startDate: challenge.startDate, endDate: endDate.toISOString().split('T')[0], kingOfDay });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
function adminToken() { return Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64'); }
function verifyAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === adminToken()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true, token: adminToken() });
  else res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/users', verifyAdmin, (req, res) => {
  res.json({ users: Object.values(db.users).map(u => ({ username: u.username, ip: u.ip, todayMs: u.dailyMs[getTodayIST()] || 0, joinedAt: u.joinedAt })) });
});

app.delete('/api/admin/user/:username', verifyAdmin, (req, res) => {
  const u = db.users[req.params.username];
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.ip && u.ip !== 'unknown') {
    db.deletedIPs = db.deletedIPs || [];
    if (!db.deletedIPs.includes(u.ip)) db.deletedIPs.push(u.ip);
  }
  delete db.users[req.params.username];
  saveDB();
  res.json({ success: true });
});

app.post('/api/admin/challenge', verifyAdmin, (req, res) => {
  const { active, startDate, durationDays } = req.body;
  db.challenge = { active: !!active, startDate: startDate || db.challenge.startDate, durationDays: durationDays || 7 };
  saveDB();
  res.json({ success: true, challenge: db.challenge });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
