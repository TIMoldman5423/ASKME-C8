# C8 Ask: handover pack

For the CFO, C8's technical lead and the AI Council. C8 Ask is offered as a free contribution: C8 can review it, trial it, adapt it or put it aside. Nothing is expected either way, and this pack deliberately says nothing about money, valuation or licensing. Written 13 November 2026; current for version 1.19.9. Facts in this pack come from the code and the tests; anything that was not checked is marked **to confirm**.

## 1. What it is, in one page

C8 Ask answers everyday questions about C8 in a few seconds, by voice or typing, on any phone, iPad or computer with a browser. Examples: how a store traded last week, who is top this week, what sells at a store, what the manual says about a procedure, what the budget says.

It is the quick and basic tool. ConceptMate (CM) stays the tool for deep, unusual or exact analysis. Ask answers from data loaded in advance, so it is fast and cheap; CM builds each answer from scratch against Power BI, so it is powerful but slower and costlier.

One timed test of the same question ("what were the sales for Geelong last week") took Ask 8.6 seconds and CM 3 minutes 12 seconds, with the same correct figure. This is one test, not a benchmark; a proper comparison of ten questions is in the pilot plan.

```
Question (voice or text)
  -> server checks who you are and which areas you may use
  -> Claude is given the rules and the tools you may use, and picks one
  -> the tool runs a fixed, read-only database query and returns exact rows
  -> Claude words a short answer from those rows (it may call another tool; up to 6 rounds)
  -> answer shown and, if wanted, read aloud by the browser
```

The key design choice: Claude never writes SQL and never answers from memory. Every figure comes from a tool result. If the data does not hold the answer it says so.

## 2. Architecture and hosting

| Part | What it is | Where it runs |
| --- | --- | --- |
| Web app and API | Node.js 20+ with Express (`server.js` and `lib-*.js`) | Railway web service, deployed automatically from a GitHub repository |
| Database | PostgreSQL (tables in `schema.sql`) | Railway Postgres service |
| Screens | Plain HTML and JavaScript, no framework (`public/`) | Served by the web app |
| AI | Anthropic Claude API (default model `claude-sonnet-5-5`; board paper summaries use `claude-haiku-5-5`) | Anthropic |
| Sign-in codes | Email by SMTP, or text by Twilio (optional) | Company mail server / Twilio |
| Maps | Google Maps and Geocoding (optional) | Google |
| Board paper reader | pdf.js, bundled in `node_modules` and served by the app | Browser |

Voice uses the browser's own speech recognition and speech synthesis, not a server service. Recognition works in Safari, Chrome and Edge; Firefox has none, so those users type. Test the microphone on each device type before relying on it (**to confirm** on Windows and Android). From v1.17.2 a blocked, missing or silent microphone produces a plain message with the fix (on iPhone/iPad: Settings > Safari > Microphone, Settings > Privacy & Security > Speech Recognition, Keyboard > Enable Dictation). Staff who cannot get voice working can always type.

Export: from v1.18.0 every chart and every list answer from the sales tools has a Download CSV button (built in the browser, no extra server cost). Finance, board, legal, pay, notes and library answers have none, so restricted figures do not spread by accident.

Size: one small server and one database. It suits a handful of directors; **company-wide use needs a load test** and probably a larger plan.

## 3. Speed and how the AI is used

- Each question sends Claude the rules text (about 2,300 tokens) plus the definitions of every tool the person may use (about 6,000 tokens), the last six turns of the conversation and the question. This is why input is thousands of tokens and the answer a few dozen. Prompt caching (`cache_control` in `server.js`) makes the repeated part cheap.
- Every tool definition is sent with every question, so each new tool adds a little cost to every question. Combine related lookups into one tool with an `action` argument.
- Usage is recorded per question in `ask_log` (tokens in and out, tools used, time taken) and shown on the admin Questions tab. The price constants in `server.js` (`PRICE`, overridable with `PRICE_IN`, `PRICE_OUT`, `PRICE_CACHE_WRITE`, `PRICE_CACHE_READ`) feed the cost column there; check them against the provider's current list if the column is used.

## 4. Running it

### Deploy

