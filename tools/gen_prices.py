# -*- coding: utf-8 -*-
"""
Regenera data/prices.js con los precios de subasta de la API oficial de STALZONE.

Uso (desde la raíz del repositorio):
    python tools/gen_prices.py                 # lee las credenciales de .env
    python tools/gen_prices.py --region eu     # ru | eu | na | sea

    python tools/gen_prices.py --demo          # API de demostración (datos ficticios)
    python tools/gen_prices.py --token eyJ...  # token de aplicación ya obtenido

    python tools/gen_prices.py --recheck-days 0   # recomprueba también los que no cotizaban
    python tools/gen_prices.py --workers 1        # descarga secuencial (para depurar)

Las credenciales se leen de .env (que está en .gitignore) o de las variables de entorno
STALZONE_CLIENT_ID / STALZONE_CLIENT_SECRET / STALZONE_REGION. Ver .env.example.

Para conseguirlas hay que registrar una aplicación en el Discord de EXBO (comando /newapp)
y esperar la aprobación: https://eapi.stalzone.net/registration.html

Fuente: GET /{region}/auction/{item}/history — historial de compras cerradas, con la
calidad y el nivel de mejora de cada lote. Ver https://eapi.stalzone.net/reference
"""
import argparse
import concurrent.futures
import http.client
import io
import json
import math
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMEDATA = os.path.join(ROOT, 'data', 'gamedata.js')
OUT = os.path.join(ROOT, 'data', 'prices.js')
ENV = os.path.join(ROOT, '.env')


def load_env():
    """
    Carga .env en el entorno del proceso, sin pisar lo que ya venga de fuera.
    Un formato mínimo (CLAVE=valor, # para comentarios) evita depender de python-dotenv.
    """
    if not os.path.exists(ENV):
        return
    for line in io.open(ENV, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

PROD = 'https://eapi.stalzone.com'
DEMO = 'https://dapi.stalzone.com'
TOKEN_URL = 'https://exbo.net/oauth/token'
# Token de aplicación de la API de demostración, publicado en la propia documentación.
DEMO_TOKEN = (
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwibmJmIjoxNjczNzk3ODM4LCJleHAiOjQ4MjczOTc4MzgsIml'
    'hdCI6MTY3Mzc5NzgzOCwianRpIjoiYXhwbzAzenJwZWxkMHY5dDgzdzc1N2x6ajl1MmdyeHVodXVlb2xsZ3M2dml1YjVva3NwZTJ'
    '3eGFrdjJ1eWZxaDU5ZDE2ZTNlN2FqdW16Z3gifQ.ZNSsvwAX72xT5BzLqqYABuH2FGbOlfiXMK5aYO1H5llG51ZjcPvOYBDRR4HU'
    'oPZVLFY8jyFUsEXNM7SYz8qL9ePmLjJl6pib8FEtqVPmf9ldXvKkbaaaSp4KkJzsIEMY_Z5PejB2Vr-q-cL13KPgnLGUaSW-2X_s'
    'HPN7VZJNMjRgjw4mPiRZTe4CEpQq0BEcPrG6OLtU5qlZ6mLDJBjN2xtK0DI6xgmYriw_5qW1mj1nqF_ewtUiQ1KTVhDgXnaNUdkG'
    'sggAGqyicTei0td6DTKtnl3noD5VkipWn_CwSqb2Mhm16I9BPfX_d5ARzWrnrwPRUf6PA_7LipNU6KkkW0mhZfmwEPTm_sXPus0m'
    'HPENoVZArdFT3L5sOYBcpqwvVIEtxRUTdcsKp-y-gSzao5muoyPVoCc2LEeHEWx0cIi9spsZ46SPRQpN4baVFp7y5rp5pjRsBKHQ'
    'YUJ0lTmh1_vyfzOzbtNN2v6W_5w9JTLrN1U6fhmifvKHppFSEqD6DameL1TC59kpIdufRkEU9HE4O-ErEf1GuJFRx-Dew6XDvb_E'
    'xhvEqcw31yNvKzpVqLYJfLazqn6tUbVuAiPwpy6rP9tYO2taT1vj5TGn_vxwDu9zoLWe796tFMPS-kmbCglxB5C9L4EbpfWNbWxY'
    'jUkTvjT2Ml9OnrB0UbYo1jI')

# Clases de calidad tal y como las devuelve la subasta (campo `qlt`), en el mismo orden
# que las franjas de rareza de la calculadora.
QCLASSES = ['ordinary', 'unordinary', 'special', 'rare', 'exclusive', 'legendary', 'unique']
MAX_LIMIT = 200          # tope que admite el endpoint por petición


# --------------------------------------------------------------------------- HTTP

class Pacer(object):
    """
    Reparte el ritmo de peticiones entre todos los hilos: espacia los *inicios*, no los
    finales, así que la latencia de una petición se solapa con la espera de las demás.
    Si la API contesta 429 se afloja el ritmo para el resto de la ejecución.
    """

    def __init__(self, delay):
        self.delay = delay
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self):
        with self._lock:
            slot = max(time.time(), self._next)
            self._next = slot + self.delay
        pause = slot - time.time()
        if pause > 0:
            time.sleep(pause)

    def slow_down(self, factor=1.5, cap=2.0):
        with self._lock:
            self.delay = min(cap, self.delay * factor)
            return self.delay


