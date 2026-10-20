# C8 Ask

Voice or text questions about C8 store sales. Claude answers by calling a fixed set of read-only database queries
(it never writes SQL and never quotes a number that did not come from a query result).

## Deploy on Railway (about 10 minutes)
1. Push this folder to a new GitHub repo (private).
2. Railway → New Project → Deploy from GitHub repo. Then **+ New → Database → PostgreSQL** (a separate database from the IVR one).
3. In the web service → Variables, add: `DATABASE_URL` (reference the Postgres service's `DATABASE_URL`), `SESSION_SECRET`, `APP_PASSWORD`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `NODE_ENV=production`.
4. Create the tables and load the starting data once (Railway CLI, or run locally with the *public* DATABASE_URL from Railway):
   `npm install && npm run init-db && npm run load`
5. Open the service URL. Sign in with APP_PASSWORD. Weekly updates: `/admin` (ADMIN_PASSWORD).

## Map
**Brands and Stores windows.** The **Brands** and **Stores** buttons open two floating windows you can drag around (close them with ×). The Brands window lists each brand with its store count, last week's sales and the change on the week before. Tap a brand and the Stores window shows only that brand's stores (tap it again to see all). The Stores window shows each store's last-week sales and change, has a search box (name, state or area manager), and tapping a store opens its details (address, phone, trading company, area manager, opening date and how reliable it is, last week's orders and average transaction value). The store you tap, or the brand if no store is chosen, becomes the context for your next question. On a phone, one window shows at a time.

**Org chart.** The **🧭 Org chart** button opens the October FY27 organisation chart as a drawn chart (52 boxes: 48 people, 3 vacant roles and the Marketing team box). It opens at a readable size with the CEO in the middle; **Fit** shows the whole chart, **+ / −** zoom, the search box highlights a person or role, and tapping a box shows who they report to and who reports to them, with the chain up to the top outlined. You can also ask by voice or text ("who reports to Tom?", "who is Head of Supply?", "which roles are vacant?"). The chart loads by itself the first time the app starts with an empty chart (from `data/org_chart.csv`). To change it later, upload a new file in **Data maintenance → Upload a CSV** (template link on that page); an upload **replaces the whole chart**. Reporting lines in that file are given by `reports_to_id` (the `person_id` of the boss) or by the boss's exact name.

**Short answers.** Claude is told to answer in one or two spoken sentences unless the question clearly needs more (comparisons, "why", lists, summaries). The wording is in the `SYSTEM` prompt in `server.js` if you want to adjust it.

