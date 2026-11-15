# C8 Ask - hosting pack (DRAFT for the technical lead)

Status: draft for later. Not yet reviewed or run inside C8. Copy `deploy/Dockerfile` and `deploy/.dockerignore` to the repository root when building.

## 1. What runs
- One Node 20 web app (`server.js`) plus one PostgreSQL database (version 14 or later).
- Browser pages are static files served by the app. No separate front-end build.
- Outbound connections: Anthropic API (questions and looked-up figures), your mail service (SMTP), optionally Google Maps/Geocoding and Twilio (SMS). Each can be left off.

## 2. Settings and secrets (environment variables)
Keep secrets in Key Vault or the container's secret settings, never in the repository.

| Name | Secret? | Purpose |
|---|---|---|
| DATABASE_URL | yes | Postgres connection string |
| DATABASE_SSL | no | set to require TLS to the database if the host needs it |
| ANTHROPIC_API_KEY | yes | C8's own key, with a spend limit |
| ANTHROPIC_MODEL, BOARD_MODEL | no | model names |
| SESSION_SECRET | yes | 32+ random characters, generated new for C8 |
| NOTES_KEY | yes | encryption key for notes and board marks, generated new; losing it makes those unreadable, so back it up in the vault |
| ADMIN_EMAIL, ADMIN_NAME | no | first administrator |
| EMAIL_PROVIDER, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM | pass is secret | sign-in code email |
| SESSION_HOURS | no | session length |
| GOOGLE_MAPS_API_KEY, GOOGLE_GEOCODE_KEY | yes | optional, store maps |
| SMS_PROVIDER, TWILIO_* | yes | optional, SMS codes |
| PORT | no | default 3000 |

Do not set ANTHROPIC_MOCK, GEOCODE_MOCK or NO_SEED in production.

## 3. First start
1. Create the database and user. 2. Run `node scripts/init-db.js` (creates tables; safe to repeat). 3. Start the app and sign in as ADMIN_EMAIL. 4. Load data from Admin > Upload: stores, weekly sales, daily takings, and so on. `scripts/load.js` loads sample data only, not needed in production.

## 4. Backups
Back up the Postgres database nightly and test a restore. Back up NOTES_KEY separately in the vault.

## 5. Data flow (for the security review)
- Staff sign in by emailed code (to be replaced by Microsoft Entra sign-in if preferred; access classes would map to Entra groups - this change is not yet built).
- Each question goes to Anthropic with the results of a fixed set of read-only database lookups. Claude never writes SQL and cannot change data.
- Areas are gated by access class (finance, board, legal, pay, notes, library). An area can be left empty or switched off until the reviewers are comfortable.
- Notes and board marks are encrypted in the database; the library is private to each user.
- Questions are logged with their cost so use can be reviewed.

## 6. Before any copy leaves Tim's environment
Remove: restaurant guide, notes, library entries, test users, personal wording in the read me. Use a fresh database in C8, not a copy of Tim's.

## 7. Open items
Entra sign-in; confirm Anthropic data-handling terms for the finance and board areas; choose host (Azure Container Apps or App Service); who owns the repository.
