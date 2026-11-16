'use strict';
// Chambers with no PO in the app: each judge and competitor keeps a private speech log.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createApp } = require('../server/app');

let app, server, base;
test.before(async () => {
  app = createApp(open(':memory:'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { app.locals.close(); server.close(); });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, ok: async (m, p, b) => { const r = await call(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; } };
}

test('judges and competitors track the floor themselves when no PO runs it', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { users } = await admin.ok('POST', '/api/users/bulk', { text: 'Avery A, Lincoln\nBlake B, Roosevelt\nCasey C, Lincoln\nJudge One, , judge\nJudge Two, , judge' });
  const [avery, blake, casey, j1, j2] = users;
  const login = async (u) => { const c = client(); await c.ok('POST', '/api/login', { username: u.username, password: u.password }); return c; };
  const cA = await login(avery), cB = await login(blake), cJ1 = await login(j1), cJ2 = await login(j2);
  const { id } = await admin.ok('POST', '/api/chambers', { name: 'Room 12' });
  const P = (p) => `/api/chambers/${id}${p}`;
  await admin.ok('POST', P('/members'), { user_ids: users.map((u) => u.id) });
  await admin.ok('POST', P('/legislation'), { title: 'Bill A' });
  const billA = (await cJ1.ok('GET', P('/state'))).legislation[0];

  // Off by default: the PO runs the floor.
  assert.equal((await cJ1.ok('GET', P('/state'))).chamber.floor_mode, 'po');
  assert.equal((await cJ1.call('POST', P('/my-log'), { speaker_id: avery.id, side: 'authorship', legislation_id: billA.id })).status, 400);
  assert.equal((await cJ1.call('PUT', P(''), { floor_mode: 'self' })).status, 403, 'only admins change it');
  assert.equal((await admin.call('PUT', P(''), { floor_mode: 'nobody' })).status, 400);
  await admin.ok('PUT', P(''), { floor_mode: 'self' });

  // Judge One logs and scores three speeches, one on a bill that isn't on the docket.
  const { speech_id: s1 } = await cJ1.ok('POST', P('/my-log'), { speaker_id: avery.id, side: 'authorship', legislation_id: billA.id });
  const { speech_id: s2 } = await cJ1.ok('POST', P('/my-log'), { speaker_id: blake.id, side: 'neg', legislation_id: billA.id });
  const { speech_id: s3 } = await cJ1.ok('POST', P('/my-log'), { speaker_id: casey.id, side: 'aff', topic: 'A Bill to Reform Bail' });
  assert.equal((await cJ1.call('POST', P('/my-log'), { speaker_id: j2.id, side: 'aff' })).status, 400, 'only competitors speak');
  assert.equal((await cJ1.call('POST', P('/my-log'), { speaker_id: avery.id, side: 'sideways' })).status, 400);
  await cJ1.ok('PUT', P(`/my-log/${s1}`), { duration_seconds: 171 });
  await cJ1.ok('PUT', P(`/scores/${s1}`), { points: 6, comment: 'Strong open' });
  await cJ1.ok('PUT', P(`/scores/${s2}`), { points: 4 });
  await cJ1.ok('PUT', P(`/scores/${s3}`), { points: 5 });

  let st = await cJ1.ok('GET', P('/state'));
  assert.equal(st.speeches.length, 0, 'there is no official record');
  assert.deepEqual(st.my_log.map((x) => [x.speaker_id, x.side, x.legislation_title]), [[avery.id, 'authorship', 'Bill A'], [blake.id, 'neg', 'Bill A'], [casey.id, 'aff', 'A Bill to Reform Bail']]);
  assert.equal(st.my_log[0].duration_seconds, 171);
  assert.ok(st.competitors.every((p) => p.speeches === 0), 'precedence stats ignore private logs');

  // Nobody else sees or touches Judge One's log.
  st = await cJ2.ok('GET', P('/state'));
  assert.equal(st.my_log.length, 0);
  assert.equal((await cJ2.call('PUT', P(`/scores/${s1}`), { points: 3 })).status, 404);
  assert.equal((await cJ2.call('PUT', P(`/my-log/${s1}`), { side: 'neg' })).status, 404);
  await cJ2.ok('DELETE', P(`/my-log/${s1}`));
  assert.equal((await cJ1.ok('GET', P('/state'))).my_log.length, 3, 'deleting someone else\'s entry does nothing');
  assert.equal(JSON.stringify(await cA.ok('GET', P('/state'))).includes('Strong open'), false);

  // Fixing a mistake.
  await cJ1.ok('PUT', P(`/my-log/${s2}`), { side: 'aff' });
  assert.equal((await cJ1.ok('GET', P('/state'))).my_log.find((x) => x.id === s2).side, 'aff');
  assert.equal((await cJ1.call('PUT', P(`/my-log/${s2}`), { legislation_id: 99999 })).status, 400);

  // Judge Two keeps a separate log of the same round.
  const { speech_id: t1 } = await cJ2.ok('POST', P('/my-log'), { speaker_id: avery.id, side: 'authorship', legislation_id: billA.id });
  const { speech_id: t2 } = await cJ2.ok('POST', P('/my-log'), { speaker_id: avery.id, side: 'aff', legislation_id: billA.id });
  await cJ2.ok('PUT', P(`/scores/${t1}`), { points: 5 });
  await cJ2.ok('PUT', P(`/scores/${t2}`), { points: 5 });

  // Competitors log for practice; they can't practice-score themselves.
  const { speech_id: p1 } = await cA.ok('POST', P('/my-log'), { speaker_id: blake.id, side: 'neg', legislation_id: billA.id });
  const { speech_id: p2 } = await cA.ok('POST', P('/my-log'), { speaker_id: avery.id, side: 'aff', legislation_id: billA.id });
  await cA.ok('PUT', P(`/practice/scores/${p1}`), { points: 3 });
  assert.equal((await cA.call('PUT', P(`/practice/scores/${p2}`), { points: 6 })).status, 400);
  assert.equal((await cB.call('PUT', P(`/practice/scores/${p1}`), { points: 6 })).status, 404);
  assert.equal((await cA.call('PUT', P(`/scores/${p1}`), { points: 6 })).status, 403);

  // Ranking, submitting and results work as before.
  await cJ1.ok('PUT', P('/rankings'), { user_ids: [avery.id, casey.id, blake.id] });
  await cJ2.ok('PUT', P('/rankings'), { user_ids: [avery.id, blake.id] });
  await cJ1.ok('POST', P('/ballot/submit'));
  assert.equal((await cJ1.call('POST', P('/my-log'), { speaker_id: blake.id, side: 'neg', legislation_id: billA.id })).status, 400, 'submitted ballot is locked');
  assert.equal((await cJ1.call('DELETE', P(`/my-log/${s3}`))).status, 400);
  const res = await admin.ok('GET', P('/results'));
  const row = (u) => res.rows.find((x) => x.id === u.id);
  assert.equal(row(avery).total_points, 16);
  assert.equal(row(avery).speeches, 2, 'speech count comes from the judges\' logs');
  assert.equal(row(blake).total_points, 4);
  assert.equal(row(casey).speeches, 1);
  assert.equal(res.rows[0].name, 'Avery A');

  // A judge can remove their own entry while the ballot is open; its score goes with it.
  await cJ2.ok('DELETE', P(`/my-log/${t2}`));
  st = await cJ2.ok('GET', P('/state'));
  assert.equal(st.my_log.length, 1);
  assert.equal(st.my_scores[t2], undefined);
});

test('older databases gain speech logs without losing speeches or scores', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'congress-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, school TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE chambers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE legislation (id INTEGER PRIMARY KEY, chamber_id INTEGER NOT NULL, title TEXT NOT NULL);
    CREATE TABLE speeches (id INTEGER PRIMARY KEY, chamber_id INTEGER NOT NULL REFERENCES chambers(id) ON DELETE CASCADE, legislation_id INTEGER NOT NULL REFERENCES legislation(id) ON DELETE CASCADE,
      speaker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, side TEXT NOT NULL, recognized_at INTEGER NOT NULL, ended_at INTEGER, duration_seconds INTEGER);
    CREATE TABLE speech_scores (speech_id INTEGER NOT NULL REFERENCES speeches(id) ON DELETE CASCADE, judge_id INTEGER NOT NULL, points INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY (speech_id, judge_id));
    INSERT INTO users (id, username, display_name, role, password_hash) VALUES (1, 'a', 'A', 'competitor', 'x'), (2, 'j', 'J', 'judge', 'x');
    INSERT INTO chambers (id, name) VALUES (1, 'Old');
    INSERT INTO legislation (id, chamber_id, title) VALUES (1, 1, 'Bill');
    INSERT INTO speeches (id, chamber_id, legislation_id, speaker_id, side, recognized_at, duration_seconds) VALUES (7, 1, 1, 1, 'aff', 1000, 175);
    INSERT INTO speech_scores VALUES (7, 2, 5, 'ok', 1);
  `);
  old.close();
  const db = open(file);
  const cols = db.prepare('PRAGMA table_info(speeches)').all();
  assert.ok(cols.some((c) => c.name === 'logged_by'));
  assert.equal(cols.find((c) => c.name === 'legislation_id').notnull, 0);
  assert.deepEqual({ ...db.prepare('SELECT id, speaker_id, side, duration_seconds, logged_by FROM speeches').get() }, { id: 7, speaker_id: 1, side: 'aff', duration_seconds: 175, logged_by: null });
  assert.equal(db.prepare('SELECT points FROM speech_scores WHERE speech_id = 7').get().points, 5);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.prepare('DELETE FROM speeches WHERE id = 7').run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM speech_scores').get().n, 0, 'scores still cascade with their speech');
  db.close();
  open(file).close(); // opening again is a no-op
});
