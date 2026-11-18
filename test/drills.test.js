'use strict';
// Bill drills: which bills are offered, ratings, readiness, the coach view and the bill of the week.
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
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, ok: async (m, p, b) => { const r = await call(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; } };
}


test('bill drills: current bills, ratings, readiness, coach view, bill of the week', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { user: cu } = await admin.ok('POST', '/api/users', { display_name: 'Coach Cole', role: 'judge', password: 'secret1' });
  const coach = client(); await coach.ok('POST', '/api/login', { username: cu.username, password: 'secret1' });
  const { id: tid } = await coach.ok('POST', '/api/teams', { name: 'Lincoln' });
  const T = (p = '') => `/api/teams/${tid}${p}`;
  const code = (await coach.ok('GET', T())).team.join_code;
  const sam = client(); await sam.ok('POST', '/api/signup', { code, display_name: 'Sam', username: 'sam', password: 'secret1' });
  const sid = (await coach.ok('GET', T())).members.find((m) => m.name === 'Sam').id;
  await coach.ok('POST', T(`/members/${sid}`), { action: 'approve' });

  // No research yet: nothing to drill.
  assert.deepEqual((await sam.ok('GET', T('/drills'))).bills, []);
  const { id: b1 } = await coach.ok('POST', T('/bills'), { title: 'Tariff Bill' });
  const { id: b2 } = await coach.ok('POST', T('/bills'), { title: 'Tax Bill' });
  const add = (b, section, text, detail = '', extra = {}) => coach.ok('POST', T(`/bills/${b}/items`), { section, text, detail, ...extra });
  const q1 = (await add(b1, 'question', 'Can a law require impeachment?', 'Best answer (if you\'re affirmative): No, but...')).id;
  const q2 = (await add(b1, 'question', 'Why only Canada?')).id;
  const a1 = (await add(b1, 'aff', 'Congress holds the tariff power', 'Warrant: Article I.')).id;
  const e1 = (await add(b1, 'evidence', 'Canada is the top export market', '', { cite_source: 'USTR', cite_url: 'https://ustr.gov' })).id;
  // No bill is "up next", so bills with research are offered.
  let d = await sam.ok('GET', T('/drills'));
  assert.equal(d.current, false);
  assert.deepEqual(d.bills.map((b) => b.id), [b1]);
  await coach.ok('POST', T('/bills/bulk'), { ids: [b2], action: 'current' });
  d = await sam.ok('GET', T('/drills'));
  assert.equal(d.current, true);
  assert.deepEqual(d.bills.map((b) => b.id), [b2]);
  await coach.ok('POST', T('/bills/bulk'), { ids: [b1], action: 'current' });
  d = await sam.ok('GET', T('/drills'));
  const r0 = d.bills.find((b) => b.id === b1).readiness;
  assert.equal(r0.done, 0);
  assert.equal(r0.total, 5); // read, questions, refute, cite, speech
  assert.equal(d.bills.find((b) => b.id === b2).readiness.total, 2); // nothing to drill on b2 but reading and a speech
  assert.equal(d.roster, undefined);

  // Ratings come back as "latest", and fill in readiness.
  await sam.ok('POST', T(`/drills/${b1}/results`), { results: [{ kind: 'read' }, { kind: 'read' }, { kind: 'question', item_id: q1, rating: 0 }, { kind: 'question', item_id: q1, rating: 2 }, { kind: 'question', item_id: q2, rating: 0 }, { kind: 'refute', item_id: a1, rating: 1 }, { kind: 'cite', item_id: e1, rating: 9 }] });
  assert.equal((await sam.call('POST', T(`/drills/${b1}/results`), { results: [{ kind: 'question', item_id: 99999, rating: 2 }] })).status, 400);
  const one = await sam.ok('GET', T(`/drills/${b1}`));
  assert.equal(one.latest[`question:${q1}`], 2);
  assert.equal(one.latest[`question:${q2}`], 0);
  assert.equal(one.latest[`cite:${e1}`], 2);
  assert.equal(one.items.length, 4);
  const s = one.readiness.steps;
  assert.ok(s.read.done && s.questions.done && s.refute.done && s.cite.done && !s.speech.done);
  assert.equal(one.readiness.done, 4);

  // A practice run on a speech plan for this bill completes it.
  const { id: pid } = await sam.ok('POST', T('/plans'), { title: 'Quick speech', bill_id: b1, side: 'aff' });
  await sam.ok('POST', T(`/plans/${pid}/runs`), { seconds: 170, target: 180 });
  assert.equal((await sam.ok('GET', T(`/drills/${b1}`))).readiness.done, 5);

  // Coach view: readiness per teammate per bill, and the weakest drill type.
  await sam.ok('POST', T(`/drills/${b1}/results`), { results: [0, 0, 0].map(() => ({ kind: 'speed', item_id: q2, rating: 0 })) });
  const cv = await coach.ok('GET', T('/drills'));
  const row = cv.roster.find((m) => m.id === sid);
  assert.equal(row.bills[b1].done, 5);
  assert.equal(row.weakest.kind, 'speed');
  assert.ok(row.last > 0);

  // Bill of the week: leaders only; it's listed first even if not current.
  assert.equal((await sam.call('POST', T(`/drills/${b2}/pin`), {})).status, 403);
  await coach.ok('POST', T('/bills/bulk'), { ids: [b2], action: 'clear' });
  await coach.ok('POST', T(`/drills/${b2}/pin`), {});
  d = await sam.ok('GET', T('/drills'));
  assert.equal(d.pinned_bill_id, b2);
  assert.ok(d.bills.some((b) => b.id === b2));
  assert.equal((await sam.ok('GET', T(`/drills/${b2}`))).pinned, true);

  // AI items stay out when hidden.
  await coach.ok('POST', T(`/bills/${b1}/ai/import`), { items: [{ section: 'question', text: 'AI question?', detail: 'Answer' }] });
  assert.equal((await sam.ok('GET', T(`/drills/${b1}`))).items.length, 5);
  await sam.ok('PUT', '/api/me/ai', { hide: true });
  assert.equal((await sam.ok('GET', T(`/drills/${b1}`))).items.length, 4);
});
