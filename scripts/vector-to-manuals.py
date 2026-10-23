# One-off: turn the IVR app's vector-store.json into manuals.json for Admin -> Load manuals file.
# Usage: python3 vector-to-manuals.py vector-store.json manuals.json
import json, sys, collections
d = json.load(open(sys.argv[1])); by = collections.OrderedDict()
for x in d:
    s, p = x.get('source'), x.get('page')
    if not s or not p or 'sheet' in x: continue          # old pageless pieces and Excel sheets are left out
    by.setdefault(s, collections.OrderedDict()).setdefault(str(p), []).append(x['text'])
out = {'manuals': [{'title': s, 'pages': {p: '\n'.join(t) for p, t in pg.items()}} for s, pg in by.items()]}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
print({m['title']: len(m['pages']) for m in out['manuals']})
