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

test('the shipped WSFA Fall 2026 replies all read cleanly', () => {
  const { parseAiReply } = require('../server/aikit');
  const folder = path.join(__dirname, '..', 'server', 'seeds', 'ai-wsfa-fall-2026');
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 17);
  for (const f of files) {
    const r = parseAiReply(fs.readFileSync(path.join(folder, f), 'utf8'));
    assert.ok(r.title && r.summary && r.items.length >= 13 && !r.warnings.length && r.items.every((i) => !i.flags.length), f);
  }
});
