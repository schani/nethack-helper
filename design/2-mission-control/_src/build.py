#!/usr/bin/env python3
"""Inline real fixture data into the mockup: python3 -I build.py <fixtures_dir>"""
import json, sys, pathlib
here = pathlib.Path(__file__).resolve().parent
fx = pathlib.Path(sys.argv[1])
names = ['deep-dlvl4', 'hungry-conditions', 'low-hp', 'menu-open',
         'fountain-quaff-prompt', 'shop', 'more-prompt']
out = {}
for n in names:
    d = json.loads((fx / f'{n}.json').read_text())
    s = d['state']
    levels = {}
    for k, l in s['levels'].items():
        levels[k] = {
            'info': {kk: l['info'][kk] for kk in ('dnum', 'dlevel', 'depth', 'dungeon', 'desc')},
            'seen': l.get('lastSeenTurn'),
            'cells': [[c['x'], c['y'], c['ch'], c['color'], c['desc']] for c in l['cells']],
        }
    out[n] = {
        'game': {k: s['game'][k] for k in ('name', 'role', 'race', 'gender', 'alignment')},
        'turn': s['turn'], 'hero': s['hero'], 'status': s['status'],
        'awaiting': s['awaiting'], 'cur': s['currentLevel'], 'levels': levels,
        'messages': s['messages'], 'inventory': s['inventory'], 'menu': s['menu'],
        'discoveries': s['discoveries'], 'overview': s['overview'],
        'underfoot': s['underfoot'] and s['underfoot']['desc'],
        'screen0': d['screen']['lines'][0],
    }
tpl = (here / 'template.html').read_text()
html = tpl.replace('/*__DATA__*/null', json.dumps(out, separators=(',', ':')))
(here.parent / 'index.html').write_text(html)
print('wrote', here.parent / 'index.html', len(html))
