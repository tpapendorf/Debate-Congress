# Congress Chamber

A web app for running a high school Congressional Debate chamber (NSDA / WSFA style) from any phone, tablet or laptop.

## What each person sees

| Role | How they get it | What they can do |
|---|---|---|
| **Admin / parliamentarian** | `admin` account role | Add people and print their logins, create chambers, set points range and timing, load the docket, assign the elected PO, run chair controls if needed, see standings and download CSV. |
| **Presiding officer** | A competitor the admin assigns as PO | *Preside* tab: call to order, begin debate on docket items, recognize speakers from the precedence list, run speech and questioning timers, log questioners, entertain motions, open and close votes, post announcements. |
| **Competitor** | `competitor` role, added to a chamber | Live floor (who has the floor, timer, bill text), rise to speak aff/neg or to ask a question, vote on their device, see precedence and their own speeches. Never sees scores. |
| **Judge / scorer** | `judge` role, added to a chamber | Score each speech with one tap (range set per chamber, e.g. 1–6 or 1–8), add comments, score the PO, and submit a top-N ranking. Each judge sees only their own scores. |

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