Each row has a 🗺 button that puts that store (or every store of the brand) on a Google Map in a floating window. **Send back** tucks the window away (a "🗺 Map (n)" button appears at the top); pins stay until you press the same 🗺 button again, click × on a name, or **Clear all**.
Setup in Google Cloud: enable *Maps JavaScript API* and *Geocoding API*, make a key, and set `GOOGLE_MAPS_API_KEY` on Railway (restrict it to your site's address under "HTTP referrers"). Optionally use a second, server-only key as `GOOGLE_GEOCODE_KEY`.
Then run `npm run geocode` once (or /admin → Stores → *Find map locations*): addresses are converted to coordinates and saved, so Google is called once per store. Stores with no address are located from their name and marked approximate; you can type exact latitude/longitude on the Stores tab.
Without a key the map still works for one store at a time (a Google embed of the latest pin).

## Maintaining the data (/admin)
- **Upload a CSV**: weekly sales (Power BI), store details (SharePoint capture), opening dates, network events, new stores. The type is recognised from the header row; the preview shows matches, unmatched/ambiguous names, restated figures and whether the stores add up to the report's TOTAL row. Templates are on the page.
- **Stores**: search, edit any store (state, address, opening date, trading company…), add a store, add the other names people say, mark a store inactive, download everything as CSV.
- **History**: every upload and edit is logged. A restated sales figure keeps its old value in `weekly_sales_history`.
- Orders and ATV for later weeks go in the weekly file as extra columns `orders w/e dd/mm/yyyy` and `ATV w/e dd/mm/yyyy`.

## Notes
- Voice in uses the browser's speech recognition (Safari/Chrome, needs https and the microphone permission). Voice out uses the browser's speech synthesis.
- `data/stores_master.csv` was built by `scripts/build_master.py` (sales store list + SharePoint details + best opening date). Opening dates carry a reliability label.
- Tests: `DATABASE_URL=... npm test` (uses a mocked Claude, real Postgres).

## Printing, voice window, and when answers are spoken

- **🖨 Print reply** (top bar) prints the last answer on a clean page: question, answer, date and data week. Greyed out until there is an answer.
- **Speaking.** On a big screen answers are silent until you press the 🔊 button on that answer (or tick "Read answers aloud automatically" — remembered). On a phone they are read aloud automatically.
- **🎙 Voice window** opens a small window (or go to `/?voice=1`; Option/Alt-click opens it in the same tab). Tap the microphone once, then just talk: it listens, answers aloud, and listens again. Say **repeat**, **stop**, **print**, **new chat**, **help** or **finish**. Tap the microphone to pause/resume. "Stop" is only heard between answers (the mic is off while it speaks); tap the mic to cut it off mid-sentence.
- `test/voice-test.js` tests this with a fake microphone and speaker.

## Item sales by store

Admin → upload `brand,store,item_name,period_start,period_end,sales` (menu-item dollars per store for a block of weeks, captured from the Power BI Item Sales & Heatmap report). Loading replaces any earlier rows for the same brand and period. Stores are matched to store profiles by name. Questions use the `item_sales` tool (best sellers, one item's total and top stores, an item at one store). These figures are **not** on the same basis as the weekly Sales Report, and the assistant is told never to add or compare the two.

## Code sign-in by email (optional; text messages also supported)

Instead of two shared passwords, each person signs in with their own email address and a 6-digit code sent to it (like a banking app). Switch it on only when you are ready; until then nothing changes.

**Setting it up (one time) with a Gmail account**
1. On the Gmail account that will send the codes: Google Account → Security → turn on 2-Step Verification, then search "App passwords" and create one (name it "C8 Ask"). Google shows a 16-letter password once; copy it.
2. In Railway → Variables add: `SMTP_USER` (the Gmail address), `SMTP_PASS` (the 16-letter app password, no spaces), `ADMIN_EMAIL` (your own email, the first admin; optionally `ADMIN_NAME`). Optional: `MAIL_FROM` such as `C8 Ask <you@gmail.com>`.
3. Redeploy. On first start it creates you as the first admin. Open the site, enter your email, enter the code you are sent (check junk the first time).
4. Admin page → **Users**: add each director (name + email). Choose "Ask" or "Ask + administer". "Switch off" cuts someone off within about 20 seconds, even if they are signed in.

**Using a Microsoft 365 mailbox instead:** set `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, `SMTP_USER` and `SMTP_PASS` for that mailbox. Your IT admin must allow "Authenticated SMTP" for it.

**Text messages instead (Twilio):** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `ADMIN_MOBILE`; people are then identified by mobile number. If email is also set up, email is used.

**What it does**
- Codes are 6 random digits (from the system's secure random generator), work for 5 minutes, work once, and are never stored (only a scrambled copy). Five wrong guesses cancel the code. At most 3 codes per person per 15 minutes, and attempts are rate-limited per device.
- The reply to "send me a code" is the same whether or not the address is registered, so nobody can discover who has access.
- Addresses are stored in your Railway database (needed to send), shown only to admins, and shown partly hidden in server logs.
- A sign-in lasts 12 hours (change with `SESSION_HOURS`).
- Once it is on, `APP_PASSWORD` and `ADMIN_PASSWORD` no longer work and old sign-ins are ended.
- The admin page uses the same sign-in: sign in on the Ask page first (as an admin), then open the admin page.

**If you get locked out**: remove the `SMTP_*` (and `TWILIO_*`) variables in Railway and redeploy; the shared passwords work again (set `APP_PASSWORD`/`ADMIN_PASSWORD` if you removed them).

**Testing without a real mailbox**: `EMAIL_PROVIDER=console` (or `SMS_PROVIDER=console`) prints each code in the server log instead of sending it. Never use that on the live site.

## FY27 budget

`data/budget_fy27.json` holds the FY27 budget as structured figures (network sales, revenue, costs, profit, Marketing Concepts, monthly cash flow, headcount) plus about 19 short assumption notes. Load it on the admin page: choose the file under the upload box, check the preview, press Load. Loading again replaces the same year and version. Ask about it by voice or text ("what is budgeted for royalties?", "what are the greenfield assumptions?", "how is Noodle Box tracking against budget?"). Signed-in directors only. Budget sales are not on the same basis as the weekly report, so comparisons are approximate.

## Network Tracker pipeline
`python3 scripts/make-pipeline-json.py "NEW Network Tracker - 2025.xlsx" data/network_pipeline.json` turns the tracker workbook into one JSON file; upload it in Admin (recognised as `pipeline`). Loading replaces the whole pipeline. Tabs read: Greenfield, COUS, Opened, Transfers, Closures, FA Renewals, Lease Renewals, Activity, C8 Lease Liability. The question tool is `pipeline` (overview, list, site, delayed, expiries, activity).
