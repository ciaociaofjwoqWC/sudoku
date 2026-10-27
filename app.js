(() => {
'use strict';
const $ = id => document.getElementById(id);
const DIFFS = [
  { k: 'facile', n: 'Facile', clues: 40 },
  { k: 'media', n: 'Media', clues: 34 },
  { k: 'difficile', n: 'Difficile', clues: 30 },
  { k: 'esperta', n: 'Esperta', clues: 27 },
  { k: 'master', n: 'Master', clues: 24 },
];
const diffName = k => (DIFFS.find(d => d.k === k) || DIFFS[1]).n;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ---------- Sudoku engine ---------- */
const R = [], C = [], B = [], PEERS = [];
for (let i = 0; i < 81; i++) { R[i] = i / 9 | 0; C[i] = i % 9; B[i] = (R[i] / 3 | 0) * 3 + (C[i] / 3 | 0); }
for (let i = 0; i < 81; i++) {
  PEERS[i] = [];
  for (let j = 0; j < 81; j++) if (j !== i && (R[j] === R[i] || C[j] === C[i] || B[j] === B[i])) PEERS[i].push(j);
}
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bits = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };

// Counts solutions up to `limit`; with rand it fills g with a random solution.
function solve(g, limit, rand) {
  const rows = new Int16Array(9), cols = new Int16Array(9), boxes = new Int16Array(9);
  for (let i = 0; i < 81; i++) if (g[i]) {
    const b = 1 << g[i];
    if ((rows[R[i]] | cols[C[i]] | boxes[B[i]]) & b) return 0;
    rows[R[i]] |= b; cols[C[i]] |= b; boxes[B[i]] |= b;
  }
  let count = 0;
  const rec = () => {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) if (!g[i]) {
      const m = ~(rows[R[i]] | cols[C[i]] | boxes[B[i]]) & 0x3fe, n = bits(m);
      if (n < bestN) { best = i; bestMask = m; bestN = n; if (n < 2) break; }
    }
    if (best < 0) return ++count >= limit;
    if (bestN === 0) return false;
    const ds = []; for (let d = 1; d <= 9; d++) if (bestMask & (1 << d)) ds.push(d);
    if (rand) shuffle(ds);
    const r = R[best], c = C[best], x = B[best];
    for (const d of ds) {
      const b = 1 << d;
      g[best] = d; rows[r] |= b; cols[c] |= b; boxes[x] |= b;
      if (rec()) return true;
      g[best] = 0; rows[r] &= ~b; cols[c] &= ~b; boxes[x] &= ~b;
    }
    return false;
  };
  rec();
  return count;
}
function generate(diffKey) {
  const target = (DIFFS.find(d => d.k === diffKey) || DIFFS[1]).clues;
  const sol = new Int8Array(81); solve(sol, 1, true);
  const puz = Int8Array.from(sol);
  let n = 81;
  const tryRemove = cells => {
    const old = cells.map(i => puz[i]);
    cells.forEach(i => puz[i] = 0);
    if (solve(Int8Array.from(puz), 2, false) === 1) { n -= cells.length; return true; }
    cells.forEach((i, k) => puz[i] = old[k]);
    return false;
  };
  for (const i of shuffle([...Array(41).keys()])) { if (n <= target) break; tryRemove(i === 40 ? [40] : [i, 80 - i]); }
  for (const i of shuffle([...Array(81).keys()])) { if (n <= target) break; if (puz[i]) tryRemove([i]); }
  return { puzzle: Array.from(puz).join(''), solution: Array.from(sol).join('') };
}

/* ---------- Firebase (online games) ----------
 * games/<id>: meta {diff, maxErr, puzzle, solution, host, created}, seats {p1, p2},
 * startAt, next, players/<uid> {name, vals, notes, err, filled, out, outAt, doneAt}.
 * Nobody can list games: you need the id from the link. Rules in database.rules.json. */
let offset = 0;
const sNow = () => Date.now() + offset;
let fb = null;
async function fbInit() {
  if (fb) return fb;
  if (!window.firebase || !window.FIREBASE_CONFIG) throw { error: 'offline' };
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    const auth = firebase.auth();
    const user = auth.currentUser || (await auth.signInAnonymously()).user;
    const db = firebase.database();
    db.ref('.info/serverTimeOffset').on('value', s => { offset = s.val() || 0; });
    fb = { db, uid: user.uid };
    return fb;
  } catch { throw { error: 'offline' }; }
}
const TS = () => firebase.database.ServerValue.TIMESTAMP;
const gref = (id, path) => fb.db.ref('games/' + id + (path ? '/' + path : ''));
const ID_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const newId = () => { const a = new Uint32Array(10); crypto.getRandomValues(a); return [...a].map(n => ID_ABC[n % ID_ABC.length]).join(''); };

