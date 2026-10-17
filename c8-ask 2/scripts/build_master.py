"""Builds data/stores_master.csv (one row per sales store) by matching the sales store list
to SharePoint site details and the best available opening date. Prints unmatched for review."""
import csv, re, collections, sys, os
D=os.path.join(os.path.dirname(__file__),"..","data")
rd=lambda f:list(csv.DictReader(open(os.path.join(D,f),encoding="utf-8")))
sales=[r for r in csv.DictReader(open(os.path.join(D,"c8_store_weekly_sales_13wk_plus_lw_orders_atv.csv"),encoding="utf-8")) if not r["division"].startswith("TOTAL")]
sp=rd("c8_sites_sharepoint_business_fields.csv")
od=rd("c8_opening_dates_found.csv")

BRAND_SALES_TO_CANON={"Wok In A Box - OTR":"Wok In A Box"}
def key(s):
    s=s.lower()
    s=re.sub(r"\(.*?\)","",s)
    s=re.sub(r"^otr[_ \-]+","otr",s)
    s=re.sub(r"\b(nbx|ab|ps|hux|ss|sl)\b","",s)
    return re.sub(r"[^a-z]","",s)

# manual aliases: sales store name -> SharePoint site name (checked by eye)
ALIAS={
 "OTR_Motorsport Park":"OTR Tailem Bend (Motorsport Park)","OTR_Ridleyton":"OTR Croydon (Ridleyton)",
 "Prospect":"Prospect East (North Park)","Burswood (Crown Perth)":"Burswood","Duncraig (Glengarry)":"Duncraig",
 "Campbellfield Go":"Campbellfield Go","Toowoomba NBX":"Toowomba Westridge","Toowoomba HUX":None,"Toowoomba AB":None,
 "Unley":"Unley","Caroline Springs NBX":"Caroline Springs","Waterford West NBX":"Waterford West",
 "Southern River":"Southern River","Murrumba Downs SS":None,"Strathpine NBX":"Strathpine","Strathpine PS":"Strathpine",
 "Waterford West PS":"Waterford West","Palm Beach NBX":"Palm Beach","Palm Beach PS":"Palm Beach","Miami NBX":"Miami",
 "Southport NBX":"Southport","Kenmore NBX":"Kenmore","Hawthorn NBX":"Hawthorn","Port Melbourne NBX":"Port Melbourne",
 "Yamanto PS":"Yamanto","University WA":None,"Murdoch":"Murdoch University","Mount Gravatt":None,
}
spby=collections.defaultdict(list)
for r in sp:
    b=r["brand"]
    for bb in re.split(r"\s*&\s*",b): spby[(bb.strip(),key(r["site_name"]))].append(r)
    spby[("*",key(r["site_name"]))].append(r)

def sp_match(brand,store):
    canon=BRAND_SALES_TO_CANON.get(brand,brand)
    names=[ALIAS[store]] if store in ALIAS and ALIAS[store] else [store]
    if store in ALIAS and ALIAS[store] is None: return None,"alias-none"
    for n in names:
        k=key(n)
        hit=spby.get((canon,k))
        if hit: return hit[0],"brand+name"
        hit=spby.get(("*",k))
        if hit and canon in ("Noodle Box",): return hit[0],"name-only"
    return None,"none"

# opening dates ------------------------------------------------------------
BR={"NBX":"Noodle Box","PS":"Pattysmiths","WIAB":"Wok In A Box","Southern Seoul":"South Seoul","SS":"South Seoul","Noodle Box":"Noodle Box","Pattysmiths":"Pattysmiths","Acai Bros":"Acai Bros","Huxtaburger":"Huxtaburger","South Seoul":"South Seoul"}
def canon_brand(b):
    b=b.strip()
    if b in BR: return BR[b]
    t=re.split(r"[^A-Za-z]+",b)[0]      # first brand code only, e.g. "NBX & SPL" -> NBX
    return BR.get(t)
