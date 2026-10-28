// Monthly "Finance Board Report" PDFs (the C8 Consolidated Financial Statements): read the PDF, keep the profit and loss
// (month and year-to-date), the balance sheet (this month, prior month, same month last year) and the commentary, and work out a
// cash flow for any month held. The reports have no cash flow statement of their own, so the cash flow is derived from the
// movement between the two balance sheets in the same report, plus that month's net income and dividend.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONEY = /^-?\$[\d,]+(?:\.\d+)?$/;
const toNum = t => Number(t.replace(/[$,]/g, ''));
const BS_GROUPS = ['Cash & Equivalents', 'Accounts Receivable', 'Inventory', 'Other Current Assets', 'Fixed Assets', 'Intangible Assets', 'Investments or Other Non-Current Assets',
  'Accounts Payable', 'Tax Liability', 'Other Current Liabilities', 'Long Term Debt', 'Other Non-Current Liabilities', 'Retained Earnings', 'Current Earnings', 'Other Equity'];
const PL_GROUPS = ['Revenue', 'Expenses', 'Other Income', 'Other Expenses', 'Interest Expenses', 'Dividends'];
const COLUMN_HEADER = /Variance|This month vs|This year vs|same month|\(YTD\)|^\(.*\)$|^budget \(|^\$?\)$|last year|^LY$|^\(\$\)|year \(\$/i;

// ---- PDF -> text lines ----
async function extractLines(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5] })).sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const it of items) {
      if (cur && Math.abs(cur.y - it.y) <= 2.5) cur.items.push(it); else { cur = { y: it.y, items: [it] }; lines.push(cur); }
    }
    // mark the page break by a blank line so a table never runs across it by accident
    lines.push({ y: 0, items: [], brk: true });
  }
  return lines.map(l => l.brk ? '' : l.items.sort((a, b) => a.x - b.x).map(i => i.s.trim()).join(' ').replace(/\s+/g, ' ').trim());
}

