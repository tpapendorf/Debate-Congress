'use strict';
// Training: starter lessons, mark done, coach review, pinning, authoring permissions, AI switches and the lesson kit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { createApp } = require('../server/app');
const { parseLessons } = require('../server/lessonkit');
const { starterLessons } = require('../server/training');

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

test('the shipped starter lessons parse cleanly', () => {
  const list = starterLessons();
  assert.ok(list.length >= 12);
  const tracks = new Set(list.map((l) => l.track));
  for (const t of ['foundations', 'arguments', 'evidence', 'questioning', 'roles', 'delivery']) assert.ok(tracks.has(t), `no lesson in ${t}`);
  for (const l of list) {
    assert.deepEqual(l.flags, [], l.title);
    assert.ok(l.summary && l.body && l.good && l.weak && l.drill, `${l.title} is missing a part`);
    assert.ok(l.body.length < 4000);
  }
  assert.equal(new Set(list.map((l) => l.title.toLowerCase())).size, list.length, 'duplicate titles');
});

test('lesson parser: several lessons, fences, loose keys', () => {
  const out = parseLessons('Sure! Here you go:\n```markdown\n# Training lesson: Weighing impacts\n- **Track:** Speech roles\n- Skill: Compare impacts.\n- Drill: practice\n- Bill section: neg\n\n## Lesson\nWeigh by **magnitude**.\n\n## Strong example\nGood.\n## Weak example\nBad.\n## Try it\nDo it.\n\n# Lesson 2: No track here\n## Lesson\nText.\n```\nHope that helps');
  assert.equal(out.lessons.length, 2);
  const [a, b] = out.lessons;
  assert.equal(a.title, 'Weighing impacts');
  assert.equal(a.track, 'roles');
  assert.equal(a.drill_to, 'practice');
  assert.equal(a.bill_section, 'neg');
  assert.equal(a.body, 'Weigh by **magnitude**.');
  assert.equal(a.weak, 'Bad.');
  assert.equal(b.title, 'No track here');
  assert.deepEqual(b.flags, ['no_track']);
  assert.ok(parseLessons('nothing').warnings.length);
});