// Turns the raw game node into what the screens need, from this player's side.
function derive(id, g) {
  const meta = g.meta || {}, seats = g.seats || {}, players = g.players || {};
  const uid = fb.uid;
  const seated = seats.p1 === uid || seats.p2 === uid;
  const oppUid = seated ? (seats.p1 === uid ? seats.p2 : seats.p1) : seats.p1;
  const pub = (p, full) => {
    if (!p) return null;
    const o = { name: p.name || 'Giocatore', filled: p.filled || 0, err: p.err || 0, out: !!p.out,
      doneMs: p.doneAt && g.startAt ? Math.max(0, p.doneAt - g.startAt) : null,
      vals: p.vals || meta.puzzle };
    if (full) o.notes = p.notes || '00'.repeat(81);
    return o;
  };
  // The first decisive event wins: finishing the grid, or hitting the error limit.
  let winner = null, reason = null;
  const events = [];
  for (const u of [seats.p1, seats.p2]) {
    const p = u && players[u]; if (!p) continue;
    if (p.doneAt) events.push({ t: p.doneAt, u, kind: 'done' });
    if (p.outAt) events.push({ t: p.outAt, u, kind: 'err' });
  }
  events.sort((a, b) => a.t - b.t);
  if (events.length) {
    const e = events[0];
    const winUid = e.kind === 'done' ? e.u : (e.u === seats.p1 ? seats.p2 : seats.p1);
    winner = winUid === uid ? 'me' : 'opp'; reason = e.kind;
  }
  let status = 'waiting';
  if (seats.p2 && g.startAt) status = winner ? 'done' : 'playing';
  return {
    id, diff: meta.diff, maxErr: meta.maxErr || 0, puzzle: meta.puzzle, solution: meta.solution,
    status, startAt: g.startAt || null, next: g.next || null, full: !!seats.p2,
    me: seated ? pub(players[uid] || { name: nick() }, true) : null,
    opp: pub(oppUid && players[oppUid], false),
    winner: seated ? winner : null, reason,
  };
}
async function fetchGame(id) {
  await fbInit();
  const snap = await gref(id).once('value');
  if (!snap.exists() || !snap.val().meta) throw { error: 'not_found' };
  return derive(id, snap.val());
}
const freshPlayer = puzzle => ({ name: nick(), vals: puzzle, notes: '00'.repeat(81), err: 0, filled: 0, out: false });
async function createGame(diff, maxErr) {
  await fbInit();
  const g = generate(diff), id = newId();
  await gref(id, 'meta').set({ diff, maxErr, puzzle: g.puzzle, solution: g.solution, host: fb.uid, created: TS() });
  await gref(id, 'seats/p1').set(fb.uid);
  await gref(id, 'players/' + fb.uid).set(freshPlayer(g.puzzle));
  return id;
}
async function joinGame(id) {
  const d = await fetchGame(id);
  if (d.me) return d;
  const res = await gref(id, 'seats/p2').transaction(cur => (cur ? undefined : fb.uid));
  if (!res.committed && res.snapshot.val() !== fb.uid) throw { error: 'full' };
  await gref(id, 'players/' + fb.uid).set(freshPlayer(d.puzzle));
  await gref(id, 'startAt').set(Math.round(sNow()) + 4000).catch(() => {});
  return fetchGame(id);
}
const ERRORS = {
  not_found: 'Questa partita non esiste più.',
  full: 'Questa partita ha già due giocatori.',
  offline: 'Non riesco a collegarmi: controlla la connessione e riprova.',
};
const errMsg = e => ERRORS[e?.error] || 'Qualcosa non ha funzionato. Riprova tra poco.';

/* ---------- State ---------- */
const S = {
  mode: null, id: null, diff: 'media', maxErr: 3, game: null,
  puzzle: [], solution: [], given: [], vals: [], notes: [],
  err: 0, out: false, doneLocal: false, sel: -1, notesMode: false, undo: [], popAt: -1,
  outcome: null, frozenMs: null, viewBoard: false,
  // solo only
  hints: 3, base: 0, resumedAt: 0, doneMs: null,
};
let createDiff = ls.get('sv-diff') || 'media';
let createErr = ls.get('sv-err') !== '0';

