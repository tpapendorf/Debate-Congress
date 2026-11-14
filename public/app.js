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
let ui = { recognizeSide: null, results: null, rankDraft: null, userFlash: null };

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
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/api/login')) { me = null; go('#/login'); throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
// Run an action, report errors, refresh chamber state.
async function act(method, url, body, okMsg) {
  try {
    const r = await api(method, url, body);
    if (okMsg) toast(okMsg);
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
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!me) {
    closeEvents();
    const setup = await api('GET', '/api/setup');
    return setup.needed ? renderSetup() : renderLogin();
  }
  if (parts[0] === 'c' && parts[1]) {
    const id = Number(parts[1]);
    if (id !== chamberId) { chamberId = id; state = null; ui = { ...ui, results: null, rankDraft: null }; openEvents(); }
    if (!state) await loadState(); else render();
    return;
  }
  closeEvents(); chamberId = null; state = null;
  if (parts[0] === 'users' && me.role === 'admin') return renderUsers();
  if (parts[0] === 'account') return renderAccount();
  return renderHome();
}
function currentTab() { return location.hash.split('/')[3] || 'floor'; }

function renderWho() {
  $who.innerHTML = me
    ? `<span>${esc(me.display_name)} · ${esc(me.role)}</span><a href="#/account">Account</a><button class="ghost sm" data-act="logout">Sign out</button>`
    : '';
}

// ---------- live updates ----------
function openEvents() {
  closeEvents();
  events = new EventSource(C('/events'));
  events.addEventListener('changed', () => loadState());
}
function closeEvents() { if (events) { events.close(); events = null; } }
async function loadState() {
  if (!chamberId) return;
  try {
    const s = await api('GET', C('/state'));
    clockOffset = s.server_now - Date.now();
    state = s;
    if (ui.rankDraft === null && state.my_rankings) ui.rankDraft = [...state.my_rankings];
    if (currentTab() === 'results' && state.me.isAdmin) ui.results = await api('GET', C('/results'));
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
  if (!state) return;
  if (isTyping()) { pendingRender = true; return; }
  pendingRender = false;
  renderChamber();
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !isTyping()) render(); }, 50));

