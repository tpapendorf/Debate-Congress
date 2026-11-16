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

## Citations and linked docs

- **Fill in from link.** On any evidence card, paste the article link and press *Fill in from link*. The server reads the page's public details (author, title, publication, date) from the tags news sites and journals publish for this purpose. Check the result and fix anything it missed; some sites block lookups, and then you fill it in by hand.
- **Copy citation** gives a full citation (Author. "Title." Publication, Date. Link). On a speech plan, any evidence you insert into the outline is listed under **Works cited**, with *Copy all*.
- **Google Docs, Sheets, Slides and Drive folders** can be linked on the Research tab (whole team), on a bill page (that bill), or on a speech plan (just you, plus coaches and captains if you share the plan). The app only stores the link and recognises what kind of Google file it is. Opening it uses each person's own Google account, so share the file or folder with the team, or set it to "Anyone with the link".
- Lookups only go to public web addresses on the normal ports, never to internal addresses, and give up after 8 seconds.

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
- `public/`: the single-page client (plain HTML, CSS and JavaScript, no build step)
- `scripts/seed.js`: demo data
- `test/`: end-to-end test