/* ---------- UI build ---------- */
const boardEl = $('board'), cells = [], noteEls = [], valEls = [];
for (let i = 0; i < 81; i++) {
  const el = document.createElement('div');
  el.className = `cell r${R[i]} c${C[i]}`;
  el.setAttribute('role', 'gridcell');
  const v = document.createElement('span'); v.className = 'v';
  const ns = document.createElement('div'); ns.className = 'notes';
  const arr = [];
  for (let d = 1; d <= 9; d++) { const s = document.createElement('span'); ns.appendChild(s); arr.push(s); }
  el.append(v, ns);
  el.addEventListener('pointerdown', e => { e.preventDefault(); select(i); });
  boardEl.appendChild(el); cells.push(el); valEls.push(v); noteEls.push(arr);
}
const numBtns = [];
for (let d = 1; d <= 9; d++) {
  const b = document.createElement('button');
  b.className = 'num'; b.innerHTML = `<b>${d}</b><small></small>`;
  b.setAttribute('aria-label', 'Numero ' + d);
  b.addEventListener('click', () => place(d));
  $('numpad').appendChild(b); numBtns.push(b);
}
for (const d of DIFFS) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = d.n; b.dataset.k = d.k;
  b.addEventListener('click', () => { createDiff = d.k; ls.set('sv-diff', d.k); renderChips(); });
  $('diffs').appendChild(b);
}
function renderChips() {
  for (const b of $('diffs').children) b.setAttribute('aria-pressed', String(b.dataset.k === createDiff));
  $('errSw').setAttribute('aria-checked', String(createErr));
}
$('errSw').addEventListener('click', () => { createErr = !createErr; ls.set('sv-err', createErr ? '1' : '0'); renderChips(); });
renderChips();

$('nick').value = ls.get('sv-nick') || '';
$('nick').addEventListener('input', () => { ls.set('sv-nick', $('nick').value.trim()); $('inviteNick').value = $('nick').value; });
$('inviteNick').addEventListener('input', () => { ls.set('sv-nick', $('inviteNick').value.trim()); $('nick').value = $('inviteNick').value; });
const nick = () => (ls.get('sv-nick') || $('nick').value || '').trim() || 'Giocatore';

let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500);
}
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gameUrl = id => location.origin + location.pathname + '?g=' + id;
const setUrl = id => { try { history.replaceState(null, '', '?g=' + id); } catch {} };
const clearUrl = () => { try { history.replaceState(null, '', location.pathname); } catch {} };

/* ---------- Rendering ---------- */
const emptiesCount = () => S.given.filter(g => !g).length;
const filledCount = () => { let n = 0; for (let i = 0; i < 81; i++) if (!S.given[i] && S.vals[i] === S.solution[i]) n++; return n; };

// Online, the puzzle stays hidden (both grids) until the countdown ends.
function started() {
  if (S.mode !== 'online') return true;
  const g = S.game;
  return !!(g && g.status !== 'waiting' && g.startAt && sNow() >= g.startAt);
}
function renderBoard() {
  boardEl.classList.toggle('hide', !started());
  const sel = S.sel, sv = sel >= 0 ? S.vals[sel] : 0;
  // After the game, "Guarda la soluzione" fills every missing or wrong cell with the answer.
  const showSol = !!(S.outcome && S.viewBoard);
  const conflict = new Set();
  if (!showSol) for (let i = 0; i < 81; i++) {
    const v = S.vals[i];
    if (v && !S.given[i] && v !== S.solution[i]) for (const p of PEERS[i]) if (S.vals[p] === v) conflict.add(p);
  }
  for (let i = 0; i < 81; i++) {
    const el = cells[i], given = S.given[i];
    const solved = showSol && !given && S.vals[i] !== S.solution[i];
    const v = solved ? S.solution[i] : S.vals[i];
    const wrong = !!v && !given && v !== S.solution[i];
    el.classList.toggle('solv', solved);
    const peer = sel >= 0 && i !== sel && (R[i] === R[sel] || C[i] === C[sel] || B[i] === B[sel]);
    el.classList.toggle('user', !!v && !given && !wrong);
    el.classList.toggle('wrong', wrong);
    el.classList.toggle('conflict', conflict.has(i));
    el.classList.toggle('sel', i === sel);
    el.classList.toggle('peer', peer);
    el.classList.toggle('same', !!sv && v === sv && i !== sel);
    el.classList.toggle('pop', i === S.popAt);
    valEls[i].textContent = v || '';
    const nm = v ? 0 : S.notes[i];
    for (let d = 1; d <= 9; d++) {
      const s = noteEls[i][d - 1], on = !!(nm & (1 << d));
      s.textContent = on ? d : '';
      s.classList.toggle('hl', on && d === sv);
    }
  }
  S.popAt = -1;
  const placed = Array(10).fill(0);
  for (let i = 0; i < 81; i++) if (S.vals[i] && S.vals[i] === S.solution[i]) placed[S.vals[i]]++;
  numBtns.forEach((b, k) => {
    const left = 9 - placed[k + 1];
    b.classList.toggle('gone', left <= 0);
    b.querySelector('small').textContent = left;
  });
  $('numpad').classList.toggle('pencil', S.notesMode);
  $('notesBtn').setAttribute('aria-pressed', String(S.notesMode));
  $('notesBadge').textContent = S.notesMode ? 'ON' : 'OFF';
  $('hintBadge').textContent = S.hints;
}

