-- C8 Ask: schema (idempotent)
CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,            -- name exactly as in the Power BI sales report
  brand TEXT NOT NULL,                  -- Noodle Box, Pattysmiths, Huxtaburger, Acai Bros, South Seoul, Wok In A Box - OTR
  division TEXT,
  state TEXT, address TEXT, phone TEXT,
  trading_company TEXT, bdm TEXT,
  sharepoint_name TEXT,
  opening_date DATE, opening_date_source TEXT, opening_date_confidence TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS store_aliases (
  alias TEXT NOT NULL,                  -- lower-case spoken/typed name, e.g. 'hawthorn noodle box'
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'auto',   -- 'auto' (rebuilt from the store name) or 'manual' (kept)
  PRIMARY KEY (alias, store_id)
);
ALTER TABLE store_aliases ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';
CREATE TABLE IF NOT EXISTS load_log (
  id SERIAL PRIMARY KEY, loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL, file_name TEXT, rows_inserted INT, rows_changed INT, note TEXT
);
CREATE TABLE IF NOT EXISTS weekly_sales (
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  week_ending DATE NOT NULL,            -- Sunday
  sales NUMERIC(12,2),
  orders INT, atv NUMERIC(8,2),
  load_id INT REFERENCES load_log(id),
  PRIMARY KEY (store_id, week_ending)
);
CREATE TABLE IF NOT EXISTS weekly_sales_history (  -- value before a restatement
  id SERIAL PRIMARY KEY, store_id INT NOT NULL, week_ending DATE NOT NULL,
  old_sales NUMERIC(12,2), new_sales NUMERIC(12,2), changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), load_id INT
);
CREATE TABLE IF NOT EXISTS weekly_totals (  -- the report's own TOTAL row, used as a check
  week_ending DATE PRIMARY KEY, report_total NUMERIC(14,2), report_orders INT, load_id INT
);
CREATE TABLE IF NOT EXISTS network_events (
  id SERIAL PRIMARY KEY,
  source TEXT, brand TEXT, restaurant TEXT, state TEXT,
  event_type TEXT, event_date TEXT,      -- text: some are only a month ('2026-06') or blank
  date_meaning TEXT, note TEXT,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ev_store ON network_events(store_id);
CREATE INDEX IF NOT EXISTS ws_week ON weekly_sales(week_ending);
CREATE TABLE IF NOT EXISTS ask_log (
  id SERIAL PRIMARY KEY, asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  question TEXT, tools TEXT, ms INT
);

-- map locations (filled by `npm run geocode` or the Stores admin tab)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS geo_source TEXT;   -- 'address' (good), 'name' (approximate), 'manual'

-- organisation chart (replaced as a whole by an org_chart CSV upload)
CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,                    -- 'VACANT' for an unfilled role
  position TEXT, department TEXT, team TEXT,
  parent_id INT REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'person',   -- person | vacant | group (a team box with no named head)
  chart_group TEXT,                      -- colour legend on the slide: Senior Leadership Team / Exec Team
  status_flag TEXT, region TEXT, notes TEXT, reports_to_basis TEXT
);
CREATE INDEX IF NOT EXISTS people_parent ON people(parent_id);

-- menu-item sales by store for a period (from the Power BI "Item Sales & Heatmap" report; replaced per brand + period)
CREATE TABLE IF NOT EXISTS item_sales (
  id SERIAL PRIMARY KEY,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  store_name TEXT NOT NULL, brand TEXT NOT NULL, item_name TEXT NOT NULL,
  period_start DATE NOT NULL, period_end DATE NOT NULL,
  sales NUMERIC(14,2) NOT NULL,
  load_id INT
);
CREATE INDEX IF NOT EXISTS item_sales_store ON item_sales(store_id);
CREATE INDEX IF NOT EXISTS item_sales_item ON item_sales(lower(item_name));
CREATE INDEX IF NOT EXISTS item_sales_period ON item_sales(brand, period_start, period_end);

-- individual sign-ins with a texted 6-digit code (used when SMS sign-in is switched on; see README)
CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mobile TEXT UNIQUE,                                -- E.164, e.g. +61412345678 (used when sign-in codes are texted)
  email TEXT,                                        -- lower-case (used when sign-in codes are emailed)
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS login_codes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                           -- the code itself is never stored
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_user ON login_codes(user_id, created_at DESC);

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE app_users ALTER COLUMN mobile DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email ON app_users(lower(email)) WHERE email IS NOT NULL;

-- FY budget (structured numbers + short assumptions notes); loaded from a JSON file on the admin page
CREATE TABLE IF NOT EXISTS budget_lines (
  id SERIAL PRIMARY KEY, fy TEXT NOT NULL, version TEXT NOT NULL, section TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '',
  line TEXT NOT NULL, period TEXT NOT NULL, value NUMERIC(18,2) NOT NULL, unit TEXT NOT NULL DEFAULT 'AUD', load_id INT
);
CREATE INDEX IF NOT EXISTS budget_lines_k ON budget_lines(fy, version, section);
CREATE TABLE IF NOT EXISTS budget_notes (
  id SERIAL PRIMARY KEY, fy TEXT NOT NULL, version TEXT NOT NULL, topic TEXT NOT NULL, note TEXT NOT NULL, load_id INT
);

-- what happened to each question (so that failures can be reviewed on the admin page)
ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE ask_log DROP COLUMN IF EXISTS user_id;   -- questions are not linked to who asked
ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS answer TEXT;
ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS note TEXT;

