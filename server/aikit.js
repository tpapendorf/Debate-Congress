'use strict';
// Reads the reply a student's AI assistant wrote from the prep kit (see public/teams.js aiKit()).
// The format is plain Markdown: "## Section" headings, one "### Item" heading per entry, and
// "- Key: value" lines for sources. We accept small variations, since every AI drifts a little.

const SECTIONS = [
  ['summary', /summary|overview|what (it|the bill|the resolution) does/i],
  ['question', /question|cross|cx\b/i],
  ['evidence', /evidence|facts?\b|statistic|sources?\b|research/i],
  ['aff', /affirm|\baff\b|\bpro\b|for the bill|in favor|support/i],
  ['neg', /negat|\bneg\b|\bcon\b|against|oppos/i],
];
const MAX_ITEMS = 80;
const clean = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/^\s*(?:\d+[.)]|[-*•]|Q\d*[:.]|Claim[:.]|Question[:.])\s*/i, '').replace(/\s+/g, ' ').trim();
const SIDE = (v) => (/\baff|pro|for\b|support/i.test(v) ? 'aff' : /\bneg|con\b|against|oppos/i.test(v) ? 'neg' : 'both');
const isUrl = (u) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u);

function sectionOf(heading) {
  for (const [k, re] of SECTIONS) if (re.test(heading)) return k;
  return null;
}

function parseAiReply(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n');
  // A reply pasted with its code fence around it.
  // A reply wrapped in a code fence, often with a sentence of chat before or after it.
  const fenced = text.match(/```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```/i);
  if (fenced && /^##\s/m.test(fenced[1])) text = fenced[1];
  text = text.replace(/^\s*```.*$/gm, '');
  const out = { title: '', summary: '', items: [], warnings: [] };
  let section = null, cur = null, summary = [];
  const finish = () => {
    if (!cur) return;
    const it = cur; cur = null;
    it.text = clean(it.text).slice(0, 500);
    it.detail = it.detail.map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 3000);
    if (!it.text) return;
    if (it.section === 'evidence') {
      it.cite_url = isUrl(it.cite_url) ? it.cite_url : '';
      if (!it.cite_url) it.flags.push('no_link');
    }
    out.items.push(it);
  };
  const start = (t) => { finish(); cur = { section, side: section === 'aff' || section === 'neg' ? section : 'both', text: t, detail: [], cite_source: '', cite_author: '', cite_title: '', cite_date: '', cite_url: '', flags: [] }; };
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h && h[1].length === 1) { finish(); out.title = out.title || clean(h[2]).replace(/^AI Learning Aid:\s*/i, ''); section = null; continue; }
    if (h && h[1].length === 2) { finish(); section = sectionOf(h[2]); continue; }
    if (!section) continue;
    if (section === 'summary') { if (!h) summary.push(line); continue; }
    if (h) { start(h[2]); continue; }
    // Items written as a top-level bullet list instead of ### headings.
    const bullet = line.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/);
    const kv = (bullet ? bullet[1] : line).match(/^\s*\**\s*(supports?|side|for|asked of|source|publication|website|author|title|date|published|link|url|answer|suggested answer|warrant|impact|how to use(?: it)?)\s*\**\s*:\s*\**\s*(.*)$/i);
    if (kv && cur) {
      const key = kv[1].toLowerCase(), val = clean(kv[2]).replace(/^<|>$/g, '');
      if (/^(supports?|side|for|asked of)$/.test(key)) cur.side = SIDE(val);
      else if (/^(source|publication|website)$/.test(key)) cur.cite_source = val.slice(0, 200);
      else if (key === 'author') cur.cite_author = val.slice(0, 200);
      else if (key === 'title') cur.cite_title = val.slice(0, 300);
      else if (/^(date|published)$/.test(key)) cur.cite_date = val.slice(0, 60);
      else if (/^(link|url)$/.test(key)) cur.cite_url = (val.match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
      else cur.detail.push(/answer/.test(key) ? val : `${kv[1][0].toUpperCase()}${kv[1].slice(1).toLowerCase()}: ${val}`);
      continue;
    }
    if (bullet && !/^\s/.test(line) && (!cur || cur.fromBullet)) { start(bullet[1]); cur.fromBullet = true; continue; }
    if (cur) cur.detail.push(line.replace(/^\s*[-*•]\s+/, ''));
  }
  finish();
  out.summary = summary.join('\n').replace(/\*\*/g, '').trim().slice(0, 2000);
  if (/^(two or three plain|one or two)/i.test(out.summary)) out.summary = '';
  // Drop untouched template lines copied back as-is.
  out.items = out.items.filter((i) => !/^(one-sentence claim|the fact, statistic|a question a cross-examiner)/i.test(i.text)).slice(0, MAX_ITEMS);
  for (const i of out.items) delete i.fromBullet;
  if (!out.items.length && !out.summary) out.warnings.push('No arguments, evidence or questions were found. Check that the reply uses the ## headings from the kit.');
  return out;
}

module.exports = { parseAiReply };