function errHtml(e) {
  const cls = e ? 'e' : '';
  return S.maxErr ? `Errori <span class="${cls}">${e}/${S.maxErr}</span>` : `Errori <span class="${cls}">${e}</span>`;
}
function renderVs() {
  const tot = emptiesCount() || 1;
  const mine = filledCount();
  const solo = S.mode === 'solo';
  const meName = $('meName'); meName.textContent = solo ? 'Partita singola' : nick() + ' ';
  if (!solo) { const sm = document.createElement('small'); sm.textContent = '(tu)'; meName.append(sm); }
  $('meBar').style.width = (mine / tot * 100) + '%';
  $('meStat').innerHTML = `${Math.round(mine / tot * 100)}% · ${errHtml(S.err)}`;
  $('vs').classList.toggle('solo', solo);
  $('vs').classList.toggle('duel', !solo);
  $('vsMid').hidden = solo; $('oppBox').hidden = solo; $('oppMini').hidden = solo;
  if (solo) return;
  const opp = S.game?.opp;
  renderMini(opp ? opp.vals : null, !started());
  if (!opp) { $('oppName').textContent = 'In attesa…'; $('oppBar').style.width = '0'; $('oppStat').textContent = 'Nessun avversario'; return; }
  $('oppName').textContent = opp.name || 'Avversario';
  const pct = Math.min(100, opp.filled / tot * 100);
  $('oppBar').style.width = pct + '%';
  $('oppStat').innerHTML = `${Math.round(pct)}% · ${errHtml(opp.err || 0)}`;
}

// The opponent's grid: givens readable, their correct entries covered; wrong ones stay empty.
// It stays blank until the countdown ends, so the puzzle isn't visible early.
const miniCells = [];
for (let i = 0; i < 81; i++) {
  const c = document.createElement('i');
  c.className = `r${R[i]} c${C[i]}`;
  $('oppMini').appendChild(c); miniCells.push(c);
}
function renderMini(vals, blank) {
  for (let i = 0; i < 81; i++) {
    const c = miniCells[i], given = S.given[i];
    const v = blank || given || !vals ? 0 : +vals[i];
    c.textContent = given && !blank ? S.puzzle[i] : '';
    c.classList.toggle('f', !!v && v === S.solution[i]);
  }
}

function renderTitle() {
  const t = $('gTitle'); t.textContent = '';
  const b = document.createElement('b'); b.textContent = diffName(S.diff);
  t.append(b, S.mode === 'solo' ? ' · Da solo' : ' · Sfida');
  $('shareBtn').hidden = S.mode !== 'online';
  $('hintBtn').hidden = S.mode !== 'solo';
}

