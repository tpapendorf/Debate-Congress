'use strict';
// Bill drills: quick spoken practice built from the research the team already has on its current bills.
// Each drill card is a bill item (a likely question, an argument to refute, a piece of evidence to cite).
// Students rate themselves (0 need work, 1 close, 2 nailed it); "need work" cards come back first next time.
// Readiness per bill = read the summary, drill the questions, refute both sides, cite the evidence, one practice speech.
const KINDS = ['read', 'question', 'refute', 'cite', 'speed'];
const RATED = ['question', 'refute', 'cite', 'speed'];
const KIND_NAME = { question: 'Answering questions', refute: 'Refutation', cite: 'Citing evidence', speed: 'Speed round' };

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drill_results (
      id INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bill_id INTEGER NOT NULL REFERENCES team_bills(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES bill_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drill_results_user ON drill_results(team_id, user_id, bill_id);
  `);
  if (!db.prepare('PRAGMA table_info(teams)').all().some((c) => c.name === 'drill_bill_id')) db.exec('ALTER TABLE teams ADD COLUMN drill_bill_id INTEGER');
}

function mountDrills(app, { q, wrap, loadTeam, bad, notFound, now, billPreview }) {
  function drillBills(team) {
    const cur = q(`SELECT id, title, kind, source, status, updated_at FROM team_bills WHERE team_id = ? AND status = 'current' ORDER BY title`).all(team.id);
    let list = cur;
    if (!cur.length) {
      list = q(`SELECT b.id, b.title, b.kind, b.source, b.status, b.updated_at FROM team_bills b WHERE b.team_id = ? AND b.status != 'archived'
                AND EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = b.id) ORDER BY b.updated_at DESC LIMIT 8`).all(team.id);
    }
    if (team.drill_bill_id && !list.some((b) => b.id === team.drill_bill_id)) {
      const p = q('SELECT id, title, kind, source, status, updated_at FROM team_bills WHERE id = ? AND team_id = ?').get(team.drill_bill_id, team.id);
      if (p) list = [p, ...list];
    }
    return { list, current: cur.length > 0 };
  }
  const itemsOf = (billId, showAi) => q('SELECT id, section, side, text, detail, cite_title, cite_source, cite_author, cite_date, cite_url, ai FROM bill_items WHERE bill_id = ? AND (ai = 0 OR ?) ORDER BY section, id').all(billId, showAi ? 1 : 0);

  // What one person has done on one bill.
  function readiness(team, uid, billId, items) {
    const res = q('SELECT item_id, kind FROM drill_results WHERE team_id = ? AND user_id = ? AND bill_id = ?').all(team.id, uid, billId);
    const ids = (sec) => items.filter((i) => i.section === sec).map((i) => i.id);
    const rated = (kind, list) => new Set(res.filter((r) => r.kind === kind && list.includes(r.item_id)).map((r) => r.item_id)).size;
    const qs = ids('question'), ev = ids('evidence'), aff = ids('aff'), neg = ids('neg');
    const qNeed = Math.min(qs.length, 5), cNeed = Math.min(ev.length, 3);
    const runs = q(`SELECT COUNT(*) n FROM practice_runs r JOIN speech_plans p ON p.id = r.plan_id WHERE r.team_id = ? AND r.user_id = ? AND p.bill_id = ?`).get(team.id, uid, billId).n;
    const steps = {
      read: { avail: true, done: res.some((r) => r.kind === 'read') },
      questions: { avail: qs.length > 0, done: qs.length > 0 && rated('question', qs) >= qNeed, have: Math.min(rated('question', qs), qNeed), need: qNeed },
      refute: { avail: aff.length + neg.length > 0, done: (!aff.length || rated('refute', aff) > 0) && (!neg.length || rated('refute', neg) > 0) && aff.length + neg.length > 0,
        aff: rated('refute', aff) > 0, neg: rated('refute', neg) > 0 },
      cite: { avail: ev.length > 0, done: ev.length > 0 && rated('cite', ev) >= cNeed, have: Math.min(rated('cite', ev), cNeed), need: cNeed },
      speech: { avail: true, done: runs > 0, runs },
    };
    const avail = Object.values(steps).filter((s) => s.avail);
    return { steps, done: avail.filter((s) => s.done).length, total: avail.length, drills: res.filter((r) => r.kind !== 'read').length };
  }
  // The drill type someone finds hardest, from their recent ratings.
  function weakest(team, uid) {
    const rows = q(`SELECT kind, AVG(rating) avg, COUNT(*) n FROM (SELECT kind, rating FROM drill_results WHERE team_id = ? AND user_id = ? AND kind != 'read' ORDER BY created_at DESC LIMIT 60)
                    GROUP BY kind HAVING n >= 3 ORDER BY avg`).all(team.id, uid);
    const w = rows[0];
    return w && w.avg < 1.5 ? { kind: w.kind, name: KIND_NAME[w.kind], avg: Math.round(w.avg * 10) / 10 } : null;
  }
  const counts = (items) => ({ question: items.filter((i) => i.section === 'question').length, aff: items.filter((i) => i.section === 'aff').length,
    neg: items.filter((i) => i.section === 'neg').length, evidence: items.filter((i) => i.section === 'evidence').length });

  app.get('/api/teams/:tid/drills', wrap((req) => {
    const ctx = loadTeam(req);
    const { list, current } = drillBills(ctx.team);
    const itemMap = new Map(list.map((b) => [b.id, itemsOf(b.id, ctx.showAi)]));
    const bills = list.map((b) => ({ ...b, counts: counts(itemMap.get(b.id)), readiness: readiness(ctx.team, ctx.user.id, b.id, itemMap.get(b.id)) }));
    const out = { bills, current, pinned_bill_id: ctx.team.drill_bill_id || null };
    if (ctx.isLeader) {
      const members = q(`SELECT u.id, u.display_name name, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id
                         WHERE tm.team_id = ? AND tm.status = 'active' ORDER BY u.display_name`).all(ctx.team.id);
      out.roster = members.map((m) => ({
        ...m,
        bills: Object.fromEntries(list.map((b) => { const r = readiness(ctx.team, m.id, b.id, itemMap.get(b.id)); return [b.id, { done: r.done, total: r.total, drills: r.drills }]; })),
        last: q('SELECT MAX(created_at) t FROM drill_results WHERE team_id = ? AND user_id = ?').get(ctx.team.id, m.id).t || null,
        weakest: weakest(ctx.team, m.id),
      }));
    }
    return out;
  }));
  function getBill(ctx, bid) {
    const b = q('SELECT * FROM team_bills WHERE id = ? AND team_id = ?').get(Number(bid), ctx.team.id);
    if (!b) throw notFound('Bill not found.');
    return b;
  }
  app.get('/api/teams/:tid/drills/:bid', wrap((req) => {
    const ctx = loadTeam(req);
    const b = getBill(ctx, req.params.bid);
    const items = itemsOf(b.id, ctx.showAi);
    // Each card's latest rating, per drill type, so "need work" comes back first.
    const latest = {};
    for (const r of q(`SELECT item_id, kind, rating FROM drill_results WHERE team_id = ? AND user_id = ? AND bill_id = ? AND item_id IS NOT NULL ORDER BY created_at, id`).all(ctx.team.id, ctx.user.id, b.id)) latest[`${r.kind}:${r.item_id}`] = r.rating;
    return {
      bill: { id: b.id, title: b.title, kind: b.kind, source: b.source, status: b.status, summary: b.summary, ai_summary: ctx.showAi ? b.ai_summary : '', preview: billPreview(b.summary, (b.body || '').slice(0, 1500)), has_text: !!(b.body || '').trim() },
      items, latest, readiness: readiness(ctx.team, ctx.user.id, b.id, items), pinned: ctx.team.drill_bill_id === b.id,
    };
  }));
  app.post('/api/teams/:tid/drills/:bid/results', wrap((req) => {
    const ctx = loadTeam(req);
    const b = getBill(ctx, req.params.bid);
    const list = (Array.isArray((req.body || {}).results) ? req.body.results : []).slice(0, 200);
    const ok = new Set(q('SELECT id FROM bill_items WHERE bill_id = ?').all(b.id).map((i) => i.id));
    let saved = 0;
    for (const r of list) {
      if (!KINDS.includes(r.kind)) continue;
      const itemId = r.kind === 'read' ? null : Number(r.item_id);
      if (r.kind !== 'read' && !ok.has(itemId)) continue;
      if (r.kind === 'read' && q(`SELECT 1 FROM drill_results WHERE team_id = ? AND user_id = ? AND bill_id = ? AND kind = 'read'`).get(ctx.team.id, ctx.user.id, b.id)) continue;
      const rating = RATED.includes(r.kind) ? Math.max(0, Math.min(2, Math.round(Number(r.rating) || 0))) : 0;
      q('INSERT INTO drill_results (team_id, user_id, bill_id, item_id, kind, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ctx.team.id, ctx.user.id, b.id, itemId, r.kind, rating, now());
      saved++;
    }
    if (!saved && list.length) throw bad('Nothing to save.');
    return { saved };
  }));
  app.post('/api/teams/:tid/drills/:bid/pin', wrap((req) => {
    const ctx = loadTeam(req, 'leader');
    const b = getBill(ctx, req.params.bid);
    q('UPDATE teams SET drill_bill_id = ? WHERE id = ?').run((req.body || {}).pinned === false ? null : b.id, ctx.team.id);
    return { ok: true };
  }));
}

module.exports = { schema, mountDrills };
