'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createApp } = require('../server/app');

test('practice runs are logged per speech plan, private to the speaker', async () => {
  const app = createApp(open(':memory:'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  try {
    const coach = mk();
    await coach('POST', '/api/setup', { username: 'admin', display_name: 'Coach', password: 'secret1' });
    const team = (await coach('POST', '/api/teams', { name: 'T' })).data;
    const { users } = (await coach('POST', '/api/users/bulk', { text: 'Sam S, X' })).data;
    const sam = mk(); await sam('POST', '/api/login', { username: users[0].username, password: users[0].password });
    await sam('POST', '/api/teams/join', { code: (await coach('GET', `/api/teams/${team.id}`)).data.team.join_code });
    await coach('POST', `/api/teams/${team.id}/members/${users[0].id}`, { action: 'approve' });

    const plan = (await sam('POST', `/api/teams/${team.id}/plans`, { title: 'Aff: Audit', side: 'aff' })).data;
    const P = `/api/teams/${team.id}/plans/${plan.id}`;
    const z = await sam('POST', `${P}/runs`, { seconds: 0 }); assert.equal(z.status, 400, JSON.stringify(z.data) + JSON.stringify(plan));
    await sam('POST', `${P}/runs`, { seconds: 171, target: 180, rating: 3, notes: 'Too fast' });
    const second = (await sam('POST', `${P}/runs`, { seconds: 186, target: 999, rating: 9 })).data;
    let got = (await sam('GET', P)).data;
    assert.equal(got.runs.length, 2);
    assert.deepEqual(got.runs.map((r) => [r.seconds, r.target, r.rating]).sort(), [[171, 180, 3], [186, 180, 5]]);
    const prep = (await sam('GET', `/api/teams/${team.id}/prep`)).data;
    assert.equal(prep.plans[0].practice_count, 2);

    // Nobody else can log or see them unless the plan is shared, and only the speaker can delete.
    assert.equal((await coach('POST', `${P}/runs`, { seconds: 100 })).status, 404);
    await sam('PUT', P, { shared_with_leaders: true });
    assert.equal((await coach('GET', P)).data.runs.length, 2);
    assert.equal((await coach('POST', `${P}/runs`, { seconds: 100 })).status, 403);
    await coach('DELETE', `${P}/runs/${second.id}`);
    assert.equal((await sam('GET', P)).data.runs.length, 2);
    await sam('DELETE', `${P}/runs/${second.id}`);
    got = (await sam('GET', P)).data;
    assert.deepEqual(got.runs.map((r) => r.seconds), [171]);
  } finally { app.locals.close(); server.close(); }
});
