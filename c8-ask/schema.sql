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
