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
  const tabs = [['research', 'Research'], ['prep', 'My prep'], ['progress', 'Progress'], ['members', data.me.isLeader ? `Members${data.members.some((m) => m.status === 'pending') ? ' •' : ''}` : 'Members']];
  const active = ['bill'].includes(tab) ? 'research' : (['plan', 'note'].includes(tab) ? 'prep' : tab);
  let body;
  try {
    body = await ({
      research: viewResearch, bill: () => viewBill(Number(sub)), prep: viewPrep, plan: () => viewPlan(Number(sub)), note: () => viewNote(Number(sub)),
      progress: () => viewProgress(sub ? Number(sub) : null), members: viewMembers,
    }[tab] || viewResearch)();
  } catch (e) { body = `<div class="card"><p>${esc(e.message)}</p></div>`; }
  document.body.classList.add('wide');
  $view.innerHTML = `
    <a href="#/teams">← Teams</a>
    <div class="spread"><h1>${esc(data.team.name)}</h1><span class="row">${data.team.school ? `<span class="small muted">${esc(data.team.school)}</span>` : ''}<span class="pill">${ROLE_LABEL[data.me.role]}</span></span></div>
    <label class="switch-row small" title="Saves this team's research, your speech plans and notes on this device so they open without Wi-Fi."><input type="checkbox" data-keep-offline="${id}" ${keepOffline(id) ? 'checked' : ''}> Keep available offline <span class="muted" data-keep-label>${keepOffline(id) ? `· ${esc(keptLabel(id))}` : ''}</span></label>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/team/${id}/${k}" class="${k === active ? 'active' : ''}">${l}</a>`).join('')}</nav>
    ${body}`;
  void sub2;
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
    const urls = [...data.bills.map((b) => `${base}/bills/${b.id}`), ...plans.map((p) => `${base}/plans/${p.id}`), `${base}/progress`];
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
async function viewResearch() {
  const { bills, links } = teamCtx.data;
  return `
    <div class="grid side">
      <div class="card"><h2>Bills and resolutions (${bills.length})</h2>
        ${bills.length ? `<ul class="list">${bills.map((b) => `<li><div class="spread"><a href="#/team/${teamCtx.id}/bill/${b.id}"><strong>${esc(b.title)}</strong></a><span class="small muted">updated ${fmtDate(b.updated_at)}</span></div>
          <div class="row small">${b.source ? `<span class="muted">${esc(b.source)}</span>` : ''}
            <span class="pill aff">${b.aff} aff</span><span class="pill neg">${b.neg} neg</span><span class="pill">${b.evidence} evidence</span><span class="pill">${b.questions} questions</span></div></li>`).join('')}</ul>`
          : '<p class="muted">No bills yet. Add one, or import from a tournament docket.</p>'}
      </div>
      <div>
        <form class="card" data-tform="new-bill"><h2>Add a bill</h2>
          <div class="field"><label>Title</label><input name="title" required placeholder="A Bill to…"></div>
          <div class="inline-fields"><div class="field"><label>Type</label><select name="kind"><option value="bill">Bill</option><option value="resolution">Resolution</option></select></div>
          <div class="field"><label>Source</label><input name="source" placeholder="e.g. State Quals docket"></div></div>
          <div class="field"><label>Summary</label><textarea name="summary" rows="3"></textarea></div>
          <button class="primary">Add</button></form>
        ${linksCard(links || [], { title: 'Team docs & folders', hint: 'The team Drive folder, a shared docket doc, a research spreadsheet…' })}
        <div class="card"><h2>Import from a docket</h2><p class="small muted">Copies bills from chambers you're in, so the team can research them.</p>
          <div data-docket-options><button class="sm" data-tact="load-docket">Show docket items</button></div></div>
      </div>
    </div>`;
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
    <div class="row"><button class="sm primary">${item.id ? 'Save' : 'Add'}</button>${item.id ? `<button type="button" class="sm ghost" data-tact="delete-item" data-bill="${billId}" data-id="${item.id}">Delete</button>` : ''}</div>
  </form>`;
}
function itemView(i, billId) {
  const flag = i.pending ? '<span class="pill warn">Waiting to send</span> ' : i.conflict_of ? '<span class="pill failed" title="Saved while offline after a teammate changed the same entry. Keep one and delete the other.">Offline copy</span> ' : '';
  return `<li class="item${i.pending ? ' pending' : i.conflict_of ? ' conflict' : ''}"><div class="spread"><div>${flag}${i.section === 'evidence' && i.side !== 'both' ? `<span class="pill ${i.side}">${i.side}</span> ` : ''}<strong>${esc(i.text)}</strong></div></div>
    ${i.detail ? `<div class="small">${esc(i.detail)}</div>` : ''}
    ${citation(i)}
    <div class="small muted">${esc(i.updated_by_name || i.created_by_name || '')} · ${fmtDate(i.updated_at)}${citationFull(i) ? ` · <button class="linkish" data-tact="copy-cite" data-text="${esc(citationFull(i))}">Copy citation</button>` : ''}</div>
    <details><summary class="small">Edit</summary>${itemForm(i.section, i, billId)}</details></li>`;
}
async function viewBill(bid) {
  const { bill, items, my_plans, my_notes, links } = await api('GET', T(`/bills/${bid}`));
  const evSide = ui.evSide || 'all';
  const section = (k) => {
    let list = items.filter((i) => i.section === k);
    if (k === 'evidence' && evSide !== 'all') list = list.filter((i) => i.side === evSide || i.side === 'both');
    return `<div class="card section-${k}"><div class="spread"><h2>${SECTION_LABEL[k]} <span class="muted small">${list.length}</span></h2>
      ${k === 'evidence' ? `<div class="seg">${['all', 'aff', 'neg'].map((s) => `<button class="${evSide === s ? 'on' : ''}" data-tact="ev-side" data-side="${s}">${s === 'all' ? 'All' : s === 'aff' ? 'Aff' : 'Neg'}</button>`).join('')}</div>` : ''}</div>
      ${list.length ? `<ul class="list">${list.map((i) => itemView(i, bid)).join('')}</ul>` : '<p class="muted small">Nothing yet.</p>'}
      <details><summary class="small"><strong>+ Add</strong></summary>${itemForm(k, {}, bid)}</details></div>`;
  };
  return `
    <a href="#/team/${teamCtx.id}/research">← All bills</a>
    <div class="card"><div class="spread"><h2 style="margin:0">${esc(bill.title)}</h2><span class="row"><span class="pill">${esc(bill.kind)}</span>${bill.source ? `<span class="small muted">${esc(bill.source)}</span>` : ''}</span></div>
      ${bill.summary ? `<p>${esc(bill.summary)}</p>` : ''}
      ${bill.body ? `<details><summary class="small">Read the full text</summary><pre class="legtext">${esc(bill.body)}</pre></details>` : ''}
      <details><summary class="small">Edit title, summary and text</summary>
        <form class="stack" data-tform="edit-bill" data-id="${bill.id}" style="margin-top:8px"><input name="title" value="${esc(bill.title)}"><input name="source" value="${esc(bill.source)}" placeholder="Source">
        <textarea name="summary" rows="3" placeholder="Summary">${esc(bill.summary)}</textarea><textarea name="body" rows="6" placeholder="Full text">${esc(bill.body)}</textarea>
        <div class="row"><button class="sm primary">Save</button>${teamCtx.data.me.isLeader ? `<button type="button" class="sm ghost" data-tact="delete-bill" data-id="${bill.id}">Delete bill</button>` : ''}</div></form></details>
      <div class="row" style="margin-top:10px"><span class="small muted">Plan a speech:</span>
        ${Object.entries(PLAN_SIDES).map(([k, l]) => `<button class="sm ${k === 'authorship' ? '' : k}" data-tact="plan-from-bill" data-bill="${bill.id}" data-side="${k}" data-title="${esc(bill.title)}">${l}</button>`).join('')}
        <button class="sm" data-tact="note-from-bill" data-bill="${bill.id}" data-title="${esc(bill.title)}">Private note</button></div>
      ${my_plans.length || my_notes.length ? `<p class="small" style="margin-bottom:0">Your prep: ${[...my_plans.map((p) => `<a href="#/team/${teamCtx.id}/plan/${p.id}">${esc(p.title)}</a> <span class="pill ${p.side}">${PLAN_SIDES[p.side] || p.side}</span>`), ...my_notes.map((n) => `<a href="#/team/${teamCtx.id}/note/${n.id}">${esc(n.title)}</a>`)].join(' · ')}</p>` : ''}
    </div>
    <div class="grid two">
      <div>${section('aff')}${section('evidence')}</div>
      <div>${section('neg')}${section('question')}${linksCard(links, { title: 'Docs & folders for this bill', billId: bill.id, hint: 'Shared research docs, Drive folders or articles. Everyone on the team sees these.' })}</div>
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
          <span class="row"><span class="pill ${p.side}">${PLAN_SIDES[p.side] || p.side}</span><span class="pill plan-${p.status}">${STATUS_LABEL_PLAN[p.status]}</span>${p.shared_with_leaders ? '<span class="pill">Shared</span>' : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">No speech plans yet.</p>'}
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
  const { plan, own, author, items, links } = await api('GET', T(`/plans/${pid}`));
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
          <div class="field"><label>Bill</label><select name="bill_id" ${dis}><option value="">No bill yet</option>${bills.map((b) => `<option value="${b.id}" ${plan.bill_id === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select></div>
          <div class="field"><label>Side</label><select name="side" ${dis}>${Object.entries(PLAN_SIDES).map(([k, l]) => `<option value="${k}" ${plan.side === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Status</label><select name="status" ${dis}>${Object.entries(STATUS_LABEL_PLAN).map(([k, l]) => `<option value="${k}" ${plan.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Tournament</label><input name="tournament" value="${esc(plan.tournament)}" ${dis}></div>
        </div>
        <div class="field"><label>Outline and draft</label><textarea name="outline" rows="18" data-outline ${dis} placeholder="Intro and hook&#10;Point 1: claim, warrant, evidence, impact&#10;Point 2: …&#10;Refutation of earlier speakers&#10;Conclusion">${esc(plan.outline)}</textarea></div>
        ${own ? `<label class="row" style="color:var(--ink)"><input type="checkbox" name="shared_with_leaders" ${plan.shared_with_leaders ? 'checked' : ''} style="width:auto;min-height:0"> Share this plan with my coaches and captains</label>
        <div class="row"><button class="primary">Save</button><button type="button" class="sm ghost" data-tact="delete-plan" data-id="${plan.id}">Delete</button><span class="small muted" data-saved></span></div>` : ''}
      </form>
      <div class="card"><h2>Team research${plan.bill_title ? ` on this bill` : ''}</h2>
        ${!plan.bill_id ? '<p class="muted small">Pick a bill to see the team\'s arguments, evidence and likely questions here.</p>'
          : relevant.length ? groups.map((g) => { const list = relevant.filter((i) => i.section === g); return list.length ? `<h3>${SECTION_LABEL[g]}</h3><ul class="list">${list.map((i) => `<li><div class="spread"><strong class="small">${esc(i.text)}</strong>${own ? `<button class="sm" data-tact="insert" data-text="${esc(i.text + (i.detail ? ` (${i.detail})` : '') + (citationText(i) ? ` [${citationText(i)}]` : ''))}">Insert</button>` : ''}</div>${citation(i)}</li>`).join('')}</ul>` : ''; }).join('')
          : `<p class="muted small">No research yet. <a href="#/team/${teamCtx.id}/bill/${plan.bill_id}">Add some on the bill page</a>.</p>`}
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
      <select name="bill_id"><option value="">No bill</option>${teamCtx.data.bills.map((b) => `<option value="${b.id}" ${n.bill_id === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
      <textarea name="body" rows="16">${esc(n.body)}</textarea>
      <div class="row"><button class="primary">Save</button><button type="button" class="sm ghost" data-tact="delete-note" data-id="${n.id}">Delete</button><span class="small muted">Private to you</span></div>
    </form>`;
}

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
      case 'edit-item': { const r = await api('PUT', T(`/bills/${f.dataset.bill}/items/${f.dataset.id}`), { ...d, section: f.dataset.section }); if (r?.conflict) toast('A teammate changed this while you were away. Your version was saved as a copy next to theirs.', true); else savedToast(r, 'Saved'); reTeam(); break; }
      case 'new-plan': { const r = await api('POST', T('/plans'), d); go(`#/team/${teamCtx.id}/plan/${r.id}`); break; }
      case 'save-plan': savedToast(await api('PUT', T(`/plans/${f.dataset.id}`), { ...d, shared_with_leaders: !!f.querySelector('[name=shared_with_leaders]')?.checked }), 'Saved'); reTeam(); break;
      case 'new-note': { const r = await api('POST', T('/notes'), d); go(`#/team/${teamCtx.id}/note/${r.id}`); break; }
      case 'save-note': savedToast(await api('PUT', T(`/notes/${f.dataset.id}`), d), 'Saved'); break;
      case 'new-entry': await api('POST', T('/progress'), d); toast('Logged'); reTeam(); break;
      case 'new-goal': await api('POST', T('/goals'), { ...d, user_id: Number(f.dataset.user) }); toast('Goal added'); reTeam(); break;
      case 'new-link': await api('POST', T('/links'), { ...d, bill_id: f.dataset.bill ? Number(f.dataset.bill) : undefined, plan_id: f.dataset.plan ? Number(f.dataset.plan) : undefined }); toast('Link added'); reTeam(); break;
      case 'team-settings': await api('PUT', T(''), d); toast('Saved'); reTeam(); break;
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
      case 'ev-side': ui.evSide = d.side; reTeam(); break;
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
