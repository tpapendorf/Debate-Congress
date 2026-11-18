'use strict';
/* Training: short skill lessons in six tracks, with a strong and a weak example and a "Try it" drill.
   Coaches and captains write lessons, pin this week's focus and see who finished what.
   Lessons written with an AI assistant carry the AI Learning Aid badge and follow the same switches.
   Uses helpers from app.js and teams.js (api, esc, toast, go, reTeam, teamCtx, T, ICON, svg, AI_ICON, aiBadge). */

const TRACK_META = {
  foundations: { name: 'Foundations', blurb: 'How a session runs and what judges reward.', icon: () => ICON.book },
  arguments: { name: 'Arguments', blurb: 'Claim, warrant, impact, and clash.', icon: () => ICON.sec_aff },
  evidence: { name: 'Evidence', blurb: 'Cite sources out loud and use them honestly.', icon: () => ICON.sec_evidence },
  questioning: { name: 'Questioning', blurb: 'Ask in lines. Answer short and direct.', icon: () => ICON.sec_question },
  roles: { name: 'Speech roles', blurb: 'Authorship, mid-round and crystallization.', icon: () => ICON.mic },
  delivery: { name: 'Delivery & presiding', blurb: 'Speaking from notes, and running the floor.', icon: () => ICON.gavel },
};
const TRACKS = Object.keys(TRACK_META);
const DRILL_LABEL = { '': 'No link', bills: 'A bill', practice: 'Practice timer', prep: 'My prep' };
const BILL_SEC_LABEL = { '': 'None', aff: 'Affirmative arguments', neg: 'Negative arguments', evidence: 'Evidence', question: 'Likely questions' };
const CHECK = '<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const reviewedPill = (name) => `<span class="pill reviewed-pill" title="${name ? `Reviewed by ${esc(name)}` : 'A coach reviewed this lesson'}">${CHECK}Coach reviewed</span>`;

