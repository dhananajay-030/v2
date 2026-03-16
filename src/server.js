const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_ID = process.env.JSONBIN_ID || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── IN-MEMORY STORE ─────────────────────────────────────────────────────────
let db = {
  users: {},
  challenge: { active: false, startDate: null, durationDays: 7 },
  deletedIPs: []
};
let dbLoaded = false;
let savePending = false;

// ─── JSONBIN PERSISTENCE ──────────────────────────────────────────────────────
function jsonbinRequest(method, data) {
  return new Promise((resolve, reject) => {
    if (!JSONBIN_KEY || !JSONBIN_ID) { dbLoaded = true; return resolve(null); }
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${JSONBIN_ID}`,
      method,
      headers: {
        'X-Master-Key': JSONBIN_KEY,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function loadFromBin() {
  try {
    const res = await jsonbinRequest('GET');
    if (res?.record) { db = { ...db, ...res.record }; console.log('✅ Loaded from JSONBin'); }
  } catch (e) { console.warn('JSONBin load failed:', e.message); }
  dbLoaded = true;
}

function saveData() {
  if (savePending) return;
  savePending = true;
  setTimeout(async () => {
    savePending = false;
    try { await jsonbinRequest('PUT', db); } catch (e) { console.warn('Save failed:', e.message); }
  }, 2000);
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api') && !dbLoaded)
    return res.status(503).json({ error: 'Loading, retry in a moment' });
  next();
});

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

// ─── POST /api/submit ─────────────────────────────────────────────────────────
app.post('/api/submit', (req, res) => {
  const { username, timeSpentMs, date, allowRejoin } = req.body;
  if (!username || timeSpentMs === undefined)
    return res.status(400).json({ error: 'username and timeSpentMs required' });

  const ip = getClientIP(req);
  const today = date || new Date().toISOString().split('T')[0];

  if (db.deletedIPs?.includes(ip) && !allowRejoin)
    return res.status(403).json({ error: 'removed' });

  if (allowRejoin) db.deletedIPs = (db.deletedIPs || []).filter(i => i !== ip);

  const conflict = Object.values(db.users).find(u => u.ip === ip && u.username !== username);
  if (conflict) return res.status(409).json({ error: 'ip_conflict' });

  if (!db.users[username]) {
    db.users[username] = { username, ip, totalMs: 0, dailyMs: {}, lastSeen: today, joinedAt: new Date().toISOString() };
  }
  db.users[username].ip = ip;
  db.users[username].dailyMs[today] = timeSpentMs;
  db.users[username].totalMs = Object.values(db.users[username].dailyMs).reduce((a, b) => a + b, 0);
  db.users[username].lastSeen = today;
  saveData();
  res.json({ success: true });
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const users = Object.values(db.users).map(u => ({
    username: u.username, totalMs: u.totalMs,
    todayMs: u.dailyMs[today] || 0, dailyMs: u.dailyMs,
    lastSeen: u.lastSeen, joinedAt: u.joinedAt
  }));
  users.sort((a, b) => b.todayMs - a.todayMs);
  res.json({ users, challenge: db.challenge, today });
});

// ─── GET /api/studywar ────────────────────────────────────────────────────────
app.get('/api/studywar', (req, res) => {
  const challenge = db.challenge;
  if (!challenge.active || !challenge.startDate)
    return res.json({ active: false, users: [], challenge });

  const start = new Date(challenge.startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + (challenge.durationDays || 7));
  const today = new Date();
  const daysPassed = Math.min(
    Math.floor((today - start) / 86400000) + 1, challenge.durationDays || 7
  );

  const users = Object.values(db.users).map(u => {
    let totalChallengeMs = 0, daysCompleted = 0, daysAttempted = 0, dailyBreakdown = [];
    for (let d = 0; d < daysPassed; d++) {
      const date = new Date(start); date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const ms = u.dailyMs[dateStr] || 0;
      const hours = ms / 3600000;
      totalChallengeMs += ms;
      if (ms > 0) daysAttempted++;
      if (hours >= 10) daysCompleted++;
      dailyBreakdown.push({ date: dateStr, ms, hours: Math.round(hours * 10) / 10, completed: hours >= 10 });
    }
    const totalHours = totalChallengeMs / 3600000;
    const eliminated = daysPassed > 1 && daysAttempted < daysPassed;
    let rank = null;
    if (daysCompleted >= 7) rank = 'gold';
    else if (daysCompleted >= 5) rank = 'silver';
    else if (daysCompleted >= 3) rank = 'bronze';
    let titles = [];
    if (daysCompleted === (challenge.durationDays || 7)) titles.push('iron_discipline');
    return { username: u.username, totalChallengeMs, totalHours: Math.round(totalHours*10)/10, daysCompleted, daysAttempted, eliminated, rank, titles, dailyBreakdown };
  });

  users.sort((a, b) => b.totalChallengeMs - a.totalChallengeMs);
  const todayStr = today.toISOString().split('T')[0];
  let kingOfDay = null, maxToday = 0;
  users.forEach(u => {
    const day = u.dailyBreakdown.find(d => d.date === todayStr);
    if (day && day.ms > maxToday) { maxToday = day.ms; kingOfDay = u.username; }
  });

  res.json({ active: true, users, challenge, kingOfDay, daysPassed, startDate: challenge.startDate, endDate: end.toISOString().split('T')[0] });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD)
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64') });
  else res.status(401).json({ error: 'Wrong password' });
});

function verifyAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64')) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.delete('/api/admin/user/:username', verifyAdmin, (req, res) => {
  const u = db.users[req.params.username];
  if (!u) return res.status(404).json({ error: 'Not found' });
  const ip = u.ip;
  delete db.users[req.params.username];
  if (ip && ip !== 'unknown') {
    if (!db.deletedIPs) db.deletedIPs = [];
    if (!db.deletedIPs.includes(ip)) db.deletedIPs.push(ip);
  }
  saveData();
  res.json({ success: true });
});

app.post('/api/admin/challenge', verifyAdmin, (req, res) => {
  const { active, startDate, durationDays } = req.body;
  db.challenge = { active: !!active, startDate: startDate || db.challenge.startDate, durationDays: durationDays || db.challenge.durationDays || 7 };
  saveData();
  res.json({ success: true, challenge: db.challenge });
});

app.get('/api/admin/users', verifyAdmin, (req, res) => {
  res.json({ users: Object.values(db.users), deletedIPs: db.deletedIPs || [] });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

loadFromBin().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
});
