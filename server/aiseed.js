'use strict';
// One-time loads of AI Learning Aids shipped with the app (server/seeds/<name>/*.md, each in the
// prep-kit reply format). Each seed runs once per database, on the first start where its bills exist.
// Items land exactly as if a coach had uploaded them: tagged ai = 1, so they show the AI Learning Aid
// badge and follow the team and personal switches. A backup is taken before anything is written.
//
// A seed folder may hold seed.json with { "replaces": "<older seed name>" }. The older seed then never
// runs on its own, and when this one runs it first removes the older seed's items that are still exactly
// as shipped (same bill, section and text). Anything a student added or edited stays.
const fs = require('fs');
const path = require('path');
const { parseAiReply } = require('./aikit');

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function readSeed(dir, name) {
  const folder = path.join(dir, name);
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(folder, 'seed.json'), 'utf8')); } catch { /* no manifest */ }
  const replies = fs.readdirSync(folder).filter((f) => f.endsWith('.md')).sort().map((f) => parseAiReply(fs.readFileSync(path.join(folder, f), 'utf8')));
  return { name, replaces: manifest.replaces || null, replies };
}

function runAiSeeds(db, { backup, dir = path.join(__dirname, 'seeds'), log = console.log } = {}) {
  if (!fs.existsSync(dir)) return [];
  db.exec('CREATE TABLE IF NOT EXISTS seed_runs (name TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT \'\')');
  const seeds = fs.readdirSync(dir).sort().filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).map((n) => readSeed(dir, n));
  const byName = new Map(seeds.map((s) => [s.name, s]));
  const superseded = new Set(seeds.map((s) => s.replaces).filter(Boolean));
  const results = [];
  for (const seed of seeds) {
    if (superseded.has(seed.name)) continue;
    if (db.prepare('SELECT 1 FROM seed_runs WHERE name = ?').get(seed.name)) continue;
    const old = seed.replaces && byName.get(seed.replaces);
    const bills = db.prepare('SELECT b.id, b.title, b.team_id, b.ai_summary, t.created_by team_owner FROM team_bills b JOIN teams t ON t.id = b.team_id').all();
    const aiItems = db.prepare('SELECT id, section, text FROM bill_items WHERE bill_id = ? AND ai = 1');
    const plan = [];
    for (const r of seed.replies) {
      const oldReply = old && old.replies.find((o) => norm(o.title) === norm(r.title));
      const shipped = new Set((oldReply ? oldReply.items : []).map((i) => `${i.section}|${i.text}`));
      for (const b of bills.filter((x) => norm(x.title) === norm(r.title))) {
        const existing = aiItems.all(b.id);
        const remove = existing.filter((i) => shipped.has(`${i.section}|${i.text}`)).map((i) => i.id);
        // Skip bills that hold other AI items (a student's own upload, or edited ones): never mix sets.
        if (existing.length > remove.length) continue;
        plan.push({ bill: b, reply: r, remove, oldSummary: oldReply ? oldReply.summary : null });
      }
    }
    if (!plan.length) continue; // the bills aren't here yet; try again on a later start
    if (backup) backup();
    let items = 0, removed = 0;
    const ins = db.prepare(`INSERT INTO bill_items (bill_id, section, side, text, detail, cite_title, cite_source, cite_author, cite_date, cite_url, created_by, updated_by, updated_at, ai)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const del = db.prepare('DELETE FROM bill_items WHERE id = ?');
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const { bill, reply, remove, oldSummary } of plan) {
        for (const id of remove) { del.run(id); removed++; }
        for (const it of reply.items) {
          if (it.section === 'evidence' && !/^https?:\/\//i.test(it.cite_url)) continue;
          ins.run(bill.id, it.section, it.side, it.text, it.detail, it.cite_title, it.cite_source, it.cite_author, it.cite_date, it.cite_url, bill.team_owner, bill.team_owner, now);
          items++;
        }
        const keepSummary = bill.ai_summary && bill.ai_summary !== oldSummary;
        if (reply.summary && !keepSummary) db.prepare('UPDATE team_bills SET ai_summary = ? WHERE id = ?').run(reply.summary, bill.id);
      }
      const detail = JSON.stringify({ bills: plan.length, items, removed, teams: [...new Set(plan.map((p) => p.bill.team_id))] });
      db.prepare('INSERT INTO seed_runs (name, ran_at, detail) VALUES (?, ?, ?)').run(seed.name, now, detail);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log(`AI Learning Aids seed "${seed.name}": ${items} items on ${plan.length} bills${removed ? `, replacing ${removed}` : ''}.`);
    results.push({ name: seed.name, bills: plan.length, items, ...(removed ? { removed } : {}) });
  }
  return results;
}

module.exports = { runAiSeeds };