class Api(object):
    """
    Cliente con una conexión persistente por hilo: la subasta se consulta un objeto tras
    otro contra el mismo servidor, y reaprovechar el socket ahorra el saludo TLS —el grueso
    del tiempo de cada petición— en todas menos la primera.
    """

    def __init__(self, base, token, pacer, region):
        u = urllib.parse.urlsplit(base)
        self.base = base.rstrip('/')
        self.scheme, self.host, self.prefix = u.scheme, u.netloc, u.path.rstrip('/')
        self.token = token
        self.pacer = pacer
        self.region = region
        self._local = threading.local()

    def _conn(self):
        c = getattr(self._local, 'conn', None)
        if c is None:
            cls = http.client.HTTPSConnection if self.scheme == 'https' else http.client.HTTPConnection
            c = cls(self.host, timeout=60)
            self._local.conn = c
        return c

    def _drop(self):
        c = getattr(self._local, 'conn', None)
        if c is not None:
            try:
                c.close()
            except Exception:                        # noqa: BLE001 — cerrar nunca debe romper
                pass
            self._local.conn = None

    def get(self, path, params=None, retries=5):
        url = self.prefix + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        for attempt in range(retries):
            self.pacer.wait()
            try:
                conn = self._conn()
                conn.request('GET', url, headers={
                    'Authorization': 'Bearer ' + self.token,
                    'Accept': 'application/json',
                    'User-Agent': 'calculadora-artefactos/1.0',
                })
                r = conn.getresponse()
                body = r.read()
                status, retry_after = r.status, r.getheader('Retry-After')
                if r.will_close:
                    self._drop()
            except (http.client.HTTPException, socket.error) as e:
                # Un socket reutilizado puede haber caducado al otro lado: se tira y se reintenta.
                self._drop()
                if attempt < retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError('sin conexión con %s: %s' % (self.base, e))

            if status in (400, 404):
                return None                          # el objeto no cotiza en subasta
            if status == 429 or status in (500, 502, 503):
                if attempt >= retries - 1:
                    raise RuntimeError('HTTP %d en %s' % (status, url))
                if status == 429:
                    print('    HTTP 429: bajando el ritmo a %.2f s entre peticiones'
                          % self.pacer.slow_down())
                pause = float(retry_after or 0) or 2 ** (attempt + 1)
                time.sleep(pause)
                continue
            if status != 200:
                raise RuntimeError('HTTP %d en %s' % (status, url))
            return json.loads(body.decode('utf-8'))
        return None