function renderOverlay() {
  const ov = $('overlay');
  let html = '';
  const g = S.game;
  if (S.outcome && !S.viewBoard) {
    const o = S.outcome;
    const oppName = esc(g?.opp?.name || 'Il tuo avversario');
    let title, msg;
    if (S.mode === 'solo') {
      title = o.win ? 'Completato!' : 'Troppi errori';
      msg = o.win ? `Tempo: <b>${fmt(S.doneMs)}</b> · Errori: ${S.err}` : `Hai fatto ${S.err} errori. Riprova con uno schema nuovo.`;
    } else if (o.win) {
      title = 'Hai vinto!';
      msg = o.reason === 'err' ? `${oppName} ha fatto troppi errori.` : `Hai finito in <b>${fmt(g.me?.doneMs || 0)}</b>.`;
    } else {
      title = 'Hai perso';
      msg = o.reason === 'err' ? 'Hai raggiunto il limite di errori.' : `${oppName} ha finito in <b>${fmt(g.opp?.doneMs || 0)}</b>.`;
    }
    const nextLbl = S.mode === 'solo' ? 'Nuovo schema' : (g?.next ? 'Entra nella rivincita' : 'Rivincita');
    html = `<div class="ov result ${o.win ? 'win' : 'lose'}"><h3>${title}</h3><p>${msg}</p><div class="btns"><button class="btn" data-act="again">${nextLbl}</button><button class="btn ghost" data-act="view">Guarda la soluzione</button></div></div>`;
  } else if (S.outcome) {
    html = '';
  } else if (S.mode === 'online' && (S.doneLocal || S.out)) {
    html = `<div class="ov"><h3>${S.doneLocal ? 'Completato!' : 'Troppi errori'}</h3><p>Aspetto il risultato…</p></div>`;
  } else if (S.mode === 'online' && g?.status === 'waiting') {
    html = `<div class="ov"><h3>Invita il tuo avversario</h3><p>Manda questo link: solo chi lo riceve può entrare.</p><div class="linkbox">${esc(gameUrl(S.id))}</div><div class="btns"><button class="btn" data-act="share">Condividi link</button><button class="btn ghost" data-act="copy">Copia</button></div><p>Lo schema appare quando entrate entrambi.</p></div>`;
  } else if (S.mode === 'online' && g?.status === 'playing' && sNow() < g.startAt) {
    html = `<div class="ov"><p>Si parte tra</p><div class="count">${Math.ceil((g.startAt - sNow()) / 1000)}</div></div>`;
  }
  if (ov.dataset.html !== html) { ov.innerHTML = html; ov.dataset.html = html; }
  ov.hidden = !html;
}
$('overlay').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'copy') copyLink();
  else if (act === 'share') shareLink();
  else if (act === 'view') { S.viewBoard = true; renderAll(); }
  else if (act === 'again') rematch();
});
$('shareBtn').addEventListener('click', shareLink);