// A small, safe Markdown reader for lesson text: paragraphs, - and 1. lists, ### headings, > quotes, **bold**, *italic*.
function lessonMd(src) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const out = []; let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join(' ')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), hd = line.match(/^\s*#{3,6}\s+(.*)$/), bq = line.match(/^\s*>\s?(.*)$/);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push((ul || ol)[1]); continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    if (hd) { flushPara(); out.push(`<h3>${inline(hd[1])}</h3>`); continue; }
    if (bq) { flushPara(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
    // A line that starts with a bold label ("**Claim:** ...") reads best on its own line.
    if (/^\*\*[^*]+:\*\*/.test(line.trim())) { flushPara(); out.push(`<p>${inline(line.trim())}</p>`); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('');
}

// Lessons for the team, kept for a minute so bill pages can link to them without another request each time.
let lessonCache = null;
async function loadLessons(force = false) {
  if (!force && lessonCache && lessonCache.team === teamCtx.id && Date.now() - lessonCache.at < 60000) return lessonCache.data;
  const data = await api('GET', T('/lessons'));
  lessonCache = { team: teamCtx.id, at: Date.now(), data };
  return data;
}
const dropLessonCache = () => { lessonCache = null; };

// "Practice this skill" on a bill's section card.
function skillLink(section) {
  const list = (lessonCache?.team === teamCtx.id ? lessonCache.data.lessons : []).filter((l) => l.bill_section === section);
  if (!list.length) return '';
  const l = list.find((x) => !x.done) || list[0];
  return `<a class="skill-link" href="#/team/${teamCtx.id}/lesson/${l.id}">${ICON.book}<span>Practice this skill: <b>${esc(l.title)}</b></span>${l.done ? `<span class="skill-done">${CHECK}Done</span>` : ''}</a>`;
}

function lessonRow(l, members) {
  const leader = teamCtx.data.me.isLeader;
  return `<li><a class="lesson-row${l.done ? ' done' : ''}" href="#/team/${teamCtx.id}/lesson/${l.id}">
    <span class="lr-check" aria-label="${l.done ? 'Done' : 'Not done yet'}">${l.done ? CHECK : ''}</span>
    <span class="lr-main"><b>${esc(l.title)}</b>${l.summary ? `<span class="lr-sum">${esc(l.summary)}</span>` : ''}
      <span class="lr-tags">${l.pinned ? `<span class="pill now-pill">${ICON.star}This week</span>` : ''}${l.ai ? aiBadge() : ''}${l.reviewed ? reviewedPill() : ''}${leader && members ? `<span class="lr-count" title="Teammates who finished it">${l.done_count}/${members} done</span>` : ''}</span></span>
  </a></li>`;
}

async function viewTraining() {
  const data = await loadLessons(true);
  const { lessons, members, hidden_ai } = data;
  const me2 = teamCtx.data.me, team = teamCtx.data.team, leader = me2.isLeader;
  const pinned = lessons.find((l) => l.pinned);
  const done = lessons.filter((l) => l.done).length;
  const pct = lessons.length ? Math.round((done / lessons.length) * 100) : 0;
  const tracks = TRACKS.map((k) => [k, lessons.filter((l) => l.track === k)]);
  const hiddenNote = hidden_ai
    ? (team.ai_aids
      ? `<p class="ai-hidden small muted">${AI_ICON} ${hidden_ai} lesson${hidden_ai === 1 ? ' was' : 's were'} written with an AI assistant and ${hidden_ai === 1 ? 'is' : 'are'} hidden for you. <button class="linkish" data-tact="ai-hide" data-hide="0">Show them</button></p>`
      : `<p class="ai-hidden small muted">${AI_ICON} ${hidden_ai} lesson${hidden_ai === 1 ? '' : 's'} written with an AI assistant ${hidden_ai === 1 ? 'is' : 'are'} hidden because AI Learning Aids are off for this team.${me2.isCoach ? ' Turn them on under Members → Team settings.' : ''}</p>`)
    : '';
  return `
    <section class="tr-head">
      <div class="tr-intro"><h2>Training</h2>
        <p class="small muted">Short lessons on the skills judges reward. Each one has a strong example next to a weak one and a drill to try in the app.</p></div>
      ${lessons.length ? `<div class="tr-meter" title="${done} of ${lessons.length} lessons done"><div class="tr-meter-top"><b>${done}</b><span>of ${lessons.length} done</span></div><div class="tr-bar"><i style="width:${pct}%"></i></div></div>` : ''}
    </section>
    ${pinned ? `<a class="focus-card" href="#/team/${teamCtx.id}/lesson/${pinned.id}">
        <span class="focus-kicker">${ICON.star}This week's focus · ${esc(TRACK_META[pinned.track]?.name || '')}</span>
        <span class="focus-title">${esc(pinned.title)}</span>
        ${pinned.summary ? `<span class="focus-sum">${esc(pinned.summary)}</span>` : ''}
        <span class="focus-go">${pinned.done ? `${CHECK}You finished this one` : 'Start the lesson →'}</span></a>` : ''}
    ${leader ? `<div class="row tr-tools">
        <button class="sm primary" data-lact="new-open">+ New lesson</button>
        ${team.ai_aids ? `<button class="sm" data-lact="kit-open">${AI_ICON}Add lessons with AI</button>` : ''}
        ${!pinned && lessons.length ? '<span class="small muted">Open a lesson to pin it as this week\'s focus.</span>' : ''}</div>
      <div class="tr-panel" data-lpanel="new" hidden><div class="card"><h2>New lesson</h2>${lessonForm({})}</div></div>
      ${team.ai_aids ? `<div class="tr-panel" data-lpanel="kit" ${lessonAi ? '' : 'hidden'}>${lessonKitPanel()}</div>` : ''}` : ''}
    ${hiddenNote}
    <div class="track-grid">${tracks.map(([k, list]) => {
      const m = TRACK_META[k], d = list.filter((l) => l.done).length;
      return `<section class="track track-${k}" id="track-${k}">
        <header class="track-head"><span class="track-icon">${m.icon()}</span><div><h3>${m.name}</h3><p class="small muted">${m.blurb}</p></div>
          ${list.length ? `<span class="track-count${d === list.length ? ' all' : ''}">${d}/${list.length}</span>` : ''}</header>
        ${list.length ? `<ul class="lesson-list">${list.map((l) => lessonRow(l, members)).join('')}</ul>` : `<p class="small muted track-empty">No lessons here yet.${leader ? ' Add one with + New lesson.' : ''}</p>`}
      </section>`;
    }).join('')}</div>`;
}

function lessonForm(l) {
  const sel = (name, opts, cur) => `<select name="${name}">${Object.entries(opts).map(([v, t]) => `<option value="${v}" ${v === (cur || '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<form class="stack lesson-form" data-lform="${l.id ? 'edit' : 'new'}" ${l.id ? `data-id="${l.id}"` : ''}>
    <div class="inline-fields">
      <div class="field"><label>Track</label>${sel('track', Object.fromEntries(TRACKS.map((k) => [k, TRACK_META[k].name])), l.track || 'foundations')}</div>
      <div class="field" style="grid-column:span 2"><label>Title</label><input name="title" required maxlength="200" value="${esc(l.title || '')}" placeholder="e.g. Ask questions in lines"></div>
    </div>
    <div class="field"><label>The skill, in one line</label><input name="summary" maxlength="300" value="${esc(l.summary || '')}" placeholder="What a student can do after this lesson"></div>
    <div class="field"><label>Lesson</label><textarea name="body" rows="9" required placeholder="The short read. Keep it to a few paragraphs.">${esc(l.body || '')}</textarea>
      <p class="small muted" style="margin:4px 0 0">Leave a blank line between paragraphs. Start a line with - for a bullet, and wrap words in **two stars** for bold.</p></div>
    <div class="grid two">
      <div class="field"><label>Strong example</label><textarea name="good" rows="5" placeholder="What it sounds like done well">${esc(l.good || '')}</textarea></div>
      <div class="field"><label>Weak example</label><textarea name="weak" rows="5" placeholder="The common mistake">${esc(l.weak || '')}</textarea></div>
    </div>
    <div class="field"><label>Try it</label><textarea name="drill" rows="3" placeholder="A short drill students can do now">${esc(l.drill || '')}</textarea></div>
    <div class="inline-fields">
      <div class="field"><label>"Try it" opens</label>${sel('drill_to', DRILL_LABEL, l.drill_to)}</div>
      <div class="field"><label>Show on bill pages under</label>${sel('bill_section', BILL_SEC_LABEL, l.bill_section)}</div>
    </div>
    <div class="row"><button class="sm primary">${l.id ? 'Save' : 'Add lesson'}</button><button type="button" class="sm ghost" data-lact="${l.id ? 'edit-toggle' : 'new-open'}">Cancel</button></div>
  </form>`;
}

function drillButton(l) {
  const tid = teamCtx.id, bills = teamCtx.data.bills || [];
  if (l.drill_to === 'bills') {
    const cur = bills.find((b) => b.status === 'current');
    return cur ? `<a class="btn primary" href="#/team/${tid}/bill/${cur.id}">${ICON.bill}Open ${esc(cur.title.length > 60 ? `${cur.title.slice(0, 57)}…` : cur.title)}</a>`
      : `<a class="btn primary" href="#/team/${tid}/research">${ICON.bill}Open your bills</a>`;
  }
  if (l.drill_to === 'practice') return `<a class="btn primary" href="#/team/${tid}/prep">${ICON.mic}Pick a speech to practice</a>`;
  if (l.drill_to === 'prep') return `<a class="btn primary" href="#/team/${tid}/prep">${ICON.pencil}Open My prep</a>`;
  return '';
}

async function viewLesson(lid) {
  const [{ lesson: l, done, roster }, list] = await Promise.all([api('GET', T(`/lessons/${lid}`)), loadLessons().catch(() => null)]);
  const me2 = teamCtx.data.me, leader = me2.isLeader, m = TRACK_META[l.track] || { name: l.track, icon: () => ICON.book };
  const inTrack = (list?.lessons || []).filter((x) => x.track === l.track);
  const at = inTrack.findIndex((x) => x.id === l.id);
  const next = at >= 0 ? inTrack[at + 1] : null, prev = at > 0 ? inTrack[at - 1] : null;
  const finished = (roster || []).filter((r) => r.done_at);
  return `
    <nav class="crumbs"><a href="#/team/${teamCtx.id}/training">← Training</a><span>${esc(m.name)}</span>${at >= 0 ? `<span>Lesson ${at + 1} of ${inTrack.length}</span>` : ''}</nav>
    <article class="lesson">
      <header class="lesson-hero track-${l.track}">
        <div class="bh-top">
          <div class="lesson-kicker"><span class="track-icon sm">${m.icon()}</span>${esc(m.name)}${l.pinned ? `<span class="pill now-pill">${ICON.star}This week's focus</span>` : ''}</div>
          ${leader ? `<details class="bc-menu"><summary aria-label="More for this lesson">⋯</summary><div class="bc-pop">
            <button data-lact="edit-toggle">Edit lesson</button>
            <button data-lact="pin" data-id="${l.id}" data-on="${l.pinned ? 0 : 1}">${l.pinned ? 'Unpin from this week' : 'Pin as this week\'s focus'}</button>
            ${me2.isCoach ? `<button data-lact="review" data-id="${l.id}" data-on="${l.reviewed ? 0 : 1}">${l.reviewed ? 'Remove "Coach reviewed"' : 'Mark "Coach reviewed"'}</button>` : ''}
            <button class="danger" data-lact="delete" data-id="${l.id}">Delete lesson</button></div></details>` : ''}
        </div>
        <h2 class="lesson-title">${esc(l.title)}</h2>
        ${l.summary ? `<p class="lesson-sum">${esc(l.summary)}</p>` : ''}
        ${l.ai || l.reviewed ? `<div class="row lesson-tags">${l.ai ? aiBadge() : ''}${l.reviewed ? reviewedPill(l.reviewed_by_name) : ''}
          ${l.ai && !l.reviewed ? '<span class="small muted">Written with an AI assistant. Check anything you plan to rely on.</span>' : ''}</div>` : ''}
      </header>
      ${leader ? `<div class="card lesson-edit" hidden><h2>Edit lesson</h2>${lessonForm(l)}</div>` : ''}
      <div class="lesson-body md">${lessonMd(l.body)}</div>
      ${l.good || l.weak ? `<div class="ex-pair">
        ${l.good ? `<section class="ex ex-good"><h3><span class="ex-mark">${CHECK}</span>Strong example</h3><div class="md">${lessonMd(l.good)}</div></section>` : ''}
        ${l.weak ? `<section class="ex ex-weak"><h3><span class="ex-mark">✕</span>Weak example</h3><div class="md">${lessonMd(l.weak)}</div></section>` : ''}
      </div>` : ''}
      ${l.drill ? `<section class="try-it"><h3>Try it</h3><div class="md">${lessonMd(l.drill)}</div>${drillButton(l) ? `<div class="row">${drillButton(l)}</div>` : ''}</section>` : ''}
      <div class="lesson-done${done ? ' is-done' : ''}">
        <button class="${done ? '' : 'primary'} lg" data-lact="done" data-id="${l.id}" data-on="${done ? 0 : 1}">${done ? `${CHECK}Done · Mark not done` : 'Mark this lesson done'}</button>
        ${next ? `<a class="btn" href="#/team/${teamCtx.id}/lesson/${next.id}">Next: ${esc(next.title)} →</a>` : prev ? `<a class="btn ghost" href="#/team/${teamCtx.id}/training">Back to all lessons</a>` : ''}
      </div>
      ${roster ? `<section class="card lesson-roster"><h2>Who finished it <span class="muted">${finished.length} of ${roster.length}</span></h2>
        <ul class="roster-chips">${roster.map((r) => `<li class="${r.done_at ? 'done' : ''}" title="${r.done_at ? `Done ${new Date(r.done_at).toLocaleDateString()}` : 'Not yet'}"><span class="avatar-xs">${esc(initials(r.name))}</span>${esc(r.name)}${r.done_at ? CHECK : ''}</li>`).join('')}</ul></section>` : ''}
    </article>`;
}

// ---------- AI lesson kit ----------
// As with bill aids, the app never calls an AI: a coach or captain gives the kit to their own assistant and uploads the reply.
let lessonAi = null; // { data } once a reply has been read
function lessonKit({ topic, track, count }) {
  const trackName = TRACK_META[track]?.name || 'any track';
  return `# Congress Debate training kit

## Instructions for the AI assistant

You are helping a high school Congressional Debate coach or team captain write short training lessons for their team. The team uses an app where each lesson has a short read, a strong example, a weak example and a "Try it" drill. Your reply is saved in the app as an **AI Learning Aid**, so students know an AI helped write it.

**What to teach:** ${topic || 'Pick the skills a newer competitor most needs.'}
**Track:** ${trackName}
**Number of lessons:** ${count}

Follow these rules:

1. Write for high school students who are new to or improving at Congressional Debate. Use plain words and short sentences.
2. Each lesson teaches **one skill**. Keep the lesson read to about 150 to 300 words.
3. The strong and weak examples should be things a student would actually say in a chamber, about realistic legislation, so the difference is easy to hear.
4. The "Try it" drill should take 5 to 15 minutes and use the student's own bills, speech plans or practice timer.
5. Be accurate about Congressional Debate. Rules differ between leagues (NSDA, state associations and local tournaments), so when you mention speech times, questioning periods or motions, say they vary and tell students to check their tournament's rules. Don't invent statistics, studies or quotes; examples can use made-up legislators, but any real fact must be true.
6. Reply with **only** one Markdown document in exactly this format, repeating the block for each lesson. Keep the \`#\` and \`##\` headings and the \`- Key:\` lines exactly as shown. Save it as a .md file if you can.

## Reply format

\`\`\`markdown
# Training lesson: Title of the lesson
- Track: foundations | arguments | evidence | questioning | roles | delivery
- Skill: one line on what a student can do after this lesson
- Drill: bills | practice | prep | none
- Bill section: aff | neg | evidence | question | none

## Lesson
The short read. Use a blank line between paragraphs, "- " for bullets and **bold** for key terms.

## Strong example
What it sounds like done well.

## Weak example
The common mistake, and it should be clear why it's weaker.

## Try it
A short drill the student can do now.
\`\`\`

"Drill" says where the app's "Try it" button goes: \`bills\` (a bill's research page), \`practice\` (the speech practice timer), \`prep\` (speech plans) or \`none\`. "Bill section" puts a "Practice this skill" link on that part of every bill page, or \`none\`.
`;
}
function lessonKitPanel() {
  if (lessonAi?.data) return lessonAiPreview();
  return `<section class="ai-band">
    <div class="ai-band-head"><span class="ai-mark">${AI_ICON}</span><div><h2>Add lessons with AI</h2>
      <p class="small">Say what to teach and get a kit. Give it to your AI assistant, then upload what it writes back. You review every lesson before it's added, and each one shows the AI Learning Aid badge.</p></div></div>
    <form class="stack" data-lform="kit">
      <div class="field"><label>What should the lessons teach?</label><textarea name="topic" rows="2" placeholder="e.g. Weighing impacts in a crystallization speech, for first-year competitors"></textarea></div>
      <div class="inline-fields">
        <div class="field"><label>Track</label><select name="track"><option value="">Any track</option>${TRACKS.map((k) => `<option value="${k}">${TRACK_META[k].name}</option>`).join('')}</select></div>
        <div class="field"><label>How many lessons</label><select name="count">${[1, 2, 3, 4, 5].map((n) => `<option ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div class="ai-steps">
        <div class="ai-step"><span class="ai-num">1</span><div><b>Get the kit</b><div class="row"><button class="sm" name="go" value="dl">Download .md</button><button class="sm ghost" name="go" value="copy">Copy</button></div></div></div>
        <div class="ai-step"><span class="ai-num">2</span><div><b>Ask your AI</b><div class="small muted">Attach or paste the kit into Claude, ChatGPT or another assistant.</div></div></div>
        <div class="ai-step"><span class="ai-num">3</span><div><b>Upload its reply</b><div class="small muted">Below.</div></div></div>
      </div>
    </form>
    <div class="stack" style="margin-top:12px">
      <label class="ai-file"><input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" data-lesson-file> <span>Choose the .md file</span></label>
      <textarea rows="5" data-lesson-text placeholder="…or paste the AI's whole reply here"></textarea>
      <div class="row"><button class="sm primary" data-lact="ai-read">Read reply</button><button class="sm ghost" data-lact="kit-open">Close</button></div>
    </div>
  </section>`;
}
function lessonAiPreview() {
  const p = lessonAi.data;
  const count = p.lessons.filter((l) => !l.flags.includes('no_track')).length;
  return `<section class="ai-band"><div class="ai-band-head"><span class="ai-mark">${AI_ICON}</span><div><h2>Check the lessons</h2>
      <p class="small">Untick anything you don't want. You can edit any lesson after it's added.</p></div></div>
    <div class="ai-preview">
      ${p.warnings.map((w) => `<div class="banner recess small">${esc(w)}</div>`).join('')}
      ${p.lessons.map((l, n) => {
        const noTrack = l.flags.includes('no_track'), dup = l.flags.includes('duplicate');
        return `<label class="aip-row${noTrack ? ' blocked' : ''}"><input type="checkbox" data-lap="${n}" ${!noTrack && !dup ? 'checked' : ''} ${noTrack ? 'disabled' : ''}>
          <span><b>${esc(l.title)}</b> ${l.track ? `<span class="pill">${esc(TRACK_META[l.track].name)}</span>` : ''}
          ${l.summary ? `<span class="aip-detail">${esc(l.summary)}</span>` : ''}
          <details class="aip-more"><summary class="small">Read it</summary><div class="md small">${lessonMd(l.body)}</div>
            ${l.good ? `<p class="small"><b>Strong:</b> ${esc(l.good)}</p>` : ''}${l.weak ? `<p class="small"><b>Weak:</b> ${esc(l.weak)}</p>` : ''}${l.drill ? `<p class="small"><b>Try it:</b> ${esc(l.drill)}</p>` : ''}</details>
          ${noTrack ? '<span class="aip-flag">No track given, so it can\'t be added. Ask your AI to add a "- Track:" line.</span>' : ''}${dup ? '<span class="aip-flag">A lesson with this title already exists</span>' : ''}</span></label>`;
      }).join('')}
      <div class="row aip-actions"><button class="primary" data-lact="ai-import" ${count ? '' : 'disabled'}>${AI_ICON}Add lessons</button><button class="ghost" data-lact="ai-cancel">Cancel</button></div>
    </div></section>`;
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- events ----------
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-lform]');
  if (!f) return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f).entries());
  try {
    switch (f.dataset.lform) {
      case 'new': { const r = await api('POST', T('/lessons'), d); dropLessonCache(); toast('Lesson added'); go(`#/team/${teamCtx.id}/lesson/${r.id}`); break; }
      case 'edit': await api('PUT', T(`/lessons/${f.dataset.id}`), d); dropLessonCache(); toast('Saved'); reTeam(); break;
      case 'kit': {
        const md = lessonKit({ topic: d.topic.trim(), track: d.track, count: Number(d.count) || 2 });
        if (e.submitter?.value === 'copy') { try { await navigator.clipboard.writeText(md); toast('Kit copied. Paste it into your AI assistant.'); } catch { toast('Could not copy. Use Download instead.', true); } break; }
        download('training-lesson-kit.md', md); break;
      }
    }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-lesson-file]')) return;
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 200000) { toast('That file is too big for a reply.', true); return; }
  document.querySelector('[data-lesson-text]').value = await file.text();
  document.querySelector('[data-lact=ai-read]')?.click();
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lact]');
  if (!b) return;
  const d = b.dataset;
  const panel = (k) => document.querySelector(`[data-lpanel=${k}]`);
  try {
    switch (d.lact) {
      case 'new-open': { const p = panel('new'); p.hidden = !p.hidden; if (!p.hidden) { panel('kit') && (panel('kit').hidden = true); p.querySelector('input[name=title]').focus(); } break; }
      case 'kit-open': { const p = panel('kit'); p.hidden = !p.hidden; if (p.hidden) lessonAi = null; else { panel('new').hidden = true; p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } break; }
      case 'edit-toggle': { const c = document.querySelector('.lesson-edit'); c.hidden = !c.hidden; if (!c.hidden) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
      case 'done': {
        await api('POST', T(`/lessons/${d.id}/done`), { done: d.on === '1' }); dropLessonCache();
        toast(d.on === '1' ? 'Nice work. Marked done.' : 'Marked not done'); reTeam(); break;
      }
      case 'pin': await api('POST', T(`/lessons/${d.id}/pin`), { pinned: d.on === '1' }); dropLessonCache(); toast(d.on === '1' ? 'Pinned as this week\'s focus' : 'Unpinned'); reTeam(); break;
      case 'review': await api('POST', T(`/lessons/${d.id}/review`), { reviewed: d.on === '1' }); dropLessonCache(); toast(d.on === '1' ? 'Marked "Coach reviewed"' : 'Review removed'); reTeam(); break;
      case 'delete': if (confirm('Delete this lesson for the whole team? Who finished it is deleted too.')) { await api('DELETE', T(`/lessons/${d.id}`)); dropLessonCache(); toast('Deleted'); go(`#/team/${teamCtx.id}/training`); } break;
      case 'ai-read': {
        const text = document.querySelector('[data-lesson-text]').value;
        lessonAi = { data: await api('POST', T('/lessons/ai/read'), { text }) };
        panel('kit').innerHTML = lessonKitPanel(); break;
      }
      case 'ai-cancel': lessonAi = null; panel('kit').innerHTML = lessonKitPanel(); panel('kit').hidden = true; break;
      case 'ai-import': {
        const picked = [...document.querySelectorAll('[data-lap]:checked')].map((x) => lessonAi.data.lessons[Number(x.dataset.lap)]);
        const r = await api('POST', T('/lessons/ai/import'), { lessons: picked.map(({ flags, ...l }) => l) });
        lessonAi = null; dropLessonCache(); toast(`Added ${r.added} lesson${r.added === 1 ? '' : 's'}`); reTeam(); break;
      }
    }
  } catch (err) { toast(err.message, true); }
});
