'use strict';
/* Team prep: join codes, shared bill research, private speech plans and notes, progress.
   Uses helpers from app.js (api, esc, $view, go, toast, me, fmtTime, SIDE_LABEL). */

let teamCtx = null; // { id, data } for the team being viewed

const ROLE_LABEL = { coach: 'Coach', captain: 'Captain', member: 'Competitor' };
const SECTION_LABEL = { aff: 'Affirmative arguments', neg: 'Negative arguments', evidence: 'Evidence and facts', question: 'Likely questions' };
const STATUS_LABEL_PLAN = { idea: 'Idea', drafting: 'Drafting', ready: 'Ready', delivered: 'Delivered' };
const PLAN_SIDES = { authorship: 'Authorship', aff: 'Affirmative', neg: 'Negative' };
const T = (path = '') => `/api/teams/${teamCtx.id}${path}`;
const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });

// Short form for spoken use: Author, "Title," Publication (Date)
function citeBits(i) {
  const parts = [i.cite_author, i.cite_title ? `"${i.cite_title}"` : '', i.cite_source].filter(Boolean).join(', ');
  return [parts, i.cite_date ? `(${i.cite_date})` : ''].filter(Boolean).join(' ');
}
function citation(i) {
  const bits = citeBits(i);
  if (!bits && !i.cite_url) return '';
  return `<div class="cite">${esc(bits)}${i.cite_url ? ` <a href="${esc(i.cite_url)}" target="_blank" rel="noopener noreferrer">${esc(linkHost(i.cite_url))} ↗</a>` : ''}</div>`;
}
function citationText(i) {
  return [citeBits(i), i.cite_url].filter(Boolean).join(' ');
}
// Full form for a works-cited list: Author. "Title." Publication, Date. URL
function citationFull(i) {
  const end = (t) => (/[.?!]$/.test(t) ? t : `${t}.`);
  return [i.cite_author && end(i.cite_author), i.cite_title && `"${end(i.cite_title)}"`, [i.cite_source, i.cite_date].filter(Boolean).join(', ') && end([i.cite_source, i.cite_date].filter(Boolean).join(', ')), i.cite_url].filter(Boolean).join(' ');
}
function linkHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'source'; } }

// ---------- linked docs and folders ----------
const LINK_KIND = { gdoc: ['Google Doc', '📄'], gsheet: ['Google Sheet', '📊'], gslides: ['Google Slides', '📽'], gform: ['Google Form', '📝'], gfolder: ['Drive folder', '📁'], gdrive: ['Google Drive file', '📎'], web: ['Link', '🔗'] };
function linksCard(links, { title = 'Linked docs & folders', billId, planId, hint, canAdd = true } = {}) {
  const myId = teamCtx.data.me.id, leader = teamCtx.data.me.isLeader;
  return `<div class="card links-card"><h2>${title}</h2>
    ${hint ? `<p class="small muted">${hint}</p>` : ''}
    ${links.length ? `<ul class="list">${links.map((l) => {
      const [label, icon] = LINK_KIND[l.kind] || LINK_KIND.web;
      const canDel = l.plan_id ? l.created_by === myId : (l.created_by === myId || leader);
      return `<li class="spread"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="link-row"><span class="link-icon" aria-hidden="true">${icon}</span><span><strong>${esc(l.title)}</strong><span class="small muted"> ${esc([l.title === label ? '' : label, l.plan_id ? '' : l.added_by].filter(Boolean).join(' · '))}</span></span></a>
        ${canDel ? `<button class="sm ghost" data-tact="delete-link" data-id="${l.id}" aria-label="Remove link">✕</button>` : ''}</li>`;
    }).join('')}</ul>` : '<p class="muted small">Nothing linked yet.</p>'}
    ${canAdd ? `<details><summary class="small"><strong>+ Add a link</strong></summary>
      <form class="stack" data-tform="new-link" ${billId ? `data-bill="${billId}"` : ''} ${planId ? `data-plan="${planId}"` : ''} style="margin-top:8px">
        <input name="url" required placeholder="Paste a Google Doc, Drive folder or web link">
        <input name="title" placeholder="Name (optional)">
        <button class="sm primary">Add link</button>
        <p class="small muted" style="margin:0">Google files open with each person's own Google sharing. Set the doc or folder to "Anyone with the link" or share it with your team.</p>
      </form></details>` : ''}
  </div>`;
}

