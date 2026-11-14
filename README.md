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
- **Upload a CSV**: weekly sales (Power BI), store details (SharePoint capture), store states (store,brand,state: also copied onto that store's events and pipeline records), opening dates, network events, new stores. The type is recognised from the header row; the preview shows matches, unmatched/ambiguous names, restated figures and whether the stores add up to the report's TOTAL row. Templates are on the page.
- **Operating manuals**: Admin → Load manuals file takes manuals.json (made once from the IVR app's vector-store.json with scripts/vector-to-manuals.py). Every page is kept for search; the Manuals area in Admin → Users controls who can ask about them (everyone by default).
- **Franchise agreements and leases**: Admin → Upload takes the Store agreements file; questions about royalty rates, agreement and lease end dates, landlords and rent use the store_agreements tool (Finance area and above). A new address on a store clears its map pin so Find map locations places it again (pins set by hand are kept).
- **Legal documents**: Admin → Legal documents takes a PDF (for example the latest signed franchise agreement) and keeps its text by page. Questions use the legal_documents tool and quote the clause and page. It is in its own Legal area (Board class by default), separate from the operating manuals.
- **Stores**: search, edit any store (state, address, opening date, trading company…), add a store, add the other names people say, mark a store inactive, download everything as CSV.
- **History**: every upload and edit is logged. A restated sales figure keeps its old value in `weekly_sales_history`.
- Orders and ATV for later weeks go in the weekly file as extra columns `orders w/e dd/mm/yyyy` and `ATV w/e dd/mm/yyyy`.

## C8 Ask and ConceptMate: which to use
ConceptMate (CM) is incredibly powerful but slower and costlier: it works across all of C8's data, answers almost anything and builds each answer from scratch, so it suits senior managers and complex questions. C8 Ask is quick and basic: a fixed set of common questions answered in seconds from data loaded in advance, at very little cost, limited to approved directors. It can go no deeper than the loaded data, and small differences from the source reports are accepted for speed; for an exact figure ask CM. Use Ask for the basics and CM for anything deeper, unusual or exact. When Ask says it does not hold something, that is the cue to ask CM. Ask's sales data comes mostly from CM exports, so CM stays the source of truth.

## Personal notes, to-dos and reminders (v1.14)
Each signed-in person has a private list. Type or say: `note ...`, `to do ...`, `remind me to ... tomorrow at 3pm` (also "in 2 hours", "on Friday at 10am", "on 20 November"), or switch the **Ask / Note** button beside the question box so everything typed is saved. Say or type `list my notes` (read back aloud), `delete note 3`, `mark 2 done`, `delete the last one`, `clear done notes`; `delete all my notes` asks you to say `confirm delete all`. The **Notes** window lists them with tick, read-aloud and delete. A reminder is emailed to the person's own address at its due time (once), and anything due is announced when Ask opens. Times are Melbourne time.
- Private: every query is scoped to the signed-in person; there is no admin screen that shows notes. They need a personal sign-in (email or text code), not the shared password.
- The words are encrypted in the database (AES-256-GCM, tied to the person). Set `NOTES_KEY` in Railway to a long random string and keep a copy: if it is lost, notes cannot be read. Without it the key is derived from `SESSION_SECRET`, so changing that would lock the notes. The due time and kind are not encrypted so reminders can be found. Alert emails do contain the note text.
- Notes never go to Claude and never appear in the questions log. Removing a person from the user list removes their notes.

## Board paper reader and private marks (v1.15)
Directors (anyone with board-paper access) open **Board papers** at the bottom of the screen, choose a paper and read it inside Ask: no Adobe, no download button. The original PDF is never changed; a director's marks are a separate private layer, created only when they make a mark.
- **Mark up:** select text, then pick a highlight colour (yellow noted, green agree, amber or orange query, red concern), a coloured circle (a rounded box round the words), underline, strikethrough, a comment or a question. Tap **¶ Sentence** first, then a colour or circle, to mark the whole sentence round the words you selected (v1.19). Spoken or typed: `circle bank debt in red`, `highlight amber network sales`, `colour the sentence containing lease provision green`, `circle the sentence with cash at bank in amber`. Marks are drawn over the reading copy only; the stored PDF is never changed. **Comment on this page** and **Question on this page** work without selecting text. Comments can be typed or dictated.
- **By voice or typing in the question box while a paper is open:** `highlight bank debt`, `highlight green bank debt on page 3`, `underline lease provision`, `strike out subject to approval on page 6`, `comment on page 4: ask Patrick about the lease`, `question page 2 why is headroom shrinking`, `go to page 5`, `next page`, `list my questions`, `read my remarks`, `delete remark 3`, `open the October board pack`. Highlights find the exact words on the page; if they are not found Ask says so.
- **My remarks** lists everything in page order with Go to, Edit and Delete; tick **Questions only** to show just your questions.
- **Send my questions** (or say `send my questions to Grant`, then `confirm send`) emails one message with each question, its page, the quoted line and the comment, to one person chosen from the active Ask users who have board-paper access, or to yourself. You see the email first. The paper is never attached and replies go to the sender's own address.
- **Private:** every mark belongs to one person and is stored encrypted (same key as notes); no admin screen shows it. Marks survive a paper being loaded again; deleting a paper deletes its reading copy and everyone's marks on it.
- **Reading copies:** Admin → Board papers now also stores each PDF. Papers loaded before v1.15 have no reading copy: load them again once. The reader sends the PDF to the director's browser (as any viewer must), so it is for directors only; there is no download or email-the-paper feature.

## Notes
- **Weekly sales upload formats (v1.19.4):** the wide Power BI file (`W/E dd/mm/yyyy` columns) and the long ConceptMate export (`week_ending, site_store, site_brand, state, sales, orders, atv, ...`, one row per store and week; the `Brand - ` prefix is removed to match store names; the `_ly`, `_var_pct` and `read` columns are ignored). Both go through the same preview and commit (`lib-weekly.js`: `parseAny`).
- Voice in uses the browser's speech recognition (Safari/Chrome/Edge, needs https and the microphone permission; Firefox has none). Voice out uses the browser's speech synthesis. Since v1.17.2 every voice path (main microphone, voice window, board paper comment box) shows a plain-English message for blocked, missing or silent microphones (`speechErrText` in `public/index.html`); the paper comment box shows interim words, a Stop button and a status line. iPhone/iPad fixes: Settings > Safari > Microphone; Settings > Privacy & Security > Speech Recognition > Safari; Settings > General > Keyboard > Enable Dictation. Not yet tested on Windows or Android.
- **CSV download (v1.18.0).** `drawChart` adds a Download CSV button to every chart (built in the browser, UTF-8 with a byte-order mark so Excel reads it). List results from sales-area tools (`TABLE_TOOLS` in `server.js`: rank_stores, rank_stores_growth, stores_by_opening, group_totals, compare_stores, store_sales_history, daily_sales, item_sales, weekly_trend, pipeline) are returned by `/api/ask` as `tables` (max 3, 500 rows, pages of one tool joined) and shown as a button under the answer when no chart is drawn. Finance, board, legal, pay, notes and library results are never exported. Each file starts with a title and a source/period line. To allow another tool, add it to `TABLE_TOOLS`.
- **Chart limits:** one chart type per chart (bar or line) and one scale. A combined bars-plus-line chart with a second axis would mean a per-series `kind` and `axis` in `show_chart` and a change to `drawChart`.
- `data/stores_master.csv` was built by `scripts/build_master.py` (sales store list + SharePoint details + best opening date). Opening dates carry a reliability label.
- Tests: `DATABASE_URL=... npm test` (uses a mocked Claude, real Postgres).

## Printing, voice window, and when answers are spoken

- **🖨 Print reply** (top bar) prints the last answer on a clean page: question, answer, date and data week. Greyed out until there is an answer.
- **Speaking.** On a big screen answers are silent until you press the 🔊 button on that answer (or tick "Read answers aloud automatically" — remembered). On a phone they are read aloud automatically.
- **🎙 Voice window** opens a small window (or go to `/?voice=1`; Option/Alt-click opens it in the same tab). Tap the microphone once, then just talk: it listens, answers aloud, and listens again. Say **repeat**, **stop**, **print**, **new chat**, **help** or **finish**. Tap the microphone to pause/resume. "Stop" is only heard between answers (the mic is off while it speaks); tap the mic to cut it off mid-sentence.
- `test/voice-test.js` tests this with a fake microphone and speaker.

## Daily sales by store (v1.13)

Admin → upload `sales_date,store,brand,state,sales,orders` (one row per store per trading day, from the Power BI Daily Sales dataset, as ConceptMate exports it; store names as in the weekly files, e.g. `Noodle Box - Geelong`). A store and day already held is **replaced** by the new figure, so the same days can be loaded again (the usual update is the last 14 days). Rows for a store that is not in the store list are skipped, not created; add the store first, then load the file again. The preview shows each day's total and how many store-days would be restated. Where a store has no state recorded, the file's state fills it; a state already recorded is never changed.

Questions use the `daily_sales` tool: one day (network, brand, state or store, against the same weekday last week and a year earlier on the stores that traded on both days), one store day by day, a ranking of stores for a day (by sales or by change on last week or last year), and totals for a range (by brand, state or day, against the equal-length period before). Orders are customer orders, and ATV is sales divided by orders. **The daily dataset is not the same basis as the weekly Sales Report** (it differed by about 3.5% for the same week), and the assistant is told to say which one it is quoting and never to mix them. Year-on-year comparisons appear once a year of days is held.

## Item sales by store

Admin → upload `brand,store,item_name,period_start,period_end,sales` (menu-item dollars per store for a block of weeks, captured from the Power BI Item Sales & Heatmap report). Loading replaces any earlier rows for the same brand and period. Stores are matched to store profiles by name. Questions use the `item_sales` tool (best sellers, one item's total and top stores, an item at one store). These figures are **not** on the same basis as the weekly Sales Report, and the assistant is told never to add or compare the two.

A `units` column is also accepted (`brand,store,item_name,period_start,period_end,sales,units`). **Virtual brands (v1.12):** Double Dragon Dumplings, Bokyo and the other virtual brands (Supreme Leader, Dante's Hot Chicken, Bama Fried Chicken, Plant Patty, Nature's Wok, Supreme Noodles) have no stores of their own. Upload them with the brand name in `brand` and the physical site in `store`, as Power BI names it (`Noodle Box - Ashmore`, `South Seoul - Casey`); each row is linked to that site's store profile, so store and state questions work. Their figures stay under their own brand and are separate from the host brand's.

## Code sign-in by email (optional; text messages also supported)

Instead of two shared passwords, each person signs in with their own email address and a 6-digit code sent to it (like a banking app). Switch it on only when you are ready; until then nothing changes.

**Setting it up (one time) with a Gmail account**
1. On the Gmail account that will send the codes: Google Account → Security → turn on 2-Step Verification, then search "App passwords" and create one (name it "C8 Ask"). Google shows a 16-letter password once; copy it.
2. In Railway → Variables add: `SMTP_USER` (the Gmail address), `SMTP_PASS` (the 16-letter app password, no spaces), `ADMIN_EMAIL` (your own email, the first admin; optionally `ADMIN_NAME`). Optional: `MAIL_FROM` such as `C8 Ask <you@gmail.com>`.
3. Redeploy. On first start it creates you as the first admin. Open the site, enter your email, enter the code you are sent (check junk the first time).
4. Admin page → **Users**: add each director (name + email). Choose "Ask" or "Ask + administer" and an access class (see "Access classes" below; a new person starts in Operations). "Switch off" cuts someone off within about 20 seconds, even if they are signed in.

**Using a Microsoft 365 mailbox instead:** set `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, `SMTP_USER` and `SMTP_PASS` for that mailbox. Your IT admin must allow "Authenticated SMTP" for it.

**Text messages instead (Twilio):** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `ADMIN_MOBILE`; people are then identified by mobile number. If email is also set up, email is used.

**What it does**
- Codes are 6 random digits (from the system's secure random generator), work for 5 minutes, work once, and are never stored (only a scrambled copy). Five wrong guesses cancel the code. At most 3 codes per person per 15 minutes, and attempts are rate-limited per device.
- The reply to "send me a code" is the same whether or not the address is registered, so nobody can discover who has access.
- Addresses are stored in your Railway database (needed to send), shown only to admins, and shown partly hidden in server logs.
- A sign-in lasts 12 hours by default (change the default with `SESSION_HOURS`). **Each person can have their own length**: Admin → Users → *Stays signed in* (1 hour up to 30 days). It is counted from when the person signed in and checked on every request, so a change takes effect on their next click (shortening signs them out at once if the time has already passed). Shorter is safer on a shared or lost device.
- Once it is on, `APP_PASSWORD` and `ADMIN_PASSWORD` no longer work and old sign-ins are ended.
- The admin page uses the same sign-in: sign in on the Ask page first (as an admin), then open the admin page.

**If you get locked out**: remove the `SMTP_*` (and `TWILIO_*`) variables in Railway and redeploy; the shared passwords work again (set `APP_PASSWORD`/`ADMIN_PASSWORD` if you removed them).

**Testing without a real mailbox**: `EMAIL_PROVIDER=console` (or `SMS_PROVIDER=console`) prints each code in the server log instead of sending it. Never use that on the live site.

## Sign-in record (who tried to get in)

Every attempt at signing in is kept: the email address or number as typed, what happened (code sent, signed in, wrong code, **not on the list**, not a valid address, switched-off person, blocked for too many tries), the internet address it came from and the time. Strangers get no code and are told nothing, but they appear here. It is on Admin → **Sign-ins** (default view: only people not on the list, with a 7-day count and the number of different addresses), can be downloaded as a CSV, and each line is also printed in the deployment log (for example `sign-in unknown_user: someone@example.com from 1.2.3.4`) so it is there even if the database is reset. Kept for about a year. The full address is stored on purpose; the codes themselves never are.

## Access classes (who may ask about what)

The users list is still the front door: only people you add can sign in. Inside it, each person is in an **access class**, which lists the areas of data they may ask about: *store sales and pipeline*, *organisation chart*, *company financial statements*, *finance team commentary*, *executive and director pay lines*, *budget and forecast*, and *board papers*.

* Three classes are set up. **Board** (directors, CFO, CEO) has every area and cannot be changed. **Finance only** has sales, the org chart and the financial statements, without commentary, executive pay, budget or board papers. **Operations** has sales and the org chart only. Admin → **Users** has a table where you tick the areas for Finance only and Operations, and a drop-down on each person to choose their class. Changes bite within about 20 seconds.
* **Administrators always have every area.** People who were already in when this was added were put in Board, so nobody lost anything; **a new person starts in Operations** until you promote them.
* It is enforced on the server. The tools a person's class does not allow are not offered to Claude and are refused if called, the Brands, Stores and Org chart windows are hidden for areas they lack, and the "what data is held" answer only describes what they may use. Claude is also told, for that person, what is outside their access so it will not guess. Commentary is the finance team's written notes; executive pay means finance lines naming executives, directors, incentives (LTI, STI), the CEO or CFO. Budget columns inside the financial reports are part of the finance area and stay visible to it.
* The two shared passwords (used only before code sign-in is switched on) have no classes: everyone who uses them sees everything, as before.
* Not covered: the PDF originals in Dropbox, and anything a person is told outside the app.

## FY27 budget

`data/budget_fy27.json` holds the FY27 budget as structured figures (network sales, revenue, costs, profit, Marketing Concepts, monthly cash flow, headcount) plus about 19 short assumption notes. Load it on the admin page: choose the file under the upload box, check the preview, press Load. Loading again replaces the same year and version. Ask about it by voice or text ("what is budgeted for royalties?", "what are the greenfield assumptions?", "how is Noodle Box tracking against budget?"). Signed-in directors only. Budget sales are not on the same basis as the weekly report, so comparisons are approximate.

## Monthly finance reports
Each month's Finance Board Report (the "Consolidated Financial Statements" PDF) is loaded on the admin page: choose one or several PDFs, check the table (month, revenue, net income, cash, CBA loan, balance sheet gap), press Load. The PDF is read on the server (pdfjs-dist). It keeps the profit and loss for the month and year to date against budget and last year, the whole balance sheet (this month, the month before as restated, same month last year), the written commentary, and every line including executive and director pay. Loading a month again replaces it. A scanned (image-only) PDF cannot be read.
The reports have no cash flow statement, so the question tool `finance` (overview, month, cash_flow, lines, trend, commentary) derives one for any held month from the two balance sheets inside that month's report plus its net income and dividend: operating cash flow, capital spending, free cash flow before dividend, growth investment (site advances, acquisitions), financing (CBA loan, shareholder loans, franchisee growth facilities) and the dividend. Where the report's own balance sheet does not balance, the gap is shown as an adjustment (the finance team's own cash flow page calls it "change in unbalanced balance sheet"). Signed-in directors only.

## Network Tracker pipeline
`python3 scripts/make-pipeline-json.py "NEW Network Tracker - 2025.xlsx" data/network_pipeline.json` turns the tracker workbook into one JSON file; upload it in Admin (recognised as `pipeline`). Loading replaces the whole pipeline. Tabs read: Greenfield, COUS, Opened, Transfers, Closures, FA Renewals, Lease Renewals, Activity, C8 Lease Liability. The question tool is `pipeline` (overview, list, site, delayed, expiries, activity).


## Board papers (board packs, Finance Board Reports, minutes, agendas)

Admin → **Board papers**: choose any number of the PDFs at once and press Load. For each paper the app keeps the text of every page (so a question can be pointed at the page) and asks Claude for a short summary with key points and decisions and their page numbers. Questions such as "what did the board decide about Ingle Farm?" or "key points in the latest board pack" use the `board_papers` tool, which answers from the summaries and from quoted page snippets and names the paper, the page and the file.

* Month and type come from the file name (for example "C8 Board Pack - February FY25.pdf", "Finance Board Report - Concept Eight Group (Aug 2026).pdf", "C8 Board Meeting Minutes 20 June 2024.pdf"); the financial year runs July to June.
* Loading a paper that is already held replaces it and keeps its link. "Summarise again" re-makes a summary from the stored text (useful after changing `BOARD_MODEL`, default `claude-haiku-5-5`, or the wording of the summary instructions in `lib-board.js`). "Link to original" lets you add a shared Dropbox link for each paper; the answer then mentions it. Where the originals are kept is `BOARD_PAPERS_LOCATION` (default "Dropbox > C8 > Consolidated Financial Statements > Board Papers").
* Summaries are machine-written. Figures still come from the finance tables; a figure quoted from a paper is said to be "as printed in that paper". Scanned or picture-only PDFs load but are only lightly searchable and get no summary.
* **Load summaries file** (Admin → Board papers): choose a `summaries.json` (an object keyed by PDF file name, each with title, covers, summary, key_points, decisions, topics). Papers already held are updated at once; for the others the summary is kept by file name (table `board_summaries`) and used when the PDF is loaded, so Claude is not called. Loading the file again replaces what was stored. Papers filled this way show `stored summary file` as the writer.
* A paper takes roughly 15 to 30 seconds to summarise when Claude writes it. About 100 papers is a 30 to 50 minute load: leave the page open.

- **Best/worst stores by growth:** the `rank_stores_growth` tool ranks stores by like-for-like year-on-year sales growth over the last N weeks (default 13), by brand/state. Only stores that traded in both years are ranked, so stores under a year old are excluded and counted. State is needed for state questions: upload a store_state file (store, brand, state) to fill blanks.
- **Opening dates by age:** the `stores_by_opening` tool lists stores opened more than/less than N years ago (by brand/state) with each date's source and reliability (low = franchise agreement start only).

- **Graphs and like-for-like:** `weekly_trend` gives weekly sales (total, store count, and like-for-like vs the same week a year earlier) and draws a bar chart; `show_chart` lets the assistant draw any bar/line chart from numbers it holds. LFL needs prior-year weeks loaded (Admin → Upload weekly sales).
- **Power BI like-for-like:** Admin → Upload `company_lfl_weekly.csv` (week_ending, lfl_pct, scope, source). `weekly_trend` then uses Power BI's own weekly Site LFL % for the company (scope All) and charts it. Weeks already held are replaced.

## How dates and periods work

- **Weeks** run Monday to Sunday and are named by the Sunday they end. "Last week" and "this week" mean the latest complete week held.
- **Days** such as "yesterday" come from the latest day held in the daily data, not today's date.
- **Week so far** comes from the daily sales, Monday to the latest day held. It is on the daily basis (about 3.5% from the weekly report) so it is never added to or compared with weekly figures.
- **Like-for-like** compares the same week a year earlier (364 days back so the weekday matches), only for stores that traded in both.
- **Finance** figures are per calendar month from the Finance Board Report; the financial year runs July to June (FY27 = July 2026 to June 2027).
- **Item sales** are held per period (a month or block of weeks) and answers name the period.
- The read me page shows a live "Data held right now" table (`/api/data-held`), so the dates there never go stale.

## My library (v1.17)

Each signed-in person can load their own text (a .docx, .txt, .md or .csv file, or pasted text) under **My library** and ask about it. Files are split into entries (at most 300 per upload, 8,000 characters each, 3,000 per person); a .docx is read directly with no extra packages, and old .doc files are refused with a message to save as .docx. CSV files need `title` and `text` columns. Loading the same file name again replaces it. The `my_library` tool (search / list / get) is scoped to the owner's user id in every query; administrators can see and delete entries under Admin → Library. The text is not encrypted (it must be searchable) and questions that use it are stored in the question log as "[question about a private library]" with no answer text. The area is called `library` and is given to the Board class once on deploy; other classes are set on the Users tab. Library text is passed to Claude as information only, and the tool description tells it never to follow instructions found inside it.
