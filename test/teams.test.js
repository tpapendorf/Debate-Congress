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



test('teams: join code sign-up, approval, shared research, private prep, progress', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { user: coachU } = await admin.ok('POST', '/api/users', { display_name: 'Coach Cole', role: 'judge', password: 'secret1' });
  const coach = client(); await coach.ok('POST', '/api/login', { username: coachU.username, password: 'secret1' });

  const { id: tid } = await coach.ok('POST', '/api/teams', { name: 'Lincoln Debate', school: 'Lincoln HS' });
  const T = (p = '') => `/api/teams/${tid}${p}`;
  let team = await coach.ok('GET', T());
  const code = team.team.join_code;
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(team.me.role, 'coach');

  // A student signs up with the code; they are pending and cannot see anything yet.
  assert.equal((await client().call('POST', '/api/signup', { code: 'NOPE00', display_name: 'X', password: 'secret1' })).status, 400);
  assert.equal((await client().ok('GET', `/api/join/${code.toLowerCase()}`)).team.name, 'Lincoln Debate');
  const sam = client();
  const su = await sam.ok('POST', '/api/signup', { code, display_name: 'Sam Student', username: 'sam', password: 'secret1' });
  assert.equal(su.team_id, tid);
  assert.equal((await sam.ok('GET', '/api/me')).user.role, 'competitor');
  assert.equal((await sam.ok('GET', '/api/teams')).teams[0].status, 'pending');
  assert.equal((await sam.call('GET', T())).status, 403);
  const ria = client(); await ria.ok('POST', '/api/signup', { code, display_name: 'Ria Captain', username: 'ria', password: 'secret1' });
  const outsider = client(); const { user: o } = await admin.ok('POST', '/api/users', { display_name: 'Other School', role: 'competitor', password: 'secret1' });
  await outsider.ok('POST', '/api/login', { username: o.username, password: 'secret1' });

  // Coach approves both and makes Ria a captain; a member cannot approve.
  team = await coach.ok('GET', T());
  const samId = team.members.find((m) => m.name === 'Sam Student').id;
  const riaId = team.members.find((m) => m.name === 'Ria Captain').id;
  await coach.ok('POST', T(`/members/${samId}`), { action: 'approve' });
  await coach.ok('POST', T(`/members/${riaId}`), { action: 'role', role: 'captain' });
  assert.equal((await sam.call('POST', T(`/members/${riaId}`), { action: 'approve' })).status, 403);
  assert.equal((await sam.ok('GET', T())).team.join_code, null, 'members do not see the code');
  assert.equal((await ria.ok('GET', T())).team.join_code, code, 'captains see the code');
  assert.equal((await ria.call('POST', T(`/members/${samId}`), { action: 'role', role: 'captain' })).status, 403, 'captains cannot change roles');
  assert.equal((await coach.call('POST', T('/leave'))).status, 400, 'last coach cannot leave');

  // Shared research: anyone on the team adds and edits; outsiders cannot see it.
  const { id: bid } = await sam.ok('POST', T('/bills'), { title: 'A Bill to Fund Rail', summary: 'Funds HSR' });
  await ria.ok('POST', T(`/bills/${bid}/items`), { section: 'aff', text: 'Cuts emissions' });
  const { id: evId } = await sam.ok('POST', T(`/bills/${bid}/items`), { section: 'evidence', side: 'aff', text: 'Rail emits 80% less CO2 per passenger-mile', cite_source: 'DOT report', cite_author: 'US DOT', cite_date: '2024', cite_url: 'dot.gov/rail' });
  await sam.ok('POST', T(`/bills/${bid}/items`), { section: 'question', text: 'Who pays for maintenance?' });
  await coach.ok('PUT', T(`/bills/${bid}/items/${evId}`), { detail: 'Table 3' });
  let bill = await ria.ok('GET', T(`/bills/${bid}`));
  const ev = bill.items.find((i) => i.id === evId);
  assert.equal(ev.cite_url, 'https://dot.gov/rail');
  assert.equal(ev.detail, 'Table 3');
  assert.equal(ev.updated_by_name, 'Coach Cole');
  assert.equal(bill.items.length, 3);
  assert.equal((await outsider.call('GET', T(`/bills/${bid}`))).status, 403);
  assert.equal((await sam.call('DELETE', T(`/bills/${bid}`))).status, 403, 'only leaders delete whole bills');

  // Import from a docket the user can see.
  const { id: cid } = await admin.ok('POST', '/api/chambers', { name: 'Prelims' });
  await admin.ok('POST', `/api/chambers/${cid}/legislation`, { title: 'A Resolution on Trade', body: 'RESOLVED...' });
  await admin.ok('POST', `/api/chambers/${cid}/members`, { user_ids: [samId] });
  const opts = await sam.ok('GET', T('/docket-options'));
  assert.equal(opts.items.length, 1);
  assert.equal((await sam.ok('POST', T('/bills/import'), { legislation_ids: [opts.items[0].id] })).added, 1);
  assert.equal((await sam.ok('POST', T('/bills/import'), { legislation_ids: [opts.items[0].id] })).added, 0, 'no duplicates');
  assert.equal((await ria.ok('POST', T('/bills/import'), { legislation_ids: [opts.items[0].id] })).added, 0, 'cannot import a docket you are not in');

  // Private prep: plans and notes are the author's only, unless a plan is shared with leaders.
  const { id: pid } = await sam.ok('POST', T('/plans'), { title: 'Rail aff 1', bill_id: bid, side: 'aff', outline: 'Intro' });
  await sam.ok('POST', T('/notes'), { title: 'My thoughts', body: 'secret', bill_id: bid });
  let prep = await ria.ok('GET', T('/prep'));
  assert.equal(prep.plans.length + prep.notes.length, 0);
  assert.equal((await coach.call('GET', T(`/plans/${pid}`))).status, 404, 'coach cannot read an unshared plan');
  const plan = await sam.ok('GET', T(`/plans/${pid}`));
  assert.equal(plan.items.length, 3, 'plan pulls in team research for its bill');
  await sam.ok('PUT', T(`/plans/${pid}`), { shared_with_leaders: true, status: 'drafting' });
  assert.equal((await coach.ok('GET', T(`/plans/${pid}`))).plan.status, 'drafting');
  assert.equal((await coach.call('PUT', T(`/plans/${pid}`), { outline: 'x' })).status, 403);
  assert.equal((await ria.ok('GET', T(`/bills/${bid}`))).my_plans.length, 0);

  // Progress: own only, leaders see everyone; coach sets goals; app speeches counted.
  await admin.ok('POST', `/api/chambers/${cid}/members`, { user_ids: [riaId] });
  await admin.ok('PUT', `/api/chambers/${cid}`, { po_user_id: riaId });
  const st = await admin.ok('GET', `/api/chambers/${cid}/state`);
  await admin.ok('POST', `/api/chambers/${cid}/legislation/${st.legislation[0].id}/begin`);
  await admin.ok('POST', `/api/chambers/${cid}/recognize`, { user_id: samId, side: 'authorship' });
  await sam.ok('POST', T('/progress'), { date: '2026-11-01', tournament: 'Fall Classic', side: 'aff', points: '5,6', result: 'Finalist' });
  await coach.ok('POST', T('/goals'), { user_id: samId, text: 'Cite two sources per speech' });
  assert.equal((await sam.call('POST', T('/goals'), { user_id: samId, text: 'x' })).status, 403);
  let pr = await sam.ok('GET', T('/progress'));
  assert.equal(pr.summary.app_speeches, 1);
  assert.equal(pr.summary.sides.authorship, 1);
  assert.equal(pr.entries[0].result, 'Finalist');
  assert.equal(pr.goals.length, 1);
  assert.equal(pr.summary.avg_score_pct, null, 'no published feedback yet');
  await sam.ok('PUT', T(`/goals/${pr.goals[0].id}`), { done: true });
  assert.equal((await sam.call('GET', T(`/progress?user=${riaId}`))).status, 403);
  pr = await coach.ok('GET', T(`/progress?user=${samId}`));
  assert.equal(pr.shared_plans.length, 1);
  const roster = await ria.ok('GET', T('/roster-progress'));
  assert.equal(roster.members.find((m) => m.id === samId).app_speeches, 1);
});
