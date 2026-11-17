'use strict';
/* Reads a tournament's Congress legislation packet (PDF or Word) and splits it into bills and resolutions.
   Packets differ from tournament to tournament, so this is a best guess that people check before importing. */
const zlib = require('node:zlib');

// ---------- getting text out of the file ----------
async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t) => `\f\n${t}`).join('\n');
}
// Minimal zip reader: enough to pull word/document.xml out of a .docx.
function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('no document');
  return xml.toString('utf8')
    .replace(/<w:br[^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\/>/g, '\n\f\n')
    .replace(/<w:tab\/>/g, ' ').replace(/<w:br[^>]*\/>/g, '\n')
    .split(/<\/w:p>/).map((p) => unxml(p.replace(/<[^>]+>/g, ''))).join('\n');
}
async function fileText(buf, name = '') {
  if (buf.subarray(0, 5).toString() === '%PDF-') return pdfText(buf);
  if (buf[0] === 0x50 && buf[1] === 0x4b) return docxText(buf);
  if (/\.(txt|md)$/i.test(name) || !buf.subarray(0, 512).includes(0)) return buf.toString('utf8');
  throw Object.assign(new Error('That file is not a PDF or Word document.'), { status: 400 });
}

// ---------- splitting it into legislation ----------
const PREFIX = String.raw`(?:(?:Bill|Legislation|Item|Resolution|Docket Item|Leg\.?)\s*#?\s*[A-Z0-9]{1,3}\s*[-–—:.)]\s*)`;
const TITLE_RE = new RegExp(String.raw`^(?:${PREFIX}|[A-Z]{1,2}\s+(?=An?\s)|(?:[A-Z]|\d{1,2}|[IVX]{1,4})[.):]\s+|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?:\s*|(?:Semis?|Semifinals?|Finals?|Prelims?|Session\s+\w+)\s*:?\s+)?((?:A|An)\s+(?:Bill|Resolution|Joint Resolution|Concurrent Resolution)\b.*)$`, 'i');
const ACT_RE = new RegExp(String.raw`^(?:${PREFIX}|(?:[A-Z]|\d{1,2})[.):]\s+|(?:Semis?|Finals?)\s*:?\s*)?((?:The\s+)?[A-Z][\w'’.,()\- ]{2,90}\bAct(?:\s+of\s+\d{4})?\s*(?:\([A-Z.\- ]+\))?)\s*$`);
const BODY_RE = /^(?:BE IT (?:ENACTED|RESOLVED)|WHEREAS\b)/i;
const SESSION_RE = /^(?:Congress(?:ional)?\s+|Congressional Debate\s+)?(?:(Session|Round|Chamber)\s+([0-9]+|One|Two|Three|Four|Five|Six|[IVX]+)\b|(Prelims?|Preliminary|Semi-?finals?|Semis|Finals?|Elim\w*|Super Session|Super Congress|Supers?)\b)/i;
const AUTHOR_RE = /^(?:Introduced|Submitted|Respectfully submitted|Authored|Written|Sponsored)\b.*?\bby[.:]?\s+(.+?)\.?$/i;
const NUM_ONLY = /^\s*\d{1,3}\s*$/;
const HEADER_RE = /\b(LEGISLATION|DOCKET|PACKET|TOURNAMENT|INVITATIONAL|CLASSIC)\b.*\b(SESSION|ITEM|[A-Z]\b|\d)/;

function cleanTitle(t) {
  return t.replace(/\s*\.{3,}\s*\d*\s*$/, '').replace(/\s+(?!(?:19|20)\d{2}$)\d{4,}$/, '').replace(/^(A Resolution to )+(A Resolution to )/i, '$2')
    .replace(/^(A Bill to )+(A Bill to )/i, '$2').replace(/\s{2,}/g, ' ').replace(/[\s.]+$/, '').trim();
}
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Titles match when most of their words match (PDFs sometimes garble letter pairs like "ti" or "ft").
function same(a, b) {
  const A = norm(a), B = norm(b);
  const acr = (x, y) => { const m = x.match(/^(?:the )?([A-Z]{3,})\s+Act$/i); return m && new RegExp(`\\(${m[1]}\\)`, 'i').test(y); };
  if (acr(a, b) || acr(b, a)) return true;
  if (A === B || (Math.min(A.length, B.length) > 20 && (A.startsWith(B) || B.startsWith(A)))) return true;
  const wa = new Set(A.split(' ').filter((w) => w.length > 2)), wb = new Set(B.split(' ').filter((w) => w.length > 2));
  if (wa.size < 3 || wb.size < 3) return false;
  let hit = 0; for (const w of wa) if (wb.has(w)) hit += 1;
  return hit / Math.max(wa.size, wb.size) >= 0.7;
}
const kindOf = (t) => (/^an?\s+(joint |concurrent )?resolution/i.test(t) ? 'resolution' : 'bill');
function sessionLabel(m) {
  if (m[1]) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  const w = m[3].toLowerCase();
  if (w.startsWith('super')) return 'Super Congress';
  return w.startsWith('semi') ? 'Semifinals' : w.startsWith('final') ? 'Finals' : w.startsWith('prelim') ? 'Prelims' : m[3];
}

