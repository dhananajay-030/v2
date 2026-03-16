const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, '..', 'data', 'leaderboard.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ensure data dir exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      users: {},
      challenge: {
        active: false,
        startDate: null,
        endDate: null,
        durationDays: 7
      },
      deletedIPs: []
    };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, challenge: { active: false, startDate: null, endDate: null, durationDays: 7 }, deletedIPs: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

// ─── POST /api/submit ───────────────────────────────────────────────────────
// Called by SP client to submit time
app.post('/api/submit', (req, res) => {
  const { username, timeSpentMs, date } = req.body;
  if (!username || timeSpentMs === undefined) {
    return res.status(400).json({ error: 'username and timeSpentMs required' });
  }

  const ip = getClientIP(req);
  const data = readData();

  // If this IP was deleted by admin, reject unless they re-register
  // (re-register handled by re-clicking the register button which sends allowRejoin flag)
  if (data.deletedIPs && data.deletedIPs.includes(ip) && !req.body.allowRejoin) {
    return res.status(403).json({ error: 'removed', message: 'You have been removed from the leaderboard. Click Join to re-appear.' });
  }

  // Remove from deletedIPs if rejoining
  if (req.body.allowRejoin && data.deletedIPs) {
    data.deletedIPs = data.deletedIPs.filter(i => i !== ip);
  }

  const today = date || new Date().toISOString().split('T')[0];

  // Check if another user with different name exists for this IP
  const existingIPEntry = Object.values(data.users).find(u => u.ip === ip && u.username !== username);
  if (existingIPEntry) {
    return res.status(409).json({ error: 'ip_conflict', message: 'Another user is registered from this device.' });
  }

  if (!data.users[username]) {
    data.users[username] = {
      username,
      ip,
      totalMs: 0,
      dailyMs: {},
      lastSeen: today,
      joinedAt: new Date().toISOString()
    };
  }

  // Update the user's IP (in case it changed)
  data.users[username].ip = ip;
  data.users[username].dailyMs[today] = timeSpentMs;
  data.users[username].totalMs = Object.values(data.users[username].dailyMs).reduce((a, b) => a + b, 0);
  data.users[username].lastSeen = today;

  writeData(data);
  res.json({ success: true });
});

// ─── GET /api/leaderboard ───────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const data = readData();
  const today = new Date().toISOString().split('T')[0];

  const users = Object.values(data.users).map(u => ({
    username: u.username,
    totalMs: u.totalMs,
    todayMs: u.dailyMs[today] || 0,
    dailyMs: u.dailyMs,
    lastSeen: u.lastSeen,
    joinedAt: u.joinedAt
  }));

  // Sort by today's time descending
  users.sort((a, b) => b.todayMs - a.todayMs);

  res.json({ users, challenge: data.challenge, today });
});

// ─── GET /api/studywar ──────────────────────────────────────────────────────
app.get('/api/studywar', (req, res) => {
  const data = readData();
  const challenge = data.challenge;

  if (!challenge.active || !challenge.startDate) {
    return res.json({ active: false, users: [], challenge });
  }

  const start = new Date(challenge.startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + (challenge.durationDays || 7));

  const today = new Date();
  const daysPassed = Math.min(
    Math.floor((today - start) / (1000 * 60 * 60 * 24)) + 1,
    challenge.durationDays || 7
  );

  const users = Object.values(data.users).map(u => {
    // Calculate challenge stats
    let totalChallengeMs = 0;
    let daysCompleted = 0;
    let daysAttempted = 0;
    let dailyBreakdown = [];

    for (let d = 0; d < daysPassed; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      const ms = u.dailyMs[dateStr] || 0;
      const hours = ms / (1000 * 60 * 60);

      totalChallengeMs += ms;
      if (ms > 0) daysAttempted++;
      if (hours >= 10) daysCompleted++;

      dailyBreakdown.push({ date: dateStr, ms, hours: Math.round(hours * 10) / 10, completed: hours >= 10 });
    }

    const totalHours = totalChallengeMs / (1000 * 60 * 60);
    const eliminated = daysAttempted < daysPassed && daysPassed > 1; // missed a day

    // Rank system
    let rank = null;
    if (daysCompleted >= 7) rank = 'gold';
    else if (daysCompleted >= 5) rank = 'silver';
    else if (daysCompleted >= 3) rank = 'bronze';

    // Special titles
    let titles = [];
    if (daysCompleted === challenge.durationDays) titles.push('iron_discipline');

    return {
      username: u.username,
      totalChallengeMs,
      totalHours: Math.round(totalHours * 10) / 10,
      daysCompleted,
      daysAttempted,
      eliminated,
      rank,
      titles,
      dailyBreakdown
    };
  });

  // Sort by totalChallengeMs descending
  users.sort((a, b) => b.totalChallengeMs - a.totalChallengeMs);

  // King of the day - highest today
  const todayStr = today.toISOString().split('T')[0];
  let kingOfDay = null;
  let maxToday = 0;
  users.forEach(u => {
    const day = u.dailyBreakdown.find(d => d.date === todayStr);
    if (day && day.ms > maxToday) { maxToday = day.ms; kingOfDay = u.username; }
  });

  res.json({
    active: true,
    users,
    challenge,
    kingOfDay,
    daysPassed,
    startDate: challenge.startDate,
    endDate: end.toISOString().split('T')[0]
  });
});

// ─── POST /api/admin/login ──────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64') });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

function verifyAdmin(req, res, next) {
  const auth = req.headers['x-admin-token'];
  const expected = Buffer.from(ADMIN_PASSWORD + ':admin').toString('base64');
  if (auth === expected) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── DELETE /api/admin/user/:username ───────────────────────────────────────
app.delete('/api/admin/user/:username', verifyAdmin, (req, res) => {
  const { username } = req.params;
  const data = readData();

  if (!data.users[username]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const ip = data.users[username].ip;
  delete data.users[username];

  if (ip && ip !== 'unknown') {
    if (!data.deletedIPs) data.deletedIPs = [];
    if (!data.deletedIPs.includes(ip)) data.deletedIPs.push(ip);
  }

  writeData(data);
  res.json({ success: true });
});

// ─── POST /api/admin/challenge ──────────────────────────────────────────────
app.post('/api/admin/challenge', verifyAdmin, (req, res) => {
  const { active, startDate, endDate, durationDays } = req.body;
  const data = readData();

  data.challenge = {
    active: !!active,
    startDate: startDate || data.challenge.startDate,
    endDate: endDate || data.challenge.endDate,
    durationDays: durationDays || data.challenge.durationDays || 7
  };

  writeData(data);
  res.json({ success: true, challenge: data.challenge });
});

// ─── GET /api/admin/users ───────────────────────────────────────────────────
app.get('/api/admin/users', verifyAdmin, (req, res) => {
  const data = readData();
  res.json({ users: Object.values(data.users), deletedIPs: data.deletedIPs || [] });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Leaderboard server running on port ${PORT}`);
});
