# Builds data/budget_fy27.json from figures read off the FY27 budget board paper (18 June 2026).
import json
L=[]
def add(section,line,period,value,brand='',unit='AUD'):
    L.append(dict(section=section,brand=brand,line=line,period=period,value=value,unit=unit))
def pair(section,line,a,b,brand='',unit='AUD'):
    add(section,line,'FY26A',a,brand,unit); add(section,line,'FY27B',b,brand,unit)
M=['2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03','2027-04','2027-05','2027-06']
def months(section,line,vals):
    for m,v in zip(M,vals): add(section,line,m,v)
# network sales
pair('network_sales','Existing estate',186203176,207247905)
add('network_sales','Greenfield (25 new stores)','FY27B',15668571)
add('network_sales','Total network sales','FY26A',186203176); add('network_sales','Total network sales','FY27B',222916476)
add('network_sales','Matured greenfield run-rate (FY28)','FY28F',33400000)
add('network_sales','Same-store (like-for-like) sales','FY26A',171900000); add('network_sales','Same-store (like-for-like) sales','FY27B',178200000)
for b,a,c in [('Asian division',144.5,162.4),('Noodle Box',139.2,156.8),('Wok in a Box OTR',4.9,5.6),('Burgers division',34.1,35.8),('Pattysmiths',28.3,29.5),('Huxtaburger',5.8,6.3),('Innovation division',7.3,9.0),('Acai Brothers',4.4,4.5),('South Seoul',2.9,4.5)]:
    pair('estate_sales_by_brand','Existing estate net sales',a*1e6,c*1e6,b)
for b,a,c in [('Noodle Box',116,128),('Pattysmiths',24,24),('Huxtaburger',5,8),('South Seoul',4,10),('Acai Brothers',8,10),('Wok in a Box OTR',9,11),('Total network',166,191)]:
    pair('store_count','Stores at year end',a,c,b,'stores')
months('openings','New store openings',[1,3,1,3,1,2,0,1,3,2,4,4])
for t,n,s,r in [('BAU new franchisee',12,5.17,0.90),('Multi-unit franchisee',7,4.77,0.67),('Strategic geographic',4,4.56,0.53),('Strategic format',2,1.17,0.18)]:
    add('greenfield','Openings','FY27B',n,t,'stores'); add('greenfield','Sales','FY27B',s*1e6,t); add('greenfield','C8 revenue','FY27B',r*1e6,t)
