'use strict';
// Offline support on the server (replayed changes are applied once, with their real time; conflict copies)
// and backups (create, download, export, restore).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { open } = require('../server/db');
const { createApp } = require('../server/app');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'congress-offline-'));
const dbFile = path.join(dir, 'congress.db');
let app, server, base;
test.before(async () => {
  app = createApp(open(dbFile), { dbFile, backupDir: path.join(dir, 'backups') });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { app.locals.close(); server.close(); });

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + p, {
      method, headers: { ...(body ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, ok: async (m, p, b, h) => { const r = await call(m, p, b, h); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; } };
}

test('replayed offline changes apply once, at the time they happened', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { users } = await admin.ok('POST', '/api/users/bulk', { text: 'Avery A, X\nBlake B, Y\nJudge J, , judge' });
  const [avery, blake, judge] = users;
  const cJ = client(); await cJ.ok('POST', '/api/login', { username: judge.username, password: judge.password });
  const { id } = await admin.ok('POST', '/api/chambers', { name: 'Room' });
  const P = (p) => `/api/chambers/${id}${p}`;
  await admin.ok('POST', P('/members'), { user_ids: users.map((u) => u.id) });
  await admin.ok('POST', P('/legislation'), { title: 'Bill' });
  const bill = (await admin.ok('GET', P('/state'))).legislation[0];
  await admin.ok('POST', P(`/legislation/${bill.id}/begin`));

  // The PO was offline: recognition 90 seconds ago, sent now. Sent twice (the first reply was lost).
  const t = Date.now() - 90000;
  const h = { 'X-Op-Id': 'op-recognize-0001', 'X-Op-Time': String(t) };
  const r1 = await admin.ok('POST', P('/recognize'), { user_id: avery.id, side: 'authorship' }, h);
  const r2 = await admin.ok('POST', P('/recognize'), { user_id: avery.id, side: 'authorship' }, h);
  assert.equal(r1.speech_id, r2.speech_id, 'the same answer comes back');
  let st = await admin.ok('GET', P('/state'));
  assert.equal(st.speeches.length, 1, 'applied once');
  assert.equal(st.speeches[0].recognized_at, t);
  assert.ok(st.chamber.timer.started_at === t, 'the timer started when the speech really began');
  // Pause 10s later, also replayed: elapsed is 10 seconds, not 90.
  await admin.ok('POST', P('/timer'), { action: 'pause' }, { 'X-Op-Id': 'op-pause-00000001', 'X-Op-Time': String(t + 10000) });
  st = await admin.ok('GET', P('/state'));
  assert.equal(st.chamber.timer.elapsed_ms, 10000);
  // Questions return their id so later offline changes can point at them.
  const { question_id } = await admin.ok('POST', P('/questions'), { user_id: blake.id });
  assert.ok(question_id > 0);
  // Times in the future, or more than a day old, are ignored.
  await admin.ok('POST', P('/speech/end'));
  const { speech_id: s2 } = await admin.ok('POST', P('/recognize'), { user_id: blake.id, side: 'neg' }, { 'X-Op-Time': String(Date.now() + 3600000) });
  st = await admin.ok('GET', P('/state'));
  assert.ok(st.speeches.find((x) => x.id === s2).recognized_at <= Date.now());
  // Same op id from a different person is a different change.
  await cJ.ok('PUT', P(`/scores/${r1.speech_id}`), { points: 5 }, { 'X-Op-Id': 'op-recognize-0001' });
  assert.equal((await cJ.ok('GET', P('/state'))).my_scores[r1.speech_id].points, 5);
  // An error is remembered too, so a retry gets the same answer.
  const e1 = await cJ.call('PUT', P(`/scores/${r1.speech_id}`), { points: 99 }, { 'X-Op-Id': 'op-bad-score-0001' });
  const e2 = await cJ.call('PUT', P(`/scores/${r1.speech_id}`), { points: 99 }, { 'X-Op-Id': 'op-bad-score-0001' });
  assert.equal(e1.status, 400); assert.equal(e2.status, 400);
});

test('an offline edit that crossed a newer teammate edit is kept as a separate copy', async () => {
  const admin = client(); await admin.ok('POST', '/api/login', { username: 'admin', password: 'secret1' });
  const { id: tid } = await admin.ok('POST', '/api/teams', { name: 'T' });
  const code = (await admin.ok('GET', `/api/teams/${tid}`)).team.join_code;
  const sam = client(); const su = await sam.ok('POST', '/api/signup', { code, display_name: 'Sam', username: 'sam', password: 'secret1' });
  const samId = su.user_id ?? (await sam.ok('GET', '/api/me')).user.id;
  await admin.ok('POST', `/api/teams/${tid}/members/${samId}`, { action: 'approve' });
  const T = (p) => `/api/teams/${tid}${p}`;
  const { id: bid } = await sam.ok('POST', T('/bills'), { title: 'Bill' });
  const { id: iid } = await sam.ok('POST', T(`/bills/${bid}/items`), { section: 'aff', text: 'Original' });
  const before = (await sam.ok('GET', T(`/bills/${bid}`))).items[0].updated_at;
  await new Promise((r) => setTimeout(r, 5));
  await admin.ok('PUT', T(`/bills/${bid}/items/${iid}`), { section: 'aff', text: 'Coach edit' });
  const r = await sam.ok('PUT', T(`/bills/${bid}/items/${iid}`), { section: 'aff', text: 'Sam offline edit', base_updated_at: before });
  assert.equal(r.conflict, true);
  const items = (await sam.ok('GET', T(`/bills/${bid}`))).items;
  assert.deepEqual(items.map((i) => i.text).sort(), ['Coach edit', 'Sam offline edit']);
  assert.equal(items.find((i) => i.text === 'Sam offline edit').conflict_of, iid);
  // No conflict when nobody else changed it.
  const latest = items.find((i) => i.id === iid).updated_at;
  await admin.ok('PUT', T(`/bills/${bid}/items/${iid}`), { section: 'aff', text: 'Coach again', base_updated_at: latest });
  assert.equal((await sam.ok('GET', T(`/bills/${bid}`))).items.length, 2);
});

test('backups: create, list, download, export everything, restore', async () => {
  const admin = client(); await admin.ok('POST', '/api/login', { username: 'admin', password: 'secret1' });
  const student = client(); await student.ok('POST', '/api/login', { username: 'sam', password: 'secret1' });
  assert.equal((await student.call('GET', '/api/admin/backups')).status, 403);
  assert.equal((await student.call('GET', '/api/admin/export.zip')).status, 403);

  const { backup } = await admin.ok('POST', '/api/admin/backups');
  assert.match(backup.name, /manual\.db\.gz$/);
  const listing = await admin.ok('GET', '/api/admin/backups');
  assert.equal(listing.backups[0].name, backup.name);
  assert.equal(listing.can_restore, true);
  const file = await admin.call('GET', `/api/admin/backups/${backup.name}`);
  assert.equal(file.status, 200);
  const raw = zlib.gunzipSync(file.data);
  assert.equal(raw.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await admin.call('GET', '/api/admin/backups/..%2Fcongress.db')).status, 404);

  const zip = await admin.call('GET', '/api/admin/export.zip');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const text = zip.data.toString('latin1');
  for (const n of ['people.csv', 'speeches.csv', 'speech_scores.csv', 'team_research.csv', 'README.txt']) assert.ok(text.includes(n), n);
  assert.ok(!text.includes('password_hash'), 'no passwords');
  assert.ok(!text.includes('speech_plans'), 'no private plans');

  // Change something, then restore the earlier backup: the change is gone and the app keeps working.
  await admin.ok('POST', '/api/chambers', { name: 'Made after the backup' });
  assert.equal((await student.call('POST', '/api/admin/restore', Buffer.from('not a database'))).status, 403);
  assert.equal((await admin.call('POST', '/api/admin/restore', Buffer.from('not a database'))).status, 400);
  await admin.ok('POST', '/api/admin/restore', { name: backup.name });
  const after = await admin.ok('GET', '/api/chambers');
  assert.equal(after.chambers.some((c) => c.name === 'Made after the backup'), false);
  assert.ok((await admin.ok('GET', '/api/admin/backups')).backups.some((b) => b.reason === 'pre-restore'), 'current data saved first');
  // Upload a downloaded backup file.
  await admin.ok('POST', '/api/admin/restore', file.data);
  assert.equal((await admin.ok('GET', '/api/chambers')).chambers.some((c) => c.name === 'Room'), true);
  assert.equal(fs.existsSync(`${dbFile}.restore`), false);
});
