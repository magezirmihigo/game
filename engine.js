// engine.js — pure tournament logic (no HTTP). Single-elimination for 4, 8 or 16 players.
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

const rid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const ROUND_NAMES = { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals', 16: 'Round of 16' };
const SIZES = [4, 8, 16];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function log(t, message) {
  t.log.unshift({ at: Date.now(), message });
  if (t.log.length > 100) t.log.length = 100;
}

function newTournament({ title, platform, size, organizerId }) {
  return {
    id: rid('trn'),
    title, platform, size,
    organizerId,
    status: 'OPEN',            // OPEN -> LIVE -> COMPLETE (or CANCELLED)
    players: [organizerId],
    matches: [],
    champion: null,
    createdAt: Date.now(),
    log: [],
  };
}

function buildBracket(t) {
  const order = shuffle(t.players);
  const rounds = Math.log2(t.size);
  const matches = [];
  for (let r = 1; r <= rounds; r++) {
    const count = t.size / 2 ** r;
    for (let i = 0; i < count; i++) {
      matches.push({
        id: `r${r}m${i + 1}`, round: r, index: i,
        name: ROUND_NAMES[count * 2],
        a: null, b: null,
        status: 'LOCKED',      // LOCKED, AWAITING_CODE, IN_PROGRESS, CONFIRMED, DISPUTED
        roomCode: null,
        reports: { a: null, b: null },
        scoreA: null, scoreB: null,
        winner: null,
        decidedBy: null,       // 'players' | 'admin' | 'forfeit'
        evidence: {},
      });
    }
  }
  matches.filter(m => m.round === 1).forEach((m, i) => {
    m.a = order[i * 2];
    m.b = order[i * 2 + 1];
    m.status = 'AWAITING_CODE';
  });
  t.matches = matches;
}

function getMatch(t, matchId) {
  const m = t.matches.find(x => x.id === matchId);
  if (!m) fail(404, 'Match not found');
  return m;
}

function advance(t, m) {
  const next = t.matches.find(x => x.round === m.round + 1 && x.index === Math.floor(m.index / 2));
  if (!next) {
    t.status = 'COMPLETE';
    t.champion = m.winner;
    log(t, `Tournament complete. Champion decided.`);
    return;
  }
  next[m.index % 2 === 0 ? 'a' : 'b'] = m.winner;
  if (next.a && next.b) {
    next.status = 'AWAITING_CODE';
    log(t, `${next.name} match unlocked.`);
  }
}

function decide(t, m, scoreA, scoreB, decidedBy) {
  if (scoreA === scoreB) fail(400, 'A knockout match needs a winner');
  m.scoreA = scoreA;
  m.scoreB = scoreB;
  m.winner = scoreA > scoreB ? m.a : m.b;
  m.status = 'CONFIRMED';
  m.decidedBy = decidedBy;
  advance(t, m);
}

const isPlayerOf = (m, uid) => m.a === uid || m.b === uid;

function setRoomCode(t, m, userId, code) {
  if (t.status !== 'LIVE') fail(409, 'Tournament is not live');
  if (m.a !== userId) fail(403, 'Only the host (first player) can set the room code');
  if (m.status !== 'AWAITING_CODE' && m.status !== 'IN_PROGRESS') fail(409, 'Match is not open');
  if (m.reports.a || m.reports.b) fail(409, 'Scores already reported');
  m.roomCode = code;
  m.status = 'IN_PROGRESS';
  log(t, `${m.name} ${m.id}: room code shared.`);
}

// myScore/oppScore are from the reporter's own point of view.
function reportScore(t, m, userId, myScore, oppScore) {
  if (t.status !== 'LIVE') fail(409, 'Tournament is not live');
  if (!isPlayerOf(m, userId)) fail(403, 'You are not in this match');
  if (m.status !== 'IN_PROGRESS' && m.status !== 'DISPUTED') {
    fail(409, m.status === 'AWAITING_CODE' ? 'Host must share the room code first' : 'Match is not accepting scores');
  }
  if (m.decidedBy) fail(409, 'Match already decided');
  if (myScore === oppScore) fail(400, 'No draws: enter the final score including extra time or penalties (winner must be higher)');
  const side = m.a === userId ? 'a' : 'b';
  const norm = side === 'a' ? { a: myScore, b: oppScore } : { a: oppScore, b: myScore };
  m.reports[side] = norm;
  const other = m.reports[side === 'a' ? 'b' : 'a'];
  if (!other) { log(t, `${m.name} ${m.id}: one score reported, waiting for opponent.`); return; }
  if (other.a === norm.a && other.b === norm.b) {
    decide(t, m, norm.a, norm.b, 'players');
    log(t, `${m.name} ${m.id}: scores match, result confirmed (${norm.a}-${norm.b}).`);
  } else {
    m.status = 'DISPUTED';
    log(t, `${m.name} ${m.id}: scores do not match, dispute opened.`);
  }
}

// Reporter may re-submit while still waiting; once both reported and disputed they can correct.
function canJudge(t, m, user) {
  if (user.role === 'admin') return true;
  return t.organizerId === user.id && !isPlayerOf(m, user.id);
}

function resolveDispute(t, m, user, scoreA, scoreB) {
  if (!canJudge(t, m, user)) fail(403, 'Only an admin or an uninvolved organizer can rule on this match');
  if (m.status !== 'DISPUTED' && m.status !== 'IN_PROGRESS') fail(409, 'Match has nothing to resolve');
  decide(t, m, scoreA, scoreB, 'admin');
  log(t, `${m.name} ${m.id}: ruled by ${user.role === 'admin' ? 'admin' : 'organizer'} (${scoreA}-${scoreB}).`);
}

function forfeit(t, m, user, loserId) {
  if (!canJudge(t, m, user)) fail(403, 'Only an admin or an uninvolved organizer can forfeit a player');
  if (!isPlayerOf(m, loserId)) fail(400, 'That player is not in this match');
  if (m.status === 'LOCKED' || m.status === 'CONFIRMED') fail(409, 'Match is not open');
  const loserIsA = m.a === loserId;
  decide(t, m, loserIsA ? 0 : 3, loserIsA ? 3 : 0, 'forfeit');
  m.decidedBy = 'forfeit';
  log(t, `${m.name} ${m.id}: forfeit awarded.`);
}

// ---- Bots (for solo testing). Bots share codes and report honestly. ----
function runBots(t, isBot) {
  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const m of t.matches) {
      if (t.status !== 'LIVE') return;
      if (m.status === 'AWAITING_CODE' && m.a && isBot(m.a)) {
        setRoomCode(t, m, m.a, 'BOT-' + crypto.randomInt(1000, 9999));
        changed = true;
      }
      if (m.status === 'IN_PROGRESS' && !m.decidedBy) {
        const bothBots = isBot(m.a) && isBot(m.b);
        if (bothBots) {
          let x = crypto.randomInt(0, 5), y = crypto.randomInt(0, 5);
          if (x === y) x++;
          reportScore(t, m, m.a, x, y);
          reportScore(t, m, m.b, y, x);
          changed = true;
          continue;
        }
        for (const [side, other] of [['a', 'b'], ['b', 'a']]) {
          const botId = m[side];
          if (isBot(botId) && !m.reports[side] && m.reports[other]) {
            const r = m.reports[other];            // normalized {a,b}
            const mine = side === 'a' ? r.a : r.b;
            const theirs = side === 'a' ? r.b : r.a;
            reportScore(t, m, botId, mine, theirs);
            changed = true;
          }
        }
      }
    }
  }
}

module.exports = {
  HttpError, fail, rid, SIZES, log, newTournament, buildBracket, getMatch,
  setRoomCode, reportScore, resolveDispute, forfeit, runBots, isPlayerOf, canJudge,
};