1. Push the repository contents to GitHub (private). Railway deploys on every push.
2. Railway needs the web service and a Postgres service. The tables are created on start-up and by `npm run init-db`; it is safe to run repeatedly.
3. Starting data: `npm run load` (one-off, from `data/`).
4. After a deploy, check the version number beside the title in the app matches `VERSION` in `server.js`.

### Environment variables (set in Railway, never in the code)

| Variable | Needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection (reference the Railway Postgres service) |
| `SESSION_SECRET` | yes | Signs sign-in cookies. Long random value. |
| `ANTHROPIC_API_KEY` | yes | Claude API key. Should belong to a C8 account. |
| `NOTES_KEY` | yes | Encrypts notes, board marks and similar. **Keep a copy; if it is lost or changed, existing notes cannot be read.** |
| `ADMIN_EMAIL`, `ADMIN_MOBILE`, `ADMIN_NAME` | first start | Creates the first administrator |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | for email sign-in, reminders, "send my questions" | The default host is `smtp.gmail.com`, so **C8 will need to point this at its own mail service** (**to confirm** how, for example a Microsoft 365 mailbox) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | optional | Text-message sign-in |
| `APP_PASSWORD`, `ADMIN_PASSWORD` | only for shared-password mode | Older mode where everyone shares one password and sees everything; do not use it company-wide |
| `GOOGLE_MAPS_API_KEY`, `GOOGLE_GEOCODE_KEY` | optional | Map windows and finding store coordinates |
| `ANTHROPIC_MODEL`, `BOARD_MODEL` | optional | Override the models |
| `SESSION_HOURS` | optional | Default sign-in length (12 hours) |
| `BOARD_PAPERS_LOCATION` | optional | Text telling people where original papers are kept |
| `PRICE_*`, `DATABASE_SSL`, `PORT`, `NODE_ENV` | optional | See code comments |

Test-only settings (`EMAIL_PROVIDER=console`, `SMS_PROVIDER=console`, `ANTHROPIC_MOCK`, `GEOCODE_MOCK`, `NO_SEED`) must never be set in production.

### Tests

`npm test` runs 98 integration tests against a real, empty Postgres (`DATABASE_URL`), using a mock Claude. Create the database, run `npm run init-db && npm run load`, then `npm test`. **Do not deploy unless all tests pass.** Postgres on a development machine may need starting first.

### Routine tasks

| Task | Who | How often |
| --- | --- | --- |
| Weekly sales | Admin | Each Wednesday for the week just ended: export from ConceptMate, Admin > Upload a CSV |
| Daily sales | Admin | Rolling run of days, same page |
| Item sales | Admin | Monthly, one file per brand |
| Finance reports | Admin | Each month: Admin > Monthly finance reports (PDF) |
| Network Tracker | Admin | About every two weeks |
| Check the Questions tab | Owner | Weekly: unanswered questions show which data or tool to add next |
| Database backups | IT | **Not set up by this code. To confirm** what Railway provides and test a restore |

### When something goes wrong

- Version did not change: GitHub still has the old files; push again and check the Railway deploy log.
- "Missing env": a required variable is not set.
- An upload shows few rows or unknown stores: read the preview; most problems are a bad export (for example an 8-byte file) or a store name not matched. Fix the file and load again; most loads replace only their own slice.
- Wrong or missing answer: open Admin > Questions, find it, and see which tool was used and what it returned.
- Sign-in codes not arriving: check the SMTP/Twilio variables and Admin > Sign-ins.

## 5. Data and how it gets in

| Data | Source | Loaded by | Replaces |
| --- | --- | --- | --- |
| Stores, aliases | `data/` plus store files | Admin upload | By store |
| Weekly sales | Power BI sales report via ConceptMate export | Admin upload | The week, per store; restated values keep history |
| Daily sales | Power BI Daily Sales dataset | Admin upload | The store and day |
| Item sales | Power BI Item Sales report | Admin upload | The brand and period |
| Finance reports | Monthly Finance Board Report PDFs | Admin PDF upload | The month |
| Budget | JSON made by `scripts/make-budget-json.py` | Admin upload | The financial year and version |
| Network Tracker | JSON made by `scripts/make-pipeline-json.py` | Admin upload | The whole pipeline |
| Org chart | CSV | Admin upload | The whole chart |
| Manuals, legal documents | Text or PDF | Admin | By document |
| Board papers | PDFs | Admin | By paper (the PDF is also kept so directors can read and mark it) |

