// server.js — EFOOTBALL ARENA. Zero dependencies (Node 18+): accounts, tournaments, room codes,
// dual-confirmed scores, disputes with proof screenshots, live updates over Server-Sent Events.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, save, DATA_DIR } = require('./store');
const E = require('./engine');
const { HttpError, fail } = E;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').toLowerCase();
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const intIn = (v, lo, hi, label) => {
  const n = Number(v);
  if (v === '' || v === null || !Number.isInteger(n) || n < lo || n > hi) fail(400, `${label} must be a whole number from ${lo} to ${hi}`);
  return n;
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}
const DUMMY_HASH = hashPassword('dummy-password');

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { userId, exp: Date.now() + 30 * 24 * 3600 * 1000 };
  save();
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.sessions[sha(token)];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[sha(token)]; return null; }
  return db.users[s.userId] || null;
}
const isBot = (id) => !!(id && db.users[id] && db.users[id].isBot);
const publicUser = (u) => u && ({ id: u.id, name: u.displayName, efootballId: u.efootballId || '', isBot: !!u.isBot });
const meView = (u) => ({ id: u.id, username: u.username, name: u.displayName, efootballId: u.efootballId || '', role: u.role });

// ---------- live updates (Server-Sent Events) ----------
const streams = new Set();
function changed(tid) {
  const msg = `data: ${JSON.stringify({ tid })}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25_000).unref();

// ---------- rate limiting (in memory) ----------
const buckets = new Map();
function hit(name, ip, max, windowMs) {
  const key = name + ':' + ip;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (++b.n > max) fail(429, 'Too many requests, slow down');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

// ---------- views (what each viewer may see) ----------
function matchView(t, m, viewer) {
  const involved = E.isPlayerOf(m, viewer.id);
  const judge = viewer.role === 'admin' || t.organizerId === viewer.id;
  const revealReports = m.status === 'DISPUTED' || m.status === 'CONFIRMED' || judge;
  const mySide = m.a === viewer.id ? 'a' : m.b === viewer.id ? 'b' : null;
  return {
    id: m.id, round: m.round, index: m.index, name: m.name,
    a: m.a, b: m.b, status: m.status,
    roomCode: (involved || judge) ? m.roomCode : (m.roomCode ? '••••' : null),
    scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, decidedBy: m.decidedBy,
    iReported: mySide ? !!m.reports[mySide] : false,
    opponentReported: mySide ? !!m.reports[mySide === 'a' ? 'b' : 'a'] : false,
    reports: revealReports ? m.reports : undefined,
    evidence: (involved || judge) ? Object.keys(m.evidence || {}) : [],
    canJudge: E.canJudge(t, m, viewer),
  };
}
function tournamentView(t, viewer) {
  const ids = new Set(t.players);
  t.matches.forEach(m => { if (m.a) ids.add(m.a); if (m.b) ids.add(m.b); });
  const people = {};
  ids.forEach(id => { people[id] = publicUser(db.users[id]); });
  return {
    id: t.id, title: t.title, platform: t.platform, size: t.size, status: t.status,
    organizerId: t.organizerId, players: t.players, champion: t.champion, createdAt: t.createdAt,
    people, matches: t.matches.map(m => matchView(t, m, viewer)),
    log: t.log.slice(0, 40),
    joined: t.players.includes(viewer.id),
    isOrganizer: t.organizerId === viewer.id,
  };
}
function summary(t) {
  return {
    id: t.id, title: t.title, platform: t.platform, size: t.size, status: t.status,
    joinedCount: t.players.length, organizer: publicUser(db.users[t.organizerId])?.name,
    champion: t.champion ? publicUser(db.users[t.champion])?.name : null, createdAt: t.createdAt,
  };
}
function getT(id) {
  const t = Object.prototype.hasOwnProperty.call(db.tournaments, id) ? db.tournaments[id] : null;
  if (!t) fail(404, 'Tournament not found');
  return t;
}
function after(t) { E.runBots(t, isBot); save(); changed(t.id); }

// ---------- evidence helpers ----------
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}
const AUTHED = { auth: true };

// Auth
route('POST', '/api/auth/register', { limit: ['auth', 15, 10 * 60_000] }, ({ body, ip }) => {
  const username = clean(body.username, 20).toLowerCase();
  const password = String(body.password || '');
  const displayName = clean(body.displayName, 24) || username;
  const efootballId = clean(body.efootballId, 24);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Username: 3-20 letters, numbers or underscore');
  if (password.length < 6 || password.length > 100) fail(400, 'Password must be 6 to 100 characters');
  if (displayName.length < 2) fail(400, 'Display name is too short');
  if (Object.values(db.users).some(u => u.username === username)) fail(409, 'Username is taken');
  const humans = Object.values(db.users).filter(u => !u.isBot).length;
  const isAdmin = ADMIN_USERNAME ? username === ADMIN_USERNAME : humans === 0;
  const user = { id: E.rid('usr'), username, displayName, efootballId, passHash: hashPassword(password), role: isAdmin ? 'admin' : 'player', createdAt: Date.now() };
  db.users[user.id] = user;
  return { token: newSession(user.id), user: meView(user) };
});

route('POST', '/api/auth/login', { limit: ['auth', 15, 10 * 60_000] }, ({ body }) => {
  const username = clean(body.username, 20).toLowerCase();
  const user = Object.values(db.users).find(u => u.username === username && !u.isBot);
  const ok = checkPassword(String(body.password || ''), user ? user.passHash : DUMMY_HASH) && !!user;
  if (!ok) fail(401, 'Wrong username or password');
  return { token: newSession(user.id), user: meView(user) };
});

route('POST', '/api/auth/logout', AUTHED, ({ token }) => { delete db.sessions[sha(token)]; save(); return { ok: true }; });
route('GET', '/api/me', AUTHED, ({ user }) => ({ user: meView(user) }));
route('PATCH', '/api/me', AUTHED, ({ user, body }) => {
  const name = clean(body.displayName, 24);
  if (name.length >= 2) user.displayName = name;
  user.efootballId = clean(body.efootballId, 24);
  save();
  return { user: meView(user) };
});

// Tournaments
route('GET', '/api/tournaments', AUTHED, () => ({
  tournaments: Object.values(db.tournaments).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(summary),
}));

route('POST', '/api/tournaments', { auth: true, limit: ['create', 10, 60 * 60_000] }, ({ user, body }) => {
  const title = clean(body.title, 40);
  if (title.length < 3) fail(400, 'Cup name must be at least 3 characters');
  if (!['Mobile', 'PlayStation', 'PC'].includes(body.platform)) fail(400, 'Choose a platform');
  const size = intIn(body.size, 4, 16, 'Size');
  if (!E.SIZES.includes(size)) fail(400, 'Size must be 4, 8 or 16');
  const t = E.newTournament({ title, platform: body.platform, size, organizerId: user.id });
  E.log(t, `Tournament created by ${user.displayName}.`);
  db.tournaments[t.id] = t;
  save(); changed(t.id);
  return { id: t.id };
});

route('GET', '/api/tournaments/:tid', AUTHED, ({ user, params }) => ({ tournament: tournamentView(getT(params.tid), user) }));

route('POST', '/api/tournaments/:tid/join', AUTHED, ({ user, params }) => {
  const t = getT(params.tid);
  if (t.status !== 'OPEN') fail(409, 'Registration is closed');
  if (t.players.includes(user.id)) fail(409, 'You already joined');
  if (t.players.length >= t.size) fail(409, 'Tournament is full');
  t.players.push(user.id);
  E.log(t, `${user.displayName} joined (${t.players.length}/${t.size}).`);
  save(); changed(t.id);
  return { ok: true };
});

route('POST', '/api/tournaments/:tid/leave', AUTHED, ({ user, params }) => {
  const t = getT(params.tid);
  if (t.status !== 'OPEN') fail(409, 'Tournament already started');
  if (t.organizerId === user.id) fail(400, 'The organizer cannot leave; cancel the tournament instead');
  if (!t.players.includes(user.id)) fail(409, 'You are not in this tournament');
  t.players = t.players.filter(id => id !== user.id);
  E.log(t, `${user.displayName} left.`);
  save(); changed(t.id);
  return { ok: true };
});

route('POST', '/api/tournaments/:tid/start', AUTHED, ({ user, params, body }) => {
  const t = getT(params.tid);
  if (t.organizerId !== user.id && user.role !== 'admin') fail(403, 'Only the organizer can start');
  if (t.status !== 'OPEN') fail(409, 'Already started');
  if (t.players.length < t.size) {
    if (!body.fillBots) fail(409, `Need ${t.size} players (have ${t.players.length}). Wait for more, or fill empty slots with test bots.`);
    let n = 1;
    while (t.players.length < t.size) {
      const bot = { id: E.rid('bot'), username: 'bot_' + t.id + '_' + n, displayName: 'Bot ' + n, isBot: true, role: 'player', createdAt: Date.now() };
      db.users[bot.id] = bot;
      t.players.push(bot.id);
      n++;
    }
    E.log(t, 'Empty slots filled with test bots.');
  }
  t.status = 'LIVE';
  E.buildBracket(t);
  E.log(t, 'Bracket generated. Good luck!');
  after(t);
  return { ok: true };
});

route('POST', '/api/tournaments/:tid/cancel', AUTHED, ({ user, params }) => {
  const t = getT(params.tid);
  if (t.organizerId !== user.id && user.role !== 'admin') fail(403, 'Only the organizer can cancel');
  if (t.status === 'COMPLETE' || t.status === 'CANCELLED') fail(409, 'Already finished');
  t.status = 'CANCELLED';
  E.log(t, 'Tournament cancelled.');
  save(); changed(t.id);
  return { ok: true };
});

// Match actions
const matchRoute = (path_, opts, fn) => route('POST', path_, opts, (ctx) => {
  const t = getT(ctx.params.tid);
  const m = E.getMatch(t, ctx.params.mid);
  fn(ctx, t, m);
  after(t);
  return { ok: true };
});

matchRoute('/api/tournaments/:tid/matches/:mid/room-code', AUTHED, ({ user, body }, t, m) => {
  const code = clean(body.roomCode, 32);
  if (!/^[A-Za-z0-9 _-]{3,32}$/.test(code)) fail(400, 'Room code: 3-32 letters, numbers, space, dash');
  E.setRoomCode(t, m, user.id, code);
});

matchRoute('/api/tournaments/:tid/matches/:mid/report', AUTHED, ({ user, body }, t, m) => {
  const my = intIn(body.myScore, 0, 99, 'Your score');
  const opp = intIn(body.oppScore, 0, 99, 'Opponent score');
  E.reportScore(t, m, user.id, my, opp);
});

matchRoute('/api/tournaments/:tid/matches/:mid/resolve', AUTHED, ({ user, body }, t, m) => {
  E.resolveDispute(t, m, user, intIn(body.scoreA, 0, 99, 'Score A'), intIn(body.scoreB, 0, 99, 'Score B'));
});

matchRoute('/api/tournaments/:tid/matches/:mid/forfeit', AUTHED, ({ user, body }, t, m) => {
  E.forfeit(t, m, user, String(body.loserId || ''));
});

// Proof screenshots
route('POST', '/api/tournaments/:tid/matches/:mid/evidence',
  { auth: true, bodyLimit: 3 * 1024 * 1024, limit: ['evidence', 20, 10 * 60_000] }, ({ user, params, body }) => {
    const t = getT(params.tid);
    const m = E.getMatch(t, params.mid);
    if (!E.isPlayerOf(m, user.id)) fail(403, 'Only the two players can upload proof');
    const mm = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
    if (!mm) fail(400, 'Upload a PNG, JPG or WEBP screenshot');
    const buf = Buffer.from(mm[1], 'base64');
    if (buf.length > 2 * 1024 * 1024) fail(413, 'Screenshot must be under 2 MB');
    const ext = sniff(buf);
    if (!ext) fail(400, 'File is not a valid image');
    const file = `${t.id}_${m.id}_${user.id}.${ext}`;
    fs.writeFileSync(path.join(DATA_DIR, 'evidence', file), buf);
    m.evidence[user.id] = file;
    E.log(t, `${m.name} ${m.id}: proof screenshot uploaded.`);
    save(); changed(t.id);
    return { ok: true };
  });

route('GET', '/api/tournaments/:tid/matches/:mid/evidence/:uid', AUTHED, ({ user, params }) => {
  const t = getT(params.tid);
  const m = E.getMatch(t, params.mid);
  const judge = user.role === 'admin' || t.organizerId === user.id;
  if (!E.isPlayerOf(m, user.id) && !judge) fail(403, 'Not allowed');
  const file = Object.prototype.hasOwnProperty.call(m.evidence, params.uid) ? m.evidence[params.uid] : null;
  if (!file || !/^[\w.-]+$/.test(file)) fail(404, 'No proof uploaded');
  return { __file: path.join(DATA_DIR, 'evidence', file), type: MIME[file.split('.').pop()], cache: 'private, max-age=60' };
});

// Disputes inbox
route('GET', '/api/disputes', AUTHED, ({ user }) => {
  const out = [];
  for (const t of Object.values(db.tournaments)) {
    if (t.status !== 'LIVE') continue;
    if (user.role !== 'admin' && t.organizerId !== user.id) continue;
    for (const m of t.matches) {
      if (m.status === 'DISPUTED') {
        out.push({ tid: t.id, mid: m.id, title: t.title, name: m.name, a: publicUser(db.users[m.a]), b: publicUser(db.users[m.b]), reports: m.reports, canJudge: E.canJudge(t, m, user) });
      }
    }
  }
  return { disputes: out };
});

// ---------- server ----------
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS };
  if (status === 413) headers.Connection = 'close';        // we did not read the whole body
  res.writeHead(status, headers);
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;                                   // discard the rest, reply first, then close
      size += c.length;
      if (size > limit) {
        tooBig = true;
        reject(new HttpError(413, 'Request too large'));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function serveFile(res, file, type, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache, ...SEC_HEADERS });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'x';
  const clientIp = (process.env.TRUST_PROXY !== '0' && req.headers['x-forwarded-for']) ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : ip;
  hit('api', clientIp, 300, 60_000);

  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    if (!userFromToken(token)) fail(401, 'Please log in');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS });
    res.write('retry: 3000\n: connected\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  let match = null, params = {};
  let pathKnown = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathKnown = true;
    if (r.method !== req.method) continue;
    match = r;
    r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { fail(400, 'Bad request'); } });
    break;
  }
  if (!match) fail(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Not found');

  const { opts } = match;
  if (opts.limit) hit(opts.limit[0], clientIp, opts.limit[1], opts.limit[2]);
  let user = null;
  if (opts.auth) {
    user = userFromToken(token);
    if (!user) fail(401, 'Please log in');
  }
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    const raw = await readBody(req, opts.bodyLimit || 10 * 1024);
    if (raw) {
      try { body = JSON.parse(raw); } catch { fail(400, 'Bad request'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Bad request');
    }
  }
  const result = match.handler({ req, user, token, params, body, ip: clientIp, query: url.searchParams });
  if (result && result.__file) return serveFile(res, result.__file, result.type, result.cache);
  sendJson(res, 200, result);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return sendJson(res, 400, { error: 'Bad request' }); }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      if (res.headersSent) return;
      if (e instanceof HttpError) {
        if (e.status === 413) res.on('finish', () => req.destroy());
        return sendJson(res, e.status, { error: e.message });
      }
      console.error(e);
      sendJson(res, 500, { error: 'Server error' });
    });
    return;
  }
  if (url.pathname === '/healthz') { res.writeHead(200, SEC_HEADERS); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  serveFile(res, file, TYPES[path.extname(file)] || 'application/octet-stream', 'no-cache');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`EFOOTBALL ARENA running on http://localhost:${PORT}`));
}
module.exports = { server };
