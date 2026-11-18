'use strict';
// One-time loads of AI Learning Aids shipped with the app (server/seeds/<name>/*.md, each in the
// prep-kit reply format). Each seed runs once per database, on the first start where its bills exist.
// Items land exactly as if a coach had uploaded them: tagged ai = 1, so they show the AI Learning Aid
// badge and follow the team and personal switches. A backup is taken before anything is written.
const fs = require('fs');
const path = require('path');
const { parseAiReply } = require('./aikit');

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function runAiSeeds(db, { backup, dir = path.join(__dirname, 'seeds'), log = console.log } = {}) {
  if (!fs.existsSync(dir)) return [];
  db.exec('CREATE TABLE IF NOT EXISTS seed_runs (name TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT \'\')');
  const results = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const folder = path.join(dir, name);
    if (!fs.statSync(folder).isDirectory()) continue;
    if (db.prepare('SELECT 1 FROM seed_runs WHERE name = ?').get(name)) continue;
    const replies = fs.readdirSync(folder).filter((f) => f.endsWith('.md')).sort().map((f) => parseAiReply(fs.readFileSync(path.join(folder, f), 'utf8')));
    const bills = db.prepare(`SELECT b.id, b.title, b.team_id, b.ai_summary, t.created_by team_owner,
                                (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = b.id AND i.ai = 1) ai_count
                              FROM team_bills b JOIN teams t ON t.id = b.team_id`).all();
    const plan = [];
    for (const r of replies) {
      for (const b of bills.filter((x) => norm(x.title) === norm(r.title) && !x.ai_count)) plan.push({ bill: b, reply: r });
    }
    if (!plan.length) continue; // the bills aren't here yet; try again on a later start
    if (backup) backup();
    let items = 0;
    const ins = db.prepare(`INSERT INTO bill_items (bill_id, section, side, text, detail, cite_title, cite_source, cite_author, cite_date, cite_url, created_by, updated_by, updated_at, ai)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const { bill, reply } of plan) {
        for (const it of reply.items) {
          if (it.section === 'evidence' && !/^https?:\/\//i.test(it.cite_url)) continue;
          ins.run(bill.id, it.section, it.side, it.text, it.detail, it.cite_title, it.cite_source, it.cite_author, it.cite_date, it.cite_url, bill.team_owner, bill.team_owner, now);
          items++;
        }
        if (reply.summary && !bill.ai_summary) db.prepare('UPDATE team_bills SET ai_summary = ? WHERE id = ?').run(reply.summary, bill.id);
      }
      const detail = JSON.stringify({ bills: plan.length, items, teams: [...new Set(plan.map((p) => p.bill.team_id))] });
      db.prepare('INSERT INTO seed_runs (name, ran_at, detail) VALUES (?, ?, ?)').run(name, now, detail);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log(`AI Learning Aids seed "${name}": ${items} items on ${plan.length} bills.`);
    results.push({ name, bills: plan.length, items });
  }
  return results;
}

module.exports = { runAiSeeds };
