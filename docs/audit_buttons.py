import re, glob, os, json

BUILTINS = set(['window','document','location','event','e','this','alert','confirm','prompt','history','console',
'localStorage','sessionStorage','encodeURIComponent','decodeURIComponent','setTimeout','clearTimeout','String','Number',
'parseInt','parseFloat','JSON','Object','Array','Date','Math','fetch','Promise','requestAnimationFrame','scrollTo','open','print','Clerk','stop','void'])

def defined_in(js):
    names = set()
    for m in re.finditer(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', js): names.add(m.group(1))
    for m in re.finditer(r'(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b', js): names.add(m.group(1))
    for m in re.finditer(r'window\.([A-Za-z_$][\w$]*)\s*=', js): names.add(m.group(1))
    for m in re.finditer(r'\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)', js): names.add(m.group(1))
    return names

asset_defs = {}
for a in glob.glob('assets/*.js'):
    asset_defs['/' + a] = defined_in(open(a).read())

pages = sorted(glob.glob('*.html'))
existing = set(pages)
handler_issues, href_missing, hash_dead = [], [], []

for f in pages:
    s = open(f).read()
    inline = '\n'.join(re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>', s, re.DOTALL))
    defs = defined_in(inline) | BUILTINS
    for m in re.finditer(r'<script[^>]*src="([^"]+)"', s):
        src = m.group(1).split('?')[0]
        if src in asset_defs: defs |= asset_defs[src]
    # onclick/onsubmit/onchange handlers → every identifier directly invoked
    for attr, code in re.findall(r'\bon(click|submit|change|keydown|input)="([^"]*)"', s):
        for call in re.finditer(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(', code):
            fn = call.group(1)
            if fn not in defs:
                handler_issues.append((f, fn, code[:70]))
    # hrefs → internal targets must exist
    for href in re.findall(r'href="([^"]+)"', s):
        if href.startswith(('http','#','mailto:','tel:','javascript:','//','data:')): continue
        target = href.split('?')[0].split('#')[0].lstrip('/')
        if target and target.endswith('.html') and target not in existing:
            href_missing.append((f, href))

# dedupe
hi = sorted(set(handler_issues)); hm = sorted(set(href_missing))
print("=== UNDEFINED ONCLICK HANDLERS (page · fn · snippet) ===")
for f, fn, code in hi: print(f"  {f:34s} {fn:22s} {code}")
print(f"  TOTAL: {len(hi)}")
print()
print("=== INTERNAL LINKS TO NONEXISTENT PAGES (page · href) ===")
for f, h in hm: print(f"  {f:34s} {h}")
print(f"  TOTAL: {len(hm)}")
