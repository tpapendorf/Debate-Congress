'use strict';
// Reading tournament legislation packets and importing the bills.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText } = require('../server/packet');
const { zip } = require('../server/backup');
const { open } = require('../server/db');
const { createApp } = require('../server/app');

const PACKET = `2026 Spring Invitational Congress Docket
Session 1
A. A Bill to Ban Plastic Straws
B. A Resolution to Recognize the Importance
of Rural Broadband in the United States
C. The Clean Water Act of 2026
Finals
A Bill to Fund High-Speed Rail
\f
SPRING INVITATIONAL 2026 SESSION 1 - LEGISLATION A
A Bill to Ban Plastic Straws
1
2
BE IT ENACTED BY THE CONGRESS HERE ASSEMBLED THAT:
SECTION 1. Plastic straws are banned in all federal
buildings.
SECTION 2. This takes effect in FY 2027.
Introduced for Congressional Debate by Pat Lee, Central High School.
\f
A Resolution to Recognize the Importance of Rural
Broadband in the United States
WHEREAS, Many rural homes lack fast internet; and
WHEREAS, Students need internet to do homework; now,
therefore, be it
RESOLVED, That the Congress here assembled recognizes rural broadband.
Introduced for Congressional Debate by North High School.
\f
The Clean Water Act of 2026
Submitted by West Academy
BE IT ENACTED BY THE CONGRESS HERE ASSEMBLED THAT:
SECTION 1. Lead pipes shall be replaced by 2035.`;

test('splits a packet into bills with titles, sessions, authors and text', () => {
  const items = parseText(PACKET);
  assert.deepEqual(items.map((x) => x.title), [
    'A Bill to Ban Plastic Straws',
    'A Resolution to Recognize the Importance of Rural Broadband in the United States',
    'The Clean Water Act of 2026',
    'A Bill to Fund High-Speed Rail',
  ]);
  assert.deepEqual(items.map((x) => x.session), ['Session 1', 'Session 1', 'Session 1', 'Finals']);
  assert.deepEqual(items.map((x) => x.kind), ['bill', 'resolution', 'bill', 'bill']);
  assert.equal(items[0].author, 'Pat Lee, Central High School');
  assert.equal(items[2].author, 'West Academy');
  assert.match(items[0].text, /^BE IT ENACTED/);
  assert.match(items[0].text, /SECTION 1\. Plastic straws are banned in all federal buildings\./, 'wrapped lines are re-joined');
  assert.equal((items[1].text.match(/WHEREAS/g) || []).length, 2, 'a resolution stays one item');
  assert.equal(items[3].text, '', 'listed without text');
});

test('uploading a Word packet, then importing into team research and a chamber docket', async () => {
  const app = createApp(open(':memory:'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, raw) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  try {
    await call('POST', '/api/setup', { username: 'admin', display_name: 'Coach', password: 'secret1' });
    const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${PACKET.split('\n').map((l) => (l === '\f' ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : para(l))).join('')}</w:body></w:document>`;
    const docx = zip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from(xml) }]);
    const r = await call('POST', '/api/packet/read?name=Spring%20Invitational%20Docket.docx', null, docx);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items.length, 4);
    assert.equal(r.data.items[0].title, 'A Bill to Ban Plastic Straws');

    const bad = await call('POST', '/api/packet/read?name=x.pdf', null, Buffer.from('hello there, not a packet'));
    assert.equal(bad.status, 400);

    const team = (await call('POST', '/api/teams', { name: 'Solo' })).data;
    const imp = await call('POST', `/api/teams/${team.id}/bills/packet`, { items: r.data.items.slice(0, 2), tournament: 'Spring Invitational' });
    assert.equal(imp.data.added, 2);
    const again = await call('POST', `/api/teams/${team.id}/bills/packet`, { items: r.data.items.slice(0, 2) });
    assert.equal(again.data.added, 0, 'no duplicates');
    const bills = (await call('GET', `/api/teams/${team.id}`)).data.bills;
    const straws = bills.find((b) => b.title === 'A Bill to Ban Plastic Straws');
    assert.equal(straws.source, 'Spring Invitational · Session 1 · Pat Lee, Central High School');
    assert.match((await call('GET', `/api/teams/${team.id}/bills/${straws.id}`)).data.bill.body, /Plastic straws are banned/);

    const ch = (await call('POST', '/api/chambers', { name: 'Room' })).data;
    const docket = await call('POST', `/api/chambers/${ch.id}/legislation/packet`, { items: r.data.items });
    assert.equal(docket.data.added, 4);
    const leg = (await call('GET', `/api/chambers/${ch.id}/state`)).data.legislation;
    assert.deepEqual(leg.map((l) => l.docket_order), [1, 2, 3, 4]);
    assert.equal(leg[1].kind, 'resolution');
  } finally { app.locals.close(); server.close(); }
});
