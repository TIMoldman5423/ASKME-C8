#!/usr/bin/env python3
"""Turn the Network Tracker workbook into one JSON file for the admin upload (type: pipeline).
Usage: python3 make-pipeline-json.py "NEW Network Tracker - 2025.xlsx" data/network_pipeline.json
Tabs read: Greenfield, COUS, Transfers, Closures, Opened, FA Renewals, Lease Renewals, Activity, C8 Lease Liability.
Left out on purpose: Schedule, Workbook Summary, MRO, International, Ampol, Data, Lookups, Tables for BP."""
import sys, json, re, datetime, warnings
warnings.filterwarnings('ignore')
import openpyxl
from openpyxl.utils import get_column_letter as L

SRC, OUT = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(SRC, data_only=True)
TABS = [('Greenfield', 'greenfield'), ('COUS', 'cous'), ('Opened', 'opened'), ('Transfers', 'transfer'),
        ('Closures', 'closure'), ('FA Renewals ', 'fa_renewal'), ('Lease Renewals', 'lease_renewal')]
SUBBRANDS = {'dd dumplings', 'supreme leader'}

def clean(v):
    if v is None: return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        d = v.date() if isinstance(v, datetime.datetime) else v
        return d.isoformat() if d.year >= 2000 else None
    if isinstance(v, float) and v == int(v): v = int(v)
    s = str(v).strip()
    if not s or s.startswith('#') or s in ('0/01/1900',): return None
    return s
def iso(v):
    v = clean(v)
    return v if v and re.match(r'^\d{4}-\d{2}-\d{2}$', v) else None
def num(v):
    v = clean(v)
    if v is None: return None
    try: return float(str(v).replace('$', '').replace(',', ''))
    except ValueError: return None

BASE = {  # header text (lower) -> field
    'restaurant': 'restaurant', 'development status': 'status', 'franchise at risk': 'at_risk', 'brand': 'brand', 'state': 'state', 'gsm': 'gsm',
    'franchise partner name': 'partner', 'franchise partners name': 'partner',
    'target opening date w/c': 'target_date', 'target transfer date': 'target_date', 'target closure date': 'target_date',
    'actual opening date w/c': 'actual_date', 'delayed days': 'delayed_days',
    'fa expiry date': 'fa_expiry', 'lease expiry date': 'lease_expiry',
}
LATE = {'estimated weekly sales': 'est_weekly_sales', 'budgeted opening date': 'budgeted_date', 'delay reason': 'delay_reason', 'days to first dollar lost rev': 'lost_revenue'}
SKIP_STEP = {'days until opening', 'days until transfer', 'days until closure'}

projects = []
for tab, kind in TABS:
    ws = wb[tab]
    hr = next(r for r in range(1, 12) if str(ws.cell(r, 1).value or '').strip().lower() == 'restaurant')
    sr = hr + 1
    ncol = ws.max_column
    heads = {c: (clean(ws.cell(hr, c).value) or '') for c in range(1, ncol + 1)}
    basecols, stepcols = {}, []
    phase = ''
    for c in range(1, ncol + 1):
        h = heads[c]; hl = re.sub(r'\s+', ' ', h.lower())
        if hl in BASE: basecols[BASE[hl]] = c; continue
        if re.match(r'phase \d|marketing and launch|finance', hl): phase = re.sub(r'\s+', ' ', h).strip()
        s = clean(ws.cell(sr, c).value); s2 = clean(ws.cell(sr + 1, c).value)
        if hl.startswith('days to first dollar') and not s: s = h  # header sits in the top row for the two Finance columns
        if not s and hl in ('grand opening date',): s = h
        if not s: continue
        name = re.sub(r'\s+', ' ', s).strip()
        if name.lower() in SKIP_STEP: continue
        if s2 in ('Primary', 'Virtual'): name += f' ({s2.lower()})'
        stepcols.append((c, phase or 'Other', name))
    # locate the late finance columns by their step names
    for c, ph, name in stepcols:
        nl = name.lower()
        for k, f in LATE.items():
            if nl.startswith(k) or (k == 'days to first dollar lost rev' and 'lost rev' in nl): basecols[f] = c
    blank = 0
    for r in range(sr + 1, ws.max_row + 1):
        rest = clean(ws.cell(r, basecols['restaurant']).value)
        brand = clean(ws.cell(r, basecols.get('brand', 1)).value) if 'brand' in basecols else None
        if not rest or not brand or brand.lower() in SUBBRANDS or rest.lower().startswith('denotes'): continue
        p = {'tab': tab.strip(), 'kind': kind, 'restaurant': re.sub(r'\s+', ' ', rest).strip(), 'brand': brand, 'source_row': r}
        for f, c in basecols.items():
            if f in ('restaurant', 'brand'): continue
            v = ws.cell(r, c).value
            if f in ('target_date', 'actual_date', 'fa_expiry', 'lease_expiry', 'budgeted_date'): p[f] = iso(v)
            elif f in ('delayed_days',):
                n = num(v); p[f] = int(n) if n is not None and abs(n) < 2000 else None
            elif f in ('est_weekly_sales', 'lost_revenue'): p[f] = num(v)
            else: p[f] = clean(v)
        steps = []
        for c, ph, name in stepcols:
            if c in basecols.values(): continue
            v = clean(ws.cell(r, c).value)
            if v is not None: steps.append({'phase': ph, 'step': name, 'value': v})
        p['steps'] = steps
        projects.append(p)

