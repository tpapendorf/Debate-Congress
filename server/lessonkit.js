'use strict';
// Reads training lessons written in the lesson format (the starter lessons in server/training/*.md,
// and replies from a coach's or captain's own AI assistant). One file may hold several lessons:
//
//   # Training lesson: Title
//   - Track: foundations | arguments | evidence | questioning | roles | delivery
//   - Skill: one line on what the student will be able to do
//   - Drill: bills | practice | prep | none        (where "Try it" sends them in the app)
//   - Bill section: aff | neg | evidence | question | none   (shows "Practice this skill" on bill pages)
//   ## Lesson
//   ## Strong example
//   ## Weak example
//   ## Try it

const TRACKS = ['foundations', 'arguments', 'evidence', 'questioning', 'roles', 'delivery'];
const DRILLS = ['bills', 'practice', 'prep'];
const BILL_SECTIONS = ['aff', 'neg', 'evidence', 'question'];
const LIMITS = { title: 200, summary: 300, body: 12000, good: 4000, weak: 4000, drill: 4000 };
const MAX_LESSONS = 30;

const PARTS = [
  ['good', /strong|good|better|model/i],
  ['weak', /weak|bad|avoid|common mistake/i],
  ['drill', /try it|drill|practice|exercise|your turn/i],
  ['body', /lesson|read|learn|overview|explain/i],
];
const clean = (s) => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

function pick(val, list) {
  const v = clean(val).toLowerCase();
  if (list.includes(v)) return v;
  return list.find((x) => v.startsWith(x.slice(0, 4))) || '';
}
function trackOf(val) {
  const v = clean(val).toLowerCase();
  if (/question|cross|cx/.test(v)) return 'questioning';
  if (/evidence|source|research|cit/.test(v)) return 'evidence';
  if (/argument|warrant|impact|claim|refut|rebut/.test(v)) return 'arguments';
  if (/role|author|sponsor|crystal|speech/.test(v)) return 'roles';
  if (/deliver|present|voice|presid|\bpo\b/.test(v)) return 'delivery';
  if (/found|basic|intro|begin/.test(v)) return 'foundations';
  return pick(v, TRACKS);
}

function parseLessons(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n');
  const fenced = text.match(/```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```/i);
  if (fenced && /^#\s/m.test(fenced[1])) text = fenced[1];
  text = text.replace(/^\s*```.*$/gm, '');
  const out = { lessons: [], warnings: [] };
  let cur = null, part = null;
  const finish = () => {
    if (!cur) return;
    const l = cur; cur = null;
    for (const k of ['body', 'good', 'weak', 'drill']) l[k] = l[k].join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, LIMITS[k]);
    if (!l.title || !l.body) return;
    if (/^(title of the lesson|a short title)/i.test(l.title)) return;
    if (!l.track) l.flags.push('no_track');
    out.lessons.push(l);
  };
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h && h[1].length === 1) {
      finish();
      cur = { title: clean(h[2]).replace(/^(training )?lesson\s*\d*\s*:\s*/i, '').slice(0, LIMITS.title), track: '', summary: '', drill_to: '', bill_section: '', body: [], good: [], weak: [], drill: [], flags: [] };
      part = 'meta'; continue;
    }
    if (!cur) continue;
    if (h && h[1].length === 2) { part = (PARTS.find(([, re]) => re.test(h[2])) || ['body'])[0]; continue; }
    if (part === 'meta') {
      const kv = line.match(/^\s*[-*•]?\s*\**\s*(track|skill|summary|drill|try it|bill sections?)\s*\**\s*:\s*(.*)$/i);
      if (kv) {
        const key = kv[1].toLowerCase(), val = kv[2];
        if (key === 'track') cur.track = trackOf(val);
        else if (key === 'skill' || key === 'summary') cur.summary = clean(val).slice(0, LIMITS.summary);
        else if (key === 'drill' || key === 'try it') cur.drill_to = pick(val, DRILLS);
        else cur.bill_section = pick(val.split(/[,|]/)[0], BILL_SECTIONS);
        continue;
      }
      if (line.trim()) { part = 'body'; cur.body.push(line); }
      continue;
    }
    cur[part].push(line);
  }
  finish();
  if (out.lessons.length > MAX_LESSONS) { out.warnings.push(`Only the first ${MAX_LESSONS} lessons are read.`); out.lessons = out.lessons.slice(0, MAX_LESSONS); }
  if (!out.lessons.length) out.warnings.push('No lessons were found. Check that the reply starts each lesson with "# Training lesson:" and has a "## Lesson" section.');
  return out;
}

module.exports = { parseLessons, TRACKS, DRILLS, BILL_SECTIONS, LIMITS };
