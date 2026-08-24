# -*- coding: utf-8 -*-
"""
Sirve la calculadora en local y le da un botón para actualizar los precios de mercado.

Uso (desde la raíz del repositorio):
    python tools/serve.py                  # abre http://127.0.0.1:8000 en el navegador
    python tools/serve.py --port 9000
    python tools/serve.py --no-browser
    python tools/serve.py --region ru      # región con la que se actualizarán los precios

Abrir index.html con doble clic sigue funcionando igual; lo único que se pierde es el botón
de «Actualizar precios», que necesita a alguien que ejecute tools/gen_prices.py. Eso es todo
lo que hace este servidor: servir los ficheros del repositorio y, cuando la página lo pide,
lanzar el generador y contar cómo va.

Sólo escucha en 127.0.0.1 y no acepta ningún parámetro del navegador: qué se ejecuta está
decidido aquí, en los argumentos del arranque.
"""
import argparse
import functools
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(ROOT, 'tools', 'gen_prices.py')
OUT = os.path.join(ROOT, 'data', 'prices.js')

# Cabecera que tiene que traer quien pida una actualización. El navegador no deja ponerla en
# una petición de otro origen sin preguntar antes (preflight), y aquí no se contesta a esas
# preguntas, así que ninguna página ajena puede disparar el generador por su cuenta.
GUARD = ('X-Calculadora', '1')
MAX_LINES = 400          # cola de salida que se guarda para enseñar el progreso


class Job(object):
    """La actualización en curso, si la hay. Sólo puede haber una a la vez."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.running = False
        self.done = False
        self.ok = False
        self.lines = []
        self.summary = ''
        self.started = 0.0
        self.elapsed = 0.0

    def snapshot(self):
        with self.lock:
            return {
                'running': self.running,
                'done': self.done,
                'ok': self.ok,
                'lines': list(self.lines),
                'summary': self.summary,
                'elapsed': round(self.elapsed or (time.time() - self.started if self.running else 0), 1),
            }

    def start(self, args):
        """Arranca el generador en segundo plano. Devuelve False si ya había uno en marcha."""
        with self.lock:
            if self.running:
                return False
            self.reset()
            self.running = True
            self.started = time.time()
        threading.Thread(target=self._run, args=(args,), daemon=True).start()
        return True

    def _run(self, args):
        # El hijo escribe acentos y el · de las líneas de progreso: sin forzar UTF-8, en
        # Windows la consola del proceso hijo los rompería antes de llegar aquí.
        env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUNBUFFERED='1')
        try:
            p = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, encoding='utf-8', errors='replace')
            for line in p.stdout:
                line = line.rstrip('\n')
                with self.lock:
                    self.lines.append(line)
                    del self.lines[:-MAX_LINES]
                    # El resumen que interesa enseñar es la última línea con enjundia.
                    if line.strip() and not line.startswith('  ['):
                        self.summary = line.strip()
            code = p.wait()
        except Exception as e:                       # noqa: BLE001 — se informa en la interfaz
            code, self.summary = 1, str(e)
            with self.lock:
                self.lines.append('ERROR: %s' % e)
        with self.lock:
            self.running = False
            self.done = True
            self.ok = code == 0
            self.elapsed = time.time() - self.started
            if not self.ok and not self.summary:
                self.summary = 'El generador terminó con código %s' % code


JOB = Job()


def gen_command(region, demo=False):
    cmd = [sys.executable, GEN]
    if demo:
        cmd.append('--demo')
    elif region:
        cmd += ['--region', region]
    return cmd


class Handler(http.server.SimpleHTTPRequestHandler):
    """Ficheros del repositorio, más los dos endpoints de la actualización."""

    region = None
    demo = False

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def guarded(self):
        if self.headers.get(GUARD[0]) == GUARD[1]:
            return True
        self.send_json({'error': 'petición no reconocida'}, 403)
        return False

    def do_GET(self):
        if self.path.startswith('/api/prices'):
            if not self.guarded():
                return
            if self.path == '/api/prices/status':
                gen = os.path.exists(OUT) and time.strftime(
                    '%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(OUT)))
                return self.send_json({'server': True, 'region': self.region,
                                       'demo': self.demo, 'file': gen})
            if self.path == '/api/prices/refresh':
                return self.send_json(JOB.snapshot())
            return self.send_json({'error': 'no existe'}, 404)
        return http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path != '/api/prices/refresh':
            return self.send_json({'error': 'no existe'}, 404)
        if not self.guarded():
            return
        started = JOB.start(gen_command(self.region, self.demo))
        return self.send_json(dict(JOB.snapshot(), started=started))

    def end_headers(self):
        # La instantánea de precios se reescribe en caliente: sin esto el navegador podría
        # recargar la página y seguir leyendo el prices.js viejo de su caché.
        self.send_header('Cache-Control', 'no-store')
        http.server.SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        if '/api/prices/refresh' in (self.path or '') and self.command == 'GET':
            return                                   # el sondeo del progreso ensucia la consola
        http.server.SimpleHTTPRequestHandler.log_message(self, fmt, *args)


def main():
    ap = argparse.ArgumentParser(description='Sirve la calculadora con actualización de precios')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--region', default=None,
                    help='región con la que actualizar (por defecto: la de .env)')
    ap.add_argument('--demo', action='store_true',
                    help='el botón usará la API de demostración (precios ficticios, sin credenciales)')
    ap.add_argument('--no-browser', action='store_true', help='no abrir el navegador al arrancar')
    args = ap.parse_args()

    Handler.region = args.region
    Handler.demo = args.demo
    handler = functools.partial(Handler, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    url = 'http://127.0.0.1:%d/index.html' % args.port

    print('Calculadora en %s' % url)
    print('El botón «Actualizar precios» ejecuta: %s'
          % ' '.join(gen_command(args.region, args.demo)[1:]))
    print('Ctrl+C para parar.')
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nParado.')
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
