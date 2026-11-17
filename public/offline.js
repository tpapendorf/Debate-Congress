'use strict';
/* Offline support: pages you have opened are saved on this device, and changes made
   without a connection wait in an outbox and are sent, in order, when the connection returns.
   Loaded before app.js; it reads app.js globals (me, ui, chamberId, state, clockOffset) only when called. */

const Offline = (() => {
  const OUTBOX = 'congress.outbox', FAILED = 'congress.outbox.failed', IDMAP = 'congress.idmap', TMP = 'congress.tmpid';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return mem[k] ?? d; } },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* memory only */ } },
  };
  const mem = {};
  let online = navigator.onLine !== false;
  let flushing = false, retryTimer = null, retryDelay = 2000, justSynced = false;

  // ---------- saved pages (IndexedDB, with a memory fallback) ----------
  let dbp = null;
  const memCache = new Map();
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const r = indexedDB.open('congress-offline', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('pages');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbp;
  }
  async function cacheOp(mode, key, val) {
    const db = await idb();
    if (!db) {
      if (mode === 'put') memCache.set(key, val); else if (mode === 'clear') memCache.clear();
      return mode === 'get' ? memCache.get(key) : undefined;
    }
    return new Promise((resolve) => {
      try {
        const t = db.transaction('pages', mode === 'get' ? 'readonly' : 'readwrite').objectStore('pages');
        const r = mode === 'get' ? t.get(key) : mode === 'put' ? t.put(val, key) : t.clear();
        r.onsuccess = () => resolve(mode === 'get' ? r.result : undefined);
        r.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }
  const keyFor = (url, viewAs) => (url === '/api/me' ? `*|${url}` : `${me?.id ?? 'anon'}|${viewAs || ''}|${url}`);

  // ---------- network ----------
  class NetError extends Error { constructor() { super('You are offline. This needs a connection.'); this.offline = true; } }
  async function send(method, url, body, headers = {}, timeoutMs = 12000) {
    if (navigator.onLine === false) throw new NetError();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl?.signal });
    } catch { throw new NetError(); } finally { clearTimeout(timer); }
    // Render answers 502/503/504 while the app restarts: treat that like a dropped connection.
    if ([502, 503, 504].includes(res.status)) throw new NetError();
    const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  function setOnline(v) {
    if (v === online) return;
    online = v;
    if (v) { retryDelay = 2000; flush(); } else scheduleRetry();
    banner();
  }

  // ---------- reads ----------
  async function get(url, viewAs) {
    url = mapUrl(url);
    const headers = viewAs ? { 'X-View-As': String(viewAs) } : {};
    let data = null, fromCache = false, tried = false;
    const tmpUrl = /\/-\d+(\/|$|\?)/.test(url);
    const fetchIt = async () => {
      tried = true;
      try {
        data = await send('GET', url, null, headers, 8000);
        setOnline(true);
        cacheOp('put', keyFor(url, viewAs), { data, at: Date.now() });
      } catch (e) { if (!e.offline) throw e; setOnline(false); }
    };
    // While known to be offline, go straight to the saved copy instead of waiting on the network.
    if (online && !tmpUrl) await fetchIt();
    if (data === null) {
      let hit = await cacheOp('get', keyFor(url, viewAs));
      if (!hit && !tried && !tmpUrl) { await fetchIt(); if (data === null) hit = await cacheOp('get', keyFor(url, viewAs)); }
      if (data !== null) { /* fetched */ } else if (hit) { data = hit.data; fromCache = true; } else data = await synth(url, viewAs);
      if (data == null) throw new Error(online ? 'This is not saved on this device yet.' : 'You are offline, and this page was not saved on this device yet. Open it once while connected to keep it for later.');
    }
    data = JSON.parse(JSON.stringify(data));
    for (const op of mine()) if ((op.viewAs || null) === (viewAs || null)) applyPatch(data, url, op);
    if (fromCache && data && typeof data === 'object' && !Array.isArray(data)) data._offline = true;
    return data;
  }
  // Prefetch pages so they open later without a connection.
  async function keep(urls) {
    let ok = 0;
    for (const u of urls) { try { await get(u); ok += 1; } catch { /* skip */ } }
    return ok;
  }

  // ---------- writes ----------
  // Changes that can wait for the connection. Everything else needs one.
  const QUEUE = [
    ['PUT', /^\/api\/chambers\/\d+\/(scores\/-?\d+|practice\/scores\/-?\d+|question-scores\/-?\d+|po-score|rankings|practice\/rankings|my-log\/-?\d+)$/],
    ['POST', /^\/api\/chambers\/\d+\/(my-log|my-log\/-?\d+\/questions|recognize|questions|questioning|speech\/end|timer|legislation\/\d+\/begin)$/],
    ['DELETE', /^\/api\/chambers\/\d+\/(my-log\/-?\d+|my-questions\/-?\d+|questions\/-?\d+|speeches\/-?\d+)$/],
    ['PUT', /^\/api\/teams\/\d+\/(plans\/-?\d+|notes\/-?\d+|bills\/\d+\/items\/-?\d+)$/],
    ['POST', /^\/api\/teams\/\d+\/(plans|notes|bills\/\d+\/items)$/],
    ['PUT', /^\/api\/trackers\/\d+$/],
  ];
  const queueable = (method, url) => QUEUE.some(([m, re]) => m === method && re.test(url));
  const CREATES = [[/\/(recognize|my-log)$/, 'speech_id'], [/\/(questions)$/, 'question_id'], [/\/(plans|notes|items)$/, 'id']];

  const outbox = () => ls.get(OUTBOX, []);
  const mine = () => outbox().filter((o) => o.uid === me?.id);
  const idmap = () => ls.get(IDMAP, {});
  function mapUrl(url) {
    const m = idmap();
    return url.replace(/\/(-\d+)(?=\/|$|\?)/g, (all, id) => (m[id] ? `/${m[id]}` : all));
  }
  function nextTmp() { const n = ls.get(TMP, 0) - 1; ls.set(TMP, n); return n; }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  async function write(method, url, body, viewAs) {
    url = mapUrl(url);
    const op = { id: uuid(), method, url, body: body || null, viewAs: viewAs || null, uid: me?.id, uname: me?.display_name, time: Date.now() + (clockOffset || 0) };
    if (!queueable(method, url)) {
      const r = await send(method, url, body, viewAs ? { 'X-View-As': String(viewAs) } : {});
      setOnline(true);
      return r;
    }
    if (!mine().length && online && !/\/-\d+(\/|$)/.test(url)) {
      try { const r = await sendOp(op); setOnline(true); return r; } catch (e) { if (!e.offline) throw e; setOnline(false); }
    }
    const create = CREATES.find(([re]) => method === 'POST' && re.test(url));
    if (create) op.tmp = { id: nextTmp(), key: create[1] };
    ls.set(OUTBOX, [...outbox(), op]);
    banner();
    if (online) flush(); else scheduleRetry();
    return { ok: true, queued: true, ...(op.tmp ? { [op.tmp.key]: op.tmp.id } : {}) };
  }
  const sendOp = (op) => send(op.method, mapUrl(op.url), op.body, { 'X-Op-Id': op.id, 'X-Op-Time': String(op.time), ...(op.viewAs ? { 'X-View-As': String(op.viewAs) } : {}) });

  async function flush() {
    if (flushing || !me) return;
    flushing = true; clearTimeout(retryTimer);
    let sent = 0;
    banner();
    try {
      for (;;) {
        const op = mine()[0];
        if (!op) break;
        let res;
        try { res = await sendOp(op); setOnline(true); } catch (e) {
          if (e.offline) { online = false; scheduleRetry(); break; }
          if (e.status === 401) break;
          drop(op.id);
          ls.set(FAILED, [...ls.get(FAILED, []), { ...op, error: e.message }].slice(-50));
          continue;
        }
        drop(op.id); sent += 1;
        if (op.tmp && res?.[op.tmp.key]) mapped(op.tmp.id, res[op.tmp.key]);
        if (res?.conflict) ls.set(FAILED, [...ls.get(FAILED, []), { ...op, conflict: true, error: 'A teammate changed this while you were offline. Your version was saved as a copy next to theirs.' }].slice(-50));
      }
    } finally { flushing = false; }
    if (sent) { justSynced = true; setTimeout(() => { justSynced = false; banner(); }, 3000); hooks.synced?.(); }
    banner();
  }
  function drop(id) { ls.set(OUTBOX, outbox().filter((o) => o.id !== id)); }
  function mapped(tmp, real) {
    ls.set(IDMAP, { ...idmap(), [tmp]: real });
    // Keep the open page pointing at the saved copy.
    const h = location.hash.replace(new RegExp(`/${tmp}(?=/|$)`), `/${real}`);
    if (h !== location.hash) history.replaceState(null, '', h);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('congress.timer.')) continue;
        const t = JSON.parse(localStorage.getItem(k));
        if (t?.speech_id === tmp) { t.speech_id = real; localStorage.setItem(k, JSON.stringify(t)); }
      }
    } catch { /* storage blocked */ }
    if (typeof timerMem === 'object') for (const t of Object.values(timerMem)) if (t?.speech_id === tmp) t.speech_id = real;
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      if (mine().length) await flush();
      else { try { await send('GET', '/api/me', null, {}, 6000); setOnline(true); hooks.synced?.(); } catch { scheduleRetry(); } }
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }
  window.addEventListener('online', () => { retryDelay = 2000; online = true; flush(); scheduleRetry(); banner(); });
  window.addEventListener('offline', () => setOnline(false));

  // ---------- applying waiting changes to saved pages ----------
  function applyPatch(data, url, op) {
    if (!data || typeof data !== 'object') return;
    try {
      const cm = url.match(/^\/api\/chambers\/(\d+)\/state$/);
      if (cm) { const om = op.url.match(/^\/api\/chambers\/(\d+)(\/.*)$/); if (om && om[1] === cm[1]) patchState(data, om[2], op); return; }
      const tm = url.match(/^\/api\/teams\/(\d+)(\/.*)?$/), om = op.url.match(/^\/api\/teams\/(\d+)(\/.*)$/);
      if (tm && om && tm[1] === om[1]) return patchTeam(data, tm[2] || '', om[2], op);
      if (/^\/api\/trackers\/\d+$/.test(url) && mapUrl(op.url) === url) { if (op.body.name !== undefined) data.name = op.body.name; if (op.body.data !== undefined) data.data = op.body.data; }
    } catch (e) { console.warn('offline patch skipped', e); }
  }
  const idOf = (p) => { const n = Number(p); return idmap()[n] || n; };
  function timerAt(label, secs, t) { return { label, duration: secs, running: true, started_at: t, elapsed_ms: 0 }; }
  function moveLast(list, id) { const i = list.indexOf(id); if (i >= 0) { list.splice(i, 1); list.push(id); } }
  function closeSpeech(s) { s.chamber.current_speech_id = null; s.chamber.timer = null; }
  function patchState(s, path, op) {
    const b = op.body || {}, t = op.time, c = s.chamber;
    const name = (id) => s.competitors.find((p) => p.id === id)?.display_name;
    const billTitle = (lid, topic) => s.legislation.find((l) => l.id === lid)?.title || topic || 'No bill picked';
    let m;
    const score = (bag, id) => { if (!bag) return; if (b.points === null || b.points === '') delete bag[id]; else bag[id] = { points: Number(b.points), comment: b.comment || '' }; };
    if ((m = path.match(/^\/scores\/(-?\d+)$/))) return score(s.my_scores, idOf(m[1]));
    if ((m = path.match(/^\/practice\/scores\/(-?\d+)$/))) return score(s.my_practice_scores, idOf(m[1]));
    if ((m = path.match(/^\/question-scores\/(-?\d+)$/))) return score(s.my_question_scores, idOf(m[1]));
    if (path === '/po-score' && s.my_po_scores) {
      const po = Number(b.po_user_id || c.po_user_id);
      s.my_po_scores = s.my_po_scores.filter((x) => x.po_user_id !== po).concat({ po_user_id: po, points: Number(b.points), comment: b.comment || '' });
      return;
    }
    if (path === '/rankings') { s.my_rankings = (b.user_ids || []).map(Number); return; }
    if (path === '/practice/rankings') { s.my_practice_rankings = (b.user_ids || []).map(Number); return; }
    if (path === '/my-log') {
      const lid = b.legislation_id ? Number(b.legislation_id) : null;
      s.my_log = [...(s.my_log || []), { id: op.tmp.id, chamber_id: c.id, legislation_id: lid, topic: lid ? '' : (b.topic || ''), speaker_id: Number(b.speaker_id), side: b.side, recognized_at: t,
        duration_seconds: b.duration_seconds ?? null, logged_by: s.me.id, mine: true, speaker_name: name(Number(b.speaker_id)), legislation_title: billTitle(lid, b.topic) }];
      return;
    }
    if ((m = path.match(/^\/my-log\/(-?\d+)$/))) {
      const id = idOf(m[1]), x = (s.my_log || []).find((y) => y.id === id);
      if (op.method === 'DELETE') { s.my_log = (s.my_log || []).filter((y) => y.id !== id); s.my_questions = (s.my_questions || []).filter((y) => y.speech_id !== id); return; }
      if (!x) return;
      if (b.speaker_id !== undefined) { x.speaker_id = Number(b.speaker_id); x.speaker_name = name(x.speaker_id); }
      if (b.side !== undefined) x.side = b.side;
      if (b.legislation_id !== undefined) { x.legislation_id = b.legislation_id ? Number(b.legislation_id) : null; x.legislation_title = billTitle(x.legislation_id, x.topic); }
      if (b.duration_seconds !== undefined) x.duration_seconds = b.duration_seconds;
      return;
    }
    if ((m = path.match(/^\/my-log\/(-?\d+)\/questions$/))) {
      const qid = Number(b.questioner_id);
      s.my_questions = [...(s.my_questions || []), { id: op.tmp.id, speech_id: idOf(m[1]), questioner_id: qid, asked_at: t, logged_by: s.me.id, questioner_name: name(qid) }];
      return;
    }
    if ((m = path.match(/^\/my-questions\/(-?\d+)$/))) { const id = idOf(m[1]); s.my_questions = (s.my_questions || []).filter((y) => y.id !== id); return; }
    // The presiding officer's floor controls.
    if ((m = path.match(/^\/legislation\/(\d+)\/begin$/))) {
      const lid = Number(m[1]);
      closeSpeech(s);
      for (const l of s.legislation) { if (l.id === lid) l.status = 'debating'; else if (l.id === c.current_legislation_id && l.status === 'debating') l.status = 'pending'; }
      c.current_legislation_id = lid; c.status = 'in_session'; s.requests = []; c.next_side = 'authorship';
      return;
    }
    if (path === '/recognize') {
      const uid = Number(b.user_id);
      closeSpeech(s);
      s.speeches.push({ id: op.tmp.id, chamber_id: c.id, legislation_id: c.current_legislation_id, speaker_id: uid, side: b.side, recognized_at: t, ended_at: null, duration_seconds: null,
        logged_by: null, speaker_name: name(uid), legislation_title: billTitle(c.current_legislation_id) });
      c.current_speech_id = op.tmp.id; c.timer = timerAt('Speech', c.speech_seconds, t);
      c.next_side = b.side === 'neg' ? 'aff' : 'neg';
      s.requests = (s.requests || []).filter((r) => !(r.user_id === uid && ['aff', 'neg'].includes(r.kind)));
      moveLast(s.speaking_precedence, uid);
      const p = s.competitors.find((x) => x.id === uid); if (p && typeof p.speeches === 'number') p.speeches += 1;
      return;
    }
    if (path === '/questions' && op.method === 'POST') {
      const uid = Number(b.user_id);
      if (!c.current_speech_id) return;
      s.questions.push({ id: op.tmp.id, speech_id: c.current_speech_id, questioner_id: uid, asked_at: t, logged_by: null, questioner_name: name(uid) });
      s.requests = (s.requests || []).filter((r) => !(r.user_id === uid && r.kind === 'question'));
      moveLast(s.question_precedence, uid);
      const p = s.competitors.find((x) => x.id === uid); if (p && typeof p.questions === 'number') p.questions += 1;
      return;
    }
    if ((m = path.match(/^\/questions\/(-?\d+)$/))) { const id = idOf(m[1]); s.questions = s.questions.filter((y) => y.id !== id); return; }
    if (path === '/questioning') {
      const sp = s.speeches.find((x) => x.id === c.current_speech_id);
      if (!sp) return;
      c.timer = timerAt('Questioning', ['authorship', 'sponsorship'].includes(sp.side) ? c.authorship_question_seconds : c.question_seconds, t);
      return;
    }
    if (path === '/speech/end') return closeSpeech(s);
    if ((m = path.match(/^\/speeches\/(-?\d+)$/))) { const id = idOf(m[1]); if (c.current_speech_id === id) closeSpeech(s); s.speeches = s.speeches.filter((y) => y.id !== id); return; }
    if (path === '/timer') {
      const tm = c.timer;
      if (b.action === 'pause' && tm?.running) { tm.elapsed_ms += t - tm.started_at; tm.running = false; tm.started_at = null; }
      else if (b.action === 'resume' && tm && !tm.running) { tm.running = true; tm.started_at = t; }
      else if (b.action === 'reset' && tm) { tm.elapsed_ms = 0; tm.running = false; tm.started_at = null; }
      else if (b.action === 'custom') c.timer = timerAt(String(b.label || 'Timer').slice(0, 40), Number(b.seconds), t);
      else if (b.action === 'clear') c.timer = null;
    }
  }
  function patchTeam(d, view, path, op) {
    const b = op.body || {};
    let m;
    if ((m = path.match(/^\/plans\/(-?\d+)$/))) {
      const id = idOf(m[1]);
      const fix = (p) => { Object.assign(p, pick(b, ['title', 'side', 'status', 'tournament', 'outline'])); if (b.bill_id !== undefined) p.bill_id = b.bill_id ? Number(b.bill_id) : null; if (b.shared_with_leaders !== undefined) p.shared_with_leaders = b.shared_with_leaders ? 1 : 0; p.updated_at = op.time; };
      if (view === '/prep') d.plans?.filter((p) => p.id === id).forEach(fix);
      if (view === `/plans/${id}` && d.plan) fix(d.plan);
      return;
    }
    if ((m = path.match(/^\/notes\/(-?\d+)$/))) {
      const id = idOf(m[1]);
      if (view === '/prep') d.notes?.filter((n) => n.id === id).forEach((n) => { Object.assign(n, pick(b, ['title', 'body'])); if (b.bill_id !== undefined) n.bill_id = b.bill_id ? Number(b.bill_id) : null; n.updated_at = op.time; });
      return;
    }
    if (path === '/plans' && view === '/prep') {
      d.plans = [{ id: op.tmp.id, user_id: op.uid, title: b.title || 'Untitled speech', bill_id: b.bill_id ? Number(b.bill_id) : null, bill_title: null, side: b.side || 'aff', status: b.status || 'idea', tournament: b.tournament || '', outline: b.outline || '', shared_with_leaders: 0, updated_at: op.time }, ...(d.plans || [])];
      return;
    }
    if (path === '/notes' && view === '/prep') {
      d.notes = [{ id: op.tmp.id, user_id: op.uid, title: b.title || 'Untitled note', bill_id: b.bill_id ? Number(b.bill_id) : null, bill_title: null, body: b.body || '', updated_at: op.time }, ...(d.notes || [])];
      return;
    }
    if ((m = path.match(/^\/bills\/(\d+)\/items(?:\/(-?\d+))?$/)) && (view === `/bills/${m[1]}` || (d.plan && String(d.plan.bill_id) === m[1]))) {
      d.items = d.items || [];
      if (!m[2]) { d.items.push({ id: op.tmp.id, bill_id: Number(m[1]), section: b.section, side: b.side || 'both', text: b.text || '', detail: b.detail || '', cite_title: b.cite_title || '', cite_source: b.cite_source || '', cite_author: b.cite_author || '', cite_date: b.cite_date || '', cite_url: b.cite_url || '', updated_at: op.time, created_by_name: op.uname, updated_by_name: op.uname, pending: true }); return; }
      const it = d.items.find((x) => x.id === idOf(m[2]));
      if (it) { it.base_updated_at = it.base_updated_at ?? it.updated_at; Object.assign(it, pick(b, ['section', 'side', 'text', 'detail', 'cite_title', 'cite_source', 'cite_author', 'cite_date', 'cite_url'])); it.updated_at = op.time; it.updated_by_name = op.uname; it.pending = true; }
    }
  }
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

  // A new plan made offline has no saved page yet, so build it from what is on this device.
  async function synth(url, viewAs) {
    const m = url.match(/^\/api\/teams\/(\d+)\/plans\/(-\d+)$/);
    if (!m) return null;
    const op = mine().find((o) => o.tmp?.id === Number(m[2]));
    if (!op) return null;
    const b = op.body || {};
    const billId = b.bill_id ? Number(b.bill_id) : null;
    const bill = billId ? await cacheOp('get', keyFor(`/api/teams/${m[1]}/bills/${billId}`, viewAs)) : null;
    return { plan: { id: op.tmp.id, user_id: op.uid, title: b.title || 'Untitled speech', bill_id: billId, side: b.side || 'aff', status: b.status || 'idea', tournament: b.tournament || '', outline: b.outline || '', shared_with_leaders: 0, updated_at: op.time },
      own: true, author: op.uname, items: bill?.data?.items || [], links: [] };
  }

  // ---------- status in the header ----------
  const hooks = {};
  function describe(op) {
    const p = op.url.replace(/^\/api\/(chambers|teams)\/\d+/, '');
    const table = [[/scores|po-score|question-scores/, 'Score'], [/rankings/, 'Ranking'], [/my-log\/-?\d+\/questions|my-questions/, 'Question in your log'], [/my-log/, 'Speech in your log'],
      [/recognize/, 'Recognized speaker'], [/questions/, 'Question'], [/timer|questioning|speech\/end/, 'Timer'], [/begin/, 'Debate started'], [/speeches/, 'Removed speech'],
      [/plans/, 'Speech plan'], [/notes/, 'Note'], [/items/, 'Team research'], [/trackers/, 'Tracker']];
    return (table.find(([re]) => re.test(p)) || [null, 'Change'])[1];
  }
  function banner() {
    const el = document.getElementById('netstatus');
    if (!el) return;
    const n = mine().length, others = outbox().filter((o) => o.uid !== me?.id), failed = ls.get(FAILED, []).filter((o) => o.uid === me?.id);
    let cls = '', text = '';
    if (!online) { cls = 'off'; text = n ? `Offline · ${n} change${n === 1 ? '' : 's'} waiting` : 'Offline · saved pages'; }
    else if (n) { cls = 'sync'; text = `Saving ${n} change${n === 1 ? '' : 's'}…`; }
    else if (failed.length) { cls = 'bad'; text = `${failed.length} change${failed.length === 1 ? '' : 's'} need a look`; }
    else if (justSynced) { cls = 'ok'; text = 'All changes saved'; }
    else if (others.length && me) { cls = 'sync'; text = `${others.length} waiting for ${others[0].uname || 'another account'}`; }
    el.hidden = !text;
    el.className = `netstatus ${cls}`;
    const short = !online ? `Offline${n ? ` · ${n}` : ''}` : n ? `Saving ${n}` : failed.length ? `${failed.length} to check` : justSynced ? 'Saved' : others.length ? `${others.length} held` : '';
    el.innerHTML = `<span class="long">${esc(text)}</span><span class="short">${esc(short)}</span>`;
    el.title = text;
  }
  function panel() {
    const n = mine(), failed = ls.get(FAILED, []).filter((o) => o.uid === me?.id), others = outbox().filter((o) => o.uid !== me?.id);
    const when = (o) => new Date(o.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<div class="card stack">
      <div class="spread"><h2>Changes on this device</h2><button class="ghost sm" data-act="net-close">Close</button></div>
      <p class="small muted">${online ? 'Connected.' : 'No connection right now.'} Pages you have opened are kept on this device, and changes you make offline are sent in order when the connection returns.</p>
      ${n.length ? `<h3>Waiting to send</h3><ul class="list">${n.map((o) => `<li class="spread"><span>${esc(describe(o))}</span><span class="small muted">${when(o)}</span></li>`).join('')}</ul>${online ? '' : '<button class="sm" data-act="net-retry">Try now</button>'}` : '<p class="small">Nothing is waiting to send.</p>'}
      ${failed.length ? `<h3>Needs a look</h3><ul class="list">${failed.map((o) => `<li><div class="spread"><strong class="small">${esc(describe(o))}</strong><span class="small muted">${when(o)}</span></div><div class="small ${o.conflict ? '' : 'error-text'}">${esc(o.error)}</div></li>`).join('')}</ul><button class="sm ghost" data-act="net-dismiss">Dismiss these</button>` : ''}
      ${others.length ? `<p class="small muted">${others.length} change${others.length === 1 ? ' was' : 's were'} made here by ${esc(others[0].uname || 'another account')}. They send when that person signs in on this device.</p>` : ''}
    </div>`;
  }
  function dismiss() { ls.set(FAILED, ls.get(FAILED, []).filter((o) => o.uid !== me?.id)); banner(); }
  async function clearSaved() { await cacheOp('clear'); }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* offline pages still work while this tab stays open */ }));
  }
  setInterval(banner, 15000);

  return { get, write, keep, queueable, flush, banner, panel, dismiss, clearSaved, hooks, pending: () => mine().length, isOnline: () => online, describe, mapUrl };
})();
