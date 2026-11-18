# Congress Chamber

A web app for running a high school Congressional Debate chamber (NSDA / WSFA style) from any phone, tablet or laptop.

## What each person sees

| Role | How they get it | What they can do |
|---|---|---|
| **Admin / parliamentarian** | `admin` account role | Add people and print their logins, create chambers, set points range and timing, load the docket, assign the elected PO, run chair controls if needed, see standings and download CSV. |
| **Presiding officer** | A competitor the admin assigns as PO | *Preside* tab: call to order, begin debate on docket items, recognize speakers from the precedence list, run speech and questioning timers, log questioners, entertain motions, open and close votes, post announcements. |
| **Competitor** | `competitor` role, added to a chamber | Live floor (who has the floor, timer, bill text), rise to speak aff/neg or to ask a question, vote on their device, see precedence and their own speeches. Never sees scores. |
| **Judge / scorer** | `judge` role, added to a chamber | Score each speech with one tap (range set per chamber, e.g. 1–6 or 1–8), add comments, score the PO, and submit a top-N ranking. Each judge sees only their own scores. |

## Laptop dashboard

The **Dashboard** tab (presiding officer or admin) is built for a laptop at the front of the room: a big timer (space bar starts and pauses it), every competitor in one table with speeches, when they last spoke, questions and when they last asked, and Auth / Aff / Neg buttons on each row to recognize them. The table *is* the precedence list: it follows the rule automatically (recognizing someone drops them to the bottom), and you can drag rows to fix a mistake or set the opening order. **Random draw** shuffles people tied on count; **Reset to rule** undoes manual changes. Switch to **Questioning order** to log questioners the same way.

## Personal tracker

Any signed-in person can open **My trackers** from the home page and run the same dashboard privately, for any chamber, even at tournaments that don't use this app. Type in the people in the room, set what's on the floor, and track speeches, questions, precedence, recency and the timer. Trackers are saved to that person's account and nobody else can see them.

## Scoring, practice ballots and publishing