// ---------- sign up with a join code ----------
async function renderSignup(code = '') {
  let teamName = '';
  if (code) { try { teamName = (await api('GET', `/api/join/${encodeURIComponent(code)}`)).team.name; } catch { /* shown on submit */ } }
  $view.innerHTML = `
    <form class="card login" data-tform="signup">
      <h1>Join your team</h1>
      ${teamName ? `<p>You're joining <strong>${esc(teamName)}</strong>. A coach or captain will approve you.</p>` : '<p class="muted">Enter the join code from your coach or captain. They approve you before you see the team.</p>'}
      <div class="field"><label>Join code</label><input name="code" value="${esc(code)}" autocapitalize="characters" required></div>
      <div class="field"><label>Your name</label><input name="display_name" required></div>
      <div class="field"><label>School</label><input name="school" placeholder="Optional"></div>
      <div class="field"><label>Choose a username</label><input name="username" autocapitalize="none" required></div>
      <div class="field"><label>Password (6+ characters)</label><input name="password" type="password" minlength="6" required></div>
      <button class="primary" style="width:100%;justify-content:center">Create account and join</button>
      <p class="small muted">Already have an account? <a href="#/login">Sign in</a>, then use Teams → Join a team.</p>
    </form>`;
}

// ---------- my teams ----------
async function renderTeams() {
  const { teams } = await api('GET', '/api/teams');
  $view.innerHTML = `
    <a href="#/">← Home</a><h1>Teams</h1>
    <p class="muted">Plan speeches, build shared research on bills with citations, keep private notes, and track progress with your team.</p>
    <div class="card">${teams.length ? `<ul class="list">${teams.map((t) => `<li class="spread">
        ${t.status === 'active' ? `<a href="#/team/${t.id}"><strong>${esc(t.name)}</strong></a>` : `<strong>${esc(t.name)}</strong>`}
        <span class="row">${t.school ? `<span class="small muted">${esc(t.school)}</span>` : ''}
        ${t.status === 'pending' ? '<span class="pill debating">Waiting for approval</span>' : `<span class="pill">${t.via_admin ? 'Admin access' : ROLE_LABEL[t.role]}</span>`}</span></li>`).join('')}</ul>`
      : '<p class="muted" style="margin:0">You are not on a team yet.</p>'}</div>
    <div class="grid two">
      <form class="card" data-tform="join"><h2>Join a team</h2>
        <div class="row"><input name="code" placeholder="Join code" autocapitalize="characters" required style="flex:1;min-width:140px"><button class="primary">Request to join</button></div>
        <p class="small muted">A coach or captain approves new members.</p></form>
      <form class="card" data-tform="new-team"><h2>Start a team</h2>
        <div class="inline-fields"><input name="name" placeholder="Team name" required><input name="school" placeholder="School"></div>
        <button style="margin-top:8px">Create team</button>
        <p class="small muted">You become its coach and get a join code to share.</p></form>
    </div>`;
}

// ---------- team shell ----------
async function loadTeamData(id) {
  const data = await api('GET', `/api/teams/${id}`);
  teamCtx = { id, data };
  return data;
}
async function renderTeam(id, tab = 'research', sub, sub2) {
  let data;
  try { data = await loadTeamData(id); } catch (e) {
    $view.innerHTML = `<div class="card"><p>${esc(e.message)}</p><a href="#/teams">← Teams</a></div>`; return;
  }
  const tabs = [['research', 'Research'], ['training', 'Training'], ['prep', 'My prep'], ['progress', 'Progress'], ['members', data.me.isLeader ? `Members${data.members.some((m) => m.status === 'pending') ? ' •' : ''}` : 'Members']];
  const active = ['bill'].includes(tab) ? 'research' : ['lesson', 'drill'].includes(tab) ? 'training' : (['plan', 'note', 'practice'].includes(tab) ? 'prep' : tab);
  let body;
  try {
    body = await ({
      research: viewResearch, bill: () => viewBill(Number(sub)), training: viewTraining, lesson: () => viewLesson(Number(sub)), drill: () => viewDrill(Number(sub), sub2), prep: viewPrep, plan: () => viewPlan(Number(sub)), practice: () => viewPractice(Number(sub)), note: () => viewNote(Number(sub)),
      progress: () => viewProgress(sub ? Number(sub) : null), members: viewMembers,
    }[tab] || viewResearch)();
  } catch (e) { body = `<div class="card"><p>${esc(e.message)}</p></div>`; }
  document.body.classList.add('wide');
  $view.innerHTML = `
    <a href="#/teams">← Teams</a>
    <div class="spread"><h1>${esc(data.team.name)}</h1><span class="row">${data.team.school ? `<span class="small muted">${esc(data.team.school)}</span>` : ''}<span class="pill">${ROLE_LABEL[data.me.role]}</span></span></div>
    <label class="switch-row small" title="Saves this team's research, your speech plans and notes on this device so they open without Wi-Fi."><input type="checkbox" data-keep-offline="${id}" ${keepOffline(id) ? 'checked' : ''}> Keep available offline <span class="muted" data-keep-label>${keepOffline(id) ? `· ${esc(keptLabel(id))}` : ''}</span></label>
    ${data.team.ai_aids ? `<label class="switch-row small" title="Show research that teammates wrote with an AI assistant. Only changes what you see."><input type="checkbox" data-ai-show ${data.me.showAi ? 'checked' : ''}> Show AI Learning Aids</label>` : ''}
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/team/${id}/${k}" class="${k === active ? 'active' : ''}">${l}</a>`).join('')}</nav>
    ${body}`;
  if (keepOffline(id) && Offline.isOnline() && Date.now() - (keptAt(id) || 0) > 10 * 60 * 1000) saveTeamOffline(id);
}
// ---------- keep a team on this device ----------
const keepKey = (id) => `congress.keep.${me?.id}.${id}`;
function keepOffline(id) { try { return !!localStorage.getItem(keepKey(id)); } catch { return false; } }
function keptAt(id) { try { return JSON.parse(localStorage.getItem(keepKey(id)) || 'null')?.at; } catch { return null; } }
function keptLabel(id) { const t = keptAt(id); return t ? `saved ${new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'saving…'; }
async function saveTeamOffline(id) {
  const base = `/api/teams/${id}`;
  try {
    const data = await api('GET', base);
    const { plans } = await api('GET', `${base}/prep`);
    const lessons = await api('GET', `${base}/lessons`).then((r) => r.lessons).catch(() => []);
    const drillBills = await api('GET', `${base}/drills`).then((r) => r.bills).catch(() => []);
    const urls = [...data.bills.map((b) => `${base}/bills/${b.id}`), ...plans.map((p) => `${base}/plans/${p.id}`), `${base}/progress`, `${base}/lessons`, ...lessons.map((l) => `${base}/lessons/${l.id}`), `${base}/drills`, ...drillBills.map((b) => `${base}/drills/${b.id}`)];
    await Offline.keep(urls);
    try { localStorage.setItem(keepKey(id), JSON.stringify({ at: Date.now() })); } catch { /* storage blocked */ }
    const el = document.querySelector('[data-keep-label]');
    if (el) el.textContent = `· ${keptLabel(id)}`;
    return urls.length + 2;
  } catch (e) { toast(`Could not save for offline: ${e.message}`, true); return 0; }
}
const reTeam = () => route();
const savedToast = (r, msg) => toast(r?.queued ? `${msg} on this device. It sends when you are back online.` : msg);

// ---------- research ----------
const redrawBills = () => { const c = document.querySelector('.bills-card'); if (c) c.outerHTML = billsCard(teamCtx.data.bills, !!document.querySelector('.add-bills')); };
const SESSION_WORD = /^(Prelims?|Preliminary|Session\b|Super|Semi|Finals?|Round\b|Elim)/i;
function billMeta(b) {
  const parts = (b.source || '').split(' · ').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return { tourn: parts[0], session: parts[1], school: parts.slice(2).join(' · ') };
  if (parts.length === 2) return SESSION_WORD.test(parts[1]) ? { tourn: parts[0], session: parts[1], school: '' } : { tourn: parts[0], session: '', school: parts[1] };
  return { tourn: parts[0] || '', session: '', school: '' };
}
function researchLine(b) {
  const bits = [[b.aff, 'aff'], [b.neg, 'neg'], [b.evidence, 'evidence'], [b.questions, b.questions === 1 ? 'question' : 'questions']].filter(([n]) => n);
  return bits.length ? bits.map(([n, l]) => `${n} ${l}`).join(' · ') : '';
}
const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  bill: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  res: svg('<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>'),
  school: svg('<path d="m3 10 9-5 9 5-9 5z"/><path d="M7 12v4c0 1.5 2.2 3 5 3s5-1.5 5-3v-4"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="currentColor"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  book: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  note: svg('<path d="M5 3h10l4 4v14H5z"/><path d="M9 12h6M9 16h6M9 8h3"/>'),
  sec_aff: svg('<path d="M7 11v9H4v-9zM7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.3 20H7"/>'),
  sec_neg: svg('<path d="M17 13V4h3v9zM17 13l-4 8a2.5 2.5 0 0 1-2.5-2.5V15H5.3a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.7 4H17"/>'),
  sec_evidence: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  sec_question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>'),
  gavel: svg('<path d="m14 13-8.5 8.5a2.1 2.1 0 0 1-3-3L11 10"/><path d="m16 16 6-6M8 8l6-6M9 7l8 8M21 11l-8-8"/>'),
};
function billsCard(bills, adding) {
  const counts = { current: bills.filter((b) => b.status === 'current').length, all: bills.filter((b) => b.status !== 'archived').length, archived: bills.filter((b) => b.status === 'archived').length };
  const f = ui.billFilter && (counts[ui.billFilter] || ui.billFilter === 'all') ? ui.billFilter : (counts.current ? 'current' : 'all');
  const inTab = bills.filter((b) => (f === 'archived' ? b.status === 'archived' : f === 'current' ? b.status === 'current' : b.status !== 'archived'));
  const tourns = [...new Set(inTab.map((b) => billMeta(b).tourn).filter(Boolean))].sort();
  const tf = tourns.includes(ui.billTourn) ? ui.billTourn : '';
  const list = inTab.filter((b) => !tf || billMeta(b).tourn === tf);
  const sel = (ui.billSel || []).filter((id) => list.some((b) => b.id === id));
  ui.billSel = sel;
  const leader = teamCtx.data.me.isLeader;
  // Group by tournament, then session, keeping the order bills were added in.
  const groups = [];
  for (const b of [...list].sort((x, y) => x.id - y.id)) {
    const m = billMeta(b), t = m.tourn || 'Other bills';
    let g = groups.find((x) => x.t === t); if (!g) groups.push(g = { t, sessions: [] });
    let ss = g.sessions.find((x) => x.s === m.session); if (!ss) g.sessions.push(ss = { s: m.session, bills: [] });
    ss.bills.push({ b, m, n: ss.bills.length + 1 });
  }
  const leaderDel = leader;
  const READY = [['aff', 'Aff'], ['neg', 'Neg'], ['evidence', 'Evidence'], ['questions', 'Questions']];
  const planBtn = (b, side) => {
    const p = (b.my_plans || []).find((x) => x.side === side);
    const label = side === 'aff' ? 'Aff' : 'Neg';
    return p ? `<a class="btn sm plan-chip ${side}" href="#/team/${teamCtx.id}/plan/${p.id}" title="Your ${label.toLowerCase()} speech">${ICON.mic}${label} · ${esc(STATUS_LABEL_PLAN[p.status] || p.status)}</a>`
      : `<button class="sm" data-tact="plan-from-bill" data-side="${side}" data-bill="${b.id}" data-title="${esc(b.title)}">${ICON.mic}${label}<span class="wide-only">&nbsp;speech</span></button>`;
  };
  const score = (b) => READY.filter(([k]) => b[k]).length;
  const stage = (n) => (n === 4 ? ['done', 'Researched'] : n ? ['mid', 'In progress'] : ['none', 'Not started']);
  const row = ({ b, m, n }) => {
    const sc = score(b), [st, stl] = stage(sc), res = b.kind === 'resolution';
    return `<article class="bill-card kind-${res ? 'resolution' : 'bill'} stage-${st}${b.status === 'current' ? ' is-current' : ''}${b.status === 'archived' ? ' is-archived' : ''}${sel.includes(b.id) ? ' picked' : ''}">
      <div class="bc-top">
        <input type="checkbox" data-bill-sel="${b.id}" ${sel.includes(b.id) ? 'checked' : ''} aria-label="Select ${esc(b.title)}">
        <div class="bc-num" title="Docket position ${n}"><small>${res ? 'Res' : 'Bill'}</small>${n}</div>
        <div class="bc-main">
          <div class="bc-kicker"><span class="type-badge ${res ? 'resolution' : 'bill'}">${res ? ICON.res : ICON.bill}${res ? 'Resolution' : 'Bill'}</span>${m.school ? `<span class="bc-school">${ICON.school}${esc(m.school)}</span>` : ''}${b.status === 'current' ? `<span class="pill now-pill">${ICON.star}Up next</span>` : ''}${b.status === 'archived' ? '<span class="pill">Archived</span>' : ''}</div>
          <a class="bc-title" href="#/team/${teamCtx.id}/bill/${b.id}">${esc(b.title)}</a>
          ${b.preview ? `<p class="bc-preview">${esc(b.preview)}</p>` : ''}
        </div>
        <div class="bc-side">
          <details class="bc-menu"><summary aria-label="More for this bill">⋯</summary><div class="bc-pop">
            ${b.status === 'archived' ? `<button data-tact="bill-status" data-a="restore" data-id="${b.id}">Restore</button>`
              : `${b.status === 'current' ? `<button data-tact="bill-status" data-a="clear" data-id="${b.id}">Unmark current</button>` : `<button data-tact="bill-status" data-a="current" data-id="${b.id}">Mark current</button>`}<button data-tact="bill-status" data-a="archive" data-id="${b.id}">Archive</button>`}
            ${leaderDel ? `<button class="danger" data-tact="bill-del" data-id="${b.id}" data-title="${esc(b.title)}">Delete…</button>` : ''}
          </div></details>
          <span class="rd-badge rd-${st}" title="${sc} of 4 research areas started"><span class="pips">${READY.map(([k]) => `<i class="${b[k] ? 'on' : ''}"></i>`).join('')}</span>${stl}</span>
        </div>
      </div>
      <div class="bc-foot">
        <a class="ready" href="#/team/${teamCtx.id}/bill/${b.id}" title="Team research on this bill">${READY.map(([k, l]) => `<span class="seg-${k}${b[k] ? ' on' : ''}"><b>${b[k] || 0}</b> ${l}</span>`).join('')}</a>
        <div class="bc-actions">${planBtn(b, 'aff')}${planBtn(b, 'neg')}<a class="btn sm ghost" href="#/team/${teamCtx.id}/bill/${b.id}">${ICON.book}Research</a></div>
      </div>
    </article>`;
  };
  const stats = (bs) => { const started = bs.filter((x) => score(x.b)).length; const pct = bs.length ? Math.round(bs.reduce((a, x) => a + score(x.b), 0) / (bs.length * 4) * 100) : 0; return { n: bs.length, cur: bs.filter((x) => x.b.status === 'current').length, started, pct }; };
  const tabs = [['current', 'Current'], ['all', 'All'], ['archived', 'Archived']];
  return `<div class="card bills-card">
    <div class="bills-head">
      <h2>Bills</h2>
      <div class="seg">${tabs.map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-tact="bill-filter" data-f="${k}">${l} <span class="muted">${counts[k]}</span></button>`).join('')}</div>
      ${tourns.length > 1 ? `<select data-bill-tourn aria-label="Tournament"><option value="">All tournaments</option>${tourns.map((t) => `<option ${t === tf ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
      <button class="sm ${adding ? '' : 'primary'} add-btn" data-tact="add-bills">${adding && bills.length ? 'Done adding' : '+ Add bills'}</button>
    </div>
    ${list.length ? `
    <div class="bulkbar ${sel.length ? 'on' : ''}">
      <label><input type="checkbox" data-bill-all ${sel.length && sel.length === list.length ? 'checked' : ''}> ${sel.length ? `${sel.length} selected` : 'Select'}</label>
      ${sel.length ? `${f === 'archived'
        ? '<button class="sm" data-tact="bill-bulk" data-a="restore">Restore</button>'
        : `<button class="sm" data-tact="bill-bulk" data-a="current">Mark current</button>${list.some((b) => sel.includes(b.id) && b.status === 'current') ? '<button class="sm" data-tact="bill-bulk" data-a="clear">Unmark current</button>' : ''}<button class="sm" data-tact="bill-bulk" data-a="archive">Archive</button>`}
        ${leader ? '<button class="sm danger-ghost" data-tact="bill-bulk" data-a="delete">Delete</button>' : ''}` : ''}
    </div>
    ${groups.map((g) => { const all = g.sessions.flatMap((x) => x.bills), gs = stats(all); return `<section class="bill-group">${groups.length > 1 || g.t !== 'Other bills' ? `<header class="tourn-banner">
        <div class="tb-name"><span class="tb-icon">${ICON.trophy}</span><div><span class="eyebrow">Tournament</span><h3>${esc(g.t)}</h3></div></div>
        <div class="tb-stats"><span><b>${gs.n}</b> ${gs.n === 1 ? 'item' : 'items'}</span>${gs.cur ? `<span class="tb-cur"><b>${gs.cur}</b> up next</span>` : ''}<span><b>${gs.started}</b> started</span></div>
        <div class="tb-meter" title="Research coverage across this tournament"><span style="width:${gs.pct}%"></span><em>${gs.pct}% researched</em></div>
      </header>` : ''}
      ${g.sessions.map((ss) => { const s2 = stats(ss.bills); return `${ss.s ? `<div class="session-band"><span class="sb-name">${ICON.gavel}${esc(ss.s)}</span><span class="sb-count">${s2.n}</span><span class="sb-prog">${s2.started} of ${s2.n} started</span></div>` : ''}<div class="bill-cards">${ss.bills.map(row).join('')}</div>`; }).join('')}</section>`; }).join('')}`
    : `<p class="muted">${!bills.length ? 'No bills yet. Import a tournament packet below, or add one by hand.' : f === 'current' ? 'No bills are marked current. Open All, tick the bills for your next tournament, and tap Mark current.' : f === 'archived' ? 'Nothing archived.' : 'Every bill is archived. Open Archived to bring some back.'}</p>`}
  </div>`;
}

async function viewResearch() {
  const { bills, links } = teamCtx.data;
  const adding = ui.addBills || !bills.length || packetState?.target === 'team';
  return `
    ${billsCard(bills, adding)}
    ${adding ? `<div class="grid two add-bills">
      <div>${packetCard('team')}
        <div class="card"><h2>Import from a chamber docket</h2><p class="small muted">Copies bills from chambers you're in, so the team can research them.</p>
          <div data-docket-options><button class="sm" data-tact="load-docket">Show docket items</button></div></div></div>
      <form class="card" data-tform="new-bill"><h2>Add a bill by hand</h2>
        <div class="field"><label>Title</label><input name="title" required placeholder="A Bill to…"></div>
        <div class="inline-fields"><div class="field"><label>Type</label><select name="kind"><option value="bill">Bill</option><option value="resolution">Resolution</option></select></div>
        <div class="field"><label>Tournament</label><input name="source" placeholder="e.g. WSFA Fall 2026"></div></div>
        <div class="field"><label>Summary</label><textarea name="summary" rows="3"></textarea></div>
        <button class="primary">Add</button></form>
    </div>` : ''}
    <details class="card docs-fold" ${links?.length ? '' : ''}><summary><h2 style="display:inline">Team docs &amp; folders</h2> <span class="muted small">${links?.length || 0}</span></summary>
      ${linksCard(links || [], { title: '', hint: 'The team Drive folder, a shared docket doc, a research spreadsheet…' }).replace(/^<div class="card[^"]*"><h2><\/h2>/, '<div>')}</details>`;
}
function itemForm(section, item = {}, billId) {
  const isEv = section === 'evidence';
  return `<form class="stack item-form" data-tform="${item.id ? 'edit-item' : 'new-item'}" data-bill="${billId}" data-section="${section}" ${item.id ? `data-id="${item.id}"` : ''}>
    <textarea name="text" rows="2" required placeholder="${isEv ? 'Fact, statistic or quote' : section === 'question' ? 'A question you might be asked, or should ask' : 'Claim'}">${esc(item.text || '')}</textarea>
    <textarea name="detail" rows="2" placeholder="${isEv ? 'How to use it (optional)' : section === 'question' ? 'Suggested answer (optional)' : 'Warrant and impact (optional)'}">${esc(item.detail || '')}</textarea>
    ${isEv ? `<div class="inline-fields"><select name="side">${['both', 'aff', 'neg'].map((s) => `<option value="${s}" ${item.side === s ? 'selected' : ''}>${s === 'both' ? 'Either side' : s === 'aff' ? 'Supports aff' : 'Supports neg'}</option>`).join('')}</select></div>` : ''}
    <details ${isEv ? 'open' : ''}><summary class="small">Citation</summary>
      <div class="cite-fields" style="margin-top:6px">
        <div class="row cite-url"><input name="cite_url" placeholder="Paste the article link" value="${esc(item.cite_url || '')}"><button type="button" class="sm" data-tact="autofill">Fill in from link</button></div>
        <div class="inline-fields"><input name="cite_author" placeholder="Author / organization" value="${esc(item.cite_author || '')}"><input name="cite_title" placeholder="Article title" value="${esc(item.cite_title || '')}"></div>
        <div class="inline-fields"><input name="cite_source" placeholder="Publication / website" value="${esc(item.cite_source || '')}"><input name="cite_date" placeholder="Date" value="${esc(item.cite_date || '')}"></div>
        <div class="small muted" data-cite-msg></div>
      </div></details>
    ${item.id ? `<input type="hidden" name="base_updated_at" value="${item.base_updated_at ?? item.updated_at ?? ''}">` : ''}
    <div class="row"><button class="sm primary">${item.id ? 'Save' : 'Add'}</button><button type="button" class="sm ghost" data-tact="${item.id ? 'item-edit' : 'sec-add'}">Cancel</button>${item.id ? `<button type="button" class="sm danger-ghost push-right" data-tact="delete-item" data-bill="${billId}" data-id="${item.id}">Delete</button>` : ''}</div>
  </form>`;
}
// ---------- AI Learning Aids ----------
// The app never calls an AI. A student downloads a prep kit (Markdown), gives it to their own assistant,
// and uploads the reply. Everything that comes back is tagged as an AI Learning Aid and can be hidden.
const AI_ICON = '<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9zM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7z"/></svg>';
const aiBadge = () => `<span class="ai-badge" title="Written with an AI assistant">${AI_ICON}AI Learning Aid</span>`;
const aiOn = () => !!(teamCtx.data.team.ai_aids && teamCtx.data.me.showAi);
let aiPreview = null;
function aiKit(bill, items) {
  const m = billMeta(bill);
  const have = (k) => items.filter((i) => i.section === k).map((i) => `- ${i.text}`).join('\n') || '- (none yet)';
  return `# Congress Debate prep kit: ${bill.title}

## Instructions for the AI assistant

You are helping a high school student prepare for Congressional Debate on the legislation below. Your reply is saved in their team's prep app as an **AI Learning Aid**: it should teach and give starting points. Do not write a finished speech.

Follow these rules:

1. **Real sources only.** Every piece of evidence must come from a real, published source, with its full link. If you cannot browse the web or check a source, leave the Evidence section empty. Never invent statistics, quotes, authors, dates or links.
2. Give arguments for **both** sides. Keep each claim to one sentence, then give the warrant (why it is true) and the impact (why it matters).
3. Aim for 3 to 5 affirmative arguments, 3 to 5 negative arguments, 4 to 8 pieces of evidence, and 4 to 8 likely questions.
4. Don't repeat what the team already has (listed at the end).
5. Reply with **only** one Markdown document in exactly the format below, so the student can upload it. Keep the \`##\` headings and the \`- Key:\` lines exactly as shown. Save it as a .md file if you can.

## Reply format

\`\`\`markdown
# AI Learning Aid: ${bill.title}

## Summary
Two or three plain-English sentences on what the legislation does and who it affects.

## Affirmative arguments
### One-sentence claim
Warrant: why it is true.
Impact: why it matters.

## Negative arguments
### One-sentence claim
Warrant: why it is true.
Impact: why it matters.

## Evidence
### The fact, statistic or short quote
- Supports: aff | neg | either
- Source: publication or website
- Author: person or organization
- Title: article or report title
- Date: publication date
- Link: https://the-full-link
How to use it: one sentence.

## Likely questions
### A question a cross-examiner might ask
- For: aff | neg | either (which speaker should prepare for it)
Answer: a short suggested answer.
\`\`\`

## The legislation

- **Title:** ${bill.title}
- **Type:** ${bill.kind === 'resolution' ? 'Resolution' : 'Bill'}
${m.tourn ? `- **Tournament:** ${m.tourn}\n` : ''}${m.session ? `- **Session:** ${m.session}\n` : ''}${m.school ? `- **Written by:** ${m.school}\n` : ''}
${bill.summary ? `**Summary:** ${bill.summary}\n\n` : ''}${bill.body ? `### Full text\n\n${bill.body}\n` : '(The full text was not entered. Work from the title, and say so in the summary.)\n'}
## What the team already has

### Affirmative arguments
${have('aff')}

### Negative arguments
${have('neg')}

### Evidence
${have('evidence')}

### Likely questions
${have('question')}
`;
}
function aiPreviewHtml() {
  const p = aiPreview?.data; if (!p) return '';
  const LABEL = { summary: 'Summary', aff: 'Affirmative arguments', neg: 'Negative arguments', evidence: 'Evidence', question: 'Likely questions' };
  const groups = ['aff', 'neg', 'evidence', 'question'].map((k) => [k, p.items.map((it, n) => ({ it, n })).filter(({ it }) => it.section === k)]).filter(([, l]) => l.length);
  const ok = (it) => !it.flags.length;
  const count = p.items.filter(ok).length + (p.summary ? 1 : 0);
  return `<div class="ai-preview">
    ${p.warnings.map((w) => `<div class="banner recess small">${esc(w)}</div>`).join('')}
    ${p.summary ? `<label class="aip-row"><input type="checkbox" data-aip="summary" checked><span><b>${LABEL.summary}</b><span class="aip-detail">${esc(p.summary)}</span></span></label>` : ''}
    ${groups.map(([k, l]) => `<h4>${LABEL[k]} <span class="muted">${l.length}</span></h4>${l.map(({ it, n }) => {
      const noLink = it.flags.includes('no_link'), dup = it.flags.includes('duplicate');
      return `<label class="aip-row${noLink ? ' blocked' : ''}"><input type="checkbox" data-aip="${n}" ${ok(it) ? 'checked' : ''} ${noLink ? 'disabled' : ''}>
        <span><b>${esc(it.text)}</b>${it.side !== 'both' && ['evidence', 'question'].includes(k) ? ` <span class="pill ${it.side}">${it.side}</span>` : ''}
        ${it.detail ? `<span class="aip-detail">${esc(it.detail)}</span>` : ''}
        ${it.cite_url ? `<span class="aip-detail">${esc([it.cite_source, it.cite_date].filter(Boolean).join(', '))} <a href="${esc(it.cite_url)}" target="_blank" rel="noopener noreferrer">${esc(linkHost(it.cite_url))} ↗</a></span>` : ''}
        ${noLink ? '<span class="aip-flag">No link to a real source, so it can\'t be added. Ask your AI for the link.</span>' : ''}${dup ? '<span class="aip-flag">Already on this bill</span>' : ''}</span></label>`; }).join('')}`).join('')}
    <div class="row aip-actions"><button class="primary" data-tact="ai-import" ${count ? '' : 'disabled'}>${AI_ICON}Add ${count} as AI Learning Aids</button><button class="ghost" data-tact="ai-cancel">Cancel</button></div>
  </div>`;
}
function aiBand(bill) {
  const team = teamCtx.data.team, me2 = teamCtx.data.me;
  if (!team.ai_aids) return '';
  if (!me2.showAi) return `<p class="ai-hidden small muted">${AI_ICON} AI Learning Aids are hidden for you. <button class="linkish" data-tact="ai-hide" data-hide="0">Show them</button></p>`;
  return `<section class="ai-band">
    <div class="ai-band-head"><span class="ai-mark">${AI_ICON}</span><div><h2>AI Learning Aids</h2>
      <p class="small">Give your AI assistant this bill's prep kit. It explains the rules and the reply format. Then upload what it writes back.</p></div></div>
    <div class="ai-steps">
      <div class="ai-step"><span class="ai-num">1</span><div><b>Get the kit</b><div class="row"><button class="sm" data-tact="ai-kit-dl" data-id="${bill.id}">Download .md</button><button class="sm ghost" data-tact="ai-kit-copy" data-id="${bill.id}">Copy</button></div></div></div>
      <div class="ai-step"><span class="ai-num">2</span><div><b>Ask your AI</b><div class="small muted">Attach or paste the kit into Claude, ChatGPT or another assistant that can search the web.</div></div></div>
      <div class="ai-step"><span class="ai-num">3</span><div><b>Upload its reply</b><div class="row"><button class="sm primary" data-tact="ai-upload" >Upload reply</button></div></div></div>
    </div>
    <div class="ai-upload" ${aiPreview?.bid === bill.id ? '' : 'hidden'}>
      ${aiPreview?.bid === bill.id && aiPreview.data ? aiPreviewHtml() : `<div class="stack">
        <label class="ai-file"><input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" data-ai-file> <span>Choose the .md file</span></label>
        <textarea rows="6" data-ai-text placeholder="…or paste the AI's whole reply here"></textarea>
        <div class="row"><button class="sm primary" data-tact="ai-read" data-id="${bill.id}">Read reply</button><button class="sm ghost" data-tact="ai-cancel">Cancel</button></div></div>`}
    </div>
    <div class="ai-band-foot small"><button class="linkish" data-tact="ai-hide" data-hide="1">Hide AI Learning Aids</button></div>
  </section>`;
}
const SECTION_META = {
  aff: { short: 'Aff', add: 'Add an aff argument', empty: 'No affirmative arguments yet.' },
  neg: { short: 'Neg', add: 'Add a neg argument', empty: 'No negative arguments yet.' },
  evidence: { short: 'Evidence', add: 'Add evidence', empty: 'No evidence yet. Facts, stats and quotes with a source go here.' },
  question: { short: 'Questions', add: 'Add a question', empty: 'No questions yet. Think about what a cross-examiner would ask.' },
};
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function itemView(i, billId) {
  const flag = i.pending ? '<span class="pill warn">Waiting to send</span>' : i.conflict_of ? '<span class="pill failed" title="Saved while offline after a teammate changed the same entry. Keep one and delete the other.">Offline copy</span>' : '';
  const who = i.updated_by_name || i.created_by_name || '';
  const q = i.section === 'question';
  return `<li class="ri ri-${i.section}${i.ai ? ' is-ai' : ''}${i.pending ? ' pending' : i.conflict_of ? ' conflict' : ''}">
    <div class="ri-view">
      ${flag || i.ai || (i.section === 'evidence' && i.side !== 'both') ? `<div class="ri-flags">${i.ai ? aiBadge() : ''}${flag}${i.section === 'evidence' && i.side !== 'both' ? `<span class="pill ${i.side}">Supports ${i.side}</span>` : ''}</div>` : ''}
      <div class="ri-text">${q ? '<span class="ri-q">Q</span>' : ''}<strong>${esc(i.text)}</strong></div>
      ${i.detail ? `<div class="ri-detail${q ? ' ri-answer' : ''}">${q ? '<span class="ri-a">A</span>' : ''}<span>${esc(i.detail)}</span></div>` : ''}
      ${citation(i)}
      <div class="ri-foot"><span class="ri-who"><span class="avatar-xs">${esc(initials(who))}</span>${esc(who)} · ${fmtDate(i.updated_at)}</span>
        <span class="ri-acts">${citationFull(i) ? `<button class="linkish" data-tact="copy-cite" data-text="${esc(citationFull(i))}">Copy citation</button>` : ''}<button class="icon-btn" data-tact="item-edit" aria-label="Edit" title="Edit">${ICON.pencil}</button></span></div>
    </div>
    <div class="ri-edit">${itemForm(i.section, i, billId)}</div></li>`;
}
async function viewBill(bid) {
  const [{ bill, items, my_plans, my_notes, links }] = await Promise.all([api('GET', T(`/bills/${bid}`)), loadLessons().catch(() => null)]);
  ui.billData = { bill, items };
  if (aiPreview && aiPreview.bid !== bill.id) aiPreview = null;
  const evSide = ui.evSide || 'all';
  const m = billMeta(bill), res = bill.kind === 'resolution';
  const counts = Object.fromEntries(Object.keys(SECTION_META).map((k) => [k, items.filter((i) => i.section === k).length]));
  const sc = Object.values(counts).filter(Boolean).length;
  const [st, stl] = sc === 4 ? ['done', 'Researched'] : sc ? ['mid', 'In progress'] : ['none', 'Not started'];
  const section = (k) => {
    const sm = SECTION_META[k];
    let list = items.filter((i) => i.section === k);
    if (k === 'evidence' && evSide !== 'all') list = list.filter((i) => i.side === evSide || i.side === 'both');
    return `<section class="rs rs-${k}" id="sec-${k}">
      <header class="rs-head"><span class="rs-icon">${ICON['sec_' + k]}</span><h2>${SECTION_LABEL[k]}</h2><span class="rs-count">${counts[k]}</span>
        ${k === 'evidence' && counts.evidence ? `<div class="seg rs-filter">${['all', 'aff', 'neg'].map((s) => `<button class="${evSide === s ? 'on' : ''}" data-tact="ev-side" data-side="${s}">${s === 'all' ? 'All' : s === 'aff' ? 'Aff' : 'Neg'}</button>`).join('')}</div>` : ''}
        <button class="sm rs-addbtn" data-tact="sec-add" aria-label="${sm.add}">+ Add</button></header>
      ${skillLink(k)}
      <div class="rs-add" hidden><h3>${sm.add}</h3>${itemForm(k, {}, bid)}</div>
      ${list.length ? `<ul class="rs-items">${list.map((i) => itemView(i, bid)).join('')}</ul>`
        : `<div class="rs-empty"><p>${counts[k] ? 'Nothing for this side yet.' : sm.empty}</p><button class="sm" data-tact="sec-add">+ ${sm.add}</button></div>`}
    </section>`;
  };
  const plan = (side) => {
    const p = my_plans.find((x) => x.side === side);
    return p ? `<a class="btn sm plan-chip ${side}" href="#/team/${teamCtx.id}/plan/${p.id}">${ICON.mic}${PLAN_SIDES[side]} · ${esc(STATUS_LABEL_PLAN[p.status] || p.status)}</a>`
      : `<button class="sm prep-${side}" data-tact="plan-from-bill" data-bill="${bill.id}" data-side="${side}" data-title="${esc(bill.title)}">${ICON.mic}${PLAN_SIDES[side]}</button>`;
  };
  const leader = teamCtx.data.me.isLeader;
  return `
    <nav class="crumbs"><a href="#/team/${teamCtx.id}/research">← Bills</a>${m.tourn ? `<span>${esc(m.tourn)}</span>` : ''}${m.session ? `<span>${esc(m.session)}</span>` : ''}</nav>
    <header class="bill-hero kind-${res ? 'resolution' : 'bill'}${bill.status === 'current' ? ' is-current' : ''}${bill.status === 'archived' ? ' is-archived' : ''}">
      <div class="bh-top">
        <div class="bc-kicker"><span class="type-badge">${res ? ICON.res : ICON.bill}${res ? 'Resolution' : 'Bill'}</span>${m.school ? `<span class="bc-school">${ICON.school}${esc(m.school)}</span>` : ''}${bill.status === 'current' ? `<span class="pill now-pill">${ICON.star}Up next</span>` : ''}${bill.status === 'archived' ? '<span class="pill">Archived</span>' : ''}</div>
        <details class="bc-menu"><summary aria-label="More for this bill">⋯</summary><div class="bc-pop">
          ${bill.status === 'archived' ? `<button data-tact="bill-status" data-a="restore" data-id="${bill.id}">Restore</button>`
            : `${bill.status === 'current' ? `<button data-tact="bill-status" data-a="clear" data-id="${bill.id}">Unmark current</button>` : `<button data-tact="bill-status" data-a="current" data-id="${bill.id}">Mark current</button>`}<button data-tact="bill-status" data-a="archive" data-id="${bill.id}">Archive</button>`}
          <button data-tact="bill-edit">Edit details</button>
          ${leader ? `<button class="danger" data-tact="delete-bill" data-id="${bill.id}">Delete…</button>` : ''}
        </div></details>
      </div>
      <h1 class="bh-title">${esc(bill.title)}</h1>
      ${bill.preview ? `<p class="bc-preview bh-preview">${esc(bill.preview)}</p>` : ''}
      ${bill.ai_summary ? `<div class="ai-summary">${aiBadge()}<p>${esc(bill.ai_summary)}</p><button class="icon-btn" data-tact="ai-sum-del" data-id="${bill.id}" title="Remove the AI summary" aria-label="Remove the AI summary">✕</button></div>` : ''}
      ${bill.body ? `<details class="bh-text"><summary class="btn sm ghost">${ICON.bill}<span class="when-closed">Read the full text</span><span class="when-open">Hide the full text</span></summary><pre class="legtext">${esc(bill.body)}</pre></details>` : ''}
      <form class="stack bh-edit" data-tform="edit-bill" data-id="${bill.id}" hidden>
        <div class="field"><label>Title</label><input name="title" value="${esc(bill.title)}"></div>
        <div class="field"><label>Tournament · session · school</label><input name="source" value="${esc(bill.source)}" placeholder="WSFA Fall 2026 · Prelims · School"></div>
        <div class="field"><label>Summary</label><textarea name="summary" rows="3" placeholder="One or two sentences on what it does">${esc(bill.summary)}</textarea></div>
        <div class="field"><label>Full text</label><textarea name="body" rows="8">${esc(bill.body)}</textarea></div>
        <div class="row"><button class="sm primary">Save</button><button type="button" class="sm ghost" data-tact="bill-edit">Cancel</button></div></form>
      <div class="bh-prep">
        <div class="bh-prep-label">Your prep</div>
        <div class="bh-prep-btns">${plan('aff')}${plan('neg')}${plan('authorship')}
          ${my_notes.length ? my_notes.map((n) => `<a class="btn sm ghost" href="#/team/${teamCtx.id}/note/${n.id}">${ICON.note}${esc(n.title.replace(/^Notes: .*/, 'My notes'))}</a>`).join('') : `<button class="sm ghost" data-tact="note-from-bill" data-bill="${bill.id}" data-title="${esc(bill.title)}">${ICON.note}Private note</button>`}</div>
      </div>
    </header>
    ${aiBand(bill)}
    <nav class="rs-jump" aria-label="Research sections">
      <span class="rd-badge rd-${st}" title="${sc} of 4 research areas started"><span class="pips">${Object.keys(SECTION_META).map((k) => `<i class="${counts[k] ? 'on' : ''}"></i>`).join('')}</span>${stl}</span>
      ${Object.entries(SECTION_META).map(([k, sm]) => `<a href="#sec-${k}" data-jump="sec-${k}" class="jump-${k}${counts[k] ? ' on' : ''}"><b>${counts[k]}</b> ${counts[k] === 1 && k === 'question' ? 'Question' : sm.short}</a>`).join('')}
      <a href="#sec-docs" data-jump="sec-docs" class="jump-docs${links.length ? ' on' : ''}"><b>${links.length}</b> Docs</a>
    </nav>
    <div class="rs-grid">
      <div class="rs-col">${section('aff')}${section('evidence')}</div>
      <div class="rs-col">${section('neg')}${section('question')}<div id="sec-docs">${linksCard(links, { title: 'Docs &amp; folders', billId: bill.id, hint: 'Shared research docs, Drive folders or articles for this bill.' })}</div></div>
    </div>`;
}

// ---------- private prep ----------
async function viewPrep() {
  const { plans, notes } = await api('GET', T('/prep'));
  const bills = teamCtx.data.bills;
  const billOpts = (sel) => `<option value="">No bill yet</option>${bills.map((b) => `<option value="${b.id}" ${sel === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}`;
  return `
    <p class="muted small">Only you can see your speech plans and notes. You can choose to share a speech plan with your coaches and captains.</p>
    <div class="grid two">
      <div class="card"><h2>Speech plans</h2>
        ${plans.length ? `<ul class="list">${plans.map((p) => `<li class="spread"><div><a href="#/team/${teamCtx.id}/plan/${p.id}"><strong>${esc(p.title)}</strong></a>
            <div class="small muted">${p.bill_title ? esc(p.bill_title) : 'No bill'}${p.tournament ? ` · ${esc(p.tournament)}` : ''}</div></div>
          <span class="row"><span class="pill ${p.side}">${PLAN_SIDES[p.side] || p.side}</span><span class="pill plan-${p.status}">${STATUS_LABEL_PLAN[p.status]}</span>${p.shared_with_leaders ? '<span class="pill">Shared</span>' : ''}<a class="btn sm ghost prep-practice" href="#/team/${teamCtx.id}/practice/${p.id}" title="Practice this speech">${ICON.mic}${p.practice_count ? `${p.practice_count}× · ${fmtT(p.practice_last)}` : 'Practice'}</a></span></li>`).join('')}</ul>` : '<p class="muted small">No speech plans yet.</p>'}
        <form data-tform="new-plan" class="stack" style="margin-top:10px"><h3>New speech plan</h3>
          <input name="title" placeholder="Working title" required>
          <div class="inline-fields"><select name="bill_id">${billOpts()}</select><select name="side">${Object.entries(PLAN_SIDES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <button class="sm primary">Create</button></form>
      </div>
      <div class="card"><h2>Notes</h2>
        ${notes.length ? `<ul class="list">${notes.map((n) => `<li><a href="#/team/${teamCtx.id}/note/${n.id}"><strong>${esc(n.title)}</strong></a>
          <div class="small muted">${n.bill_title ? esc(n.bill_title) + ' · ' : ''}${fmtDate(n.updated_at)}</div></li>`).join('')}</ul>` : '<p class="muted small">No notes yet.</p>'}
        <form data-tform="new-note" class="stack" style="margin-top:10px"><h3>New note</h3>
          <input name="title" placeholder="Title" required><select name="bill_id">${billOpts()}</select>
          <button class="sm primary">Create</button></form>
      </div>
    </div>`;
}
async function viewPlan(pid) {
  const { plan, own, author, items, links, runs = [] } = await api('GET', T(`/plans/${pid}`));
  const used = items.filter((i) => citationFull(i) && plan.outline.includes(i.text));
  const cited = `<div class="card"><div class="spread"><h2>Works cited</h2>${used.length ? `<button class="sm" data-tact="copy-cite" data-text="${esc(used.map(citationFull).join('\n'))}">Copy all</button>` : ''}</div>
    ${used.length ? `<ol class="works-cited">${used.map((i) => `<li>${esc(citationFull(i))}${i.cite_url ? ` <a href="${esc(i.cite_url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</li>`).join('')}</ol>`
      : '<p class="muted small">Insert team evidence into your outline and its sources are listed here automatically.</p>'}</div>`;
  const bills = teamCtx.data.bills;
  const relevant = items.filter((i) => i.section === 'question' || i.section === 'evidence' ? (i.side === 'both' || plan.side === 'authorship' || i.side === plan.side) : (plan.side === 'authorship' ? i.section === 'aff' : i.section === plan.side || i.section === (plan.side === 'aff' ? 'neg' : 'aff')));
  const groups = [['aff', 'neg'].includes(plan.side) ? plan.side : 'aff', 'evidence', 'question', plan.side === 'aff' ? 'neg' : plan.side === 'neg' ? 'aff' : null].filter(Boolean);
  const dis = own ? '' : 'disabled';
  return `
    <a href="#/team/${teamCtx.id}/${own ? 'prep' : `progress/${plan.user_id}`}">← Back</a>
    ${own ? '' : `<div class="banner recess">Shared by ${esc(author)}. Read only.</div>`}
    <div class="grid side">
      <form class="card stack" data-tform="save-plan" data-id="${plan.id}">
        <input name="title" value="${esc(plan.title)}" ${dis} style="font-size:20px;font-weight:700">
        <div class="inline-fields">
          <div class="field"><label>Bill</label><select name="bill_id" ${dis}><option value="">No bill yet</option>${bills.filter((b) => b.status !== 'archived' || b.id === plan.bill_id).map((b) => `<option value="${b.id}" ${plan.bill_id === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select></div>
          <div class="field"><label>Side</label><select name="side" ${dis}>${Object.entries(PLAN_SIDES).map(([k, l]) => `<option value="${k}" ${plan.side === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Status</label><select name="status" ${dis}>${Object.entries(STATUS_LABEL_PLAN).map(([k, l]) => `<option value="${k}" ${plan.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Tournament</label><input name="tournament" value="${esc(plan.tournament)}" ${dis}></div>
        </div>
        <div class="field"><label>Outline and draft</label><textarea name="outline" rows="18" data-outline ${dis} placeholder="Intro and hook&#10;Point 1: claim, warrant, evidence, impact&#10;Point 2: …&#10;Refutation of earlier speakers&#10;Conclusion">${esc(plan.outline)}</textarea></div>
        ${own ? `<label class="row" style="color:var(--ink)"><input type="checkbox" name="shared_with_leaders" ${plan.shared_with_leaders ? 'checked' : ''} style="width:auto;min-height:0"> Share this plan with my coaches and captains</label>
        <div class="row"><button class="primary">Save</button><button type="button" class="sm ghost" data-tact="delete-plan" data-id="${plan.id}">Delete</button><span class="small muted" data-saved></span></div>` : ''}
      </form>
      <div>
      ${own || runs.length ? `<div class="card practice-card"><div class="spread"><h2>Practice</h2>${runStats(runs)}</div>
        ${own ? `<button class="primary practice-go" data-tact="plan-practice" data-id="${plan.id}">${ICON.mic}Practice this speech</button>` : ''}
        ${runs.length ? runsLog(runs, plan.id, own, 3) : `<p class="small muted">Run it against a 3-minute timer, record yourself, and keep notes on what to fix.</p>`}</div>` : ''}
      <div class="card"><h2>Team research${plan.bill_title ? ` on this bill` : ''}</h2>
        ${!plan.bill_id ? '<p class="muted small">Pick a bill to see the team\'s arguments, evidence and likely questions here.</p>'
          : relevant.length ? groups.map((g) => { const list = relevant.filter((i) => i.section === g); return list.length ? `<h3>${SECTION_LABEL[g]}</h3><ul class="list">${list.map((i) => `<li><div class="spread"><strong class="small">${i.ai ? `${aiBadge()} ` : ''}${esc(i.text)}</strong>${own ? `<button class="sm" data-tact="insert" data-text="${esc(i.text + (i.detail ? ` (${i.detail})` : '') + (citationText(i) ? ` [${citationText(i)}]` : ''))}">Insert</button>` : ''}</div>${citation(i)}</li>`).join('')}</ul>` : ''; }).join('')
          : `<p class="muted small">No research yet. <a href="#/team/${teamCtx.id}/bill/${plan.bill_id}">Add some on the bill page</a>.</p>`}
      </div>
      </div>
    </div>
    <div class="grid two">${cited}${linksCard(links, { title: 'My docs for this speech', planId: plan.id, canAdd: own, hint: own ? 'Link your Google Doc draft or anything else for this speech. Only you see these, plus coaches and captains if you share the plan.' : '' })}</div>`;
}
async function viewNote(nid) {
  const { notes } = await api('GET', T('/prep'));
  const n = notes.find((x) => x.id === nid);
  if (!n) return '<div class="card"><p>Note not found.</p></div>';
  return `<a href="#/team/${teamCtx.id}/prep">← My prep</a>
    <form class="card stack" data-tform="save-note" data-id="${n.id}">
      <input name="title" value="${esc(n.title)}" style="font-size:20px;font-weight:700">
      <select name="bill_id"><option value="">No bill</option>${teamCtx.data.bills.filter((b) => b.status !== 'archived' || b.id === n.bill_id).map((b) => `<option value="${b.id}" ${n.bill_id === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
      <textarea name="body" rows="16">${esc(n.body)}</textarea>
      <div class="row"><button class="primary">Save</button><button type="button" class="sm ghost" data-tact="delete-note" data-id="${n.id}">Delete</button><span class="small muted">Private to you</span></div>
    </form>`;
}

// ---------- speech practice ----------
// A timer that counts down like a PO's, with signals at 1:00, 0:30 and 0:10, a 10-second grace period,
// an optional recording kept on this device, and a log of each run's time and notes.
const fmtT = (sec) => { const a = Math.abs(Math.round(sec)); return `${sec < 0 ? '+' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`; };
const GRACE = 10;
const TARGETS = [[180, 'Speech 3:00'], [120, 'Questions 2:00'], [60, 'Questions 1:00']];
let prac = null;
function pracOpts() { try { return { notes: true, record: false, sound: false, ...JSON.parse(localStorage.getItem('congress.practice') || '{}') }; } catch { return { notes: true, record: false, sound: false }; } }
function savePracOpts(o) { try { localStorage.setItem('congress.practice', JSON.stringify(o)); } catch { /* fine */ } }
function runVerdict(sec, target) {
  const d = sec - target;
  if (d > GRACE) return ['over', `${fmtT(d).slice(1)} over`];
  if (d > 0) return ['grace', `${d}s into grace`];
  if (d >= -15) return ['good', 'Right on time'];
  return ['short', `${fmtT(-d)} short`];
}
const stars = (n) => `<span class="stars" aria-label="${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}">★</i>`).join('')}</span>`;
function runsLog(runs, planId, own, limit) {
  if (!runs.length) return '<p class="muted small">No practice runs yet.</p>';
  const list = limit ? runs.slice(0, limit) : runs;
  return `<ul class="run-log">${list.map((r) => { const [k, l] = runVerdict(r.seconds, r.target); return `<li class="run v-${k}${r.pending ? ' pending' : ''}">
      <span class="run-time">${fmtT(r.seconds)}</span>
      <span class="run-main"><span class="run-verdict">${l}</span><span class="small muted">${fmtDate(r.created_at)}${r.target !== 180 ? ` · ${fmtT(r.target)} target` : ''}${r.pending ? ' · waiting to send' : ''}</span>${r.notes ? `<span class="run-notes">${esc(r.notes)}</span>` : ''}</span>
      ${r.rating ? stars(r.rating) : ''}
      ${own && r.id ? `<button class="icon-btn" data-tact="run-del" data-plan="${planId}" data-id="${r.id}" aria-label="Delete run" title="Delete run">✕</button>` : ''}</li>`; }).join('')}</ul>
    ${limit && runs.length > limit ? `<a class="small" href="#/team/${teamCtx.id}/practice/${planId}">See all ${runs.length} runs</a>` : ''}`;
}
function runStats(runs) {
  if (!runs.length) return '';
  const onTime = runs.filter((r) => ['good', 'grace'].includes(runVerdict(r.seconds, r.target)[0])).length;
  const avg = Math.round(runs.reduce((a, r) => a + r.seconds, 0) / runs.length);
  return `<div class="run-stats"><span><b>${runs.length}</b> run${runs.length === 1 ? '' : 's'}</span><span><b>${fmtT(avg)}</b> average</span><span><b>${onTime}</b> on time</span></div>`;
}
async function viewPractice(pid) {
  const { plan, own, runs } = await api('GET', T(`/plans/${pid}`));
  if (!own) return `<div class="card"><p>Only ${'the speaker'} can practice this speech.</p></div>`;
  const o = pracOpts();
  const target = TARGETS.some(([t]) => t === ui.pracTarget) ? ui.pracTarget : 180;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  return `
    <nav class="crumbs"><a href="#/team/${teamCtx.id}/plan/${plan.id}">← ${esc(plan.title)}</a></nav>
    <div class="practice ${o.notes && plan.outline ? 'with-notes' : ''}" data-practice="${plan.id}" data-target="${target}">
      <section class="pr-stage s-ready">
        <div class="pr-head"><span class="pill ${plan.side}">${PLAN_SIDES[plan.side] || plan.side}</span><span class="pr-bill">${esc(plan.bill_title || plan.title)}</span></div>
        <div class="seg pr-targets">${TARGETS.map(([t, l]) => `<button class="${t === target ? 'on' : ''}" data-tact="prac-target" data-t="${t}">${l}</button>`).join('')}</div>
        <div class="pr-clock" data-clock>${fmtT(target)}</div>
        <div class="pr-signal" data-signal>Ready when you are</div>
        <div class="pr-bar"><span data-bar></span>${[60, 30].map((x) => `<i style="left:${(1 - x / target) * 100}%"></i>`).join('')}</div>
        <div class="pr-controls">
          <button class="primary pr-go" data-tact="prac-go">Start</button>
          <button class="pr-finish" data-tact="prac-finish" hidden>Finish</button>
          <button class="ghost pr-reset" data-tact="prac-reset" hidden>Start over</button>
        </div>
        <div class="pr-opts">
          ${plan.outline ? `<label class="switch-row small"><input type="checkbox" data-prac-opt="notes" ${o.notes ? 'checked' : ''}> Show my outline</label>` : ''}
          ${canRecord ? `<label class="switch-row small"><input type="checkbox" data-prac-opt="record" ${o.record ? 'checked' : ''}> Record audio</label>` : ''}
          <label class="switch-row small"><input type="checkbox" data-prac-opt="sound" ${o.sound ? 'checked' : ''}> Beep at signals</label>
        </div>
        <p class="small muted pr-hint"><span class="kbd-only">Space starts and pauses. </span>Signals at 1:00, 0:30 and 0:10 left, then ${GRACE} seconds of grace.</p>
      </section>
      ${plan.outline ? `<aside class="pr-notes"><h3>Outline</h3><div class="pr-outline">${esc(plan.outline)}</div></aside>` : ''}
    </div>
    <section class="card pr-review" hidden>
      <h2>How did that go?</h2>
      <div class="pr-result" data-result></div>
      <div data-playback></div>
      <form class="stack" data-tform="save-run" data-plan="${plan.id}">
        <input type="hidden" name="seconds"><input type="hidden" name="target"><input type="hidden" name="rating" value="0">
        <div class="field"><label>Rate it</label><div class="rate">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-tact="prac-rate" data-n="${i}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`).join('')}</div></div>
        <div class="field"><label>What to fix next time</label><textarea name="notes" rows="2" placeholder="Slow down in the intro, cite the GAO stat by name…"></textarea></div>
        <div class="row"><button class="primary">Save run</button><button type="button" class="ghost" data-tact="prac-reset">Discard and go again</button></div>
      </form>
    </section>
    <section class="card"><div class="spread"><h2>Practice log</h2>${runStats(runs)}</div>${runsLog(runs, plan.id, true)}</section>`;
}
function pracEls() { const root = document.querySelector('[data-practice]'); return root && { root, stage: root.querySelector('.pr-stage'), clock: root.querySelector('[data-clock]'), signal: root.querySelector('[data-signal]'), bar: root.querySelector('[data-bar]'), go: root.querySelector('.pr-go'), fin: root.querySelector('.pr-finish'), reset: root.querySelector('.pr-reset') }; }
function pracElapsed() { return prac ? prac.acc + (prac.startedAt ? (performance.now() - prac.startedAt) / 1000 : 0) : 0; }
function beep(freq = 880, ms = 160) {
  try { const ctx = prac.audio || (prac.audio = new AudioContext()); const osc = ctx.createOscillator(), g = ctx.createGain(); osc.frequency.value = freq; g.gain.value = 0.15; osc.connect(g).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + ms / 1000); } catch { /* no sound */ }
}
function pracTick() {
  const e = pracEls();
  if (!e || !prac) { pracStop(true); return; }
  const t = prac.target, el = pracElapsed(), left = t - el;
  const stage = !prac.startedAt && !prac.acc ? 'ready' : left > 60 ? 'go' : left > 30 ? 'min' : left > 0 ? 'half' : left > -GRACE ? 'grace' : 'over';
  e.clock.textContent = fmtT(left > 0 ? Math.ceil(left) : Math.floor(left));
  e.bar.style.width = `${Math.min(100, (el / t) * 100)}%`;
  const label = { ready: 'Ready when you are', go: 'Speaking', min: '1 minute left', half: left <= 10 ? '10 seconds' : '30 seconds left', grace: 'Time. Finish your sentence', over: 'Over time' }[stage];
  e.signal.textContent = prac.startedAt ? label : (stage === 'ready' ? label : 'Paused');
  e.stage.className = `pr-stage s-${stage}${prac.startedAt ? ' running' : ''}`;
  const mark = stage === 'half' && left <= 10 ? 'ten' : stage;
  if (prac.startedAt && mark !== prac.lastMark) {
    if (['min', 'half', 'ten', 'grace', 'over'].includes(mark)) { if (prac.sound) beep(mark === 'over' || mark === 'grace' ? 440 : 880, mark === 'grace' ? 500 : 160); try { navigator.vibrate?.(mark === 'grace' ? [200, 100, 200] : 120); } catch { /* fine */ } }
    prac.lastMark = mark;
  }
}
async function pracStart() {
  const e = pracEls(); if (!e) return;
  const o = pracOpts();
  if (!prac) {
    prac = { target: Number(e.root.dataset.target), acc: 0, startedAt: 0, lastMark: 'ready', sound: o.sound, chunks: [] };
    if (o.record && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
      try {
        prac.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        prac.rec = new MediaRecorder(prac.stream);
        const chunks = prac.chunks;
        prac.rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        prac.rec.start(1000);
      } catch { toast('Could not use the microphone. Practicing without a recording.', true); }
    }
    try { prac.wake = await navigator.wakeLock?.request('screen'); } catch { /* screen may sleep */ }
    prac.timer = setInterval(pracTick, 200);
  } else if (prac.rec?.state === 'paused') prac.rec.resume();
  prac.startedAt = performance.now();
  e.go.textContent = 'Pause'; e.go.classList.remove('primary'); e.fin.hidden = false; e.reset.hidden = false;
  pracTick();
}
function pracPause() {
  const e = pracEls(); if (!prac || !e) return;
  prac.acc = pracElapsed(); prac.startedAt = 0;
  if (prac.rec?.state === 'recording') prac.rec.pause();
  e.go.textContent = 'Resume'; e.go.classList.add('primary');
  pracTick();
}
function pracStop(silent) {
  if (!prac) return null;
  clearInterval(prac.timer);
  const sec = Math.round(pracElapsed()), p = prac;
  try { p.wake?.release(); } catch { /* fine */ }
  const done = new Promise((res) => {
    if (p.rec && p.rec.state !== 'inactive') { p.rec.onstop = () => res(p.chunks.length ? new Blob(p.chunks, { type: p.rec.mimeType || 'audio/webm' }) : null); p.rec.stop(); } else res(p.chunks.length ? new Blob(p.chunks) : null);
  }).finally(() => p.stream?.getTracks().forEach((t) => t.stop()));
  prac = null;
  if (silent) return null;
  return { sec, target: p.target, recording: done };
}
async function pracFinish() {
  const r = pracStop(); if (!r) return;
  const e = pracEls(); const review = document.querySelector('.pr-review');
  if (r.sec < 1) { pracReset(); return; }
  e.go.textContent = 'Start'; e.go.classList.add('primary'); e.go.hidden = true; e.fin.hidden = true; e.reset.hidden = false;
  e.signal.textContent = 'Done';
  const [k, l] = runVerdict(r.sec, r.target);
  review.hidden = false;
  review.querySelector('[data-result]').innerHTML = `<span class="pr-big v-${k}">${fmtT(r.sec)}</span><span><strong>${l}</strong><br><span class="small muted">Target ${fmtT(r.target)}</span></span>`;
  const f = review.querySelector('form'); f.seconds.value = r.sec; f.target.value = r.target;
  review.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const blob = await r.recording;
  if (blob) {
    if (ui.pracUrl) URL.revokeObjectURL(ui.pracUrl);
    ui.pracUrl = URL.createObjectURL(blob);
    const ext = /mp4|aac/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    review.querySelector('[data-playback]').innerHTML = `<div class="pr-play"><audio controls src="${ui.pracUrl}"></audio><a class="btn sm ghost" href="${ui.pracUrl}" download="practice-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}">Download</a></div>
      <p class="small muted">The recording stays on this device and is gone when you leave this page. Download it to keep it.</p>`;
  }
}
function pracReset() {
  pracStop(true);
  const e = pracEls(); if (!e) return;
  e.go.hidden = false; e.go.textContent = 'Start'; e.go.classList.add('primary'); e.fin.hidden = true; e.reset.hidden = true;
  e.clock.textContent = fmtT(Number(e.root.dataset.target)); e.bar.style.width = '0'; e.signal.textContent = 'Ready when you are'; e.stage.className = 'pr-stage s-ready';
  const review = document.querySelector('.pr-review'); if (review) { review.hidden = true; review.querySelector('form').reset(); review.querySelector('[data-playback]').innerHTML = ''; review.querySelectorAll('.rate button').forEach((x) => x.classList.remove('on')); }
}
window.addEventListener('hashchange', () => { if (prac) pracStop(true); });
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !document.querySelector('[data-practice]') || e.target.closest('input, textarea, select, button, [contenteditable]')) return;
  const review = document.querySelector('.pr-review'); if (review && !review.hidden) return;
  e.preventDefault();
  if (prac?.startedAt) pracPause(); else pracStart();
});
document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-ai-show]')) { try { await api('PUT', '/api/me/ai', { hide: !e.target.checked }); reTeam(); } catch (err) { toast(err.message, true); } return; }
  if (e.target.matches('[data-ai-file]')) {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 200000) { toast('That file is too big for a reply.', true); return; }
    document.querySelector('[data-ai-text]').value = await f.text();
    document.querySelector('[data-tact=ai-read]')?.click(); return;
  }
  const opt = e.target.closest('[data-prac-opt]'); if (!opt) return;
  const o = pracOpts(); o[opt.dataset.pracOpt] = opt.checked; savePracOpts(o);
  if (opt.dataset.pracOpt === 'notes') document.querySelector('.practice')?.classList.toggle('with-notes', opt.checked);
  if (opt.dataset.pracOpt === 'sound' && prac) prac.sound = opt.checked;
});

// ---------- progress ----------
async function viewProgress(uid) {
  const me2 = teamCtx.data.me;
  const p = await api('GET', T(`/progress${uid ? `?user=${uid}` : ''}`));
  const self = !uid || uid === me2.id;
  const sm = p.summary;
  let roster = '';
  if (me2.isLeader && self) {
    const r = await api('GET', T('/roster-progress'));
    roster = `<div class="card"><h2>Team overview</h2><div class="table-wrap"><table><tr><th>Name</th><th>Speeches (app)</th><th>Aff / Neg / Auth</th><th>Logged results</th><th>Avg judge score</th><th>Plans ready</th><th>Open goals</th></tr>
      ${r.members.map((m) => `<tr><td><a href="#/team/${teamCtx.id}/progress/${m.id}">${esc(m.name)}</a> <span class="small muted">${ROLE_LABEL[m.role]}</span></td><td>${m.app_speeches}</td>
        <td>${m.sides.aff} / ${m.sides.neg} / ${m.sides.authorship + m.sides.sponsorship}</td><td>${m.logged_entries}</td><td>${m.avg_score_pct == null ? '—' : m.avg_score_pct + '%'}</td>
        <td>${m.plans.ready || 0}</td><td>${m.goals_open}</td></tr>`).join('')}</table></div>
      <p class="small muted">Judge scores count only when a judge or admin published them to the competitor, shown as a percent of each tournament's range.</p></div>`;
  }
  return `
    ${!self ? `<a href="#/team/${teamCtx.id}/progress">← Team overview</a><h2>${esc(p.user.display_name)}</h2>` : ''}
    ${roster}
    <div class="stats">
      <div class="card stat"><div class="n">${sm.app_speeches + sm.logged_entries}</div><div class="small muted">speeches and results</div></div>
      <div class="card stat"><div class="n">${sm.sides.aff}<span class="muted">/</span>${sm.sides.neg}</div><div class="small muted">aff / neg in the app</div></div>
      <div class="card stat"><div class="n">${sm.avg_score_pct == null ? '—' : sm.avg_score_pct + '%'}</div><div class="small muted">avg published judge score</div></div>
      <div class="card stat"><div class="n">${sm.goals_open}</div><div class="small muted">open goals</div></div>
    </div>
    <div class="grid two">
      <div>
        <div class="card"><h2>Goals</h2>
          ${p.goals.length ? `<ul class="list">${p.goals.map((g) => `<li class="spread"><label class="row" style="color:var(--ink);margin:0"><input type="checkbox" data-goal="${g.id}" ${g.done ? 'checked' : ''} style="width:auto;min-height:0"> <span class="${g.done ? 'muted strike' : ''}">${esc(g.text)}</span></label>
            <span class="small muted">${esc(g.created_by_name || '')}${me2.isLeader ? ` <button class="sm ghost" data-tact="delete-goal" data-id="${g.id}">✕</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">No goals yet.</p>'}
          ${me2.isLeader ? `<form class="row" data-tform="new-goal" data-user="${p.user.id}" style="margin-top:8px"><input name="text" placeholder="Set a goal, e.g. Cite two sources per speech" style="flex:1;min-width:180px" required><button class="sm">Add goal</button></form>` : ''}
        </div>
        ${p.feedback.length ? `<div class="card"><h2>Published judge feedback</h2><ul class="list">${p.feedback.map((f) => { const s = p.speeches.find((x) => x.id === f.speech_id); return `<li><div class="spread"><span>${s ? `<span class="pill ${s.side}">${SIDE_LABEL[s.side]}</span> ${esc(s.bill)}` : ''}</span><strong>${f.points}/${f.score_max}</strong></div>
          ${f.comment ? `<div class="small">${esc(f.comment)}</div>` : ''}<div class="small muted">${esc(f.judge)}${s ? ` · ${esc(s.chamber)}` : ''}</div></li>`; }).join('')}</ul></div>` : ''}
        ${p.shared_plans?.length ? `<div class="card"><h2>Shared speech plans</h2><ul class="list">${p.shared_plans.map((x) => `<li><a href="#/team/${teamCtx.id}/plan/${x.id}">${esc(x.title)}</a> <span class="pill ${x.side}">${PLAN_SIDES[x.side] || x.side}</span> <span class="pill plan-${x.status}">${STATUS_LABEL_PLAN[x.status]}</span></li>`).join('')}</ul></div>` : ''}
      </div>
      <div>
        <div class="card"><h2>Results log</h2>
          ${self ? `<form data-tform="new-entry" class="stack"><div class="inline-fields"><input name="date" type="date"><input name="tournament" placeholder="Tournament"></div>
            <div class="inline-fields"><input name="bill" placeholder="Bill"><select name="side"><option value="">Side</option><option value="authorship">Authorship</option><option value="aff">Aff</option><option value="neg">Neg</option><option value="po">Presiding</option></select></div>
            <div class="inline-fields"><input name="points" placeholder="Points, e.g. 5, 6"><input name="result" placeholder="Result, e.g. Finalist, 3rd"></div>
            <textarea name="notes" rows="2" placeholder="What went well, what to work on"></textarea><button class="sm primary">Log it</button></form>` : ''}
          ${p.entries.length ? `<ul class="list" style="margin-top:8px">${p.entries.map((e) => `<li><div class="spread"><strong>${esc(e.tournament || 'Practice')}</strong><span class="small muted">${esc(e.date)}${self ? ` <button class="sm ghost" data-tact="delete-entry" data-id="${e.id}">✕</button>` : ''}</span></div>
            <div class="small">${[e.bill, e.side && (PLAN_SIDES[e.side] || (e.side === 'po' ? 'Presiding' : e.side)), e.points && `points ${e.points}`, e.result].filter(Boolean).map(esc).join(' · ')}</div>${e.notes ? `<div class="small muted">${esc(e.notes)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nothing logged yet. Use this for tournaments that don\'t use this app.</p>'}
        </div>
        <div class="card"><h2>Speeches in this app (${p.speeches.length})</h2>
          ${p.speeches.length ? `<ul class="list">${p.speeches.slice(0, 30).map((s) => `<li><span class="pill ${s.side}">${SIDE_LABEL[s.side]}</span> ${esc(s.bill)} <div class="small muted">${esc(s.chamber)} · ${fmtDate(s.recognized_at)}</div></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
        </div>
      </div>
    </div>`;
}

// ---------- members ----------
async function viewMembers() {
  const { team, me: m, members } = teamCtx.data;
  const pending = members.filter((x) => x.status === 'pending');
  const active = members.filter((x) => x.status === 'active');
  const link = team.join_code ? `${location.origin}/#/signup/${team.join_code}` : '';
  return `<div class="grid side">
    <div>
      ${m.isLeader && pending.length ? `<div class="card"><h2>Waiting for approval (${pending.length})</h2><ul class="list">${pending.map((x) => `<li class="spread"><span><strong>${esc(x.name)}</strong> <span class="small muted">${esc(x.school)} · asked ${fmtDate(x.joined_at)}</span></span>
        <span class="row"><button class="sm primary" data-tact="member" data-a="approve" data-id="${x.id}">Approve</button><button class="sm" data-tact="member" data-a="remove" data-id="${x.id}" data-name="${esc(x.name)}">Decline</button></span></li>`).join('')}</ul></div>` : ''}
      <div class="card"><h2>Team (${active.length})</h2><ul class="list">${active.map((x) => `<li class="spread"><span><strong>${esc(x.name)}</strong> <span class="small muted">${esc(x.school)}</span></span>
        <span class="row">${m.isCoach ? `<select data-role-for="${x.id}" style="width:auto">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `<span class="pill">${ROLE_LABEL[x.role]}</span>`}
        ${m.isLeader && x.id !== m.id && (m.isCoach || x.role !== 'coach') ? `<button class="sm ghost" data-tact="member" data-a="remove" data-id="${x.id}" data-name="${esc(x.name)}">Remove</button>` : ''}</span></li>`).join('')}</ul></div>
    </div>
    <div>
      ${m.isLeader ? `<div class="card"><h2>Invite people</h2>
        <p>Join code: <span class="code">${esc(team.join_code)}</span></p>
        <p class="small">Or share this link: <a href="${esc(link)}">${esc(link)}</a></p>
        <div class="row"><button class="sm" data-tact="copy-link" data-link="${esc(link)}">Copy link</button><button class="sm" data-tact="new-code">Make a new code</button></div>
        <p class="small muted">New people create their own account with the code, then wait for a coach or captain to approve them. Making a new code stops the old one from working.</p></div>` : ''}
      ${m.isCoach ? `<form class="card stack" data-tform="team-settings"><h2>Team settings</h2><input name="name" value="${esc(team.name)}"><input name="school" value="${esc(team.school)}" placeholder="School">
        <label class="switch-row"><input type="checkbox" name="ai_aids" ${team.ai_aids ? 'checked' : ''}> Allow AI Learning Aids</label>
        <p class="small muted" style="margin:0">Members can download a prep kit for their own AI assistant and upload its reply, tagged as an AI Learning Aid. Turning this off hides those items and stops new uploads. Nothing is deleted.</p>
        <div class="row"><button class="sm primary">Save</button><button type="button" class="sm ghost" data-tact="delete-team">Delete team</button></div></form>` : ''}
      <div class="card"><button class="sm ghost" data-tact="leave">Leave this team</button></div>
    </div>
  </div>`;
}

// ---------- events ----------
const tdata = (f) => Object.fromEntries(new FormData(f).entries());
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-tform]');
  if (!f) return;
  e.preventDefault();
  const d = tdata(f);
  try {
    switch (f.dataset.tform) {
      case 'signup': { const r = await api('POST', '/api/signup', d); me = null; toast(`Welcome! Your username is ${r.username}.`); go('#/teams'); break; }
      case 'join': { const r = await api('POST', '/api/teams/join', d); toast(r.already ? 'You already asked to join this team.' : 'Request sent. A coach or captain will approve you.'); renderTeams(); break; }
      case 'new-team': { const r = await api('POST', '/api/teams', d); go(`#/team/${r.id}/members`); break; }
      case 'new-bill': { const r = await api('POST', T('/bills'), d); go(`#/team/${teamCtx.id}/bill/${r.id}`); break; }
      case 'edit-bill': await api('PUT', T(`/bills/${f.dataset.id}`), d); toast('Saved'); reTeam(); break;
      case 'new-item': savedToast(await api('POST', T(`/bills/${f.dataset.bill}/items`), { ...d, section: f.dataset.section }), 'Added'); reTeam(); break;
      case 'save-run': { const r = await api('POST', T(`/plans/${f.dataset.plan}/runs`), { seconds: Number(d.seconds), target: Number(d.target), rating: Number(d.rating), notes: d.notes }); savedToast(r, 'Practice run saved'); reTeam(); break; }
      case 'edit-item': { const r = await api('PUT', T(`/bills/${f.dataset.bill}/items/${f.dataset.id}`), { ...d, section: f.dataset.section }); if (r?.conflict) toast('A teammate changed this while you were away. Your version was saved as a copy next to theirs.', true); else savedToast(r, 'Saved'); reTeam(); break; }
      case 'new-plan': { const r = await api('POST', T('/plans'), d); go(`#/team/${teamCtx.id}/plan/${r.id}`); break; }
      case 'save-plan': savedToast(await api('PUT', T(`/plans/${f.dataset.id}`), { ...d, shared_with_leaders: !!f.querySelector('[name=shared_with_leaders]')?.checked }), 'Saved'); reTeam(); break;
      case 'new-note': { const r = await api('POST', T('/notes'), d); go(`#/team/${teamCtx.id}/note/${r.id}`); break; }
      case 'save-note': savedToast(await api('PUT', T(`/notes/${f.dataset.id}`), d), 'Saved'); break;
      case 'new-entry': await api('POST', T('/progress'), d); toast('Logged'); reTeam(); break;
      case 'new-goal': await api('POST', T('/goals'), { ...d, user_id: Number(f.dataset.user) }); toast('Goal added'); reTeam(); break;
      case 'new-link': await api('POST', T('/links'), { ...d, bill_id: f.dataset.bill ? Number(f.dataset.bill) : undefined, plan_id: f.dataset.plan ? Number(f.dataset.plan) : undefined }); toast('Link added'); reTeam(); break;
      case 'team-settings': await api('PUT', T(''), { ...d, ai_aids: !!f.querySelector('[name=ai_aids]')?.checked }); toast('Saved'); reTeam(); break;
      case 'import': {
        const ids = [...f.querySelectorAll('input[name=leg]:checked')].map((x) => Number(x.value));
        if (!ids.length) return;
        const r = await api('POST', T('/bills/import'), { legislation_ids: ids });
        toast(r.added ? `Imported ${r.added}` : 'Those are already in your library.'); reTeam(); break;
      }
    }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.dataset.billSel) {
      const id = Number(el.dataset.billSel), sel = new Set(ui.billSel || []);
      if (el.checked) sel.add(id); else sel.delete(id);
      ui.billSel = [...sel]; redrawBills(); return;
    }
    if (el.matches('[data-bill-all]')) {
      ui.billSel = el.checked ? [...document.querySelectorAll('[data-bill-sel]')].map((x) => Number(x.dataset.billSel)) : [];
      redrawBills(); return;
    }
    if (el.matches('[data-bill-tourn]')) { ui.billTourn = el.value; ui.billSel = []; redrawBills(); return; }
    if (el.dataset.keepOffline) {
      const id = Number(el.dataset.keepOffline);
      if (el.checked) {
        try { localStorage.setItem(keepKey(id), JSON.stringify({ at: 0 })); } catch { /* storage blocked */ }
        toast('Saving this team on this device…');
        const n = await saveTeamOffline(id);
        if (n) toast('Saved. Research, your speech plans and notes open without Wi-Fi now.');
      } else { try { localStorage.removeItem(keepKey(id)); } catch { /* storage blocked */ } toast('This team is no longer kept up to date on this device.'); }
      return;
    }
    if (el.dataset.roleFor) { await api('POST', T(`/members/${el.dataset.roleFor}`), { action: 'role', role: el.value }); toast('Role updated'); reTeam(); }
    else if (el.dataset.goal) { await api('PUT', T(`/goals/${el.dataset.goal}`), { done: el.checked }); reTeam(); }
  } catch (err) { toast(err.message, true); reTeam(); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tact]');
  if (!b) return;
  const d = b.dataset;
  try {
    switch (d.tact) {
      case 'load-docket': {
        const { items } = await api('GET', T('/docket-options'));
        b.closest('[data-docket-options]').innerHTML = items.length
          ? `<form data-tform="import" class="stack"><div class="stack" style="max-height:260px;overflow:auto">${items.map((i) => `<label class="row" style="color:var(--ink)"><input type="checkbox" name="leg" value="${i.id}" style="width:auto;min-height:0"> ${esc(i.title)} <span class="small muted">${esc(i.chamber)}</span></label>`).join('')}</div><button class="sm primary">Import selected</button></form>`
          : '<p class="muted small">No docket items in chambers you belong to yet.</p>';
        break;
      }
      case 'ai-kit-dl': case 'ai-kit-copy': {
        const { bill, items } = ui.billData; const md = aiKit(bill, items);
        if (d.tact === 'ai-kit-copy') { try { await navigator.clipboard.writeText(md); toast('Prep kit copied. Paste it into your AI assistant.'); } catch { toast('Could not copy. Use Download instead.', true); } break; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
        a.download = `${bill.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-ai-kit.md`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000); break;
      }
      case 'ai-upload': { const box = document.querySelector('.ai-upload'); box.hidden = !box.hidden; if (!box.hidden) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); break; }
      case 'ai-cancel': aiPreview = null; reTeam(); break;
      case 'ai-read': {
        const text = document.querySelector('[data-ai-text]').value;
        const data = await api('POST', T(`/bills/${d.id}/ai/read`), { text });
        aiPreview = { bid: Number(d.id), data }; document.querySelector('.ai-upload').innerHTML = aiPreviewHtml(); break;
      }
      case 'ai-import': {
        const p = aiPreview.data, box = document.querySelector('.ai-preview');
        const picked = [...box.querySelectorAll('[data-aip]:checked')].map((x) => x.dataset.aip);
        const items = picked.filter((k) => k !== 'summary').map((n) => { const { flags, ...it } = p.items[Number(n)]; return it; });
        const r = await api('POST', T(`/bills/${aiPreview.bid}/ai/import`), { items, ...(picked.includes('summary') ? { summary: p.summary } : {}) });
        aiPreview = null; toast(`Added ${r.added} AI Learning Aid${r.added === 1 ? '' : 's'}${picked.includes('summary') ? ' and the summary' : ''}`); reTeam(); break;
      }
      case 'ai-sum-del': if (confirm('Remove the AI summary from this bill?')) { await api('DELETE', T(`/bills/${d.id}/ai/summary`)); reTeam(); } break;
      case 'ai-hide': await api('PUT', '/api/me/ai', { hide: d.hide === '1' }); toast(d.hide === '1' ? 'AI Learning Aids hidden. Turn them back on at the top of the team page.' : 'Showing AI Learning Aids'); reTeam(); break;
      case 'plan-practice': {
        const f = document.querySelector('[data-tform=save-plan]');
        if (f && !f.querySelector('[name=title]').disabled) { const fd = Object.fromEntries(new FormData(f)); await api('PUT', T(`/plans/${d.id}`), { ...fd, shared_with_leaders: !!f.querySelector('[name=shared_with_leaders]')?.checked }); }
        go(`#/team/${teamCtx.id}/practice/${d.id}`); break;
      }
      case 'prac-go': if (prac?.startedAt) pracPause(); else await pracStart(); break;
      case 'prac-finish': await pracFinish(); break;
      case 'prac-reset': pracReset(); break;
      case 'prac-target': if (prac) break; ui.pracTarget = Number(d.t); { const r = document.querySelector('[data-practice]'); r.dataset.target = d.t; r.querySelector('[data-clock]').textContent = fmtT(Number(d.t)); r.querySelectorAll('.pr-targets button').forEach((x) => x.classList.toggle('on', x === b)); r.querySelectorAll('.pr-bar i').forEach((x, i) => { x.style.left = `${(1 - [60, 30][i] / Number(d.t)) * 100}%`; }); } break;
      case 'prac-rate': { const f = b.closest('form'); f.rating.value = d.n; f.querySelectorAll('.rate button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= Number(d.n))); break; }
      case 'run-del': if (confirm('Delete this practice run?')) { await api('DELETE', T(`/plans/${d.plan}/runs/${d.id}`)); reTeam(); } break;
      case 'sec-add': { const sec = b.closest('.rs'); const box = sec.querySelector('.rs-add'); box.hidden = !box.hidden; sec.classList.toggle('adding', !box.hidden); if (!box.hidden) box.querySelector('textarea').focus(); break; }
      case 'item-edit': { const li = b.closest('.ri'); li.classList.toggle('editing'); if (li.classList.contains('editing')) li.querySelector('.ri-edit textarea').focus(); break; }
      case 'bill-edit': { const f = document.querySelector('.bh-edit'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); break; }
      case 'ev-side': ui.evSide = d.side; reTeam(); break;
      case 'add-bills': ui.addBills = !document.querySelector('.add-bills'); if (!ui.addBills && packetState?.target === 'team') packetState = null; reTeam(); break;
      case 'bill-filter': ui.billFilter = d.f; ui.billSel = []; redrawBills(); break;
      case 'bill-bulk': {
        const ids = ui.billSel || [];
        if (!ids.length) break;
        if (d.a === 'delete' && !confirm(`Delete ${ids.length} bill${ids.length === 1 ? '' : 's'} and all of their research for the whole team? This cannot be undone. Archive keeps them instead.`)) break;
        await api('POST', T('/bills/bulk'), { ids, action: d.a });
        toast({ current: 'Marked current', clear: 'No longer current', archive: 'Archived', restore: 'Restored', delete: 'Deleted' }[d.a] + ` (${ids.length})`);
        ui.billSel = []; reTeam(); break;
      }
      case 'bill-del': if (confirm(`Delete "${d.title}" and all of its research for the whole team? Archive keeps it instead.`)) { await api('POST', T('/bills/bulk'), { ids: [Number(d.id)], action: 'delete' }); toast('Deleted'); reTeam(); } break;
      case 'bill-status': await api('POST', T('/bills/bulk'), { ids: [Number(d.id)], action: d.a }); toast({ current: 'Marked current', clear: 'No longer current', archive: 'Archived', restore: 'Restored' }[d.a]); reTeam(); break;
      case 'autofill': {
        const f = b.closest('form'), msg = f.querySelector('[data-cite-msg]'), url = f.cite_url.value.trim();
        if (!url) { msg.textContent = 'Paste a link first.'; f.cite_url.focus(); break; }
        b.disabled = true; msg.textContent = 'Reading the page…';
        try {
          const r = await api('GET', T(`/cite?url=${encodeURIComponent(url)}`));
          f.cite_url.value = r.url || url;
          for (const k of ['author', 'title', 'source', 'date']) if (r[k] && !f[`cite_${k}`].value.trim()) f[`cite_${k}`].value = r[k];
          const got = ['author', 'title', 'source', 'date'].filter((k) => r[k]);
          msg.textContent = r.note || (got.length ? `Filled in ${got.join(', ')}. Check it, then save.` : 'That page has no citation details. Fill them in by hand.');
        } catch (err) { msg.textContent = err.message; }
        finally { b.disabled = false; }
        break;
      }
      case 'copy-cite': try { await navigator.clipboard.writeText(d.text); toast('Citation copied'); } catch { toast('Could not copy. Select the text instead.', true); } break;
      case 'delete-link': if (confirm('Remove this link? The doc itself is not touched.')) { await api('DELETE', T(`/links/${d.id}`)); reTeam(); } break;
      case 'delete-item': if (confirm('Delete this for the whole team?')) { await api('DELETE', T(`/bills/${d.bill}/items/${d.id}`)); reTeam(); } break;
      case 'delete-bill': if (confirm('Delete this bill and all of its research for the whole team?')) { await api('DELETE', T(`/bills/${d.id}`)); go(`#/team/${teamCtx.id}/research`); } break;
      case 'plan-from-bill': { const r = await api('POST', T('/plans'), { title: `${PLAN_SIDES[d.side]}: ${d.title}`.slice(0, 200), bill_id: Number(d.bill), side: d.side }); go(`#/team/${teamCtx.id}/plan/${r.id}`); break; }
      case 'note-from-bill': { const r = await api('POST', T('/notes'), { title: `Notes: ${d.title}`.slice(0, 200), bill_id: Number(d.bill) }); go(`#/team/${teamCtx.id}/note/${r.id}`); break; }
      case 'insert': {
        const ta = document.querySelector('[data-outline]');
        const add = `• ${d.text}`;
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, pos) + (pos && ta.value[pos - 1] !== '\n' ? '\n' : '') + add + '\n' + ta.value.slice(pos);
        ta.focus();
        const saved = document.querySelector('[data-saved]'); if (saved) saved.textContent = 'Not saved yet';
        break;
      }
      case 'delete-plan': if (confirm('Delete this speech plan?')) { await api('DELETE', T(`/plans/${d.id}`)); go(`#/team/${teamCtx.id}/prep`); } break;
      case 'delete-note': if (confirm('Delete this note?')) { await api('DELETE', T(`/notes/${d.id}`)); go(`#/team/${teamCtx.id}/prep`); } break;
      case 'delete-entry': if (confirm('Delete this entry?')) { await api('DELETE', T(`/progress/${d.id}`)); reTeam(); } break;
      case 'delete-goal': await api('DELETE', T(`/goals/${d.id}`)); reTeam(); break;
      case 'member':
        if (d.a === 'remove' && !confirm(`Remove ${d.name} from the team?`)) break;
        await api('POST', T(`/members/${d.id}`), { action: d.a }); toast(d.a === 'approve' ? 'Approved' : 'Removed'); reTeam(); break;
      case 'copy-link': try { await navigator.clipboard.writeText(d.link); toast('Link copied'); } catch { toast('Copy the link from the page.'); } break;
      case 'new-code': if (confirm('Make a new join code? The old code and link stop working.')) { await api('POST', T('/code')); reTeam(); } break;
      case 'delete-team': if (confirm('Delete this team and all of its research, plans and notes? This cannot be undone.')) { await api('DELETE', T('')); go('#/teams'); } break;
      case 'leave': if (confirm('Leave this team?')) { await api('POST', T('/leave')); go('#/teams'); } break;
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- tournament packets: read a docket PDF/Word file or Tabroom link, pick bills, import ----------
// target: 'team' (team research) or 'chamber' (a chamber's docket).
function packetCard(target) {
  const team = target === 'team';
  // Keep a preview in progress when the page re-renders around it.
  if (packetState?.target === target) setTimeout(() => { const box = document.querySelector(`[data-packet="${target}"]`); if (box) renderPacket(box); }, 0);
  return `<div class="card stack packet" data-packet="${target}">
    <h2>${team ? 'Import a tournament packet' : 'Import from a tournament packet'}</h2>
    <p class="small muted" style="margin:0">Paste the tournament's Tabroom page or a link to its legislation packet, or upload the PDF or Word file. You can check every bill before anything is added.</p>
    <div class="row packet-src"><input data-pk-url placeholder="tabroom.com/… or a link to the packet" inputmode="url"><button class="sm primary" data-pk="read-url">Read</button></div>
    <div class="row packet-src"><input type="file" data-pk-file accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"><button class="sm" data-pk="read-file">Read file</button></div>
    <div data-pk-out></div>
  </div>`;
}
let packetState = null;
function packetBox(el) { return el.closest('[data-packet]'); }
function renderPacket(box) {
  const out = box.querySelector('[data-pk-out]'), st = packetState;
  if (!st) { out.innerHTML = ''; return; }
  if (st.busy) { out.innerHTML = `<p class="small muted">${esc(st.busy)}</p>`; return; }
  if (st.files) {
    out.innerHTML = `<p class="small"><strong>That page has ${st.files.length} files.</strong> Pick the legislation packet:</p>
      <ul class="list">${st.files.map((f, i) => `<li class="spread"><span class="small">${esc(f.name)}</span><button class="sm" data-pk="pick-file" data-i="${i}">Read this</button></li>`).join('')}</ul>`;
    return;
  }
  const team = box.dataset.packet === 'team';
  const picked = st.items.filter((x) => x.on).length;
  const withText = st.items.filter((x) => x.text).length;
  let lastSession = null;
  out.innerHTML = `
    <p class="small" style="margin:0"><strong>Found ${st.items.length} item${st.items.length === 1 ? '' : 's'}</strong>${withText < st.items.length ? `, ${withText} with full text` : ''}. Fix any title that came out wrong, untick what you don't need, then import.</p>
    ${team ? `<div class="field"><label>Tournament</label><input data-pk-tourn value="${esc(st.tournament || '')}" placeholder="e.g. Tri-Cities Invitational 2026"></div>` : ''}
    <div class="row small"><button class="linkish" data-pk="all" data-on="1">Select all</button><button class="linkish" data-pk="all" data-on="0">Select none</button></div>
    <ul class="list packet-list">${st.items.map((x, i) => {
      const head = x.session && x.session !== lastSession ? `<li class="packet-session">${esc(x.session)}</li>` : '';
      lastSession = x.session || lastSession;
      return `${head}<li class="packet-item${x.on ? '' : ' off'}">
        <label class="row" style="align-items:flex-start;color:var(--ink)"><input type="checkbox" data-pk-on="${i}" ${x.on ? 'checked' : ''} style="width:auto;min-height:0;margin-top:12px">
          <span class="stack" style="flex:1;min-width:0;gap:4px">
            <input data-pk-title="${i}" value="${esc(x.title)}">
            <span class="row small"><select data-pk-kind="${i}" style="width:auto;min-height:32px;padding:3px 8px">${['bill', 'resolution'].map((k) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${k === 'bill' ? 'Bill' : 'Resolution'}</option>`).join('')}</select>
              ${x.author ? `<span class="muted">${esc(x.author)}</span>` : ''}
              ${x.text ? `<details><summary class="small">Full text</summary><pre class="legtext">${esc(x.text)}</pre></details>` : '<span class="pill warn" title="The packet lists this title but its text was not found. You can paste it in later.">Title only</span>'}</span>
          </span></label></li>`;
    }).join('')}</ul>
    <div class="row"><button class="primary" data-pk="import" ${picked ? '' : 'disabled'}>Import ${picked} ${picked === 1 ? 'item' : 'items'}</button><button class="ghost sm" data-pk="clear">Start over</button></div>`;
}
async function packetRead(box, how, arg) {
  const target = box.dataset.packet;
  packetState = { target, busy: how === 'file' ? 'Reading the file…' : 'Reading the packet… this can take a few seconds.' };
  renderPacket(box);
  try {
    let r;
    if (how === 'file') {
      const res = await fetch(`/api/packet/read?name=${encodeURIComponent(arg.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arg });
      r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `Could not read that file (${res.status}).`);
    } else r = await api('POST', '/api/packet/read', { url: arg });
    const guess = decodeURIComponent((r.source || '').split('/').pop().split('?')[0]).replace(/\.(pdf|docx)$/i, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\b(congress(ional)?|legislation|docket|packet|debate)\b/gi, '').replace(/\s+/g, ' ').trim();
    packetState = r.files ? { target, files: r.files } : { target, items: r.items.map((x) => ({ ...x, on: true })), source: r.source, tournament: guess.length > 3 ? guess : '' };
  } catch (e) {
    packetState = null; renderPacket(box);
    toast(e.message === 'Failed to fetch' ? 'You are offline. Reading a packet needs a connection.' : e.message, true);
    return;
  }
  renderPacket(box);
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pk]');
  if (!b) return;
  const box = packetBox(b), d = b.dataset;
  switch (d.pk) {
    case 'read-url': { const url = box.querySelector('[data-pk-url]').value.trim(); if (!url) { toast('Paste a link first.', true); break; } await packetRead(box, 'url', url); break; }
    case 'read-file': { const f = box.querySelector('[data-pk-file]').files?.[0]; if (!f) { toast('Pick a file first.', true); break; } await packetRead(box, 'file', f); break; }
    case 'pick-file': await packetRead(box, 'url', packetState.files[Number(d.i)].url); break;
    case 'all': packetState.items.forEach((x) => { x.on = d.on === '1'; }); renderPacket(box); break;
    case 'clear': packetState = null; renderPacket(box); break;
    case 'import': {
      const items = packetState.items.filter((x) => x.on);
      b.disabled = true;
      try {
        if (box.dataset.packet === 'team') {
          const r = await api('POST', T('/bills/packet'), { items, tournament: packetState.tournament || '' });
          toast(r.added ? `Imported ${r.added}${r.added < items.length ? ` (${items.length - r.added} were already here)` : ''}` : 'Those are already in your research.');
        } else {
          const r = await api('POST', C('/legislation/packet'), { items });
          toast(r.added ? `Added ${r.added} to the docket` : 'Those are already on the docket.');
        }
        packetState = null;
        if (box.dataset.packet === 'team') { ui.addBills = false; ui.billFilter = 'all'; reTeam(); } else await loadState();
      } catch (err) { toast(err.message, true); b.disabled = false; }
      break;
    }
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!packetState?.items) return;
  if (el.dataset.pkTitle) packetState.items[Number(el.dataset.pkTitle)].title = el.value;
  else if (el.matches('[data-pk-tourn]')) packetState.tournament = el.value;
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!packetState?.items) return;
  if (el.dataset.pkOn) { packetState.items[Number(el.dataset.pkOn)].on = el.checked; renderPacket(packetBox(el)); }
  else if (el.dataset.pkKind) packetState.items[Number(el.dataset.pkKind)].kind = el.value;
});

// Close an open bill-card menu when tapping anywhere else.
document.addEventListener('click', (e) => {
  const j = e.target.closest('[data-jump]');
  if (j) { e.preventDefault(); document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  for (const m of document.querySelectorAll('details.bc-menu[open]')) if (!m.contains(e.target) || e.target.closest('.bc-pop button')) m.open = false;
});
