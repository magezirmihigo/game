// test.js — end-to-end test. Run: node test.js   (no dependencies, uses a temp data folder)
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'efa-'));
const E = require('./engine');
const { server } = require('./server');

let base, passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

async function api(token, method, url, body, raw) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}
async function register(username, extra = {}) {
  const r = await api(null, 'POST', '/api/auth/register', { username, password: 'secret123', displayName: username, ...extra });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return { token: r.data.token, user: r.data.user };
}
const getT = async (tok, id) => (await api(tok, 'GET', '/api/tournaments/' + id)).data.tournament;

(async () => {
  // ---- engine unit checks ----
  console.log('Engine');
  const t16 = E.newTournament({ title: 'x', platform: 'PC', size: 16, organizerId: 'u0' });
  t16.players = Array.from({ length: 16 }, (_, i) => 'u' + i);
  E.buildBracket(t16);
  assert.strictEqual(t16.matches.length, 15);
  assert.deepStrictEqual([...new Set(t16.matches.map(m => m.name))], ['Round of 16', 'Quarterfinals', 'Semifinals', 'Final']);
  assert.strictEqual(new Set(t16.matches.filter(m => m.round === 1).flatMap(m => [m.a, m.b])).size, 16);
  ok('16-player bracket: 15 matches, correct rounds, every player placed once');

  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;

  console.log('Accounts & security');
  const root = await register('root');            // first user = admin
  assert.strictEqual(root.user.role, 'admin');
  const cap = await register('capitan', { displayName: 'Capitan <b>X</b>', efootballId: 'EF-1' });
  assert.strictEqual(cap.user.role, 'player');
  assert.ok(!/[<>]/.test(cap.user.name), 'angle brackets stripped');
  const [p1, p2, p3, p4] = await Promise.all(['plyr1', 'plyr2', 'plyr3', 'plyr4'].map(n => register(n)));
  ok('first user is admin, later users are players, names sanitised');

  assert.strictEqual((await api(null, 'GET', '/api/tournaments')).status, 401);
  assert.strictEqual((await api('bogus', 'GET', '/api/me')).status, 401);
  assert.strictEqual((await api(null, 'POST', '/api/auth/login', { username: 'capitan', password: 'wrong' })).status, 401);
  assert.strictEqual((await api(null, 'POST', '/api/auth/register', { username: 'capitan', password: 'secret123' })).status, 409);
  assert.strictEqual((await api(null, 'POST', '/api/auth/register', { username: 'ab', password: 'secret123' })).status, 400);
  const login = await api(null, 'POST', '/api/auth/login', { username: 'CAPITAN', password: 'secret123' });
  assert.strictEqual(login.status, 200);
  ok('auth required, wrong password rejected, duplicate/short usernames rejected, login case-insensitive');

  assert.strictEqual((await api(cap.token, 'POST', '/api/tournaments', '{bad json', true)).status, 400);
  assert.strictEqual((await api(cap.token, 'POST', '/api/tournaments', 'x'.repeat(20000), true)).status, 413);
  assert.strictEqual((await api(cap.token, 'GET', '/..%2f..%2fserver.js')).status, 404);
  assert.strictEqual((await api(cap.token, 'DELETE', '/api/tournaments')).status, 405);
  ok('bad JSON → 400, oversized body → 413, path traversal → 404, wrong method → 405');

  console.log('Tournament lifecycle');
  const bad = await api(cap.token, 'POST', '/api/tournaments', { title: 'Cup', platform: 'Xbox', size: 4 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await api(cap.token, 'POST', '/api/tournaments', { title: 'Cup', platform: 'PC', size: 6 })).status, 400);
  const created = await api(cap.token, 'POST', '/api/tournaments', { title: 'Dar es Salaam Cup', platform: 'Mobile', size: 4 });
  assert.strictEqual(created.status, 200);
  const tid = created.data.id;

  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${tid}/join`)).status, 409);  // organizer already in
  assert.strictEqual((await api(p1.token, 'POST', `/api/tournaments/${tid}/join`)).status, 200);
  assert.strictEqual((await api(p1.token, 'POST', `/api/tournaments/${tid}/join`)).status, 409);
  assert.strictEqual((await api(p2.token, 'POST', `/api/tournaments/${tid}/start`, {})).status, 403);
  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${tid}/start`, {})).status, 409); // not full
  assert.strictEqual((await api(p2.token, 'POST', `/api/tournaments/${tid}/join`)).status, 200);
  assert.strictEqual((await api(p2.token, 'POST', `/api/tournaments/${tid}/leave`)).status, 200);
  assert.strictEqual((await api(p2.token, 'POST', `/api/tournaments/${tid}/join`)).status, 200);
  assert.strictEqual((await api(p3.token, 'POST', `/api/tournaments/${tid}/join`)).status, 200);
  assert.strictEqual((await api(p4.token, 'POST', `/api/tournaments/${tid}/join`)).status, 409);   // full
  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${tid}/start`, {})).status, 200);
  ok('join/leave/full/start rules enforced (only organizer starts, needs full bracket)');

  const tokenOf = { [cap.user.id]: cap.token, [p1.user.id]: p1.token, [p2.user.id]: p2.token, [p3.user.id]: p3.token };
  let t = await getT(cap.token, tid);
  assert.strictEqual(t.status, 'LIVE');
  assert.strictEqual(t.matches.length, 3);
  const [m1, m2] = t.matches.filter(m => m.round === 1);
  const base_ = `/api/tournaments/${tid}/matches/`;

  // --- match 1: happy path with room code privacy ---
  assert.strictEqual((await api(tokenOf[m1.b], 'POST', base_ + m1.id + '/room-code', { roomCode: 'AB-1234' })).status, 403);
  assert.strictEqual((await api(tokenOf[m1.a], 'POST', base_ + m1.id + '/room-code', { roomCode: '!' })).status, 400);
  assert.strictEqual((await api(tokenOf[m1.b], 'POST', base_ + m1.id + '/report', { myScore: 1, oppScore: 0 })).status, 409); // no code yet
  assert.strictEqual((await api(tokenOf[m1.a], 'POST', base_ + m1.id + '/room-code', { roomCode: 'AB-1234' })).status, 200);
  const outsiderTok = tokenOf[m2.a];   // plays in the other semifinal, so is an outsider to match 1
  const seenByOutsider = (await getT(outsiderTok, tid)).matches.find(m => m.id === m1.id);
  assert.strictEqual(seenByOutsider.roomCode, '••••');
  assert.strictEqual((await getT(tokenOf[m1.b], tid)).matches.find(m => m.id === m1.id).roomCode, 'AB-1234');
  assert.strictEqual((await api(outsiderTok, 'POST', base_ + m1.id + '/report', { myScore: 5, oppScore: 0 })).status, 403);
  assert.strictEqual((await api(tokenOf[m1.a], 'POST', base_ + m1.id + '/report', { myScore: 2, oppScore: 2 })).status, 400);
  assert.strictEqual((await api(tokenOf[m1.a], 'POST', base_ + m1.id + '/report', { myScore: 'abc', oppScore: 1 })).status, 400);
  assert.strictEqual((await api(tokenOf[m1.a], 'POST', base_ + m1.id + '/report', { myScore: 3, oppScore: 1 })).status, 200);
  let v = (await getT(tokenOf[m1.b], tid)).matches.find(m => m.id === m1.id);
  assert.strictEqual(v.status, 'IN_PROGRESS');
  assert.strictEqual(v.reports, undefined, 'opponent cannot see the other side report early');
  assert.strictEqual(v.opponentReported, true);
  // B confirms from their own point of view (1-3)
  assert.strictEqual((await api(tokenOf[m1.b], 'POST', base_ + m1.id + '/report', { myScore: 1, oppScore: 3 })).status, 200);
  v = (await getT(cap.token, tid)).matches.find(m => m.id === m1.id);
  assert.strictEqual(v.status, 'CONFIRMED');
  assert.strictEqual(v.winner, m1.a);
  assert.strictEqual(v.scoreA, 3); assert.strictEqual(v.scoreB, 1);
  ok('room code host-only & hidden from outsiders; no early score peeking; mirrored scores confirm; winner advances');

  // --- match 2: dispute, proof, ruling ---
  assert.strictEqual((await api(tokenOf[m2.a], 'POST', base_ + m2.id + '/room-code', { roomCode: 'ZZ-9999' })).status, 200);
  await api(tokenOf[m2.a], 'POST', base_ + m2.id + '/report', { myScore: 2, oppScore: 1 });
  await api(tokenOf[m2.b], 'POST', base_ + m2.id + '/report', { myScore: 2, oppScore: 1 });   // both claim they won 2-1
  v = (await getT(root.token, tid)).matches.find(m => m.id === m2.id);
  assert.strictEqual(v.status, 'DISPUTED');
  assert.ok(v.reports.a && v.reports.b);
  const inbox = await api(root.token, 'GET', '/api/disputes');
  assert.strictEqual(inbox.data.disputes.length, 1);
  assert.strictEqual((await api(p4.token, 'GET', '/api/disputes')).data.disputes.length, 0);
  ok('conflicting reports open a dispute, admin inbox shows it, strangers see none');

  // proof screenshot
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await api(tokenOf[m2.a], 'POST', base_ + m2.id + '/evidence', { image: 'data:image/png;base64,' + png.toString('base64') });
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  assert.strictEqual((await api(tokenOf[m2.a], 'POST', base_ + m2.id + '/evidence', { image: 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
  assert.strictEqual((await api(p4.token, 'POST', base_ + m2.id + '/evidence', { image: 'data:image/png;base64,' + png.toString('base64') })).status, 403);
  const img = await api(root.token, 'GET', base_ + m2.id + '/evidence/' + m2.a);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await api(p4.token, 'GET', base_ + m2.id + '/evidence/' + m2.a)).status, 403);
  ok('proof upload: real images only, players only; viewable by opponent/judge, not strangers');

  // ruling: a player in the match can never rule; admin can
  assert.strictEqual((await api(tokenOf[m2.a], 'POST', base_ + m2.id + '/resolve', { scoreA: 2, scoreB: 1 })).status, 403);
  assert.strictEqual((await api(tokenOf[m2.b], 'POST', base_ + m2.id + '/resolve', { scoreA: 1, scoreB: 2 })).status, 403);
  const organizerInMatch = [m2.a, m2.b].includes(cap.user.id);
  assert.strictEqual((await api(cap.token, 'POST', base_ + m2.id + '/resolve', { scoreA: 2, scoreB: 1 })).status, organizerInMatch ? 403 : 200);
  if (organizerInMatch) assert.strictEqual((await api(root.token, 'POST', base_ + m2.id + '/resolve', { scoreA: 2, scoreB: 1 })).status, 200);
  v = (await getT(root.token, tid)).matches.find(m => m.id === m2.id);
  assert.strictEqual(v.status, 'CONFIRMED'); assert.strictEqual(v.winner, m2.a); assert.strictEqual(v.decidedBy, 'admin');
  ok('players cannot rule on their own match; organizer only if not involved; admin always can');

  // --- final ---
  t = await getT(cap.token, tid);
  const fin = t.matches.find(m => m.name === 'Final');
  assert.strictEqual(fin.status, 'AWAITING_CODE');
  assert.deepStrictEqual([fin.a, fin.b].sort(), [m1.a, m2.a].sort());
  await api(tokenOf[fin.a], 'POST', base_ + fin.id + '/room-code', { roomCode: 'FINAL-1' });
  await api(tokenOf[fin.a], 'POST', base_ + fin.id + '/report', { myScore: 0, oppScore: 1 });
  await api(tokenOf[fin.b], 'POST', base_ + fin.id + '/report', { myScore: 1, oppScore: 0 });
  t = await getT(cap.token, tid);
  assert.strictEqual(t.status, 'COMPLETE');
  assert.strictEqual(t.champion, fin.b);
  assert.strictEqual((await api(tokenOf[fin.b], 'POST', base_ + fin.id + '/report', { myScore: 9, oppScore: 0 })).status, 409);
  ok('final unlocks, completes tournament with the right champion, results are locked afterwards');

  // --- forfeit ---
  const f = (await api(cap.token, 'POST', '/api/tournaments', { title: 'Forfeit Cup', platform: 'PC', size: 4 })).data.id;
  for (const p of [p1, p2, p3]) await api(p.token, 'POST', `/api/tournaments/${f}/join`);
  await api(cap.token, 'POST', `/api/tournaments/${f}/start`, {});
  const ft = await getT(root.token, f);
  const fm = ft.matches.find(m => m.round === 1 && m.a !== cap.user.id && m.b !== cap.user.id) || ft.matches.find(m => m.round === 1);
  const fr = await api(cap.token, 'POST', `/api/tournaments/${f}/matches/${fm.id}/forfeit`, { loserId: fm.b });
  assert.strictEqual(fr.status, [fm.a, fm.b].includes(cap.user.id) ? 403 : 200);
  if (fr.status === 403) assert.strictEqual((await api(root.token, 'POST', `/api/tournaments/${f}/matches/${fm.id}/forfeit`, { loserId: fm.b })).status, 200);
  assert.strictEqual((await getT(root.token, f)).matches.find(m => m.id === fm.id).winner, fm.a);
  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${f}/cancel`)).status, 200);
  ok('no-show forfeit advances the other player; cancel works');

  // --- bots: organizer plays an 8-player cup alone ---
  console.log('Solo test with bots');
  const b8 = (await api(cap.token, 'POST', '/api/tournaments', { title: 'Bot Cup', platform: 'PC', size: 8 })).data.id;
  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${b8}/start`, {})).status, 409);
  assert.strictEqual((await api(cap.token, 'POST', `/api/tournaments/${b8}/start`, { fillBots: true })).status, 200);
  let guard = 0;
  while (guard++ < 10) {
    const bt = await getT(cap.token, b8);
    if (bt.status === 'COMPLETE') break;
    const mine = bt.matches.find(m => (m.a === cap.user.id || m.b === cap.user.id) && ['AWAITING_CODE', 'IN_PROGRESS'].includes(m.status));
    assert.ok(mine, 'organizer should always have a playable match until eliminated or champion');
    const u = `/api/tournaments/${b8}/matches/${mine.id}/`;
    if (mine.status === 'AWAITING_CODE') {
      if (mine.a === cap.user.id) assert.strictEqual((await api(cap.token, 'POST', u + 'room-code', { roomCode: 'MY-ROOM' })).status, 200);
      else { // bot host already set code on creation of the match; nothing for us to do
        assert.fail('bot-hosted match should already be IN_PROGRESS');
      }
    }
    assert.strictEqual((await api(cap.token, 'POST', u + 'report', { myScore: 3, oppScore: 0 })).status, 200);
  }
  const done = await getT(cap.token, b8);
  assert.strictEqual(done.status, 'COMPLETE');
  assert.strictEqual(done.champion, cap.user.id);
  assert.ok(done.matches.every(m => m.status === 'CONFIRMED'));
  assert.strictEqual(done.matches.length, 7);
  ok('8-player cup vs bots plays through all 3 rounds to a champion');

  // --- live updates ---
  console.log('Realtime');
  const ctl = new AbortController();
  const sse = await fetch(base + '/api/stream', { headers: { Authorization: 'Bearer ' + cap.token }, signal: ctl.signal });
  assert.strictEqual(sse.status, 200);
  assert.strictEqual((await fetch(base + '/api/stream')).status, 401);
  const reader = sse.body.getReader();
  const got = (async () => { let buf = ''; for (;;) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); if (buf.includes('"tid"')) return buf; } })();
  await api(p1.token, 'POST', '/api/tournaments', { title: 'Live Ping Cup', platform: 'PC', size: 4 });
  const msg = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event')), 3000))]);
  assert.ok(msg.includes('data: {"tid":"trn_'));
  ctl.abort();
  ok('authenticated live stream pushes change events; anonymous stream refused');

  // --- rate limiting (last: shares the login bucket) ---
  console.log('Abuse protection');
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) limited = (await api(null, 'POST', '/api/auth/login', { username: 'root', password: 'nope' + i })).status === 429;
  assert.ok(limited, 'login brute force should be rate limited');
  ok('login brute-force is rate limited (429)');

  console.log(`\nAll ${passed} test groups passed.`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
