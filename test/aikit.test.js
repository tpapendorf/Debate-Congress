'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAiReply } = require('../server/aikit');
const { open } = require('../server/db');
const { createApp } = require('../server/app');

const REPLY = `Here is your learning aid:

\`\`\`markdown
# AI Learning Aid: A Bill to Require the Pentagon to Pass an Audit

## Summary
Cuts 10% from any Pentagon agency that fails a clean audit.

## Affirmative arguments
### **Taxpayers deserve accountability**
Warrant: The DoD has failed every audit since 2018.
Impact: Waste crowds out real needs.

## Negative arguments
1. Cuts hurt readiness
   - Troops bear the cost, not accountants
2. Audits are already improving

## Evidence
### The Pentagon failed its seventh straight audit in 2024
- Supports: aff
- Source: AP News
- Date: Nov 15, 2024
- Link: https://apnews.com/article/pentagon-audit
How to use it: open with it.
### A statistic with no source
- Supports: neg
- Link: (none found)

## Likely questions
### Why 10% and not 5%?
- For: aff
Answer: A smaller cut would not change behavior.
\`\`\`
`;

test('reads an AI reply in the kit format, even with drift', () => {
  const r = parseAiReply(REPLY);
  assert.equal(r.title, 'A Bill to Require the Pentagon to Pass an Audit');
  assert.match(r.summary, /^Cuts 10%/);
  const by = (s) => r.items.filter((i) => i.section === s);
  assert.deepEqual(by('aff').map((i) => [i.text, i.side]), [['Taxpayers deserve accountability', 'aff']]);
  assert.match(by('aff')[0].detail, /Warrant: .*\nImpact: /);
  assert.deepEqual(by('neg').map((i) => i.text), ['Cuts hurt readiness', 'Audits are already improving']);
  assert.equal(by('neg')[0].detail, 'Troops bear the cost, not accountants');
  const [ev, bad] = by('evidence');
  assert.deepEqual([ev.side, ev.cite_source, ev.cite_date, ev.cite_url, ev.flags.length], ['aff', 'AP News', 'Nov 15, 2024', 'https://apnews.com/article/pentagon-audit', 0]);
  assert.deepEqual(bad.flags, ['no_link']);
  assert.deepEqual(by('question').map((i) => [i.side, i.detail]), [['aff', 'A smaller cut would not change behavior.']]);
  assert.equal(parseAiReply('just some chat').warnings.length, 1);
});

test('AI Learning Aids are tagged, can be hidden per person, and turned off per team', async () => {
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
    const B = `/api/teams/${team.id}/bills`;
    const bill = (await coach('POST', B, { title: 'A Bill to Require the Pentagon to Pass an Audit' })).data;
    await coach('POST', `${B}/${bill.id}/items`, { section: 'neg', text: 'Audits are already improving' });
    const read = (await coach('POST', `${B}/${bill.id}/ai/read`, { text: REPLY })).data;
    assert.ok(read.items.find((i) => i.text === 'Audits are already improving').flags.includes('duplicate'));
    const wrong = (await coach('POST', `${B}/${bill.id}/ai/read`, { text: REPLY.replace('Pentagon to Pass an Audit', 'Ban TikTok') })).data;
    assert.equal(wrong.warnings.length, 1);
    // Evidence without a link is refused even if sent.
    const r = (await coach('POST', `${B}/${bill.id}/ai/import`, { summary: read.summary, items: read.items.filter((i) => !i.flags.includes('duplicate')) })).data;
    assert.equal(r.added, 4);
    const seen = async () => { const d = (await coach('GET', `${B}/${bill.id}`)).data; return { ai: d.items.filter((i) => i.ai).length, all: d.items.length, summary: d.bill.ai_summary }; };
    assert.deepEqual(await seen(), { ai: 4, all: 5, summary: read.summary });
    const neg = async () => (await coach('GET', `/api/teams/${team.id}`)).data.bills[0].neg;
    assert.equal(await neg(), 2);

    // Personal switch hides them for that person only.
    await coach('PUT', '/api/me/ai', { hide: true });
    assert.deepEqual(await seen(), { ai: 0, all: 1, summary: '' });
    assert.equal(await neg(), 1);
    assert.equal((await coach('GET', `/api/teams/${team.id}`)).data.me.showAi, false);
    await coach('PUT', '/api/me/ai', { hide: false });

    // Team switch hides them for everyone and stops uploads; nothing is deleted.
    await coach('PUT', `/api/teams/${team.id}`, { ai_aids: false });
    assert.deepEqual(await seen(), { ai: 0, all: 1, summary: '' });
    assert.equal((await coach('POST', `${B}/${bill.id}/ai/read`, { text: REPLY })).status, 403);
    await coach('PUT', `/api/teams/${team.id}`, { ai_aids: true });
    assert.equal((await seen()).ai, 4);
  } finally { app.locals.close(); server.close(); }
});
