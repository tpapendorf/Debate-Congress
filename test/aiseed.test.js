'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../server/db');
const { schema } = require('../server/teams');
const { runAiSeeds } = require('../server/aiseed');

test('shipped AI Learning Aids load once onto matching bills, after a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  fs.mkdirSync(path.join(dir, 'demo'));
  fs.writeFileSync(path.join(dir, 'demo', '01.md'), `# AI Learning Aid: A Bill to Require the Pentagon to Pass an Audit
## Summary
Cuts budgets of agencies that fail audits.
## Affirmative arguments
### Taxpayers deserve accountability
Warrant: Seven failed audits.
## Evidence
### The Pentagon failed its seventh audit
- Supports: aff
- Link: https://example.org/audit
### No link here
- Supports: neg
`);
  const db = open(':memory:'); schema(db);
  let backups = 0;
  const opts = { dir, backup: () => { backups++; }, log: () => {} };
  assert.deepEqual(runAiSeeds(db, opts), []); // no bills yet: nothing, and it will try again later
  db.prepare("INSERT INTO teams (id, name, join_code, created_at) VALUES (1, 'T', 'ABC123', 0)").run();
  db.prepare("INSERT INTO team_bills (team_id, title, updated_at) VALUES (1, 'A Bill to Require the Pentagon to Pass an Audit', 0)").run();
  db.prepare("INSERT INTO team_bills (team_id, title, updated_at) VALUES (1, 'Something else', 0)").run();
  assert.deepEqual(runAiSeeds(db, opts), [{ name: 'demo', bills: 1, items: 2 }]);
  assert.equal(backups, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bill_items WHERE ai = 1').get().n, 2);
  assert.equal(db.prepare('SELECT ai_summary FROM team_bills WHERE id = 1').get().ai_summary, 'Cuts budgets of agencies that fail audits.');
  assert.deepEqual(runAiSeeds(db, opts), []); // never twice
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bill_items').get().n, 2);
});

test('a replacing seed swaps out the shipped items it replaces and leaves everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const reply = (claim, summary) => `# AI Learning Aid: A Bill to Ban Things\n## Summary\n${summary}\n## Affirmative arguments\n### ${claim}\nWarrant: because.\n`;
  fs.mkdirSync(path.join(dir, 'v1')); fs.writeFileSync(path.join(dir, 'v1', '01.md'), reply('Old claim', 'Old summary.'));
  const db = open(':memory:'); schema(db);
  db.prepare("INSERT INTO teams (id, name, join_code, created_at) VALUES (1, 'T', 'ABC123', 0)").run();
  for (const t of ['A Bill to Ban Things', 'A Bill to Ban Things']) db.prepare('INSERT INTO team_bills (team_id, title, updated_at) VALUES (1, ?, 0)').run(t);
  const opts = { dir, backup: () => {}, log: () => {} };
  runAiSeeds(db, opts);
  // Bill 2: a student edited the shipped item, so that bill keeps its set untouched.
  db.prepare("UPDATE bill_items SET text = 'My edited claim' WHERE bill_id = 2").run();
  db.prepare("INSERT INTO bill_items (bill_id, section, side, text, updated_at, ai) VALUES (1, 'neg', 'neg', 'My own note', 0, 0)").run();
  fs.mkdirSync(path.join(dir, 'v2')); fs.writeFileSync(path.join(dir, 'v2', '01.md'), reply('New claim', 'New summary.'));
  fs.writeFileSync(path.join(dir, 'v2', 'seed.json'), '{"replaces":"v1"}');
  assert.deepEqual(runAiSeeds(db, opts), [{ name: 'v2', bills: 1, items: 1, removed: 1 }]);
  const texts = (id) => db.prepare('SELECT text FROM bill_items WHERE bill_id = ? ORDER BY id').all(id).map((r) => r.text);
  assert.deepEqual(texts(1), ['My own note', 'New claim']);
  assert.deepEqual(texts(2), ['My edited claim']);
  assert.equal(db.prepare('SELECT ai_summary FROM team_bills WHERE id = 1').get().ai_summary, 'New summary.');
  assert.deepEqual(runAiSeeds(db, opts), []);
  // On a fresh database the replaced seed never runs; only the new one loads.
  const fresh = open(':memory:'); schema(fresh);
  fresh.prepare("INSERT INTO teams (id, name, join_code, created_at) VALUES (1, 'T', 'ABC123', 0)").run();
  fresh.prepare("INSERT INTO team_bills (team_id, title, updated_at) VALUES (1, 'A Bill to Ban Things', 0)").run();
  assert.deepEqual(runAiSeeds(fresh, opts), [{ name: 'v2', bills: 1, items: 1 }]);
});

test('the shipped WSFA Fall 2026 replies all read cleanly', () => {
  const { parseAiReply } = require('../server/aikit');
  const folder = path.join(__dirname, '..', 'server', 'seeds', 'ai-wsfa-fall-2026-v2');
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 17);
  for (const f of files) {
    const r = parseAiReply(fs.readFileSync(path.join(folder, f), 'utf8'));
    assert.ok(r.title && r.summary && r.items.length >= 15 && !r.warnings.length && r.items.every((i) => !i.flags.length && i.detail.length < 3000), f);
  }
});