# drop empty continuation rows (same site on the same tab that has a fuller row)
full = {(p['tab'], p['restaurant'].lower(), p['brand']) for p in projects if p['steps']}
projects = [p for p in projects if p['steps'] or (p['tab'], p['restaurant'].lower(), p['brand']) not in full]
# Activity log
ws = wb['Activity 2025 (2)']; activity = []
for r in range(3, ws.max_row + 1):
    brand, rest, typ = clean(ws.cell(r, 1).value), clean(ws.cell(r, 2).value), clean(ws.cell(r, 4).value)
    if not rest or not typ or typ.lower() == 'type': continue
    inc = num(ws.cell(r, 8).value)
    activity.append({'brand': brand, 'restaurant': rest, 'state': clean(ws.cell(r, 3).value), 'type': typ, 'date': iso(ws.cell(r, 5).value),
                     'franchise_partner': clean(ws.cell(r, 7).value), 'incentive': inc if inc is not None else clean(ws.cell(r, 8).value),
                     'description': clean(ws.cell(r, 9).value), 'lead_source': clean(ws.cell(r, 10).value) or clean(ws.cell(r, 11).value)})
# C8 lease liability
ws = wb['C8 Lease Liablity ']; leases = []
for r in range(3, ws.max_row + 1):   # columns B..K
    site = clean(ws.cell(r, 2).value)
    if not site: continue
    g = lambda c: ws.cell(r, c).value
    leases.append({'site': site, 'term_years': num(g(3)), 'commencement': iso(g(4)), 'expiry': iso(g(5)),
                   'bank_guarantee': num(g(6)), 'landlord': clean(g(7)), 'tenant': clean(g(8)),
                   'guarantor': clean(g(9)), 'occupancy_licence': clean(g(10)), 'further_term': clean(g(11))})
# The sheet's own "Date:" cell is a live TODAY() formula, so it says nothing about how fresh the entries are.
# "as_of" is therefore the latest dated entry actually recorded (opening/transfer/closure dates, step dates, activity dates).
cands = [p.get('actual_date') for p in projects] + [a['date'] for a in activity] + [x['value'] for p in projects for x in p['steps'] if re.match(r'^\d{4}-\d{2}-\d{2}$', x['value'])]
as_of = max([c for c in cands if c and c <= datetime.date.today().isoformat()] or [None])
out = {'pipeline': True, 'source': 'NEW Network Tracker - 2025.xlsx', 'as_of': as_of, 'projects': projects, 'activity': activity, 'leases': leases}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=0)
from collections import Counter
print('as_of', as_of, '| projects', Counter(p['kind'] for p in projects), '| steps', sum(len(p['steps']) for p in projects), '| activity', len(activity), '| leases', len(leases))