The weekly and daily figures differ by about 3.5% (different Power BI datasets), so Ask never adds or compares them. Item sales are on yet another basis. The in-app read me (`docs/readme.html`) shows a live "Data held right now" table so dates never go stale.

**Recommended next step:** replace the manual weekly exports with an automated feed (a scheduled Power BI export or Power Automate flow into a folder or storage the app reads), with the same preview and checks. **To confirm** what C8's Power BI licensing allows.

## 6. Access and security

- **Sign-in:** each person is a user with an email address or mobile number and a 6-digit code (valid 5 minutes, single use, five tries, limited sends). Sessions last 12 hours by default, 1 hour to 30 days per person. Every sign-in attempt is logged (Admin > Sign-ins).
- **Access classes:** each person is in a class that lists the areas they may use: sales and stores, organisation chart, company financial statements, finance commentary, executive and director pay, budget, board papers, manuals, legal documents, restaurant guide, library. Classes are edited on the Users tab. Limits are enforced on the server: tools outside a person's areas are not offered to Claude and are refused if called.
- **Private material:** notes (encrypted, owner only, never sent to Claude or logged), board paper marks (encrypted, owner only; only the questions a director chooses to send are emailed, never the paper), and the library (owner and administrators only, **not encrypted**, sent to Claude when asked about, logged without content).
- **Logging:** every question, the tools used, outcome, time and cost are logged for administrators. Private-library questions are logged without text.
- **Secrets** live only in Railway variables.
- **Not done, to consider before company-wide use:** single sign-on with Microsoft accounts instead of emailed codes; an external security review; rate limits tuned for 70 users; an audit trail for administrator actions beyond the load history.

## 7. Modules, and what can be removed

Each feature is separate. Removing one means removing its tool, area, upload type and screen button; the tests show what depends on what.

| Module | Files | Area | Notes |
| --- | --- | --- | --- |
| Sales, stores, map, rankings | `tools.js`, `lib-weekly.js`, `lib-data.js`, `lib-geo.js` | sales | The core. Keep. |
| Organisation chart | `tools.js`, `lib-data.js` | org | Small |
| Company finance and budget | `lib-finance.js`, `tools.js` | finance, finance_commentary, exec_pay, budget | Confidential classes |
| Board papers | `lib-board.js` | board_papers | Candidate to restrict or remove for company-wide use |
| Board paper reader and marking | `lib-markup.js`, `public/reader.js` | board_papers | Depends on board papers |
| Operating manuals | `lib-manuals.js` | manuals | Likely useful to operations and support staff |
| Legal documents and agreements | `lib-manuals.js`, `tools.js` | legal, finance | Confidential |
| Private notes and reminders | `lib-notes.js` | any signed-in person | Needs personal sign-in |
| My library | `lib-library.js` | library | General personal text; keep or remove |
| Restaurant guide | `tools.js`, `lib-data.js` | restaurants | Personal; example of adding a dataset. Remove if not wanted. |

## 8. Adding or changing things

See `CLAUDE.md` in the repository: the design rules, where things are, and the steps to add a dataset or tool. The sensible way to work is a developer using an AI coding assistant against this repository and its tests, as it was built.

Likely first additions for a company-wide version: user classes for GSMs, marketing and finance staff; datasets from ConceptMate exports for time of day, channel mix, loyalty and labour (each loaded as prepared tables, which keeps answers fast); an automated data feed.

## 9. A suggested trial, the crossover, and support

### The trial (look, try, decide)

| Stage | What happens | Who | Outcome |
| --- | --- | --- | --- |
| 1. Look | The technical lead reads this pack and `CLAUDE.md`, runs the tests and reviews the code and the security design. No C8 systems are touched. | C8 technical lead, with the author on call | A list of questions and concerns |
| 2. Try | A small named group (for example ops, support and finance) uses the live app, hosted by the author, for four to six weeks on a limited set of areas. Board-level areas can be left out. | CFO's nominated group, the author | Usage and feedback |
| 3. Review | The CFO and technical lead decide whether to use it, adapt it, or set it aside. All three are good outcomes. | CFO, technical lead | A written decision |