def app_token(client_id, client_secret):
    """Client Credentials Grant: token de aplicación a partir del id y el secreto."""
    body = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'client_credentials',
        'scope': '',
    }).encode('utf-8')
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))['access_token']


# --------------------------------------------------------------------------- datos

def load_gamedata():
    src = io.open(GAMEDATA, encoding='utf-8').read()
    i = src.index('=') + 1
    return json.loads(src[i:src.rindex(';')].strip())


def load_previous(path, region, demo):
    """
    Lee el prices.js que ya hubiera. Sólo sirve si se generó para la misma región y el
    mismo servidor: qué objetos llegan a la subasta cambia de una región a otra.
    """
    try:
        src = io.open(path, encoding='utf-8').read()
        prev = json.loads(src[src.index('=') + 1:src.rindex(';')].strip())
    except Exception:                                # noqa: BLE001 — sin fichero se descarga todo
        return {}
    if prev.get('region') != region.upper() or bool(prev.get('demo')) != bool(demo):
        return {}
    return prev


def untraded_cache(prev, catalog):
    """
    Objetos que ya se sabe que no se subastan, con la fecha en que se comprobó.

    No hace falta que el prices.js traiga la lista apuntada: lo que no aparece en `items`
    es justo lo que no dio precio, así que la caché se deduce de ahí y las fechas guardadas
    sólo afinan cuándo toca recomprobar cada uno. Así también sirve un fichero generado
    antes de que existiera la caché.

    La deducción se hace por categoría y sólo para las que tengan algún objeto con precio,
    porque una categoría entera vacía puede ser que aquella vez ni se llegara a pedir (--only).
    """
    items = (prev or {}).get('items') or {}
    if not items:
        return {}
    seen = prev.get('untraded') or {}
    day = (prev.get('generated') or '')[:10] or time.strftime('%Y-%m-%d', time.gmtime())
    priced = set(kind for kind, it in catalog if it['i'] in items)
    return dict((it['i'], seen.get(it['i'], day)) for kind, it in catalog
                if kind in priced and it['i'] not in items)


def fetch_history(api, item_id, pages):
    """Devuelve la lista de ventas del historial, paginando de 200 en 200."""
    out = []
    for page in range(pages):
        d = api.get('/%s/auction/%s/history' % (api.region, item_id),
                    {'limit': MAX_LIMIT, 'offset': page * MAX_LIMIT, 'additional': 'true'})
        if d is None:
            return None                              # objeto no comerciable
        prices = d.get('prices') or []
        out.extend(prices)
        if len(prices) < MAX_LIMIT:
            break
    return out


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def aggregate(sales, kind):
    """
    Agrupa las ventas por (clase de calidad, nivel de mejora) y devuelve la mediana
    de cada grupo. La mediana, y no la media, porque el historial tiene lotes atípicos
    (regalos entre jugadores a precio simbólico y reventas infladas).

    Los contenedores no tienen nivel ni calidad: se agregan en un único grupo (0, 0).
    Las armaduras se agrupan sólo por nivel, porque el catálogo de la calculadora no
    distingue su calidad y no habría con qué consultar el precio de cada rareza.
    """
    groups = {}
    for s in sales:
        amount = max(1, s.get('amount') or 1)
        price = (s.get('price') or 0) / float(amount)
        if price <= 0:
            continue                                 # traspasos a precio cero
        add = s.get('additional') or {}
        if kind == 'container':
            q, lvl = 0, 0
        elif kind == 'armor':
            q, lvl = 0, int(add.get('ptn') or 0)
        else:
            q = int(add.get('qlt') or 0)
            lvl = int(add.get('ptn') or 0)
        if not (0 <= q < len(QCLASSES)) or not (0 <= lvl <= 15):
            continue
        groups.setdefault((q, lvl), []).append(price)
    return {k: (median(v), len(v)) for k, v in groups.items()}


# ------------------------------------------------------------------- modelo de precio

