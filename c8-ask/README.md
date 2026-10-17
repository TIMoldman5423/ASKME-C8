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

## Maintaining the data (/admin)
- **Upload a CSV**: weekly sales (Power BI), store details (SharePoint capture), opening dates, network events, new stores. The type is recognised from the header row; the preview shows matches, unmatched/ambiguous names, restated figures and whether the stores add up to the report's TOTAL row. Templates are on the page.
- **Stores**: search, edit any store (state, address, opening date, trading company…), add a store, add the other names people say, mark a store inactive, download everything as CSV.
- **History**: every upload and edit is logged. A restated sales figure keeps its old value in `weekly_sales_history`.
- Orders and ATV for later weeks go in the weekly file as extra columns `orders w/e dd/mm/yyyy` and `ATV w/e dd/mm/yyyy`.

## Notes
- Voice in uses the browser's speech recognition (Safari/Chrome, needs https and the microphone permission). Voice out uses the browser's speech synthesis.
- `data/stores_master.csv` was built by `scripts/build_master.py` (sales store list + SharePoint details + best opening date). Opening dates carry a reliability label.
- Tests: `DATABASE_URL=... npm test` (uses a mocked Claude, real Postgres).