- **Judges**: the speech being given pops to the top of the Score tab. Tap points, tap comment chips (Clash, Evidence, Refutation, …), and type a note only if wanted. A **Grid** view shows every competitor's speeches in one table. The final ranking is pre-filled from the judge's points, then adjusted and saved. **Submit ballot** locks it; an admin can reopen it from Results.
- **Competitors**: a **Practice ballot** tab with the same scoring screen (never counted, private, can't score yourself), and a **Reflection** tab that puts their practice scores and ranking next to whatever has been published.
- **Publishing**: a judge can share their own ballot, and an admin can share any judge's ballot or the combined standings, at one of three levels: *Private* (default), *Each competitor* (students see only the points and comments on their own speeches, or their own place), or *Everyone* (all point totals and rankings; comments are still only seen by the competitor they were written for).

## Teams and prep

Open **Teams** in the top bar.

- **Joining**: anyone can start a team and becomes its coach. Coaches and captains see a join code and a sign-up link. New people create their own account with the code (or existing users enter it under Teams), then wait for a coach or captain to approve them. Coaches set roles (coach, captain, competitor); a new code stops the old one working.
- **Research** (shared, whole team edits): one page per bill or resolution with affirmative arguments, negative arguments, evidence with citations (author, source, date, link, which side it supports), and likely questions with suggested answers. Bills can be typed in or imported from a docket in a chamber you belong to.
- **My prep** (private): speech plans tied to a bill and side, with status (idea, drafting, ready, delivered), an outline, and a panel of the team's research with **Insert** buttons that drop the argument and citation into the outline. A plan can be shared with coaches and captains. Private notes, optionally tied to a bill.
- **Progress**: speeches given in this app, judge feedback that was published to the student, a hand-kept results log for other tournaments, and goals set by coaches. Coaches and captains get a team overview.

## Live dashboard

Every chamber opens on the screen that person uses most:

| Role | Tabs |
| --- | --- |
| Judge | Dashboard, Ballot, Docket |
| Presiding officer | Dashboard, Floor, Docket |
| Competitor | Floor, Practice, My results, Docket |
| Admin | Dashboard, Docket, Setup, Results |

On phones the tabs sit in a bar at the bottom of the screen.

The **Dashboard** shows who has the floor and the timer at the top, then a scoring panel for that speech and each question asked during it (points and a note, saved as you go), then a feed of the whole round where anything can be scored or annotated later. The roster on the side is in precedence order; whoever runs the floor taps **Speech** or **Q** beside a name. In a PO-run chamber that is the PO (or an admin), and the PO's session, docket, motion and vote controls sit under the roster. In a self-tracked chamber every judge and competitor marks speeches and questions in their own private log.

**Question scores** use the same point scale. They appear in their own *Q pts* column in Results and the CSV and are never added to point totals or rankings. A note typed before points are picked is kept and saved with the points.

## Rounds without a PO in the app

When the presiding officer isn't running the round in this app, an admin sets **Setup → Who runs the floor?** to *Each judge and competitor tracks for themselves*. Then:

- The **Score** tab (judges) and **Practice ballot** tab (competitors) get a *Track the floor* bar: pick the bill (or type one that isn't on the docket), tap the name of whoever gets the floor, and their speech card opens ready to score. Names are ordered by precedence from your own log, and the side is guessed (authorship first, then aff/neg alternating).
- The timer runs on your own device: Pause/Start (space bar on a laptop), Questioning (longer after authorship), End speech. Speech length is saved with the entry.
- Each person's log is private. Two judges in the same room keep separate logs and never see each other's. A wrong entry can be fixed or removed until the ballot is submitted.
- Rankings, submitting, publishing and results work the same. Results count speeches from the judges' logs.

## Speech practice

Every speech plan has a **Practice this speech** button. The practice screen runs a countdown like a PO's timer: 3:00 for a speech, or 2:00 or 1:00 for questioning. It signals at 1:00, 0:30 and 0:10 left by changing color, and can also vibrate or beep. Then it gives 10 seconds of grace before it shows over time. Your outline can sit beside the timer, and Space starts and pauses it on a laptop.

Tick **Record audio** to record the run. You can play it back and download it right after, but the recording never leaves the device. Each run's time, a 1 to 5 star rating and a note on what to fix are saved to a practice log on the plan. Runs saved offline send later.

## AI Learning Aids

The app never talks to an AI itself. Instead, each bill page has an **AI Learning Aids** panel:

1. **Get the kit.** Download or copy a Markdown prep kit. It has the bill's full text, what the team already has, the rules for the AI, and the exact format to reply in. The rules are: a learning aid not a speech, both sides, and real sources with links only.
2. **Ask your AI.** Give the kit to Claude, ChatGPT or any other assistant, ideally one that can search the web.
3. **Upload its reply.** Upload the .md file or paste the reply. A preview lists the summary, arguments, evidence and questions it found, so you pick what to keep. Entries already on the bill are unticked. Evidence without a real link can't be added.

Everything added this way carries an **AI Learning Aid** badge, and keeps it even after a teammate edits it. Anyone can untick **Show AI Learning Aids** at the top of the team page to hide them for themselves; research counts then leave them out too. A coach can turn **Allow AI Learning Aids** off in Team settings. That hides them for the whole team and stops new uploads, but nothing is deleted.

### Learning aids shipped with the app

`server/seeds/<name>/*.md` holds replies in the kit format. When the server starts, `server/aiseed.js` loads each folder once onto every bill whose title matches, but only onto bills with no AI Learning Aids yet. It takes a backup first and records the run in `seed_runs`, so it never loads twice. If no bills match yet, it tries again on the next start. `ai-wsfa-fall-2026` covers the 17 WSFA Fall 2026 bills.

## Citations and linked docs

- **Fill in from link.** On any evidence card, paste the article link and press *Fill in from link*. The server reads the page's public details (author, title, publication, date) from the tags news sites and journals publish for this purpose. Check the result and fix anything it missed; some sites block lookups, and then you fill it in by hand.
- **Copy citation** gives a full citation (Author. "Title." Publication, Date. Link). On a speech plan, any evidence you insert into the outline is listed under **Works cited**, with *Copy all*.
- **Google Docs, Sheets, Slides and Drive folders** can be linked on the Research tab (whole team), on a bill page (that bill), or on a speech plan (just you, plus coaches and captains if you share the plan). The app only stores the link and recognises what kind of Google file it is. Opening it uses each person's own Google account, so share the file or folder with the team, or set it to "Anyone with the link".
- Lookups only go to public web addresses on the normal ports, never to internal addresses, and give up after 8 seconds.

## Tournament packets (Tabroom)

Tournaments post their Congress legislation as a PDF or Word packet on Tabroom. On a team's **Research** tab (or a chamber's **Docket** tab, for admins), paste the tournament's Tabroom page or a link to the packet, or upload the file. The app finds each bill and resolution with its session, author and full text, shows a preview where titles can be fixed and items unticked, and imports what is picked. Google Docs share links work too when the doc is shared publicly. Scanned packets (images of text) cannot be read.

### Managing the bill library

The Research tab lists bills under **Current**, **All** and **Archived**, with a tournament filter once there is more than one. Tick bills (or Select all) to **Mark current** for an upcoming tournament, **Archive** old ones (hidden from the list and from speech-plan menus, research kept), **Restore** them, or **Delete** them for good (coaches and captains only). A single bill's page has the same Mark current and Archive buttons.

## Working without Wi-Fi

Every page you open is kept on that device, so the app still opens and shows your chamber, ballot, team research, speech plans and notes when the connection drops.

- **Changes wait on the device.** Scores, question scores, rankings, your own speech log, the presiding officer's floor controls (recognize, questions, timer), speech plans, notes, team research and trackers can all be changed offline. They are sent in the order you made them, with the time you made them, as soon as the connection is back. Sending twice never saves twice.
- **The header shows where things stand:** "Offline · 3 changes waiting", "Saving…", then "All changes saved". Tap it for the list. Anything the server refused is listed there too.
- **Keep a team available offline.** On a team page, turn on "Keep available offline" before the tournament. That saves all of the team's research plus your speech plans and notes, and refreshes them whenever you open the team while connected.
- **Two people edit the same research offline:** nothing is lost. The second save is kept as an "Offline copy" next to the first, so the team can keep one.
- Some things still need a connection: votes, submitting a ballot, citation lookup, joining a team and admin settings. Signing out clears the saved pages from that device; changes that have not been sent stay and send the next time that person signs in there.

## Backups and export (admins)

The **Data** page (admins only) shows what is stored and how much disk it uses.

- The app saves a compressed copy of the whole database once a day when something changed, and keeps 14 days (always at least the last five). A full season is a few MB, so this stays far below the 1 GB disk.
- **Back up now** makes a copy on demand; **Download** saves any copy to your computer. Do both before a tournament.
- **Export everything** downloads a zip with one spreadsheet per table. Passwords, private speech plans, notes, trackers and practice ballots are left out of the export (they are in the full backups).
- **Restore** replaces everything with a stored backup or a file you upload. The current data is backed up first, so a restore can be undone. The app keeps running; nobody has to restart anything.

Backups are written to a `backups` folder next to the database (`BACKUP_DIR` to change it). On Render that is the same persistent disk, which Render also snapshots daily.

## Mock tournament

Admins can click **Create a mock tournament for testing** on the home page. It builds a practice chamber with 12 made-up competitors (one already the PO), 2 judges and 4 bills. A **View as** menu at the top lets the admin see and act as any of those people (vote, rise, score) from one laptop. **Setup → Delete this mock tournament** removes it and its made-up people. Made-up people never appear in the real people list.

## How a session flows

1. Admin adds people (paste a list as `Name, School, role`), creates the chamber, adds members and legislation.
2. After the chamber elects a PO, admin picks them in **Setup**. The PO sets the agreed docket order with the arrows.
3. PO: **Call to order**, then **Begin debate** on the first item. The app expects authorship first, then negative, affirmative, and so on.
4. Competitors tap **Speak affirmative / negative** or **Ask a question**. The PO's list is ordered by precedence (fewest speeches, then least recent) with tags for who rose.
5. **Recognize** starts a speech timer (3:00 by default). **Start questioning** switches to 2:00 after authorship or 1:00 after other speeches. **Log question** keeps question precedence.
6. Motions (previous question 2/3, amend, table, recess, adjourn, …) can pass by unanimous consent or go to a device vote. Votes on legislation are majority. A hand vote can be recorded instead.
7. Judges score as speeches happen and rank at the end. Admin sees standings ordered by sum of judge ranks, then total points.

Everything updates live on every screen; nobody needs to refresh.

## Run it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there is nothing else to install).

```bash
npm install
npm run seed     # optional: demo chamber; every demo login uses password "congress"
npm start        # http://localhost:3000
```

With no seed, the first visit asks you to create the admin account.

Demo logins after `npm run seed`: `admin`, `judge1`, `judge2`, `jules` (presiding officer), and competitors `avery`, `blake`, `casey`, `dana`, `emery`, `finley`, `gray`, `harper`, `indy`.

```bash
npm test         # runs a full chamber session end to end over HTTP
```

## Try it from GitHub (Codespaces)

On the repo page, click **Code → Codespaces → Create codespace on main**. It installs, loads the demo chamber and starts the app by itself. To let other people in, open the **Ports** tab, right-click port 3000 and set **Port visibility → Public**, then share that URL. The codespace sleeps after about 30 idle minutes (raise this in your GitHub Codespaces settings); data is kept until you delete the codespace. Good for trying it out, not for a real tournament.

## Deploy

It is one Node process plus one SQLite file, so it needs a host with a persistent disk.

- **Render**: `render.yaml` is included (web service plus a 1 GB disk). Create a Blueprint from this repo.
- **Railway / Fly.io / any Docker host**: use the `Dockerfile` and mount a volume at `/data`.

Environment variables: `PORT` (default 3000), `DB_PATH` (default `./data/congress.db`), `COOKIE_SECURE=1` when served over HTTPS.

## Code layout

- `server/db.js`: schema
- `server/app.js`: all API routes, permission checks and scoring math
- `server/teams.js`: teams, research and prep
- `server/backup.js`: daily backups, export and restore
- `server/packet.js`: reads tournament legislation packets (PDF via `unpdf`, Word)
- `server/aikit.js`: reads the reply a student's own AI assistant wrote from the bill prep kit (AI Learning Aids)
- `public/offline.js` and `public/sw.js`: saved pages and the offline outbox
- `public/`: the single-page client (plain HTML, CSS and JavaScript, no build step)
- `scripts/seed.js`: demo data
- `test/`: end-to-end test