// ---------- timer ----------
function timerRemaining(t) {
  if (!t) return null;
  const elapsed = t.elapsed_ms + (t.running ? (Date.now() + clockOffset - t.started_at) : 0);
  return t.duration - elapsed / 1000;
}
function timerHtml(t) {
  if (!t) return `<div class="timer muted">--:--</div>`;
  return `<div class="timer" data-timer>${fmtSecs(timerRemaining(t))}</div>`;
}
setInterval(() => {
  const t = state?.chamber?.timer;
  for (const el of document.querySelectorAll('[data-timer]')) {
    const r = timerRemaining(t);
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
      <p class="muted small">Your tournament admin gives you a username and password.</p>
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
    <h1>Chambers</h1>
    ${admin ? `<div class="card"><form class="row" data-form="new-chamber">
        <input name="name" placeholder="New chamber name, e.g. House Prelims Chamber A" required style="flex:1;min-width:200px">
        <button class="primary">Create chamber</button></form>
        <p class="small muted" style="margin-bottom:0"><a href="#/users">Manage people and logins →</a></p></div>` : ''}
    <div class="card">
      ${chambers.length ? `<ul class="list">${chambers.map((c) => `
        <li class="spread"><a href="#/c/${c.id}/floor"><strong>${esc(c.name)}</strong></a>
        <span class="row">${c.is_po ? '<span class="pill">You preside</span>' : ''}<span class="pill">${esc(STATUS_LABEL[c.status])}</span></span></li>`).join('')}</ul>`
        : `<p class="muted">${admin ? 'No chambers yet. Create one above.' : 'You are not assigned to a chamber yet. Ask your tournament admin.'}</p>`}
    </div>`;
}

// ---------- users (admin) ----------
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
function tabsFor(m) {
  const t = [['floor', 'Floor']];
  if (m.canChair) t.push(['chair', m.isPO ? 'Preside' : 'Chair controls']);
  if (m.isJudge) t.push(['score', 'Score']);
  t.push(['docket', 'Docket'], ['log', 'Speech log']);
  if (m.isAdmin) t.push(['setup', 'Setup'], ['results', 'Results']);
  return t;
}
function renderChamber() {
  const s = state, c = s.chamber, m = s.me;
  const tabs = tabsFor(m);
  let tab = currentTab();
  if (!tabs.some(([k]) => k === tab)) tab = 'floor';
  const body = { floor: viewFloor, chair: viewChair, score: viewScore, docket: viewDocket, log: viewLog, setup: viewSetup, results: viewResults }[tab]();
  $view.innerHTML = `
    <div class="spread"><h1>${esc(c.name)}</h1><span class="row"><span class="pill">${esc(STATUS_LABEL[c.status])}</span>
      ${c.po_name ? `<span class="pill">PO: ${esc(c.po_name)}</span>` : ''}</span></div>
    <nav class="tabs">${tabs.map(([k, label]) => `<a href="#/c/${c.id}/${k}" class="${k === tab ? 'active' : ''}">${label}</a>`).join('')}</nav>
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

// ---------- Chair / PO controls ----------
function viewChair() {
  const s = state, c = s.chamber, leg = currentLeg(), sp = currentSpeech();
  const side = ui.recognizeSide || c.next_side || 'aff';
  const t = c.timer;
  const pendingItems = s.legislation.filter((l) => ['pending', 'debating'].includes(l.status) && l.id !== c.current_legislation_id);
  const qs = sp ? s.questions.filter((q) => q.speech_id === sp.id) : [];
  const motionsOpen = s.motions.filter((x) => ['pending', 'voting'].includes(x.status));
  const competitorsOpts = s.competitors.filter((p) => !p.is_po).map((p) => `<option value="${p.id}">${esc(p.display_name)}</option>`).join('');
  return `
    ${voteBanner()}
    ${s.open_vote ? `<div class="card row"><button class="primary" data-act="close-vote" data-id="${s.open_vote.id}">Close vote and announce result</button>
       <button data-act="cancel-vote" data-id="${s.open_vote.id}">Cancel vote</button></div>` : ''}
    <div class="grid side">
      <div>
        ${floorCard()}
        <div class="card"><h2>Timer</h2><div class="row">
          ${t ? (t.running ? '<button data-act="timer" data-a="pause">Pause</button>' : '<button class="primary" data-act="timer" data-a="resume">Start / resume</button>') : ''}
          ${t ? '<button data-act="timer" data-a="reset">Reset</button>' : ''}
          ${sp ? `<button data-act="questioning">Start questioning (${fmtSecs(['authorship', 'sponsorship'].includes(sp.side) ? c.authorship_question_seconds : c.question_seconds)})</button>
                  <button data-act="end-speech">End speech, open floor</button>` : ''}
        </div>
        <form class="row" data-form="custom-timer" style="margin-top:8px">
          <input name="label" placeholder="Custom timer label" style="flex:2;min-width:140px"><input name="seconds" type="number" min="1" placeholder="Seconds" style="flex:1;min-width:90px">
          <button class="sm">Set</button></form></div>
        ${leg ? `<div class="card"><h2>Recognize a speaker</h2>
          <div class="row" style="margin-bottom:8px">${['authorship', 'sponsorship', 'aff', 'neg'].map((k) => `<button class="sm ${k === side ? 'on' : ''} ${k}" data-act="pick-side" data-side="${k}">${SIDE_LABEL[k]}</button>`).join('')}</div>
          <p class="small muted">Next expected: <strong>${SIDE_LABEL[c.next_side] || '—'}</strong>. Listed by precedence; tags show who rose for which side.</p>
          ${precedenceList(s.speaking_precedence, 'speeches', { button: (p) => `<button class="sm primary" data-act="recognize" data-id="${p.id}">Recognize</button>` })}
        </div>` : `<div class="card"><h2>Next item</h2><p class="muted">Choose an item from the docket to begin debate.</p></div>`}
        ${sp ? `<div class="card"><h2>Questioners for ${esc(sp.speaker_name)}</h2>
          ${qs.length ? `<ul class="list">${qs.map((q) => `<li class="spread">${esc(q.questioner_name)} <button class="sm ghost" data-act="del-question" data-id="${q.id}">Undo</button></li>`).join('')}</ul>` : '<p class="muted small">None logged yet.</p>'}
          <h3>Question precedence</h3>
          ${precedenceList(s.question_precedence.filter((id) => id !== sp.speaker_id), 'questions', { button: (p) => `<button class="sm" data-act="question" data-id="${p.id}">Log question</button>` })}
        </div>` : ''}
      </div>
      <div>
        <div class="card"><h2>Session</h2><div class="row">
          ${c.status !== 'in_session' ? '<button class="primary" data-act="status" data-status="in_session">Call to order</button>' : '<button data-act="status" data-status="recess">Recess</button>'}
          ${c.status !== 'adjourned' ? '<button data-act="status" data-status="adjourned">Adjourn</button>' : ''}
          ${s.requests.length ? '<button data-act="clear-requests">Clear everyone standing</button>' : ''}
        </div></div>
        <div class="card"><h2>Docket</h2>
          ${leg ? `<p>On the floor: <strong>${esc(leg.title)}</strong></p><div class="row">
            <button class="primary" data-act="open-vote" data-type="legislation" data-id="${leg.id}" ${s.open_vote ? 'disabled' : ''}>Vote on ${esc(leg.kind)}</button>
            </div>
            <details style="margin-top:8px"><summary class="small">Record a hand vote instead</summary>
              <form class="inline-fields" data-form="hand-vote" data-id="${leg.id}" style="margin-top:8px">
                <input name="yes" type="number" min="0" placeholder="Yea"><input name="no" type="number" min="0" placeholder="Nay"><input name="abstain" type="number" min="0" placeholder="Abstain">
                <select name="status"><option value="passed">Passed</option><option value="failed">Failed</option></select><button class="sm">Record</button></form></details>` : ''}
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
        <div class="card"><h2>Announce</h2><form data-form="announce" class="row"><input name="body" placeholder="e.g. Five-minute recess, return at 10:40" style="flex:1;min-width:180px"><button class="sm">Post</button></form></div>
        ${s.past_votes.length ? `<div class="card"><h2>Recent votes</h2><ul class="list">${s.past_votes.map((v) => `<li class="spread"><span>${esc(v.label)}</span><span class="small">${v.tally.yes}–${v.tally.no}–${v.tally.abstain} <span class="pill ${v.result}">${esc(v.result)}</span></span></li>`).join('')}</ul></div>` : ''}
      </div>
    </div>`;
}

// ---------- Judge scoring ----------
function scoreButtons(current, attrs) {
  const c = state.chamber, out = [];
  for (let p = c.score_min; p <= c.score_max; p++) out.push(`<button class="${current === p ? 'on' : ''}" ${attrs} data-points="${p}">${p}</button>`);
  return `<div class="score-buttons">${out.join('')}</div>`;
}
function viewScore() {
  const s = state, c = s.chamber;
  const speeches = [...s.speeches].reverse();
  const unscored = speeches.filter((x) => !s.my_scores[x.id]).length;
  const draft = ui.rankDraft || [];
  const rankable = s.competitors;
  const poScores = new Map(s.my_po_scores.map((x) => [x.po_user_id, x]));
  const pos = [...new Set([c.po_user_id, ...s.my_po_scores.map((x) => x.po_user_id)].filter(Boolean))];
  return `
    <p class="muted small">Your scores are private. Competitors never see them; only tournament admins see totals. Points range ${c.score_min}–${c.score_max}.</p>
    <div class="grid side">
      <div>
        <div class="card"><h2>Speeches ${unscored ? `<span class="pill debating">${unscored} to score</span>` : ''}</h2>
        ${speeches.length ? speeches.map((x) => {
          const sc = s.my_scores[x.id];
          return `<div class="card ${sc ? '' : 'unscored'}" style="margin-bottom:10px">
            <div class="spread"><div><strong>${esc(x.speaker_name)}</strong> <span class="pill ${x.side}">${SIDE_LABEL[x.side]}</span>${x.id === c.current_speech_id ? ' <span class="pill debating">speaking now</span>' : ''}</div>
            <span class="small muted">${fmtTime(x.recognized_at)}${x.duration_seconds != null ? ` · ${fmtSecs(x.duration_seconds)}` : ''}</span></div>
            <div class="small muted" style="margin:4px 0 8px">${esc(x.legislation_title)}</div>
            ${scoreButtons(sc?.points, `data-act="score" data-id="${x.id}"`)}
            <textarea data-comment-for="${x.id}" placeholder="Comments for the competitor (optional)" style="margin-top:8px;min-height:60px">${esc(sc?.comment || '')}</textarea>
          </div>`;
        }).join('') : '<p class="muted">No speeches yet. They appear here as soon as the PO recognizes someone.</p>'}
        </div>
      </div>
      <div>
        <div class="card"><h2>Presiding officer</h2>
          ${pos.length ? pos.map((id) => { const sc = poScores.get(id); const p = competitor(id); return `
            <div style="margin-bottom:10px"><strong>${esc(p?.display_name || 'PO')}</strong>
            ${scoreButtons(sc?.points, `data-act="po-score" data-id="${id}"`)}
            <textarea data-po-comment-for="${id}" placeholder="Comments on presiding (optional)" style="margin-top:8px;min-height:60px">${esc(sc?.comment || '')}</textarea></div>`; }).join('')
          : '<p class="muted">No presiding officer assigned yet.</p>'}
        </div>
        <div class="card"><h2>Final ranking (top ${c.rank_count})</h2>
          <p class="small muted">Tap names in order, best first. The PO can be ranked too.</p>
          <ol>${draft.map((id, i) => `<li class="spread" style="padding:4px 0"><span>${esc(competitor(id)?.display_name)}</span>
            <span class="row"><button class="sm ghost" data-act="rank-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="sm ghost" data-act="rank-remove" data-i="${i}">✕</button></span></li>`).join('')}</ol>
          <div class="row">${rankable.filter((p) => !draft.includes(p.id)).map((p) => `<button class="sm" data-act="rank-add" data-id="${p.id}" ${draft.length >= c.rank_count ? 'disabled' : ''}>${esc(p.display_name)}${p.is_po ? ' (PO)' : ''}</button>`).join('')}</div>
          <div class="row" style="margin-top:10px"><button class="primary" data-act="save-ranks">Save ranking</button>
          ${JSON.stringify(draft) !== JSON.stringify(s.my_rankings) ? '<span class="small muted">Unsaved changes</span>' : (s.my_rankings.length ? '<span class="small muted">Saved</span>' : '')}</div>
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
    ${editing ? `<form class="card" data-form="new-leg"><h2>Add legislation</h2>
      <div class="field"><label>Title</label><input name="title" required placeholder="A Bill to…"></div>
      <div class="inline-fields"><div class="field"><label>Type</label><select name="kind"><option value="bill">Bill</option><option value="resolution">Resolution</option></select></div>
      <div class="field"><label>Author / school</label><input name="author"></div></div>
      <div class="field"><label>Text</label><textarea name="body" rows="6" placeholder="Paste the full text so everyone can read it on their device"></textarea></div>
      <button class="primary">Add to docket</button></form>` : ''}`;
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
      <div class="field"><label>Presiding officer (after the chamber elects one)</label><select name="po_user_id"><option value="">None yet</option>
        ${s.competitors.map((p) => `<option value="${p.id}" ${p.id === c.po_user_id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select></div>
      <button class="primary">Save settings</button>
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
    <p class="small muted">Ordered by the sum of judge ranks (lower is better; an unranked competitor counts as ${r.unranked_value}), then total points. Totals include PO points. ${r.total_speeches} speeches so far.</p>
    <div class="table-wrap"><table><tr><th>#</th><th>Competitor</th><th>Speeches</th><th>Points</th><th>Avg</th><th>Rank sum</th>${r.judges.map((j) => `<th>${esc(j.display_name)}</th>`).join('')}</tr>
    ${r.rows.map((x) => `<tr><td>${x.place}</td><td>${esc(x.name)}${x.was_po ? ' <span class="pill">PO</span>' : ''}<div class="small muted">${esc(x.school)}</div></td><td>${x.speeches}</td><td>${x.total_points}</td><td>${x.average_points ?? '—'}</td><td>${x.rank_total}</td>
      ${x.by_judge.map((b) => `<td>${b.rank ? `#${b.rank}` : '—'}<div class="small muted">${b.points} pts</div></td>`).join('')}</tr>`).join('')}
    </table></div></div>
    <div class="card"><h2>Judge progress</h2><ul class="list">${r.progress.map((p) => `<li class="spread"><span>${esc(p.name)}</span><span class="small">${p.scored}/${r.total_speeches} speeches · PO ${p.po_scored ? '✓' : '—'} · ranked ${p.ranked}</span></li>`).join('') || '<li class="muted">No judges assigned.</li>'}</ul>
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
      case 'custom-timer': f.querySelector('button').focus(); await act('POST', C('/timer'), { action: 'custom', label: d.label || 'Timer', seconds: Number(d.seconds) }); break;
      case 'motion': f.querySelector('button').focus(); await act('POST', C('/motions'), d, 'Motion on the floor'); break;
      case 'announce': f.querySelector('button').focus(); if (await act('POST', C('/announcements'), d, 'Posted')) f.reset(); break;
      case 'hand-vote': f.querySelector('button').focus(); await act('POST', C(`/legislation/${f.dataset.id}/result`), { status: d.status, yes: d.yes === '' ? null : Number(d.yes), no: d.no === '' ? null : Number(d.no), abstain: d.abstain === '' ? null : Number(d.abstain) }, 'Result recorded'); break;
    }
  } catch (err) { toast(err.message, true); }
});

// Judge comments save when the field loses focus.
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.commentFor) {
    const id = Number(el.dataset.commentFor), sc = state.my_scores[id];
    if (!sc) { toast('Pick points first, then your comment is saved with them.', true); return; }
    await act('PUT', C(`/scores/${id}`), { points: sc.points, comment: el.value }, 'Comment saved');
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
    case 'logout': await api('POST', '/api/logout'); me = null; closeEvents(); chamberId = null; state = null; go('#/login'); break;
    case 'reset-pw': if (confirm(`Reset the password for ${d.name}?`)) { const r = await api('PUT', `/api/users/${d.id}`, { reset_password: true }); ui.userFlash = [{ display_name: d.name, role: '', username: '(unchanged)', password: r.password }]; renderUsers(); } break;
    case 'delete-user': if (confirm(`Delete ${d.name}? Their speeches and scores are removed too.`)) { await api('DELETE', `/api/users/${d.id}`); allUsersCache = null; renderUsers(); } break;
    case 'remove-member': await act('DELETE', C(`/members/${d.id}`)); break;
    case 'request': {
      const mine = s.requests.some((r) => r.user_id === s.me.id && r.kind === d.kind);
      await act(mine ? 'DELETE' : 'POST', mine ? C(`/requests/${d.kind}`) : C('/requests'), mine ? undefined : { kind: d.kind });
      break;
    }
    case 'ballot': await act('POST', C('/ballot'), { choice: d.choice }, 'Vote recorded'); break;
    case 'pick-side': ui.recognizeSide = d.side; render(); break;
    case 'recognize': {
      const side = ui.recognizeSide || s.chamber.next_side || 'aff';
      ui.recognizeSide = null;
      await act('POST', C('/recognize'), { user_id: Number(d.id), side }, `Recognized ${competitor(Number(d.id)).display_name}`);
      break;
    }
    case 'timer': await act('POST', C('/timer'), { action: d.a }); break;
    case 'questioning': await act('POST', C('/questioning')); break;
    case 'end-speech': await act('POST', C('/speech/end')); break;
    case 'question': await act('POST', C('/questions'), { user_id: Number(d.id) }); break;
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
      const id = Number(d.id), points = Number(d.points);
      const comment = document.querySelector(`[data-comment-for="${id}"]`)?.value || '';
      const same = s.my_scores[id]?.points === points;
      await act('PUT', C(`/scores/${id}`), same ? { points: null } : { points, comment }, same ? 'Score cleared' : 'Saved');
      break;
    }
    case 'po-score': {
      const id = Number(d.id);
      const comment = document.querySelector(`[data-po-comment-for="${id}"]`)?.value || '';
      await act('PUT', C('/po-score'), { po_user_id: id, points: Number(d.points), comment }, 'Saved');
      break;
    }
    case 'rank-add': ui.rankDraft = [...(ui.rankDraft || []), Number(d.id)]; render(); break;
    case 'rank-remove': ui.rankDraft.splice(Number(d.i), 1); render(); break;
    case 'rank-up': { const i = Number(d.i); [ui.rankDraft[i - 1], ui.rankDraft[i]] = [ui.rankDraft[i], ui.rankDraft[i - 1]]; render(); break; }
    case 'save-ranks': if (await act('PUT', C('/rankings'), { user_ids: ui.rankDraft }, 'Ranking saved')) ui.rankDraft = [...state.my_rankings]; render(); break;
    case 'refresh-results': ui.results = null; render(); break;
  }
});

route();
