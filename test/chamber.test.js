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
  return { call, ok: async (m, p, b) => { const r = await call(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; } };
}

test('a full chamber session works end to end with role-based access', async () => {
  const admin = client();
  assert.equal((await admin.ok('GET', '/api/setup')).needed, true);
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  assert.equal((await client().call('POST', '/api/setup', { username: 'x', password: 'secret1' })).status, 403);

  // People
  const { users } = await admin.ok('POST', '/api/users/bulk', {
    text: 'Avery A, Lincoln\nBlake B, Roosevelt\nCasey C, Lincoln\nDana D, Garfield\nJudge One, , judge\nJudge Two, , judge',
  });
  assert.equal(users.length, 6);
  const [avery, blake, casey, dana, j1, j2] = users;
  const login = async (u) => { const c = client(); await c.ok('POST', '/api/login', { username: u.username, password: u.password }); return c; };
  const cA = await login(avery), cB = await login(blake), cC = await login(casey), cD = await login(dana);
  const cJ1 = await login(j1), cJ2 = await login(j2);
  assert.equal((await client().call('POST', '/api/login', { username: avery.username, password: 'nope' })).status, 401);

  // Chamber
  const { id } = await admin.ok('POST', '/api/chambers', { name: 'Chamber A' });
  const P = (p) => `/api/chambers/${id}${p}`;
  assert.equal((await cA.call('GET', P('/state'))).status, 403, 'non-members cannot see the chamber');
  await admin.ok('POST', P('/members'), { user_ids: users.map((u) => u.id) });
  await admin.ok('PUT', P(''), { po_user_id: dana.id, score_min: 1, score_max: 8, rank_count: 3 });
  assert.equal((await admin.call('PUT', P(''), { po_user_id: j1.id })).status, 400, 'a judge cannot preside');
  await admin.ok('POST', P('/legislation'), { title: 'Bill A', body: 'text' });
  await admin.ok('POST', P('/legislation'), { title: 'Resolution B', kind: 'resolution' });
  let st = await cA.ok('GET', P('/state'));
  const [billA, resB] = st.legislation;
  assert.equal(st.me.isCompetitor, true);
  assert.equal(st.my_scores, undefined, 'competitors get no score data');

  // Competitors cannot run the chamber; the PO can.
  assert.equal((await cA.call('POST', P(`/legislation/${billA.id}/begin`))).status, 403);
  await cD.ok('POST', P('/docket-order'), { ids: [resB.id, billA.id] });
  await cD.ok('POST', P('/docket-order'), { ids: [billA.id, resB.id] });
  await cD.ok('POST', P(`/legislation/${billA.id}/begin`));
  st = await cD.ok('GET', P('/state'));
  assert.equal(st.chamber.status, 'in_session');
  assert.equal(st.chamber.next_side, 'authorship');
  assert.ok(!st.speaking_precedence.includes(dana.id), 'PO is not in the speaking queue');

  // Rising to speak, recognition, timers, questioning
  await cB.ok('POST', P('/requests'), { kind: 'neg' });
  assert.equal((await cD.call('POST', P('/requests'), { kind: 'aff' })).status, 400, 'PO cannot seek the floor');
  const { speech_id: s1 } = await cD.ok('POST', P('/recognize'), { user_id: avery.id, side: 'authorship' });
  st = await cA.ok('GET', P('/state'));
  assert.equal(st.chamber.timer.label, 'Speech');
  assert.equal(st.chamber.timer.duration, 180);
  await cD.ok('POST', P('/timer'), { action: 'pause' });
  await cD.ok('POST', P('/timer'), { action: 'resume' });
  await cD.ok('POST', P('/questioning'));
  st = await cA.ok('GET', P('/state'));
  assert.equal(st.chamber.timer.label, 'Questioning');
  assert.equal(st.chamber.timer.duration, 120, 'authorship gets the longer questioning block');
  await cD.ok('POST', P('/questions'), { user_id: casey.id });
  await cD.ok('POST', P('/speech/end'));

  st = await cD.ok('GET', P('/state'));
  assert.equal(st.chamber.next_side, 'neg');
  assert.equal(st.speaking_precedence[st.speaking_precedence.length - 1], avery.id, 'the speaker drops to the bottom of precedence');
  assert.equal(st.question_precedence[st.question_precedence.length - 1], casey.id);
  const { speech_id: s2 } = await cD.ok('POST', P('/recognize'), { user_id: blake.id, side: 'neg' });
  st = await cD.ok('GET', P('/state'));
  assert.equal(st.requests.length, 0, 'recognizing clears the speaker\'s request');
  await cD.ok('POST', P('/speech/end'));
  const { speech_id: s3 } = await cD.ok('POST', P('/recognize'), { user_id: casey.id, side: 'aff' });

  // Motion for previous question needs two-thirds; competitors vote on their devices.
  const { motion_id } = await cD.ok('POST', P('/motions'), { kind: 'previous_question', mover_id: blake.id });
  await cD.ok('POST', P('/votes'), { target_type: 'motion', target_id: motion_id });
  assert.equal((await cD.call('POST', P('/votes'), { target_type: 'legislation', target_id: billA.id })).status, 400, 'one vote at a time');
  await cA.ok('POST', P('/ballot'), { choice: 'yes' });
  await cB.ok('POST', P('/ballot'), { choice: 'yes' });
  await cC.ok('POST', P('/ballot'), { choice: 'no' });
  assert.equal((await cD.call('POST', P('/ballot'), { choice: 'yes' })).status, 400, 'PO does not vote');
  assert.equal((await cJ1.call('POST', P('/ballot'), { choice: 'yes' })).status, 403, 'judges do not vote');
  st = await cA.ok('GET', P('/state'));
  assert.equal(st.open_vote.tally, null, 'competitors do not see the running tally');
  assert.equal(st.open_vote.cast, 3);
  st = await cD.ok('GET', P('/state'));
  assert.deepEqual(st.open_vote.tally, { yes: 2, no: 1, abstain: 0 });
  let r = await cD.ok('POST', P(`/votes/${st.open_vote.id}/close`));
  assert.equal(r.result, 'passed', '2 of 3 meets two-thirds');

  // Vote on the bill: 1-2 fails.
  await cD.ok('POST', P('/votes'), { target_type: 'legislation', target_id: billA.id });
  await cA.ok('POST', P('/ballot'), { choice: 'yes' });
  await cB.ok('POST', P('/ballot'), { choice: 'no' });
  await cC.ok('POST', P('/ballot'), { choice: 'no' });
  st = await cD.ok('GET', P('/state'));
  r = await cD.ok('POST', P(`/votes/${st.open_vote.id}/close`));
  assert.equal(r.result, 'failed');
  st = await cD.ok('GET', P('/state'));
  assert.equal(st.legislation.find((l) => l.id === billA.id).status, 'failed');
  assert.equal(st.chamber.current_legislation_id, null);
  assert.equal(st.chamber.current_speech_id, null);
  assert.ok(st.speeches.find((s) => s.id === s3).ended_at, 'open speech is closed when the item ends');

  // Table the resolution.
  await cD.ok('POST', P(`/legislation/${resB.id}/begin`));
  const { motion_id: m2 } = await cD.ok('POST', P('/motions'), { kind: 'table', mover_id: avery.id });
  await cD.ok('POST', P(`/motions/${m2}/status`), { status: 'passed' });
  st = await cD.ok('GET', P('/state'));
  assert.equal(st.legislation.find((l) => l.id === resB.id).status, 'tabled');

  // Scoring is judge-only and private.
  assert.equal((await cA.call('PUT', P(`/scores/${s1}`), { points: 6 })).status, 403);
  assert.equal((await cD.call('PUT', P(`/scores/${s1}`), { points: 6 })).status, 403, 'PO cannot score');
  assert.equal((await cJ1.call('PUT', P(`/scores/${s1}`), { points: 9 })).status, 400, 'out of range');
  await cJ1.ok('PUT', P(`/scores/${s1}`), { points: 7, comment: 'Clear authorship' });
  await cJ1.ok('PUT', P(`/scores/${s2}`), { points: 5 });
  await cJ1.ok('PUT', P(`/scores/${s3}`), { points: 6 });
  await cJ2.ok('PUT', P(`/scores/${s1}`), { points: 6 });
  await cJ2.ok('PUT', P(`/scores/${s2}`), { points: 8 });
  await cJ1.ok('PUT', P('/po-score'), { points: 8 });
  await cJ2.ok('PUT', P('/po-score'), { points: 7 });
  assert.equal((await cJ1.call('PUT', P('/rankings'), { user_ids: [avery.id, blake.id, casey.id, dana.id] })).status, 400, 'max 3 ranks');
  await cJ1.ok('PUT', P('/rankings'), { user_ids: [dana.id, avery.id, casey.id] });
  await cJ2.ok('PUT', P('/rankings'), { user_ids: [blake.id, dana.id, avery.id] });

  const j1State = await cJ1.ok('GET', P('/state'));
  assert.equal(j1State.my_scores[s1].points, 7);
  assert.equal(j1State.my_scores[s1].comment, 'Clear authorship');
  const j2State = await cJ2.ok('GET', P('/state'));
  assert.equal(j2State.my_scores[s3], undefined, 'judges only see their own scores');
  assert.equal(JSON.stringify(await cA.ok('GET', P('/state'))).includes('Clear authorship'), false, 'comments never reach competitors');

  // Results are admin-only.
  assert.equal((await cJ1.call('GET', P('/results'))).status, 403);
  assert.equal((await cD.call('GET', P('/results'))).status, 403);
  const res = await admin.ok('GET', P('/results'));
  const row = (u) => res.rows.find((x) => x.id === u.id);
  assert.equal(row(dana).rank_total, 3, 'PO: 1 + 2');
  assert.equal(row(dana).total_points, 15);
  assert.equal(row(avery).rank_total, 5, '2 + 3');
  assert.equal(row(avery).total_points, 13);
  assert.equal(row(blake).rank_total, 5, 'unranked (4) + 1');
  assert.equal(row(casey).rank_total, 7, '3 + unranked (4)');
  assert.deepEqual(res.rows.map((x) => x.name), ['Dana D', 'Avery A', 'Blake B', 'Casey C'], 'avery beats blake on points at equal rank sum');
  const csv = await admin.call('GET', P('/results.csv'));
  assert.match(csv.data, /"1","Dana D \(PO\)"/);

  // Scored speeches are protected from removal.
  assert.equal((await cD.call('DELETE', P(`/speeches/${s1}`))).status, 400);
});
