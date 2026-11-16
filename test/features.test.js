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


test('precedence queue: speakers drop to the bottom, chair can drag, reset and draw', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { users } = await admin.ok('POST', '/api/users/bulk', { text: 'P1\nP2\nP3\nP4\nPO Person' });
  const [p1, p2, p3, p4, po] = users;
  const { id } = await admin.ok('POST', '/api/chambers', { name: 'Q' });
  const P = (p) => `/api/chambers/${id}${p}`;
  await admin.ok('POST', P('/members'), { user_ids: users.map((u) => u.id) });
  await admin.ok('PUT', P(''), { po_user_id: po.id });
  await admin.ok('POST', P('/legislation'), { title: 'B' });
  let st = await admin.ok('GET', P('/state'));
  assert.deepEqual(st.speaking_precedence, [p1.id, p2.id, p3.id, p4.id], 'seat order before anyone speaks');
  await admin.ok('POST', P(`/legislation/${st.legislation[0].id}/begin`));

  // Drag P3 to the top, then recognize P3: P3 goes to the bottom, others keep the dragged order.
  await admin.ok('POST', P('/queue'), { kind: 'speak', action: 'set', ids: [p3.id, p1.id, p2.id, p4.id, po.id] });
  st = await admin.ok('GET', P('/state'));
  assert.deepEqual(st.speaking_precedence, [p3.id, p1.id, p2.id, p4.id]);
  await admin.ok('POST', P('/recognize'), { user_id: p3.id, side: 'authorship' });
  st = await admin.ok('GET', P('/state'));
  assert.deepEqual(st.speaking_precedence, [p1.id, p2.id, p4.id, p3.id]);
  await admin.ok('POST', P('/queue'), { kind: 'speak', action: 'set', ids: [p4.id, p1.id, p2.id, p3.id] });
  st = await admin.ok('GET', P('/state'));
  assert.deepEqual(st.speaking_precedence, [p4.id, p1.id, p2.id, p3.id]);
  assert.deepEqual(st.speaking_rule_order, [p1.id, p2.id, p4.id, p3.id]);
  await admin.ok('POST', P('/queue'), { kind: 'speak', action: 'reset' });
  st = await admin.ok('GET', P('/state'));
  assert.deepEqual(st.speaking_precedence, st.speaking_rule_order);
  // Random draw keeps the person who already spoke last.
  await admin.ok('POST', P('/queue'), { kind: 'speak', action: 'shuffle' });
  st = await admin.ok('GET', P('/state'));
  assert.equal(st.speaking_precedence[3], p3.id);
  // Bad list is refused; competitors cannot reorder.
  assert.equal((await admin.call('POST', P('/queue'), { kind: 'speak', action: 'set', ids: [p1.id, 999999] })).status, 400);
  const c1 = client(); await c1.ok('POST', '/api/login', { username: p1.username, password: p1.password });
  assert.equal((await c1.call('POST', P('/queue'), { kind: 'speak', action: 'reset' })).status, 403);

  // Question queue moves independently.
  await admin.ok('POST', P('/questions'), { user_id: p1.id });
  st = await admin.ok('GET', P('/state'));
  assert.equal(st.question_precedence[st.question_precedence.length - 1], p1.id);

  // A competitor added later joins at the bottom.
  const { user: late } = await admin.ok('POST', '/api/users', { display_name: 'Late Arrival', role: 'competitor' });
  await admin.ok('POST', P('/members'), { user_ids: [late.id] });
  st = await admin.ok('GET', P('/state'));
  assert.ok(st.speaking_precedence.includes(late.id));
});

test('mock tournament: made-up people, view-as for admins only, one-click delete', async () => {
  const admin = client();
  await admin.ok('POST', '/api/login', { username: 'admin', password: 'secret1' });
  const { id, password } = await admin.ok('POST', '/api/mock', {});
  assert.equal(password, 'practice');
  const P = (p) => `/api/chambers/${id}${p}`;
  let st = await admin.ok('GET', P('/state'));
  assert.equal(st.is_mock, true);
  assert.equal(st.competitors.length, 12);
  assert.equal(st.judges.length, 2);
  assert.equal(st.legislation.length, 4);
  assert.ok(st.chamber.po_user_id);
  const people = st.view_as_options;
  assert.equal(people.length, 14);
  const { users } = await admin.ok('GET', '/api/users');
  assert.ok(!users.some((u) => people.some((p) => p.id === u.id)), 'mock people stay out of the real people list');

  // View as the PO and run the floor; view as a competitor and vote; view as a judge and score.
  const as = async (uid, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-View-As': String(uid), Cookie: admin.cookie() }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
  };
  const poId = st.chamber.po_user_id, comp = st.competitors[0].id, judge = st.judges[0].id;
  const poState = await as(poId, 'GET', P('/state'));
  assert.equal(poState.me.isPO, true);
  assert.equal(poState.me.viewingAs, true);
  await as(poId, 'POST', P(`/legislation/${st.legislation[0].id}/begin`));
  const { speech_id } = await as(poId, 'POST', P('/recognize'), { user_id: comp, side: 'authorship' });
  await as(poId, 'POST', P('/votes'), { target_type: 'legislation', target_id: st.legislation[0].id });
  await as(comp, 'POST', P('/ballot'), { choice: 'yes' });
  await as(judge, 'PUT', P(`/scores/${speech_id}`), { points: 5 });
  const jState = await as(judge, 'GET', P('/state'));
  assert.equal(jState.my_scores[speech_id].points, 5);

  // View-as does nothing for real (non-mock) people or for non-admins.
  const real = client();
  const { user: realComp } = await admin.ok('POST', '/api/users', { display_name: 'Real Kid', role: 'competitor', password: 'secret1' });
  await real.ok('POST', '/api/login', { username: realComp.username, password: 'secret1' });
  const r = await fetch(base + P('/state'), { headers: { 'X-View-As': String(poId), Cookie: real.cookie() } });
  assert.equal(r.status, 403, 'a non-admin cannot borrow a mock identity');

  await admin.ok('DELETE', P(''));
  assert.equal((await admin.call('GET', P('/state'))).status, 404);
  const login = await client().call('POST', '/api/login', { username: people[0].username || 'mock.avery', password: 'practice' });
  assert.equal(login.status, 401, 'mock logins are gone');
});

test('personal trackers are private to their owner', async () => {
  const admin = client();
  await admin.ok('POST', '/api/login', { username: 'admin', password: 'secret1' });
  const { user: a } = await admin.ok('POST', '/api/users', { display_name: 'Tracker A', role: 'competitor', password: 'secret1' });
  const { user: b } = await admin.ok('POST', '/api/users', { display_name: 'Tracker B', role: 'competitor', password: 'secret1' });
  const ca = client(); await ca.ok('POST', '/api/login', { username: a.username, password: 'secret1' });
  const cb = client(); await cb.ok('POST', '/api/login', { username: b.username, password: 'secret1' });
  const { id } = await ca.ok('POST', '/api/trackers', { name: 'Regionals' });
  await ca.ok('PUT', `/api/trackers/${id}`, { data: { people: [{ id: 'x', name: 'Someone' }] } });
  const t = await ca.ok('GET', `/api/trackers/${id}`);
  assert.equal(t.data.people[0].name, 'Someone');
  assert.equal((await cb.call('GET', `/api/trackers/${id}`)).status, 404);
  assert.equal((await cb.call('PUT', `/api/trackers/${id}`, { data: {} })).status, 404);
  assert.equal((await cb.ok('GET', '/api/trackers')).trackers.length, 0);
  await ca.ok('DELETE', `/api/trackers/${id}`);
});