What the trial can measure, with no dollar figures: questions per week by team; how often Ask answered without sending the person to ConceptMate; seconds to answer; figures that disagree with Power BI or the source reports; questions Ask could not answer (the Questions tab); and any security or access concerns.

### Crossing from the author's copy to C8's

| Route | What moves | Effort for C8 | Choose it when |
| --- | --- | --- | --- |
| A. Keep it hosted by the author for longer | Nothing | None | C8 wants more time before deciding |
| B. Copy the code into C8's own accounts | The repository, a new hosting project, a new Postgres database and C8's own Anthropic key; data re-loaded by C8's administrator | A day or two for a developer following this pack | C8 wants the product as it stands, run by C8 |
| C. Take the design and rebuild it in C8's stack | The design rules and lookups, rebuilt on C8's chosen platform | Larger, depending on the platform | C8 wants it inside its existing Microsoft or Azure tools |

Checklist for route B:

- [ ] Name a C8 owner (business) and a maintainer (developer, internal or contract). Name who approves access for each user class.
- [ ] Create C8-owned GitHub, hosting, Postgres and Anthropic accounts. Do not reuse any of the author's keys.
- [ ] Copy the code across and deploy from C8's repository; check the version number shown beside the title.
- [ ] Create fresh `SESSION_SECRET` and `NOTES_KEY` values and keep copies (changing `NOTES_KEY` makes existing notes unreadable). Point email (and text, if used) at C8's own services.
- [ ] Remove personal and non-C8 material from the copy: the restaurant guide data, personal notes and library entries, test users, and author-specific wording in the read me.
- [ ] Decide which modules in section 7 to keep, and who sees confidential areas.
- [ ] Load the data through the Admin upload screens, create the user list, and ask the same ten questions of both copies.
- [ ] Run the test suite in the new environment, set up and test database backups, then move the users across.
- [ ] Remove C8 data from the author's copy once C8's is running.

### Support and continuing maintenance

C8 names three roles and keeps the routine small: an **owner** (decides which data and areas are offered and who has access), a **technical maintainer** (code, hosting, settings; changes made with `CLAUDE.md`) and a **data administrator** (weekly and monthly loads, checking each preview before saving). The routine tasks are in section 4. Add these to keep it healthy:

| Routine | How often | Who |
| --- | --- | --- |
| Review the user list and access classes | Quarterly | Owner |
| Update packages, run the tests, redeploy | Quarterly, or when security notices arrive | Technical maintainer |
| Check the AI provider's notices for changes that affect the tool | Quarterly | Technical maintainer |
| Back up the database and test a restore | As the hosting plan allows | Technical maintainer |

The author's part is to be available during the trial and for a handover window agreed with the CFO, to answer questions and to fix faults in his own copy. The real test that the code can be maintained is that C8's technical maintainer makes the first two changes without the author, using only `CLAUDE.md` and the tests. A natural improvement for C8 to consider is replacing the manual weekly uploads with a scheduled export or data-lake feed (section 5).

## 10. Known limits

- Weekly orders and average transaction value are held for the latest week only (daily data holds orders for every day).
- Time of day, channel, loyalty, labour and detailed slices are not held: ask ConceptMate.
- Item sales usually cover a store's top items and are not on the same basis as weekly sales.
- Figures differ from Power BI by a few percent; for an exact figure use ConceptMate.
- Finance reports are held only for the months loaded; the reports have no cash flow statement, so cash flow is derived and labelled as an estimate.
- The Network Tracker is as current as its latest entry.
- One database and one small server; not yet load tested for company-wide use.
- Charts are bars or lines on one scale; no combined bars-plus-line chart with a second axis (possible small addition: per-series kind and axis in `show_chart`/`drawChart`).
- CSV download covers charts and sales-tool lists only, as .csv (not .xlsx), up to 500 rows.