test('training: starter lessons, done, review, pin, authoring, AI switches, kit upload', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { user: cu } = await admin.ok('POST', '/api/users', { display_name: 'Coach Cole', role: 'judge', password: 'secret1' });
  const coach = client(); await coach.ok('POST', '/api/login', { username: cu.username, password: 'secret1' });
  const { id: tid } = await coach.ok('POST', '/api/teams', { name: 'Lincoln', school: 'Lincoln HS' });
  const T = (p = '') => `/api/teams/${tid}${p}`;
  const code = (await coach.ok('GET', T())).team.join_code;
  const sam = client(); await sam.ok('POST', '/api/signup', { code, display_name: 'Sam', username: 'sam', password: 'secret1' });
  const ria = client(); await ria.ok('POST', '/api/signup', { code, display_name: 'Ria', username: 'ria', password: 'secret1' });
  const members = (await coach.ok('GET', T())).members;
  const sid = members.find((m) => m.name === 'Sam').id, rid = members.find((m) => m.name === 'Ria').id;
  assert.equal((await sam.call('GET', T('/lessons'))).status, 403); // not approved yet
  await coach.ok('POST', T(`/members/${sid}`), { action: 'approve' });
  await coach.ok('POST', T(`/members/${rid}`), { action: 'approve' });
  await coach.ok('POST', T(`/members/${rid}`), { action: 'role', role: 'captain' });

  // Starter lessons arrive once, tagged as AI Learning Aids.
  let list = await sam.ok('GET', T('/lessons'));
  const n = starterLessons().length;
  assert.equal(list.lessons.length, n);
  assert.ok(list.lessons.every((l) => l.ai && l.source === 'starter' && !l.done));
  assert.equal(list.members, undefined); // members don't see team counts
  assert.equal((await coach.ok('GET', T('/lessons'))).lessons.length, n); // not seeded twice
  const first = list.lessons[0];

  // Mark done; the coach sees who finished it.
  await sam.ok('POST', T(`/lessons/${first.id}/done`), { done: true });
  await sam.ok('POST', T(`/lessons/${first.id}/done`), { done: true });
  assert.equal((await sam.ok('GET', T(`/lessons/${first.id}`))).done, true);
  assert.equal((await sam.ok('GET', T(`/lessons/${first.id}`))).roster, undefined);
  const cv = await coach.ok('GET', T(`/lessons/${first.id}`));
  assert.equal(cv.roster.find((r) => r.id === sid).done_at > 0, true);
  const cl = await coach.ok('GET', T('/lessons'));
  assert.equal(cl.members, 3);
  assert.equal(cl.lessons.find((l) => l.id === first.id).done_count, 1);
  await sam.ok('POST', T(`/lessons/${first.id}/done`), { done: false });
  assert.equal((await sam.ok('GET', T(`/lessons/${first.id}`))).done, false);

  // Members can't write, review or pin. Captains can write and pin but not review.
  assert.equal((await sam.call('POST', T('/lessons'), { track: 'evidence', title: 'X', body: 'Y' })).status, 403);
  assert.equal((await sam.call('POST', T(`/lessons/${first.id}/pin`), {})).status, 403);
  assert.equal((await ria.call('POST', T(`/lessons/${first.id}/review`), {})).status, 403);
  assert.equal((await ria.call('POST', T('/lessons'), { track: 'nope', title: 'X', body: 'Y' })).status, 400);
  const { id: own } = await ria.ok('POST', T('/lessons'), { track: 'questioning', title: 'Captain drill: rapid lines', summary: 'Fast lines', body: 'Ask three.', drill_to: 'bills', bill_section: 'question' });
  let mine = (await sam.ok('GET', T(`/lessons/${own}`))).lesson;
  assert.equal(mine.ai, false);
  assert.equal(mine.bill_section, 'question');
  await ria.ok('PUT', T(`/lessons/${own}`), { title: 'Rapid question lines', track: 'evidence' });
  mine = (await sam.ok('GET', T(`/lessons/${own}`))).lesson;
  assert.equal(mine.title, 'Rapid question lines');
  assert.equal(mine.track, 'evidence');
  assert.equal(mine.body, 'Ask three.');

  // Pinning keeps one focus; review records the coach.
  await ria.ok('POST', T(`/lessons/${first.id}/pin`), {});
  await ria.ok('POST', T(`/lessons/${own}/pin`), {});
  list = await sam.ok('GET', T('/lessons'));
  assert.deepEqual(list.lessons.filter((l) => l.pinned).map((l) => l.id), [own]);
  await coach.ok('POST', T(`/lessons/${first.id}/review`), {});
  const rv = (await sam.ok('GET', T(`/lessons/${first.id}`))).lesson;
  assert.equal(rv.reviewed, true);
  assert.equal(rv.reviewed_by_name, 'Coach Cole');

  // Hiding AI hides AI lessons, but not the captain's own.
  await sam.ok('PUT', '/api/me/ai', { hide: true });
  list = await sam.ok('GET', T('/lessons'));
  assert.deepEqual(list.lessons.map((l) => l.id), [own]);
  assert.equal(list.hidden_ai, n);
  assert.equal((await sam.call('GET', T(`/lessons/${first.id}`))).status, 404);
  await sam.ok('PUT', '/api/me/ai', { hide: false });

  // AI lesson kit: read a reply, flag duplicates, import as AI.
  const reply = '# Training lesson: Rapid question lines\n- Track: questioning\n## Lesson\nDup.\n\n# Training lesson: Weighing impacts\n- Track: roles\n- Skill: Compare.\n## Lesson\nWeigh.\n## Try it\nGo.';
  assert.equal((await sam.call('POST', T('/lessons/ai/read'), { text: reply })).status, 403);
  const read = await ria.ok('POST', T('/lessons/ai/read'), { text: reply });
  assert.deepEqual(read.lessons.map((l) => l.flags), [['duplicate'], []]);
  const imp = await ria.ok('POST', T('/lessons/ai/import'), { lessons: [read.lessons[1], { title: 'bad' }] });
  assert.equal(imp.added, 1);
  const w = (await sam.ok('GET', T('/lessons'))).lessons.find((l) => l.title === 'Weighing impacts');
  assert.equal(w.ai, true);
  assert.equal(w.source, '');

  // Deleting a starter lesson keeps it deleted.
  await coach.ok('DELETE', T(`/lessons/${first.id}`));
  assert.equal((await sam.ok('GET', T('/lessons'))).lessons.some((l) => l.id === first.id), false);
  assert.equal((await sam.ok('GET', T('/lessons'))).lessons.length, n + 1);

  // With AI off for the team, the kit is refused and AI lessons are hidden for everyone.
  await coach.ok('PUT', T(''), { name: 'Lincoln', ai_aids: false });
  assert.equal((await ria.call('POST', T('/lessons/ai/read'), { text: reply })).status, 403);
  assert.deepEqual((await coach.ok('GET', T('/lessons'))).lessons.map((l) => l.id), [own]);
});