cands=collections.defaultdict(list)  # (brand,key)->[(priority,date,source,type)]
for r in od:
    t=r["date_type"]; src=r["source"]
    if src.startswith("Finance"): pr,b=1,r["brand"]
    elif "Openings&Closures" in src: pr,b=2,r["brand"]
    elif t=="Opening date (listed brand)": pr=4; b=r["brand"]
    elif t.startswith("Franchise agreement start"): pr=5; b=r["brand"]
    else: continue
    cb=canon_brand(b)
    if not cb: continue
    cands[(cb,key(r["site_as_listed"]))].append((pr,r["date"],src,t))
# network tracker greenfield actuals (priority 3)
GF=[("Acai Bros","Toowoomba","2026-03-23"),("Wok In A Box","Strathalbyn","2026-03-23"),("Noodle Box","Clyde North","2026-03-30"),("Noodle Box","Atwell","2026-04-06"),("South Seoul","Ripley","2026-04-13"),("Noodle Box","Brassall","2026-04-27"),("Noodle Box","Northcote","2026-04-27"),("Acai Bros","Adelaide Hospital","2026-05-04"),("Noodle Box","Lathlain","2026-05-04"),("Noodle Box","South Ripley","2026-05-07"),("Noodle Box","Bathurst","2026-06-01"),("Noodle Box","Richmond","2026-03-30")]
for b,s,d in GF: cands[(b,key(s))].append((3,d,"Network Tracker: Greenfield tab (actual opening week)","Opening week"))

OPEN_ALIAS={"University WA":"UWA","Murrumba Downs SS":"Murrumba Downs","Campbellfield Go":"Campbellfield Go","Mount Gravatt":"Mount Gravatt","OTR_Port Augusta":"OTR Port Augusta","Burswood (Crown Perth)":"Burswood","Mambourin":"Mambourin","Toowoomba NBX":"Toowoomba Westridge","Waterford West NBX":"Waterford","Unley":"Malvern (Unley)","OTR_Wakefield Road":"OTR - Port Wakefield Road","OTR_Motorsport Park":"OTR -Tailem Bend (Motorsport Park)","OTR_Ridleyton":"OTR - Croydon (Ridleyton)","Banksia Grove":"Banksia Grove","Royal Adelaide Hospital":"Adelaide Hospital","Chirnside Park AB":"Chirnside Park","Ringwood North":"North Ringwood","Kellyville":"Kellyville Grove"}
def open_for(brand,store):
    cb=BRAND_SALES_TO_CANON.get(brand,brand)
    names={store,OPEN_ALIAS.get(store,store)}
    best=[]
    for n in names:
        for c in cands.get((cb,key(n)),[]): best.append(c)
        if cb=="Wok In A Box" or True:
            pass
    if not best: return "", "", ""
    best.sort(key=lambda c:(c[0], c[1]))
    pr=best[0][0]
    same=[c for c in best if c[0]==pr]
    if pr==5: same.sort(key=lambda c:c[1])    # earliest FA start
    c=same[0]
    conf={1:"high",2:"high",3:"high",4:"medium",5:"low (franchise agreement start, not store opening)"}[pr]
    return c[1], c[2]+" | "+c[3], conf

out=[]; unm=[]; noopen=[]
for r in sales:
    b=r["brand"]; s=r["store"]
    m,how=sp_match(b,s)
    od_,src,conf=open_for(b,s)
    if not m: unm.append((b,s))
    if not od_: noopen.append((b,s))
    out.append({"store":s,"brand":b,"division":r["division"],
      "state":(m or {}).get("state",""),"address":(m or {}).get("address",""),"phone":(m or {}).get("phone",""),
      "trading_company":(m or {}).get("trading_company",""),"bdm":(m or {}).get("bdm",""),
      "sharepoint_name":(m or {}).get("site_name",""),"match":how,
      "opening_date":od_,"opening_date_source":src,"opening_date_confidence":conf})
with open(os.path.join(D,"stores_master.csv"),"w",newline="",encoding="utf-8") as f:
    w=csv.DictWriter(f,fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print("stores",len(out),"| sharepoint matched",len(out)-len(unm),"| with opening date",len(out)-len(noopen))
print("UNMATCHED SP:",unm)
print("NO OPENING DATE:",noopen)
print(collections.Counter(o["opening_date_confidence"] for o in out))
