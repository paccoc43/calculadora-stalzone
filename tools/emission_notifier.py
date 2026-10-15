# -*- coding: utf-8 -*-
"""
Avisa en un canal de Discord cuando hay una emisión nueva en STALZONE.

Uso (desde la raíz del repositorio):
    python tools/emission_notifier.py                  # lee las credenciales de .env
    python tools/emission_notifier.py --region eu      # ru | eu | na | sea
    python tools/emission_notifier.py --dry-run        # imprime el mensaje sin enviarlo

Pensado para ejecutarse cada pocos minutos (ver .github/workflows/emission.yml). En cada
ejecución consulta GET /{region}/emission y compara el inicio de la emisión más reciente con
el último que ya se avisó, guardado en --state. Si la ejecución llega tarde y la emisión ya ha
terminado, avisa igualmente (los artefactos siguen en el mapa), indicando cuándo empezó.

Variables de entorno: STALZONE_CLIENT_ID / STALZONE_CLIENT_SECRET (como gen_prices.py),
STALZONE_REGION y DISCORD_WEBHOOK_URL.
"""
import argparse
import datetime
import io
import json
import os
import random
import sys
import urllib.request

from gen_prices import PROD, app_token, load_env

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, '.emission_state.json')


def get_json(url, token):
    req = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'User-Agent': 'calculadora-artefactos/1.0',
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def parse_ts(s):
    """'2026-10-15T12:34:56Z' (o con fracciones de segundo) -> datetime en UTC."""
    if not s:
        return None
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))


def load_state(path):
    if not os.path.exists(path):
        return {}
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


def save_state(path, state):
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(state, f)


USERNAME = 'AItor Menta'

# Frases del locutor. {region} es la región y {start} la hora de inicio, que Discord pinta en
# la hora local de cada uno ("hace 3 minutos").
ACTIVE = [
    '📻 ¡Buenas tardes, stalkers de {region}! Aquí AItor Menta con el parte del tiempo: '
    'se esperan cielos rojos, rayos y un 100 % de probabilidad de que te frías si sigues '
    'al raso. La emisión ha empezado {start}. ¡Al refugio!',
    '🎙️ Interrumpimos la programación musical para un aviso urgente: emisión en {region}, '
    'empezó {start}. Recuerden: un búnker al día es salud.',
    '⛈️ AItor Menta informa: ¡hay tormenta! Y no de las de paraguas. Emisión en {region} '
    'desde {start}. Los artefactos frescos, después; ahora, a esconderse.',
    '📡 Atención, oyentes de {region}: la Zona ha decidido estornudar. Emisión en curso '
    'desde {start}. Si ve el cielo de color raro, no es su monitor.',
    '🌩️ Parte meteorológico de AItor Menta: temperatura agradable, ligera brisa radiactiva '
    'y una emisión en {region} que empezó {start}. Les dejo con un tema mientras corren.',
    '📻 ¡Ding, ding, ding! Ha tocado la lotería de la Zona: emisión en {region} ({start}). '
    'Premio para quien llegue vivo al refugio: artefactos nuevos.',
    '🎙️ Se ruega a los stalkers de {region} que dejen lo que estén haciendo, incluido '
    'pelearse con el bandido de turno: emisión desde {start}. Ya se matarán luego.',
]
FINISHED = [
    '📻 AItor Menta, con retraso pero con estilo: hubo emisión en {region} (empezó {start}). '
    'La tormenta ya ha pasado y el suelo está sembrado de artefactos. ¡A recolectar!',
    '🎙️ Fe de erratas del parte: llovió más de lo previsto. Emisión en {region} a {start}. '
    'Ya se puede salir; los artefactos les esperan.',
    '☀️ Tras la tormenta llega la calma… y los artefactos. Emisión en {region} ({start}). '
    'AItor Menta les desea buena caza.',
    '📡 Los meteorólogos de la Zona confirman que la emisión de {region} ({start}) ya ha '
    'terminado. Saquen las mochilas: hoy toca cosecha.',
    '🌈 Ha escampado en {region}. La emisión empezó {start} y ha dejado regalitos por el '
    'mapa. Quien llegue primero, se los lleva.',
]


def build_message(region, start, active):
    ts = int(start.timestamp())
    when = '<t:%d:R>' % ts if active else '<t:%d:t>, <t:%d:R>' % (ts, ts)
    text = random.choice(ACTIVE if active else FINISHED).format(region=region, start=when)
    return {'content': text, 'username': USERNAME}


def post_discord(webhook, payload):
    req = urllib.request.Request(webhook, data=json.dumps(payload).encode('utf-8'), headers={
        'Content-Type': 'application/json',
        'User-Agent': 'calculadora-artefactos/1.0',
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()


def main():
    load_env()
    sys.stdout.reconfigure(encoding='utf-8')         # la consola de Windows no pinta los emojis
    ap =argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--region', default=os.environ.get('STALZONE_REGION', 'eu'))
    ap.add_argument('--client-id', default=os.environ.get('STALZONE_CLIENT_ID'))
    ap.add_argument('--client-secret', default=os.environ.get('STALZONE_CLIENT_SECRET'))
    ap.add_argument('--webhook', default=os.environ.get('DISCORD_WEBHOOK_URL'))
    ap.add_argument('--state', default=STATE)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not (args.client_id and args.client_secret):
        sys.exit('Faltan STALZONE_CLIENT_ID y STALZONE_CLIENT_SECRET.')
    if not (args.webhook or args.dry_run):
        sys.exit('Falta DISCORD_WEBHOOK_URL.')

    region = args.region.upper()
    token = app_token(args.client_id, args.client_secret)
    data = get_json('%s/%s/emission' % (PROD, region), token)

    current = parse_ts(data.get('currentStart'))
    latest = current or parse_ts(data.get('previousStart'))
    if latest is None:
        print('La API no informa de ninguna emisión en %s.' % region)
        return

    state = load_state(args.state)
    known = parse_ts(state.get(region))
    if known is not None and latest <= known:
        print('Sin emisiones nuevas en %s (última: %s).' % (region, latest.isoformat()))
        return

    # Sin estado previo (primera ejecución o caché perdida) solo se avisa de una emisión en
    # curso: anunciar la anterior podría ser repetir algo de hace horas.
    if known is None and current is None:
        print('Primera ejecución: se toma %s como última emisión conocida.' % latest.isoformat())
    else:
        payload = build_message(region, latest, current is not None)
        if args.dry_run:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            post_discord(args.webhook, payload)
            print('Aviso enviado: emisión de %s en %s.' % (latest.isoformat(), region))

    if not args.dry_run:
        state[region] = latest.isoformat()
        save_state(args.state, state)


if __name__ == '__main__':
    main()