def solve(a, b):
    """Sistema lineal pequeño por eliminación gaussiana con pivoteo parcial."""
    n = len(b)
    m = [list(a[i]) + [b[i]] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            return None
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r == c:
                continue
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


def fit(points, force=None):
    """
    Ajusta log(precio) = a + b·nivel + c·clase_de_calidad por mínimos cuadrados
    ponderados por el número de ventas de cada punto.

    El precio de la subasta crece de forma aproximadamente geométrica tanto con el
    nivel de mejora como con la rareza, así que la regresión se hace en logaritmos:
    b y c son entonces el encarecimiento por punto de nivel y por escalón de rareza.

    `force` fija (b, c) y ajusta sólo el término independiente, para los objetos con
    pocas observaciones propias.
    """
    if force is not None:
        b, c = force
        sw = sum(w for _, _, _, w in points)
        a = sum(w * (y - b * lv - c * q) for lv, q, y, w in points) / sw
        return a, b, c

    n, sl, sq = 0.0, 0.0, 0.0
    A = [[0.0] * 3 for _ in range(3)]
    B = [0.0] * 3
    for lv, q, y, w in points:
        x = (1.0, float(lv), float(q))
        for i in range(3):
            for j in range(3):
                A[i][j] += w * x[i] * x[j]
            B[i] += w * x[i] * y
    return solve(A, B)


def global_slopes(per_item):
    """
    Pendientes comunes (encarecimiento por nivel y por escalón de rareza) estimadas
    con un modelo de efectos fijos: cada objeto aporta sus desviaciones respecto a su
    propia media, de modo que las diferencias de precio base entre objetos no
    contaminan la estimación de las pendientes.
    """
    A = [[0.0] * 2 for _ in range(2)]
    B = [0.0] * 2
    for points in per_item.values():
        if len(points) < 2:
            continue
        sw = sum(w for _, _, _, w in points)
        ml = sum(w * lv for lv, _, _, w in points) / sw
        mq = sum(w * q for _, q, _, w in points) / sw
        my = sum(w * y for _, _, y, w in points) / sw
        for lv, q, y, w in points:
            x = (lv - ml, q - mq)
            dy = y - my
            for i in range(2):
                for j in range(2):
                    A[i][j] += w * x[i] * x[j]
                B[i] += w * x[i] * dy
    # Si el historial no da para estimar (por ejemplo, las armaduras se subastan siempre
    # sin mejorar), no se inventa ninguna pendiente: el precio no varía con nivel ni rareza.
    return solve(A, B) or [0.0, 0.0]


def build_model(obs, kind):
    """
    Convierte las observaciones en un modelo por objeto. Devuelve, para cada uno, los
    tres coeficientes y las propias observaciones (que la calculadora prefiere al
    modelo cuando existen para la combinación exacta que se está mirando).
    """
    per_item = {}
    for item_id, groups in obs.items():
        pts = [(lvl, q, math.log(p), float(n)) for (q, lvl), (p, n) in groups.items() if p > 0]
        if pts:
            per_item[item_id] = pts

    if kind == 'container':
        gb, gc = 0.0, 0.0                # no tienen ni nivel de mejora ni calidad
    else:
        gb, gc = global_slopes(per_item)
        if kind == 'armor':
            gc = 0.0                     # el catálogo de armaduras no distingue calidad

    model = {}
    for item_id, pts in per_item.items():
        levels = set(p[0] for p in pts)
        qs = set(p[1] for p in pts)
        total = sum(p[3] for p in pts)
        # Sólo se ajustan pendientes propias cuando hay variedad suficiente; en otro
        # caso se reutilizan las globales y se ajusta únicamente el nivel de precios.
        own = None
        if len(levels) >= 3 and len(qs) >= 2 and total >= 20:
            own = fit(pts)
        if own is None or any(not math.isfinite(v) for v in own):
            own = fit(pts, force=(gb, gc))
        a, b, c = own
        # Encoge las pendientes propias hacia las globales según el volumen de datos:
        # con pocas ventas manda el comportamiento general del mercado.
        k = total / (total + 40.0)
        b = k * b + (1 - k) * gb
        c = k * c + (1 - k) * gc
        a = fit(pts, force=(b, c))[0]
        model[item_id] = {
            'a': round(a, 5), 'b': round(b, 6), 'c': round(c, 5),
            'n': int(total),
            'o': {'%d,%d' % (q, lvl): [int(round(p)), n]
                  for (q, lvl), (p, n) in obs[item_id].items() if p > 0},
        }
    return model, gb, gc


# --------------------------------------------------------------------------- main

def main():
    load_env()
    ap = argparse.ArgumentParser(description='Descarga precios de subasta y genera data/prices.js')
    ap.add_argument('--region', default=os.environ.get('STALZONE_REGION', 'eu'),
                    help='ru | eu | na | sea (por defecto: el de .env, o eu)')
    ap.add_argument('--token', default=os.environ.get('STALZONE_TOKEN'),
                    help='token de aplicación ya obtenido')
    ap.add_argument('--client-id', default=os.environ.get('STALZONE_CLIENT_ID'))
    ap.add_argument('--client-secret', default=os.environ.get('STALZONE_CLIENT_SECRET'))
    ap.add_argument('--demo', action='store_true',
                    help='usa la API de demostración (datos ficticios, sólo para probar)')
    ap.add_argument('--pages', type=int, default=1,
                    help='páginas de 200 ventas por objeto (por defecto: 1)')
    ap.add_argument('--delay', type=float, default=0.2,
                    help='segundos entre el inicio de una petición y el de la siguiente '
                         '(por defecto: 0.2; súbelo si la API responde 429)')
    ap.add_argument('--workers', type=int, default=8,
                    help='descargas simultáneas (por defecto: 8; 1 vuelve a ser secuencial)')
    ap.add_argument('--recheck-days', type=int, default=7,
                    help='cada cuántos días se vuelve a comprobar un objeto que no cotizaba '
                         '(por defecto: 7; 0 los comprueba siempre)')
    ap.add_argument('--only', default='artefact,container,armor',
                    help='categorías a descargar, separadas por comas')
    ap.add_argument('--limit', type=int, default=0,
                    help='descarga sólo los N primeros objetos (para pruebas)')
    ap.add_argument('--out', default=OUT, help='fichero de salida')
    args = ap.parse_args()

    if args.demo:
        base, token = DEMO, DEMO_TOKEN
    else:
        base = PROD
        token = args.token
        if not token:
            if not (args.client_id and args.client_secret):
                sys.exit('Faltan credenciales. Usa --demo, --token, o define\n'
                         'STALZONE_CLIENT_ID y STALZONE_CLIENT_SECRET.\n'
                         'Registro de aplicaciones: https://eapi.stalzone.net/registration.html')
            print('Obteniendo token de aplicación…')
            token = app_token(args.client_id, args.client_secret)

    api = Api(base, token, Pacer(max(0.0, args.delay)), args.region.lower())

    data = load_gamedata()
    kinds = [k.strip() for k in args.only.split(',') if k.strip()]
    catalog = []
    if 'artefact' in kinds:
        catalog += [('artefact', it) for it in data['artefacts']]
    if 'container' in kinds:
        catalog += [('container', it) for it in data['containers']]
    if 'armor' in kinds:
        catalog += [('armor', it) for it in data['armors']]
    if args.limit:
        catalog = catalog[:args.limit]

    # Dos tercios largos del catálogo no llegan a subastarse nunca (casi todas las armaduras
    # y la mitad de las mochilas). Preguntar por ellos en cada ejecución es la mitad del
    # tiempo para nada, así que se recuerda quiénes son y se recomprueban de vez en cuando.
    known = untraded_cache(load_previous(args.out, api.region, args.demo), catalog) \
        if args.recheck_days > 0 else {}
    today = time.strftime('%Y-%m-%d', time.gmtime())
    fresh = time.strftime('%Y-%m-%d', time.gmtime(time.time() - args.recheck_days * 86400.0))
    skipped = dict((i, d) for i, d in known.items() if d >= fresh)
    pending = [(k, it) for k, it in catalog if it['i'] not in skipped]

    workers = max(1, args.workers)
    print('Descargando %d objetos de la región %s (%s) con %d hilos…'
          % (len(pending), api.region.upper(), base, workers))
    if skipped:
        print('  (%d que no cotizan se saltan: %d peticiones menos; --recheck-days 0 los '
              'recomprueba)' % (len(skipped), len(skipped) * args.pages))

    obs = {'artefact': {}, 'container': {}, 'armor': {}}
    untraded = dict(skipped)
    failed = []
    total = len(pending)

    def work(job):
        """Lo único que corre en los hilos: bajar el historial de un objeto."""
        kind, it = job
        name = it['n']['es'] or it['n']['en']
        try:
            return kind, it, name, fetch_history(api, it['i'], args.pages), None
        except Exception as e:                       # noqa: BLE001 — se informa y se sigue
            return kind, it, name, None, e

    def report(n, kind, it, name, sales, err):
        """Agrega y va contando. Corre siempre en el hilo principal y en el orden del
        catálogo, así que no hace falta sincronizar nada ni se entrelazan las líneas."""
        if err is not None:
            failed.append((it['i'], name, str(err)))
            print('  [%3d/%d] %-28s ERROR %s' % (n, total, name[:28], err))
            return
        # Sin lotes en la subasta (404), con el historial vacío o con ventas que no dejan
        # ninguna mediana utilizable, el resultado es el mismo: no hay precio que estimar.
        # Se apunta para no volver a preguntar por él en la siguiente actualización.
        groups = aggregate(sales, kind) if sales else {}
        if not groups:
            untraded[it['i']] = today
            print('  [%3d/%d] %-28s no cotiza' % (n, total, name[:28]))
            return
        obs[kind][it['i']] = groups
        print('  [%3d/%d] %-28s %4d ventas · %2d combinaciones'
              % (n, total, name[:28], len(sales), len(groups)))

    started = time.time()
    if workers == 1:
        for n, job in enumerate(pending, 1):
            report(n, *work(job))
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            for n, res in enumerate(pool.map(work, pending), 1):
                report(n, *res)

    out = {
        'region': api.region.upper(),
        'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': base,
        'demo': bool(args.demo),
        'qclasses': QCLASSES,
        'items': {},
        'slopes': {},
        # Fecha en que se vio que cada objeto no se subasta, para no volver a preguntar por
        # él en cada ejecución. La calculadora no lo usa: es caché del generador.
        'untraded': untraded,
    }
    for kind in ('artefact', 'container', 'armor'):
        if not obs[kind]:
            continue
        model, gb, gc = build_model(obs[kind], kind)
        out['items'].update(model)
        out['slopes'][kind] = [round(gb, 6), round(gc, 5)]

    with io.open(args.out, 'w', encoding='utf-8') as f:
        f.write('// Precios de subasta de STALZONE. Generados con tools/gen_prices.py\n')
        f.write('// desde %s (región %s) — no editar a mano.\n' % (base, out['region']))
        f.write('window.SZ_PRICES = ')
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

    print('\nEscrito %s (%d KB); descarga en %.1f s'
          % (args.out, os.path.getsize(args.out) // 1024, time.time() - started))
    print('%d objetos con precio · %d no cotizan (%d ya se sabían) · %d con error'
          % (len(out['items']), len(untraded), len(skipped), len(failed)))
    flat = sum(1 for m in out['items'].values() if len(m['o']) == 1)
    print('%d con una única combinación de calidad y nivel (precio plano)' % flat)
    for kind, s in out['slopes'].items():
        if s[0] or s[1]:
            print('  %-9s +%.1f %% por nivel · ×%.2f por escalón de rareza'
                  % (kind, (math.exp(s[0]) - 1) * 100, math.exp(s[1])))
        else:
            print('  %-9s sin variación observable por nivel ni rareza' % kind)


if __name__ == '__main__':
    main()
