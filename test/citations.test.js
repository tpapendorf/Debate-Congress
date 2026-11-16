'use strict';
// Citations from links, and linked Google Docs / Drive folders on team, bill and plan pages.
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

const { parseCitation, linkKind, privateAddress } = require('../server/teams');

test('linkKind recognises Google Docs, Sheets, Slides, Forms and Drive folders', () => {
  assert.equal(linkKind('https://docs.google.com/document/d/abc/edit'), 'gdoc');
  assert.equal(linkKind('https://docs.google.com/spreadsheets/d/abc/edit#gid=0'), 'gsheet');
  assert.equal(linkKind('https://docs.google.com/presentation/d/abc'), 'gslides');
  assert.equal(linkKind('https://docs.google.com/forms/d/abc/viewform'), 'gform');
  assert.equal(linkKind('https://drive.google.com/drive/folders/xyz'), 'gfolder');
  assert.equal(linkKind('https://drive.google.com/file/d/xyz/view'), 'gdrive');
  assert.equal(linkKind('https://www.nytimes.com/2024/01/01/a.html'), 'web');
  assert.equal(linkKind('not a url'), 'web');
});

test('privateAddress blocks internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '2607:f8b0:4004:800::200e']) assert.equal(privateAddress(ip), false, ip);
});

test('parseCitation reads scholarly, Open Graph and JSON-LD metadata', () => {
  const og = parseCitation(`<html><head><title>Fallback | Site</title>
    <meta property="og:title" content="Rising Seas &amp; Coastal Towns">
    <meta property="og:site_name" content="The Daily Planet">
    <meta name="author" content="Lois Lane">
    <meta property="article:published_time" content="2024-03-05T10:00:00Z">
    <link rel="canonical" href="https://planet.example/seas"></head></html>`, 'https://planet.example/seas?utm=1');
  assert.equal(og.title, 'Rising Seas & Coastal Towns');
  assert.equal(og.source, 'The Daily Planet');
  assert.equal(og.author, 'Lois Lane');
  assert.equal(og.date, '2024-03-05');

  const ld = parseCitation(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Wage Study","author":[{"@type":"Person","name":"A. Smith"},{"@type":"Person","name":"B. Jones"}],"datePublished":"2023-11-20","publisher":{"name":"Econ Weekly"}}</script>`, 'https://econ.example/w');
  assert.equal(ld.title, 'Wage Study');
  assert.match(ld.author, /A\. Smith/);
  assert.equal(ld.source, 'Econ Weekly');
  assert.equal(ld.date, '2023-11-20');

  const bare = parseCitation('<title>Just a title</title>', 'https://www.example.org/x');
  assert.equal(bare.title, 'Just a title');
  assert.ok(bare.source, 'falls back to the site name');
});

test('citations and links over HTTP: lookup safety, Google links, sharing rules', async () => {
  const admin = client();
  await admin.ok('POST', '/api/setup', { username: 'admin', display_name: 'Parli', password: 'secret1' });
  const { user: coachU } = await admin.ok('POST', '/api/users', { display_name: 'Coach Cole', role: 'judge', password: 'secret1' });
  const coach = client(); await coach.ok('POST', '/api/login', { username: coachU.username, password: 'secret1' });
  const { id: tid } = await coach.ok('POST', '/api/teams', { name: 'Lincoln' });
  const T = (p = '') => `/api/teams/${tid}${p}`;
  const code = (await coach.ok('GET', T())).team.join_code;
  const join = async (name, username) => { const c = client(); const r = await c.ok('POST', '/api/signup', { code, display_name: name, username, password: 'secret1' }); await coach.ok('POST', T(`/members/${r.user_id ?? (await c.ok('GET', '/api/me')).user.id}`), { action: 'approve' }); return c; };
  const sam = await join('Sam S', 'sam');
  const ria = await join('Ria R', 'ria');
  const samId = (await sam.ok('GET', '/api/me')).user.id;

  // Citation lookup
  assert.equal((await client().call('GET', T('/cite?url=https://example.com'))).status, 401, 'login needed');
  assert.equal((await sam.call('GET', T('/cite?url='))).status, 400);
  const local = await sam.call('GET', T(`/cite?url=${encodeURIComponent(base)}`));
  assert.equal(local.status, 400, 'never fetches internal addresses');
  assert.equal((await sam.call('GET', T(`/cite?url=${encodeURIComponent('file:///etc/passwd')}`))).status, 400);
  const g = await sam.ok('GET', T(`/cite?url=${encodeURIComponent('https://docs.google.com/document/d/abc/edit')}`));
  assert.equal(g.kind, 'gdoc');
  assert.equal(g.source, 'Google Doc');

  // Evidence with a full citation keeps its title
  const { id: bid } = await sam.ok('POST', T('/bills'), { title: 'A Bill to Raise Seawalls' });
  const { id: iid } = await sam.ok('POST', T(`/bills/${bid}/items`), { section: 'evidence', text: 'Seas rose 4 inches since 2000', cite_author: 'Lois Lane', cite_title: 'Rising Seas', cite_source: 'Daily Planet', cite_date: '2024-03-05', cite_url: 'https://planet.example/seas' });
  let bill = await ria.ok('GET', T(`/bills/${bid}`));
  assert.equal(bill.items.find((i) => i.id === iid).cite_title, 'Rising Seas');

  // Team, bill and plan links
  const { id: teamLink, kind } = await sam.ok('POST', T('/links'), { url: 'drive.google.com/drive/folders/team123' });
  assert.equal(kind, 'gfolder');
  const { id: billLink } = await ria.ok('POST', T('/links'), { url: 'https://docs.google.com/spreadsheets/d/s1', title: 'Seawall data', bill_id: bid });
  assert.equal((await sam.call('POST', T('/links'), { url: '' })).status, 400);
  let team = await ria.ok('GET', T());
  assert.deepEqual(team.links.map((l) => [l.title, l.kind, l.url]), [['Drive folder', 'gfolder', 'https://drive.google.com/drive/folders/team123']]);
  bill = await sam.ok('GET', T(`/bills/${bid}`));
  assert.deepEqual(bill.links.map((l) => l.title), ['Seawall data']);

  const { id: pid } = await sam.ok('POST', T('/plans'), { title: 'Aff speech', bill_id: bid, side: 'aff' });
  const { id: planLink } = await sam.ok('POST', T('/links'), { url: 'https://docs.google.com/document/d/draft', title: 'My draft', plan_id: pid });
  assert.equal((await ria.call('POST', T('/links'), { url: 'https://x.example', plan_id: pid })).status, 404, 'cannot add to someone else\'s plan');
  assert.equal((await sam.ok('GET', T(`/plans/${pid}`))).links.length, 1);
  team = await ria.ok('GET', T());
  assert.equal(team.links.length, 1, 'plan links stay off the team page');
  assert.equal(JSON.stringify(await ria.ok('GET', T(`/bills/${bid}`))).includes('My draft'), false, 'plan links stay off the bill page');

  // Removing: the adder or a leader, but plan links only by their owner
  assert.equal((await ria.call('DELETE', T(`/links/${teamLink}`))).status, 403);
  assert.equal((await coach.call('DELETE', T(`/links/${planLink}`))).status, 403);
  await coach.ok('DELETE', T(`/links/${teamLink}`));
  await ria.ok('DELETE', T(`/links/${billLink}`));
  await sam.ok('DELETE', T(`/links/${planLink}`));
  assert.equal((await coach.ok('GET', T())).links.length, 0);
  void samId;
});
