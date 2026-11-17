'use strict';
/* Congress Chamber: single-page client. No build step. */

const $view = document.getElementById('view');
const $who = document.getElementById('whoami');
let me = null;
let state = null;          // chamber state from the server
let chamberId = null;
let events = null;         // EventSource for live updates
let clockOffset = 0;       // server time minus local time
let pendingRender = false; // deferred re-render while someone is typing
let ui = { recognizeSide: null, results: null, rankDraft: null, userFlash: null, viewAs: null, dashList: 'speak' };
let tracker = null;        // personal tracker being edited ({ id, name, data })

// ---------- utilities ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const SIDE_LABEL = { authorship: 'Authorship', sponsorship: 'Sponsorship', aff: 'Affirmative', neg: 'Negative' };
const STATUS_LABEL = { setup: 'Not started', in_session: 'In session', recess: 'In recess', adjourned: 'Adjourned' };
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtSecs = (s) => { const neg = s < 0; s = Math.abs(Math.round(s)); return `${neg ? '+' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const byId = (list, id) => list.find((x) => x.id === id);
const competitor = (id) => state && byId(state.competitors, id);

function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2200);
}
async function api(method, url, body) {
  // Admins in a mock tournament can act as one of its made-up people.
  const viewAs = ui.viewAs && chamberId && url.startsWith(`/api/chambers/${chamberId}/`) ? ui.viewAs : null;
  try {
    return method === 'GET' ? await Offline.get(url, viewAs) : await Offline.write(method, url, body, viewAs);
  } catch (e) {
    if (e.status === 401 && !url.startsWith('/api/login')) { me = null; go('#/login'); throw new Error('Please sign in.'); }
    throw e;
  }
}
// Run an action, report errors, refresh chamber state.
async function act(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    if (r?.queued) toast(`${okMsg || 'Saved'} on this device. It sends when you are back online.`);
    else if (okMsg) toast(okMsg);
    if (chamberId) await loadState();
    return r;
  } catch (e) { toast(e.message, true); return null; }
}
const C = (path) => `/api/chambers/${chamberId}${path}`;
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

// ---------- routing ----------
window.addEventListener('hashchange', route);
async function route() {
  if (!me) {
    try { me = (await api('GET', '/api/me')).user; } catch { me = null; }
  }
  renderWho();
  document.body.classList.remove('wide', 'in-chamber');
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'signup' && !me) return renderSignup(parts[1] || '');
  if (!me) {
    closeEvents();
    const setup = await api('GET', '/api/setup');
    return setup.needed ? renderSetup() : renderLogin();
  }
  if (parts[0] === 'c' && parts[1]) {
    const id = Number(parts[1]);
    tracker = null;
    if (id !== chamberId) { chamberId = id; state = null; ui = { ...ui, results: null, rankDraft: null, viewAs: null, reflection: null }; openEvents(); }
    if (!state) await loadState(); else render();
    return;
  }
  closeEvents(); chamberId = null; state = null;
  if (parts[0] === 'tracker' && parts[1]) return openTracker(Number(parts[1]));
  tracker = null;
  if (parts[0] === 'tracker') return renderTrackerList();
  if (parts[0] === 'users' && me.role === 'admin') return renderUsers();
  if (parts[0] === 'data' && me.role === 'admin') return renderData();
  if (parts[0] === 'signup') return renderTeams();
  if (parts[0] === 'teams') return renderTeams();
  if (parts[0] === 'team' && parts[1]) return renderTeam(Number(parts[1]), parts[2] || 'research', parts[3], parts[4]);
  if (parts[0] === 'account') return renderAccount();
  return renderHome();
}
function currentTab() { const t = location.hash.split('/')[3] || ''; return TAB_ALIAS[t] || t; }

function renderWho() {
  Offline.banner();
  const nav = document.getElementById('mainnav');
  const here = location.hash.replace(/^#\/?/, '').split('/')[0];
  const sec = ['c', ''].includes(here) ? 'home' : (['team', 'teams', 'signup'].includes(here) ? 'teams' : here);
  const links = me ? [['home', '#/', 'Chambers'], ['teams', '#/teams', 'Teams'], ['tracker', '#/tracker', 'Tracker'], ...(me.role === 'admin' ? [['users', '#/users', 'People'], ['data', '#/data', 'Data']] : [])] : [];
  if (nav) nav.innerHTML = links.map(([k, h, l]) => `<a href="${h}" class="${sec === k ? 'active' : ''}">${l}</a>`).join('');
  $who.innerHTML = me
    ? `<a href="#/account" class="me-chip" title="Account and password"><span class="avatar">${esc((me.display_name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase())}</span><span class="me-name">${esc(me.display_name)}<small>${esc(me.role)}</small></span></a><button class="ghost sm" data-act="logout">Sign out</button>`
    : '';
}

// ---------- live updates ----------
function openEvents() {
  closeEvents();
  events = new EventSource(C('/events'));
  events.addEventListener('changed', () => loadState());
}
Offline.hooks.synced = () => { if (chamberId) loadState(); };
function closeEvents() { if (events) { events.close(); events = null; } }
async function loadState() {
  if (!chamberId) return;
  try {
    const s = await api('GET', C('/state'));
    if (!s._offline) clockOffset = s.server_now - Date.now();
    state = s;
    const savedRanks = state.my_rankings || state.my_practice_rankings;
    if (ui.rankDraft === null && savedRanks?.length) ui.rankDraft = [...savedRanks];
    if (currentTab() === 'results' && state.me.isAdmin) ui.results = await api('GET', C('/results'));
    if (currentTab() === 'reflect' && state.me.isCompetitor) ui.reflection = await api('GET', C('/reflection'));
    render();
  } catch (e) {
    $view.innerHTML = `<div class="card"><p>${esc(e.message)}</p><a href="#/">Back</a></div>`;
  }
}
function isTyping() {
  const a = document.activeElement;
  return a && $view.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'button') || a.tagName === 'SELECT');
}
function render() {
  if (!state && !tracker) return;
  if (isTyping()) { pendingRender = true; return; }
  pendingRender = false;
  if (tracker) renderTracker(); else renderChamber();
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !isTyping()) render(); }, 50));

// ---------- timer ----------
// The timer on screen belongs to the chamber (server clock) or to a personal tracker (this device's clock).
function activeTimer() {
  if (tracker) return { t: tracker.data.timer, offset: 0 };
  if (selfTracking()) return { t: myTimer(), offset: 0 };
  return { t: state?.chamber?.timer, offset: clockOffset };
}
function timerRemaining(t, offset = activeTimer().offset) {
  if (!t) return null;
  const elapsed = t.elapsed_ms + (t.running ? (Date.now() + offset - t.started_at) : 0);
  return t.duration - elapsed / 1000;
}
function timerHtml(t) {
  if (!t) return `<div class="timer muted">--:--</div>`;
  return `<div class="timer" data-timer>${fmtSecs(timerRemaining(t))}</div>`;
}
setInterval(() => {
  const { t, offset } = activeTimer();
  for (const el of document.querySelectorAll('[data-timer]')) {
    const r = timerRemaining(t, offset);
    if (r == null) continue;
    el.textContent = fmtSecs(r);
    el.classList.toggle('over', r < 0);
    el.classList.toggle('low', r >= 0 && r <= 30);
  }
}, 250);

// ---------- sign in / setup / account ----------
function renderLogin() {
  $view.innerHTML = `
    <form class="card login" data-form="login">
      <h1>Sign in</h1>
      <div class="field"><label>Username</label><input name="username" autocomplete="username" autocapitalize="none" required></div>
      <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
      <button class="primary" style="width:100%;justify-content:center">Sign in</button>
      <p class="muted small">Your tournament admin gives you a username and password. Joining a team? <a href="#/signup">Sign up with your team's join code</a>.</p>
    </form>`;
}
function renderSetup() {
  $view.innerHTML = `
    <form class="card login" data-form="setup">
      <h1>Set up the tournament</h1>
      <p class="muted">Create the first admin account. Admins (the parliamentarian or tab staff) add everyone else.</p>
      <div class="field"><label>Your name</label><input name="display_name" required></div>
      <div class="field"><label>Username</label><input name="username" autocapitalize="none" required></div>
      <div class="field"><label>Password (6+ characters)</label><input name="password" type="password" minlength="6" required></div>
      <button class="primary" style="width:100%;justify-content:center">Create admin</button>
    </form>`;
}
function renderAccount() {
  $view.innerHTML = `
    <a href="#/">← Home</a>
    <form class="card login" data-form="password">
      <h1>Change password</h1>
      <div class="field"><label>Current password</label><input name="current" type="password" required></div>
      <div class="field"><label>New password (6+ characters)</label><input name="next" type="password" minlength="6" required></div>
      <button class="primary">Save</button>
    </form>`;
}

// ---------- home ----------
async function renderHome() {
  const { chambers } = await api('GET', '/api/chambers');
  const admin = me.role === 'admin';
  $view.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Welcome, ${esc(me.display_name.split(' ')[0])}</span><h1>Your chambers</h1></div>
      ${admin ? '<div class="row"><a class="btn" href="#/users">People and logins</a><button data-act="make-mock">Mock tournament</button></div>' : ''}</div>
    ${chambers.length ? `<div class="tiles">${chambers.map((c) => `
      <a class="tile status-${c.status}" href="#/c/${c.id}">
        <span class="tile-top"><span class="pill status-${c.status}">${esc(STATUS_LABEL[c.status])}</span>${c.is_mock ? '<span class="pill debating">Mock</span>' : ''}${c.is_po ? '<span class="pill">You preside</span>' : ''}</span>
        <strong>${esc(c.name)}</strong><span class="tile-go">Open →</span></a>`).join('')}</div>`
      : `<div class="card empty"><p class="muted">${admin ? 'No chambers yet. Create one below, or make a mock tournament to try things out.' : 'You are not assigned to a chamber yet. Ask your tournament admin.'}</p></div>`}
    ${admin ? `<form class="card row" data-form="new-chamber"><input name="name" placeholder="New chamber name, e.g. House Prelims Chamber A" required style="flex:1;min-width:200px">
        <button class="primary">Create chamber</button></form>` : ''}
    <div class="grid two">
      <a class="card link-card" href="#/teams"><span class="eyebrow">Prep</span><h2>Teams</h2><p class="small muted">Shared bill research, speech plans, notes and progress.</p></a>
      <a class="card link-card" href="#/tracker"><span class="eyebrow">On your own</span><h2>Personal tracker</h2><p class="small muted">Track precedence, recency and a timer for any chamber. Only you see it.</p></a>
    </div>`;
}

// ---------- users (admin) ----------
// ---------- data & backups (admins) ----------
const fmtBytes = (n) => (n == null ? '?' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const BACKUP_REASON = { daily: 'Daily', manual: 'Made by hand', 'pre-restore': 'Before a restore', upload: 'Uploaded' };
async function renderData() {
  let b;
  try { b = await api('GET', '/api/admin/backups'); } catch (e) { $view.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`; return; }
  const used = b.disk ? b.disk.total - b.disk.free : null;
  $view.innerHTML = `
    <div class="page-head"><div><h1>Data &amp; backups</h1><p class="muted" style="margin:0">Copies of everything in the app, kept on the server and ready to download.</p></div></div>
    ${b._offline ? '<div class="banner recess">You are offline. This list is from the last time you were connected.</div>' : ''}
    <div class="grid two">
      <div class="card stack">
        <h2>Save a copy</h2>
        <p class="small muted" style="margin:0">The app backs itself up once a day when something changed and keeps ${b.keep_days} days of copies (always at least the last five). Before a tournament, make one by hand and download it to your own computer.</p>
        <div class="row"><button class="primary" data-act="backup-now">Back up now</button><a class="btn" href="/api/admin/export.zip">Export everything (spreadsheets)</a></div>
        <p class="small muted" style="margin:0">The export is a zip with one spreadsheet per table, for Excel or Google Sheets. Passwords, private speech plans, notes, trackers and practice ballots stay out of it; they are only in the full backups.</p>
      </div>
      <div class="card stack">
        <h2>Storage</h2>
        <div class="spread small"><span>Database</span><strong>${fmtBytes(b.db_bytes)}</strong></div>
        <div class="spread small"><span>Backups (${b.backups.length})</span><strong>${fmtBytes(b.total_bytes)}</strong></div>
        ${b.disk ? `<div class="spread small"><span>Disk used</span><strong>${fmtBytes(used)} of ${fmtBytes(b.disk.total)}</strong></div><div class="meter" aria-hidden="true"><span style="width:${Math.min(100, Math.round((used / b.disk.total) * 100))}%"></span></div>` : ''}
      </div>
    </div>
    <div class="card">
      <h2>Backups</h2>
      ${b.backups.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Size</th><th></th></tr></thead><tbody>
        ${b.backups.map((x) => `<tr><td>${esc(new Date(x.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${esc(BACKUP_REASON[x.reason] || x.reason)}</td><td>${fmtBytes(x.size)}</td>
          <td class="row" style="justify-content:flex-end"><a class="btn sm" href="/api/admin/backups/${encodeURIComponent(x.name)}">Download</a>${b.can_restore ? `<button class="sm ghost" data-act="restore" data-name="${esc(x.name)}" data-when="${esc(new Date(x.created_at).toLocaleString())}">Restore</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No backups yet. The first daily copy is made a few minutes after the app starts.</p>'}
    </div>
    ${b.can_restore ? `<div class="card stack">
      <h2>Restore from a file</h2>
      <p class="small muted" style="margin:0">Pick a backup you downloaded earlier (a .db.gz file). Everything in the app is replaced with what is in that file. A copy of the current data is saved first, so a restore can be undone.</p>
      <div class="row"><input type="file" id="restore-file" accept=".gz,.db,application/gzip" style="max-width:340px"><button class="ghost" data-act="restore-upload">Restore this file</button></div>
    </div>` : ''}`;
}
async function renderUsers() {
  const { users } = await api('GET', '/api/users');
  const flash = ui.userFlash; ui.userFlash = null;
  $view.innerHTML = `
    <a href="#/">← Home</a>
    <h1>People and logins</h1>
    ${flash ? `<div class="card"><h2>New logins</h2><p class="muted small">Copy these now. Passwords are not shown again (you can reset them).</p>
      <div class="table-wrap"><table><tr><th>Name</th><th>Role</th><th>Username</th><th>Password</th></tr>
      ${flash.map((u) => `<tr><td>${esc(u.display_name)}</td><td>${esc(u.role)}</td><td class="pw">${esc(u.username)}</td><td class="pw">${esc(u.password)}</td></tr>`).join('')}
      </table></div></div>` : ''}
    <div class="grid two">
      <form class="card" data-form="new-user">
        <h2>Add one person</h2>
        <div class="field"><label>Name</label><input name="display_name" required></div>
        <div class="inline-fields">
          <div class="field"><label>School</label><input name="school"></div>
          <div class="field"><label>Role</label><select name="role"><option value="competitor">Competitor</option><option value="judge">Judge / scorer</option><option value="admin">Admin / parliamentarian</option></select></div>
        </div>
        <div class="inline-fields">
          <div class="field"><label>Username (optional)</label><input name="username" autocapitalize="none"></div>
          <div class="field"><label>Password (optional)</label><input name="password"></div>
        </div>
        <button class="primary">Add</button>
      </form>
      <form class="card" data-form="bulk-users">
        <h2>Add many at once</h2>
        <p class="muted small">One person per line: <code>Name, School, role</code>. Role is competitor, judge or admin (competitor if left out). Usernames and passwords are generated.</p>
        <textarea name="text" rows="7" placeholder="Jordan Lee, Lincoln HS&#10;Sam Ortiz, Roosevelt HS&#10;Pat Kim, , judge"></textarea>
        <button class="primary">Add all</button>
      </form>
    </div>
    <div class="card"><h2>Everyone (${users.length})</h2><div class="table-wrap"><table>
      <tr><th>Name</th><th>School</th><th>Role</th><th>Username</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.display_name)}</td><td>${esc(u.school)}</td><td>${esc(u.role)}</td><td class="pw">${esc(u.username)}</td>
        <td class="row"><button class="sm" data-act="reset-pw" data-id="${u.id}" data-name="${esc(u.display_name)}">Reset password</button>
        ${u.id !== me.id ? `<button class="sm" data-act="delete-user" data-id="${u.id}" data-name="${esc(u.display_name)}">Delete</button>` : ''}</td></tr>`).join('')}
    </table></div></div>`;
}

// ---------- chamber shell ----------
// A few tabs per role. Old tab names in saved links still land somewhere sensible.
const TAB_LABEL = { live: 'Dashboard', ballot: 'Ballot', floor: 'Floor', practice: 'Practice', reflect: 'My results', docket: 'Docket', setup: 'Setup', results: 'Results' };
const TAB_ALIAS = { chair: 'live', score: 'live', log: 'docket' };
const TAB_ICON = {
  live: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="8"/>',
  ballot: '<path d="M9 11l2 2 4-4"/><rect x="4" y="3" width="16" height="18" rx="2"/>',
  floor: '<path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/>',
  practice: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  reflect: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  docket: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  results: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICON[k] || ''}</svg>`;
function tabsFor(m) {
  const self = state?.chamber?.floor_mode === 'self';
  if (m.isJudge) return ['live', 'ballot', 'docket'];
  if (m.isPO && !self) return ['live', 'floor', 'docket'];
  if (m.isCompetitor) return self ? ['practice', 'reflect', 'docket'] : ['floor', 'practice', 'reflect', 'docket'];
  if (m.isAdmin) return self ? ['docket', 'setup', 'results'] : ['live', 'docket', 'setup', 'results'];
  return ['floor', 'docket'];
}
function renderChamber() {
  const s = state, c = s.chamber, m = s.me;
  const tabs = tabsFor(m);
  let tab = TAB_ALIAS[currentTab()] || currentTab();
  if (!tabs.includes(tab)) tab = tabs[0];
  const body = { live: () => viewLive(m.isJudge ? 'judge' : 'chair'), ballot: () => viewBallot('judge'), floor: viewFloor, practice: () => viewLive('practice'), reflect: viewReflection, docket: viewDocket, setup: viewSetup, results: viewResults }[tab]();
  document.body.classList.toggle('wide', ['live', 'practice'].includes(tab));
  document.body.classList.add('in-chamber');
  const viewAs = s.view_as_options ? `<div class="card viewas row">
      <strong>Mock tournament.</strong> <label for="viewas" style="margin:0">View as</label>
      <select id="viewas" data-viewas style="width:auto;flex:1;min-width:200px"><option value="">Myself (admin)</option>
      ${s.view_as_options.map((u) => `<option value="${u.id}" ${ui.viewAs === u.id ? 'selected' : ''}>${esc(u.display_name)} · ${u.is_po ? 'presiding officer' : esc(u.role)}</option>`).join('')}</select>
      ${m.viewingAs ? '<span class="small">Everything you do now counts as this person, so you can vote, rise and score as them.</span>' : ''}</div>` : '';
  $view.innerHTML = `
    ${viewAs}
    <div class="page-head"><div><a href="#/" class="eyebrow back">← All chambers</a><h1>${esc(c.name)}</h1></div>
      <div class="row head-pills">${s.is_mock ? '<span class="pill debating">Mock</span>' : ''}<span class="pill status-${c.status}">${esc(STATUS_LABEL[c.status])}</span>
      ${c.floor_mode === 'self' ? '<span class="pill">Self-tracked</span>' : (c.po_name ? `<span class="pill">PO: ${esc(c.po_name)}</span>` : '')}
      <span class="pill role">${m.isJudge ? 'Judge' : m.isPO ? 'Presiding officer' : m.isCompetitor ? 'Competitor' : 'Admin'}</span></div></div>
    <nav class="tabs chamber-tabs">${tabs.map((k) => `<a href="#/c/${c.id}/${k}" class="${k === tab ? 'active' : ''}">${icon(k)}<span>${TAB_LABEL[k]}</span></a>`).join('')}</nav>
    ${body}`;
}
const currentLeg = () => state.chamber.current_legislation_id && byId(state.legislation, state.chamber.current_legislation_id);
const currentSpeech = () => state.chamber.current_speech_id && byId(state.speeches, state.chamber.current_speech_id);

// ---------- Floor (everyone) ----------
function floorCard() {
  const c = state.chamber, leg = currentLeg(), sp = currentSpeech();
  const qs = sp ? state.questions.filter((q) => q.speech_id === sp.id) : [];
  return `<div class="card floor">
    <div class="muted small">${leg ? `Now debating · ${esc(leg.kind)}` : 'No item on the floor'}</div>
    <h2 style="margin:4px 0">${leg ? esc(leg.title) : '—'}</h2>
    ${sp ? `<div class="who">${esc(sp.speaker_name)}</div><span class="pill ${sp.side}">${SIDE_LABEL[sp.side]}</span>` : `<div class="who muted">Floor is open</div>`}
    <div style="margin:14px 0 4px" class="muted small">${esc(c.timer?.label || 'Timer')}${c.timer && !c.timer.running ? ' (paused)' : ''}</div>
    ${timerHtml(c.timer)}
    ${qs.length ? `<p class="small muted">Questions from: ${qs.map((q) => esc(q.questioner_name)).join(', ')}</p>` : ''}
  </div>`;
}
function voteBanner() {
  const v = state.open_vote;
  if (!v) return '';
  const m = state.me;
  const canVote = m.isCompetitor && !m.isPO;
  return `<div class="card"><div class="banner vote">Vote open: ${esc(v.label)} (${v.threshold === 'two_thirds' ? 'two-thirds' : 'majority'} needed)</div>
    ${canVote ? `<div class="vote-buttons">
      ${['yes', 'no', 'abstain'].map((ch) => `<button class="${ch === 'yes' ? 'aff' : ch === 'no' ? 'neg' : ''} ${v.my_choice === ch ? 'on' : ''}" data-act="ballot" data-choice="${ch}">${ch === 'abstain' ? 'Abstain' : ch === 'yes' ? 'Yea' : 'Nay'}</button>`).join('')}
      </div><p class="small muted">${v.my_choice ? `You voted ${esc(v.my_choice)}. You can change it until the PO closes the vote.` : 'Tap to cast your vote.'}</p>` : ''}
    <p class="small muted" style="margin-bottom:0">${v.cast} of ${v.eligible} voted${v.tally ? ` · Yea ${v.tally.yes}, Nay ${v.tally.no}, Abstain ${v.tally.abstain}` : ''}</p></div>`;
}
function precedenceList(ids, countKey, opts = {}) {
  return ids.map((id, i) => {
    const p = competitor(id);
    const req = state.requests.filter((r) => r.user_id === id && (countKey === 'questions' ? r.kind === 'question' : r.kind !== 'question'));
    const tags = req.map((r) => `<span class="pill ${r.kind === 'question' ? '' : r.kind}">${r.kind === 'question' ? 'Question' : SIDE_LABEL[r.kind]}</span>`).join(' ');
    return `<div class="prec-item"><span class="n">${i + 1}</span><span class="name">${esc(p.display_name)} <span class="small muted">${esc(p.school)}</span></span>
      <span class="small muted">${p[countKey]} ${countKey === 'speeches' ? 'sp' : 'q'}</span> ${tags} ${opts.button ? opts.button(p) : ''}</div>`;
  }).join('') || '<p class="muted">No competitors yet.</p>';
}
function viewFloor() {
  const s = state, m = s.me, c = s.chamber;
  const myReq = s.requests.filter((r) => r.user_id === m.id).map((r) => r.kind);
  const mySpeeches = s.speeches.filter((x) => x.speaker_id === m.id);
  const canRise = m.isCompetitor && !m.isPO && c.current_legislation_id;
  if (c.floor_mode === 'self') return `<div class="card"><h2>No PO in the app for this chamber</h2>
    <p>Each person tracks the floor for themselves, and nobody else sees your log.</p>
    <ul>${m.isJudge ? '<li>Judges: open the <a href="#/c/' + c.id + '/live">Dashboard</a>, tap Speech beside a name when someone gets the floor, then score it right there.</li>' : ''}
      ${m.isCompetitor ? '<li>Competitors: open <a href="#/c/' + c.id + '/practice">Practice</a> to log speeches, run a timer and practice scoring.</li>' : ''}
      ${m.isAdmin ? '<li>Admins can switch this back to a PO-run chamber in Setup.</li>' : ''}</ul></div>`;
  return viewFloorPO();
}
function viewFloorPO() {
  const s = state, m = s.me, c = s.chamber;
  const myReq = s.requests.filter((r) => r.user_id === m.id).map((r) => r.kind);
  const mySpeeches = s.speeches.filter((x) => x.speaker_id === m.id);
  const canRise = m.isCompetitor && !m.isPO && c.current_legislation_id && c.floor_mode !== 'self';
  return `
    ${c.status === 'recess' ? '<div class="banner recess">The chamber is in recess.</div>' : ''}
    ${c.status === 'adjourned' ? '<div class="banner recess">The chamber has adjourned.</div>' : ''}
    ${voteBanner()}
    <div class="grid side">
      <div>
        ${floorCard()}
        ${canRise ? `<div class="card"><h2>Seek the floor</h2>
          <p class="small muted">Let the PO know you want to speak or ask a question. They still recognize speakers by precedence.</p>
          <div class="row">
            <button class="aff ${myReq.includes('aff') ? 'on' : ''}" data-act="request" data-kind="aff">${myReq.includes('aff') ? '✓ ' : ''}Speak affirmative</button>
            <button class="neg ${myReq.includes('neg') ? 'on' : ''}" data-act="request" data-kind="neg">${myReq.includes('neg') ? '✓ ' : ''}Speak negative</button>
            <button class="${myReq.includes('question') ? 'on' : ''}" data-act="request" data-kind="question">${myReq.includes('question') ? '✓ ' : ''}Ask a question</button>
          </div>
          ${myReq.length ? '<p class="small muted">Tap a highlighted button again to sit back down.</p>' : ''}</div>` : ''}
        ${s.announcements.length ? `<div class="card"><h2>Announcements</h2><ul class="list">${s.announcements.map((a) => `<li><span class="small muted">${fmtTime(a.created_at)}</span> ${esc(a.body)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div>
        ${m.isCompetitor ? `<div class="card"><h2>My speeches (${mySpeeches.length})</h2>${mySpeeches.length ? `<ul class="list">${mySpeeches.map((x) => `<li><span class="pill ${x.side}">${SIDE_LABEL[x.side]}</span> ${esc(x.legislation_title)} <span class="small muted">${fmtTime(x.recognized_at)}</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</div>` : ''}
        <div class="card"><h2>Speaking precedence</h2><p class="small muted">Fewest speeches first, then whoever spoke longest ago.</p>${precedenceList(s.speaking_precedence, 'speeches')}</div>
      </div>
    </div>`;
}

// ---------- Dashboard (shared by the chamber and personal trackers) ----------
// model: { scope, timer, title, speaker, nextSide, people[], order{speak,question}, ruleOrder{speak,question}, canQuestion, qSecs }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function dashTimer(model) {
  const t = model.timer, sc = model.scope;
  return `<div class="card dash-timer">
    <div class="muted small">${model.title ? esc(model.title) : 'No item on the floor'}</div>
    <div class="who">${model.speaker ? `${esc(model.speaker.name)} <span class="pill ${model.speaker.side}">${SIDE_LABEL[model.speaker.side]}</span>` : '<span class="muted">Floor is open</span>'}</div>
    <div class="muted small">${esc(t?.label || 'Timer')}${t && !t.running ? ' · paused' : ''}</div>
    ${timerHtml(t)}
    <div class="row" style="justify-content:center;margin-top:12px">
      ${t ? `<button class="${t.running ? '' : 'primary'}" data-act="d-timer" data-scope="${sc}" data-a="${t.running ? 'pause' : 'resume'}" title="Space bar">${t.running ? 'Pause' : 'Start'}</button>
             <button data-act="d-timer" data-scope="${sc}" data-a="reset">Reset</button>` : ''}
      ${model.speaker ? `<button data-act="d-questioning" data-scope="${sc}">Questioning ${fmtSecs(model.qSecs)}</button>
                         <button data-act="d-end" data-scope="${sc}">End speech</button>` : ''}
    </div>
    <form class="row" data-form="d-custom-timer" data-scope="${sc}" style="justify-content:center;margin-top:8px">
      <input name="label" placeholder="Other timer (e.g. Recess)" style="width:auto;flex:2;min-width:120px"><input name="minutes" type="number" min="0.25" step="0.25" placeholder="Minutes" style="width:auto;flex:1;min-width:80px">
      <button class="sm">Set</button></form>
    <p class="small muted" style="margin:8px 0 0">Space bar starts and pauses the timer.</p>
  </div>`;
}
function dashList(model) {
  const sc = model.scope, kind = ui.dashList;
  const order = model.order[kind], rule = model.ruleOrder[kind];
  const adjusted = JSON.stringify(order) !== JSON.stringify(rule);
  const people = new Map(model.people.map((p) => [p.id, p]));
  const spokeOrder = model.people.filter((p) => p.lastSpeech).sort((a, b) => b.lastSpeech - a.lastSpeech).map((p) => p.id);
  const askOrder = model.people.filter((p) => p.lastQuestion).sort((a, b) => b.lastQuestion - a.lastQuestion).map((p) => p.id);
  const sides = ['authorship', 'aff', 'neg'];
  const rows = order.map((id, i) => {
    const p = people.get(id);
    if (!p) return '';
    const sr = spokeOrder.indexOf(id), qr = askOrder.indexOf(id);
    const actions = kind === 'speak'
      ? sides.map((sd) => `<button class="sm ${sd === 'authorship' ? '' : sd} " data-act="d-recognize" data-scope="${sc}" data-id="${id}" data-side="${sd}" ${model.title ? '' : 'disabled'} title="Recognize for ${SIDE_LABEL[sd]}">${sd === 'authorship' ? 'Auth' : sd === 'aff' ? 'Aff' : 'Neg'}</button>`).join('')
      : `<button class="sm primary" data-act="d-question" data-scope="${sc}" data-id="${id}" ${model.canQuestion && !p.speaking ? '' : 'disabled'}>Question</button>`;
    return `<tr draggable="true" data-drag-id="${id}" class="${p.speaking ? 'speaking' : ''}">
      <td class="handle" title="Drag to reorder">⠿</td>
      <td class="num">${i + 1}</td>
      <td><strong>${esc(p.name)}</strong>${p.school ? ` <span class="small muted">${esc(p.school)}</span>` : ''}
        ${p.speaking ? ' <span class="pill debating">has the floor</span>' : ''}
        ${(p.tags || []).filter((t) => (kind === 'speak') === (t !== 'question')).map((t) => `<span class="pill ${t === 'question' ? '' : t}">${t === 'question' ? 'wants to ask' : 'rose ' + (t === 'aff' ? 'aff' : 'neg')}</span>`).join(' ')}</td>
      <td class="num">${p.speeches}</td>
      <td class="small">${p.lastSpeech ? `${fmtTime(p.lastSpeech)} <span class="muted">· ${sr === 0 ? 'most recent' : ordinal(sr + 1) + ' most recent'}</span>` : '<span class="muted">not yet</span>'}</td>
      <td class="num">${p.questions}</td>
      <td class="small">${p.lastQuestion ? `${fmtTime(p.lastQuestion)}${qr === 0 ? ' <span class="muted">· most recent</span>' : ''}` : '<span class="muted">—</span>'}</td>
      <td class="row nowrap">${actions}
        <span class="movers"><button class="sm ghost" data-act="d-move" data-scope="${sc}" data-id="${id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="sm ghost" data-act="d-move" data-scope="${sc}" data-id="${id}" data-dir="1" ${i === order.length - 1 ? 'disabled' : ''} title="Move down">↓</button></span></td>
    </tr>`;
  }).join('');
  return `<div class="card dash-list">
    <div class="spread">
      <div class="seg"><button class="${kind === 'speak' ? 'on' : ''}" data-act="d-list" data-kind="speak">Speaking order</button><button class="${kind === 'question' ? 'on' : ''}" data-act="d-list" data-kind="question">Questioning order</button></div>
      <div class="row">${adjusted ? '<span class="small warn-text">Adjusted by hand</span>' : '<span class="small muted">Following the rule</span>'}
        <button class="sm" data-act="d-queue" data-scope="${sc}" data-a="reset" ${adjusted ? '' : 'disabled'}>Reset to rule</button>
        <button class="sm" data-act="d-queue" data-scope="${sc}" data-a="shuffle" title="Random order among people tied on count">Random draw</button></div>
    </div>
    <p class="small muted">${kind === 'speak'
      ? `Top of the list has precedence: fewest speeches, then longest since speaking. Recognizing someone moves them to the bottom. Drag rows to fix mistakes or set a starting order.${model.nextSide ? ` Next expected: <strong>${SIDE_LABEL[model.nextSide]}</strong>.` : ''}`
      : 'Top of the list asks next: fewest questions, then longest since asking. Logging a question moves them to the bottom.'}</p>
    ${model.people.length ? `<div class="table-wrap"><table class="dash-table">
      <tr><th></th><th>#</th><th>Name</th><th>Speeches</th><th>Last spoke</th><th>Qs</th><th>Last asked</th><th>${kind === 'speak' ? `Recognize${model.nextSide ? ` <span class="pill ${model.nextSide}">next: ${SIDE_LABEL[model.nextSide]}</span>` : ''}` : 'Log'}</th></tr>
      ${rows}</table></div>` : `<p class="muted">No competitors yet.</p>`}
  </div>`;
}

function chamberDashModel() {
  const s = state, c = s.chamber, leg = currentLeg(), sp = currentSpeech();
  const lastQ = new Map();
  for (const q of s.questions) lastQ.set(q.questioner_id, q.asked_at);
  return {
    scope: 'chamber', timer: c.timer, title: leg?.title, nextSide: leg ? c.next_side : null,
    speaker: sp ? { name: sp.speaker_name, side: sp.side } : null,
    qSecs: sp && ['authorship', 'sponsorship'].includes(sp.side) ? c.authorship_question_seconds : c.question_seconds,
    canQuestion: !!sp,
    people: s.competitors.filter((p) => !p.is_po).map((p) => ({
      id: p.id, name: p.display_name, school: p.school, speeches: p.speeches, questions: p.questions,
      lastSpeech: p.last_speech_at, lastQuestion: p.last_question_at, speaking: sp?.speaker_id === p.id,
      tags: s.requests.filter((r) => r.user_id === p.id).map((r) => r.kind),
    })),
    order: { speak: s.speaking_precedence, question: s.question_precedence },
    ruleOrder: { speak: s.speaking_rule_order, question: s.question_rule_order },
  };
}

function chairControls() {
  const s = state, c = s.chamber, leg = currentLeg();
  const pendingItems = s.legislation.filter((l) => ['pending', 'debating'].includes(l.status) && l.id !== c.current_legislation_id);
  const motionsOpen = s.motions.filter((x) => ['pending', 'voting'].includes(x.status));
  const competitorsOpts = s.competitors.filter((p) => !p.is_po).map((p) => `<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
  return `
        <div class="card"><h2>Session</h2><div class="row">
          ${c.status !== 'in_session' ? '<button class="primary" data-act="status" data-status="in_session">Call to order</button>' : '<button data-act="status" data-status="recess">Recess</button>'}
          ${c.status !== 'adjourned' ? '<button data-act="status" data-status="adjourned">Adjourn</button>' : ''}
          ${s.requests.length ? '<button data-act="clear-requests">Clear everyone standing</button>' : ''}
        </div></div>
        <div class="card"><h2>Docket</h2>
          ${leg ? `<p style="margin-top:0">On the floor: <strong>${esc(leg.title)}</strong></p><div class="row">
            <button class="primary" data-act="open-vote" data-type="legislation" data-id="${leg.id}" ${s.open_vote ? 'disabled' : ''}>Vote on ${esc(leg.kind)}</button>
            </div>
            <details style="margin-top:8px"><summary class="small">Record a hand vote instead</summary>
              <form class="inline-fields" data-form="hand-vote" data-id="${leg.id}" style="margin-top:8px">
                <input name="yes" type="number" min="0" placeholder="Yea"><input name="no" type="number" min="0" placeholder="Nay"><input name="abstain" type="number" min="0" placeholder="Abstain">
                <select name="status"><option value="passed">Passed</option><option value="failed">Failed</option></select><button class="sm">Record</button></form></details>` : '<p class="muted small" style="margin-top:0">Pick an item to begin debate.</p>'}
          <h3>Up next</h3>
          ${pendingItems.length ? `<ul class="list">${pendingItems.map((l) => `<li class="spread"><span>${esc(l.title)}</span><button class="sm" data-act="begin" data-id="${l.id}">Begin debate</button></li>`).join('')}</ul>` : '<p class="muted small">Nothing else pending.</p>'}
        </div>
        <div class="card"><h2>Motions</h2>
          <form data-form="motion" class="stack">
            <div class="inline-fields"><select name="kind">${s.motion_kinds.map((k) => `<option value="${k.kind}">${esc(k.label)} (${k.threshold === 'two_thirds' ? '2/3' : 'majority'})</option>`).join('')}</select>
              <select name="mover_id"><option value="">Moved by…</option>${competitorsOpts}</select></div>
            <input name="details" placeholder="Details (e.g. amendment text, recess length)">
            <button class="sm">Entertain motion</button>
          </form>
          ${motionsOpen.length ? `<ul class="list" style="margin-top:8px">${motionsOpen.map((x) => `<li><div><strong>${esc(x.label)}</strong> ${x.mover_name ? `<span class="small muted">by ${esc(x.mover_name)}</span>` : ''} <span class="pill ${x.status}">${x.status}</span></div>
            ${x.details ? `<div class="small">${esc(x.details)}</div>` : ''}
            <div class="row" style="margin-top:6px">${x.status === 'pending' ? `<button class="sm primary" data-act="open-vote" data-type="motion" data-id="${x.id}" ${s.open_vote ? 'disabled' : ''}>Put to a vote</button>
              <button class="sm" data-act="motion-status" data-id="${x.id}" data-status="passed">Passed (no objection)</button>
              <button class="sm" data-act="motion-status" data-id="${x.id}" data-status="withdrawn">Withdrawn / out of order</button>` : ''}</div></li>`).join('')}</ul>` : ''}
        </div>
        <div class="card"><h2>Announce</h2><form data-form="announce" class="row"><input name="body" placeholder="e.g. Five-minute recess, return at 10:40" style="flex:1;min-width:160px"><button class="sm">Post</button></form></div>
        ${s.past_votes.length ? `<div class="card"><h2>Recent votes</h2><ul class="list">${s.past_votes.map((v) => `<li class="spread"><span>${esc(v.label)}</span><span class="small">${v.tally.yes}–${v.tally.no}–${v.tally.abstain} <span class="pill ${v.result}">${esc(v.result)}</span></span></li>`).join('')}</ul></div>` : ''}
        <details class="card"><summary><strong>Other timer</strong> <span class="small muted">recess, caucus…</span></summary>
          <form class="row" data-form="d-custom-timer" data-scope="chamber" style="margin-top:8px">
            <input name="label" placeholder="Label, e.g. Recess" style="width:auto;flex:2;min-width:120px"><input name="minutes" type="number" min="0.25" step="0.25" placeholder="Minutes" style="width:auto;flex:1;min-width:80px">
            <button class="sm">Set</button></form></details>`;
}

// ---------- Live dashboard (judges, the PO, admins, and competitors' practice) ----------
// One screen for the round: timer and who has the floor, score and note the speech and its questions in place,
// the roster in precedence order with Speech and Question buttons, and a feed of everything so far.
function liveCtx(mode) {
  const s = state, c = s.chamber, m = s.me, self = c.floor_mode === 'self';
  const speeches = allSpeeches();
  const questions = [...s.questions, ...(s.my_questions || [])].sort((a, b) => a.asked_at - b.asked_at);
  const curId = self ? myTimer()?.speech_id : c.current_speech_id;
  const cur = speeches.find((x) => x.id === curId) || null;
  const locked = !!(m.isJudge && s.my_ballot?.submitted_at);
  const canMark = self ? (m.isJudge || m.isCompetitor) && !locked : m.canChair;
  const scoreMode = mode === 'practice' ? 'practice' : (mode === 'judge' && m.isJudge ? 'judge' : null);
  const cfg = scoreMode ? ballotCfg(scoreMode) : null;
  return { mode, s, c, m, self, speeches, questions, cur, canMark, cfg, locked, timer: self ? myTimer() : c.timer };
}
const canScoreSpeech = (x, sp) => x.cfg && !(x.cfg.mode === 'practice' && sp.speaker_id === x.m.id);
const canScoreQuestion = (x, q) => x.cfg && q.questioner_id !== x.m.id;
function noteValue(kind, id, saved) { return saved ?? ui.notes?.[`${kind}${id}`] ?? ''; }

function liveSide(x) {
  if (ui.markSide) return ui.markSide;
  return x.self ? trackGuessSide() : (x.c.next_side || 'authorship');
}
function liveNow(x) {
  const { c, s, self, cur, canMark, timer: t } = x;
  const leg = currentLeg();
  const qSecs = cur && ['authorship', 'sponsorship'].includes(cur.side) ? c.authorship_question_seconds : c.question_seconds;
  const bill = self ? trackBill() : null;
  const billHtml = self
    ? `<div class="now-bill-pick"><select data-track="bill" aria-label="Bill" ${canMark ? '' : 'disabled'}>${s.legislation.map((l) => `<option value="${l.id}" ${bill === String(l.id) ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}<option value="other" ${bill === 'other' ? 'selected' : ''}>${s.legislation.length ? 'Another bill…' : 'Type the bill name'}</option></select>
       ${bill === 'other' ? `<input data-track="topic" value="${esc(trackTopic())}" placeholder="Bill name" aria-label="Bill name">` : ''}</div>`
    : `<div class="now-bill">${leg ? esc(leg.title) : 'No item on the floor'}</div>`;
  const ctl = (act, label, cls = '', extra = '') => `<button class="${cls}" data-act="${act}" ${self ? '' : 'data-scope="chamber"'} ${extra}>${label}</button>`;
  const controls = !canMark ? '' : `<div class="now-controls">
      ${t ? ctl(self ? 'track-timer' : 'd-timer', t.running ? 'Pause' : 'Start', t.running ? '' : 'primary', `data-a="${t.running ? 'pause' : 'resume'}" title="Space bar"`) : ''}
      ${cur && t?.label === 'Speech' ? ctl(self ? 'track-questioning' : 'd-questioning', `Questioning · ${fmtSecs(qSecs)}`) : ''}
      ${cur ? ctl(self ? 'track-end' : 'd-end', 'End speech') : (t ? (self ? ctl('track-end', 'Clear timer') : ctl('d-timer', 'Reset', '', 'data-a="reset"')) : '')}
    </div>`;
  return `<div class="now-card ${cur ? cur.side : ''}">
    <div class="now-head"><span class="eyebrow">${self ? 'Bill' : (leg ? `Now debating · ${esc(leg.kind)}` : 'Floor')}</span>${billHtml}</div>
    <div class="now-body">
      <div class="now-who">
        ${cur ? `<span class="pill ${cur.side}">${SIDE_LABEL[cur.side]}</span><div class="now-name">${esc(cur.speaker_name)}</div>` : `<div class="now-name dim">Floor is open</div>`}
        <div class="small now-sub">${t ? `${esc(t.label)}${t.running ? '' : ' · paused'}` : (canMark ? 'Tap <b>Speech</b> beside a name to start' : 'Waiting for the next speaker')}</div>
      </div>
      <div class="now-timer">${timerHtml(t)}</div>
    </div>
    ${controls}
  </div>`;
}
function liveScoreSpeech(x, sp) {
  const cfg = x.cfg, sc = cfg.scores[sp.id], note = noteValue('s', sp.id, sc?.comment);
  return `<div class="score-block">
    <div class="spread"><h3>Score ${esc(sp.speaker_name)}'s speech</h3>${sc ? `<span class="pill saved">${sc.points} pts</span>` : '<span class="pill warn">Not scored</span>'}</div>
    ${scoreButtons(sc?.points, `data-act="score" data-mode="${cfg.mode}" data-id="${sp.id}"`, cfg.locked)}
    <div class="chips">${CHIPS.map((ch) => `<button class="chip ${note.includes(ch) ? 'on' : ''}" data-act="chip" data-mode="${cfg.mode}" data-id="${sp.id}" data-chip="${ch}" ${cfg.locked ? 'disabled' : ''}>${ch}</button>`).join('')}</div>
    <textarea data-comment-for="${sp.id}" data-mode="${cfg.mode}" placeholder="${cfg.mode === 'judge' ? 'Note for this speech (the competitor sees it only if you publish your ballot)' : 'Your note (only you see it)'}" ${cfg.locked ? 'disabled' : ''}>${esc(note)}</textarea>
  </div>`;
}
function liveQuestion(x, q, compact) {
  const sc = x.s.my_question_scores?.[q.id], scorable = canScoreQuestion(x, q);
  const note = noteValue('q', q.id, sc?.comment);
  const undo = x.canMark ? (q.logged_by ? `<button class="sm ghost" data-act="myq-delete" data-id="${q.id}" title="Remove">✕</button>` : (x.m.canChair ? `<button class="sm ghost" data-act="del-question" data-id="${q.id}" title="Remove">✕</button>` : '')) : '';
  const opts = (cur) => `<option value="">pts</option>${Array.from({ length: x.c.score_max - x.c.score_min + 1 }, (_, i) => x.c.score_min + i).map((p) => `<option ${cur === p ? 'selected' : ''}>${p}</option>`).join('')}`;
  return `<div class="q-row">
    <div class="q-line"><span class="q-tag">Q</span><strong>${esc(q.questioner_name)}</strong><span class="small muted">${fmtTime(q.asked_at)}</span>
      <span class="q-actions">${scorable ? (compact
        ? `<select class="pts" data-grid-question="${q.id}" ${x.cfg.locked ? 'disabled' : ''} aria-label="Points for ${esc(q.questioner_name)}'s question">${opts(sc?.points)}</select>`
        : scoreButtons(sc?.points, `data-act="qscore" data-id="${q.id}"`, x.cfg.locked).replace('score-buttons', 'score-buttons mini')) : ''}${undo}</span></div>
    ${scorable ? `<details class="note" ${note && !compact ? 'open' : ''}><summary class="small">${note ? `Note: ${esc(note.length > 60 ? note.slice(0, 60) + '…' : note)}` : 'Add a note'}</summary>
      <textarea data-qcomment-for="${q.id}" placeholder="Note on this question" ${x.cfg.locked ? 'disabled' : ''}>${esc(note)}</textarea></details>` : ''}
  </div>`;
}
function liveCurrentPanel(x) {
  const { cur } = x;
  if (!cur) return '';
  const qs = x.questions.filter((q) => q.speech_id === cur.id);
  const scoreSp = canScoreSpeech(x, cur);
  if (!scoreSp && !qs.length && !x.canMark) return '';
  return `<div class="card live-panel">
    ${scoreSp ? liveScoreSpeech(x, cur) : ''}
    <div class="q-block"><div class="spread"><h3>Questions ${qs.length ? `<span class="muted">${qs.length}</span>` : ''}</h3>
      ${x.canMark ? '<span class="small muted">Tap <b>Q</b> beside a name to log a questioner</span>' : ''}</div>
      ${qs.length ? qs.map((q) => liveQuestion(x, q, false)).join('') : '<p class="small muted" style="margin:0">No questions yet.</p>'}</div>
  </div>`;
}
function liveFeed(x) {
  const list = [...x.speeches].reverse().filter((sp) => sp !== x.cur);
  const opts = (cur) => `<option value="">pts</option>${Array.from({ length: x.c.score_max - x.c.score_min + 1 }, (_, i) => x.c.score_min + i).map((p) => `<option ${cur === p ? 'selected' : ''}>${p}</option>`).join('')}`;
  const unscored = x.cfg ? list.filter((sp) => canScoreSpeech(x, sp) && !x.cfg.scores[sp.id]).length : 0;
  return `<div class="card feed"><div class="spread"><h2>This round</h2>${unscored ? `<span class="pill warn">${unscored} to score</span>` : ''}</div>
    ${list.length ? list.map((sp) => {
      const sc = x.cfg?.scores[sp.id], qs = x.questions.filter((q) => q.speech_id === sp.id), note = noteValue('s', sp.id, sc?.comment);
      const scorable = canScoreSpeech(x, sp);
      return `<div class="feed-item ${scorable && !sc ? 'unscored' : ''}">
        <div class="feed-line"><span class="pill ${sp.side}">${SIDE_LABEL[sp.side].slice(0, sp.side === 'authorship' ? 4 : 3)}</span>
          <div class="feed-main"><strong>${esc(sp.speaker_name)}</strong><div class="small muted">${esc(sp.legislation_title)} · ${fmtTime(sp.recognized_at)}${sp.duration_seconds != null ? ` · ${fmtSecs(sp.duration_seconds)}` : ''}</div></div>
          ${scorable ? `<select class="pts" data-grid-speech="${sp.id}" data-mode="${x.cfg.mode}" ${x.cfg.locked ? 'disabled' : ''} aria-label="Points for ${esc(sp.speaker_name)}">${opts(sc?.points)}</select>` : ''}
          ${!sp.mine && x.m.canChair && !x.self ? `<button class="sm ghost" data-act="del-speech" data-id="${sp.id}" title="Remove from the record">✕</button>` : ''}</div>
        ${scorable ? `<details class="note"><summary class="small">${note ? `Note: ${esc(note.length > 70 ? note.slice(0, 70) + '…' : note)}` : 'Add a note'}</summary>
          <div class="chips">${CHIPS.map((ch) => `<button class="chip ${note.includes(ch) ? 'on' : ''}" data-act="chip" data-mode="${x.cfg.mode}" data-id="${sp.id}" data-chip="${ch}" ${x.cfg.locked ? 'disabled' : ''}>${ch}</button>`).join('')}</div>
          <textarea data-comment-for="${sp.id}" data-mode="${x.cfg.mode}" ${x.cfg.locked ? 'disabled' : ''}>${esc(note)}</textarea></details>` : ''}
        ${qs.length ? `<div class="feed-qs">${qs.map((q) => liveQuestion(x, q, true)).join('')}</div>` : ''}
        ${sp.mine && !x.locked ? logFixer(sp) : ''}
      </div>`;
    }).join('') : `<p class="muted">${x.cur ? 'Earlier speeches show up here.' : 'Nothing yet. Speeches and questions show up here as they happen.'}</p>`}
  </div>`;
}
// Questioning precedence from this person's own log.
function myQPrecedence() {
  const stats = new Map(state.competitors.map((p) => [p.id, { n: 0, last: -1 }]));
  for (const q of state.my_questions || []) { const st = stats.get(q.questioner_id); if (st) { st.n += 1; st.last = q.asked_at; } }
  return state.competitors.filter((p) => !p.is_po).map((p) => ({ p, ...stats.get(p.id) }))
    .sort((a, b) => (a.n - b.n) || (a.last - b.last) || ((a.p.seat ?? 0) - (b.p.seat ?? 0)));
}
function liveRoster(x) {
  const { s, self, cur, canMark } = x;
  const kind = ui.dashList === 'question' ? 'question' : 'speak';
  const chairQueue = !self && x.m.canChair;
  let order;
  const counts = new Map();
  if (self) {
    const sp = myPrecedence(), qp = myQPrecedence();
    for (const r of sp) counts.set(r.p.id, { s: r.n, q: 0 });
    for (const r of qp) counts.get(r.p.id).q = r.n;
    order = (kind === 'speak' ? sp : qp).map((r) => r.p.id);
  } else {
    for (const p of s.competitors) counts.set(p.id, { s: p.speeches, q: p.questions });
    order = kind === 'speak' ? s.speaking_precedence : s.question_precedence;
  }
  const side = liveSide(x);
  const canSpeech = canMark && (self || x.c.current_legislation_id);
  const rule = kind === 'speak' ? s.speaking_rule_order : s.question_rule_order;
  const adjusted = chairQueue && JSON.stringify(order) !== JSON.stringify(rule);
  const standing = (id) => s.requests.filter((r) => r.user_id === id).map((r) => r.kind);
  return `<div class="card roster">
    <div class="spread"><h2>Chamber</h2>
      <div class="seg small-seg"><button class="${kind === 'speak' ? 'on' : ''}" data-act="d-list" data-kind="speak">Speaking order</button><button class="${kind === 'question' ? 'on' : ''}" data-act="d-list" data-kind="question">Questioning order</button></div></div>
    ${canMark ? `<div class="side-pick"><span class="small muted">Next speech</span><div class="seg">${['authorship', 'aff', 'neg'].map((k) => `<button class="${side === k ? 'on ' + k : ''}" data-act="mark-side" data-side="${k}">${k === 'authorship' ? 'Authorship' : k === 'aff' ? 'Aff' : 'Neg'}</button>`).join('')}</div></div>` : ''}
    ${!self && canMark && !x.c.current_legislation_id ? '<p class="small warn-text">Begin debate on a docket item (below) before recognizing speakers.</p>' : ''}
    <div class="roster-list">${order.map((id, i) => {
      const p = competitor(id); if (!p) return '';
      const n = counts.get(id) || { s: 0, q: 0 }, speaking = cur?.speaker_id === id, st = self ? [] : standing(id);
      return `<div class="roster-row ${speaking ? 'speaking' : ''}" ${chairQueue ? `draggable="true" data-drag-id="${id}"` : ''}>
        <span class="n">${i + 1}</span>
        <span class="who"><strong>${esc(p.display_name)}</strong>${p.school ? `<span class="small muted"> ${esc(p.school)}</span>` : ''}
          ${speaking ? '<span class="pill now-pill">speaking</span>' : ''}${st.map((k) => `<span class="pill ${k === 'question' ? '' : k}">${k === 'question' ? 'wants Q' : 'rose ' + k}</span>`).join('')}</span>
        <span class="counts" title="${n.s} speeches, ${n.q} questions">${n.s}<small>sp</small> ${n.q}<small>q</small></span>
        ${canMark ? `<span class="acts"><button class="sm mark-speech ${side}" data-act="mark-speech" data-id="${id}" ${canSpeech && !speaking ? '' : 'disabled'} title="${SIDE_LABEL[side]} speech">Speech</button><button class="sm mark-q" data-act="mark-question" data-id="${id}" ${cur && !speaking ? '' : 'disabled'} title="${cur ? 'Asked a question' : 'No speech to question yet'}">Q</button></span>` : ''}
      </div>`;
    }).join('') || '<p class="muted">No competitors yet.</p>'}</div>
    ${chairQueue ? `<div class="row roster-foot">${adjusted ? '<span class="small warn-text">Adjusted by hand</span>' : '<span class="small muted">Drag names to adjust</span>'}
      <button class="sm" data-act="d-queue" data-scope="chamber" data-a="reset" ${adjusted ? '' : 'disabled'}>Reset to rule</button>
      <button class="sm" data-act="d-queue" data-scope="chamber" data-a="shuffle">Random draw</button></div>` : ''}
  </div>`;
}
function viewLive(mode) {
  const x = liveCtx(mode), s = x.s;
  const chair = !x.self && x.m.canChair;
  return `
    ${voteBanner()}
    ${chair && s.open_vote ? `<div class="card row"><button class="primary" data-act="close-vote" data-id="${s.open_vote.id}">Close vote and announce result</button>
       <button data-act="cancel-vote" data-id="${s.open_vote.id}">Cancel vote</button></div>` : ''}
    ${x.locked ? `<div class="banner submitted">Ballot submitted. Ask an admin to reopen it to change anything.</div>` : ''}
    ${x.self && mode !== 'chair' ? '<p class="small muted mode-note">No PO in the app for this chamber, so you track the floor yourself. Your log is private to you.</p>' : ''}
    <div class="live">
      <div class="live-main">
        ${liveNow(x)}
        ${liveCurrentPanel(x)}
        ${liveFeed(x)}
        ${mode === 'practice' ? rankingCard(x.cfg) : ''}
      </div>
      <aside class="live-side">
        ${liveRoster(x)}
        ${chair ? chairControls() : ''}
      </aside>
    </div>`;
}

// ---------- Personal tracker (private, saved to the owner's account) ----------
const uid = () => Math.random().toString(36).slice(2, 10);
function blankTracker() {
  return { people: [], speakOrder: [], qOrder: [], speeches: [], questions: [], item: '', currentSpeechId: null, timer: null,
    speechSecs: 180, authQSecs: 120, qSecs: 60 };
}
async function renderTrackerList() {
  const { trackers } = await api('GET', '/api/trackers');
  $view.innerHTML = `<a href="#/">← Home</a><h1>My personal trackers</h1>
    <p class="muted">Use one at any tournament, even one that doesn't use this app. Add the people in your chamber, then track who has spoken, who asked questions, precedence, recency and the timer. Only you can see your trackers.</p>
    <form class="card row" data-form="new-tracker"><input name="name" placeholder="e.g. State Quals, Senate Chamber 2" style="flex:1;min-width:200px" required><button class="primary">Start a tracker</button></form>
    <div class="card">${trackers.length ? `<ul class="list">${trackers.map((t) => `<li class="spread"><a href="#/tracker/${t.id}"><strong>${esc(t.name)}</strong></a>
      <span class="row"><span class="small muted">Updated ${new Date(t.updated_at).toLocaleDateString()}</span><button class="sm ghost" data-act="tr-delete" data-id="${t.id}" data-name="${esc(t.name)}">Delete</button></span></li>`).join('')}</ul>` : '<p class="muted">No trackers yet.</p>'}</div>`;
}
async function openTracker(id) {
  try {
    const t = await api('GET', `/api/trackers/${id}`);
    tracker = { id: t.id, name: t.name, data: { ...blankTracker(), ...t.data } };
    renderTracker();
  } catch (e) { $view.innerHTML = `<div class="card"><p>${esc(e.message)}</p><a href="#/tracker">Back</a></div>`; }
}
let saveTimer = null;
function saveTracker() {
  clearTimeout(saveTimer);
  const t = tracker;
  saveTimer = setTimeout(() => api('PUT', `/api/trackers/${t.id}`, { name: t.name, data: t.data }).catch((e) => toast(`Not saved: ${e.message}`, true)), 400);
}
function trStats() {
  const d = tracker.data, st = new Map(d.people.map((p) => [p.id, { speeches: 0, questions: 0, lastSpeech: null, lastQuestion: null }]));
  for (const x of d.speeches) { const r = st.get(x.pid); if (r) { r.speeches++; r.lastSpeech = Math.max(r.lastSpeech || 0, x.at); } }
  for (const x of d.questions) { const r = st.get(x.pid); if (r) { r.questions++; r.lastQuestion = Math.max(r.lastQuestion || 0, x.at); } }
  return st;
}
function trRuleOrder(kind) {
  const d = tracker.data, st = trStats(), seat = new Map(d.people.map((p, i) => [p.id, i]));
  const ck = kind === 'speak' ? 'speeches' : 'questions', lk = kind === 'speak' ? 'lastSpeech' : 'lastQuestion';
  return d.people.map((p) => p.id).sort((a, b) => (st.get(a)[ck] - st.get(b)[ck]) || ((st.get(a)[lk] ?? -1) - (st.get(b)[lk] ?? -1)) || (seat.get(a) - seat.get(b)));
}
function trSync() {
  // Keep the stored orders consistent with the people list.
  const d = tracker.data, ids = new Set(d.people.map((p) => p.id));
  for (const k of ['speakOrder', 'qOrder']) {
    d[k] = d[k].filter((id) => ids.has(id));
    for (const id of trRuleOrder(k === 'speakOrder' ? 'speak' : 'question')) if (!d[k].includes(id)) d[k].push(id);
  }
}
function trCurrentSpeech() { const d = tracker.data; return d.currentSpeechId ? d.speeches.find((x) => x.id === d.currentSpeechId) : null; }
function trNextSide() {
  const d = tracker.data;
  if (!d.item) return null;
  const onItem = d.speeches.filter((x) => x.item === d.item);
  const last = onItem[onItem.length - 1];
  return !last ? 'authorship' : (last.side === 'neg' ? 'aff' : 'neg');
}
function trSetTimer(label, secs) { tracker.data.timer = { label, duration: secs, started_at: Date.now(), elapsed_ms: 0, running: true }; }
function renderTracker() {
  document.body.classList.add('wide');
  trSync();
  const d = tracker.data, st = trStats(), sp = trCurrentSpeech();
  const name = (id) => d.people.find((p) => p.id === id)?.name || '(removed)';
  const model = {
    scope: 'tracker', timer: d.timer, title: d.item, nextSide: d.item ? trNextSide() : null,
    speaker: sp ? { name: name(sp.pid), side: sp.side } : null,
    qSecs: sp && sp.side === 'authorship' ? d.authQSecs : d.qSecs, canQuestion: !!sp,
    people: d.people.map((p) => ({ id: p.id, name: p.name, school: p.school, ...st.get(p.id), speaking: sp?.pid === p.id, tags: [] })),
    order: { speak: d.speakOrder, question: d.qOrder },
    ruleOrder: { speak: trRuleOrder('speak'), question: trRuleOrder('question') },
  };
  const log = [...d.speeches].reverse();
  const items = [...new Set(d.speeches.map((x) => x.item).filter(Boolean))];
  $view.innerHTML = `
    <div class="spread"><div class="row"><a href="#/tracker">← My trackers</a></div><span class="pill">Private to you</span></div>
    <div class="spread"><h1>${esc(tracker.name)}</h1>
      <form class="row" data-form="tr-item" style="flex:1;max-width:560px"><input name="item" value="${esc(d.item)}" placeholder="What's on the floor? e.g. A Bill to…" list="tr-items" style="flex:1"><datalist id="tr-items">${items.map((i) => `<option value="${esc(i)}">`).join('')}</datalist><button class="sm">Set item</button></form></div>
    <div class="dash">
      <div class="dash-main">${dashList(model)}</div>
      <div class="dash-side">
        ${dashTimer(model)}
        <div class="card"><h2>People in the chamber (${d.people.length})</h2>
          <form data-form="tr-people" class="stack"><textarea name="text" rows="3" placeholder="One per line: Name, School"></textarea><button class="sm primary">Add</button></form>
          ${d.people.length ? `<details style="margin-top:8px"><summary class="small">Remove someone</summary><ul class="list">${d.people.map((p) => `<li class="spread">${esc(p.name)} <button class="sm ghost" data-act="tr-remove-person" data-id="${p.id}">Remove</button></li>`).join('')}</ul></details>` : ''}
        </div>
        <div class="card"><h2>Log</h2>
          ${log.length ? `<ul class="list">${log.slice(0, 40).map((x) => {
            const qs = d.questions.filter((q) => q.speechId === x.id);
            return `<li><div class="spread"><span><span class="pill ${x.side}">${SIDE_LABEL[x.side]}</span> <strong>${esc(name(x.pid))}</strong></span>
              <span class="small muted">${fmtTime(x.at)} <button class="sm ghost" data-act="tr-undo-speech" data-id="${x.id}">Remove</button></span></div>
              ${x.item ? `<div class="small muted">${esc(x.item)}</div>` : ''}
              ${qs.length ? `<div class="small">Questions: ${qs.map((q) => `${esc(name(q.pid))} <button class="sm ghost" data-act="tr-undo-question" data-id="${q.id}" title="Remove">✕</button>`).join(', ')}</div>` : ''}</li>`;
          }).join('')}</ul>` : '<p class="muted small">Speeches you log show up here.</p>'}
        </div>
        <div class="card"><h2>Timer lengths</h2><form data-form="tr-settings" class="inline-fields">
          <div class="field"><label>Speech (sec)</label><input name="speechSecs" type="number" value="${d.speechSecs}"></div>
          <div class="field"><label>Authorship Q (sec)</label><input name="authQSecs" type="number" value="${d.authQSecs}"></div>
          <div class="field"><label>Other Q (sec)</label><input name="qSecs" type="number" value="${d.qSecs}"></div>
          <div><button class="sm">Save</button></div></form>
          <p class="small muted"><button class="sm ghost" data-act="tr-clear">Clear all speeches and questions</button></p>
        </div>
      </div>
    </div>`;
}
// Tracker actions mirror the chamber's server actions, but run locally and save privately.
const trackerOps = {
  recognize(id, side) {
    const d = tracker.data;
    if (!d.item) { toast('Set what is on the floor first.', true); return; }
    const sp = { id: uid(), pid: id, side, at: Date.now(), item: d.item };
    d.speeches.push(sp); d.currentSpeechId = sp.id;
    d.speakOrder = [...d.speakOrder.filter((x) => x !== id), id];
    trSetTimer('Speech', d.speechSecs);
  },
  question(id) {
    const d = tracker.data;
    if (!d.currentSpeechId) return;
    d.questions.push({ id: uid(), pid: id, at: Date.now(), speechId: d.currentSpeechId });
    d.qOrder = [...d.qOrder.filter((x) => x !== id), id];
  },
  questioning() { const d = tracker.data, sp = trCurrentSpeech(); if (sp) trSetTimer('Questioning', sp.side === 'authorship' ? d.authQSecs : d.qSecs); },
  end() { tracker.data.currentSpeechId = null; tracker.data.timer = null; },
  timer(a) {
    const t = tracker.data.timer; if (!t) return;
    if (a === 'pause' && t.running) { t.elapsed_ms += Date.now() - t.started_at; t.running = false; }
    else if (a === 'resume' && !t.running) { t.started_at = Date.now(); t.running = true; }
    else if (a === 'reset') { t.elapsed_ms = 0; t.running = false; }
  },
  custom(label, secs) { trSetTimer(label, secs); },
  queue(kind, a, ids) {
    const d = tracker.data, key = kind === 'speak' ? 'speakOrder' : 'qOrder';
    if (a === 'reset') d[key] = trRuleOrder(kind);
    else if (a === 'shuffle') {
      const st = trStats(), ck = kind === 'speak' ? 'speeches' : 'questions', lk = kind === 'speak' ? 'lastSpeech' : 'lastQuestion';
      const r = new Map(d.people.map((p) => [p.id, Math.random()]));
      d[key] = d.people.map((p) => p.id).sort((a2, b) => (st.get(a2)[ck] - st.get(b)[ck]) || ((st.get(a2)[lk] ?? -1) - (st.get(b)[lk] ?? -1)) || (r.get(a2) - r.get(b)));
    } else if (a === 'set') d[key] = ids;
  },
};
function trackerDo(fn) { fn(); saveTracker(); renderTracker(); }

// Dispatch dashboard actions to the chamber (server) or the personal tracker (local).
async function dashAction(scope, op, ...args) {
  if (scope === 'tracker') return trackerDo(() => trackerOps[op](...args));
  const [a, b, c2] = args;
  switch (op) {
    case 'recognize': return act('POST', C('/recognize'), { user_id: a, side: b }, `Recognized ${competitor(a)?.display_name}`);
    case 'question': return act('POST', C('/questions'), { user_id: a });
    case 'questioning': return act('POST', C('/questioning'));
    case 'end': return act('POST', C('/speech/end'));
    case 'timer': return act('POST', C('/timer'), { action: a });
    case 'custom': return act('POST', C('/timer'), { action: 'custom', label: a, seconds: b });
    case 'queue': return act('POST', C('/queue'), { kind: a, action: b, ids: c2 });
  }
}
function dashOrder() {
  if (tracker) return [...(ui.dashList === 'speak' ? tracker.data.speakOrder : tracker.data.qOrder)];
  return [...(ui.dashList === 'speak' ? state.speaking_precedence : state.question_precedence)];
}
function dashScope() { return tracker ? 'tracker' : 'chamber'; }

// Drag and drop rows on the dashboard list.
let dragId = null;
document.addEventListener('dragstart', (e) => {
  const tr = e.target.closest?.('[data-drag-id]');
  if (!tr) return;
  dragId = tr.dataset.dragId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  tr.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  const tr = e.target.closest?.('[data-drag-id]');
  if (!tr || dragId == null) return;
  e.preventDefault();
  document.querySelectorAll('.drop-above,.drop-below').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
  const r = tr.getBoundingClientRect();
  tr.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
});
document.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.dragging,.drop-above,.drop-below').forEach((x) => x.classList.remove('dragging', 'drop-above', 'drop-below')); });
document.addEventListener('drop', (e) => {
  const tr = e.target.closest?.('[data-drag-id]');
  if (!tr || dragId == null) return;
  e.preventDefault();
  const scope = dashScope(), parse = (v) => (scope === 'tracker' ? v : Number(v));
  const moving = parse(dragId), target = parse(tr.dataset.dragId);
  const below = tr.classList.contains('drop-below');
  dragId = null;
  if (moving === target) return;
  const ids = dashOrder().filter((x) => x !== moving);
  ids.splice(ids.indexOf(target) + (below ? 1 : 0), 0, moving);
  dashAction(scope, 'queue', ui.dashList, 'set', ids);
});
// Space bar starts/pauses the timer on a dashboard.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || isTyping() || e.target.closest?.('button,a,summary')) return;
  const self = selfTracking();
  const onDash = tracker || self || (state && ['live', ''].includes(currentTab()) && state.me.canChair);
  const t = activeTimer().t;
  if (!onDash || !t) return;
  e.preventDefault();
  if (self) document.querySelector('[data-act="track-timer"]')?.click();
  else dashAction(dashScope(), 'timer', t.running ? 'pause' : 'resume');
});

// ---------- Judge scoring ----------
function scoreButtons(current, attrs) {
  const c = state.chamber, out = [];
  for (let p = c.score_min; p <= c.score_max; p++) out.push(`<button class="${current === p ? 'on' : ''}" ${attrs} data-points="${p}">${p}</button>`);
  return `<div class="score-buttons">${out.join('')}</div>`;
}
// ---------- tracking the floor yourself (no PO in the app) ----------
// Each judge or competitor keeps a private speech log; the timer runs on this device.
function selfTracking() {
  return !!(state && !tracker && state.chamber.floor_mode === 'self' && ['live', 'practice', ''].includes(currentTab()));
}
function allSpeeches() {
  return [...state.speeches, ...(state.my_log || [])].sort((a, b) => a.recognized_at - b.recognized_at);
}
const timerKey = () => `congress.timer.${chamberId}.${state?.me?.id}`;
let timerMem = {};
function myTimer() {
  try { const v = localStorage.getItem(timerKey()); if (v) return JSON.parse(v); if (v === null && !(timerKey() in timerMem)) return null; } catch { /* storage blocked */ }
  return timerMem[timerKey()] || null;
}
function setMyTimer(t) {
  timerMem[timerKey()] = t;
  try { if (t) localStorage.setItem(timerKey(), JSON.stringify(t)); else localStorage.removeItem(timerKey()); } catch { /* keep it in memory */ }
}
function startMyTimer(label, secs, speechId) { setMyTimer({ label, duration: secs, started_at: Date.now(), elapsed_ms: 0, running: true, speech_id: speechId ?? myTimer()?.speech_id ?? null }); }
// Save how long the current speech ran, the first time its speech timer stops.
async function closeMySpeechTime() {
  const t = myTimer();
  if (!t || t.label !== 'Speech' || !t.speech_id) return;
  const secs = Math.round(t.duration - timerRemaining(t, 0));
  try { await api('PUT', C(`/my-log/${t.speech_id}`), { duration_seconds: secs }); } catch { /* speech was removed */ }
}
function trackBill() {
  const s = state, log = s.my_log || [];
  if (ui.trackBill !== undefined) return ui.trackBill;
  const last = log[log.length - 1];
  if (last) return last.legislation_id ? String(last.legislation_id) : 'other';
  const open = s.legislation.find((l) => l.status === 'debating') || s.legislation.find((l) => l.status === 'pending');
  return open ? String(open.id) : 'other';
}
function trackTopic() {
  if (ui.trackTopic !== undefined) return ui.trackTopic;
  const log = state.my_log || [], last = log[log.length - 1];
  return last && !last.legislation_id ? last.topic : '';
}
function trackGuessSide() {
  const bill = trackBill(), topic = trackTopic();
  const on = (state.my_log || []).filter((x) => (bill === 'other' ? !x.legislation_id && x.topic === topic : String(x.legislation_id) === bill));
  const last = on[on.length - 1];
  return !last ? 'authorship' : (last.side === 'neg' ? 'aff' : 'neg');
}
// Who should speak next by the usual rule, from this person's own log: fewest speeches, then least recent, then seat.
function myPrecedence() {
  const log = state.my_log || [];
  const stats = new Map(state.competitors.map((p) => [p.id, { n: 0, last: -1 }]));
  for (const x of log) { const st = stats.get(x.speaker_id); if (st) { st.n += 1; st.last = x.recognized_at; } }
  return state.competitors.filter((p) => !p.is_po)
    .map((p) => ({ p, ...stats.get(p.id) }))
    .sort((a, b) => (a.n - b.n) || (a.last - b.last) || ((a.p.seat ?? 0) - (b.p.seat ?? 0)));
}
function logFixer(x) {
  const s = state;
  return `<details class="log-fix"><summary class="small muted">Fix this entry</summary>
    <div class="inline-fields" style="margin-top:6px">
      <select data-mylog="${x.id}" data-field="speaker_id">${s.competitors.map((p) => `<option value="${p.id}" ${p.id === x.speaker_id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select>
      <select data-mylog="${x.id}" data-field="side">${['authorship', 'sponsorship', 'aff', 'neg'].map((k) => `<option value="${k}" ${k === x.side ? 'selected' : ''}>${SIDE_LABEL[k]}</option>`).join('')}</select>
      <select data-mylog="${x.id}" data-field="legislation_id"><option value="">${x.topic ? esc(x.topic) : 'No bill picked'}</option>${s.legislation.map((l) => `<option value="${l.id}" ${l.id === x.legislation_id ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}</select>
    </div>
    <button class="sm ghost" data-act="mylog-delete" data-id="${x.id}" style="margin-top:6px">Remove from my log</button></details>`;
}

async function trackSpeaker(id) {
  const bill = trackBill();
  const body = { speaker_id: id, side: ui.trackSide || trackGuessSide(), ...(bill === 'other' ? { topic: trackTopic() } : { legislation_id: Number(bill) }) };
  await closeMySpeechTime();
  const r = await act('POST', C('/my-log'), body);
  if (r) { ui.trackSide = null; ui.markSide = null; startMyTimer('Speech', state.chamber.speech_seconds, r.speech_id); ui.trackBill = bill; await loadState(); }
}
document.addEventListener('track-speaker', (e) => trackSpeaker(e.detail));

// A ballot is the judge's real scoring sheet, or a competitor's practice sheet (same screen, never counted).
const CHIPS = ['Clash', 'Evidence', 'Refutation', 'Delivery', 'Questioning', 'Organization', 'Time'];
function ballotCfg(mode) {
  const s = state;
  return mode === 'judge'
    ? { mode, scores: s.my_scores, saved: s.my_rankings, locked: !!s.my_ballot?.submitted_at,
        speeches: allSpeeches(), scorePath: (id) => C(`/scores/${id}`), rankPath: C('/rankings') }
    : { mode, scores: s.my_practice_scores, saved: s.my_practice_rankings, locked: false,
        speeches: allSpeeches().filter((x) => x.speaker_id !== s.me.id), scorePath: (id) => C(`/practice/scores/${id}`), rankPath: C('/practice/rankings') };
}
function pointsBy(cfg) {
  const tot = new Map();
  for (const x of cfg.speeches) { const sc = cfg.scores[x.id]; if (sc) tot.set(x.speaker_id, (tot.get(x.speaker_id) || 0) + sc.points); }
  if (cfg.mode === 'judge') for (const p of state.my_po_scores) tot.set(p.po_user_id, (tot.get(p.po_user_id) || 0) + p.points);
  return tot;
}
function suggestedRanking(cfg) {
  const tot = pointsBy(cfg);
  return [...tot.entries()].filter(([id]) => cfg.mode === 'judge' || id !== state.me.id)
    .sort((a, b) => (b[1] - a[1]) || (competitor(a[0])?.display_name || '').localeCompare(competitor(b[0])?.display_name || ''))
    .slice(0, state.chamber.rank_count).map(([id]) => id);
}
function scoreButtons(current, attrs, disabled) {
  const c = state.chamber, out = [];
  for (let p = c.score_min; p <= c.score_max; p++) out.push(`<button class="${current === p ? 'on' : ''}" ${attrs} data-points="${p}" ${disabled ? 'disabled' : ''}>${p}</button>`);
  return `<div class="score-buttons">${out.join('')}</div>`;
}
function speechCard(cfg, x, now) {
  const sc = cfg.scores[x.id], c = state.chamber;
  const comment = noteValue('s', x.id, sc?.comment);
  return `<div class="card ${sc ? '' : 'unscored'} ${now ? 'now' : ''}" style="margin-bottom:10px">
    <div class="spread"><div>${now ? '<span class="pill debating">Speaking now</span> ' : ''}<strong>${esc(x.speaker_name)}</strong> <span class="pill ${x.side}">${SIDE_LABEL[x.side]}</span></div>
    <span class="small muted">${fmtTime(x.recognized_at)}${x.duration_seconds != null ? ` · ${fmtSecs(x.duration_seconds)}` : ''}</span></div>
    <div class="small muted" style="margin:4px 0 8px">${esc(x.legislation_title)}</div>
    ${scoreButtons(sc?.points, `data-act="score" data-mode="${cfg.mode}" data-id="${x.id}"`, cfg.locked)}
    <div class="chips">${CHIPS.map((ch) => `<button class="chip ${comment.includes(ch) ? 'on' : ''}" data-act="chip" data-mode="${cfg.mode}" data-id="${x.id}" data-chip="${ch}" ${cfg.locked ? 'disabled' : ''}>${ch}</button>`).join('')}</div>
    <textarea data-comment-for="${x.id}" data-mode="${cfg.mode}" placeholder="${cfg.mode === 'judge' ? 'Comments for the competitor (optional)' : 'Your notes (only you see these)'}" style="margin-top:8px;min-height:56px" ${cfg.locked ? 'disabled' : ''}>${esc(comment)}</textarea>
    ${x.mine && !cfg.locked ? logFixer(x) : ''}
  </div>`;
}
function ballotGrid(cfg) {
  const s = state, c = s.chamber;
  const people = s.competitors.filter((p) => cfg.mode === 'judge' || p.id !== s.me.id);
  const bySpeaker = new Map(people.map((p) => [p.id, cfg.speeches.filter((x) => x.speaker_id === p.id)]));
  const cols = Math.max(1, ...[...bySpeaker.values()].map((v) => v.length));
  const tot = pointsBy(cfg);
  const opts = (cur) => `<option value="">—</option>${Array.from({ length: c.score_max - c.score_min + 1 }, (_, i) => c.score_min + i).map((p) => `<option ${cur === p ? 'selected' : ''}>${p}</option>`).join('')}`;
  const poScore = (id) => s.my_po_scores?.find((x) => x.po_user_id === id);
  return `<div class="card"><div class="table-wrap"><table class="grid-ballot">
    <tr><th>Competitor</th>${Array.from({ length: cols }, (_, i) => `<th>Speech ${i + 1}</th>`).join('')}${cfg.mode === 'judge' ? '<th>PO</th>' : ''}<th>Total</th></tr>
    ${people.map((p) => `<tr><td><strong>${esc(p.display_name)}</strong>${p.is_po ? ' <span class="pill">PO</span>' : ''}<div class="small muted">${esc(p.school)}</div></td>
      ${Array.from({ length: cols }, (_, i) => { const x = bySpeaker.get(p.id)[i]; if (!x) return '<td></td>';
        const sc = cfg.scores[x.id];
        return `<td class="${sc ? '' : 'missing'}"><select data-grid-speech="${x.id}" data-mode="${cfg.mode}" ${cfg.locked ? 'disabled' : ''} title="${esc(x.legislation_title)} · ${SIDE_LABEL[x.side]}">${opts(sc?.points)}</select><div class="small muted">${SIDE_LABEL[x.side].slice(0, 3)}</div></td>`; }).join('')}
      ${cfg.mode === 'judge' ? `<td>${p.is_po || poScore(p.id) ? `<select data-grid-po="${p.id}" ${cfg.locked ? 'disabled' : ''}>${opts(poScore(p.id)?.points)}</select>` : ''}</td>` : ''}
      <td class="num"><strong>${tot.get(p.id) || 0}</strong></td></tr>`).join('')}
  </table></div><p class="small muted">Pick points in each box; they save right away. Switch to List to add comments.</p></div>`;
}
function rankingCard(cfg) {
  const s = state, c = s.chamber;
  const suggested = ui.rankDraft === null;
  const draft = ui.rankDraft ?? suggestedRanking(cfg);
  const rankable = s.competitors.filter((p) => cfg.mode === 'judge' || p.id !== s.me.id);
  const dis = cfg.locked ? 'disabled' : '';
  return `<div class="card"><h2>${cfg.mode === 'judge' ? 'Final ranking' : 'Your ranking'} (top ${c.rank_count})</h2>
    <p class="small muted">${suggested && draft.length ? 'Suggested from your points. Adjust it, then save.' : 'Best first. Tap names to add them; the PO can be ranked too.'}</p>
    <ol>${draft.map((id, i) => `<li class="spread" style="padding:4px 0"><span>${esc(competitor(id)?.display_name)}</span>
      <span class="row"><button class="sm ghost" data-act="rank-up" data-i="${i}" ${i === 0 || cfg.locked ? 'disabled' : ''}>↑</button><button class="sm ghost" data-act="rank-remove" data-i="${i}" ${dis}>✕</button></span></li>`).join('')}</ol>
    <div class="row">${rankable.filter((p) => !draft.includes(p.id)).map((p) => `<button class="sm" data-act="rank-add" data-id="${p.id}" ${draft.length >= c.rank_count || cfg.locked ? 'disabled' : ''}>${esc(p.display_name)}${p.is_po ? ' (PO)' : ''}</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><button class="primary" data-act="save-ranks" data-mode="${cfg.mode}" ${dis}>Save ranking</button>
      <button class="sm" data-act="rank-fill" ${dis}>Fill from my points</button>
      ${JSON.stringify(draft) !== JSON.stringify(cfg.saved) ? '<span class="small muted">Not saved yet</span>' : (cfg.saved.length ? '<span class="small muted">Saved</span>' : '')}</div>
  </div>`;
}
const PUBLISH_LABEL = { private: 'Private', individual: 'Each competitor sees their own scores', all: 'Everyone sees totals and rankings' };
function publishSelect(attrs, value) {
  return `<select ${attrs}>${Object.entries(PUBLISH_LABEL).map(([k, v]) => `<option value="${k}" ${value === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
}
function viewBallot(mode) {
  const s = state, c = s.chamber, cfg = ballotCfg(mode);
  const view = ui.ballotView || 'list';
  const nowId = c.floor_mode === 'self' ? myTimer()?.speech_id : c.current_speech_id;
  const now = cfg.speeches.find((x) => x.id === nowId);
  const rest = [...cfg.speeches].reverse().filter((x) => x !== now);
  const unscored = cfg.speeches.filter((x) => !cfg.scores[x.id]).length;
  const b = s.my_ballot;
  const poScores = new Map((s.my_po_scores || []).map((x) => [x.po_user_id, x]));
  const pos = mode === 'judge' ? [...new Set([c.po_user_id, ...s.my_po_scores.map((x) => x.po_user_id)].filter(Boolean))] : [];
  return `
    <div class="spread"><p class="muted small" style="margin:0">${mode === 'judge'
      ? `Points ${c.score_min}–${c.score_max}. Your scores stay private unless you or an admin publish them.`
      : `Score speeches the way a judge would, then compare after results are published. This never counts, and only you can see it.`}</p>
      <div class="seg"><button class="${view === 'list' ? 'on' : ''}" data-act="ballot-view" data-v="list">List</button><button class="${view === 'grid' ? 'on' : ''}" data-act="ballot-view" data-v="grid">Grid</button></div></div>
    ${mode === 'judge' && b.submitted_at ? `<div class="banner submitted">Ballot submitted at ${fmtTime(b.submitted_at)}. Ask an admin to reopen it if you need to change something.</div>` : ''}
    <div class="grid side" style="margin-top:12px">
      <div>
        ${view === 'grid' ? ballotGrid(cfg) : `
          ${now ? speechCard(cfg, now, true) : ''}
          <div class="card"><h2>Speeches ${unscored ? `<span class="pill debating">${unscored} to score</span>` : ''}</h2>
          ${rest.length ? rest.map((x) => speechCard(cfg, x, false)).join('') : (now ? '' : `<p class="muted">${c.floor_mode === 'self' ? 'Tap a name above when someone gets the floor, and their speech shows up here to score.' : 'Speeches appear here as soon as the PO recognizes someone.'}</p>`)}
          </div>`}
      </div>
      <div>
        ${mode === 'judge' ? `<div class="card"><h2>Presiding officer</h2>
          ${pos.length ? pos.map((id) => { const sc = poScores.get(id); const p = competitor(id); return `
            <div style="margin-bottom:10px"><strong>${esc(p?.display_name || 'PO')}</strong>
            ${scoreButtons(sc?.points, `data-act="po-score" data-id="${id}"`, cfg.locked)}
            <textarea data-po-comment-for="${id}" placeholder="Comments on presiding (optional)" style="margin-top:8px;min-height:56px" ${cfg.locked ? 'disabled' : ''}>${esc(sc?.comment || '')}</textarea></div>`; }).join('')
          : '<p class="muted">No presiding officer assigned yet.</p>'}
        </div>` : ''}
        ${rankingCard(cfg)}
        ${mode === 'judge' ? `<div class="card"><h2>Finish</h2>
          ${b.submitted_at ? '<p class="small">Submitted. Thank you!</p>' : `<p class="small muted">${unscored ? `${unscored} speech${unscored === 1 ? '' : 'es'} still unscored. ` : ''}Submitting locks your ballot.</p>
            <button class="primary" data-act="submit-ballot">Submit ballot</button>`}
          <h3>Share my ballot</h3>
          ${publishSelect('data-publish="ballot"', b.publish)}
          <p class="small muted">Each competitor sees only your points and comments on their own speeches. "Everyone" also shows all point totals and your ranking, but never other people's comments.</p>
        </div>` : ''}
      </div>
    </div>`;
}

// ---------- Reflection (competitors) ----------
function viewReflection() {
  const r = ui.reflection, s = state;
  if (!r) { api('GET', C('/reflection')).then((x) => { ui.reflection = x; render(); }).catch((e) => toast(e.message, true)); return '<p class="muted">Loading…</p>'; }
  const name = (id) => competitor(id)?.display_name || '—';
  const speech = (id) => s.speeches.find((x) => x.id === id);
  const mine = r.practice;
  const myPoints = new Map();
  for (const x of mine.scores) { const e = myPoints.get(x.speaker_id) || []; e.push(x.points); myPoints.set(x.speaker_id, e); }
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const allBallots = r.ballots.filter((b) => b.level === 'all');
  const official = r.standings?.level === 'all' ? r.standings.rows : null;
  const nothing = !r.ballots.length && !r.standings;
  // Compare my practice ranking with the official order.
  let agreement = '';
  if (official && mine.ranking.length) {
    const top = new Set(official.slice(0, r.rank_count).map((x) => x.id));
    const hits = mine.ranking.filter((id) => top.has(id)).length;
    agreement = `<p><strong>${hits} of your ${mine.ranking.length}</strong> ranked competitors finished in the official top ${r.rank_count}.</p>`;
  }
  return `
    ${nothing ? '<div class="card"><p class="muted" style="margin:0">Nothing has been published yet. When a judge or your tournament admin shares results, they show up here next to your practice ballot.</p></div>' : ''}
    <div class="grid two">
      <div>
        ${r.ballots.length ? `<div class="card"><h2>Feedback on your speeches</h2>
          ${r.ballots.map((b) => `<h3>${esc(b.judge_name)}${b.my_rank ? ` <span class="pill">ranked you #${b.my_rank}</span>` : ''}</h3>
            ${b.my_scores.length ? `<ul class="list">${b.my_scores.map((x) => { const sp = speech(x.speech_id); return `<li><div class="spread"><span>${sp ? `<span class="pill ${sp.side}">${SIDE_LABEL[sp.side]}</span> ${esc(sp.legislation_title)}` : 'Speech'}</span><strong>${x.points} pts</strong></div>${x.comment ? `<div class="small">${esc(x.comment)}</div>` : ''}</li>`; }).join('')}</ul>` : '<p class="small muted">No speech scores from this judge.</p>'}
            ${b.my_po_score ? `<p class="small"><strong>Presiding:</strong> ${b.my_po_score.points} pts${b.my_po_score.comment ? ` · ${esc(b.my_po_score.comment)}` : ''}</p>` : ''}`).join('')}
        </div>` : ''}
        ${r.standings ? `<div class="card"><h2>${r.standings.level === 'all' ? 'Standings' : 'Your result'}</h2>
          <div class="table-wrap"><table><tr><th>Place</th><th>Name</th><th>Points</th><th>Rank sum</th></tr>
          ${r.standings.rows.map((x) => `<tr class="${x.id === s.me.id ? 'me' : ''}"><td>${x.place}${r.standings.level === 'individual' ? ` of ${r.standings.of}` : ''}</td><td>${esc(x.name)}${x.was_po ? ' <span class="pill">PO</span>' : ''}</td><td>${x.total_points}</td><td>${x.rank_total}</td></tr>`).join('')}
          </table></div></div>` : ''}
      </div>
      <div>
        <div class="card"><h2>Your practice ballot</h2>
          ${agreement}
          ${mine.ranking.length ? `<h3>Your ranking</h3><ol>${mine.ranking.map((id) => {
            const off = official?.find((x) => x.id === id);
            return `<li>${esc(name(id))}${off ? ` <span class="small muted">· official place ${off.place}</span>` : ''}</li>`; }).join('')}</ol>` : '<p class="small muted">You have not saved a practice ranking.</p>'}
          ${myPoints.size ? `<h3>Your points by competitor</h3><div class="table-wrap"><table><tr><th>Competitor</th><th>Your avg</th>${allBallots.map((b) => `<th>${esc(b.judge_name)} total</th>`).join('')}</tr>
            ${[...myPoints.entries()].map(([id, pts]) => `<tr><td>${esc(name(id))}</td><td>${avg(pts)} <span class="small muted">(${pts.length})</span></td>${allBallots.map((b) => `<td>${b.totals.find((t) => t.id === id)?.points ?? '—'}</td>`).join('')}</tr>`).join('')}
            </table></div>` : '<p class="small muted">Score speeches on the Practice ballot tab to compare later.</p>'}
          ${allBallots.map((b) => b.ranking?.length ? `<h3>${esc(b.judge_name)}'s ranking</h3><ol>${b.ranking.map((x) => `<li>${esc(x.name)}${mine.ranking.includes(x.id) ? ' <span class="pill passed">you ranked them too</span>' : ''}</li>`).join('')}</ol>` : '').join('')}
        </div>
      </div>
    </div>`;
}

// ---------- Docket ----------
function viewDocket() {
  const s = state, m = s.me;
  const editing = m.isAdmin;
  return `
    <div class="card"><h2>Docket</h2>
    ${s.legislation.length ? `<ul class="list">${s.legislation.map((l, i) => `<li>
      <div class="spread"><div><span class="muted">${i + 1}.</span> <strong>${esc(l.title)}</strong> <span class="pill ${l.status}">${esc(l.status)}</span>
        ${l.vote_yes != null ? `<span class="small muted">${l.vote_yes}–${l.vote_no}–${l.vote_abstain ?? 0}</span>` : ''}</div>
      ${m.canChair ? `<span class="row"><button class="sm ghost" data-act="move-leg" data-id="${l.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="sm ghost" data-act="move-leg" data-id="${l.id}" data-dir="1" ${i === s.legislation.length - 1 ? 'disabled' : ''}>↓</button></span>` : ''}</div>
      <div class="small muted">${esc(l.kind)}${l.author ? ` · ${esc(l.author)}` : ''} · ${s.speeches.filter((x) => x.legislation_id === l.id).length} speeches</div>
      ${l.body ? `<details><summary class="small">Read text</summary><pre class="legtext">${esc(l.body)}</pre></details>` : ''}
      ${editing ? `<details><summary class="small">Edit</summary><form data-form="edit-leg" data-id="${l.id}" class="stack" style="margin-top:8px">
        <input name="title" value="${esc(l.title)}"><div class="inline-fields"><select name="kind"><option value="bill" ${l.kind === 'bill' ? 'selected' : ''}>Bill</option><option value="resolution" ${l.kind === 'resolution' ? 'selected' : ''}>Resolution</option></select>
        <input name="author" value="${esc(l.author)}" placeholder="Author / school"></div><textarea name="body" rows="6">${esc(l.body)}</textarea>
        <div class="row"><button class="sm primary">Save</button><button type="button" class="sm" data-act="delete-leg" data-id="${l.id}">Delete</button></div></form></details>` : ''}
    </li>`).join('')}</ul>` : '<p class="muted">No legislation on the docket yet.</p>'}
    ${m.canChair && s.legislation.length > 1 ? '<p class="small muted">After the chamber votes on docket order, set it here with the arrows.</p>' : ''}
    </div>
    ${editing ? packetCard('chamber') : ''}
    ${editing ? `<form class="card" data-form="new-leg"><h2>Add legislation</h2>
      <div class="field"><label>Title</label><input name="title" required placeholder="A Bill to…"></div>
      <div class="inline-fields"><div class="field"><label>Type</label><select name="kind"><option value="bill">Bill</option><option value="resolution">Resolution</option></select></div>
      <div class="field"><label>Author / school</label><input name="author"></div></div>
      <div class="field"><label>Text</label><textarea name="body" rows="6" placeholder="Paste the full text so everyone can read it on their device"></textarea></div>
      <button class="primary">Add to docket</button></form>` : ''}
    ${s.speeches.length ? `<h2 class="section-title">Speech record</h2>${viewLog()}` : ''}`;
}

// ---------- Speech log ----------
function viewLog() {
  const s = state;
  const byLeg = s.legislation.map((l) => ({ l, sp: s.speeches.filter((x) => x.legislation_id === l.id) })).filter((g) => g.sp.length);
  return byLeg.length ? byLeg.map(({ l, sp }) => `<div class="card"><h2>${esc(l.title)} <span class="pill ${l.status}">${esc(l.status)}</span></h2>
    <ul class="list">${sp.map((x) => {
      const qs = s.questions.filter((q) => q.speech_id === x.id);
      return `<li><div class="spread"><span><span class="pill ${x.side}">${SIDE_LABEL[x.side]}</span> <strong>${esc(x.speaker_name)}</strong></span>
        <span class="small muted">${fmtTime(x.recognized_at)}${x.duration_seconds != null ? ` · ${fmtSecs(x.duration_seconds)}` : ''}
        ${s.me.canChair ? ` <button class="sm ghost" data-act="del-speech" data-id="${x.id}">Remove</button>` : ''}</span></div>
        ${qs.length ? `<div class="small muted">Questions: ${qs.map((q) => esc(q.questioner_name)).join(', ')}</div>` : ''}</li>`;
    }).join('')}</ul></div>`).join('') : '<div class="card"><p class="muted">No speeches yet.</p></div>';
}

// ---------- Setup (admin) ----------
let allUsersCache = null;
function viewSetup() {
  const s = state, c = s.chamber;
  if (!allUsersCache) { api('GET', '/api/users').then((r) => { allUsersCache = r.users; render(); }).catch(() => {}); }
  const memberIds = new Set([...s.competitors, ...s.judges].map((x) => x.id));
  const available = (allUsersCache || []).filter((u) => u.role !== 'admin' && !memberIds.has(u.id));
  return `<div class="grid two">
    <form class="card" data-form="settings"><h2>Chamber settings</h2>
      <div class="field"><label>Name</label><input name="name" value="${esc(c.name)}"></div>
      <div class="inline-fields">
        <div class="field"><label>Lowest points</label><input name="score_min" type="number" value="${c.score_min}"></div>
        <div class="field"><label>Highest points</label><input name="score_max" type="number" value="${c.score_max}"></div>
        <div class="field"><label>Judges rank top</label><input name="rank_count" type="number" value="${c.rank_count}"></div>
      </div>
      <div class="inline-fields">
        <div class="field"><label>Speech (sec)</label><input name="speech_seconds" type="number" value="${c.speech_seconds}"></div>
        <div class="field"><label>Authorship questioning (sec)</label><input name="authorship_question_seconds" type="number" value="${c.authorship_question_seconds}"></div>
        <div class="field"><label>Other questioning (sec)</label><input name="question_seconds" type="number" value="${c.question_seconds}"></div>
      </div>
      <div class="field"><label>Who runs the floor?</label><select name="floor_mode">
        <option value="po" ${c.floor_mode !== 'self' ? 'selected' : ''}>The presiding officer, in the app</option>
        <option value="self" ${c.floor_mode === 'self' ? 'selected' : ''}>Each judge and competitor tracks for themselves</option></select>
        <p class="small muted" style="margin:4px 0 0">Use the second option when the PO isn't running the round in this app. Judges then log speeches and time them on their own Score tab.</p></div>
      <div class="field"><label>Presiding officer (after the chamber elects one)</label><select name="po_user_id"><option value="">None yet</option>
        ${s.competitors.map((p) => `<option value="${p.id}" ${p.id === c.po_user_id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select></div>
      <button class="primary">Save settings</button>
      <p class="small" style="margin-bottom:0"><button type="button" class="sm" data-act="delete-chamber">${s.is_mock ? 'Delete this mock tournament' : 'Delete chamber'}</button></p>
    </form>
    <div class="card"><h2>Members</h2>
      <h3>Competitors (${s.competitors.length})</h3>
      <ul class="list">${s.competitors.map((p) => `<li class="spread"><span>${esc(p.display_name)} <span class="small muted">${esc(p.school)}</span>${p.is_po ? ' <span class="pill">PO</span>' : ''}</span><button class="sm ghost" data-act="remove-member" data-id="${p.id}">Remove</button></li>`).join('') || '<li class="muted">None</li>'}</ul>
      <h3>Judges (${s.judges.length})</h3>
      <ul class="list">${s.judges.map((p) => `<li class="spread"><span>${esc(p.display_name)}</span><button class="sm ghost" data-act="remove-member" data-id="${p.id}">Remove</button></li>`).join('') || '<li class="muted">None</li>'}</ul>
      <h3>Add to this chamber</h3>
      ${allUsersCache ? (available.length ? `<form data-form="add-members"><div class="stack" style="max-height:260px;overflow:auto">${available.map((u) => `<label class="row" style="color:var(--ink)"><input type="checkbox" name="u" value="${u.id}" style="width:auto;min-height:0"> ${esc(u.display_name)} <span class="small muted">${esc(u.role)}${u.school ? ' · ' + esc(u.school) : ''}</span></label>`).join('')}</div>
        <button class="primary" style="margin-top:8px">Add selected</button></form>` : '<p class="muted small">Everyone is already in this chamber. <a href="#/users">Add people</a>.</p>') : '<p class="muted small">Loading…</p>'}
    </div>
  </div>`;
}

// ---------- Results (admin) ----------
function viewResults() {
  const r = ui.results;
  if (!r) { api('GET', C('/results')).then((x) => { ui.results = x; render(); }).catch((e) => toast(e.message, true)); return '<p class="muted">Loading…</p>'; }
  return `<div class="card"><div class="spread"><h2>Standings</h2><a class="btn" href="${C('/results.csv')}">Download CSV</a></div>
    <p class="small muted">Ordered by the sum of judge ranks (lower is better; an unranked competitor counts as ${r.unranked_value}), then total points. Totals include PO points. Q pts are judges' question scores, shown separately and not added in. ${r.total_speeches} speeches so far.</p>
    <div class="table-wrap"><table><tr><th>#</th><th>Competitor</th><th>Speeches</th><th>Points</th><th>Avg</th><th>Rank sum</th><th title="Judges' question scores, shown separately and not added to points">Q pts</th>${r.judges.map((j) => `<th>${esc(j.display_name)}</th>`).join('')}</tr>
    ${r.rows.map((x) => `<tr><td>${x.place}</td><td>${esc(x.name)}${x.was_po ? ' <span class="pill">PO</span>' : ''}<div class="small muted">${esc(x.school)}</div></td><td>${x.speeches}</td><td>${x.total_points}</td><td>${x.average_points ?? '—'}</td><td>${x.rank_total}</td><td>${x.questions_scored ? `${x.question_points}<div class="small muted">${x.questions_scored} scored</div>` : '—'}</td>
      ${x.by_judge.map((b) => `<td>${b.rank ? `#${b.rank}` : '—'}<div class="small muted">${b.points} pts</div></td>`).join('')}</tr>`).join('')}
    </table></div></div>
    <div class="card"><h2>Publish standings</h2>
      ${publishSelect('data-publish="standings" style="max-width:420px"', r.standings_publish)}
      <p class="small muted">"Each competitor" shows students only their own place and totals. "Everyone" shows the whole table above without the per-judge columns. Judge comments are never shown to anyone but the competitor they were written for.</p></div>
    <div class="card"><h2>Judges</h2><div class="table-wrap"><table><tr><th>Judge</th><th>Progress</th><th>Ballot</th><th>Shared with</th></tr>
      ${r.progress.map((p) => `<tr><td>${esc(p.name)}</td><td class="small">${p.scored}/${r.total_speeches} speeches · PO ${p.po_scored ? '✓' : '—'} · ranked ${p.ranked}</td>
        <td class="small">${p.submitted_at ? `Submitted ${fmtTime(p.submitted_at)} <button class="sm ghost" data-act="reopen-ballot" data-id="${p.judge_id}" data-name="${esc(p.name)}">Reopen</button>` : '<span class="muted">Not submitted</span>'}</td>
        <td>${publishSelect(`data-publish="ballot" data-judge="${p.judge_id}"`, p.publish)}</td></tr>`).join('') || '<tr><td class="muted">No judges assigned.</td></tr>'}
    </table></div>
    <button class="sm" data-act="refresh-results">Refresh</button></div>`;
}

// ---------- event handling ----------
const formData = (f) => Object.fromEntries(new FormData(f).entries());
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const d = formData(f);
  try {
    switch (f.dataset.form) {
      case 'login': await api('POST', '/api/login', d); me = null; go('#/'); break;
      case 'setup': await api('POST', '/api/setup', d); me = null; go('#/users'); break;
      case 'password': await api('POST', '/api/me/password', d); toast('Password changed'); f.reset(); break;
      case 'new-chamber': { const r = await api('POST', '/api/chambers', d); go(`#/c/${r.id}/setup`); break; }
      case 'new-user': { if (!d.username) delete d.username; if (!d.password) delete d.password; const r = await api('POST', '/api/users', d); ui.userFlash = [r.user]; allUsersCache = null; renderUsers(); break; }
      case 'bulk-users': { const r = await api('POST', '/api/users/bulk', d); ui.userFlash = r.users; allUsersCache = null; renderUsers(); break; }
      case 'settings': f.querySelector('button').focus(); await act('PUT', C(''), { ...d, po_user_id: d.po_user_id || null }, 'Settings saved'); break;
      case 'add-members': { const ids = [...f.querySelectorAll('input[name=u]:checked')].map((x) => Number(x.value)); if (!ids.length) return; f.querySelector('button').focus(); await act('POST', C('/members'), { user_ids: ids }, 'Added'); break; }
      case 'new-leg': f.querySelector('button').focus(); if (await act('POST', C('/legislation'), d, 'Added to docket')) f.reset(); break;
      case 'edit-leg': f.querySelector('button').focus(); await act('PUT', C(`/legislation/${f.dataset.id}`), d, 'Saved'); break;
      case 'd-custom-timer': {
        const secs = Math.round(Number(d.minutes) * 60);
        if (!secs) { toast('Enter the number of minutes.', true); return; }
        f.querySelector('button').focus();
        await dashAction(f.dataset.scope, 'custom', d.label || 'Timer', secs);
        break;
      }
      case 'new-tracker': { const r = await api('POST', '/api/trackers', d); go(`#/tracker/${r.id}`); break; }
      case 'tr-item': f.querySelector('button').focus(); trackerDo(() => { tracker.data.item = d.item.trim(); }); break;
      case 'tr-people': {
        const lines = d.text.split('\n').map((l) => l.trim()).filter(Boolean);
        f.querySelector('button').focus();
        trackerDo(() => { for (const l of lines) { const [n, sc = ''] = l.split(',').map((x) => x.trim()); if (n) tracker.data.people.push({ id: uid(), name: n, school: sc }); } });
        break;
      }
      case 'tr-settings': f.querySelector('button').focus(); trackerDo(() => { for (const k of ['speechSecs', 'authQSecs', 'qSecs']) { const v = Number(d[k]); if (v > 0) tracker.data[k] = Math.round(v); } }); toast('Saved'); break;
      case 'motion': f.querySelector('button').focus(); await act('POST', C('/motions'), d, 'Motion on the floor'); break;
      case 'announce': f.querySelector('button').focus(); if (await act('POST', C('/announcements'), d, 'Posted')) f.reset(); break;
      case 'hand-vote': f.querySelector('button').focus(); await act('POST', C(`/legislation/${f.dataset.id}/result`), { status: d.status, yes: d.yes === '' ? null : Number(d.yes), no: d.no === '' ? null : Number(d.no), abstain: d.abstain === '' ? null : Number(d.abstain) }, 'Result recorded'); break;
    }
  } catch (err) { toast(err.message, true); }
});

// Judge comments save when the field loses focus.
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-track]')) {
    if (el.dataset.track === 'bill') { ui.trackBill = el.value; ui.trackSide = null; el.blur(); render(); }
    else { ui.trackTopic = el.value.trim(); ui.trackSide = null; el.blur(); render(); }
    return;
  }
  if (el.matches('[data-mylog]')) {
    el.blur();
    const v = el.value, f = el.dataset.field;
    await act('PUT', C(`/my-log/${el.dataset.mylog}`), { [f]: f === 'side' ? v : (v ? Number(v) : null) }, 'Fixed');
    return;
  }
  if (el.matches('[data-viewas]')) {
    ui.viewAs = el.value ? Number(el.value) : null;
    ui.rankDraft = null; ui.results = null; ui.reflection = null;
    el.blur();
    await loadState();
    return;
  }
  if (el.matches('[data-publish]')) {
    el.blur();
    const body = el.dataset.publish === 'standings' ? { target: 'standings', level: el.value }
      : { target: 'ballot', level: el.value, judge_id: el.dataset.judge ? Number(el.dataset.judge) : undefined };
    await act('POST', C('/publish'), body, el.value === 'private' ? 'Now private' : 'Published');
    if (currentTab() === 'results') { ui.results = null; render(); }
    return;
  }
  if (el.dataset.gridSpeech) {
    const cfg = ballotCfg(el.dataset.mode), id = Number(el.dataset.gridSpeech);
    el.blur();
    await act('PUT', cfg.scorePath(id), el.value ? { points: Number(el.value), comment: cfg.scores[id]?.comment || ui.notes?.[`s${id}`] || '' } : { points: null }, 'Saved');
    return;
  }
  if (el.dataset.gridQuestion) {
    const id = Number(el.dataset.gridQuestion);
    el.blur();
    await act('PUT', C(`/question-scores/${id}`), el.value ? { points: Number(el.value), comment: state.my_question_scores?.[id]?.comment || ui.notes?.[`q${id}`] || '' } : { points: null }, 'Saved');
    return;
  }
  if (el.dataset.qcommentFor) {
    const id = Number(el.dataset.qcommentFor), sc = state.my_question_scores?.[id];
    if (!sc) { ui.notes = { ...(ui.notes || {}), [`q${id}`]: el.value }; toast('Note kept. It saves when you pick points.'); return; }
    await act('PUT', C(`/question-scores/${id}`), { points: sc.points, comment: el.value }, 'Note saved');
    return;
  }
  if (el.dataset.gridPo) {
    el.blur();
    if (el.value) await act('PUT', C('/po-score'), { po_user_id: Number(el.dataset.gridPo), points: Number(el.value), comment: state.my_po_scores.find((x) => x.po_user_id === Number(el.dataset.gridPo))?.comment || '' }, 'Saved');
    return;
  }
  if (el.dataset.commentFor) {
    const cfg = ballotCfg(el.dataset.mode), id = Number(el.dataset.commentFor), sc = cfg.scores[id];
    if (!sc) { ui.notes = { ...(ui.notes || {}), [`s${id}`]: el.value }; toast('Note kept. It saves when you pick points.'); return; }
    await act('PUT', cfg.scorePath(id), { points: sc.points, comment: el.value }, 'Note saved');
  } else if (el.dataset.poCommentFor) {
    const id = Number(el.dataset.poCommentFor), sc = state.my_po_scores.find((x) => x.po_user_id === id);
    if (!sc) { toast('Pick points first, then your comment is saved with them.', true); return; }
    await act('PUT', C('/po-score'), { po_user_id: id, points: sc.points, comment: el.value }, 'Comment saved');
  }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const d = b.dataset, s = state;
  switch (d.act) {
    case 'logout': {
      const n = Offline.pending();
      if (n && !confirm(`${n} change${n === 1 ? ' has' : 's have'} not reached the server yet. They stay on this device and send the next time you sign in here. Sign out anyway?`)) break;
      try { await api('POST', '/api/logout'); } catch (err) { toast(err.message, true); break; }
      await Offline.clearSaved(); me = null; closeEvents(); chamberId = null; state = null; go('#/login'); break;
    }
    case 'backup-now': {
      b.disabled = true;
      try { await api('POST', '/api/admin/backups'); toast('Backup saved'); renderData(); } catch (err) { toast(err.message, true); b.disabled = false; }
      break;
    }
    case 'restore': {
      if (!confirm(`Replace everything in the app with the backup from ${d.when}? Anything added since then is replaced. A copy of the current data is saved first.`)) break;
      try { await api('POST', '/api/admin/restore', { name: d.name }); toast('Restored'); me = null; go('#/data'); } catch (err) { toast(err.message, true); }
      break;
    }
    case 'restore-upload': {
      const file = document.getElementById('restore-file')?.files?.[0];
      if (!file) { toast('Pick a backup file first.', true); break; }
      if (!confirm(`Replace everything in the app with "${file.name}"? A copy of the current data is saved first.`)) break;
      b.disabled = true;
      try {
        const res = await fetch('/api/admin/restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r.error || `Restore failed (${res.status})`);
        toast('Restored'); me = null; go('#/data');
      } catch (err) { toast(err.message === 'Failed to fetch' ? 'You are offline. This needs a connection.' : err.message, true); b.disabled = false; }
      break;
    }
    case 'net-open': { const p = document.getElementById('netpanel'); p.innerHTML = Offline.panel(); p.hidden = false; break; }
    case 'net-close': document.getElementById('netpanel').hidden = true; break;
    case 'net-retry': await Offline.flush(); document.getElementById('netpanel').innerHTML = Offline.panel(); break;
    case 'net-dismiss': Offline.dismiss(); document.getElementById('netpanel').innerHTML = Offline.panel(); break;
    case 'reset-pw': if (confirm(`Reset the password for ${d.name}?`)) { const r = await api('PUT', `/api/users/${d.id}`, { reset_password: true }); ui.userFlash = [{ display_name: d.name, role: '', username: '(unchanged)', password: r.password }]; renderUsers(); } break;
    case 'delete-user': if (confirm(`Delete ${d.name}? Their speeches and scores are removed too.`)) { await api('DELETE', `/api/users/${d.id}`); allUsersCache = null; renderUsers(); } break;
    case 'remove-member': await act('DELETE', C(`/members/${d.id}`)); break;
    case 'request': {
      const mine = s.requests.some((r) => r.user_id === s.me.id && r.kind === d.kind);
      await act(mine ? 'DELETE' : 'POST', mine ? C(`/requests/${d.kind}`) : C('/requests'), mine ? undefined : { kind: d.kind });
      break;
    }
    case 'ballot': await act('POST', C('/ballot'), { choice: d.choice }, 'Vote recorded'); break;
    case 'd-recognize': await dashAction(d.scope, 'recognize', d.scope === 'tracker' ? d.id : Number(d.id), d.side); break;
    case 'd-question': await dashAction(d.scope, 'question', d.scope === 'tracker' ? d.id : Number(d.id)); break;
    case 'd-questioning': await dashAction(d.scope, 'questioning'); break;
    case 'd-end': await dashAction(d.scope, 'end'); break;
    case 'd-timer': await dashAction(d.scope, 'timer', d.a); break;
    case 'd-list': ui.dashList = d.kind; render(); break;
    case 'd-queue': await dashAction(d.scope, 'queue', ui.dashList, d.a); break;
    case 'd-move': {
      const id = d.scope === 'tracker' ? d.id : Number(d.id), ids = dashOrder(), i = ids.indexOf(id), j = i + Number(d.dir);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await dashAction(d.scope, 'queue', ui.dashList, 'set', ids);
      break;
    }
    case 'tr-remove-person': if (confirm('Remove this person and their speeches from the tracker?')) trackerDo(() => {
      const t = tracker.data; t.people = t.people.filter((x) => x.id !== d.id);
      t.speeches = t.speeches.filter((x) => x.pid !== d.id); t.questions = t.questions.filter((x) => x.pid !== d.id);
      if (t.currentSpeechId && !t.speeches.some((x) => x.id === t.currentSpeechId)) { t.currentSpeechId = null; t.timer = null; }
    }); break;
    case 'tr-undo-speech': if (confirm('Remove this speech from your log?')) trackerDo(() => {
      const t = tracker.data; t.speeches = t.speeches.filter((x) => x.id !== d.id); t.questions = t.questions.filter((x) => x.speechId !== d.id);
      if (t.currentSpeechId === d.id) { t.currentSpeechId = null; t.timer = null; }
      t.speakOrder = trRuleOrder('speak'); t.qOrder = trRuleOrder('question');
    }); break;
    case 'tr-undo-question': trackerDo(() => { const t = tracker.data; t.questions = t.questions.filter((x) => x.id !== d.id); t.qOrder = trRuleOrder('question'); }); break;
    case 'tr-clear': if (confirm('Clear every speech and question? People stay.')) trackerDo(() => {
      Object.assign(tracker.data, { speeches: [], questions: [], currentSpeechId: null, timer: null, speakOrder: [], qOrder: [] });
    }); break;
    case 'tr-delete': if (confirm(`Delete the tracker "${d.name}"?`)) { await api('DELETE', `/api/trackers/${d.id}`); renderTrackerList(); } break;
    case 'make-mock': {
      try {
        b.disabled = true;
        const r = await api('POST', '/api/mock', {});
        toast(`Mock tournament ready. Its made-up people all use the password "${r.password}".`);
        go(`#/c/${r.id}/chair`);
      } catch (err) { toast(err.message, true); b.disabled = false; }
      break;
    }
    case 'delete-chamber': if (confirm(s.is_mock ? 'Delete this mock tournament and all of its made-up people?' : 'Delete this chamber and every speech, vote and score in it? This cannot be undone.')) {
      ui.viewAs = null;
      try { await api('DELETE', C('')); toast('Deleted'); go('#/'); } catch (err) { toast(err.message, true); }
    } break;
    case 'del-question': await act('DELETE', C(`/questions/${d.id}`)); break;
    case 'del-speech': if (confirm('Remove this speech from the record? Use this only to fix a mistake.')) await act('DELETE', C(`/speeches/${d.id}`)); break;
    case 'status': await act('POST', C('/status'), { status: d.status }); break;
    case 'clear-requests': await act('DELETE', C('/requests')); break;
    case 'begin': await act('POST', C(`/legislation/${d.id}/begin`), null, 'Debate begins'); break;
    case 'open-vote': await act('POST', C('/votes'), { target_type: d.type, target_id: Number(d.id) }, 'Vote open'); break;
    case 'close-vote': { const r = await act('POST', C(`/votes/${d.id}/close`)); if (r) toast(`Vote ${r.result}: ${r.tally.yes}–${r.tally.no}–${r.tally.abstain}`); break; }
    case 'cancel-vote': await act('POST', C(`/votes/${d.id}/close`), { cancel: true }, 'Vote cancelled'); break;
    case 'motion-status': await act('POST', C(`/motions/${d.id}/status`), { status: d.status }); break;
    case 'move-leg': {
      const ids = s.legislation.map((l) => l.id), i = ids.indexOf(Number(d.id)), j = i + Number(d.dir);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await act('POST', C('/docket-order'), { ids });
      break;
    }
    case 'delete-leg': if (confirm('Delete this legislation?')) await act('DELETE', C(`/legislation/${d.id}`), null, 'Deleted'); break;
    case 'score': {
      const cfg = ballotCfg(d.mode), id = Number(d.id), points = Number(d.points);
      const comment = document.querySelector(`[data-comment-for="${id}"]`)?.value || ui.notes?.[`s${id}`] || '';
      const same = cfg.scores[id]?.points === points;
      if (await act('PUT', cfg.scorePath(id), same ? { points: null } : { points, comment }, same ? 'Score cleared' : 'Saved') && ui.notes) delete ui.notes[`s${id}`];
      break;
    }
    case 'chip': {
      const cfg = ballotCfg(d.mode), id = Number(d.id);
      const ta = document.querySelector(`[data-comment-for="${id}"]`);
      let text = ta.value;
      const re = new RegExp(`(^|\\s)${d.chip}\\.?(?=\\s|$)`);
      text = re.test(text) ? text.replace(re, '').replace(/\s{2,}/g, ' ').trim() : `${text.trim()} ${d.chip}.`.trim();
      ta.value = text;
      const sc = cfg.scores[id];
      if (sc) await act('PUT', cfg.scorePath(id), { points: sc.points, comment: text });
      else { ui.notes = { ...(ui.notes || {}), [`s${id}`]: text }; b.classList.toggle('on'); toast('Note kept. It saves when you pick points.'); }
      break;
    }
    case 'ballot-view': ui.ballotView = d.v; render(); break;
    case 'track-side': ui.trackSide = d.side; render(); break;
    case 'mark-side': ui.markSide = d.side; ui.trackSide = d.side; render(); break;
    case 'mark-speech': {
      const side = ui.markSide || (s.chamber.floor_mode === 'self' ? trackGuessSide() : (s.chamber.next_side || 'authorship'));
      if (s.chamber.floor_mode === 'self') { ui.trackSide = side; document.dispatchEvent(new CustomEvent('track-speaker', { detail: Number(d.id) })); }
      else if (await act('POST', C('/recognize'), { user_id: Number(d.id), side }, `${competitor(Number(d.id))?.display_name}: ${SIDE_LABEL[side]}`)) ui.markSide = null;
      ui.markSide = null; break;
    }
    case 'mark-question': {
      const x = liveCtx('chair');
      if (!x.cur) { toast('Start a speech first.', true); break; }
      if (s.chamber.floor_mode === 'self') await act('POST', C(`/my-log/${x.cur.id}/questions`), { questioner_id: Number(d.id) }, `Question: ${competitor(Number(d.id))?.display_name}`);
      else await act('POST', C('/questions'), { user_id: Number(d.id) }, `Question: ${competitor(Number(d.id))?.display_name}`);
      break;
    }
    case 'qscore': {
      const id = Number(d.id), points = Number(d.points), cur = s.my_question_scores?.[id];
      const comment = document.querySelector(`[data-qcomment-for="${id}"]`)?.value || ui.notes?.[`q${id}`] || '';
      const same = cur?.points === points;
      if (await act('PUT', C(`/question-scores/${id}`), same ? { points: null } : { points, comment }, same ? 'Score cleared' : 'Saved') && ui.notes) delete ui.notes[`q${id}`];
      break;
    }
    case 'myq-delete': await act('DELETE', C(`/my-questions/${d.id}`), null, 'Removed'); break;
    case 'track-speaker': await trackSpeaker(Number(d.id)); break;
    case 'track-timer': {
      const t = myTimer(); if (!t) break;
      if (d.a === 'pause' && t.running) setMyTimer({ ...t, running: false, elapsed_ms: t.elapsed_ms + (Date.now() - t.started_at) });
      else if (d.a === 'resume' && !t.running) setMyTimer({ ...t, running: true, started_at: Date.now() });
      render(); break;
    }
    case 'track-questioning': {
      const t = myTimer(), cur = t && (s.my_log || []).find((x) => x.id === t.speech_id);
      await closeMySpeechTime();
      startMyTimer('Questioning', cur && ['authorship', 'sponsorship'].includes(cur.side) ? s.chamber.authorship_question_seconds : s.chamber.question_seconds);
      await loadState(); break;
    }
    case 'track-end': await closeMySpeechTime(); setMyTimer(null); await loadState(); break;
    case 'mylog-delete': if (confirm('Remove this speech from your log? Any points you gave it are removed too.')) {
      if (myTimer()?.speech_id === Number(d.id)) setMyTimer(null);
      await act('DELETE', C(`/my-log/${d.id}`), null, 'Removed');
    } break;
    case 'rank-fill': ui.rankDraft = suggestedRanking(ballotCfg(s.me.isJudge ? 'judge' : 'practice')); render(); break;
    case 'submit-ballot': {
      const cfg = ballotCfg('judge'), unsaved = JSON.stringify(ui.rankDraft ?? suggestedRanking(cfg)) !== JSON.stringify(cfg.saved);
      if (unsaved) { toast('Save your ranking first.', true); break; }
      if (confirm('Submit your ballot? You will not be able to change scores afterwards unless an admin reopens it.')) await act('POST', C('/ballot/submit'), null, 'Ballot submitted');
      break;
    }
    case 'reopen-ballot': if (confirm(`Reopen ${d.name}'s ballot so they can make changes?`)) { await act('POST', C(`/ballots/${d.id}/reopen`), null, 'Reopened'); ui.results = null; render(); } break;
    case 'po-score': {
      const id = Number(d.id);
      const comment = document.querySelector(`[data-po-comment-for="${id}"]`)?.value || '';
      await act('PUT', C('/po-score'), { po_user_id: id, points: Number(d.points), comment }, 'Saved');
      break;
    }
    case 'rank-add': case 'rank-remove': case 'rank-up': {
      const cfg = ballotCfg(s.me.isJudge ? 'judge' : 'practice');
      ui.rankDraft = [...(ui.rankDraft ?? suggestedRanking(cfg))];
      const i = Number(d.i);
      if (d.act === 'rank-add') ui.rankDraft.push(Number(d.id));
      else if (d.act === 'rank-remove') ui.rankDraft.splice(i, 1);
      else [ui.rankDraft[i - 1], ui.rankDraft[i]] = [ui.rankDraft[i], ui.rankDraft[i - 1]];
      render();
      break;
    }
    case 'save-ranks': {
      const cfg = ballotCfg(d.mode), ids = ui.rankDraft ?? suggestedRanking(cfg);
      if (await act('PUT', cfg.rankPath, { user_ids: ids }, 'Ranking saved')) ui.rankDraft = [...ballotCfg(d.mode).saved];
      render();
      break;
    }
    case 'refresh-results': ui.results = null; render(); break;
  }
});

route();