# revenue
for l,a,b in [('Franchise partner fees',1292326,1208000),('Royalties',12035762,14927186),('Rebates',2281146,2897914),('Recharge income',195000,200856),('Other income',1341,0),('Total revenue',15805576,19233956)]: pair('revenue',l,a,b)
# expenses
for l,a,b in [('Employment costs',5783108,6632790),('Occupancy costs',206721,255750),('Operating costs',264571,264000),('Entertainment & staff awards',56366,71096),('Franchise support',228574,180000),('IT costs',184766,289038),('Marketing',24080,30000),('Network development',218972,220000),('Product development',85290,87395),('Professional fees',204682,254548),('Staff & restaurant training',70334,99000),('Travel costs',354939,412572),('Financing costs',187917,180000),('Company restaurant P&L (COUS)',97453,0),('Total other operational costs',2184664,2343399),('Total expenses',7967772,8976189)]: pair('expense',l,a,b)
# profit
for l,a,b in [('Operating profit before investment projects',7837804,10257767),('Burger conversion costs (PS to Hux)',0,-75000),('Equipment D&A (franchise partner incentives)',-25458,-70000),('Brand equity costs',-214250,-77000),('Executive LTI',-175000,-185000),('CEO & CFO STI',-225000,-225000),('Expansion projects & other investments',-135800,54000),('Total investment projects',-775508,-578000),('EBITDA before shareholder costs',7062296,9679767),('Shareholder costs',-658696,-658696),('R&D tax bill',-30200,-30200),('EBIT',6373399,8990871),('Tax expense (25%)',-1593350,-2247718),('Net profit after tax',4780049,6743153),('Dividends',-3720000,-3720000),('Retained earnings',1060049,3023153)]: pair('profit',l,a,b)
# marketing concepts (separate entity)
for l,a,b in [('Revenue',4992726,6080324),('Expenses (cost of sales)',3585590,4259537),('Agency',398224,0),('Media',2625657,3628657),('Delivery platforms',1376592,1776592),('Digital advertising',1249066,1852066),('Contractors',27588,30347),('Licensing',52221,72443),('Marketing',32869,36156),('Photography',72050,90255),('Point of sale',257396,293136),('Tech & software licensing',7768,8545),('Website',111818,100000),('Gross profit',1407136,1820787),('Operating expenses',1513645,1807881),('Employee costs',1103832,1300000),('CX',182604,144705),('Accounting & audit fees',25692,30000),('Miscellaneous',2183,2402),('Loyalty advertising',19333,29266),('C8 management fee',180000,195000),('Net profit',-106509,12906)]: pair('marketing_pl',l,a,b)
# monthly cash flow
months('cashflow','Royalties received',[1300511,1369772,1281465,1323679,1309771,1362541,1329042,1210467,1371591,1379678,1493317,1470720])
months('cashflow','Franchise fees received',[67650,111650,67650,172150,67650,111650,23650,67650,155650,128150,199650,155650])
months('cashflow','Rebates received',[253049,266303,249014,257151,254562,264624,257997,234817,266034,267944,289622,285029])
months('cashflow','Total operational inflows (inc GST)',[1644571,2079137,1621541,1776392,1655395,1762226,1634100,1536345,1816687,1799184,2006000,1929811])
months('cashflow','Total employment (cash basis)',[-539557,-709998,-577269,-588218,-545767,-528973,-494829,-556314,-567570,-564251,-541830,-582289])
months('cashflow','Total operational outflows (inc GST)',[-754740,-899973,-772135,-797068,-725101,-865827,-682743,-782353,-757064,-756064,-760131,-803407])
months('cashflow','Net operational cash flow (stream 1)',[889832,1179164,849405,979324,930294,896399,951358,753993,1059624,1043119,1245870,1126404])
months('cashflow','Capex (stream 2)',[-5000,-5000,-5000,-5000,-67500,-67500,-5000,-5000,-5000,-5000,-5000,-5000])
months('cashflow','STI & LTI cash (stream 3)',[-15417,-240417]+[-15417]*10)
months('cashflow','Investment project facility repayments (stream 4)',[-105186,-118228,-105369,-107786,-101819,-88890,-105640,-71640,-73066,-73066,-73066,-74375])
months('cashflow','Shareholder costs (stream 5)',[-409023]*12)
months('cashflow','Taxes: GST and corporate tax (stream 6)',[0,-574487,0,-755475,0,0,-730361,0,0,-1383142,0,0])
months('cashflow','Total streams 2-6 monthly movement',[-534626,-1347155,-534809,-1292701,-593759,-580830,-1265441,-501080,-502506,-1885648,-502506,-503815])
months('cashflow','Investment facility balance (closing)',[3504678,2953294,2877281,2830875,2736529,2703445,2643073,2620034,2567651,2640030,2576574,2547809])
months('cashflow','Facility headroom',[300419,851804,927818,974225,1068572,1101657,1162030,1185070,1237454,1165076,1228533,1257299][0:0] or [300455,300419,851804,927818,974225,1068572,1101657,1162030,1185070,1237454,1165076,1228533])
months('cashflow','Total access to cash',[840111,672085,1538066,1300703,1683644,2093561,1812561,2125847,2706005,1915859,2586845,3272891])
# employment
for l,a,b in [('Closing headcount (C8)',33,36),('Closing headcount (Marketing Concepts)',14,13)]: pair('headcount',l,a,b,'', 'FTE')
notes=[
('status','Approved FY27 budget (July 2026 to June 2027), as presented to the Board in June 2026.'),
('headline','Network sales $222.9m (+19.7%); C8 revenue $19.23m (+21.7%); operating profit before investment projects $10.26m (53.3% margin); EBITDA before shareholder costs $9.68m; NPAT $6.74m (35.1%); dividends held at $3.72m.'),
('network','Stores go from 166 to 191 (25 greenfield openings, 8 more than last year). Openings by month Jul to Jun: 1,3,1,3,1,2,0,1,3,2,4,4. Total employees 36 (33 now, 3 net new) excluding marketing.'),
('network','Like-for-like sales growth about +3.6% to +3.7% on 142 locations. The FY26 opening cohort (23 sites) gets a +145% full-year ramp effect. 11 franchise renewals and 8 transfers assumed.'),
('greenfield','Greenfield average weekly sales assumptions: BAU new franchisee $25k, multi-unit $27.5k, strategic $30k, Acai Brothers $15k, Wok in a Box OTR $20k. Evidence from FY26 openings (last 12 weeks): Noodle Box $26.2k, Pattysmiths $23.2k, South Seoul $14.4k, Acai $10.2k, WIAB OTR $13.8k. Acai and OTR run well below assumptions.'),
('greenfield','Greenfield mix: 12 BAU new franchisee, 7 multi-unit, 4 strategic geographic, 2 strategic format. FY27 greenfield sales $15.7m and C8 revenue $2.3m; matured (FY28) $33.4m and $3.7m.'),
('revenue','Franchisor take is 8.15% of sales (7% royalty plus 1.15% rebate). Franchise fee $40k per opening (25 x $40k = $1.0m). Royalties +24%, rebates +27%.'),
('costs','Employment costs $6.63m, 34.5% of revenue (36.6% last year), +15% in dollars. Pay rises 3.5% to 5% at team level, minimal for executives. Super 12%, payroll tax 4.85%, Workcover 1.6%. Store opening bonus $5k each (25 = $125k); 7 executive STIs at $10k.'),
('costs','Other operational costs $2.34m, 12.2% of revenue (13.8%). IT up 56% to $289k (security, Microsoft licensing, AI). Occupancy $256k (extra office space). No company restaurant P&L is forecast: NBX Ringwood is being sold and franchised; NBX Richmond is profitable but on the market.'),
('investment','Investment projects $578k: 5 Pattysmiths to Huxtaburger conversions at $15k each ($75k); equipment incentives depreciate 10% straight line, held 2 years then sold to the franchisee for $1; Brand Equity $77k; Executive LTI $185k (8 executives, 4 year); CEO and CFO STI $225k. Further conversions need Board sign-off and a budget increase.'),
('investment','Shareholder costs $658,696, R&D tax bill $30,200 and dividends $3.72m are held at FY26 levels. Tax at 25%. The R&D tax saving is uncertain pending changing rules.'),
('conversion','Pattysmiths to Huxtaburger: 22 Pattysmiths sites rebadge across FY27 and FY28 (Huxtaburger 5 to 27 sites); 2 (Darlinghurst, Waterford West) go to Noodle Box. Assumed uplift +15%, about $15k per conversion. 6 of the 29 burger stores converting in FY27 are not reflected in the sales budget.'),
('acai','Acai Brothers exit scenario: assumes sale from October FY27; C8 forgoes 9 months of royalties and rebates from the 4 existing stores; about $3m to $3.5m of network sales leave; the 2 FY27 Acai greenfields move to Noodle Box. Ex-Acai network sales $220.0m (+18.2%), revenue $19.0m, operating profit about $9.77m (52.2%), EBITDA $9.19m, EBIT $8.51m, NPAT about $6.32m (33.7%).'),
('acai','Acai exit background: 2025 Franchising Code sections 43 and 44 (effective 1 Nov 2025) require compensation if a brand is closed or exited. Royalty and marketing-fund contributions at risk to franchise agreement expiry (Sep 2033) about $2.11m. Options: sell to another franchisor, run agreements to expiry, or negotiate termination and rebadge. Written legal opinion was pending.'),
('marketing','Marketing Concepts (separate entity) revenue $6.08m (+21.8%), net profit +$12.9k (0.2%) against a loss of $106.5k last year. The agency ($398k) is brought in-house and the money goes into media (+38% to $3.63m). Delivery platforms $1.78m, digital advertising $1.85m, employee costs $1.3m, C8 management fee $195k.'),
('cash','Operating cash flow positive every month; net operational cash flow about $0.75m to $1.25m a month. Quarterly GST (BAS) about $0.39m to $0.44m; corporate tax instalments $320k per quarter plus a $660k FY26 balancing payment in March. Dividends $310k a month; shareholder loan repayments $40k a month.'),
('cash','Investment facility: $3.5m opening, $2.55m closing; total facility limit $3.805m so headroom grows from $0.30m to $1.26m. Repayments secured: DoorDash sign-on $336k (July) and the Asahi/Coke contract $1.65m (June). Overdraft $150k. Total access to cash ranges $0.67m (Aug) to $3.27m (Jun).'),
('headcount','C8 headcount 33 now to 36 in FY27 (40 forecast FY28): Ops & Training 14 to 17, Finance 4 to 5 (Financial Controller), Network Development 4, Construction 2, Supply Chain 3, Legal 2, CEO and GMs 4 to 3. Marketing Concepts 14 to 13.'),
('basis','Network sales here are the budget basis (existing estate plus greenfield). They are not the same basis as the weekly Sales Report figures, so any budget versus actual comparison is approximate.'),
]
json.dump(dict(budget=True,fy='FY27',version='Approved budget 2026',lines=L,notes=[dict(topic=t,note=n) for t,n in notes]),open('data/budget_fy27.json','w'),indent=0)
print(len(L),'lines',len(notes),'notes')
