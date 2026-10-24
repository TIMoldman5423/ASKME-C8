# One-off: turn the SharePoint Franchise Master export (CSV) into two Admin upload files:
#   store_details_from_master.csv    (state, BDM, trading company, address)
#   store_agreements_from_master.csv (ABN, royalty, franchise agreement and lease dates/terms)
# Only Active rows for brands the app knows (NBX, PS, WIAB); franchisee names, phones and emails are left out.
# Usage: python3 franchise-master-to-uploads.py Franchise_Master.csv outdir
import csv, io, sys, os, re
src, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.StringIO(open(src, encoding='utf-8-sig').read()))); h = [x.strip() for x in rows[0]]
d = [dict(zip(h, r)) for r in rows[1:] if any(r)]
BR = {'NBX': 'Noodle Box', 'PS': 'Pattysmiths', 'WIAB': 'Wok In A Box - OTR'}
seen, keep, skipped = set(), [], {'not active': 0, 'other brand code': {}, 'duplicate': 0}
for x in d:
    b = BR.get(x['Brand'].strip().upper())
    if x['Active/Archive'].strip() != 'Active': skipped['not active'] += 1; continue
    if not b: k = x['Brand'].strip(); skipped['other brand code'][k] = skipped['other brand code'].get(k, 0) + 1; continue
    name = re.sub(r'\s+', ' ', x['Store']).strip()
    if b == 'Wok In A Box - OTR':   # the app holds only the OTR sites, named like OTR_Port Augusta
        if not name.upper().startswith('OTR'): skipped['other brand code']['WIAB (not OTR)'] = skipped['other brand code'].get('WIAB (not OTR)', 0) + 1; continue
        name = {'OTR - Croydon (Ridleyton)': 'OTR_Ridleyton', 'OTR -Tailem Bend (Motorsport Park)': 'OTR_Motorsport Park'}.get(name, re.sub(r'^OTR\s*-\s*', 'OTR_', name))
    if (b, name.lower()) in seen: skipped['duplicate'] += 1; continue
    seen.add((b, name.lower())); keep.append((b, name, x))
def rate(v):
    m = re.search(r'[\d.]+', v or ''); return '' if not m else str(round(float(m.group()) / 100, 4))
def abn(v): return re.sub(r'\s', '', v or '')
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, 'store_details_from_master.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f); w.writerow(['site_name', 'brand', 'state', 'bdm', 'trading_company', 'address'])
    for b, n, x in keep: w.writerow([n, b, x['State'].strip().upper(), x['BDM'].strip(), x['Entity Name'].strip(), x['Site Address'].strip()])
with open(os.path.join(out, 'store_agreements_from_master.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f); w.writerow(['site_name', 'brand', 'abn', 'royalty_rate', 'fa_start', 'fa_end', 'fa_options', 'lease_start', 'lease_end', 'lease_options', 'landlord', 'site_size', 'annual_rent'])
    for b, n, x in keep: w.writerow([n, b, abn(x['ABN/ACN']), rate(x['Royalties %']), x['FA Start'], x['FA End Date'], x['FA Option'], x['Lease Start'], x['Lease End Date'], x['Lease Options'], x['Lease Landlord'], x['Site Size'], x['Annual Rent']])
print(len(keep), 'stores kept;', skipped)