// The report month. Covers of the newer board packs print the FINANCIAL year, not the calendar year ("JULY 2027 | FINANCIAL YEAR" is
// July 2026, because FY27 runs July 2026 to June 2027), so for those the July-December months are moved back one year.
function periodOf(lines) {
  const top = lines.slice(0, 15);
  const fyCover = top.some(l => /FINANCIAL YEAR/i.test(l));
  for (const l of top) {
    const m = /^([A-Za-z]+)\s+(20\d\d)(\s+FINANCIAL YEAR.*)?$/i.exec(l); const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (mi >= 0) {
      let y = Number(m[2]); if ((fyCover || m[3]) && mi >= 6) y -= 1;
      const last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(); return `${y}-${String(mi + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    }
  }
  return null;
}

// split a table line into its label and its dollar columns
function splitRow(line) {
  const t = line.split(' '); const i = t.findIndex(x => MONEY.test(x));
  if (i < 0) return { label: line, money: [] };
  return { label: t.slice(0, i).join(' ').trim(), money: t.slice(i).filter(x => MONEY.test(x)).map(toNum) };
}

function parseReport(lines) {
  const period = periodOf(lines);
  const out = { period, pl: [], bs: [], commentary: '', problems: [], own_cash_flow: null };
  if (!period) { out.problems.push('Could not find the report month (e.g. "September 2025") on the first page.'); return out; }
  if (period > new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10)) out.problems.push(`The report month read as ${period.slice(0, 7)}, which is in the future. Reports can print the financial year (FY27 = July 2026 to June 2027), so check the month before loading.`);
  let mode = null, grp = null, section = null, seq = 0, skipped = 0;
  const commentary = [];
  let inSummary = false, inCommentary = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]; if (!line) continue;
    // ----- mode switches -----
    if (/^PROFIT & LOSS\s+\d{4}\/\d{4}/.test(line)) { mode = 'ytd'; grp = null; section = null; inSummary = false; inCommentary = false; continue; }
    if (/^PROFIT & LOSS\s+[A-Z][a-z]{2}\s+\d{4}/.test(line)) { mode = 'month'; grp = null; section = null; inSummary = false; inCommentary = false; continue; }
    if (/^BALANCE SHEET\b/.test(line)) { mode = 'bs'; grp = null; section = null; inSummary = false; inCommentary = false; continue; }
    if (/^Cash Flow Analysis/.test(line)) { mode = 'cf'; continue; }
    if (mode === 'cf') { if (/^Graphs/.test(line)) mode = null; else if (!out.own_cash_flow && /^-?\$[\d,]+ -?\$[\d,]+ -?\$[\d,]+$/.test(line)) { const v = line.split(' ').map(toNum); out.own_cash_flow = { operating: v[0], free: v[1], net: v[2] }; } continue; }
    if (!mode) {
      if (/^Profit and Loss Summary/.test(line)) { inSummary = true; inCommentary = false; seq = 0; grp = 'Summary'; section = null; continue; }
      if (/^Profit and Loss Commentary|^Other Expenses Commentary|^Balance Sheet\b/.test(line)) { inSummary = false; inCommentary = true; }
      if (inSummary) {
        if (COLUMN_HEADER.test(line)) continue;
        const { label, money } = splitRow(line);
        if (money.length === 3 && label) out.pl.push({ kind: 'summary', seq: seq++, grp: 'Summary', section: null, line: label, actual: money[0], budget: money[1], ly: null });
        continue;
      }
      if (inCommentary) commentary.push(line);
      continue;
    }
    // ----- table lines -----
    if (COLUMN_HEADER.test(line)) continue;
    if (/^(ASSETS|LIABILITIES|EQUITY)$/.test(line)) continue;
    const { label, money } = splitRow(line);
    if (!money.length) {   // a heading
      if (mode === 'bs' && BS_GROUPS.includes(line)) { grp = line; section = line; }
      else if (mode !== 'bs' && PL_GROUPS.includes(line)) { grp = line; section = line; }
      else if (!/^[\d.]+$/.test(line) && line.length < 80) section = line;
      continue;
    }
    if (!label) continue;
    if (money.length !== 5) { skipped++; if (out.problems.length < 8) out.problems.push(`Skipped a line with ${money.length} figures instead of 5: "${line.slice(0, 80)}"`); continue; }
    if (mode === 'bs') {
      out.bs.push({ seq: seq++, grp, section, line: label, amount: money[0], prior: money[1], ly: money[3] });
    } else {
      out.pl.push({ kind: mode, seq: seq++, grp, section, line: label, actual: money[0], budget: money[1], ly: money[3] });
    }
    if (/^Total /.test(label)) section = grp;
  }
  out.commentary = commentary.join('\n').slice(0, 15000);
  out.skipped = skipped;
  const bsv = n => (out.bs.find(r => r.line === n) || {}).amount;
  out.assets = bsv('Total Assets'); out.liab_equity = bsv('Total Liabilities & Equity');
  out.counts = { month: out.pl.filter(r => r.kind === 'month').length, ytd: out.pl.filter(r => r.kind === 'ytd').length, summary: out.pl.filter(r => r.kind === 'summary').length, bs: out.bs.length };
  if (!out.counts.month) out.problems.push('No monthly profit and loss lines found.');
  if (!out.counts.bs) out.problems.push('No balance sheet lines found.');
  return out;
}

// ---- headline numbers for previews and the overview ----
const pick = (arr, name, f) => { const r = arr.find(x => x.line === name); return r ? r[f] : null; };
function headline(p) {
  const m = p.pl.filter(r => r.kind === 'month');
  return { net_income: pick(m, 'Net Income', 'actual'), revenue: pick(m, 'Total Revenue', 'actual'), cash: pick(p.bs, 'Total Cash & Equivalents', 'amount'), cba_loan: pick(p.bs, 'CBA Loan Facility', 'amount'), total_assets: p.assets, total_liabilities_equity: p.liab_equity };
}

async function analyse(c, parsed, fileName) {
  const h = headline(parsed);
  const ex = parsed.period ? (await c.query('SELECT 1 FROM fin_reports WHERE period=$1', [parsed.period])).rowCount > 0 : false;
  return { type: 'finance', file: fileName, period: parsed.period, month: parsed.period ? parsed.period.slice(0, 7) : null, counts: parsed.counts, headline: h,
    balance_diff: parsed.assets != null && parsed.liab_equity != null ? parsed.assets - parsed.liab_equity : null, replaces_existing: ex, has_commentary: parsed.commentary.length > 0, own_cash_flow: parsed.own_cash_flow, problems: parsed.problems, skipped: parsed.skipped };
}

async function commit(c, parsed, fileName) {
  if (!parsed.period || !parsed.counts.month || !parsed.counts.bs) throw new Error('This does not look like a monthly finance report: ' + (parsed.problems[0] || 'nothing readable found'));
  const log = await c.query('INSERT INTO load_log(kind,file_name) VALUES ($1,$2) RETURNING id', ['finance', fileName]); const loadId = log.rows[0].id;
  const was = (await c.query('SELECT 1 FROM fin_reports WHERE period=$1', [parsed.period])).rowCount > 0;
  await c.query('DELETE FROM fin_pl WHERE period=$1', [parsed.period]); await c.query('DELETE FROM fin_bs WHERE period=$1', [parsed.period]); await c.query('DELETE FROM fin_reports WHERE period=$1', [parsed.period]);
  await c.query('INSERT INTO fin_reports(period,file_name,commentary,assets,liab_equity,own_cash_flow,load_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [parsed.period, fileName, parsed.commentary, parsed.assets, parsed.liab_equity, parsed.own_cash_flow ? JSON.stringify(parsed.own_cash_flow) : null, loadId]);
  for (const r of parsed.pl) await c.query('INSERT INTO fin_pl(period,kind,seq,grp,section,line,actual,budget,ly) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [parsed.period, r.kind, r.seq, r.grp, r.section, r.line, r.actual, r.budget, r.ly]);
  for (const r of parsed.bs) await c.query('INSERT INTO fin_bs(period,seq,grp,section,line,amount,prior,ly) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [parsed.period, r.seq, r.grp, r.section, r.line, r.amount, r.prior, r.ly]);
  const n = parsed.pl.length + parsed.bs.length;
  await c.query('UPDATE load_log SET rows_inserted=$2, note=$3 WHERE id=$1', [loadId, n, `Finance report ${parsed.period.slice(0, 7)}: ${parsed.counts.month} month lines, ${parsed.counts.ytd} YTD lines, ${parsed.counts.bs} balance sheet lines${was ? ' (replaced the earlier load of this month)' : ''}`]);
  return { loadId, applied: n, period: parsed.period, replaced: was, note: `Finance report for ${parsed.period.slice(0, 7)} loaded.` };
}

// ---- cash flow for one month, derived from that report's two balance sheet columns ----
function classify(r) {
  const L = r.line, g = r.grp || '', s = r.section || '';
  if (/^Total /.test(L) || L === 'Rounding') return null;
  switch (g) {
    case 'Cash & Equivalents': return null;
    case 'Accounts Receivable': return { sec: 'op', label: 'Receivables' };
    case 'Inventory': return { sec: 'op', label: 'Stock' };
    case 'Other Current Assets':
      if (/^Prepayments/i.test(L)) return { sec: 'op', label: 'Prepayments' };
      if (/^Accrued Income/i.test(L)) return { sec: 'op', label: 'Accrued income' };
      if (/Bank Guarantee/i.test(L)) return { sec: 'op', label: 'Bank guarantees lodged' };
      return { sec: 'growth', label: 'Loans, advances and projects (sites, build-and-sell, related entities)' };
    case 'Fixed Assets': return /Accumulated|Amortis|Depreciation/i.test(L) ? { sec: 'noncash', label: 'Depreciation and amortisation' } : { sec: 'capex', label: 'Equipment, software and fit-out' };
    case 'Intangible Assets': return /Amortis|Less /i.test(L) ? { sec: 'noncash', label: 'Depreciation and amortisation' } : { sec: 'capex', label: 'Intangibles' };
    case 'Investments or Other Non-Current Assets':
      if (/Amortis/i.test(L)) return { sec: 'noncash', label: 'Depreciation and amortisation' };
      if (/Trademark|Franchise System/i.test(L)) return { sec: 'capex', label: 'Trademarks and franchise system' };
      return { sec: 'growth', label: 'Acquisitions and investments' };
    case 'Accounts Payable': return { sec: 'op', label: 'Trade and other creditors' };
    case 'Tax Liability': return { sec: 'op', label: 'Tax, GST and PAYG' };
    case 'Other Current Liabilities': return { sec: 'op', label: 'Accruals, super, bonuses and unearned income' };
    case 'Long Term Debt': return { sec: 'fin', label: 'Long-term debt' };
    case 'Other Non-Current Liabilities':
      if (/Growth Facility/i.test(L)) return { sec: 'fin', label: 'Franchisee growth facilities' };
      if (/Shareholders? Loan/i.test(s)) return { sec: 'fin', label: 'Shareholder loans' };
      if (/Bank Loan/i.test(s)) return { sec: 'fin', label: 'Bank loan (CBA)' };
      if (/Employee Entitlements/i.test(s)) return { sec: 'op', label: 'Employee entitlements' };
      if (/Deposit|Gift Card/i.test(L)) return { sec: 'op', label: 'Franchisee security and site deposits' };
      return { sec: 'op', label: 'Other non-current liabilities' };
    default: return null;   // equity handled separately
  }
}
const ORDER = ['op', 'noncash', 'capex', 'growth', 'fin'];
const GROUP_TOTAL = { 'Fixed Assets': 'Total Fixed Assets', 'Accounts Payable': 'Total Accounts Payable', 'Tax Liability': 'Total Tax Liability', 'Other Current Liabilities': 'Total Other Current Liabilities', 'Other Non-Current Liabilities': 'Total Other Non-Current Liabilities' };

async function cashFlow(q, month) {
  const per = (await q(`SELECT period::text p FROM fin_reports WHERE to_char(period,'YYYY-MM')=$1`, [month])).rows[0];
  if (!per) return { error: `No finance report is held for ${month}.` };
  const bs = (await q(`SELECT seq, grp, section, line, amount::float8 amount, prior::float8 prior FROM fin_bs WHERE period=$1 ORDER BY seq`, [per.p])).rows;
  const pl = (await q(`SELECT line, grp, actual::float8 a FROM fin_pl WHERE period=$1 AND kind='month'`, [per.p])).rows;
  const tot = n => bs.find(r => r.line === n);
  const cashRow = tot('Total Cash & Equivalents'); if (!cashRow) return { error: 'The balance sheet for that month has no cash total.' };
  const ni = (pl.find(r => r.line === 'Net Income') || {}).a; if (ni == null) return { error: 'The profit and loss for that month has no net income line.' };
  const dividend = (pl.find(r => r.line === 'Dividend' && r.grp === 'Dividends') || pl.find(r => r.line === 'Dividend') || {}).a || 0;
  const buckets = {}; ORDER.forEach(k => { buckets[k] = {}; });
  const ASSET = ['Other Current Assets', 'Accounts Receivable', 'Inventory', 'Fixed Assets', 'Intangible Assets', 'Investments or Other Non-Current Assets'];
  const lineSum = {}, firstB = {};
  for (const r of bs) {
    const c = classify(r); if (!c) continue; const d = r.amount - r.prior; if (!d) continue;
    const cash = ASSET.includes(r.grp) ? -d : d;
    const b = buckets[c.sec][c.label] || (buckets[c.sec][c.label] = { label: c.label, amount: 0, detail: [] });
    b.amount += cash; b.detail.push({ line: r.line, amount: Math.round(cash) });
    lineSum[r.grp] = (lineSum[r.grp] || 0) + d; if (!firstB[r.grp] || c.sec === 'capex') firstB[r.grp] = b;
  }
  // the report's group totals for fixed assets and liabilities can differ from the sum of their lines by a dollar or two of rounding; follow the totals
  for (const [g, tn] of Object.entries(GROUP_TOTAL)) {
    const t = tot(tn); if (!t || !firstB[g]) continue; const diff = (t.amount - t.prior) - lineSum[g];
    if (diff && Math.abs(diff) <= 5) firstB[g].amount += ASSET.includes(g) ? -diff : diff;
  }
  const sec = k => Object.values(buckets[k]).filter(b => Math.round(b.amount) !== 0).map(b => ({ label: b.label, amount: Math.round(b.amount), detail: b.detail.length > 1 || b.detail[0].line !== b.label ? b.detail.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, 8) : undefined }));
  const sum = a => a.reduce((s, x) => s + x.amount, 0);
  const op = sec('op'), nc = sec('noncash'), capex = sec('capex'), growth = sec('growth'), fin = sec('fin');
  const eq = tot('Total Equity'); const dEq = eq ? eq.amount - eq.prior : null; const otherEq = dEq == null ? 0 : Math.round(dEq - (ni - dividend));
  const operating = Math.round(ni + sum(op) + sum(nc)); const fcf = operating + sum(capex);
  const afterGrowth = fcf + sum(growth);
  const financing = sum(fin) + (otherEq ? otherEq : 0);
  const derived = afterGrowth + financing - dividend;
  const actual = Math.round(cashRow.amount - cashRow.prior);
  const imbalance = (tot('Total Assets') && tot('Total Liabilities & Equity')) ? Math.round(tot('Total Assets').amount - tot('Total Liabilities & Equity').amount) : null;
  const priorImb = (tot('Total Assets') && tot('Total Liabilities & Equity')) ? Math.round(tot('Total Assets').prior - tot('Total Liabilities & Equity').prior) : null;
  const own = (await q(`SELECT own_cash_flow FROM fin_reports WHERE period=$1`, [per.p])).rows[0]?.own_cash_flow || null;
  const cba = bs.find(r => r.line === 'CBA Loan Facility');
  const netDebt = cba ? { cba_loan: Math.round(cba.amount), cash: Math.round(cashRow.amount), net_bank_debt: Math.round(cba.amount - cashRow.amount), prior_net_bank_debt: Math.round(cba.prior - cashRow.prior) } : null;
  return {
    month, basis: 'Derived (estimated): the finance report has no cash flow statement. Built from the movement between the two balance sheets in that month\'s report, plus that month\'s net income and dividend. Outflows are negative; AUD.',
    opening_cash: Math.round(cashRow.prior), closing_cash: Math.round(cashRow.amount),
    operating: { net_income: Math.round(ni), non_cash: nc, working_capital_and_other: op, operating_cash_flow: operating },
    capital_spending: capex, free_cash_flow_before_dividend: Math.round(fcf), free_cash_flow_note: 'Free cash flow = operating cash flow less capital spending (equipment, software, trademarks). Before growth investment, debt repayments and the dividend.',
    growth_investment: growth, cash_flow_after_growth_investment: Math.round(afterGrowth),
    financing: [...fin, ...(otherEq ? [{ label: 'Other equity movements', amount: otherEq }] : [])], dividend: -Math.round(dividend),
    derived_net_movement: Math.round(derived), balance_sheet_out_of_balance_adjustment: actual - Math.round(derived), actual_change_in_cash: actual,
    checks: { assets_minus_liabilities_and_equity_this_month: imbalance, same_gap_in_prior_month_column: priorImb, note: 'A non-zero gap means the report\'s own balance sheet does not balance. The adjustment above equals this month\'s gap less the prior month\'s gap (give or take a dollar or two of rounding); the finance team\'s own cash flow page calls it the change in the unbalanced balance sheet.' },
    net_bank_debt: netDebt,
    ...(own ? { report_own_cash_flow: { ...own, note: 'The finance team\'s own cash flow page, printed in some reports (Nov 2023 so far). Its definitions differ (advances to other current assets sit in operating; interest after tax), so its operating and free cash flow differ from the figures above, but its net cash flow is the actual change in cash.' } } : {}),
  };
}

module.exports = { extractLines, parseReport, analyse, commit, cashFlow, headline, classify };
