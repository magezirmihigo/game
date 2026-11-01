// app.js — EFOOTBALL ARENA front end. Plain JS, no libraries. All user text goes through
// textContent (never innerHTML), so names/room codes can't inject markup.
(() => {
  'use strict';

  // ---------- tiny helpers ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, isErr ? 4500 : 2200);
  }

  // ---------- session + API ----------
  let token = null, me = null;
  try { token = localStorage.getItem('efa_token'); } catch {}
  function setSession(tok, user) {
    token = tok; me = user;
    try { tok ? localStorage.setItem('efa_token', tok) : localStorage.removeItem('efa_token'); } catch {}
  }
  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch {}
    if (r.status === 401 && token && !url.startsWith('/api/auth/')) { logoutLocal(); throw new Error('Please log in again'); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  // Run an action from a button: disables it, shows errors as a toast.
  async function act(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try { await fn(); if (okMsg) toast(okMsg); if (token) route(true); }   // refresh now; live updates cover everyone else
    catch (e) { toast(e.message, true); }
    finally { if (btn) btn.disabled = false; }
  }
  function logoutLocal() { stopStream(); setSession(null, null); route(); }

  // ---------- live updates ----------
  let streamCtl = null, liveOn = false, refreshTimer = null;
  function setLive(on) { liveOn = on; const d = $('#livedot'); if (d) d.className = 'pulse' + (on ? ' on' : ''); }
  function stopStream() { if (streamCtl) streamCtl.abort(); streamCtl = null; setLive(false); }
  async function startStream() {
    stopStream();
    if (!token) return;
    const ctl = new AbortController();
    streamCtl = ctl;
    try {
      const r = await fetch('/api/stream', { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
      if (!r.ok) throw new Error('stream');
      setLive(true);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(chunk);
          if (m) { try { onChange(JSON.parse(m[1])); } catch {} }
        }
      }
    } catch {}
    if (streamCtl === ctl) { setLive(false); streamCtl = null; if (token) setTimeout(startStream, 3000); }
  }
  function onChange(ev) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const r = parseRoute();
      if (r.name === 'lobby' || r.name === 'disputes' || (r.name === 't' && r.id === ev.tid)) route(true);
    }, 150);
  }

  // ---------- routing ----------
  function parseRoute() {
    const p = (location.hash.replace(/^#\/?/, '') || '').split('/');
    if (p[0] === 't' && p[1]) return { name: 't', id: p[1] };
    if (p[0] === 'disputes') return { name: 'disputes' };
    if (p[0] === 'me') return { name: 'me' };
    return { name: 'lobby' };
  }
  window.addEventListener('hashchange', () => route());

  // Re-rendering must not wipe what someone is typing: remember inputs marked data-keep.
  function snapshotInputs() {
    const vals = {}, a = document.activeElement;
    app.querySelectorAll('[data-keep]').forEach(el => { vals[el.dataset.keep] = el.value; });
    return { vals, focus: a && a.dataset && a.dataset.keep, pos: a && a.selectionStart };
  }
  function restoreInputs(s) {
    app.querySelectorAll('[data-keep]').forEach(el => { if (s.vals[el.dataset.keep] !== undefined) el.value = s.vals[el.dataset.keep]; });
    if (s.focus) { const el = app.querySelector(`[data-keep="${CSS.escape(s.focus)}"]`); if (el) { el.focus(); try { el.setSelectionRange(s.pos, s.pos); } catch {} } }
  }

  let routeSeq = 0;
  async function route(isRefresh) {
    const seq = ++routeSeq;
    renderTop();
    if (!token) { mount(authView(), isRefresh); return; }
    if (!me) {
      try { me = (await api('GET', '/api/me')).user; } catch { setSession(null, null); mount(authView(), isRefresh); return; }
      renderTop();
    }
    if (!streamCtl) startStream();      // also right after sign-up/login, when `me` is already set
    const r = parseRoute();
    let view;
    try {
      if (r.name === 'lobby') view = await lobbyView();
      else if (r.name === 't') view = await tournamentView(r.id);
      else if (r.name === 'disputes') view = await disputesView();
      else view = meView();
    } catch (e) {
      view = h('div', { class: 'empty' }, h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to lobby'));
    }
    if (seq !== routeSeq) return;     // a newer navigation won
    mount(view, isRefresh);
  }
  function mount(view, keepInputs) {
    const snap = keepInputs ? snapshotInputs() : null;
    const scroller = app.querySelector('.bracket');
    const sx = scroller ? scroller.scrollLeft : 0;
    app.replaceChildren(view);
    if (snap) restoreInputs(snap);
    const nb = app.querySelector('.bracket');
    if (nb && sx) nb.scrollLeft = sx;
    if (!keepInputs) { window.scrollTo(0, 0); }
  }

  function renderTop() {
    const r = parseRoute();
    const link = (href, label, name, cls) => h('a', { href, class: cls, 'aria-current': r.name === name ? 'page' : null }, label);
    $('#top').replaceChildren(...[
      h('a', { class: 'brand', href: '#/' }, 'eFootball ', h('b', {}, 'Arena')),
      token && me ? h('nav', { class: 'nav' },
        link('#/', 'Lobby', 'lobby', 'hide-sm'),
        link('#/disputes', 'Disputes', 'disputes'),
        link('#/me', me.name.length > 12 ? me.name.slice(0, 11) + '…' : me.name, 'me'),
        h('span', { id: 'livedot', class: 'pulse' + (liveOn ? ' on' : ''), title: 'Live updates', role: 'img', 'aria-label': liveOn ? 'Live updates connected' : 'Live updates offline' }),
      ) : null,
    ].filter(Boolean));
  }

  // ---------- auth ----------
  function authView() {
    let mode = 'login';
    const box = h('div', {});
    const draw = () => {
      const reg = mode === 'register';
      const err = h('p', { class: 'error', role: 'alert' });
      const user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', required: true, minlength: 3, maxlength: 20 });
      const pass = h('input', { id: 'p', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true, minlength: 6 });
      const name = h('input', { id: 'n', maxlength: 24, placeholder: 'Shown to other players' });
      const efid = h('input', { id: 'e', maxlength: 24, placeholder: 'Your in-game ID (optional)' });
      const submit = h('button', { class: 'primary', type: 'submit' }, reg ? 'Create account' : 'Log in');
      const form = h('form', {
        onsubmit: (ev) => {
          ev.preventDefault(); err.textContent = '';
          act(submit, async () => {
            try {
              const d = await api('POST', reg ? '/api/auth/register' : '/api/auth/login',
                reg ? { username: user.value, password: pass.value, displayName: name.value, efootballId: efid.value } : { username: user.value, password: pass.value });
              setSession(d.token, d.user);
              location.hash = '#/';
              route();
            } catch (e) { err.textContent = e.message; throw e; }
          });
        },
      },
        h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
        h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
        reg ? h('div', { class: 'field' }, h('label', { for: 'n' }, 'Display name'), name) : null,
        reg ? h('div', { class: 'field' }, h('label', { for: 'e' }, 'eFootball ID'), efid) : null,
        submit, err);
      box.replaceChildren(
        h('div', { class: 'tabs', role: 'tablist' },
          h('button', { role: 'tab', 'aria-selected': String(!reg), onclick: () => { mode = 'login'; draw(); } }, 'Log in'),
          h('button', { role: 'tab', 'aria-selected': String(reg), onclick: () => { mode = 'register'; draw(); } }, 'Sign up')),
        form);
      user.focus();
    };
    draw();
    return h('div', {},
      h('div', { class: 'hero' }, h('h1', {}, 'eFootball ', h('b', {}, 'Arena')), h('p', { class: 'muted' }, 'Knockout tournaments with your friends. Share room codes, confirm scores, settle disputes.')),
      h('div', { class: 'card auth' }, box),
      steps());
  }
  function steps() {
    return h('ol', { class: 'steps' },
      h('li', {}, h('b', {}, 'Create or join a cup'), '4, 8 or 16 players. The bracket is drawn at random when it starts.'),
      h('li', {}, h('b', {}, 'Host shares the room code'), 'Only the two players in a match can see the code.'),
      h('li', {}, h('b', {}, 'Both report the score'), 'Matching reports confirm the result and move the winner on.'),
      h('li', {}, h('b', {}, 'Disagree? Upload proof'), 'The organizer or admin reviews screenshots and rules.'));
  }

  // ---------- lobby ----------
  const when = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  async function lobbyView() {
    const { tournaments } = await api('GET', '/api/tournaments');
    const title = h('input', { id: 'ct', maxlength: 40, required: true, minlength: 3, placeholder: 'e.g. Kariakoo Friday Cup', 'data-keep': 'ct' });
    const plat = h('select', { id: 'cp' }, ['Mobile', 'PlayStation', 'PC'].map(p => h('option', { value: p }, p)));
    const size = h('select', { id: 'cs' }, [4, 8, 16].map(n => h('option', { value: n }, n + ' players')));
    const go = h('button', { class: 'primary', type: 'submit' }, 'Create cup');
    const create = h('details', { class: 'card create', open: tournaments.length === 0 },
      h('summary', {}, '+ New tournament'),
      h('form', {
        onsubmit: (ev) => {
          ev.preventDefault();
          act(go, async () => {
            const d = await api('POST', '/api/tournaments', { title: title.value, platform: plat.value, size: Number(size.value) });
            location.hash = '#/t/' + d.id;
          });
        },
      },
        h('div', { class: 'form-grid' },
          h('div', {}, h('label', { for: 'ct' }, 'Cup name'), title),
          h('div', {}, h('label', { for: 'cp' }, 'Platform'), plat),
          h('div', {}, h('label', { for: 'cs' }, 'Size'), size)),
        h('div', { class: 'gap' }, go)));
    const list = tournaments.length
      ? h('div', { class: 'grid gap' }, tournaments.map(t =>
        h('a', { class: 'card t-card', href: '#/t/' + t.id },
          h('div', { class: 'row' }, h('span', { class: 'badge ' + t.status.toLowerCase() }, t.status), h('span', { class: 'muted small' }, t.platform + ' · ' + when(t.createdAt))),
          h('h3', {}, t.title),
          h('div', { class: 'muted small' }, t.status === 'COMPLETE' && t.champion ? 'Champion: ' + t.champion : `${t.joinedCount}/${t.size} players · by ${t.organizer || '?'}`))))
      : h('div', { class: 'empty gap' }, h('p', {}, 'No tournaments yet. Create the first one above and invite your friends.'), steps());
    return h('div', {}, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Tournaments')), h('div', { class: 'gap' }, create), list);
  }

  // ---------- tournament ----------
  const STATUS_TEXT = { LOCKED: 'Waiting', AWAITING_CODE: 'Needs room code', IN_PROGRESS: 'Playing', DISPUTED: 'Disputed', CONFIRMED: 'Final' };
  async function tournamentView(id) {
    const { tournament: t } = await api('GET', '/api/tournaments/' + encodeURIComponent(id));
    const P = (pid) => (pid && t.people[pid] ? t.people[pid].name : null);
    const base = `/api/tournaments/${encodeURIComponent(t.id)}`;

    // header + organizer/player actions
    const actions = h('div', { class: 'row' });
    if (t.status === 'OPEN') {
      if (!t.joined && t.players.length < t.size) { const b = h('button', { class: 'primary' }, 'Join cup'); b.onclick = () => act(b, () => api('POST', base + '/join'), 'You are in!'); actions.append(b); }
      if (t.joined && !t.isOrganizer) { const b = h('button', {}, 'Leave'); b.onclick = () => act(b, () => api('POST', base + '/leave')); actions.append(b); }
    }
    if ((t.isOrganizer || me.role === 'admin') && t.status === 'OPEN') {
      const full = t.players.length >= t.size;
      const s = h('button', { class: full ? 'primary' : '', disabled: !full }, 'Start tournament');
      s.onclick = () => act(s, () => api('POST', base + '/start', {}));
      actions.append(s);
      if (!full) {
        const bots = h('button', {}, 'Fill with test bots & start');
        bots.onclick = () => { if (confirm('Empty slots become bots that play automatically. Good for testing alone.')) act(bots, () => api('POST', base + '/start', { fillBots: true })); };
        actions.append(bots);
      }
    }
    if ((t.isOrganizer || me.role === 'admin') && (t.status === 'OPEN' || t.status === 'LIVE')) {
      const c = h('button', { class: 'danger sm' }, 'Cancel cup');
      c.onclick = () => { if (confirm('Cancel this tournament for everyone?')) act(c, () => api('POST', base + '/cancel')); };
      actions.append(c);
    }

    const slots = [];
    for (let i = 0; i < t.size; i++) {
      const pid = t.players[i];
      slots.push(pid ? h('li', {}, P(pid), t.people[pid]?.isBot ? ' 🤖' : '', pid === t.organizerId ? ' ★' : '') : h('li', { class: 'slot' }, 'open slot'));
    }

    const rounds = [...new Set(t.matches.map(m => m.round))].sort((a, b) => a - b);
    const bracket = t.matches.length
      ? h('div', { class: 'bracket', tabindex: '0', 'aria-label': 'Bracket, scroll sideways' }, rounds.map(r => {
        const ms = t.matches.filter(m => m.round === r).sort((a, b) => a.index - b.index);
        return h('section', { class: 'round' }, h('h3', {}, ms[0].name), ms.map(m => matchCard(t, m, P, base)));
      }))
      : h('div', { class: 'empty gap' }, 'The bracket appears here when the organizer starts the tournament.');

    return h('div', {},
      h('p', {}, h('a', { href: '#/' }, '← All tournaments')),
      h('div', { class: 'head' },
        h('div', { class: 'grow' }, h('h2', {}, t.title),
          h('div', { class: 'row gap' }, h('span', { class: 'badge ' + t.status.toLowerCase() }, t.status), h('span', { class: 'muted' }, `${t.platform} · ${t.players.length}/${t.size} players`))),
        actions),
      t.champion ? h('div', { class: 'card champ' }, h('span', { class: 'muted small' }, '🏆 CHAMPION'), h('strong', {}, P(t.champion))) : null,
      t.status === 'OPEN' ? h('div', { class: 'card' }, h('h3', {}, 'Players'), h('ul', { class: 'players' }, slots),
        h('p', { class: 'note' }, t.joined ? 'Share this page link with friends so they can join.' : 'Join to get a spot in the bracket.')) : null,
      bracket,
      h('details', { class: 'log' }, h('summary', {}, 'Activity'), h('ul', {}, t.log.map(l => h('li', {}, h('time', {}, new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), l.message)))));
  }

  function matchCard(t, m, P, base) {
    const mine = m.a === me.id || m.b === me.id;
    const url = `${base}/matches/${encodeURIComponent(m.id)}`;
    const side = (pid, score) => {
      const nm = P(pid);
      return h('div', { class: 'side' + (m.winner && m.winner === pid ? ' won' : '') + (nm ? '' : ' tbd') },
        h('span', { class: 'nm' }, nm || 'To be decided'),
        pid && t.people[pid].efootballId ? h('span', { class: 'id' }, t.people[pid].efootballId) : null,
        h('span', { class: 'sc' }, score == null ? '–' : score));
    };
    const card = h('article', { class: 'match s-' + m.status.toLowerCase() + (mine ? ' mine' : '') },
      h('div', { class: 'mhead' }, h('span', {}, m.id), h('span', { class: 'badge ' + m.status.toLowerCase() }, STATUS_TEXT[m.status])),
      side(m.a, m.scoreA), side(m.b, m.scoreB));
    if (t.status !== 'LIVE' && t.status !== 'COMPLETE') return card;
    const body = h('div', { class: 'actions' });
    const hostName = P(m.a);
    const open = m.status === 'AWAITING_CODE' || m.status === 'IN_PROGRESS' || m.status === 'DISPUTED';

    if (m.status === 'AWAITING_CODE') {
      if (m.a === me.id) {
        const inp = h('input', { maxlength: 32, placeholder: 'eFootball room code', 'data-keep': 'code-' + m.id, 'aria-label': 'Room code' });
        const b = h('button', { class: 'primary' }, 'Share code');
        b.onclick = () => act(b, () => api('POST', url + '/room-code', { roomCode: inp.value }), 'Code shared');
        body.append(h('p', { class: 'note' }, 'You are the host. Create the room in eFootball, then paste its code:'), h('div', { class: 'inline' }, h('div', { class: 'grow' }, inp), b));
      } else if (mine) body.append(h('p', { class: 'note' }, `Waiting for ${hostName} (host) to share the room code.`));
    }

    if (m.roomCode && open) {
      const copy = h('button', { class: 'sm' }, m.roomCode === '••••' ? '' : 'Copy');
      copy.onclick = async () => { try { await navigator.clipboard.writeText(m.roomCode); toast('Copied'); } catch { toast('Copy failed', true); } };
      body.append(h('div', { class: 'room' }, h('span', { class: 'small muted' }, 'ROOM'), h('code', {}, m.roomCode), m.roomCode === '••••' ? null : copy));
    }

    if (mine && (m.status === 'IN_PROGRESS' || m.status === 'DISPUTED')) {
      const opp = P(m.a === me.id ? m.b : m.a);
      const my = h('input', { class: 'score', type: 'number', inputmode: 'numeric', min: 0, max: 99, 'data-keep': 'my-' + m.id, 'aria-label': 'Your score' });
      const ot = h('input', { class: 'score', type: 'number', inputmode: 'numeric', min: 0, max: 99, 'data-keep': 'op-' + m.id, 'aria-label': opp + ' score' });
      const b = h('button', { class: 'primary' }, m.iReported ? 'Update my report' : 'Submit final score');
      b.onclick = () => act(b, () => api('POST', url + '/report', { myScore: my.value === '' ? '' : Number(my.value), oppScore: ot.value === '' ? '' : Number(ot.value) }), 'Score sent');
      body.append(
        h('p', { class: 'note' }, m.status === 'DISPUTED' ? 'Scores did not match. Re-check, correct your report, and upload a screenshot.' : 'When the match ends, both players enter the final score (include extra time/penalties — no draws).'),
        h('div', { class: 'scoreform' }, h('div', {}, h('label', {}, 'You'), my), h('span', { class: 'dash' }, '–'), h('div', {}, h('label', {}, opp), ot), b),
        m.iReported ? h('p', { class: 'note' }, m.opponentReported ? 'Both reported.' : `Your report is in. Waiting for ${opp}.`) : (m.opponentReported ? h('p', { class: 'note' }, `${opp} already reported. Enter yours.`) : null));
      body.append(proofUploader(url, m));
    }

    if (m.status === 'DISPUTED' && m.reports) {
      const line = (who, r) => h('p', {}, who + ' says: ', r ? `${P(m.a)} ${r.a} – ${r.b} ${P(m.b)}` : 'no report');
      body.append(h('div', { class: 'dispute' }, h('strong', {}, 'Dispute'), line(P(m.a), m.reports.a), line(P(m.b), m.reports.b)));
    }
    if (m.evidence && m.evidence.length) {
      m.evidence.forEach(uid => {
        const b = h('button', { class: 'sm ghost' }, 'View proof from ' + (t.people[uid] ? t.people[uid].name : 'player'));
        b.onclick = () => act(b, () => showProof(`${url}/evidence/${encodeURIComponent(uid)}`));
        body.append(b);
      });
    }

    if (m.canJudge && (m.status === 'DISPUTED' || m.status === 'IN_PROGRESS' || m.status === 'AWAITING_CODE') && m.a && m.b) {
      const sa = h('input', { class: 'score', type: 'number', inputmode: 'numeric', min: 0, max: 99, 'data-keep': 'ja-' + m.id, 'aria-label': P(m.a) + ' final score' });
      const sb = h('input', { class: 'score', type: 'number', inputmode: 'numeric', min: 0, max: 99, 'data-keep': 'jb-' + m.id, 'aria-label': P(m.b) + ' final score' });
      const rb = h('button', {}, 'Rule');
      rb.onclick = () => act(rb, () => api('POST', url + '/resolve', { scoreA: sa.value === '' ? '' : Number(sa.value), scoreB: sb.value === '' ? '' : Number(sb.value) }), 'Ruling saved');
      const fa = h('button', { class: 'danger sm' }, `${P(m.a)} no-show`);
      fa.onclick = () => { if (confirm(`Award the win to ${P(m.b)}?`)) act(fa, () => api('POST', url + '/forfeit', { loserId: m.a })); };
      const fb = h('button', { class: 'danger sm' }, `${P(m.b)} no-show`);
      fb.onclick = () => { if (confirm(`Award the win to ${P(m.a)}?`)) act(fb, () => api('POST', url + '/forfeit', { loserId: m.b })); };
      body.append(h('details', {}, h('summary', { class: 'small muted' }, 'Judge tools'),
        h('div', { class: 'scoreform gap' }, h('div', {}, h('label', {}, P(m.a)), sa), h('span', { class: 'dash' }, '–'), h('div', {}, h('label', {}, P(m.b)), sb), rb),
        h('div', { class: 'row gap' }, fa, fb)));
    }

    if (m.status === 'CONFIRMED' && m.decidedBy && m.decidedBy !== 'players') body.append(h('p', { class: 'note' }, m.decidedBy === 'forfeit' ? 'Decided by forfeit.' : 'Decided by ruling.'));
    if (body.childNodes.length) card.append(body);
    return card;
  }

  // Phone screenshots are big: shrink to ≤1280px JPEG in the browser before upload.
  function proofUploader(url, m) {
    const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Upload proof screenshot' });
    f.onchange = () => {
      const file = f.files[0];
      if (!file) return;
      act(null, async () => {
        const dataUrl = await shrink(file);
        await api('POST', url + '/evidence', { image: dataUrl });
        f.value = '';
      }, 'Proof uploaded');
    };
    return h('div', {}, h('label', {}, 'Proof screenshot'), f);
  }
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('That file is not a readable image')); };
      img.src = u;
    });
  }
  async function showProof(url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Could not load proof');
    const obj = URL.createObjectURL(await r.blob());
    const modal = $('#modal');
    const close = () => { modal.hidden = true; modal.replaceChildren(); URL.revokeObjectURL(obj); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.onclick = (e) => { if (e.target === modal) close(); };
    const btn = h('button', { onclick: close }, 'Close');
    modal.replaceChildren(h('div', { class: 'box', role: 'dialog', 'aria-label': 'Proof screenshot' }, h('img', { src: obj, alt: 'Proof screenshot uploaded by a player' }), btn));
    modal.hidden = false;
    btn.focus();
  }

  // ---------- disputes inbox ----------
  async function disputesView() {
    const { disputes } = await api('GET', '/api/disputes');
    return h('div', {}, h('h2', {}, 'Disputes'),
      h('p', { class: 'muted' }, me.role === 'admin' ? 'All open disputes on this server.' : 'Open disputes in tournaments you organize.'),
      disputes.length ? disputes.map(d => h('a', { class: 'card t-card', href: '#/t/' + d.tid },
        h('span', { class: 'badge disputed' }, 'Disputed'), h('h3', {}, `${d.a ? d.a.name : '?'} vs ${d.b ? d.b.name : '?'}`),
        h('div', { class: 'muted small' }, `${d.title} · ${d.name}${d.canJudge ? '' : ' · you are playing, an admin must rule'}`)))
        : h('div', { class: 'empty gap' }, 'No open disputes.'));
  }

  // ---------- profile ----------
  function meView() {
    const name = h('input', { id: 'dn', value: me.name, maxlength: 24 });
    const efid = h('input', { id: 'ei', value: me.efootballId, maxlength: 24 });
    const save = h('button', { class: 'primary', type: 'submit' }, 'Save');
    const out = h('button', { class: 'danger' }, 'Log out');
    out.onclick = () => act(out, async () => { try { await api('POST', '/api/auth/logout'); } catch {} logoutLocal(); });
    return h('div', {}, h('h2', {}, 'Your profile'),
      h('form', {
        class: 'card gap',
        onsubmit: (ev) => { ev.preventDefault(); act(save, async () => { me = (await api('PATCH', '/api/me', { displayName: name.value, efootballId: efid.value })).user; renderTop(); }, 'Saved'); },
      },
        h('p', { class: 'muted' }, `@${me.username} · ${me.role === 'admin' ? 'Admin' : 'Player'}`),
        h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Display name'), name),
        h('div', { class: 'field' }, h('label', { for: 'ei' }, 'eFootball ID'), efid),
        h('div', { class: 'row' }, save, out)));
  }

  route();
})();
