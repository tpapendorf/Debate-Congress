'use strict';
/* Bill drills: quick spoken practice built from the team's research on its current bills.
   Answer the question (30 s), Refute it (30 s), Cite it (15 s), a Speed round (solo or partner flash cards)
   and a Quick speech (random side, 2 minutes to outline, then the practice timer).
   Students rate themselves; "Need work" cards come back first. Uses helpers from app.js, teams.js and training.js. */

const DRILL_MODES = {
  question: { name: 'Answer the question', short: 'Questions', secs: 30, blurb: 'A likely question comes up. Answer it out loud in 30 seconds, then check the prepared answer.', lesson: (ls) => ls.find((l) => l.bill_section === 'question' && /answer/i.test(l.title)) || ls.find((l) => l.bill_section === 'question') },
  refute: { name: 'Refute it', short: 'Refute', secs: 30, blurb: 'An argument comes up. Answer it out loud: They say, But, Because, Therefore.', lesson: (ls) => ls.find((l) => l.bill_section === 'neg') },
  cite: { name: 'Cite it', short: 'Cite', secs: 15, blurb: 'A fact comes up. Say who, when and what out loud, the way you would in a speech.', lesson: (ls) => ls.find((l) => l.bill_section === 'evidence') },
  speed: { name: 'Speed round', short: 'Speed', blurb: 'Quick questions against the clock. Solo, or with a partner like flash cards.', lesson: () => null },
  speech: { name: 'Quick speech', short: 'Speech', blurb: 'Get a random side, take 2 minutes to outline, then give it on the practice timer.', lesson: (ls) => ls.find((l) => l.track === 'roles') },
};
const RATE = [['2', 'Nailed it', 'good'], ['1', 'Close', 'mid'], ['0', 'Need work', 'bad']];
let drill = null; // the drill in progress
const D = (p = '') => T(`/drills${p}`);
const shortTitle = (t, n = 42) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Item details are written as "Label: text" lines (Warrant, They'll say, Respond, Best answer…, How to use it…).
function detailParts(detail) {
  const map = {}, rest = [];
  for (const line of String(detail || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([A-Za-z][A-Za-z ''()/,-]{1,48}?):\s+(.+)$/);
    if (m) { const k = m[1].toLowerCase().replace(/[‘’]/g, "'"); (map[k] ||= []).push(m[2]); } else rest.push(line);
  }
  const get = (re) => Object.entries(map).filter(([k]) => re.test(k)).flatMap(([k, v]) => v.map((x) => ({ k, v: x })));
  return { map, rest, get };
}
const firstSentence = (t, max = 220) => { const s = String(t || '').split(/(?<=[.?!])\s+/)[0] || ''; return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const sayCite = (i) => {
  const who = i.cite_author || i.cite_source;
  const bits = [who ? `According to ${who}` : '', i.cite_author && i.cite_source ? `, ${i.cite_source}` : '', i.cite_date ? `, ${i.cite_date}` : ''].join('');
  return bits ? `${bits}, …` : '';
};

// ---------- cards ----------
function makeCard(mode, i) {
  const p = detailParts(i.detail);
  const card = { id: i.id, ai: !!i.ai, section: i.section, side: i.side };
  if (mode === 'question') {
    const best = p.get(/^best answer/), ask = p.get(/^ask as$/)[0]?.v?.replace(/\.$/, ''), follow = p.get(/^then ask$/).map((x) => x.v);
    card.kicker = ask ? `Asked by: ${ask}` : 'Likely question';
    card.front = i.text;
    card.back = [
      ...(best.length ? best.map((b) => `<p><b>${esc(b.k.replace(/^best answer/, 'Prepared answer'))}:</b> ${esc(b.v)}</p>`) : [`<p>${esc(i.detail || 'No prepared answer yet. Add one on the bill page.')}</p>`]),
      follow.length ? `<p class="small"><b>Follow-ups to expect:</b> ${follow.map(esc).join(' · ')}</p>` : '',
    ].join('');
    return card;
  }
  if (mode === 'refute') {
    const warrant = p.get(/^warrant$/)[0]?.v, attack = p.get(/^they'll say$/)[0]?.v, respond = p.get(/^respond$/)[0]?.v;
    card.kicker = `The ${i.section === 'aff' ? 'affirmative' : 'negative'} argues`;
    card.front = i.text;
    card.sub = warrant ? `Because: ${warrant}` : '';
    card.back = [
      attack ? `<p><b>A strong answer starts from:</b> ${esc(attack)}</p>` : '',
      respond ? `<p class="small"><b>How they'll defend it:</b> ${esc(respond)}</p>` : '',
      !attack ? `<p>Did you attack the reason, not just the claim?${warrant ? ` The reason is: <i>${esc(warrant)}</i>` : ''}</p>` : '',
      '<p class="small muted">Check: did you name the speaker, give a "because", and say why it matters for the vote?</p>',
    ].join('');
    return card;
  }
  if (mode === 'cite') {
    const use = p.get(/^how to use/)[0]?.v, watch = p.get(/^watch out$/)[0]?.v;
    card.kicker = i.side === 'aff' ? 'Evidence for the affirmative' : i.side === 'neg' ? 'Evidence for the negative' : 'Evidence';
    card.front = i.text;
    card.back = [
      sayCite(i) ? `<p><b>Say it like:</b> "${esc(sayCite(i))}"</p>` : '<p>This card has no source details yet. Add them on the bill page.</p>',
      citationFull(i) ? `<p class="small">${esc(citationFull(i))}</p>` : '',
      use ? `<p class="small"><b>How to use it:</b> ${esc(use)}</p>` : '',
      watch ? `<p class="small"><b>Watch out:</b> ${esc(watch)}</p>` : '',
    ].join('');
    return card;
  }
  // speed: a short question with a short answer
  if (i.section === 'question') {
    const best = p.get(/^best answer/)[0]?.v || p.rest[0] || '';
    if (!best) return null;
    return { ...card, tag: 'Question', front: i.text, answer: firstSentence(best, 170) };
  }
  if (i.section === 'evidence') {
    const c = [i.cite_author || i.cite_source, i.cite_author && i.cite_source ? i.cite_source : '', i.cite_date].filter(Boolean).join(', ');
    if (!c) return null;
    return { ...card, tag: 'Who said it, and when?', front: i.text, answer: c };
  }
  const warrant = p.get(/^warrant$/)[0]?.v || p.rest[0] || '';
  if (!warrant) return null;
  return { ...card, tag: `Why? (${i.section === 'aff' ? 'aff' : 'neg'} argument)`, front: i.text, answer: firstSentence(warrant, 170) };
}
function buildDeck(mode, items, latest) {
  const src = items.filter((i) => (mode === 'question' ? i.section === 'question' : mode === 'refute' ? ['aff', 'neg'].includes(i.section) : mode === 'cite' ? i.section === 'evidence' : true));
  const cards = src.map((i) => makeCard(mode, i)).filter(Boolean);
  const key = mode === 'speed' ? 'speed' : mode;
  const rank = (c) => { const r = latest[`${key}:${c.id}`]; return r === undefined ? 1 : r === 0 ? 0 : r === 1 ? 2 : 3; };
  const groups = [0, 1, 2, 3].map((g) => shuffle(cards.filter((c) => rank(c) === g)));
  return groups.flat();
}
const needWork = (mode, items, latest) => items.filter((i) => latest[`${mode}:${i.id}`] === 0).length;

// ---------- Training: the Bill drills section ----------
async function drillsSection() {
  let data;
  try { data = await api('GET', D()); } catch (e) { return `<div class="card"><p class="small muted">Bill drills couldn't load: ${esc(e.message)}</p></div>`; }
  const { bills, current, pinned_bill_id: pin, roster } = data;
  const tid = teamCtx.id;
  const head = `<div class="dr-head"><div><h2>${ICON.mic} Bill drills</h2><p class="small muted">Quick spoken practice from your team's research on ${current ? 'the bills that are up next' : 'your most recent bills'}.</p></div></div>`;
  if (!bills.length) return `<section class="drills">${head}<div class="card small muted">No bills to drill yet. Add research to a bill, or mark bills as <b>Up next</b> on the Research tab.</div></section>`;
  const sorted = [...bills].sort((a, b) => (b.id === pin) - (a.id === pin));
  const tile = (b) => {
    const r = b.readiness, pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    const n = b.counts;
    return `<a class="dr-bill${b.id === pin ? ' pinned' : ''}${r.done === r.total ? ' ready' : ''}" href="#/team/${tid}/drill/${b.id}">
      ${b.id === pin ? `<span class="dr-pin">${ICON.star}This week's bill</span>` : ''}
      <b class="dr-title">${esc(b.title)}</b>
      <span class="dr-counts small muted">${[[n.question, 'questions'], [n.aff + n.neg, 'arguments'], [n.evidence, 'evidence']].map(([c, l]) => `${c} ${l}`).join(' · ')}</span>
      <span class="dr-ready"><span class="dr-bar"><i style="width:${pct}%"></i></span><span class="small"><b>${r.done}/${r.total}</b> ready${r.done === r.total ? ' ✓' : ''}</span></span>
    </a>`;
  };
  const table = roster ? `<details class="card dr-roster" ${ui.drRosterOpen ? 'open' : ''} data-dr-roster><summary><h3>Who's drilled what</h3><span class="small muted">Readiness steps done on each bill</span></summary>
    <div class="dr-table-wrap"><table class="dr-table"><thead><tr><th>Teammate</th>${sorted.map((b) => `<th title="${esc(b.title)}">${esc(shortTitle(b.title, 26))}</th>`).join('')}<th>Needs work on</th><th>Last drill</th></tr></thead>
    <tbody>${roster.map((m) => `<tr><td><span class="avatar-xs">${esc(initials(m.name))}</span> ${esc(m.name)}</td>${sorted.map((b) => { const c = m.bills[b.id]; const cls = c.done === c.total ? 'full' : c.done ? 'some' : 'none'; return `<td><span class="dr-cell ${cls}" title="${c.drills} cards drilled">${c.done}/${c.total}</span></td>`; }).join('')}
      <td class="small">${m.weakest ? esc(m.weakest.name) : '<span class="muted">—</span>'}</td><td class="small muted">${m.last ? fmtDate(m.last) : '—'}</td></tr>`).join('')}</tbody></table></div></details>` : '';
  return `<section class="drills">${head}<div class="dr-grid">${sorted.map(tile).join('')}</div>${table}</section>`;
}

// ---------- a bill's drill page ----------
async function viewDrill(bid, mode) {
  stopDrillTimers();
  const [data, lessons] = await Promise.all([api('GET', D(`/${bid}`)), loadLessons().then((r) => r.lessons).catch(() => [])]);
  ui.drillData = data;
  if (mode && DRILL_MODES[mode]) return drillRunner(data, mode, lessons);
  return drillHub(data, lessons);
}
function drillHub({ bill, items, latest, readiness: r, pinned }, lessons) {
  const tid = teamCtx.id, s = r.steps, leader = teamCtx.data.me.isLeader;
  const sum = bill.ai_summary || bill.summary || bill.preview;
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  const count = { question: items.filter((i) => i.section === 'question').length, refute: items.filter((i) => ['aff', 'neg'].includes(i.section)).length, cite: items.filter((i) => i.section === 'evidence').length };
  count.speed = items.map((i) => makeCard('speed', i)).filter(Boolean).length;
  const go2 = (m) => `#/team/${tid}/drill/${bill.id}/${m}`;
  const step = (done, avail, title, detail, action) => (avail ? `<li class="${done ? 'done' : ''}"><span class="lr-check">${done ? CHECK : ''}</span><div><b>${title}</b>${detail ? `<div class="small muted">${detail}</div>` : ''}</div>${action || ''}</li>` : '');
  const tiles = Object.entries(DRILL_MODES).map(([k, m]) => {
    const n = k === 'speech' ? null : count[k], nw = k === 'speech' || k === 'speed' ? 0 : needWork(k, items, latest);
    const l = m.lesson(lessons);
    const off = n === 0;
    return `<div class="dr-mode dm-${k}${off ? ' off' : ''}">
      <div class="dm-top"><b>${m.name}</b>${m.secs ? `<span class="pill">${m.secs} s</span>` : ''}</div>
      <p class="small muted">${m.blurb}</p>
      <div class="small dm-meta">${n === null ? '' : off ? 'No cards on this bill yet.' : `${n} card${n === 1 ? '' : 's'}${nw ? ` · <b class="nw">${nw} need work</b>` : ''}`}</div>
      <div class="row">${off ? '' : `<a class="btn sm primary" href="${go2(k)}">Start</a>`}${l ? `<a class="small" href="#/team/${tid}/lesson/${l.id}">${ICON.book} Lesson: ${esc(l.title)}</a>` : ''}</div>
    </div>`;
  }).join('');
  return `
    <nav class="crumbs"><a href="#/team/${tid}/training">← Training</a><span>Bill drills</span></nav>
    <header class="dr-hero">
      <div class="bh-top"><div class="bc-kicker">${pinned ? `<span class="pill now-pill">${ICON.star}This week's bill</span>` : ''}${bill.status === 'current' ? '<span class="pill">Up next</span>' : ''}</div>
        ${leader ? `<details class="bc-menu"><summary aria-label="More">⋯</summary><div class="bc-pop"><button data-dact="pin" data-id="${bill.id}" data-on="${pinned ? 0 : 1}">${pinned ? 'Unpin this week\'s bill' : 'Pin as this week\'s bill'}</button></div></details>` : ''}</div>
      <h2 class="lesson-title">${esc(bill.title)}</h2>
      <div class="dr-ready big"><span class="dr-bar"><i style="width:${pct}%"></i></span><span><b>${r.done} of ${r.total}</b> readiness steps done</span></div>
      <a class="small" href="#/team/${tid}/bill/${bill.id}">Open the bill's research →</a>
    </header>
    <div class="grid side dr-layout">
      <section class="card dr-steps"><h2>Ready for this bill?</h2><ol class="ready-list">
        ${step(s.read.done, true, 'Read the summary', '', s.read.done ? '' : `<button class="sm" data-dact="read" data-id="${bill.id}">Mark read</button>`)}
        ${step(s.questions.done, s.questions.avail, 'Drill the likely questions', `${s.questions.have} of ${s.questions.need} rated`, s.questions.done ? '' : `<a class="btn sm" href="${go2('question')}">Go</a>`)}
        ${step(s.refute.done, s.refute.avail, 'Refute both sides', `Aff ${s.refute.aff ? '✓' : '—'} · Neg ${s.refute.neg ? '✓' : '—'}`, s.refute.done ? '' : `<a class="btn sm" href="${go2('refute')}">Go</a>`)}
        ${step(s.cite.done, s.cite.avail, 'Cite the evidence out loud', `${s.cite.have} of ${s.cite.need} rated`, s.cite.done ? '' : `<a class="btn sm" href="${go2('cite')}">Go</a>`)}
        ${step(s.speech.done, true, 'Give one practice speech', s.speech.runs ? `${s.speech.runs} practice run${s.speech.runs === 1 ? '' : 's'}` : 'Any speech plan on this bill counts', s.speech.done ? '' : `<a class="btn sm" href="${go2('speech')}">Go</a>`)}
      </ol>
      ${sum ? `<details class="dr-sum"><summary class="small"><b>The summary</b></summary>${bill.ai_summary ? aiBadge() : ''}<p>${esc(sum)}</p></details>` : `<p class="small muted">No summary yet. <a href="#/team/${tid}/bill/${bill.id}">Read the bill</a>.</p>`}
      </section>
      <section class="dr-modes">${tiles}</section>
    </div>`;
}

// ---------- running a drill ----------
let drillTick = null;
function stopDrillTimers() { if (drillTick) { clearInterval(drillTick); drillTick = null; } }
window.addEventListener('hashchange', stopDrillTimers);
function drillRunner(data, mode, lessons) {
  const { bill, items, latest } = data;
  const m = DRILL_MODES[mode], tid = teamCtx.id;
  const back = `<nav class="crumbs"><a href="#/team/${tid}/drill/${bill.id}">← ${esc(shortTitle(bill.title, 50))}</a><span>${m.name}</span></nav>`;
  if (mode === 'speech') { drill = { mode, bill, items }; return `${back}<div data-drill>${speechSetup()}</div>`; }
  if (mode === 'speed') { drill = { mode, bill, deck: buildDeck('speed', items, latest), setup: true }; return `${back}<div data-drill>${speedSetup()}</div>`; }
  const deck = buildDeck(mode, items, latest);
  if (!deck.length) return `${back}<div class="card"><p>No cards for this drill yet. Add research on the <a href="#/team/${tid}/bill/${bill.id}">bill page</a>.</p></div>`;
  drill = { mode, bill, deck, i: 0, revealed: false, results: [], left: m.secs };
  const l = m.lesson(lessons);
  setTimeout(startCardTimer, 0);
  return `${back}<div class="dr-run" data-drill>${cardHtml()}</div>${l ? `<p class="small dr-lesson">${ICON.book} New to this? <a href="#/team/${tid}/lesson/${l.id}">Lesson: ${esc(l.title)}</a></p>` : ''}`;
}
const drillBox = () => document.querySelector('[data-drill]');
function cardHtml() {
  const d = drill, c = d.deck[d.i], m = DRILL_MODES[d.mode];
  if (!c) return doneHtml();
  return `<div class="dr-progress small"><span>Card ${d.i + 1} of ${d.deck.length}</span><button class="linkish" data-dact="finish">Finish</button></div>
    <article class="dcard dcard-${d.mode}${c.section ? ` sec-${c.section}` : ''}">
      <div class="dcard-top"><span class="dcard-kicker">${esc(c.kicker || '')}</span>${c.ai ? aiBadge() : ''}</div>
      <div class="dcard-front">${esc(c.front)}</div>
      ${c.sub ? `<div class="dcard-sub">${esc(c.sub)}</div>` : ''}
      <div class="dtimer${d.revealed ? ' stopped' : ''}"><span class="dtimer-bar"><i style="width:${(d.left / m.secs) * 100}%"></i></span><span class="dtimer-n" data-dleft>${d.revealed ? '' : `${d.left}s`}</span></div>
      ${d.revealed ? `<div class="dcard-back">${c.back}</div>
        <div class="rate-row"><span class="small muted">How did you do?</span>${RATE.map(([v, l, cls]) => `<button class="rate-${cls}" data-dact="rate" data-v="${v}">${l}</button>`).join('')}</div>`
        : `<div class="row dcard-actions"><button class="primary lg" data-dact="reveal">Show the answer</button><span class="small muted kbd-only">Space shows it. Then 1, 2 or 3 to rate.</span></div>`}
    </article>`;
}
function startCardTimer() {
  stopDrillTimers();
  if (!drill || drill.revealed || !drill.deck) return;
  drill.left = DRILL_MODES[drill.mode].secs;
  drillTick = setInterval(() => {
    if (!drill || drill.revealed) return stopDrillTimers();
    drill.left -= 1;
    const box = drillBox(); if (!box) return stopDrillTimers();
    const bar = box.querySelector('.dtimer-bar i'), n = box.querySelector('[data-dleft]');
    if (bar) bar.style.width = `${Math.max(0, (drill.left / DRILL_MODES[drill.mode].secs) * 100)}%`;
    if (n) n.textContent = `${Math.max(0, drill.left)}s`;
    box.querySelector('.dtimer')?.classList.toggle('low', drill.left <= 5);
    if (drill.left <= 0) { drill.timeUp = true; revealCard(); }
  }, 1000);
}
function revealCard() { stopDrillTimers(); drill.revealed = true; drillBox().innerHTML = cardHtml(); if (drill.timeUp) { drillBox().querySelector('.dtimer')?.classList.add('up'); drill.timeUp = false; } }
async function rateCard(v) {
  const d = drill, c = d.deck[d.i];
  d.results.push({ id: c.id, rating: Number(v), card: c });
  api('POST', D(`/${d.bill.id}/results`), { results: [{ kind: d.mode, item_id: c.id, rating: Number(v) }] }).catch((e) => toast(`Not saved: ${e.message}`, true));
  d.i++; d.revealed = false;
  drillBox().innerHTML = cardHtml();
  startCardTimer();
}
function doneHtml() {
  stopDrillTimers();
  const d = drill, r = d.results, n = (v) => r.filter((x) => x.rating === v).length;
  const weak = r.filter((x) => x.rating === 0);
  return `<div class="card dr-done"><h2>Round done</h2>
    <div class="dr-tally"><span class="t-good"><b>${n(2)}</b>Nailed it</span><span class="t-mid"><b>${n(1)}</b>Close</span><span class="t-bad"><b>${n(0)}</b>Need work</span></div>
    ${weak.length ? `<h3>Need work</h3><ul class="dr-weak">${weak.map((x) => `<li><b>${esc(x.card.front)}</b><div class="small">${x.card.back}</div></li>`).join('')}</ul>` : r.length ? '<p>Nothing marked "Need work". Nice.</p>' : '<p class="muted">No cards rated this time.</p>'}
    <div class="row">${weak.length ? '<button class="primary" data-dact="again-weak">Drill the "Need work" ones again</button>' : ''}<button data-dact="again">Another round</button><a class="btn ghost" href="#/team/${teamCtx.id}/drill/${d.bill.id}">Back to the bill's drills</a></div></div>`;
}

// ---------- speed round ----------
function speedSetup() {
  const n = drill.deck.length;
  if (!n) return `<div class="card"><p>No quick questions on this bill yet. They come from likely questions with an answer, arguments with a warrant, and evidence with a source.</p></div>`;
  const o = speedOpts();
  return `<div class="card speed-setup"><h2>Speed round</h2>
    <p class="small muted">${n} quick cards from this bill: questions, "why?" for arguments, and "who said it?" for evidence. Get through as many as you can before the clock runs out.</p>
    <div class="field"><label>How</label><div class="seg">${[['solo', 'By myself'], ['partner', 'With a partner']].map(([k, l]) => `<button class="${o.how === k ? 'on' : ''}" data-dact="speed-opt" data-k="how" data-v="${k}">${l}</button>`).join('')}</div></div>
    <p class="small speed-how">${o.how === 'solo' ? 'Read the card, answer out loud, then show the answer and mark whether you got it. Your results count toward this bill\'s readiness.' : 'Hand the phone to your partner. They see the question and the answer, read the question to you, and mark whether you got it. Results aren\'t saved to anyone\'s account.'}</p>
    <div class="field"><label>Clock</label><div class="seg">${[60, 120, 180].map((s) => `<button class="${o.secs === s ? 'on' : ''}" data-dact="speed-opt" data-k="secs" data-v="${s}">${s / 60} min</button>`).join('')}</div></div>
    <button class="primary lg" data-dact="speed-go">Start</button></div>`;
}
function speedOpts() { try { return { how: 'solo', secs: 120, ...JSON.parse(localStorage.getItem('congress.speed') || '{}') }; } catch { return { how: 'solo', secs: 120 }; } }
function speedStart() {
  const o = speedOpts();
  Object.assign(drill, { setup: false, how: o.how, secs: o.secs, left: o.secs, i: 0, revealed: o.how === 'partner', results: [] });
  drillBox().innerHTML = speedHtml();
  stopDrillTimers();
  drillTick = setInterval(() => {
    if (!drill || drill.mode !== 'speed') return stopDrillTimers();
    drill.left -= 1;
    const el = document.querySelector('[data-speed-clock]'); if (!el) return stopDrillTimers();
    el.textContent = fmtT(Math.max(0, drill.left));
    el.classList.toggle('low', drill.left <= 10);
    if (drill.left <= 0) { stopDrillTimers(); drill.over = true; drillBox().innerHTML = speedDone(); }
  }, 1000);
}
function speedHtml() {
  const d = drill;
  if (d.i >= d.deck.length) { d.i = 0; d.deck = shuffle(d.deck); } // loop the deck if they get through it
  const c = d.deck[d.i], got = d.results.filter((r) => r.got).length;
  const partner = d.how === 'partner';
  return `<div class="speed${partner ? ' partner' : ''}">
    <div class="speed-bar"><span class="speed-clock" data-speed-clock>${fmtT(d.left)}</span><span class="speed-score"><b>${got}</b> / ${d.results.length}</span><button class="linkish" data-dact="speed-stop">Stop</button></div>
    ${partner ? '<p class="small speed-note">Partner: read the question out loud. The answer is just for you.</p>' : ''}
    <article class="fcard"><div class="fcard-top"><span class="fcard-tag">${esc(c.tag)}</span>${c.ai ? aiBadge() : ''}</div>
      <div class="fcard-q">${esc(c.front)}</div>
      ${d.revealed ? `<div class="fcard-a"><span class="small muted">${partner ? 'Answer' : 'Answer'}</span>${esc(c.answer)}</div>
        <div class="row fcard-acts"><button class="got" data-dact="speed-mark" data-got="1">✓ Got it</button><button class="missed" data-dact="speed-mark" data-got="0">✕ Missed</button></div>`
        : '<div class="row fcard-acts"><button class="primary lg" data-dact="speed-show">Show answer</button></div>'}
    </article></div>`;
}
function speedMark(got) {
  const d = drill, c = d.deck[d.i];
  d.results.push({ got, card: c });
  if (d.how === 'solo') api('POST', D(`/${d.bill.id}/results`), { results: [{ kind: 'speed', item_id: c.id, rating: got ? 2 : 0 }] }).catch(() => {});
  d.i++; d.revealed = d.how === 'partner';
  drillBox().innerHTML = speedHtml();
}
function speedDone() {
  const d = drill, got = d.results.filter((r) => r.got).length, missed = d.results.filter((r) => !r.got);
  return `<div class="card dr-done"><h2>${d.over ? 'Time!' : 'Round over'}</h2>
    <div class="dr-tally"><span class="t-good"><b>${got}</b>Got it</span><span class="t-bad"><b>${missed.length}</b>Missed</span><span><b>${d.results.length}</b>Cards</span></div>
    ${missed.length ? `<h3>Missed</h3><ul class="dr-weak">${missed.map((x) => `<li><b>${esc(x.card.front)}</b><div class="small">${esc(x.card.answer)}</div></li>`).join('')}</ul>` : ''}
    <div class="row"><button class="primary" data-dact="speed-go">Go again</button><a class="btn ghost" href="#/team/${teamCtx.id}/drill/${d.bill.id}">Back to the bill's drills</a></div></div>`;
}

// ---------- quick speech ----------
function speechSetup() {
  return `<div class="card speech-setup"><h2>Quick speech</h2>
    <p class="small muted">You'll get a side at random and 2 minutes to outline from your team's research. Then the practice timer opens for a 3-minute speech, and the run counts toward this bill's readiness.</p>
    <div class="row"><button class="primary lg" data-dact="speech-side">Give me a side</button><button data-dact="speech-side" data-side="aff">Affirmative</button><button data-dact="speech-side" data-side="neg">Negative</button></div></div>`;
}
function speechPrep() {
  const d = drill, side = d.side;
  const args = d.items.filter((i) => i.section === side), ev = d.items.filter((i) => i.section === 'evidence' && (i.side === side || i.side === 'both'));
  return `<div class="speech-prep">
    <div class="speed-bar side-${side}"><span class="pill ${side}">${side === 'aff' ? 'Affirmative' : 'Negative'}</span><span>Outline time</span><span class="speed-clock" data-speed-clock>${fmtT(d.left)}</span></div>
    <div class="grid two">
      <div class="card"><h3>Your outline</h3><textarea rows="9" data-speech-outline placeholder="Hook&#10;1. Point, fact, source&#10;2. Point, fact, source&#10;Close">${esc(d.outline || '')}</textarea>
        <div class="row" style="margin-top:8px"><button class="primary lg" data-dact="speech-go">Start speaking</button></div></div>
      <div class="card speech-ref"><h3>From your team's research</h3>
        ${args.length ? `<b class="small">Arguments</b><ul>${args.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul>` : '<p class="small muted">No arguments for this side yet.</p>'}
        ${ev.length ? `<b class="small">Evidence</b><ul>${ev.map((e) => `<li>${esc(e.text)}${e.cite_source ? ` <span class="muted">(${esc(e.cite_source)}${e.cite_date ? `, ${esc(e.cite_date)}` : ''})</span>` : ''}</li>`).join('')}</ul>` : ''}
      </div>
    </div></div>`;
}
function speechStartPrep(side) {
  drill.side = side || (Math.random() < 0.5 ? 'aff' : 'neg');
  drill.left = 120;
  drillBox().innerHTML = speechPrep();
  stopDrillTimers();
  drillTick = setInterval(() => {
    drill.left -= 1;
    const el = document.querySelector('[data-speed-clock]'); if (!el) return stopDrillTimers();
    el.textContent = fmtT(Math.max(0, drill.left));
    el.classList.toggle('low', drill.left <= 15);
    if (drill.left <= 0) { stopDrillTimers(); el.textContent = 'Time to speak'; document.querySelector('[data-dact=speech-go]')?.focus(); }
  }, 1000);
}
async function speechGo() {
  stopDrillTimers();
  const d = drill, outline = document.querySelector('[data-speech-outline]')?.value || '';
  const r = await api('POST', T('/plans'), { title: `Quick speech (${d.side === 'aff' ? 'Aff' : 'Neg'}): ${d.bill.title}`.slice(0, 200), bill_id: d.bill.id, side: d.side, outline, status: 'drafting' });
  go(`#/team/${teamCtx.id}/practice/${r.id}`);
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dact]');
  if (!b) return;
  const d = b.dataset;
  try {
    switch (d.dact) {
      case 'read': await api('POST', D(`/${d.id}/results`), { results: [{ kind: 'read' }] }); toast('Marked read'); reTeam(); break;
      case 'pin': await api('POST', D(`/${d.id}/pin`), { pinned: d.on === '1' }); toast(d.on === '1' ? 'Pinned as this week\'s bill' : 'Unpinned'); reTeam(); break;
      case 'reveal': revealCard(); break;
      case 'rate': await rateCard(d.v); break;
      case 'finish': drill.deck = drill.deck.slice(0, drill.i); drillBox().innerHTML = cardHtml(); break;
      case 'again': reTeam(); break;
      case 'again-weak': {
        const weak = drill.results.filter((x) => x.rating === 0).map((x) => x.card);
        Object.assign(drill, { deck: shuffle(weak), i: 0, revealed: false, results: [] });
        drillBox().innerHTML = cardHtml(); startCardTimer(); break;
      }
      case 'speed-opt': { const o = speedOpts(); o[d.k] = d.k === 'secs' ? Number(d.v) : d.v; try { localStorage.setItem('congress.speed', JSON.stringify(o)); } catch { /* storage blocked */ } drillBox().innerHTML = speedSetup(); break; }
      case 'speed-go': drill.deck = shuffle(drill.deck); drill.over = false; speedStart(); break;
      case 'speed-show': drill.revealed = true; drillBox().innerHTML = speedHtml(); break;
      case 'speed-mark': speedMark(d.got === '1'); break;
      case 'speed-stop': stopDrillTimers(); drill.over = false; drillBox().innerHTML = speedDone(); break;
      case 'speech-side': speechStartPrep(d.side); break;
      case 'speech-go': await speechGo(); break;
    }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('input', (e) => { if (e.target.matches('[data-speech-outline]') && drill) drill.outline = e.target.value; });
document.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-dr-roster]')) ui.drRosterOpen = e.target.open; }, true);
document.addEventListener('keydown', (e) => {
  if (!drill || !drillBox() || e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (drill.mode === 'speed') {
    if (drill.setup || drill.over || !document.querySelector('.speed')) return;
    if (e.code === 'Space' && !drill.revealed) { e.preventDefault(); drill.revealed = true; drillBox().innerHTML = speedHtml(); }
    else if (drill.revealed && ['ArrowRight', 'KeyY'].includes(e.code)) speedMark(true);
    else if (drill.revealed && ['ArrowLeft', 'KeyN'].includes(e.code)) speedMark(false);
    return;
  }
  if (!drill.deck || !drill.deck[drill.i]) return;
  if (e.code === 'Space' && !drill.revealed) { e.preventDefault(); revealCard(); }
  else if (drill.revealed && ['Digit1', 'Digit2', 'Digit3'].includes(e.code)) rateCard(String(3 - Number(e.code.slice(-1))));
});
