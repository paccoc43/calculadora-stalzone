# -*- coding: utf-8 -*-
"""
Regenera data/gamedata.js descargando el catálogo público de stalzone.wiki.

Uso (desde la raíz del repositorio):
    python tools/gen_data.py

Fuente: https://stalzone.wiki/api/builds-calculator/items/?category=...
Es el mismo endpoint que consume la calculadora oficial de la wiki.
"""
import io
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'gamedata.js')
API = 'https://stalzone.wiki/api/builds-calculator/items/?'


def fetch(categories):
    url = API + '&'.join('category=' + c for c in categories)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))


def short(k):
    return k.split('.')[-1]


def name_of(it):
    l = it['name']['lines']
    return {'en': l.get('en', ''), 'es': l.get('es', l.get('en', ''))}


def rng(s):
    """Stat con rango de tirada: [clave, min, max, esPositivo, esPorcentaje]."""
    return [short(s['name']['key']), s['value']['min'], s['value']['max'],
            1 if s['is_positive'] else 0, 1 if s['is_percentage'] else 0]


def num(s):
    """Stat fija: [clave, valor, esPositivo, esPorcentaje, (variantes por nivel)]."""
    e = [short(s['name']['key']), s['value'].get('calculated', 0),
         1 if s['is_positive'] else 0, 1 if s['is_percentage'] else 0]
    if s.get('type') == 'numericVariants':
        e.append([round(x, 5) for x in s['numericVariants']])
    return e


def main():
    print('Descargando catálogo…')
    art = fetch(['artefact'])
    arm = fetch(['armor'])
    cnt = fetch(['containers', 'backpacks'])

    stat_names = {}
    for src in (art, arm, cnt):
        for it in src:
            for s in it['stats'] + it.get('additionalStats', []):
                d = stat_names.setdefault(short(s['name']['key']), {})
                for lang in ('en', 'es'):
                    v = s['name']['lines'].get(lang)
                    if v and lang not in d:
                        d[lang] = v
    for k, d in stat_names.items():
        d.setdefault('en', k)
        d.setdefault('es', d['en'])

    artefacts = [{
        'i': a['exbo_id'], 'n': name_of(a),
        'c': a['category'].split('/')[-1], 'cat': a['category'],
        's': [rng(s) for s in a['stats']],
        'a': [rng(s) for s in a.get('additionalStats', [])],
    } for a in art]

    containers = [{
        'i': c['exbo_id'], 'n': name_of(c), 'cat': c['category'],
        'cap': c.get('capacity', 0),
        'eff': round(c.get('effectiveness', 100), 4),
        'pro': round(c.get('protection', 0), 4),
        's': [num(s) for s in c['stats']],
    } for c in cnt]

    armors = [{
        'i': a['exbo_id'], 'n': name_of(a),
        'c': a['category'].split('/')[-1], 'cat': a['category'],
        's': [num(s) for s in a['stats']],
    } for a in arm]

    artefacts.sort(key=lambda x: x['n']['en'])
    containers.sort(key=lambda x: (-x['cap'], x['n']['en']))
    armors.sort(key=lambda x: x['n']['en'])

    data = {'statNames': stat_names, 'artefacts': artefacts,
            'containers': containers, 'armors': armors}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with io.open(OUT, 'w', encoding='utf-8') as f:
        f.write('// Datos de juego de STALZONE. Generados con tools/gen_data.py\n')
        f.write('// desde https://stalzone.wiki/api/builds-calculator/items/ — no editar a mano.\n')
        f.write('window.SZ_DATA = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

    print('Escrito %s (%d KB)' % (OUT, os.path.getsize(OUT) // 1024))
    print('%d artefactos · %d contenedores · %d armaduras'
          % (len(artefacts), len(containers), len(armors)))


if __name__ == '__main__':
    main()