async function copyLink() {
  try { await navigator.clipboard.writeText(gameUrl(S.id)); toast('Link copiato'); }
  catch { toast('Tieni premuto sul link per copiarlo'); }
}
async function shareLink() {
  if (navigator.share) {
    try { await navigator.share({ title: 'Sudoku 1v1', text: 'Ti sfido a Sudoku 1v1!', url: gameUrl(S.id) }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyLink();
}

function renderAll() { renderBoard(); renderVs(); renderOverlay(); updateLocks(); }
function frozen() {
  if (S.outcome || S.out || S.doneLocal) return true;
  if (S.mode === 'solo') return false;
  const g = S.game;
  return !g || g.status !== 'playing' || !g.me || sNow() < g.startAt;
}
$('resultBtn').addEventListener('click', () => { S.viewBoard = false; renderAll(); });
function updateLocks() {
  const viewing = !!(S.outcome && S.viewBoard);
  document.querySelector('.tools').hidden = viewing;
  $('numpad').hidden = viewing;
  $('resultBtn').hidden = !viewing;
  const f = frozen();
  ['undoBtn', 'eraseBtn', 'notesBtn'].forEach(id => $(id).disabled = f);
  $('hintBtn').disabled = f || S.hints <= 0;
}

/* ---------- Input ---------- */
function select(i) { if (!S.puzzle.length) return; S.sel = i; renderBoard(); }
const locked = i => S.given[i] || (S.vals[i] && S.vals[i] === S.solution[i]);
function pushUndo() { S.undo.push({ v: S.vals.slice(), n: S.notes.slice() }); if (S.undo.length > 200) S.undo.shift(); }
function isComplete() { return S.vals.every((v, k) => v === S.solution[k]); }
function place(d) {
  if (frozen() || S.sel < 0) return;
  const i = S.sel;
  if (locked(i)) return;
  if (S.notesMode) {
    if (S.vals[i]) return;
    pushUndo(); S.notes[i] ^= 1 << d; changed(); return;
  }
  if (S.vals[i] === d) return;
  pushUndo();
  S.vals[i] = d; S.notes[i] = 0; S.popAt = i;
  if (d === S.solution[i]) {
    for (const p of PEERS[i]) S.notes[p] &= ~(1 << d);
    if (isComplete()) finishLocal();
  } else {
    S.err++;
    if (S.maxErr && S.err >= S.maxErr) S.out = true;
    if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
  }
  changed(true);
}
function finishLocal() {
  if (S.mode === 'solo') S.doneMs = soloElapsed();
  else S.doneLocal = true;
}
function erase() {
  if (frozen() || S.sel < 0) return;
  const i = S.sel;
  if (locked(i) || (!S.vals[i] && !S.notes[i])) return;
  pushUndo(); S.vals[i] = 0; S.notes[i] = 0; changed();
}
function undo() {
  if (frozen()) return;
  const u = S.undo.pop(); if (!u) return;
  S.vals = u.v; S.notes = u.n; changed();
}
function hint() {
  if (frozen() || S.mode !== 'solo' || S.hints <= 0) return;
  let i = S.sel;
  if (i < 0 || locked(i)) {
    const open = []; for (let k = 0; k < 81; k++) if (!locked(k)) open.push(k);
    if (!open.length) return;
    i = open[Math.random() * open.length | 0];
  }
  const d = S.solution[i];
  S.hints--; S.vals[i] = d; S.notes[i] = 0; S.sel = i; S.popAt = i;
  for (const p of PEERS[i]) S.notes[p] &= ~(1 << d);
  if (isComplete()) finishLocal();
  changed(true);
}
$('undoBtn').addEventListener('click', undo);
$('eraseBtn').addEventListener('click', erase);
$('hintBtn').addEventListener('click', hint);
$('notesBtn').addEventListener('click', () => { S.notesMode = !S.notesMode; renderBoard(); });
document.addEventListener('keydown', e => {
  if ($('game').hidden || e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (/^[1-9]$/.test(k)) { place(+k); e.preventDefault(); }
  else if (k === 'Backspace' || k === 'Delete' || k === '0') { erase(); e.preventDefault(); }
  else if (k === 'n' || k === 'N') { S.notesMode = !S.notesMode; renderBoard(); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { undo(); e.preventDefault(); }
  else if (k.startsWith('Arrow')) {
    const i = S.sel < 0 ? 40 : S.sel;
    let r = R[i], c = C[i];
    if (k === 'ArrowUp') r = (r + 8) % 9;
    if (k === 'ArrowDown') r = (r + 1) % 9;
    if (k === 'ArrowLeft') c = (c + 8) % 9;
    if (k === 'ArrowRight') c = (c + 1) % 9;
    select(r * 9 + c); e.preventDefault();
  }
});

function changed(urgent) {
  checkOutcome();
  renderAll();
  if (S.mode === 'solo') saveSolo();
  else if (S.mode === 'online') queuePush(urgent);
}

/* ---------- Outcome ---------- */
function checkOutcome() {
  let o = null;
  if (S.mode === 'solo') {
    if (S.doneMs != null) o = { win: true };
    else if (S.out) o = { win: false, reason: 'err' };
  } else if (S.game?.winner) {
    o = { win: S.game.winner === 'me', reason: S.game.reason };
  }
  if (o && !S.outcome) {
    S.viewBoard = false; S.sel = -1;
    S.frozenMs = elapsed();
  }
  S.outcome = o;
}

/* ---------- Timer ---------- */
const soloElapsed = () => S.base + (Date.now() - S.resumedAt);
function elapsed() {
  if (S.mode === 'solo') {
    if (S.doneMs != null) return S.doneMs;
    if (S.outcome && S.frozenMs != null) return S.frozenMs;
    return soloElapsed();
  }
  const g = S.game;
  if (!g || !g.startAt || g.status === 'waiting') return 0;
  if (g.me?.doneMs != null) return g.me.doneMs;
  if (S.outcome && S.frozenMs != null) return S.frozenMs;
  return Math.max(0, sNow() - g.startAt);
}
setInterval(() => {
  if ($('game').hidden || !S.puzzle.length) return;
  $('timer').textContent = fmt(elapsed());
  const wasFrozen = $('undoBtn').disabled;
  renderOverlay();
  if (wasFrozen !== frozen()) { updateLocks(); renderBoard(); renderVs(); }
}, 250);

/* ---------- Board loading ---------- */
function loadBoard(puzzle, solution) {
  S.puzzle = [...puzzle].map(Number);
  S.solution = [...solution].map(Number);
  S.given = S.puzzle.map(v => v > 0);
  S.vals = S.puzzle.slice();
  S.notes = Array(81).fill(0);
  S.err = 0; S.out = false; S.doneLocal = false; S.doneMs = null; S.undo = []; S.sel = -1;
  S.outcome = null; S.frozenMs = null; S.viewBoard = false; S.notesMode = false; S.hints = 3;
}
const encNotes = n => n.map(x => x.toString(36).padStart(2, '0')).join('');
const decNotes = s => { const a = []; for (let i = 0; i < 81; i++) a.push(parseInt(s.slice(i * 2, i * 2 + 2), 36) || 0); return a; };

function showGame() {
  $('lobby').hidden = true; $('game').hidden = false;
  window.scrollTo(0, 0);
  renderTitle(); renderAll();
  $('timer').textContent = fmt(elapsed());
}
function showLobby() {
  stopPoll();
  flushPush();
  if (S.mode === 'solo') saveSolo();
  S.mode = null; S.id = null; S.game = null; S.puzzle = [];
  $('game').hidden = true; $('lobby').hidden = false;
  clearUrl();
  renderLobby();
}
$('backBtn').addEventListener('click', showLobby);

/* ---------- Solo ---------- */
function saveSolo() {
  if (S.mode !== 'solo') return;
  ls.set('sv-solo', JSON.stringify({
    p: S.puzzle.join(''), s: S.solution.join(''), v: S.vals.join(''), n: encNotes(S.notes),
    err: S.err, out: S.out, done: S.doneMs, el: S.doneMs ?? soloElapsed(), diff: S.diff, maxErr: S.maxErr, hints: S.hints,
  }));
}
function savedSolo() {
  try { const s = JSON.parse(ls.get('sv-solo') || 'null'); return s && s.done == null && !s.out ? s : null; } catch { return null; }
}
function startSolo(fresh) {
  stopPoll();
  const saved = fresh ? null : savedSolo();
  S.mode = 'solo'; S.id = null; S.game = null;
  if (saved) {
    S.diff = saved.diff; S.maxErr = saved.maxErr;
    loadBoard(saved.p, saved.s);
    S.vals = [...saved.v].map(Number); S.notes = decNotes(saved.n);
    S.err = saved.err; S.hints = saved.hints ?? 3; S.base = saved.el || 0;
  } else {
    S.diff = createDiff; S.maxErr = createErr ? 3 : 0;
    const g = generate(S.diff);
    loadBoard(g.puzzle, g.solution);
    S.base = 0;
  }
  S.resumedAt = Date.now();
  saveSolo();
  checkOutcome();
  showGame();
}
$('soloBtn').addEventListener('click', () => startSolo(false));
// The solo clock only runs while the app is on screen.
document.addEventListener('visibilitychange', () => {
  if (S.mode !== 'solo' || S.outcome) return;
  if (document.hidden) { S.base = soloElapsed(); S.resumedAt = Date.now(); saveSolo(); }
  else S.resumedAt = Date.now();
});

/* ---------- Online ---------- */
function rememberGame(id, diff) {
  let list = [];
  try { list = JSON.parse(ls.get('sv-games') || '[]'); } catch {}
  list = [{ id, diff, t: Date.now() }, ...list.filter(x => x.id !== id)].slice(0, 15);
  ls.set('sv-games', JSON.stringify(list));
}
function forgetGame(id) {
  let list = [];
  try { list = JSON.parse(ls.get('sv-games') || '[]'); } catch {}
  ls.set('sv-games', JSON.stringify(list.filter(x => x.id !== id)));
}

function applyState(d, initial) {
  S.game = d;
  if (d.me) {
    if (initial) {
      S.vals = [...d.me.vals].map(Number);
      S.notes = decNotes(d.me.notes);
      S.doneLocal = d.me.doneMs != null;
    }
    S.err = Math.max(S.err, d.me.err);
    S.out = S.out || d.me.out;
  }
  checkOutcome();
  renderAll();
}
function enterGame(d) {
  stopPoll();
  S.mode = 'online'; S.id = d.id; S.diff = d.diff; S.maxErr = d.maxErr;
  loadBoard(d.puzzle, d.solution);
  applyState(d, true);
  S.sentDone = d.me?.doneMs != null; S.sentOut = !!d.me?.out;
  rememberGame(d.id, d.diff);
  setUrl(d.id);
  $('inviteCard').hidden = true;
  $('nickCard').hidden = false;
  showGame();
  watchGame(d.id);
}
async function openOnline(id) {
  try {
    const d = await fetchGame(id);
    if (d.me) return enterGame(d);
    if (d.full) { toast(ERRORS.full); clearUrl(); return; }
    showInvite(d);
  } catch (e) {
    if (e?.error === 'not_found') forgetGame(id);
    toast(errMsg(e)); clearUrl(); renderLobby();
  }
}
let inviteId = null;
function showInvite(d) {
  inviteId = d.id;
  $('inviteText').textContent = `${d.opp?.name || 'Qualcuno'} ti sfida a un sudoku ${diffName(d.diff).toLowerCase()}` + (d.maxErr ? ', con massimo 3 errori.' : '.');
  $('inviteNick').value = ls.get('sv-nick') || '';
  $('inviteCard').hidden = false;
  $('nickCard').hidden = true;
  window.scrollTo(0, 0);
}
$('inviteBtn').addEventListener('click', async () => {
  if (!inviteId) return;
  $('inviteBtn').disabled = true;
  try { enterGame(await joinGame(inviteId)); }
  catch (e) { toast(errMsg(e)); if (e?.error === 'full' || e?.error === 'not_found') { $('inviteCard').hidden = true; clearUrl(); } }
  finally { $('inviteBtn').disabled = false; }
});

$('createBtn').addEventListener('click', async () => {
  $('createBtn').disabled = true;
  try {
    const id = await createGame(createDiff, createErr ? 3 : 0);
    enterGame(await fetchGame(id));
  } catch (e) { toast(errMsg(e)); }
  finally { $('createBtn').disabled = false; }
});

async function rematch() {
  if (S.mode === 'solo') return startSolo(true);
  try {
    let next = S.game?.next;
    if (!next) {
      const mine = await createGame(S.diff, S.maxErr);
      const res = await gref(S.id, 'next').transaction(cur => (cur ? undefined : mine));
      next = res.snapshot.val() || mine;
    }
    enterGame(await joinGame(next));
  } catch (e) { toast(errMsg(e)); }
}

// Live updates for the open game; stopPoll is the matching unsubscribe.
let watched = null;
function watchGame(id) {
  stopPoll();
  const ref = gref(id);
  const cb = snap => { if (S.id === id && snap.exists()) applyState(derive(id, snap.val()), false); };
  ref.on('value', cb, () => toast(ERRORS.offline));
  watched = () => ref.off('value', cb);
}
function stopPoll() { if (watched) { watched(); watched = null; } }

let pushT = null, pushing = false, pushDirty = false;
function queuePush(now) {
  clearTimeout(pushT);
  if (now) flushPush(); else pushT = setTimeout(flushPush, 300);
}
async function flushPush() {
  clearTimeout(pushT); pushT = null;
  if (S.mode !== 'online' || !S.id || !fb) return;
  if (S.game?.winner && S.sentDone === !!S.doneLocal && S.sentOut === !!S.out) return;
  if (pushing) { pushDirty = true; return; }
  pushing = true;
  const ref = gref(S.id, 'players/' + fb.uid);
  try {
    do {
      pushDirty = false;
      const upd = { name: nick(), vals: S.vals.join(''), notes: encNotes(S.notes), err: S.err, filled: filledCount(), out: !!S.out };
      if (S.doneLocal && !S.sentDone) { upd.doneAt = TS(); S.sentDone = true; }
      if (S.out && !S.sentOut) { upd.outAt = TS(); S.sentOut = true; }
      await ref.update(upd);
    } while (pushDirty);
  } catch (e) { toast(errMsg(e)); }
  finally { pushing = false; }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPush(); });

/* ---------- Menu ---------- */
function renderLobby() {
  const solo = savedSolo();
  $('soloBtn').textContent = solo ? `Riprendi partita da solo (${diffName(solo.diff)})` : 'Gioca da solo';
  let list = [];
  try { list = JSON.parse(ls.get('sv-games') || '[]'); } catch {}
  const week = 7 * 864e5;
  list = list.filter(x => Date.now() - x.t < week);
  const box = $('mineList'); box.textContent = '';
  $('mineCard').hidden = !list.length;
  for (const x of list) {
    const it = document.createElement('div'); it.className = 'item';
    const m = document.createElement('div'); m.className = 'meta';
    const b = document.createElement('b'); b.textContent = diffName(x.diff);
    const mins = Math.round((Date.now() - x.t) / 60000);
    const ago = mins < 1 ? 'adesso' : mins < 60 ? `${mins} min fa` : mins < 1440 ? `${Math.round(mins / 60)} h fa` : `${Math.round(mins / 1440)} g fa`;
    m.append(b, ' · ' + ago);
    const go = document.createElement('button'); go.className = 'btn'; go.textContent = 'Apri';
    go.addEventListener('click', () => openOnline(x.id));
    const del = document.createElement('button'); del.className = 'x'; del.textContent = '×';
    del.setAttribute('aria-label', 'Togli dalla lista');
    del.addEventListener('click', () => { forgetGame(x.id); renderLobby(); });
    it.append(m, go, del); box.appendChild(it);
  }
}

/* ---------- PWA ---------- */
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; installEvt = null; });
if (isIOS && !standalone()) $('installBtn').hidden = false;
$('installBtn').addEventListener('click', async () => {
  if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch {} installEvt = null; $('installBtn').hidden = true; }
  else toast('Su iPhone: tocca Condividi, poi "Aggiungi a Home".');
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ---------- Boot ---------- */
renderLobby();
const startId = new URLSearchParams(location.search).get('g');
if (startId && /^[a-z2-9]{10}$/.test(startId)) openOnline(startId);
})();