-- franchise / lease details per store (from the SharePoint Franchise Master; loaded by a store_agreements upload)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS abn TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS royalty_rate NUMERIC(6,4);   -- fraction, 0.06 = 6%
ALTER TABLE stores ADD COLUMN IF NOT EXISTS fa_start DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS fa_end DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS fa_options TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lease_start DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lease_end DATE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS lease_options TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS landlord TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS site_size TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS annual_rent TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS property_agent TEXT;

-- Network Tracker pipeline (replaced as a whole by a pipeline JSON upload)
CREATE TABLE IF NOT EXISTS pipeline_projects (
  id SERIAL PRIMARY KEY,
  tab TEXT, kind TEXT,                       -- greenfield, cous, opened, transfer, closure, fa_renewal, lease_renewal
  restaurant TEXT, brand TEXT, state TEXT, gsm TEXT, partner TEXT,
  status TEXT, at_risk TEXT,
  target_date DATE, actual_date DATE, delayed_days INT, delay_reason TEXT,
  budgeted_date DATE, est_weekly_sales NUMERIC(12,2), lost_revenue NUMERIC(12,2),
  fa_expiry DATE, lease_expiry DATE,
  store_id INT REFERENCES stores(id) ON DELETE SET NULL,
  as_of DATE, load_id INT
);
CREATE INDEX IF NOT EXISTS pp_kind ON pipeline_projects(kind);
CREATE INDEX IF NOT EXISTS pp_store ON pipeline_projects(store_id);
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id SERIAL PRIMARY KEY, project_id INT NOT NULL REFERENCES pipeline_projects(id) ON DELETE CASCADE,
  seq INT, phase TEXT, step TEXT, value TEXT
);
CREATE INDEX IF NOT EXISTS ps_project ON pipeline_steps(project_id);
CREATE TABLE IF NOT EXISTS pipeline_activity (
  id SERIAL PRIMARY KEY, brand TEXT, restaurant TEXT, state TEXT, type TEXT, action_date DATE,
  franchise_partner TEXT, incentive TEXT, description TEXT, lead_source TEXT, store_id INT REFERENCES stores(id) ON DELETE SET NULL, load_id INT
);
CREATE TABLE IF NOT EXISTS lease_liability (
  id SERIAL PRIMARY KEY, site TEXT, term_years NUMERIC, commencement DATE, expiry DATE, bank_guarantee NUMERIC(12,2),
  landlord TEXT, tenant TEXT, guarantor TEXT, occupancy_licence TEXT, further_term TEXT, store_id INT REFERENCES stores(id) ON DELETE SET NULL, load_id INT
);

-- Monthly Finance Board Report (consolidated financial statements): loaded from the PDF on the admin page
CREATE TABLE IF NOT EXISTS fin_reports (
  period DATE PRIMARY KEY,                    -- month end
  file_name TEXT, commentary TEXT, assets NUMERIC(14,2), liab_equity NUMERIC(14,2), own_cash_flow JSONB,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(), load_id INT
);
CREATE TABLE IF NOT EXISTS fin_pl (
  id SERIAL PRIMARY KEY, period DATE NOT NULL REFERENCES fin_reports(period) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- month, ytd, summary
  seq INT, grp TEXT, section TEXT, line TEXT NOT NULL,
  actual NUMERIC(14,2), budget NUMERIC(14,2), ly NUMERIC(14,2)
);
CREATE INDEX IF NOT EXISTS fin_pl_k ON fin_pl(period, kind);
CREATE TABLE IF NOT EXISTS fin_bs (
  id SERIAL PRIMARY KEY, period DATE NOT NULL REFERENCES fin_reports(period) ON DELETE CASCADE,
  seq INT, grp TEXT, section TEXT, line TEXT NOT NULL,
  amount NUMERIC(14,2), prior NUMERIC(14,2), ly NUMERIC(14,2)   -- this month, the month before (as restated in this report), same month last year
);
CREATE INDEX IF NOT EXISTS fin_bs_k ON fin_bs(period);

-- Board papers library (board packs, Finance Board Reports, minutes, agendas): page text for search, plus a Claude-written summary
CREATE TABLE IF NOT EXISTS board_docs (
  id SERIAL PRIMARY KEY, file_name TEXT NOT NULL UNIQUE, title TEXT, doc_type TEXT NOT NULL DEFAULT 'other',
  period DATE, meeting_date DATE, covers TEXT, summary TEXT, key_points JSONB NOT NULL DEFAULT '[]', decisions JSONB NOT NULL DEFAULT '[]',
  topics TEXT[] NOT NULL DEFAULT '{}', page_count INT, text_chars INT, summarised_by TEXT, summary_note TEXT, summarised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  link TEXT, loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(), load_id INT
);
CREATE TABLE IF NOT EXISTS board_pages (
  doc_id INT NOT NULL REFERENCES board_docs(id) ON DELETE CASCADE, page INT NOT NULL, txt TEXT NOT NULL, PRIMARY KEY (doc_id, page)
);
CREATE INDEX IF NOT EXISTS board_pages_fts ON board_pages USING GIN (to_tsvector('english', txt));
CREATE INDEX IF NOT EXISTS board_docs_period ON board_docs(period);
-- Summaries loaded from a file (written ahead of time), kept by file name so a PDF load uses them instead of calling Claude
CREATE TABLE IF NOT EXISTS board_summaries (
  file_name TEXT PRIMARY KEY, data JSONB NOT NULL, loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
