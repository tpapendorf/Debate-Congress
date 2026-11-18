'use strict';
// Training: short skill lessons for a team, in six tracks. Coaches and captains write and edit them,
// pin one as this week's focus, and see who finished each. Lessons written with an AI assistant
// (the starter set shipped with the app, and ones uploaded through the lesson kit) carry ai = 1,
// so they show the AI Learning Aid badge and follow the same team and personal switches.
// A coach can mark any lesson "Coach reviewed".
const fs = require('fs');
const path = require('path');
const { parseLessons, TRACKS, DRILLS, BILL_SECTIONS, LIMITS } = require('./lessonkit');

const STARTER_DIR = path.join(__dirname, 'training');
// Bump when new starter lessons ship. Teams then get the new ones (matched by title); nothing is overwritten.
const STARTER_VERSION = '1';

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      track TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      good TEXT NOT NULL DEFAULT '',
      weak TEXT NOT NULL DEFAULT '',
      drill TEXT NOT NULL DEFAULT '',
      drill_to TEXT NOT NULL DEFAULT '',
      bill_section TEXT NOT NULL DEFAULT '',
      ai INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lessons_team ON lessons(team_id);
    CREATE TABLE IF NOT EXISTS lesson_done (
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      done_at INTEGER NOT NULL,
      PRIMARY KEY (lesson_id, user_id)
    );
  `);
  if (!db.prepare('PRAGMA table_info(teams)').all().some((c) => c.name === 'training_seed')) db.exec(`ALTER TABLE teams ADD COLUMN training_seed TEXT NOT NULL DEFAULT ''`);
}

let starterCache = null;
function starterLessons(dir = STARTER_DIR) {
  if (dir === STARTER_DIR && starterCache) return starterCache;
  const list = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().flatMap((f) => parseLessons(fs.readFileSync(path.join(dir, f), 'utf8')).lessons)
    : [];
  if (dir === STARTER_DIR) starterCache = list;
  return list;
}

function mountTraining(app, { q, tx, wrap, loadTeam, bad, forbidden, notFound, now, str }) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function insertLesson(team, f, { ai = 0, source = '', uid = null, sort } = {}) {
    const s = sort ?? ((q('SELECT MAX(sort) m FROM lessons WHERE team_id = ? AND track = ?').get(team.id, f.track)?.m ?? 0) + 1);
    return Number(q(`INSERT INTO lessons (team_id, track, title, summary, body, good, weak, drill, drill_to, bill_section, ai, source, sort, created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(team.id, f.track, f.title, f.summary, f.body, f.good, f.weak, f.drill, f.drill_to, f.bill_section, ai, source, s, uid, uid, now(), now()).lastInsertRowid);
  }
  // Starter lessons land the first time anyone opens Training (and again, only the new ones, after an update).
  // teams.training_seed holds { v: starter version loaded, removed: [titles of starter lessons a leader deleted] }.
  const seedState = (raw) => { try { const s = JSON.parse(raw); return { v: String(s.v || ''), removed: s.removed || [] }; } catch { return { v: '', removed: [] }; } };
  function seedTeam(team) {
    const st = seedState(team.training_seed);
    if (st.v === STARTER_VERSION) return;
    tx(() => {
      const have = new Set(q('SELECT title FROM lessons WHERE team_id = ?').all(team.id).map((l) => norm(l.title)));
      const removed = new Set(st.removed);
      starterLessons().forEach((l, n) => {
        if (have.has(norm(l.title)) || removed.has(norm(l.title)) || !l.track) return;
        insertLesson(team, l, { ai: 1, source: 'starter', sort: n + 1 });
      });
      q('UPDATE teams SET training_seed = ? WHERE id = ?').run(JSON.stringify({ v: STARTER_VERSION, removed: st.removed }), team.id);
    });
  }
  function fields(b, existing = {}) {
    const v = (k) => str(b[k] ?? existing[k], LIMITS[k]);
    const track = TRACKS.includes(b.track) ? b.track : existing.track;
    if (!TRACKS.includes(track)) throw bad('Pick a track.');
    const title = v('title');
    if (!title) throw bad('Give the lesson a title.');
    const body = v('body');
    if (!body) throw bad('Write the lesson.');
    const drillTo = b.drill_to !== undefined ? (DRILLS.includes(b.drill_to) ? b.drill_to : '') : (existing.drill_to || '');
    const billSection = b.bill_section !== undefined ? (BILL_SECTIONS.includes(b.bill_section) ? b.bill_section : '') : (existing.bill_section || '');
    return { track, title, summary: v('summary'), body, good: v('good'), weak: v('weak'), drill: v('drill'), drill_to: drillTo, bill_section: billSection };
  }
  function getLesson(ctx, lid) {
    const l = q('SELECT * FROM lessons WHERE id = ? AND team_id = ?').get(Number(lid), ctx.team.id);
    if (!l || (l.ai && !ctx.showAi)) throw notFound('Lesson not found.');
    return l;
  }
  const active = (team) => q(`SELECT COUNT(*) n FROM team_members WHERE team_id = ? AND status = 'active'`).get(team.id).n;
  const reviewer = (l) => (l.reviewed_by ? q('SELECT display_name FROM users WHERE id = ?').get(l.reviewed_by)?.display_name || 'A coach' : null);

  app.get('/api/teams/:tid/lessons', wrap((req) => {
    const ctx = loadTeam(req);
    seedTeam(ctx.team);
    const rows = q(`SELECT l.id, l.track, l.title, l.summary, l.drill_to, l.bill_section, l.ai, l.source, l.pinned, l.sort, l.reviewed_at, l.updated_at,
                      (SELECT COUNT(*) FROM lesson_done d JOIN team_members tm ON tm.user_id = d.user_id AND tm.team_id = l.team_id AND tm.status = 'active' WHERE d.lesson_id = l.id) done_count,
                      EXISTS (SELECT 1 FROM lesson_done d WHERE d.lesson_id = l.id AND d.user_id = ?) done
                    FROM lessons l WHERE l.team_id = ? AND (l.ai = 0 OR ?) ORDER BY l.track, l.sort, l.id`).all(ctx.user.id, ctx.team.id, ctx.showAi ? 1 : 0);
    const lessons = rows.map((l) => ({ ...l, ai: !!l.ai, pinned: !!l.pinned, done: !!l.done, reviewed: !!l.reviewed_at, ...(ctx.isLeader ? {} : { done_count: undefined }) }));
    const hidden = ctx.showAi ? 0 : q('SELECT COUNT(*) n FROM lessons WHERE team_id = ? AND ai = 1').get(ctx.team.id).n;
    return { tracks: TRACKS, lessons, hidden_ai: hidden, members: ctx.isLeader ? active(ctx.team) : undefined };
  }));
  app.get('/api/teams/:tid/lessons/:lid', wrap((req) => {
    const ctx = loadTeam(req);
    const l = getLesson(ctx, req.params.lid);
    const done = !!q('SELECT 1 FROM lesson_done WHERE lesson_id = ? AND user_id = ?').get(l.id, ctx.user.id);
    const out = { lesson: { ...l, ai: !!l.ai, pinned: !!l.pinned, reviewed: !!l.reviewed_at, reviewed_by_name: reviewer(l) }, done };
    if (ctx.isLeader) {
      const roster = q(`SELECT u.id, u.display_name name, tm.role, d.done_at FROM team_members tm JOIN users u ON u.id = tm.user_id
                        LEFT JOIN lesson_done d ON d.lesson_id = ? AND d.user_id = u.id
                        WHERE tm.team_id = ? AND tm.status = 'active' ORDER BY d.done_at IS NULL, u.display_name`).all(l.id, ctx.team.id);
      out.roster = roster.map((r) => ({ id: r.id, name: r.name, role: r.role, done_at: r.done_at || null }));
    }
    return out;
  }));
  app.post('/api/teams/:tid/lessons', wrap((req) => {
    const ctx = loadTeam(req, 'leader');
    return { id: insertLesson(ctx.team, fields(req.body || {}), { uid: ctx.user.id }) };
  }));
  app.put('/api/teams/:tid/lessons/:lid', wrap((req) => {
    const ctx = loadTeam(req, 'leader');
    const l = getLesson(ctx, req.params.lid);
    const f = fields(req.body || {}, l);
    const moved = f.track !== l.track;
    q(`UPDATE lessons SET track = ?, title = ?, summary = ?, body = ?, good = ?, weak = ?, drill = ?, drill_to = ?, bill_section = ?, updated_by = ?, updated_at = ?${moved ? ', sort = (SELECT COALESCE(MAX(sort), 0) + 1 FROM lessons WHERE team_id = ? AND track = ?)' : ''} WHERE id = ?`)
      .run(...[f.track, f.title, f.summary, f.body, f.good, f.weak, f.drill, f.drill_to, f.bill_section, ctx.user.id, now()], ...(moved ? [ctx.team.id, f.track] : []), l.id);
    return { ok: true };
  }));
  app.delete('/api/teams/:tid/lessons/:lid', wrap((req) => {
    const ctx = loadTeam(req, 'leader');
    const l = getLesson(ctx, req.params.lid);
    tx(() => {
      q('DELETE FROM lessons WHERE id = ?').run(l.id);
      // Remember deleted starter lessons so a later update doesn't bring them back.
      if (l.source === 'starter') {
        const st = seedState(q('SELECT training_seed FROM teams WHERE id = ?').get(ctx.team.id).training_seed);
        q('UPDATE teams SET training_seed = ? WHERE id = ?').run(JSON.stringify({ ...st, removed: [...st.removed, norm(l.title)] }), ctx.team.id);
      }
    });
    return { ok: true };
  }));
  app.post('/api/teams/:tid/lessons/:lid/done', wrap((req) => {
    const ctx = loadTeam(req);
    const l = getLesson(ctx, req.params.lid);
    if ((req.body || {}).done === false) q('DELETE FROM lesson_done WHERE lesson_id = ? AND user_id = ?').run(l.id, ctx.user.id);
    else q('INSERT OR IGNORE INTO lesson_done (lesson_id, user_id, done_at) VALUES (?, ?, ?)').run(l.id, ctx.user.id, now());
    return { ok: true };
  }));
  app.post('/api/teams/:tid/lessons/:lid/review', wrap((req) => {
    const ctx = loadTeam(req, 'coach');
    const l = getLesson(ctx, req.params.lid);
    const on = (req.body || {}).reviewed !== false;
    q('UPDATE lessons SET reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(on ? ctx.user.id : null, on ? now() : null, l.id);
    return { ok: true };
  }));
  app.post('/api/teams/:tid/lessons/:lid/pin', wrap((req) => {
    const ctx = loadTeam(req, 'leader');
    const l = getLesson(ctx, req.params.lid);
    const on = (req.body || {}).pinned !== false;
    tx(() => {
      q('UPDATE lessons SET pinned = 0 WHERE team_id = ?').run(ctx.team.id);
      if (on) q('UPDATE lessons SET pinned = 1 WHERE id = ?').run(l.id);
    });
    return { ok: true };
  }));

  // ---------- AI lesson kit: a coach or captain gives the kit to their own AI and uploads the reply ----------
  function aiLeader(req) {
    const ctx = loadTeam(req, 'leader');
    if (!ctx.team.ai_aids) throw forbidden('AI Learning Aids are turned off for this team.');
    return ctx;
  }
  app.post('/api/teams/:tid/lessons/ai/read', wrap((req) => {
    const ctx = aiLeader(req);
    const text = String((req.body || {}).text || '');
    if (!text.trim()) throw bad('Upload or paste the reply from your AI assistant.');
    if (text.length > 200000) throw bad('That reply is too long.');
    const out = parseLessons(text);
    const have = new Set(q('SELECT title FROM lessons WHERE team_id = ?').all(ctx.team.id).map((l) => norm(l.title)));
    for (const l of out.lessons) if (have.has(norm(l.title))) l.flags.push('duplicate');
    return out;
  }));
  app.post('/api/teams/:tid/lessons/ai/import', wrap((req) => {
    const ctx = aiLeader(req);
    const list = (Array.isArray((req.body || {}).lessons) ? req.body.lessons : []).slice(0, 30);
    let added = 0;
    tx(() => {
      for (const raw of list) {
        let f;
        try { f = fields(raw); } catch { continue; }
        insertLesson(ctx.team, f, { ai: 1, uid: ctx.user.id });
        added++;
      }
    });
    return { added };
  }));
}

module.exports = { schema, mountTraining, starterLessons, STARTER_VERSION };