function parseText(text) {
  let lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
  // Line numbers glued to the end of lines ("…THAT:1") in some packets.
  const glued = lines.filter((l) => /[^\d\s]\d{1,2}$/.test(l)).length;
  if (glued > 40) lines = lines.map((l) => l.replace(/([^\d\s.])\d{1,2}$/, '$1'));
  const isPage = (l) => l === '\f';
  const meaningful = (i) => lines[i] !== '' && !NUM_ONLY.test(lines[i]);

  // 1) Full texts: every "BE IT ENACTED" or first "WHEREAS" after a title starts one.
  const full = [];
  for (let i = 0; i < lines.length; i++) {
    if (!BODY_RE.test(lines[i])) continue;
    // Walk back to the title, skipping line numbers.
    const back = [];
    let j = i - 1, sawTitle = -1, preAuthor = '';
    while (j >= 0 && back.length < 6) {
      if (isPage(lines[j])) break;
      if (meaningful(j)) {
        const au = lines[j].match(AUTHOR_RE);
        if (au && !back.length) { preAuthor = au[1].trim(); j--; continue; }
        if (au) break;
        if (BODY_RE.test(lines[j]) || /(;|; and|,)$/.test(lines[j]) || /^(SECTION|SEC\.)\s*\d/i.test(lines[j])) { back.length = 0; sawTitle = -2; break; }
        back.unshift(j);
        if (TITLE_RE.test(lines[j]) || ACT_RE.test(lines[j])) { sawTitle = j; break; }
      }
      j--;
    }
    if (sawTitle === -2) continue; // a later WHEREAS in the same resolution
    let titleLines = sawTitle >= 0 ? back.slice(back.indexOf(sawTitle)) : back.filter((k) => !HEADER_RE.test(lines[k]) && !SESSION_RE.test(lines[k]));
    if (!titleLines.length) continue;
    const m = lines[titleLines[0]].match(TITLE_RE) || lines[titleLines[0]].match(ACT_RE);
    const first = m ? m[1] : lines[titleLines[0]];
    const title = cleanTitle([first, ...titleLines.slice(1).map((k) => lines[k])].join(' '));
    if (title.length < 6 || title.length > 300) continue;
    full.push({ start: titleLines[0], bodyStart: i, title, preAuthor });
  }
  // Each body runs until the next title starts.
  full.forEach((f, n) => {
    const end = n + 1 < full.length ? full[n + 1].start : lines.length;
    const body = [];
    let author = '';
    for (let k = f.bodyStart; k < end; k++) {
      if (!meaningful(k) || isPage(lines[k])) continue;
      const a = lines[k].match(AUTHOR_RE);
      if (a) { author = a[1].trim(); body.push(lines[k]); break; }
      body.push(lines[k]);
    }
    f.text = joinBody(body);
    f.author = author || f.preAuthor;
  });

  // 2) Docket lists: titles with no text of their own, grouped by session headings.
  const listed = [];
  let session = '', lastListed = -10;
  const inFull = new Set();
  full.forEach((f, n) => { const end = n + 1 < full.length ? full[n + 1].start : lines.length; for (let k = f.start; k < end; k++) inFull.add(k); });
  for (let i = 0; i < lines.length; i++) {
    if (inFull.has(i)) continue;
    const l = lines[i];
    const sm = l.match(SESSION_RE);
    if (sm && l.length < 100) session = sessionLabel(sm);
    const rest = sm ? l.slice(sm[0].length).replace(/^[\s:(\-–]+(chamber decides order\))?/i, '').trim() : l;
    const m = rest.match(TITLE_RE) || (sm || /^(Semis?|Finals?)\b/i.test(l) || i - lastListed <= 2 ? rest.match(ACT_RE) : null);
    if (!m) continue;
    let t = m[1], lastLen = l.length;
    // Wrapped titles continue on the next line only when this one ran to the edge.
    while (lastLen >= 40 && i + 1 < lines.length && !inFull.has(i + 1) && lines[i + 1] && !isPage(lines[i + 1]) && !TITLE_RE.test(lines[i + 1]) && !SESSION_RE.test(lines[i + 1])
      && !/\.{3,}/.test(t) && lines[i + 1].length < 80 && !/^[A-Z][a-z]+:/.test(lines[i + 1]) && /^[a-z(A-Z0-9]/.test(lines[i + 1]) && !/[.?!]$/.test(t) && !ACT_RE.test(lines[i + 1])) {
      t += ' ' + lines[++i]; lastLen = lines[i].length;
    }
    t = cleanTitle(t);
    if (t.length >= 8 && t.length <= 300) { listed.push({ title: t, session }); lastListed = i; }
  }

  // 3) Merge: full texts win; a docket entry adds its session; entries with no text are kept as titles.
  const out = [];
  const find = (t) => out.find((x) => same(x.title, t));
  for (const f of full) {
    const dup = find(f.title);
    if (dup) { if (!dup.text && f.text) Object.assign(dup, { text: f.text, author: f.author }); continue; }
    out.push({ title: f.title, kind: kindOf(f.title), session: '', author: f.author, text: f.text });
  }
  for (const l of listed) {
    const hit = find(l.title);
    if (hit) {
      if (!hit.session && l.session) hit.session = l.session;
      // Use the docket's spelling when the full text's title is garbled.
      if (/[a-z][0-9][a-z]/i.test(hit.title) && !/[a-z][0-9][a-z]/i.test(l.title)) hit.title = l.title;
      continue;
    }
    out.push({ title: l.title, kind: kindOf(l.title), session: l.session, author: '', text: '' });
  }
  // Packets that set some items aside for Super Congress use the rest in the preliminary sessions.
  if (out.some((x) => x.session === 'Super Congress')) out.forEach((x) => { if (!x.session) x.session = 'Prelims'; });
  // Keep docket order when the packet has one: listed entries first in their order.
  const order = new Map(listed.map((l, i) => [norm(l.title), i]));
  const pos = (x) => { const k = norm(x.title); if (order.has(k)) return order.get(k); const i = listed.findIndex((l) => same(l.title, x.title)); return i < 0 ? 1e6 : i; };
  // Items the docket list missed stay right after the item before them.
  let prev = -1;
  const keyed = out.map((x, i) => { let p = pos(x); if (p === 1e6) p = prev + 0.001 * (i + 1); else prev = p; return { x, p, i }; });
  return keyed.sort((a, b) => (a.p - b.p) || (a.i - b.i)).map((k) => k.x);
}
function joinBody(lines) {
  // Re-flow wrapped lines into paragraphs; keep sections, WHEREAS clauses and lettered items on their own lines.
  const starts = /^(BE IT|WHEREAS|RESOLVED|SECTION|SEC\.|Introduced|Submitted|Respectfully|Authored|[A-Z]\.\s|\d+\.\s|[ivx]+\.\s|[•\-–])/i;
  const out = [];
  for (const l of lines) {
    if (!out.length || starts.test(l)) out.push(l);
    else out[out.length - 1] += (out[out.length - 1].endsWith('-') ? '' : ' ') + l;
  }
  return out.join('\n').slice(0, 20000);
}

async function parsePacket(buf, name) {
  const text = await fileText(buf, name);
  return parseText(text);
}

module.exports = { parsePacket, parseText, fileText, unzipEntry };

// ---------- reading a packet from a link ----------
const net = require('node:net');
const dns = require('node:dns').promises;
const MAX_FILE = 25 * 1024 * 1024;
async function fetchLink(rawUrl, privateAddress, hops = 0) {
  let u;
  try { u = new URL(rawUrl); } catch { throw Object.assign(new Error('That does not look like a web address.'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port))) throw Object.assign(new Error('Only ordinary web links can be read.'), { status: 400 });
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error('Could not find that website.'), { status: 400 });
  if (addrs.some((a) => privateAddress(a.address))) throw Object.assign(new Error('That address is not on the public internet.'), { status: 400 });
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'CongressChamber-PacketReader/1.0' } });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (hops >= 5) throw Object.assign(new Error('Too many redirects.'), { status: 400 });
    return fetchLink(new URL(res.headers.get('location'), u).href, privateAddress, hops + 1);
  }
  if (!res.ok) throw Object.assign(new Error(`That site answered with an error (${res.status}).`), { status: 400 });
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    if (size > MAX_FILE) { reader.cancel().catch(() => {}); throw Object.assign(new Error('That file is too large (over 25 MB).'), { status: 400 }); }
  }
  return { url: u.href, type: res.headers.get('content-type') || '', buf: Buffer.concat(chunks) };
}
// Google Docs and Drive share links point at a viewer page; ask for the file itself.
function directLink(url) {
  let m = url.match(/^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (m) return `https://docs.google.com/document/d/${m[1]}/export?format=docx`;
  m = url.match(/^https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}
const FILE_RE = /\.(pdf|docx)(\?|$)/i;
function fileLinks(html, base) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch { continue; }
    if (!FILE_RE.test(new URL(href).pathname) && !/tabroom-files/.test(href)) continue;
    const label = unxml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || decodeURIComponent(href.split('/').pop().split('?')[0]);
    if (!out.has(href)) out.set(href, { url: href, name: label.slice(0, 160) });
  }
  return [...out.values()];
}
const LIKELY = /docket|legislation|packet|bill|congress|leg\b/i;
// A tournament page on Tabroom: look for posted files there and on its postings pages.
async function tabroomFiles(url, privateAddress) {
  const id = (url.match(/tourn_id=(\d+)/) || [])[1];
  const pages = [url];
  if (id) pages.push(`https://www.tabroom.com/index/tourn/postings/index.mhtml?tourn_id=${id}`, `https://www.tabroom.com/index/tourn/index.mhtml?tourn_id=${id}`);
  const files = new Map(), more = new Set();
  for (const p of [...new Set(pages)]) {
    try {
      const r = await fetchLink(p, privateAddress);
      const html = r.buf.toString('utf8');
      for (const f of fileLinks(html, r.url)) files.set(f.url, f);
      // Posting pages linked from the tournament page.
      for (const m of html.matchAll(/href\s*=\s*["']([^"']*(?:postings|legislation|bills)[^"']*)["']/gi)) {
        try { const h = new URL(m[1].replace(/&amp;/g, '&'), r.url); if (/(^|\.)tabroom\.com$/.test(h.hostname)) more.add(h.href); } catch { /* skip */ }
      }
    } catch { /* try the next page */ }
  }
  for (const p of [...more].slice(0, 8)) {
    try { const r = await fetchLink(p, privateAddress); for (const f of fileLinks(r.buf.toString('utf8'), r.url)) files.set(f.url, f); } catch { /* skip */ }
  }
  return [...files.values()].sort((a, b) => Number(LIKELY.test(b.name + b.url)) - Number(LIKELY.test(a.name + a.url)));
}
async function readLink(rawUrl, privateAddress) {
  const url = directLink(/^https?:\/\//i.test(rawUrl) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  const r = await fetchLink(url, privateAddress);
  const isFile = r.buf.subarray(0, 5).toString() === '%PDF-' || (r.buf[0] === 0x50 && r.buf[1] === 0x4b);
  if (isFile) return { items: await parsePacket(r.buf, r.url), source: url };
  if (/html/i.test(r.type)) {
    const host = new URL(r.url).hostname;
    const files = /(^|\.)tabroom\.com$/.test(host) ? await tabroomFiles(r.url, privateAddress) : fileLinks(r.buf.toString('utf8'), r.url);
    if (!files.length) throw Object.assign(new Error(/tabroom/.test(host) ? 'No packet files were found on that Tabroom page. Open the tournament\'s Congress legislation on Tabroom, download the packet, and upload it here.' : 'That page has no PDF or Word files on it. Paste the link to the packet file itself, or upload it.'), { status: 400 });
    if (files.length === 1) { const one = await readLink(files[0].url, privateAddress); return { ...one, source: files[0].url }; }
    return { files };
  }
  throw Object.assign(new Error('That link is not a PDF or Word file.'), { status: 400 });
}

module.exports.readLink = readLink;
module.exports.fileLinks = fileLinks;
