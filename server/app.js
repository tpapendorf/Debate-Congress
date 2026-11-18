'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}
function randomPassword() {
  // Easy to read aloud / type on a phone: three lowercase syllables + 2 digits.
  const c = 'bcdfghjkmnprstvwz', v = 'aeiou';
  let s = '';
  for (let i = 0; i < 3; i++) s += c[crypto.randomInt(c.length)] + v[crypto.randomInt(v.length)] + c[crypto.randomInt(c.length)];
  return s + crypto.randomInt(10, 100);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
const notFound = (msg = 'Not found.') => new HttpError(404, msg);

const SIDES = ['authorship', 'sponsorship', 'aff', 'neg'];
const MOTIONS = {
  previous_question: { label: 'Previous question', threshold: 'two_thirds' },
  amend: { label: 'Amendment', threshold: 'majority' },
  table: { label: 'Table', threshold: 'majority' },
  take_from_table: { label: 'Take from the table', threshold: 'majority' },
  recess: { label: 'Recess', threshold: 'majority' },
  adjourn: { label: 'Adjourn', threshold: 'majority' },
  extend_questioning: { label: 'Extend questioning', threshold: 'two_thirds' },
  other: { label: 'Other', threshold: 'majority' },
};

function createApp(db0, { publicDir = path.join(__dirname, '..', 'public'), dbFile = null, backupDir = null } = {}) {
  let db = db0; // replaced in place when an admin restores a backup
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Changes made offline are sent later with the time they really happened (X-Op-Time, already in server time).
  // While a request is handled, now() returns that time, so speeches, questions and timers line up with the round.
  let opNow = null;
  const now = () => opNow ?? Date.now();
  function opTime(req) {
    const t = Number(req.headers['x-op-time']);
    if (req.method === 'GET' || !Number.isFinite(t)) return null;
    const real = Date.now();
    return t >= real - 24 * 3600 * 1000 && t <= real ? Math.round(t) : null;
  }

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  // ---------- live updates (server-sent events) ----------
  const listeners = new Map(); // chamberId -> Set(res)
  function broadcast(chamberId) {
    const set = listeners.get(Number(chamberId));
    if (!set) return;
    for (const res of set) res.write(`event: changed\ndata: ${Date.now()}\n\n`);
  }
  const heartbeat = setInterval(() => {
    for (const set of listeners.values()) for (const res of set) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  // ---------- auth ----------
  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    return q(`SELECT u.id, u.username, u.display_name, u.school, u.role FROM sessions s
              JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token) || null;
  }
  app.use((req, _res, next) => { req.user = currentUser(req); next(); });

  // A change sent again after a dropped connection (same X-Op-Id) is answered from the first result, never applied twice.
  q('DELETE FROM client_ops WHERE created_at < ?').run(Date.now() - 14 * 24 * 3600 * 1000);
  app.use((req, res, next) => {
    const op = String(req.headers['x-op-id'] || '');
    if (req.method === 'GET' || !req.user || !/^[\w-]{8,64}$/.test(op)) return next();
    const seen = q('SELECT status, body FROM client_ops WHERE op_id = ? AND user_id = ?').get(op, req.user.id);
    if (seen) return res.status(seen.status).type('application/json').send(seen.body);
    const json = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode < 500) {
        try { q('INSERT OR IGNORE INTO client_ops (op_id, user_id, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(op, req.user.id, res.statusCode, JSON.stringify(data ?? null), Date.now()); } catch { /* best effort */ }
      }
      return json(data);
    };
    next();
  });
  const requireUser = (req) => { if (!req.user) throw new HttpError(401, 'Please sign in.'); return req.user; };
  const requireAdmin = (req) => { const u = requireUser(req); if (u.role !== 'admin') throw forbidden(); return u; };

  const wrap = (fn) => (req, res) => {
    opNow = opTime(req);
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (String(e.message).includes('UNIQUE constraint failed: users.username')) {
        return res.status(400).json({ error: 'That username is already taken.' });
      }
      console.error(e);
      res.status(500).json({ error: 'Something went wrong.' });
    } finally { opNow = null; }
  };

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  }

  app.get('/api/setup', wrap(() => ({ needed: q('SELECT COUNT(*) n FROM users').get().n === 0 })));
  app.post('/api/setup', wrap((req, res) => {
    if (q('SELECT COUNT(*) n FROM users').get().n > 0) throw forbidden('Setup is already complete.');
    const { username, display_name, password } = req.body || {};
    if (!username || !password || password.length < 6) throw bad('Choose a username and a password of at least 6 characters.');
    const r = q(`INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, 'admin', ?)`)
      .run(username.trim(), (display_name || username).trim(), hashPassword(password));
    startSession(res, Number(r.lastInsertRowid));
    return { ok: true };
  }));

  app.post('/api/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const u = q('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!u || !checkPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Wrong username or password.');
    startSession(res, u.id);
    return { ok: true };
  }));
  app.post('/api/logout', wrap((req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }));
  app.get('/api/me', wrap((req) => ({ user: req.user })));
  app.post('/api/me/password', wrap((req) => {
    const u = requireUser(req);
    const { current, next } = req.body || {};
    const row = q('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    if (!checkPassword(String(current || ''), row.password_hash)) throw bad('Current password is wrong.');
    if (!next || next.length < 6) throw bad('New password must be at least 6 characters.');
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    return { ok: true };
  }));

  // ---------- users (admin) ----------
  app.get('/api/users', wrap((req) => {
    requireAdmin(req);
    return { users: q('SELECT id, username, display_name, school, role FROM users WHERE mock_chamber_id IS NULL ORDER BY role, display_name').all() };
  }));
  function makeUsername(name) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'user';
    let candidate = base, n = 1;
    while (q('SELECT 1 FROM users WHERE username = ?').get(candidate)) candidate = `${base}${++n}`;
    return candidate;
  }
  function createUser({ username, display_name, school = '', role, password }) {
    if (!display_name || !String(display_name).trim()) throw bad('Name is required.');
    if (!['admin', 'judge', 'competitor'].includes(role)) throw bad('Role must be admin, judge or competitor.');
    const uname = username ? String(username).trim() : makeUsername(display_name);
    const pw = password || randomPassword();
    const r = q('INSERT INTO users (username, display_name, school, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(uname, String(display_name).trim(), String(school).trim(), role, hashPassword(pw));
    return { id: Number(r.lastInsertRowid), username: uname, display_name: String(display_name).trim(), school, role, password: pw };
  }
  app.post('/api/users', wrap((req) => { requireAdmin(req); return { user: createUser(req.body || {}) }; }));
  // Bulk add: one per line, "Name, School, role" (role defaults to competitor).
  app.post('/api/users/bulk', wrap((req) => {
    requireAdmin(req);
    const lines = String((req.body || {}).text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw bad('Paste at least one line.');
    const created = tx(() => lines.map((line) => {
      const [name, school = '', role = 'competitor'] = line.split(',').map((s) => s.trim());
      return createUser({ display_name: name, school, role: role.toLowerCase() || 'competitor' });
    }));
    return { users: created };
  }));
  app.put('/api/users/:id', wrap((req) => {
    requireAdmin(req);
    const u = q('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw notFound();
    const b = req.body || {};
    const role = b.role || u.role;
    if (!['admin', 'judge', 'competitor'].includes(role)) throw bad('Bad role.');
    q('UPDATE users SET display_name = ?, school = ?, role = ? WHERE id = ?')
      .run(b.display_name ?? u.display_name, b.school ?? u.school, role, u.id);
    let password;
    if (b.reset_password) {
      password = randomPassword();
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    return { ok: true, password };
  }));
  app.delete('/api/users/:id', wrap((req) => {
    const admin = requireAdmin(req);
    if (Number(req.params.id) === admin.id) throw bad('You cannot delete your own account.');
    q('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  }));

  // ---------- chambers ----------
  function getChamber(id) {
    const c = q('SELECT * FROM chambers WHERE id = ?').get(Number(id));
    if (!c) throw notFound('Chamber not found.');
    return c;
  }
  function membership(c, user) {
    const member = !!q('SELECT 1 FROM chamber_members WHERE chamber_id = ? AND user_id = ?').get(c.id, user.id);
    const isAdmin = user.role === 'admin';
    return {
      isAdmin,
      member,
      isPO: member && c.po_user_id === user.id,
      isJudge: member && user.role === 'judge',
      isCompetitor: member && user.role === 'competitor',
      canChair: isAdmin || (member && c.po_user_id === user.id),
    };
  }
  function loadChamber(req, need) {
    const realUser = requireUser(req);
    const c = getChamber(req.params.id);
    // In a mock tournament an admin can act as any of its made-up people ("view as").
    let user = realUser;
    const asId = Number(req.headers['x-view-as'] || 0);
    if (asId && realUser.role === 'admin' && c.is_mock) {
      const target = q('SELECT id, username, display_name, school, role FROM users WHERE id = ? AND mock_chamber_id = ?').get(asId, c.id);
      if (target) user = target;
    }
    const m = membership(c, user);
    m.realIsAdmin = realUser.role === 'admin';
    m.viewingAs = user.id !== realUser.id;
    if (!m.isAdmin && !m.member) throw forbidden('You are not part of this chamber.');
    if (need === 'chair' && !m.canChair) throw forbidden('Only the presiding officer or an admin can do that.');
    if (need === 'admin' && !m.isAdmin) throw forbidden('Only an admin can do that.');
    if (need === 'judge' && !m.isJudge) throw forbidden('Only judges in this chamber can score.');
    if (need === 'competitor' && !m.isCompetitor) throw forbidden('Only competitors in this chamber can do that.');
    return { user, c, m };
  }
  const done = (c, extra = {}) => { broadcast(c.id); return { ok: true, ...extra }; };

  app.get('/api/chambers', wrap((req) => {
    const u = requireUser(req);
    const rows = u.role === 'admin'
      ? q('SELECT * FROM chambers ORDER BY id DESC').all()
      : q(`SELECT c.* FROM chambers c JOIN chamber_members m ON m.chamber_id = c.id
           WHERE m.user_id = ? ORDER BY c.id DESC`).all(u.id);
    return { chambers: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, is_mock: !!c.is_mock, is_po: c.po_user_id === u.id })) };
  }));
  app.post('/api/chambers', wrap((req) => {
    requireAdmin(req);
    const name = String((req.body || {}).name || '').trim();
    if (!name) throw bad('Give the chamber a name.');
    const r = q('INSERT INTO chambers (name) VALUES (?)').run(name);
    return { id: Number(r.lastInsertRowid) };
  }));
  app.delete('/api/chambers/:id', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    tx(() => {
      q('DELETE FROM chambers WHERE id = ?').run(c.id);
      if (c.is_mock) q('DELETE FROM users WHERE mock_chamber_id = ?').run(c.id);
    });
    return { ok: true };
  }));

  const SETTINGS = ['name', 'score_min', 'score_max', 'rank_count', 'speech_seconds', 'authorship_question_seconds', 'question_seconds'];
  app.put('/api/chambers/:id', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const b = req.body || {};
    const next = { ...c };
    for (const k of SETTINGS) if (b[k] !== undefined) next[k] = k === 'name' ? String(b[k]).trim() : Number(b[k]);
    if (!next.name) throw bad('Name is required.');
    for (const k of SETTINGS.slice(1)) if (!Number.isInteger(next[k]) || next[k] < 0) throw bad(`${k} must be a whole number.`);
    if (next.score_min >= next.score_max) throw bad('Lowest score must be below the highest score.');
    if ('po_user_id' in b) {
      const po = b.po_user_id ? Number(b.po_user_id) : null;
      if (po && !q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id
                    WHERE m.chamber_id = ? AND m.user_id = ? AND u.role = 'competitor'`).get(c.id, po)) {
        throw bad('The presiding officer must be a competitor in this chamber.');
      }
      next.po_user_id = po;
    }
    if (b.floor_mode !== undefined) {
      if (!['po', 'self'].includes(b.floor_mode)) throw bad('Pick who runs the floor.');
      next.floor_mode = b.floor_mode;
    }
    q(`UPDATE chambers SET name=?, score_min=?, score_max=?, rank_count=?, speech_seconds=?,
       authorship_question_seconds=?, question_seconds=?, po_user_id=?, floor_mode=? WHERE id=?`)
      .run(next.name, next.score_min, next.score_max, next.rank_count, next.speech_seconds,
        next.authorship_question_seconds, next.question_seconds, next.po_user_id, next.floor_mode, c.id);
    return done(c);
  }));

  app.post('/api/chambers/:id/members', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const ids = ((req.body || {}).user_ids || []).map(Number);
    const ins = q('INSERT OR IGNORE INTO chamber_members (chamber_id, user_id, seat) VALUES (?, ?, ?)');
    tx(() => {
      let seat = q('SELECT COALESCE(MAX(seat), 0) s FROM chamber_members WHERE chamber_id = ?').get(c.id).s;
      for (const id of ids) {
        const u = q('SELECT role FROM users WHERE id = ?').get(id);
        if (!u || u.role === 'admin') continue;
        ins.run(c.id, id, u.role === 'competitor' ? ++seat : null);
      }
    });
    return done(c);
  }));
  app.delete('/api/chambers/:id/members/:uid', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const uid = Number(req.params.uid);
    q('DELETE FROM chamber_members WHERE chamber_id = ? AND user_id = ?').run(c.id, uid);
    if (c.po_user_id === uid) q('UPDATE chambers SET po_user_id = NULL WHERE id = ?').run(c.id);
    return done(c);
  }));

  // ---------- docket ----------
  app.post('/api/chambers/:id/legislation', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const b = req.body || {};
    if (!String(b.title || '').trim()) throw bad('Title is required.');
    const order = q('SELECT COALESCE(MAX(docket_order), 0) + 1 n FROM legislation WHERE chamber_id = ?').get(c.id).n;
    q('INSERT INTO legislation (chamber_id, title, kind, author, body, docket_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, String(b.title).trim(), b.kind === 'resolution' ? 'resolution' : 'bill', String(b.author || ''), String(b.body || ''), order);
    return done(c);
  }));
  function cleanPacketItems(list) {
    if (!Array.isArray(list) || !list.length) throw bad('Pick at least one bill.');
    return list.slice(0, 200).map((x) => ({
      title: String(x?.title || '').replace(/\s+/g, ' ').trim().slice(0, 300), kind: x?.kind === 'resolution' ? 'resolution' : 'bill',
      author: String(x?.author || '').trim().slice(0, 200), session: String(x?.session || '').trim().slice(0, 60), text: String(x?.text || '').slice(0, 50000),
    })).filter((x) => x.title);
  }
  // Bulk-add legislation read from a tournament packet.
  app.post('/api/chambers/:id/legislation/packet', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const items = cleanPacketItems((req.body || {}).items);
    let order = q('SELECT COALESCE(MAX(docket_order), 0) n FROM legislation WHERE chamber_id = ?').get(c.id).n;
    let added = 0;
    tx(() => {
      for (const it of items) {
        if (q('SELECT 1 FROM legislation WHERE chamber_id = ? AND title = ?').get(c.id, it.title)) continue;
        q('INSERT INTO legislation (chamber_id, title, kind, author, body, docket_order) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, it.title, it.kind, it.author, it.text, ++order);
        added++;
      }
    });
    return done(c, { added });
  }));
  function getLeg(c, lid) {
    const l = q('SELECT * FROM legislation WHERE id = ? AND chamber_id = ?').get(Number(lid), c.id);
    if (!l) throw notFound('Legislation not found.');
    return l;
  }
  app.put('/api/chambers/:id/legislation/:lid', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const l = getLeg(c, req.params.lid);
    const b = req.body || {};
    q('UPDATE legislation SET title = ?, kind = ?, author = ?, body = ? WHERE id = ?')
      .run(String(b.title ?? l.title).trim() || l.title, b.kind === 'resolution' ? 'resolution' : (b.kind === 'bill' ? 'bill' : l.kind),
        String(b.author ?? l.author), String(b.body ?? l.body), l.id);
    return done(c);
  }));
  app.delete('/api/chambers/:id/legislation/:lid', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    const l = getLeg(c, req.params.lid);
    if (q('SELECT 1 FROM speeches WHERE legislation_id = ?').get(l.id)) throw bad('Speeches were given on this item, so it cannot be deleted.');
    q('DELETE FROM legislation WHERE id = ?').run(l.id);
    if (c.current_legislation_id === l.id) q('UPDATE chambers SET current_legislation_id = NULL WHERE id = ?').run(c.id);
    return done(c);
  }));
  // The chamber votes the docket into order; the chair records the agreed order here.
  app.post('/api/chambers/:id/docket-order', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const ids = ((req.body || {}).ids || []).map(Number);
    const upd = q('UPDATE legislation SET docket_order = ? WHERE id = ? AND chamber_id = ?');
    tx(() => ids.forEach((id, i) => upd.run(i + 1, id, c.id)));
    return done(c);
  }));

  // ---------- chair (presiding officer) controls ----------
  function setTimer(c, label, duration) {
    q('UPDATE chambers SET timer_label = ?, timer_duration = ?, timer_started_at = ?, timer_elapsed_ms = 0 WHERE id = ?')
      .run(label, duration, now(), c.id);
  }
  function timerElapsedMs(c) {
    return c.timer_elapsed_ms + (c.timer_started_at ? now() - c.timer_started_at : 0);
  }
  function closeCurrentSpeech(c) {
    if (!c.current_speech_id) return;
    const s = q('SELECT * FROM speeches WHERE id = ?').get(c.current_speech_id);
    if (s && !s.ended_at) {
      const dur = s.duration_seconds ?? (c.timer_label === 'Speech' ? Math.round(timerElapsedMs(c) / 1000) : null);
      q('UPDATE speeches SET ended_at = ?, duration_seconds = ? WHERE id = ?').run(now(), dur, s.id);
    }
    q(`UPDATE chambers SET current_speech_id = NULL, timer_label = NULL, timer_duration = NULL,
       timer_started_at = NULL, timer_elapsed_ms = 0 WHERE id = ?`).run(c.id);
  }

  app.post('/api/chambers/:id/status', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const status = (req.body || {}).status;
    if (!['setup', 'in_session', 'recess', 'adjourned'].includes(status)) throw bad('Bad status.');
    q('UPDATE chambers SET status = ? WHERE id = ?').run(status, c.id);
    return done(c);
  }));

  app.post('/api/chambers/:id/legislation/:lid/begin', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const l = getLeg(c, req.params.lid);
    tx(() => {
      closeCurrentSpeech(c);
      if (c.current_legislation_id && c.current_legislation_id !== l.id) {
        q(`UPDATE legislation SET status = 'pending' WHERE id = ? AND status = 'debating'`).run(c.current_legislation_id);
      }
      q(`UPDATE legislation SET status = 'debating' WHERE id = ?`).run(l.id);
      q(`UPDATE chambers SET current_legislation_id = ?, status = 'in_session' WHERE id = ?`).run(l.id, c.id);
      q(`DELETE FROM speech_requests WHERE chamber_id = ?`).run(c.id);
    });
    return done(c);
  }));

  app.post('/api/chambers/:id/recognize', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const { user_id, side } = req.body || {};
    if (!c.current_legislation_id) throw bad('Begin debate on a docket item first.');
    if (!SIDES.includes(side)) throw bad('Pick a side.');
    const speaker = q(`SELECT u.id FROM users u JOIN chamber_members m ON m.user_id = u.id
                       WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`).get(c.id, Number(user_id));
    if (!speaker) throw bad('That person is not a competitor in this chamber.');
    const id = tx(() => {
      closeCurrentSpeech(c);
      const r = q('INSERT INTO speeches (chamber_id, legislation_id, speaker_id, side, recognized_at) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, c.current_legislation_id, speaker.id, side, now());
      const sid = Number(r.lastInsertRowid);
      q('UPDATE chambers SET current_speech_id = ? WHERE id = ?').run(sid, c.id);
      q(`DELETE FROM speech_requests WHERE chamber_id = ? AND user_id = ? AND kind IN ('aff','neg')`).run(c.id, speaker.id);
      ensureQueues(c);
      moveToEnd(c, 'speak', speaker.id);
      setTimer(c, 'Speech', c.speech_seconds);
      return sid;
    });
    return done(c, { speech_id: id });
  }));

  app.post('/api/chambers/:id/questioning', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    if (!c.current_speech_id) throw bad('No one has the floor.');
    const s = q('SELECT * FROM speeches WHERE id = ?').get(c.current_speech_id);
    if (s.duration_seconds == null && c.timer_label === 'Speech') {
      q('UPDATE speeches SET duration_seconds = ? WHERE id = ?').run(Math.round(timerElapsedMs(c) / 1000), s.id);
    }
    const secs = ['authorship', 'sponsorship'].includes(s.side) ? c.authorship_question_seconds : c.question_seconds;
    setTimer(c, 'Questioning', secs);
    return done(c);
  }));

  app.post('/api/chambers/:id/questions', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    if (!c.current_speech_id) throw bad('No one has the floor.');
    const uid = Number((req.body || {}).user_id);
    if (!q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id
            WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`).get(c.id, uid)) throw bad('Not a competitor in this chamber.');
    const qid = tx(() => {
      const r = q('INSERT INTO questions (chamber_id, speech_id, questioner_id, asked_at) VALUES (?, ?, ?, ?)').run(c.id, c.current_speech_id, uid, now());
      q(`DELETE FROM speech_requests WHERE chamber_id = ? AND user_id = ? AND kind = 'question'`).run(c.id, uid);
      ensureQueues(c);
      moveToEnd(c, 'question', uid);
      return Number(r.lastInsertRowid);
    });
    return done(c, { question_id: qid });
  }));
  app.delete('/api/chambers/:id/questions/:qid', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    q('DELETE FROM questions WHERE id = ? AND chamber_id = ? AND logged_by IS NULL').run(Number(req.params.qid), c.id);
    resetQueue(c, 'question');
    return done(c);
  }));

  app.post('/api/chambers/:id/speech/end', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    tx(() => closeCurrentSpeech(c));
    return done(c);
  }));
  // Undo a mistaken recognition (only allowed before any judge has scored it).
  app.delete('/api/chambers/:id/speeches/:sid', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const sid = Number(req.params.sid);
    if (!q('SELECT 1 FROM speeches WHERE id = ? AND chamber_id = ? AND logged_by IS NULL').get(sid, c.id)) throw notFound('Speech not found.');
    if (q('SELECT 1 FROM speech_scores WHERE speech_id = ?').get(sid)) throw bad('A judge already scored this speech, so it cannot be removed.');
    tx(() => {
      if (c.current_speech_id === sid) closeCurrentSpeech(c);
      q('DELETE FROM speeches WHERE id = ? AND chamber_id = ? AND logged_by IS NULL').run(sid, c.id);
      resetQueue(c, 'speak');
      resetQueue(c, 'question');
    });
    return done(c);
  }));

  app.post('/api/chambers/:id/timer', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const { action, label, seconds } = req.body || {};
    if (action === 'pause' && c.timer_started_at) {
      q('UPDATE chambers SET timer_elapsed_ms = ?, timer_started_at = NULL WHERE id = ?').run(timerElapsedMs(c), c.id);
    } else if (action === 'resume' && !c.timer_started_at && c.timer_duration != null) {
      q('UPDATE chambers SET timer_started_at = ? WHERE id = ?').run(now(), c.id);
    } else if (action === 'reset' && c.timer_duration != null) {
      q('UPDATE chambers SET timer_elapsed_ms = 0, timer_started_at = NULL WHERE id = ?').run(c.id);
    } else if (action === 'custom') {
      const s = Number(seconds);
      if (!Number.isInteger(s) || s <= 0) throw bad('Seconds must be a positive whole number.');
      setTimer(c, String(label || 'Timer').slice(0, 40), s);
    } else if (action === 'clear') {
      q('UPDATE chambers SET timer_label = NULL, timer_duration = NULL, timer_started_at = NULL, timer_elapsed_ms = 0 WHERE id = ?').run(c.id);
    }
    return done(c);
  }));

  // ---------- motions & votes ----------
  app.post('/api/chambers/:id/motions', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const { kind, mover_id, details } = req.body || {};
    if (!MOTIONS[kind]) throw bad('Unknown motion.');
    const r = q('INSERT INTO motions (chamber_id, legislation_id, kind, mover_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, c.current_legislation_id, kind, mover_id ? Number(mover_id) : null, String(details || ''), now());
    return done(c, { motion_id: Number(r.lastInsertRowid) });
  }));
  app.post('/api/chambers/:id/motions/:mid/status', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const status = (req.body || {}).status;
    if (!['passed', 'failed', 'withdrawn'].includes(status)) throw bad('Bad status.');
    const m = q('SELECT * FROM motions WHERE id = ? AND chamber_id = ?').get(Number(req.params.mid), c.id);
    if (!m) throw notFound();
    tx(() => {
      q('UPDATE motions SET status = ? WHERE id = ?').run(status, m.id);
      if (status === 'passed') applyMotion(c, m);
    });
    return done(c);
  }));
  function applyMotion(c, m) {
    if (m.kind === 'table' && m.legislation_id) {
      q(`UPDATE legislation SET status = 'tabled' WHERE id = ?`).run(m.legislation_id);
      if (c.current_legislation_id === m.legislation_id) {
        closeCurrentSpeech(c);
        q('UPDATE chambers SET current_legislation_id = NULL WHERE id = ?').run(c.id);
      }
    } else if (m.kind === 'recess') {
      q(`UPDATE chambers SET status = 'recess' WHERE id = ?`).run(c.id);
    } else if (m.kind === 'adjourn') {
      closeCurrentSpeech(c);
      q(`UPDATE chambers SET status = 'adjourned' WHERE id = ?`).run(c.id);
    }
  }

  app.post('/api/chambers/:id/votes', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const { target_type, target_id } = req.body || {};
    if (q(`SELECT 1 FROM vote_rounds WHERE chamber_id = ? AND status = 'open'`).get(c.id)) throw bad('A vote is already open. Close it first.');
    let threshold = 'majority';
    if (target_type === 'legislation') {
      getLeg(c, target_id);
    } else if (target_type === 'motion') {
      const m = q('SELECT * FROM motions WHERE id = ? AND chamber_id = ?').get(Number(target_id), c.id);
      if (!m) throw notFound('Motion not found.');
      threshold = MOTIONS[m.kind].threshold;
      q(`UPDATE motions SET status = 'voting' WHERE id = ?`).run(m.id);
    } else throw bad('Vote on legislation or a motion.');
    if (req.body.threshold === 'two_thirds' || req.body.threshold === 'majority') threshold = req.body.threshold;
    q('INSERT INTO vote_rounds (chamber_id, target_type, target_id, threshold, opened_at) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, target_type, Number(target_id), threshold, now());
    return done(c);
  }));
  function tally(vid) {
    const t = { yes: 0, no: 0, abstain: 0 };
    for (const r of q('SELECT choice, COUNT(*) n FROM ballots WHERE vote_round_id = ? GROUP BY choice').all(vid)) t[r.choice] = r.n;
    return t;
  }
  function passes(t, threshold) {
    const cast = t.yes + t.no;
    if (cast === 0) return false;
    return threshold === 'two_thirds' ? t.yes * 3 >= cast * 2 : t.yes * 2 > cast;
  }
  app.post('/api/chambers/:id/votes/:vid/close', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const v = q(`SELECT * FROM vote_rounds WHERE id = ? AND chamber_id = ? AND status = 'open'`).get(Number(req.params.vid), c.id);
    if (!v) throw notFound('No open vote.');
    const cancel = (req.body || {}).cancel === true;
    const t = tally(v.id);
    const result = cancel ? 'cancelled' : (passes(t, v.threshold) ? 'passed' : 'failed');
    tx(() => {
      q(`UPDATE vote_rounds SET status = 'closed', result = ?, closed_at = ? WHERE id = ?`).run(result, now(), v.id);
      if (cancel) {
        if (v.target_type === 'motion') q(`UPDATE motions SET status = 'pending' WHERE id = ?`).run(v.target_id);
        return;
      }
      if (v.target_type === 'legislation') {
        q('UPDATE legislation SET status = ?, vote_yes = ?, vote_no = ?, vote_abstain = ? WHERE id = ?')
          .run(result, t.yes, t.no, t.abstain, v.target_id);
        if (c.current_legislation_id === v.target_id) {
          closeCurrentSpeech(c);
          q('UPDATE chambers SET current_legislation_id = NULL WHERE id = ?').run(c.id);
          q('DELETE FROM speech_requests WHERE chamber_id = ?').run(c.id);
        }
      } else {
        q('UPDATE motions SET status = ? WHERE id = ?').run(result, v.target_id);
        if (result === 'passed') applyMotion(c, q('SELECT * FROM motions WHERE id = ?').get(v.target_id));
      }
    });
    return done(c, { result, tally: t });
  }));
  // Fallback for a hand/voice vote counted by the PO instead of on devices.
  app.post('/api/chambers/:id/legislation/:lid/result', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const l = getLeg(c, req.params.lid);
    const b = req.body || {};
    if (!['passed', 'failed', 'pending'].includes(b.status)) throw bad('Bad status.');
    tx(() => {
      q('UPDATE legislation SET status = ?, vote_yes = ?, vote_no = ?, vote_abstain = ? WHERE id = ?')
        .run(b.status, b.yes ?? null, b.no ?? null, b.abstain ?? null, l.id);
      if (c.current_legislation_id === l.id) {
        closeCurrentSpeech(c);
        q('UPDATE chambers SET current_legislation_id = NULL WHERE id = ?').run(c.id);
      }
    });
    return done(c);
  }));

  app.post('/api/chambers/:id/ballot', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    if (c.po_user_id === user.id) throw bad('The presiding officer does not vote except to break a tie.');
    const { choice } = req.body || {};
    if (!['yes', 'no', 'abstain'].includes(choice)) throw bad('Vote yes, no or abstain.');
    const v = q(`SELECT * FROM vote_rounds WHERE chamber_id = ? AND status = 'open'`).get(c.id);
    if (!v) throw bad('There is no open vote.');
    q(`INSERT INTO ballots (vote_round_id, user_id, choice) VALUES (?, ?, ?)
       ON CONFLICT (vote_round_id, user_id) DO UPDATE SET choice = excluded.choice`).run(v.id, user.id, choice);
    return done(c);
  }));

  // ---------- competitor requests (rise to speak / question) ----------
  app.post('/api/chambers/:id/requests', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    const kind = (req.body || {}).kind;
    if (!['aff', 'neg', 'question'].includes(kind)) throw bad('Bad request.');
    if (c.po_user_id === user.id) throw bad('The presiding officer does not speak on legislation.');
    if (kind !== 'question') q(`DELETE FROM speech_requests WHERE chamber_id = ? AND user_id = ? AND kind IN ('aff','neg')`).run(c.id, user.id);
    q('INSERT OR REPLACE INTO speech_requests (chamber_id, user_id, kind, requested_at) VALUES (?, ?, ?, ?)').run(c.id, user.id, kind, now());
    return done(c);
  }));
  app.delete('/api/chambers/:id/requests/:kind', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    q('DELETE FROM speech_requests WHERE chamber_id = ? AND user_id = ? AND kind = ?').run(c.id, user.id, req.params.kind);
    return done(c);
  }));
  app.delete('/api/chambers/:id/requests', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    q('DELETE FROM speech_requests WHERE chamber_id = ?').run(c.id);
    return done(c);
  }));

  // ---------- precedence queue (chair can drag, reset to the rule, or draw a random starting order) ----------
  app.post('/api/chambers/:id/queue', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    const { kind, action, ids } = req.body || {};
    if (!QUEUES[kind]) throw bad('Pick the speaking or questioning list.');
    tx(() => {
      ensureQueues(c);
      const comps = competitorsWithStats(c);
      const current = [...comps].sort((a, b) => a[QUEUES[kind].col] - b[QUEUES[kind].col]).map((x) => x.id);
      if (action === 'reset') resetQueue(c, kind);
      else if (action === 'shuffle') {
        // Random draw among people tied on count; the rule still decides everything else.
        const k = QUEUES[kind];
        const shuffled = comps.map((x) => ({ ...x, seat: crypto.randomInt(1e9) }));
        setQueue(c, kind, precedence(shuffled, k.count, k.last).map((x) => x.id));
      } else if (action === 'set') {
        // The dashboard sends the visible list (it leaves out the PO); anyone left out keeps their place at the end.
        const wanted = (ids || []).map(Number);
        const known = new Set(current);
        if (!wanted.length || new Set(wanted).size !== wanted.length || !wanted.every((id) => known.has(id))) {
          throw bad('The list changed. Refresh and try again.');
        }
        setQueue(c, kind, [...wanted, ...current.filter((id) => !wanted.includes(id))]);
      } else throw bad('Unknown action.');
    });
    return done(c);
  }));

  // ---------- announcements ----------
  app.post('/api/chambers/:id/announcements', wrap((req) => {
    const { c, user } = loadChamber(req, 'chair');
    const body = String((req.body || {}).body || '').trim();
    if (!body) throw bad('Write something first.');
    q('INSERT INTO announcements (chamber_id, author_id, body, created_at) VALUES (?, ?, ?, ?)').run(c.id, user.id, body.slice(0, 1000), now());
    return done(c);
  }));
  app.delete('/api/chambers/:id/announcements/:aid', wrap((req) => {
    const { c } = loadChamber(req, 'chair');
    q('DELETE FROM announcements WHERE id = ? AND chamber_id = ?').run(Number(req.params.aid), c.id);
    return done(c);
  }));

  // ---------- judging (private to each judge) ----------
  function checkPoints(c, p) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < c.score_min || n > c.score_max) throw bad(`Points must be from ${c.score_min} to ${c.score_max}.`);
    return n;
  }
  function ballotOf(c, judgeId) {
    return q('SELECT * FROM judge_ballots WHERE chamber_id = ? AND judge_id = ?').get(c.id, judgeId)
      || { chamber_id: c.id, judge_id: judgeId, submitted_at: null, publish: 'private' };
  }
  function upsertBallot(c, judgeId, fields) {
    const b = { ...ballotOf(c, judgeId), ...fields };
    q(`INSERT INTO judge_ballots (chamber_id, judge_id, submitted_at, publish) VALUES (?, ?, ?, ?)
       ON CONFLICT (chamber_id, judge_id) DO UPDATE SET submitted_at = excluded.submitted_at, publish = excluded.publish`)
      .run(c.id, judgeId, b.submitted_at, b.publish);
  }
  function assertOpen(c, judgeId) {
    if (ballotOf(c, judgeId).submitted_at) throw bad('Your ballot is submitted. Ask an admin to reopen it to make changes.');
  }
  app.put('/api/chambers/:id/scores/:sid', wrap((req) => {
    const { c, user } = loadChamber(req, 'judge');
    assertOpen(c, user.id);
    const s = q('SELECT id FROM speeches WHERE id = ? AND chamber_id = ? AND (logged_by IS NULL OR logged_by = ?)').get(Number(req.params.sid), c.id, user.id);
    if (!s) throw notFound('Speech not found.');
    const b = req.body || {};
    if (b.points === null || b.points === '') {
      q('DELETE FROM speech_scores WHERE speech_id = ? AND judge_id = ?').run(s.id, user.id);
      return { ok: true };
    }
    q(`INSERT INTO speech_scores (speech_id, judge_id, points, comment, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (speech_id, judge_id) DO UPDATE SET points = excluded.points, comment = excluded.comment, updated_at = excluded.updated_at`)
      .run(s.id, user.id, checkPoints(c, b.points), String(b.comment || '').slice(0, 2000), now());
    return { ok: true };
  }));
  app.put('/api/chambers/:id/po-score', wrap((req) => {
    const { c, user } = loadChamber(req, 'judge');
    assertOpen(c, user.id);
    const b = req.body || {};
    const po = Number(b.po_user_id || c.po_user_id);
    if (!po) throw bad('There is no presiding officer to score.');
    q(`INSERT INTO po_scores (chamber_id, judge_id, po_user_id, points, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (chamber_id, judge_id, po_user_id) DO UPDATE SET points = excluded.points, comment = excluded.comment, updated_at = excluded.updated_at`)
      .run(c.id, user.id, po, checkPoints(c, b.points), String(b.comment || '').slice(0, 2000), now());
    return { ok: true };
  }));
  app.put('/api/chambers/:id/rankings', wrap((req) => {
    const { c, user } = loadChamber(req, 'judge');
    assertOpen(c, user.id);
    const ids = ((req.body || {}).user_ids || []).map(Number);
    if (ids.length > c.rank_count) throw bad(`Rank at most ${c.rank_count} competitors.`);
    if (new Set(ids).size !== ids.length) throw bad('Each competitor can be ranked only once.');
    const ok = q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`);
    for (const id of ids) if (!ok.get(c.id, id)) throw bad('You can only rank competitors in this chamber.');
    tx(() => {
      q('DELETE FROM rankings WHERE chamber_id = ? AND judge_id = ?').run(c.id, user.id);
      const ins = q('INSERT INTO rankings (chamber_id, judge_id, user_id, rank) VALUES (?, ?, ?, ?)');
      ids.forEach((id, i) => ins.run(c.id, user.id, id, i + 1));
    });
    return { ok: true };
  }));

  // ---------- ballots: submit, reopen, publish ----------
  app.post('/api/chambers/:id/ballot/submit', wrap((req) => {
    const { c, user } = loadChamber(req, 'judge');
    if (!q('SELECT 1 FROM rankings WHERE chamber_id = ? AND judge_id = ?').get(c.id, user.id)) throw bad('Save your ranking before submitting.');
    upsertBallot(c, user.id, { submitted_at: now() });
    return done(c);
  }));
  app.post('/api/chambers/:id/ballots/:jid/reopen', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    upsertBallot(c, Number(req.params.jid), { submitted_at: null });
    return done(c);
  }));
  // A judge publishes their own ballot; an admin can publish any ballot or the combined standings.
  // Levels: private | individual (each competitor sees only what they received) | all (everyone sees totals and rankings).
  app.post('/api/chambers/:id/publish', wrap((req) => {
    const { c, user, m } = loadChamber(req);
    const { target, judge_id, level } = req.body || {};
    if (!['private', 'individual', 'all'].includes(level)) throw bad('Pick private, each competitor, or everyone.');
    if (target === 'standings') {
      if (!m.isAdmin) throw forbidden('Only an admin can publish the standings.');
      q('UPDATE chambers SET standings_publish = ? WHERE id = ?').run(level, c.id);
    } else if (target === 'ballot') {
      const jid = Number(judge_id || user.id);
      if (!m.isAdmin && !(m.isJudge && jid === user.id)) throw forbidden('Judges can only publish their own ballot.');
      if (!q(`SELECT 1 FROM chamber_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chamber_id = ? AND u.id = ? AND u.role = 'judge'`).get(c.id, jid)) throw bad('Not a judge in this chamber.');
      upsertBallot(c, jid, { publish: level });
    } else throw bad('Publish a ballot or the standings.');
    return done(c);
  }));

  // ---------- my own speech log (chambers with no PO running the floor in the app) ----------
  function loadLogger(req) {
    const r = loadChamber(req);
    if (!r.m.isJudge && !r.m.isCompetitor) throw forbidden('Only judges and competitors in this chamber keep a speech log.');
    if (r.m.isJudge && req.method !== 'GET') assertOpen(r.c, r.user.id);
    return r;
  }
  function logFields(c, b, existing = {}) {
    const out = {};
    const has = (k) => b[k] !== undefined;
    out.speaker_id = has('speaker_id') ? Number(b.speaker_id) : existing.speaker_id;
    if (!q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`).get(c.id, out.speaker_id)) throw bad('Pick a competitor in this chamber.');
    out.side = has('side') ? b.side : existing.side;
    if (!SIDES.includes(out.side)) throw bad('Pick a side.');
    out.legislation_id = has('legislation_id') ? (b.legislation_id ? Number(b.legislation_id) : null) : (existing.legislation_id ?? null);
    if (out.legislation_id && !q('SELECT 1 FROM legislation WHERE id = ? AND chamber_id = ?').get(out.legislation_id, c.id)) throw bad('That bill is not on this docket.');
    out.topic = has('topic') ? String(b.topic || '').trim().slice(0, 200) : (existing.topic || '');
    if (out.legislation_id) out.topic = '';
    out.duration_seconds = has('duration_seconds') ? (b.duration_seconds === null ? null : Math.max(0, Math.min(3600, Math.round(Number(b.duration_seconds) || 0)))) : (existing.duration_seconds ?? null);
    return out;
  }
  app.post('/api/chambers/:id/my-log', wrap((req) => {
    const { c, user } = loadLogger(req);
    if (c.floor_mode !== 'self') throw bad('The presiding officer runs the floor in this chamber. An admin can switch it to "Each person tracks for themselves" in Setup.');
    const f = logFields(c, req.body || {});
    const r = q('INSERT INTO speeches (chamber_id, legislation_id, topic, speaker_id, side, recognized_at, duration_seconds, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, f.legislation_id, f.topic, f.speaker_id, f.side, now(), f.duration_seconds, user.id);
    return { ok: true, speech_id: Number(r.lastInsertRowid) };
  }));
  app.put('/api/chambers/:id/my-log/:sid', wrap((req) => {
    const { c, user } = loadLogger(req);
    const s = q('SELECT * FROM speeches WHERE id = ? AND chamber_id = ? AND logged_by = ?').get(Number(req.params.sid), c.id, user.id);
    if (!s) throw notFound('Speech not found.');
    const f = logFields(c, req.body || {}, s);
    q('UPDATE speeches SET legislation_id = ?, topic = ?, speaker_id = ?, side = ?, duration_seconds = ? WHERE id = ?')
      .run(f.legislation_id, f.topic, f.speaker_id, f.side, f.duration_seconds, s.id);
    if (f.speaker_id === user.id) q('DELETE FROM practice_scores WHERE speech_id = ? AND user_id = ?').run(s.id, user.id);
    return { ok: true };
  }));
  app.delete('/api/chambers/:id/my-log/:sid', wrap((req) => {
    const { c, user } = loadLogger(req);
    q('DELETE FROM speeches WHERE id = ? AND chamber_id = ? AND logged_by = ?').run(Number(req.params.sid), c.id, user.id);
    return { ok: true };
  }));

  // Questions in your own log: asked during one of your logged speeches.
  app.post('/api/chambers/:id/my-log/:sid/questions', wrap((req) => {
    const { c, user } = loadLogger(req);
    const s = q('SELECT id, speaker_id FROM speeches WHERE id = ? AND chamber_id = ? AND logged_by = ?').get(Number(req.params.sid), c.id, user.id);
    if (!s) throw notFound('Speech not found.');
    const uid = Number((req.body || {}).questioner_id);
    if (!q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`).get(c.id, uid)) throw bad('Pick a competitor in this chamber.');
    if (uid === s.speaker_id) throw bad('The speaker cannot question themselves.');
    const r = q('INSERT INTO questions (chamber_id, speech_id, questioner_id, asked_at, logged_by) VALUES (?, ?, ?, ?, ?)').run(c.id, s.id, uid, now(), user.id);
    return { ok: true, question_id: Number(r.lastInsertRowid) };
  }));
  app.delete('/api/chambers/:id/my-questions/:qid', wrap((req) => {
    const { c, user } = loadLogger(req);
    q('DELETE FROM questions WHERE id = ? AND chamber_id = ? AND logged_by = ?').run(Number(req.params.qid), c.id, user.id);
    return { ok: true };
  }));

  // ---------- question scores (judges: shown beside speech points, never added in; competitors: practice) ----------
  app.put('/api/chambers/:id/question-scores/:qid', wrap((req) => {
    const { c, user, m } = loadChamber(req);
    if (!m.isJudge && !m.isCompetitor) throw forbidden('Only judges and competitors in this chamber can score questions.');
    if (m.isJudge) assertOpen(c, user.id);
    const x = q('SELECT id, questioner_id FROM questions WHERE id = ? AND chamber_id = ? AND (logged_by IS NULL OR logged_by = ?)').get(Number(req.params.qid), c.id, user.id);
    if (!x) throw notFound('Question not found.');
    if (x.questioner_id === user.id) throw bad('You cannot score your own question.');
    const b = req.body || {};
    if (b.points === null || b.points === '') {
      q('DELETE FROM question_scores WHERE question_id = ? AND scorer_id = ?').run(x.id, user.id);
      return { ok: true };
    }
    q(`INSERT INTO question_scores (question_id, scorer_id, points, comment, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (question_id, scorer_id) DO UPDATE SET points = excluded.points, comment = excluded.comment, updated_at = excluded.updated_at`)
      .run(x.id, user.id, checkPoints(c, b.points), String(b.comment || '').slice(0, 2000), now());
    return { ok: true };
  }));

  // ---------- practice ballots (competitors score for reflection; never counted) ----------
  app.put('/api/chambers/:id/practice/scores/:sid', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    const s = q('SELECT id, speaker_id FROM speeches WHERE id = ? AND chamber_id = ? AND (logged_by IS NULL OR logged_by = ?)').get(Number(req.params.sid), c.id, user.id);
    if (!s) throw notFound('Speech not found.');
    if (s.speaker_id === user.id) throw bad('You cannot score your own speech.');
    const b = req.body || {};
    if (b.points === null || b.points === '') {
      q('DELETE FROM practice_scores WHERE speech_id = ? AND user_id = ?').run(s.id, user.id);
      return { ok: true };
    }
    q(`INSERT INTO practice_scores (speech_id, user_id, points, comment, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (speech_id, user_id) DO UPDATE SET points = excluded.points, comment = excluded.comment, updated_at = excluded.updated_at`)
      .run(s.id, user.id, checkPoints(c, b.points), String(b.comment || '').slice(0, 2000), now());
    return { ok: true };
  }));
  app.put('/api/chambers/:id/practice/rankings', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    const ids = ((req.body || {}).user_ids || []).map(Number);
    if (ids.length > c.rank_count) throw bad(`Rank at most ${c.rank_count} competitors.`);
    if (new Set(ids).size !== ids.length) throw bad('Each competitor can be ranked only once.');
    const ok = q(`SELECT 1 FROM chamber_members m JOIN users u ON u.id = m.user_id WHERE m.chamber_id = ? AND u.id = ? AND u.role = 'competitor'`);
    for (const id of ids) if (!ok.get(c.id, id)) throw bad('You can only rank competitors in this chamber.');
    tx(() => {
      q('DELETE FROM practice_rankings WHERE chamber_id = ? AND user_id = ?').run(c.id, user.id);
      const ins = q('INSERT INTO practice_rankings (chamber_id, user_id, ranked_user_id, rank) VALUES (?, ?, ?, ?)');
      ids.forEach((id, i) => ins.run(c.id, user.id, id, i + 1));
    });
    return { ok: true };
  }));

  // What a competitor may see after publishing: their own practice ballot, plus anything a judge or admin published.
  app.get('/api/chambers/:id/reflection', wrap((req) => {
    const { c, user } = loadChamber(req, 'competitor');
    const judges = q(`SELECT u.id, u.display_name FROM chamber_members m JOIN users u ON u.id = m.user_id
                      WHERE m.chamber_id = ? AND u.role = 'judge' ORDER BY u.display_name`).all(c.id);
    const comps = competitorsWithStats(c);
    const nameOf = new Map(comps.map((x) => [x.id, x.display_name]));
    const practice = {
      scores: q(`SELECT p.speech_id, p.points, p.comment, s.speaker_id FROM practice_scores p JOIN speeches s ON s.id = p.speech_id
                 WHERE s.chamber_id = ? AND p.user_id = ?`).all(c.id, user.id),
      ranking: q('SELECT ranked_user_id FROM practice_rankings WHERE chamber_id = ? AND user_id = ? ORDER BY rank').all(c.id, user.id).map((r) => r.ranked_user_id),
    };
    const ballots = [];
    for (const j of judges) {
      const b = ballotOf(c, j.id);
      if (b.publish === 'private') continue;
      const mine = q(`SELECT ss.speech_id, ss.points, ss.comment FROM speech_scores ss JOIN speeches s ON s.id = ss.speech_id
                      WHERE s.chamber_id = ? AND ss.judge_id = ? AND s.speaker_id = ?`).all(c.id, j.id, user.id);
      const po = q('SELECT points, comment FROM po_scores WHERE chamber_id = ? AND judge_id = ? AND po_user_id = ?').get(c.id, j.id, user.id) || null;
      const myRank = q('SELECT rank FROM rankings WHERE chamber_id = ? AND judge_id = ? AND user_id = ?').get(c.id, j.id, user.id)?.rank ?? null;
      const myQ = q(`SELECT qs.question_id, qs.points, qs.comment FROM question_scores qs JOIN questions x ON x.id = qs.question_id
                     WHERE x.chamber_id = ? AND qs.scorer_id = ? AND x.questioner_id = ?`).all(c.id, j.id, user.id);
      const entry = { judge_id: j.id, judge_name: j.display_name, level: b.publish, my_scores: mine, my_question_scores: myQ, my_po_score: po, my_rank: myRank };
      if (b.publish === 'all') {
        // Everyone sees each competitor's point total and the judge's ranking, not other people's comments.
        const totals = new Map();
        for (const r of q(`SELECT s.speaker_id uid, ss.points FROM speech_scores ss JOIN speeches s ON s.id = ss.speech_id WHERE s.chamber_id = ? AND ss.judge_id = ?`).all(c.id, j.id)) totals.set(r.uid, (totals.get(r.uid) || 0) + r.points);
        for (const r of q('SELECT po_user_id uid, points FROM po_scores WHERE chamber_id = ? AND judge_id = ?').all(c.id, j.id)) totals.set(r.uid, (totals.get(r.uid) || 0) + r.points);
        entry.totals = comps.map((x) => ({ id: x.id, name: x.display_name, points: totals.get(x.id) || 0 }));
        entry.ranking = q('SELECT user_id FROM rankings WHERE chamber_id = ? AND judge_id = ? ORDER BY rank').all(c.id, j.id).map((r) => ({ id: r.user_id, name: nameOf.get(r.user_id) }));
      }
      ballots.push(entry);
    }
    let standings = null;
    if (c.standings_publish !== 'private') {
      const r = computeResults(c);
      const strip = (x) => ({ place: x.place, id: x.id, name: x.name, school: x.school, was_po: x.was_po, speeches: x.speeches, total_points: x.total_points, average_points: x.average_points, rank_total: x.rank_total });
      standings = { level: c.standings_publish, rows: c.standings_publish === 'all' ? r.rows.map(strip) : r.rows.filter((x) => x.id === user.id).map(strip), of: r.rows.length };
    }
    return { practice, ballots, standings, rank_count: c.rank_count };
  }));

  // ---------- state (what each role sees) ----------
  function competitorsWithStats(c) {
    const rows = q(`SELECT u.id, u.display_name, u.school, m.seat, m.speak_pos, m.question_pos FROM chamber_members m JOIN users u ON u.id = m.user_id
                    WHERE m.chamber_id = ? AND u.role = 'competitor' ORDER BY m.seat, u.display_name`).all(c.id);
    const sp = new Map(q(`SELECT speaker_id, COUNT(*) n, MAX(recognized_at) last FROM speeches WHERE chamber_id = ? AND logged_by IS NULL GROUP BY speaker_id`).all(c.id).map((r) => [r.speaker_id, r]));
    const qs = new Map(q(`SELECT questioner_id, COUNT(*) n, MAX(asked_at) last FROM questions WHERE chamber_id = ? AND logged_by IS NULL GROUP BY questioner_id`).all(c.id).map((r) => [r.questioner_id, r]));
    return rows.map((r) => ({
      ...r,
      is_po: r.id === c.po_user_id,
      speeches: sp.get(r.id)?.n || 0,
      last_speech_at: sp.get(r.id)?.last || null,
      questions: qs.get(r.id)?.n || 0,
      last_question_at: qs.get(r.id)?.last || null,
    }));
  }
  // Precedence: fewest speeches first, then whoever spoke least recently (never spoken beats any), then seat order.
  function precedence(list, countKey, lastKey) {
    return [...list].sort((a, b) => (a[countKey] - b[countKey])
      || ((a[lastKey] ?? -1) - (b[lastKey] ?? -1))
      || ((a.seat ?? 0) - (b.seat ?? 0)));
  }

  // The live precedence list is a stored queue. It starts in rule order (fewest speeches, then least
  // recent, then seat), each speaker or questioner moves to the bottom, and the chair can drag to adjust.
  // Moving the speaker to the bottom is exactly the standard rule, so the queue only differs when someone drags.
  const QUEUES = {
    speak: { col: 'speak_pos', count: 'speeches', last: 'last_speech_at' },
    question: { col: 'question_pos', count: 'questions', last: 'last_question_at' },
  };
  function setQueue(c, kind, ids) {
    const upd = q(`UPDATE chamber_members SET ${QUEUES[kind].col} = ? WHERE chamber_id = ? AND user_id = ?`);
    ids.forEach((id, i) => upd.run(i + 1, c.id, id));
  }
  function resetQueue(c, kind) {
    const k = QUEUES[kind];
    setQueue(c, kind, precedence(competitorsWithStats(c), k.count, k.last).map((x) => x.id));
  }
  // New members (or a database from before queues existed) get placed by the rule.
  function ensureQueues(c) {
    const comps = competitorsWithStats(c);
    for (const [kind, k] of Object.entries(QUEUES)) {
      const missing = comps.filter((x) => x[k.col] == null);
      if (!missing.length) continue;
      if (missing.length === comps.length) { resetQueue(c, kind); continue; }
      const max = Math.max(...comps.map((x) => x[k.col] ?? 0));
      const upd = q(`UPDATE chamber_members SET ${k.col} = ? WHERE chamber_id = ? AND user_id = ?`);
      precedence(missing, k.count, k.last).forEach((x, i) => upd.run(max + i + 1, c.id, x.id));
    }
  }
  function moveToEnd(c, kind, uid) {
    const col = QUEUES[kind].col;
    const max = q(`SELECT COALESCE(MAX(${col}), 0) m FROM chamber_members WHERE chamber_id = ?`).get(c.id).m;
    q(`UPDATE chamber_members SET ${col} = ? WHERE chamber_id = ? AND user_id = ?`).run(max + 1, c.id, uid);
  }

  app.get('/api/chambers/:id/state', wrap((req) => {
    const { c, user, m } = loadChamber(req);
    ensureQueues(c);
    const comps = competitorsWithStats(c);
    const speakers = comps.filter((x) => !x.is_po);
    const nameOf = new Map(comps.map((x) => [x.id, x.display_name]));
    const judges = q(`SELECT u.id, u.display_name, u.school FROM chamber_members m JOIN users u ON u.id = m.user_id
                      WHERE m.chamber_id = ? AND u.role = 'judge' ORDER BY u.display_name`).all(c.id);
    const legislation = q('SELECT * FROM legislation WHERE chamber_id = ? ORDER BY docket_order, id').all(c.id);
    // Everyone sees the official record; a speech someone logged for themselves is only theirs.
    const speechRows = q(`SELECT s.*, u.display_name speaker_name, COALESCE(l.title, NULLIF(s.topic, ''), 'No bill picked') legislation_title FROM speeches s
                        JOIN users u ON u.id = s.speaker_id LEFT JOIN legislation l ON l.id = s.legislation_id
                        WHERE s.chamber_id = ? AND (s.logged_by IS NULL OR s.logged_by = ?) ORDER BY s.recognized_at`).all(c.id, user.id);
    const speeches = speechRows.filter((x) => x.logged_by == null);
    const my_log = speechRows.filter((x) => x.logged_by != null).map((x) => ({ ...x, mine: true }));
    const questionRows = q(`SELECT q.id, q.speech_id, q.questioner_id, q.asked_at, q.logged_by FROM questions q
                            WHERE q.chamber_id = ? AND (q.logged_by IS NULL OR q.logged_by = ?) ORDER BY q.asked_at`).all(c.id, user.id)
      .map((x) => ({ ...x, questioner_name: nameOf.get(x.questioner_id) }));
    const questions = questionRows.filter((x) => x.logged_by == null);
    const my_questions = questionRows.filter((x) => x.logged_by != null);
    const requests = q('SELECT user_id, kind, requested_at FROM speech_requests WHERE chamber_id = ? ORDER BY requested_at').all(c.id)
      .map((x) => ({ ...x, name: nameOf.get(x.user_id) }));
    const motions = q('SELECT * FROM motions WHERE chamber_id = ? ORDER BY created_at DESC').all(c.id)
      .map((x) => ({ ...x, label: MOTIONS[x.kind]?.label || x.kind, mover_name: nameOf.get(x.mover_id) || null }));
    const announcements = q('SELECT id, body, created_at FROM announcements WHERE chamber_id = ? ORDER BY created_at DESC LIMIT 20').all(c.id);

    const targetLabel = (v) => v.target_type === 'legislation'
      ? (legislation.find((l) => l.id === v.target_id)?.title || 'Legislation')
      : (motions.find((x) => x.id === v.target_id)?.label || 'Motion');
    const openRow = q(`SELECT * FROM vote_rounds WHERE chamber_id = ? AND status = 'open'`).get(c.id);
    let open_vote = null;
    if (openRow) {
      const t = tally(openRow.id);
      const mine = q('SELECT choice FROM ballots WHERE vote_round_id = ? AND user_id = ?').get(openRow.id, user.id);
      open_vote = {
        id: openRow.id, target_type: openRow.target_type, target_id: openRow.target_id, label: targetLabel(openRow),
        threshold: openRow.threshold, eligible: speakers.length, cast: t.yes + t.no + t.abstain,
        my_choice: mine?.choice || null, tally: m.canChair ? t : null,
      };
    }
    const past_votes = q(`SELECT * FROM vote_rounds WHERE chamber_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 15`).all(c.id)
      .map((v) => ({ id: v.id, label: targetLabel(v), target_type: v.target_type, result: v.result, threshold: v.threshold, tally: tally(v.id) }));

    // Suggested next side on the current item: authorship first, then alternate.
    let next_side = null;
    if (c.current_legislation_id) {
      const onItem = speeches.filter((s) => s.legislation_id === c.current_legislation_id);
      const last = onItem[onItem.length - 1];
      next_side = !last ? 'authorship' : (last.side === 'neg' ? 'aff' : 'neg');
    }

    const out = {
      server_now: Date.now(),
      me: { id: user.id, name: user.display_name, role: user.role, ...m },
      chamber: {
        id: c.id, name: c.name, status: c.status, po_user_id: c.po_user_id, po_name: nameOf.get(c.po_user_id) || null,
        current_legislation_id: c.current_legislation_id, current_speech_id: c.current_speech_id,
        score_min: c.score_min, score_max: c.score_max, rank_count: c.rank_count,
        speech_seconds: c.speech_seconds, authorship_question_seconds: c.authorship_question_seconds, question_seconds: c.question_seconds,
        timer: c.timer_duration == null ? null : {
          label: c.timer_label, duration: c.timer_duration, running: !!c.timer_started_at,
          started_at: c.timer_started_at, elapsed_ms: c.timer_elapsed_ms,
        },
        next_side,
        floor_mode: c.floor_mode,
      },
      competitors: comps,
      judges,
      speaking_precedence: [...speakers].sort((a, b) => a.speak_pos - b.speak_pos).map((x) => x.id),
      question_precedence: [...speakers].sort((a, b) => a.question_pos - b.question_pos).map((x) => x.id),
      speaking_rule_order: precedence(speakers, 'speeches', 'last_speech_at').map((x) => x.id),
      question_rule_order: precedence(speakers, 'questions', 'last_question_at').map((x) => x.id),
      is_mock: !!c.is_mock,
      view_as_options: m.realIsAdmin && c.is_mock
        ? q(`SELECT id, display_name, role FROM users WHERE mock_chamber_id = ? ORDER BY role DESC, display_name`).all(c.id)
          .map((u) => ({ ...u, is_po: u.id === c.po_user_id }))
        : null,
      legislation, speeches, my_log, questions, my_questions, requests, motions, announcements, open_vote, past_votes,
      motion_kinds: Object.entries(MOTIONS).map(([k, v]) => ({ kind: k, ...v })),
    };
    if (m.isJudge || m.isCompetitor) {
      out.my_question_scores = Object.fromEntries(q(`SELECT qs.question_id, qs.points, qs.comment FROM question_scores qs JOIN questions x ON x.id = qs.question_id
                                                     WHERE x.chamber_id = ? AND qs.scorer_id = ?`).all(c.id, user.id).map((r) => [r.question_id, { points: r.points, comment: r.comment }]));
    }
    if (m.isJudge) {
      out.my_scores = Object.fromEntries(q(`SELECT ss.speech_id, ss.points, ss.comment FROM speech_scores ss JOIN speeches s ON s.id = ss.speech_id
                                            WHERE s.chamber_id = ? AND ss.judge_id = ?`).all(c.id, user.id).map((r) => [r.speech_id, { points: r.points, comment: r.comment }]));
      out.my_po_scores = q('SELECT po_user_id, points, comment FROM po_scores WHERE chamber_id = ? AND judge_id = ?').all(c.id, user.id);
      out.my_rankings = q('SELECT user_id FROM rankings WHERE chamber_id = ? AND judge_id = ? ORDER BY rank').all(c.id, user.id).map((r) => r.user_id);
      out.my_ballot = ballotOf(c, user.id);
    }
    if (m.isCompetitor) {
      out.my_practice_scores = Object.fromEntries(q(`SELECT p.speech_id, p.points, p.comment FROM practice_scores p JOIN speeches s ON s.id = p.speech_id
                                                     WHERE s.chamber_id = ? AND p.user_id = ?`).all(c.id, user.id).map((r) => [r.speech_id, { points: r.points, comment: r.comment }]));
      out.my_practice_rankings = q('SELECT ranked_user_id FROM practice_rankings WHERE chamber_id = ? AND user_id = ? ORDER BY rank').all(c.id, user.id).map((r) => r.ranked_user_id);
      out.published = {
        ballots: q(`SELECT COUNT(*) n FROM judge_ballots WHERE chamber_id = ? AND publish != 'private'`).get(c.id).n,
        standings: c.standings_publish,
      };
    }
    return out;
  }));

  // ---------- results (admin only) ----------
  function computeResults(c) {
    const comps = competitorsWithStats(c);
    const judges = q(`SELECT u.id, u.display_name FROM chamber_members m JOIN users u ON u.id = m.user_id
                      WHERE m.chamber_id = ? AND u.role = 'judge' ORDER BY u.display_name`).all(c.id);
    const scores = q(`SELECT s.speaker_id, ss.judge_id, ss.points FROM speech_scores ss JOIN speeches s ON s.id = ss.speech_id WHERE s.chamber_id = ?`).all(c.id);
    const po = q('SELECT judge_id, po_user_id, points FROM po_scores WHERE chamber_id = ?').all(c.id);
    const ranks = q('SELECT judge_id, user_id, rank FROM rankings WHERE chamber_id = ?').all(c.id);
    const unranked = c.rank_count + 1;
    // Without a PO in the app there is no official record, so count speeches from the judges' own logs.
    const logged = new Map();
    for (const r of q(`SELECT speaker_id, logged_by, COUNT(*) n FROM speeches s JOIN users u ON u.id = s.logged_by
                       WHERE s.chamber_id = ? AND u.role = 'judge' GROUP BY speaker_id, logged_by`).all(c.id)) logged.set(r.speaker_id, Math.max(logged.get(r.speaker_id) || 0, r.n));
    const qPoints = new Map(q(`SELECT x.questioner_id uid, SUM(qs.points) pts, COUNT(*) n FROM question_scores qs JOIN questions x ON x.id = qs.question_id
                                JOIN users u ON u.id = qs.scorer_id WHERE x.chamber_id = ? AND u.role = 'judge' GROUP BY x.questioner_id`).all(c.id).map((r) => [r.uid, r]));
    const rows = comps.map((p) => {
      const mine = scores.filter((s) => s.speaker_id === p.id);
      const poMine = po.filter((s) => s.po_user_id === p.id);
      const all = [...mine, ...poMine];
      const total = all.reduce((a, s) => a + s.points, 0);
      const by_judge = judges.map((j) => {
        const r = ranks.find((x) => x.judge_id === j.id && x.user_id === p.id);
        return { judge_id: j.id, rank: r ? r.rank : null, points: all.filter((s) => s.judge_id === j.id).reduce((a, s) => a + s.points, 0) };
      });
      const judgesWhoRanked = judges.filter((j) => ranks.some((r) => r.judge_id === j.id));
      const rank_total = judgesWhoRanked.reduce((a, j) => a + (by_judge.find((b) => b.judge_id === j.id).rank ?? unranked), 0);
      return {
        id: p.id, name: p.display_name, school: p.school, was_po: poMine.length > 0 || p.is_po,
        speeches: p.speeches || logged.get(p.id) || 0, questions: p.questions,
        total_points: total, question_points: qPoints.get(p.id)?.pts || 0, questions_scored: qPoints.get(p.id)?.n || 0, average_points: all.length ? Math.round((total / all.length) * 100) / 100 : null,
        rank_total, by_judge,
      };
    });
    // Order by sum of judge ranks (lower is better), then total points.
    rows.sort((a, b) => (a.rank_total - b.rank_total) || (b.total_points - a.total_points) || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.place = i + 1; });
    const progress = judges.map((j) => ({
      judge_id: j.id, name: j.display_name, submitted_at: ballotOf(c, j.id).submitted_at, publish: ballotOf(c, j.id).publish,
      scored: scores.filter((s) => s.judge_id === j.id).length,
      ranked: ranks.filter((r) => r.judge_id === j.id).length,
      po_scored: po.some((s) => s.judge_id === j.id),
    }));
    return { judges, rows, progress, standings_publish: c.standings_publish, total_speeches: q('SELECT COUNT(*) n FROM speeches WHERE chamber_id = ? AND logged_by IS NULL').get(c.id).n, unranked_value: unranked };
  }
  app.get('/api/chambers/:id/results', wrap((req) => {
    const { c } = loadChamber(req, 'admin');
    return computeResults(c);
  }));
  app.get('/api/chambers/:id/results.csv', wrap((req, res) => {
    const { c } = loadChamber(req, 'admin');
    const r = computeResults(c);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Place', 'Name', 'School', 'Speeches', 'Questions', 'Total points', 'Average', 'Rank total', 'Question points (not in total)',
      ...r.judges.flatMap((j) => [`${j.display_name} rank`, `${j.display_name} points`])];
    const lines = [head.map(esc).join(',')];
    for (const row of r.rows) {
      lines.push([row.place, row.name + (row.was_po ? ' (PO)' : ''), row.school, row.speeches, row.questions, row.total_points, row.average_points, row.rank_total, row.question_points,
        ...row.by_judge.flatMap((b) => [b.rank ?? '', b.points])].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="chamber-${c.id}-results.csv"`);
    res.send(lines.join('\n'));
  }));

  // ---------- mock tournament (admin) ----------
  const MOCK_NAMES = ['Avery Johnson', 'Blake Nguyen', 'Casey Patel', 'Dana Morales', 'Emery Brooks', 'Finley Okafor',
    'Gray Thompson', 'Harper Liu', 'Indy Ramirez', 'Jules Andersen', 'Kai Robinson', 'Logan Schmidt', 'Morgan Diaz', 'Noel Kim'];
  const MOCK_SCHOOLS = ['Lincoln HS', 'Roosevelt HS', 'Garfield HS', 'Kennedy HS'];
  const MOCK_BILLS = [
    ['A Bill to Require Financial Literacy Instruction in Public High Schools', 'bill'],
    ['A Resolution to Rejoin the Trans-Pacific Partnership', 'resolution'],
    ['A Bill to Fund High-Speed Rail in the Pacific Northwest', 'bill'],
    ['A Bill to Lower the Federal Voting Age to Sixteen', 'bill'],
  ];
  app.post('/api/mock', wrap((req) => {
    requireAdmin(req);
    const size = Math.min(Math.max(Number((req.body || {}).competitors) || 12, 4), MOCK_NAMES.length);
    const password = 'practice';
    const id = tx(() => {
      const label = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      const cid = Number(q(`INSERT INTO chambers (name, is_mock) VALUES (?, 1)`).run(`Mock tournament (${label})`).lastInsertRowid);
      const hash = hashPassword(password);
      const mk = (name, school, role) => {
        const uname = makeUsername(`mock.${name.split(' ')[0]}`);
        const uid = Number(q('INSERT INTO users (username, display_name, school, role, password_hash, mock_chamber_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uname, name, school, role, hash, cid).lastInsertRowid);
        return uid;
      };
      const ins = q('INSERT INTO chamber_members (chamber_id, user_id, seat) VALUES (?, ?, ?)');
      const comps = MOCK_NAMES.slice(0, size).map((n, i) => mk(n, MOCK_SCHOOLS[i % MOCK_SCHOOLS.length], 'competitor'));
      comps.forEach((uid, i) => ins.run(cid, uid, i + 1));
      ['Judge Rivera', 'Judge Chen'].forEach((n) => ins.run(cid, mk(n, '', 'judge'), null));
      q('UPDATE chambers SET po_user_id = ? WHERE id = ?').run(comps[comps.length - 1], cid);
      const legIns = q('INSERT INTO legislation (chamber_id, title, kind, author, body, docket_order) VALUES (?, ?, ?, ?, ?, ?)');
      MOCK_BILLS.forEach(([t, k], i) => legIns.run(cid, t, k, MOCK_SCHOOLS[i % MOCK_SCHOOLS.length], 'Sample text for practice.', i + 1));
      return cid;
    });
    return { id, password };
  }));

  // ---------- personal trackers (private to their owner) ----------
  function getTracker(req) {
    const u = requireUser(req);
    const t = q('SELECT * FROM trackers WHERE id = ? AND owner_id = ?').get(Number(req.params.tid), u.id);
    if (!t) throw notFound('Tracker not found.');
    return t;
  }
  app.get('/api/trackers', wrap((req) => {
    const u = requireUser(req);
    return { trackers: q('SELECT id, name, updated_at FROM trackers WHERE owner_id = ? ORDER BY updated_at DESC').all(u.id) };
  }));
  app.post('/api/trackers', wrap((req) => {
    const u = requireUser(req);
    const name = String((req.body || {}).name || '').trim().slice(0, 100) || 'My chamber';
    const r = q('INSERT INTO trackers (owner_id, name, data, updated_at) VALUES (?, ?, ?, ?)').run(u.id, name, '{}', now());
    return { id: Number(r.lastInsertRowid) };
  }));
  app.get('/api/trackers/:tid', wrap((req) => {
    const t = getTracker(req);
    return { id: t.id, name: t.name, data: JSON.parse(t.data || '{}'), updated_at: t.updated_at };
  }));
  app.put('/api/trackers/:tid', wrap((req) => {
    const t = getTracker(req);
    const b = req.body || {};
    const data = b.data === undefined ? t.data : JSON.stringify(b.data);
    if (data.length > 500000) throw bad('This tracker is too large.');
    const name = b.name === undefined ? t.name : (String(b.name).trim().slice(0, 100) || t.name);
    q('UPDATE trackers SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(name, data, now(), t.id);
    return { ok: true };
  }));
  app.delete('/api/trackers/:tid', wrap((req) => {
    const t = getTracker(req);
    q('DELETE FROM trackers WHERE id = ?').run(t.id);
    return { ok: true };
  }));

  app.get('/api/chambers/:id/events', (req, res) => {
    try { loadChamber(req); } catch (e) { return res.status(e.status || 500).end(); }
    const id = Number(req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(res);
    req.on('close', () => listeners.get(id)?.delete(res));
  });

  // ---------- tournament packets: read a PDF or Word file (uploaded or linked) into bills ----------
  const packet = require('./packet');
  app.post('/api/packet/read', express.raw({ type: ['application/octet-stream', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], limit: '25mb' }), async (req, res) => {
    try {
      requireUser(req);
      let out;
      if (Buffer.isBuffer(req.body) && req.body.length) out = { items: await packet.parsePacket(req.body, String(req.query.name || '')), source: String(req.query.name || '') };
      else {
        const url = String((req.body || {}).url || '').trim();
        if (!url) throw bad('Paste a link or pick a file.');
        out = await packet.readLink(url, require('./teams').privateAddress);
      }
      if (out.items && !out.items.length) throw bad('No bills or resolutions were found in that file. If it is a scanned image, ask the tournament for a text version.');
      res.json(out);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.status ? e.message : `Could not read that packet (${e.name === 'TimeoutError' ? 'it took too long' : e.message}).` });
    }
  });
  require('./teams')(app, { db, q, tx, wrap, requireUser, bad, forbidden, notFound, hashPassword, startSession, makeUsername, now, cleanPacketItems });
  // Restoring: close the database, let open() swap in the staged file, and carry on with the restored data.
  function reopen() {
    db.close();
    db = require('./db').open(dbFile);
    require('./teams').schema(db);
  }
  const backups = require('./backup')(app, { getDb: () => db, q, wrap, requireAdmin, bad, notFound, dbFile, backupDir, reopen });
  // Learning aids shipped with the app, loaded once into the real database (never into test databases).
  if (dbFile && dbFile !== ':memory:') {
    try { require('./aiseed').runAiSeeds(db, { backup: () => backups.create('manual') }); } catch (e) { console.error('AI seed failed:', e.message); }
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.locals.close = () => { clearInterval(heartbeat); backups.stop(); };
  return app;
}

module.exports = { createApp, hashPassword };
