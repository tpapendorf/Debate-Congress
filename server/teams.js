'use strict';
// Teams: join codes with leader approval, shared bill research, private speech plans and notes, progress.
const crypto = require('node:crypto');

const SECTIONS = ['aff', 'neg', 'evidence', 'question'];
const PLAN_STATUS = ['idea', 'drafting', 'ready', 'delivered'];

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      school TEXT NOT NULL DEFAULT '',
      join_code TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('coach','captain','member')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS team_bills (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'bill',
      source TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES team_bills(id) ON DELETE CASCADE,
      section TEXT NOT NULL CHECK (section IN ('aff','neg','evidence','question')),
      side TEXT NOT NULL DEFAULT 'both' CHECK (side IN ('aff','neg','both')),
      text TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      cite_source TEXT NOT NULL DEFAULT '',
      cite_author TEXT NOT NULL DEFAULT '',
      cite_date TEXT NOT NULL DEFAULT '',
      cite_url TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS speech_plans (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bill_id INTEGER REFERENCES team_bills(id) ON DELETE SET NULL,
      side TEXT NOT NULL DEFAULT 'aff',
      title TEXT NOT NULL,
      tournament TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idea',
      outline TEXT NOT NULL DEFAULT '',
      shared_with_leaders INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_notes (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bill_id INTEGER REFERENCES team_bills(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress_entries (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL DEFAULT '',
      tournament TEXT NOT NULL DEFAULT '',
      bill TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL DEFAULT '',
      points TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_goals (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

module.exports = function mountTeams(app, h) {
  const { db, q, tx, wrap, requireUser, bad, forbidden, notFound, hashPassword, startSession, makeUsername } = h;
  schema(db);
  const now = () => Date.now();
  const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);

  function newCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += abc[crypto.randomInt(abc.length)];
      if (!q('SELECT 1 FROM teams WHERE join_code = ?').get(c)) return c;
    }
  }
  const findByCode = (code) => q('SELECT * FROM teams WHERE join_code = ?').get(str(code, 20).toUpperCase().replace(/[^A-Z0-9]/g, ''));

  // Access: 'member' = any approved member; 'leader' = coach or captain; 'coach' = coach only. Site admins count as coaches.
  function loadTeam(req, need = 'member') {
    const user = requireUser(req);
    const team = q('SELECT * FROM teams WHERE id = ?').get(Number(req.params.tid));
    if (!team) throw notFound('Team not found.');
    const mem = q('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, user.id);
    const active = mem?.status === 'active';
    const role = user.role === 'admin' ? 'coach' : (active ? mem.role : null);
    const isLeader = role === 'coach' || role === 'captain';
    if (!role) throw forbidden(mem ? 'A coach or captain still needs to approve you.' : 'You are not on this team.');
    if (need === 'leader' && !isLeader) throw forbidden('Only coaches and captains can do that.');
    if (need === 'coach' && role !== 'coach') throw forbidden('Only coaches can do that.');
    return { user, team, role, isLeader };
  }
  function getBill(team, bid) {
    const b = q('SELECT * FROM team_bills WHERE id = ? AND team_id = ?').get(Number(bid), team.id);
    if (!b) throw notFound('Bill not found.');
    return b;
  }
  const memberRow = (team, uid) => q(`SELECT tm.*, u.display_name, u.school, u.username FROM team_members tm JOIN users u ON u.id = tm.user_id
                                      WHERE tm.team_id = ? AND tm.user_id = ?`).get(team.id, uid);

  // ---------- sign up with a join code (no account needed yet) ----------
  app.get('/api/join/:code', wrap((req) => {
    const t = findByCode(req.params.code);
    if (!t) throw notFound('That join code does not match a team.');
    return { team: { name: t.name, school: t.school } };
  }));
  app.post('/api/signup', wrap((req, res) => {
    const b = req.body || {};
    const t = findByCode(b.code);
    if (!t) throw bad('That join code does not match a team. Check it with your coach.');
    const name = str(b.display_name, 100);
    if (!name) throw bad('Enter your name.');
    if (!b.password || String(b.password).length < 6) throw bad('Choose a password of at least 6 characters.');
    const username = b.username ? str(b.username, 60) : makeUsername(name);
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken. Try another.');
    const uid = tx(() => {
      const id = Number(q(`INSERT INTO users (username, display_name, school, role, password_hash) VALUES (?, ?, ?, 'competitor', ?)`)
        .run(username, name, str(b.school, 100) || t.school, hashPassword(String(b.password))).lastInsertRowid);
      q(`INSERT INTO team_members (team_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'pending', ?)`).run(t.id, id, now());
      return id;
    });
    startSession(res, uid);
    return { ok: true, team_id: t.id, username };
  }));

  // ---------- my teams ----------
  app.get('/api/teams', wrap((req) => {
    const u = requireUser(req);
    const mine = q(`SELECT t.id, t.name, t.school, tm.role, tm.status FROM team_members tm JOIN teams t ON t.id = tm.team_id
                    WHERE tm.user_id = ? ORDER BY t.name`).all(u.id);
    const all = u.role === 'admin'
      ? q('SELECT id, name, school FROM teams ORDER BY name').all().filter((t) => !mine.some((m) => m.id === t.id)).map((t) => ({ ...t, role: 'coach', status: 'active', via_admin: true }))
      : [];
    return { teams: [...mine, ...all] };
  }));
  app.post('/api/teams', wrap((req) => {
    const u = requireUser(req);
    const name = str((req.body || {}).name, 100);
    if (!name) throw bad('Name the team.');
    const id = tx(() => {
      const tid = Number(q('INSERT INTO teams (name, school, join_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, str((req.body || {}).school, 100), newCode(), u.id, now()).lastInsertRowid);
      q(`INSERT INTO team_members (team_id, user_id, role, status, joined_at) VALUES (?, ?, 'coach', 'active', ?)`).run(tid, u.id, now());
      return tid;
    });
    return { id };
  }));
  app.post('/api/teams/join', wrap((req) => {
    const u = requireUser(req);
    const t = findByCode((req.body || {}).code);
    if (!t) throw bad('That join code does not match a team.');
    if (q('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(t.id, u.id)) return { id: t.id, already: true };
    q(`INSERT INTO team_members (team_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'pending', ?)`).run(t.id, u.id, now());
    return { id: t.id };
  }));

  app.get('/api/teams/:tid', wrap((req) => {
    const { user, team, role, isLeader } = loadTeam(req);
    const members = q(`SELECT tm.user_id id, tm.role, tm.status, tm.joined_at, u.display_name name, u.school FROM team_members tm
                       JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.status DESC, tm.role, u.display_name`).all(team.id)
      .filter((m) => isLeader || m.status === 'active');
    const bills = q(`SELECT b.id, b.title, b.kind, b.source, b.updated_at,
                       (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id AND i.section = 'aff') aff,
                       (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id AND i.section = 'neg') neg,
                       (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id AND i.section = 'evidence') evidence,
                       (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id AND i.section = 'question') questions
                     FROM team_bills b WHERE b.team_id = ? ORDER BY b.updated_at DESC`).all(team.id);
    return {
      team: { id: team.id, name: team.name, school: team.school, join_code: isLeader ? team.join_code : null },
      me: { id: user.id, role, isLeader, isCoach: role === 'coach' },
      members, bills,
    };
  }));
  app.put('/api/teams/:tid', wrap((req) => {
    const { team } = loadTeam(req, 'coach');
    const b = req.body || {};
    q('UPDATE teams SET name = ?, school = ? WHERE id = ?').run(str(b.name ?? team.name, 100) || team.name, str(b.school ?? team.school, 100), team.id);
    return { ok: true };
  }));
  app.post('/api/teams/:tid/code', wrap((req) => {
    const { team } = loadTeam(req, 'leader');
    const code = newCode();
    q('UPDATE teams SET join_code = ? WHERE id = ?').run(code, team.id);
    return { join_code: code };
  }));
  app.delete('/api/teams/:tid', wrap((req) => {
    const { team } = loadTeam(req, 'coach');
    q('DELETE FROM teams WHERE id = ?').run(team.id);
    return { ok: true };
  }));

  // ---------- members ----------
  app.post('/api/teams/:tid/members/:uid', wrap((req) => {
    const { team, role, user } = loadTeam(req, 'leader');
    const target = memberRow(team, Number(req.params.uid));
    if (!target) throw notFound('Not on this team.');
    const b = req.body || {};
    if (b.action === 'approve') {
      q(`UPDATE team_members SET status = 'active' WHERE team_id = ? AND user_id = ?`).run(team.id, target.user_id);
    } else if (b.action === 'role') {
      if (role !== 'coach') throw forbidden('Only coaches can change roles.');
      if (!['coach', 'captain', 'member'].includes(b.role)) throw bad('Bad role.');
      if (target.role === 'coach' && b.role !== 'coach' && q(`SELECT COUNT(*) n FROM team_members WHERE team_id = ? AND role = 'coach' AND status = 'active'`).get(team.id).n <= 1) {
        throw bad('A team needs at least one coach.');
      }
      q(`UPDATE team_members SET role = ?, status = 'active' WHERE team_id = ? AND user_id = ?`).run(b.role, team.id, target.user_id);
    } else if (b.action === 'remove') {
      if (target.role === 'coach' && role !== 'coach') throw forbidden('Only coaches can remove a coach.');
      if (target.role === 'coach' && q(`SELECT COUNT(*) n FROM team_members WHERE team_id = ? AND role = 'coach' AND status = 'active'`).get(team.id).n <= 1 && target.status === 'active') {
        throw bad('A team needs at least one coach.');
      }
      q('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, target.user_id);
    } else throw bad('Unknown action.');
    void user;
    return { ok: true };
  }));
  app.post('/api/teams/:tid/leave', wrap((req) => {
    const u = requireUser(req);
    const team = q('SELECT * FROM teams WHERE id = ?').get(Number(req.params.tid));
    if (!team) throw notFound();
    const mem = q('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, u.id);
    if (mem?.role === 'coach' && q(`SELECT COUNT(*) n FROM team_members WHERE team_id = ? AND role = 'coach' AND status = 'active'`).get(team.id).n <= 1) {
      throw bad('Make someone else a coach before leaving.');
    }
    q('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, u.id);
    return { ok: true };
  }));

  // ---------- shared bill research ----------
  app.post('/api/teams/:tid/bills', wrap((req) => {
    const { team, user } = loadTeam(req);
    const b = req.body || {};
    const title = str(b.title, 300);
    if (!title) throw bad('Give the bill a title.');
    const r = q('INSERT INTO team_bills (team_id, title, kind, source, summary, body, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(team.id, title, b.kind === 'resolution' ? 'resolution' : 'bill', str(b.source, 200), str(b.summary), str(b.body, 50000), user.id, now());
    return { id: Number(r.lastInsertRowid) };
  }));
  // Docket items the user can see in chambers they belong to (or all, for admins), to copy into the team library.
  app.get('/api/teams/:tid/docket-options', wrap((req) => {
    const { user } = loadTeam(req);
    const rows = user.role === 'admin'
      ? q(`SELECT l.id, l.title, l.kind, l.author, c.name chamber FROM legislation l JOIN chambers c ON c.id = l.chamber_id WHERE c.is_mock = 0 ORDER BY c.id DESC, l.docket_order`).all()
      : q(`SELECT l.id, l.title, l.kind, l.author, c.name chamber FROM legislation l JOIN chambers c ON c.id = l.chamber_id
           JOIN chamber_members m ON m.chamber_id = c.id WHERE m.user_id = ? ORDER BY c.id DESC, l.docket_order`).all(user.id);
    return { items: rows };
  }));
  app.post('/api/teams/:tid/bills/import', wrap((req) => {
    const { team, user } = loadTeam(req);
    const ids = ((req.body || {}).legislation_ids || []).map(Number);
    const visible = new Set((user.role === 'admin'
      ? q('SELECT id FROM legislation').all()
      : q(`SELECT l.id FROM legislation l JOIN chamber_members m ON m.chamber_id = l.chamber_id WHERE m.user_id = ?`).all(user.id)).map((r) => r.id));
    let added = 0;
    tx(() => {
      for (const id of ids) {
        if (!visible.has(id)) continue;
        const l = q('SELECT l.*, c.name chamber FROM legislation l JOIN chambers c ON c.id = l.chamber_id WHERE l.id = ?').get(id);
        if (q('SELECT 1 FROM team_bills WHERE team_id = ? AND title = ?').get(team.id, l.title)) continue;
        q('INSERT INTO team_bills (team_id, title, kind, source, summary, body, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(team.id, l.title, l.kind, [l.chamber, l.author].filter(Boolean).join(' · '), '', l.body, user.id, now());
        added++;
      }
    });
    return { added };
  }));
  app.get('/api/teams/:tid/bills/:bid', wrap((req) => {
    const { team, user } = loadTeam(req);
    const bill = getBill(team, req.params.bid);
    const items = q(`SELECT i.*, cu.display_name created_by_name, uu.display_name updated_by_name FROM bill_items i
                     LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users uu ON uu.id = i.updated_by
                     WHERE i.bill_id = ? ORDER BY i.section, i.id`).all(bill.id);
    const my_plans = q('SELECT id, title, side, status FROM speech_plans WHERE bill_id = ? AND user_id = ? ORDER BY updated_at DESC').all(bill.id, user.id);
    const my_notes = q('SELECT id, title FROM team_notes WHERE bill_id = ? AND user_id = ? ORDER BY updated_at DESC').all(bill.id, user.id);
    return { bill, items, my_plans, my_notes };
  }));
  app.put('/api/teams/:tid/bills/:bid', wrap((req) => {
    const { team } = loadTeam(req);
    const bill = getBill(team, req.params.bid);
    const b = req.body || {};
    q('UPDATE team_bills SET title = ?, kind = ?, source = ?, summary = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(str(b.title ?? bill.title, 300) || bill.title, b.kind === 'resolution' ? 'resolution' : (b.kind === 'bill' ? 'bill' : bill.kind),
        str(b.source ?? bill.source, 200), str(b.summary ?? bill.summary), str(b.body ?? bill.body, 50000), now(), bill.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/bills/:bid', wrap((req) => {
    const { team } = loadTeam(req, 'leader');
    const bill = getBill(team, req.params.bid);
    q('DELETE FROM team_bills WHERE id = ?').run(bill.id);
    return { ok: true };
  }));
  function itemFields(b, existing = {}) {
    const section = b.section ?? existing.section;
    if (!SECTIONS.includes(section)) throw bad('Pick a section.');
    const text = str(b.text ?? existing.text, 2000);
    if (!text) throw bad(section === 'evidence' ? 'Enter the fact or quote.' : 'Enter the argument or question.');
    const side = ['aff', 'neg', 'both'].includes(b.side) ? b.side : (existing.side || (section === 'aff' || section === 'neg' ? section : 'both'));
    let url = str(b.cite_url ?? existing.cite_url, 1000);
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    return { section, side, text, detail: str(b.detail ?? existing.detail), cite_source: str(b.cite_source ?? existing.cite_source, 300),
      cite_author: str(b.cite_author ?? existing.cite_author, 200), cite_date: str(b.cite_date ?? existing.cite_date, 50), cite_url: url };
  }
  app.post('/api/teams/:tid/bills/:bid/items', wrap((req) => {
    const { team, user } = loadTeam(req);
    const bill = getBill(team, req.params.bid);
    const f = itemFields(req.body || {});
    const r = q(`INSERT INTO bill_items (bill_id, section, side, text, detail, cite_source, cite_author, cite_date, cite_url, created_by, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bill.id, f.section, f.side, f.text, f.detail, f.cite_source, f.cite_author, f.cite_date, f.cite_url, user.id, user.id, now());
    q('UPDATE team_bills SET updated_at = ? WHERE id = ?').run(now(), bill.id);
    return { id: Number(r.lastInsertRowid) };
  }));
  app.put('/api/teams/:tid/bills/:bid/items/:iid', wrap((req) => {
    const { team, user } = loadTeam(req);
    const bill = getBill(team, req.params.bid);
    const it = q('SELECT * FROM bill_items WHERE id = ? AND bill_id = ?').get(Number(req.params.iid), bill.id);
    if (!it) throw notFound();
    const f = itemFields(req.body || {}, it);
    q(`UPDATE bill_items SET section = ?, side = ?, text = ?, detail = ?, cite_source = ?, cite_author = ?, cite_date = ?, cite_url = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(f.section, f.side, f.text, f.detail, f.cite_source, f.cite_author, f.cite_date, f.cite_url, user.id, now(), it.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/bills/:bid/items/:iid', wrap((req) => {
    const { team } = loadTeam(req);
    const bill = getBill(team, req.params.bid);
    q('DELETE FROM bill_items WHERE id = ? AND bill_id = ?').run(Number(req.params.iid), bill.id);
    return { ok: true };
  }));

  // ---------- private prep: speech plans and notes ----------
  function planFields(team, b, existing = {}) {
    const title = str(b.title ?? existing.title, 200);
    if (!title) throw bad('Give the speech a working title.');
    let billId = b.bill_id === undefined ? existing.bill_id : (b.bill_id ? Number(b.bill_id) : null);
    if (billId) getBill(team, billId);
    const side = ['authorship', 'aff', 'neg'].includes(b.side) ? b.side : (existing.side || 'aff');
    const status = PLAN_STATUS.includes(b.status) ? b.status : (existing.status || 'idea');
    return { title, bill_id: billId, side, status, tournament: str(b.tournament ?? existing.tournament, 200),
      outline: str(b.outline ?? existing.outline, 50000), shared: b.shared_with_leaders === undefined ? (existing.shared_with_leaders || 0) : (b.shared_with_leaders ? 1 : 0) };
  }
  app.get('/api/teams/:tid/prep', wrap((req) => {
    const { team, user } = loadTeam(req);
    return {
      plans: q(`SELECT p.*, b.title bill_title FROM speech_plans p LEFT JOIN team_bills b ON b.id = p.bill_id
                WHERE p.team_id = ? AND p.user_id = ? ORDER BY p.updated_at DESC`).all(team.id, user.id),
      notes: q(`SELECT n.*, b.title bill_title FROM team_notes n LEFT JOIN team_bills b ON b.id = n.bill_id
                WHERE n.team_id = ? AND n.user_id = ? ORDER BY n.updated_at DESC`).all(team.id, user.id),
    };
  }));
  app.post('/api/teams/:tid/plans', wrap((req) => {
    const { team, user } = loadTeam(req);
    const f = planFields(team, req.body || {});
    const r = q(`INSERT INTO speech_plans (team_id, user_id, bill_id, side, title, tournament, status, outline, shared_with_leaders, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(team.id, user.id, f.bill_id, f.side, f.title, f.tournament, f.status, f.outline, f.shared, now());
    return { id: Number(r.lastInsertRowid) };
  }));
  function getPlan(req, team, user, isLeader) {
    const p = q('SELECT p.*, b.title bill_title FROM speech_plans p LEFT JOIN team_bills b ON b.id = p.bill_id WHERE p.id = ? AND p.team_id = ?').get(Number(req.params.pid), team.id);
    if (!p) throw notFound('Speech plan not found.');
    const own = p.user_id === user.id;
    if (!own && !(isLeader && p.shared_with_leaders)) throw notFound('Speech plan not found.');
    return { p, own };
  }
  app.get('/api/teams/:tid/plans/:pid', wrap((req) => {
    const { team, user, isLeader } = loadTeam(req);
    const { p, own } = getPlan(req, team, user, isLeader);
    const evidence = p.bill_id ? q(`SELECT * FROM bill_items WHERE bill_id = ? ORDER BY section, id`).all(p.bill_id) : [];
    const author = q('SELECT display_name FROM users WHERE id = ?').get(p.user_id)?.display_name;
    return { plan: p, own, author, items: evidence };
  }));
  app.put('/api/teams/:tid/plans/:pid', wrap((req) => {
    const { team, user, isLeader } = loadTeam(req);
    const { p, own } = getPlan(req, team, user, isLeader);
    if (!own) throw forbidden('Only the author can edit this plan.');
    const f = planFields(team, req.body || {}, p);
    q(`UPDATE speech_plans SET bill_id = ?, side = ?, title = ?, tournament = ?, status = ?, outline = ?, shared_with_leaders = ?, updated_at = ? WHERE id = ?`)
      .run(f.bill_id, f.side, f.title, f.tournament, f.status, f.outline, f.shared, now(), p.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/plans/:pid', wrap((req) => {
    const { team, user } = loadTeam(req);
    q('DELETE FROM speech_plans WHERE id = ? AND team_id = ? AND user_id = ?').run(Number(req.params.pid), team.id, user.id);
    return { ok: true };
  }));
  app.post('/api/teams/:tid/notes', wrap((req) => {
    const { team, user } = loadTeam(req);
    const b = req.body || {};
    if (b.bill_id) getBill(team, b.bill_id);
    const r = q('INSERT INTO team_notes (team_id, user_id, bill_id, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(team.id, user.id, b.bill_id ? Number(b.bill_id) : null, str(b.title, 200) || 'Untitled note', str(b.body, 50000), now());
    return { id: Number(r.lastInsertRowid) };
  }));
  app.put('/api/teams/:tid/notes/:nid', wrap((req) => {
    const { team, user } = loadTeam(req);
    const n = q('SELECT * FROM team_notes WHERE id = ? AND team_id = ? AND user_id = ?').get(Number(req.params.nid), team.id, user.id);
    if (!n) throw notFound('Note not found.');
    const b = req.body || {};
    if (b.bill_id) getBill(team, b.bill_id);
    q('UPDATE team_notes SET title = ?, body = ?, bill_id = ?, updated_at = ? WHERE id = ?')
      .run(str(b.title ?? n.title, 200) || n.title, str(b.body ?? n.body, 50000), b.bill_id === undefined ? n.bill_id : (b.bill_id ? Number(b.bill_id) : null), now(), n.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/notes/:nid', wrap((req) => {
    const { team, user } = loadTeam(req);
    q('DELETE FROM team_notes WHERE id = ? AND team_id = ? AND user_id = ?').run(Number(req.params.nid), team.id, user.id);
    return { ok: true };
  }));

  // ---------- progress ----------
  // Speeches come from real (non-mock) chambers; judge points only from ballots that were published to the competitor.
  function progressFor(team, uid) {
    const speeches = q(`SELECT s.id, s.side, s.recognized_at, l.title bill, c.name chamber FROM speeches s
                        JOIN legislation l ON l.id = s.legislation_id JOIN chambers c ON c.id = s.chamber_id
                        WHERE s.speaker_id = ? AND c.is_mock = 0 ORDER BY s.recognized_at DESC`).all(uid);
    const feedback = q(`SELECT ss.speech_id, ss.points, ss.comment, u.display_name judge, c.score_min, c.score_max FROM speech_scores ss
                        JOIN speeches s ON s.id = ss.speech_id JOIN chambers c ON c.id = s.chamber_id
                        JOIN judge_ballots jb ON jb.chamber_id = s.chamber_id AND jb.judge_id = ss.judge_id
                        JOIN users u ON u.id = ss.judge_id
                        WHERE s.speaker_id = ? AND c.is_mock = 0 AND jb.publish != 'private'`).all(uid);
    const entries = q('SELECT * FROM progress_entries WHERE team_id = ? AND user_id = ? ORDER BY date DESC, id DESC').all(team.id, uid);
    const goals = q(`SELECT g.*, u.display_name created_by_name FROM team_goals g LEFT JOIN users u ON u.id = g.created_by
                     WHERE g.team_id = ? AND g.user_id = ? ORDER BY g.done, g.id DESC`).all(team.id, uid);
    const plans = q('SELECT status, COUNT(*) n FROM speech_plans WHERE team_id = ? AND user_id = ? GROUP BY status').all(team.id, uid);
    const sides = { authorship: 0, sponsorship: 0, aff: 0, neg: 0 };
    for (const s of speeches) sides[s.side]++;
    // Normalize judge points to a 0-100 scale so 1-6 and 1-8 tournaments compare.
    const pct = feedback.map((f) => Math.round(((f.points - f.score_min) / Math.max(1, f.score_max - f.score_min)) * 100));
    return {
      speeches, feedback, entries, goals,
      summary: {
        app_speeches: speeches.length, logged_entries: entries.length, sides,
        avg_score_pct: pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length) : null,
        plans: Object.fromEntries(plans.map((p) => [p.status, p.n])),
        goals_open: goals.filter((g) => !g.done).length,
      },
    };
  }
  app.get('/api/teams/:tid/progress', wrap((req) => {
    const { team, user, isLeader } = loadTeam(req);
    const uid = Number(req.query.user || user.id);
    if (uid !== user.id && !isLeader) throw forbidden('You can only see your own progress.');
    if (!q(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active'`).get(team.id, uid)) throw notFound('Not on this team.');
    const out = progressFor(team, uid);
    out.user = q('SELECT id, display_name FROM users WHERE id = ?').get(uid);
    out.shared_plans = uid !== user.id
      ? q(`SELECT p.id, p.title, p.side, p.status, b.title bill_title FROM speech_plans p LEFT JOIN team_bills b ON b.id = p.bill_id
           WHERE p.team_id = ? AND p.user_id = ? AND p.shared_with_leaders = 1 ORDER BY p.updated_at DESC`).all(team.id, uid)
      : undefined;
    return out;
  }));
  app.get('/api/teams/:tid/roster-progress', wrap((req) => {
    const { team } = loadTeam(req, 'leader');
    const members = q(`SELECT tm.user_id id, tm.role, u.display_name name FROM team_members tm JOIN users u ON u.id = tm.user_id
                       WHERE tm.team_id = ? AND tm.status = 'active' ORDER BY u.display_name`).all(team.id);
    return { members: members.map((m) => ({ ...m, ...progressFor(team, m.id).summary })) };
  }));
  app.post('/api/teams/:tid/progress', wrap((req) => {
    const { team, user } = loadTeam(req);
    const b = req.body || {};
    if (!str(b.tournament, 200) && !str(b.notes)) throw bad('Add at least the tournament or a note.');
    q(`INSERT INTO progress_entries (team_id, user_id, date, tournament, bill, side, points, result, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(team.id, user.id, str(b.date, 20), str(b.tournament, 200), str(b.bill, 300), str(b.side, 20), str(b.points, 50), str(b.result, 200), str(b.notes), now());
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/progress/:eid', wrap((req) => {
    const { team, user } = loadTeam(req);
    q('DELETE FROM progress_entries WHERE id = ? AND team_id = ? AND user_id = ?').run(Number(req.params.eid), team.id, user.id);
    return { ok: true };
  }));
  app.post('/api/teams/:tid/goals', wrap((req) => {
    const { team, user } = loadTeam(req, 'leader');
    const b = req.body || {};
    const uid = Number(b.user_id);
    if (!q(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active'`).get(team.id, uid)) throw bad('Pick someone on the team.');
    const text = str(b.text, 500);
    if (!text) throw bad('Write the goal.');
    q('INSERT INTO team_goals (team_id, user_id, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(team.id, uid, text, user.id, now());
    return { ok: true };
  }));
  app.put('/api/teams/:tid/goals/:gid', wrap((req) => {
    const { team, user, isLeader } = loadTeam(req);
    const g = q('SELECT * FROM team_goals WHERE id = ? AND team_id = ?').get(Number(req.params.gid), team.id);
    if (!g || (g.user_id !== user.id && !isLeader)) throw notFound('Goal not found.');
    q('UPDATE team_goals SET done = ? WHERE id = ?').run((req.body || {}).done ? 1 : 0, g.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/goals/:gid', wrap((req) => {
    const { team } = loadTeam(req, 'leader');
    q('DELETE FROM team_goals WHERE id = ? AND team_id = ?').run(Number(req.params.gid), team.id);
    return { ok: true };
  }));
};
