'use strict';
// End-to-end run of one chamber over HTTP: setup, roles, floor, votes, scoring, results.
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
  return { call, cookie: () => cookie, ok: async (m, p, b) => { const r = await call(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; } };
}



test('practice ballots, ballot submit/lock, and publishing levels', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { users } = await admin.ok('POST', '/api/users/bulk', { text: 'Ann\nBen\nCal\nJudge J, , judge\nJudge K, , judge' });
  const [ann, ben, cal, jj, jk] = users;
  const login = async (u) => { const c = client(); await c.ok('POST', '/api/login', { username: u.username, password: u.password }); return c; };
  const cA = await login(ann), cB = await login(ben), cJ = await login(jj), cK = await login(jk);
  const { id } = await admin.ok('POST', '/api/chambers', { name: 'R' });
  const P = (p) => `/api/chambers/${id}${p}`;
  await admin.ok('POST', P('/members'), { user_ids: users.map((u) => u.id) });
  await admin.ok('PUT', P(''), { po_user_id: cal.id, rank_count: 2 });
  await admin.ok('POST', P('/legislation'), { title: 'B' });
  const st0 = await admin.ok('GET', P('/state'));
  await admin.ok('POST', P(`/legislation/${st0.legislation[0].id}/begin`));
  const { speech_id: sA } = await admin.ok('POST', P('/recognize'), { user_id: ann.id, side: 'authorship' });
  const { speech_id: sB } = await admin.ok('POST', P('/recognize'), { user_id: ben.id, side: 'neg' });

  // Practice: Ann scores Ben, not herself; judges cannot use practice routes.
  assert.equal((await cA.call('PUT', P(`/practice/scores/${sA}`), { points: 6 })).status, 400);
  await cA.ok('PUT', P(`/practice/scores/${sB}`), { points: 4, comment: 'good refutation' });
  await cA.ok('PUT', P('/practice/rankings'), { user_ids: [ben.id, cal.id] });
  assert.equal((await cJ.call('PUT', P(`/practice/scores/${sB}`), { points: 4 })).status, 403);
  let st = await cA.ok('GET', P('/state'));
  assert.equal(st.my_practice_scores[sB].points, 4);
  assert.deepEqual(st.my_practice_rankings, [ben.id, cal.id]);
  assert.equal(JSON.stringify(await cB.ok('GET', P('/state'))).includes('good refutation'), false, 'practice notes are private');

  // Judges score; nothing visible to competitors yet.
  await cJ.ok('PUT', P(`/scores/${sA}`), { points: 5, comment: 'Strong authorship' });
  await cJ.ok('PUT', P(`/scores/${sB}`), { points: 3, comment: 'Needs evidence' });
  await cJ.ok('PUT', P('/po-score'), { points: 6, comment: 'Smooth chair' });
  await cK.ok('PUT', P(`/scores/${sA}`), { points: 4, comment: 'K on Ann' });
  let r = await cA.ok('GET', P('/reflection'));
  assert.equal(r.ballots.length, 0);
  assert.equal(r.standings, null);
  assert.equal(r.practice.scores[0].points, 4);

  // Submit requires a ranking, then locks.
  assert.equal((await cJ.call('POST', P('/ballot/submit'))).status, 400);
  await cJ.ok('PUT', P('/rankings'), { user_ids: [ann.id, cal.id] });
  await cJ.ok('POST', P('/ballot/submit'));
  assert.equal((await cJ.call('PUT', P(`/scores/${sA}`), { points: 6 })).status, 400, 'locked after submit');
  assert.ok((await cJ.ok('GET', P('/state'))).my_ballot.submitted_at);

  // Judge J publishes to each competitor: Ann sees only her own scores and comments from J.
  assert.equal((await cK.call('POST', P('/publish'), { target: 'ballot', judge_id: jj.id, level: 'all' })).status, 403, 'judges only publish their own');
  assert.equal((await cA.call('POST', P('/publish'), { target: 'standings', level: 'all' })).status, 403);
  await cJ.ok('POST', P('/publish'), { target: 'ballot', level: 'individual' });
  r = await cA.ok('GET', P('/reflection'));
  assert.equal(r.ballots.length, 1);
  assert.deepEqual(r.ballots[0].my_scores.map((x) => [x.points, x.comment]), [[5, 'Strong authorship']]);
  assert.equal(r.ballots[0].my_rank, 1);
  assert.equal(r.ballots[0].totals, undefined);
  assert.equal(JSON.stringify(r).includes('Needs evidence'), false, 'no one else\'s comments');
  assert.equal(JSON.stringify(r).includes('K on Ann'), false, 'unpublished judge stays private');

  // Admin publishes J's ballot to everyone: totals and ranking appear, still no other comments.
  await admin.ok('POST', P('/publish'), { target: 'ballot', judge_id: jj.id, level: 'all' });
  r = await cB.ok('GET', P('/reflection'));
  const totals = Object.fromEntries(r.ballots[0].totals.map((x) => [x.name, x.points]));
  assert.deepEqual(totals, { Ann: 5, Ben: 3, Cal: 6 });
  assert.deepEqual(r.ballots[0].ranking.map((x) => x.name), ['Ann', 'Cal']);
  assert.equal(JSON.stringify(r).includes('Strong authorship'), false);
  assert.equal(r.ballots[0].my_scores[0].comment, 'Needs evidence');

  // Standings: individual shows only your own row; all shows everyone.
  await admin.ok('POST', P('/publish'), { target: 'standings', level: 'individual' });
  r = await cB.ok('GET', P('/reflection'));
  assert.equal(r.standings.rows.length, 1);
  assert.equal(r.standings.rows[0].name, 'Ben');
  await admin.ok('POST', P('/publish'), { target: 'standings', level: 'all' });
  r = await cB.ok('GET', P('/reflection'));
  assert.equal(r.standings.rows.length, 3);
  assert.equal(r.standings.rows[0].by_judge, undefined, 'no per-judge breakdown');

  // Admin can reopen a submitted ballot.
  await admin.ok('POST', P(`/ballots/${jj.id}/reopen`));
  await cJ.ok('PUT', P(`/scores/${sA}`), { points: 6 });
  const res = await admin.ok('GET', P('/results'));
  assert.equal(res.progress.find((p) => p.judge_id === jj.id).publish, 'all');
  assert.equal(res.standings_publish, 'all');
});
