"""
capture_guide.py — Capturas de pantalla para la Guía de uso (RF13).

Herramienta de desarrollo (como generate_icons.py): abre la app en un
navegador controlado, la lleva a cada estado que explica la guía y guarda
una captura recortada al elemento relevante, en tema oscuro y claro.

Requisitos:
  pip install playwright
  python -m playwright install chromium    # opcional: sin esto se usa el
                                           # Google Chrome instalado (--channel chrome)
  Pillow (pip install pillow), ya usado por generate_icons.py

Uso:
  1. Servir la app:  python -m http.server 8080
  2. Ejecutar:       python scripts/capture_guide.py
     Opciones:       --channel chromium   usar el Chromium de Playwright
                     --quality 72         calidad WebP (por defecto 75)
                     --actualizar-marcadores  corrige en partials/guide.html
                                          las posiciones de los marcadores numerados

Salida en assets/guide/<nombre>-dark.webp y <nombre>-light.webp (máx. 800 px
de ancho), salvo tema.webp, que muestra los dos temas en una sola imagen.

Capturas reproducibles:
  - El clima (api.openweathermap.org/data/2.5/weather) se responde con un
    JSON fijo: 10 % de nubes y 14 °C, un ejemplo "óptimo". Las teselas de
    nubes (tile.openweathermap.org) NO se interceptan: esa capa es real.
  - El reloj arranca en una noche de luna nueva (CAPTURE_TIME), calculada
    con la misma fórmula de predictor.js. Se usa clock.install() +
    resume() y no set_fixed_time(): con la hora congelada, flyTo/panTo de
    Leaflet (que miden el avance con Date.now) nunca terminan y el mapa
    no se mueve al abrir el panel.
  - La geolocalización se simula en el centro de Tunja con el permiso
    concedido: NUNCA se usa la ubicación real de quien ejecuta el script.
    Tunja y no Villa de Leyva para que el punto azul no tape el marcador
    del catálogo.
  - Los Service Workers se bloquean: así ninguna caché vieja interfiere y
    page.route ve todas las peticiones.

Nitidez:
  - Las capturas de mapa se hacen a densidad 1 (las teselas son de 256 px:
    a 2x se amplían y se ven borrosas), en una ventana de 800 px de ancho:
    cada recorte es de 800 px exactos, sin redimensionar.
  - Las de interfaz (panel, buscador, botones) se hacen a 2x y se reducen
    a 800 px de ancho como máximo.

Marcadores numerados (círculos con el número del paso sobre algunas
imágenes de la guía): STEP_TARGETS dice qué elemento señala cada paso. Al
capturar se calcula su posición en % sobre la imagen y se compara con los
<span class="guide-step"> de partials/guide.html; si la interfaz cambió y
ya no coinciden, el informe final dice qué valores poner. Con
--actualizar-marcadores el script los escribe en el HTML directamente.

Notas:
  - Si js/config.js no existe, las capas de contaminación y nubosidad
    salen deshabilitadas en las capturas (el script avisa).
  - Cada tema se captura en sesiones que arrancan con ese tema guardado
    (gis-theme en localStorage), como haría un usuario: así cambian la
    interfaz Y el mapa base. Solo alternar html.light-theme dejaría la
    interfaz clara sobre el mapa oscuro.
  - Se emula prefers-reduced-motion: reduce para capturar estados finales
    (sin fotogramas a mitad de una animación).
"""

import argparse
import io
import json
import math
import re
import sys
import urllib.request
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

from PIL import Image
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE_URL = 'http://localhost:8080/'
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'assets' / 'guide'

# Tunja (Boyacá), plaza de Bolívar: ubicación simulada para las capturas.
# Precisión de 800 m para que el círculo de margen de error se vea a zoom 12
FAKE_LOCATION = {'latitude': 5.5446, 'longitude': -73.3576, 'accuracy': 800}

# Clima fijo: el panel muestra un ejemplo de condiciones óptimas
WEATHER_API = re.compile(r'^https://api\.openweathermap\.org/data/2\.5/weather')
FAKE_WEATHER = {'clouds': {'all': 10}, 'main': {'temp': 14}}

# Luna nueva con la fórmula de predictor.js (MOON_CYCLE y KNOWN_NEW): la
# n.º 34 tras la de referencia cae el 11/10/2026; a las 21:00 de Colombia
# la luna tiene ~0,5 días (fase "Nueva", 0 % iluminada)
MOON_CYCLE = 29.53058867
KNOWN_NEW = datetime(2024, 1, 11, 11, 57, tzinfo=timezone.utc)
NEW_MOON_INDEX = 34
COLOMBIA_TZ = timezone(timedelta(hours=-5))

# Encuadres
MARKERS_ZOOM = 7
MARKERS_CENTER = (5.1, -73.6)    # Boyacá–Cundinamarca
LAYERS_ZOOM = 8
LAYERS_CENTER = (5.3, -74.8)     # eje Bogotá–Medellín
LOCATE_ZOOM = 12
PANEL_VIEW = (5.75, -73.45, 9)   # Villa de Leyva a la vista (sin el punto azul)

MAP_VIEWPORT = {'width': 800, 'height': 800}   # capturas de mapa, a 1x
UI_VIEWPORT = {'width': 1280, 'height': 800}   # capturas de interfaz, a 2x
TALL_VIEWPORT = {'width': 1280, 'height': 1800}  # panel completo sin scroll
HEADER_VIEWPORT = {'width': 760, 'height': 800}  # header compacto para "tema"
MOBILE_VIEWPORT = {'width': 375, 'height': 812}
UI_SCALE = 2
MAX_WIDTH = 800
CLIP_W, CLIP_H = 800, 500        # capas y marcadores
TARGET_BYTES = int(1.5 * 1024 * 1024)

# Resultados de Nominatim: <li> sin clase (los de recientes, el título y
# "Borrar historial" sí la llevan)
RESULT_ITEM = '#search-results li:not([class])'

# Marcadores numerados por imagen: (selector CSS, índice entre los que
# coinciden, fx, fy, dx, dy). (fx, fy) es el punto del elemento donde se
# centra el círculo, en fracción de su ancho y alto ((0, 0.5) = mitad del
# borde izquierdo); (dx, dy) lo corre en px para no tapar lo que señala
# (-16: a la izquierda del elemento, en el espacio libre)
STEP_TARGETS = {
    'buscador': [('#search-input', 0, 0, 0.5, 0, 0),           # 1 la barra
                 ('#search-btn', 0, 0, 0.5, -16, 0),           # 2 la lupa
                 (RESULT_ITEM, 0, 0, 0.5, 0, 0)],              # 3 un resultado
    'recientes': [('.search-item-recent', 0, 0, 0.5, 0, 0),    # 1 una búsqueda
                  ('.search-item-remove', 0, 0, 0.5, -16, 0),  # 2 su ✕
                  ('.search-clear button', 0, 0, 0.5, -16, 0)],  # 3 Borrar historial
    'panel': [('.success-gauge', 0, 0, 0, 0, 0),               # 1 porcentaje de éxito
              ('#side-panel .panel-section', 0, 0, 0, 0, 0),   # 2 condiciones actuales
              ('#side-panel .panel-section', 1, 0, 0, 0, 0),   # 3 simulador
              ('#spot-info-section', 0, 0, 0, 0, 0)],          # 4 ficha del sitio
    'simulador': [('#sim-clouds-val', 0, 0, 0.5, -16, 0),      # 1 valores reales
                  ('#sim-bortle', 0, 0, 0.5, 0, 0),            # 2 mover un control
                  ('.sim-result', 0, 0, 0.5, 0, 0)],           # 3 resultado simulado
    'instalar': [('#install-btn', 0, 0, 0, 0, 0)],             # 1 botón instalar
}
STEP_TOLERANCE = 1.5  # puntos porcentuales de diferencia admitidos
GUIDE_HTML = ROOT / 'partials' / 'guide.html'

# Historial precargado para la captura de búsquedas recientes (mismo
# formato que guarda search.js)
RECENT_SEARCHES = [
    {'name': 'Villa de Leyva, Ricaurte, Boyacá', 'region': 'Boyacá, Colombia',
     'lat': 5.6333, 'lng': -73.5250, 'zoom': 13},
    {'name': 'Desierto de la Tatacoa, Villavieja, Huila', 'region': 'Huila, Colombia',
     'lat': 3.2319, 'lng': -75.1741, 'zoom': 12},
    {'name': 'Barichara, Guanentá, Santander', 'region': 'Santander, Colombia',
     'lat': 6.6359, 'lng': -73.2236, 'zoom': 14},
]

# Antes de cargar la app: tema guardado, historial y acceso a la instancia
# del mapa. Leaflet hace window.L = ...; al ocurrir, se registra un hook que
# guarda cada L.Map creado en window.__captureMap (solo para esta herramienta).
INIT_SCRIPT = """
try {
  localStorage.setItem('gis-theme', %THEME%);
  localStorage.setItem('gis-recent-searches', %RECENT%);
} catch (e) {}
(() => {
  let leaflet;
  Object.defineProperty(window, 'L', {
    configurable: true,
    get() { return leaflet; },
    set(value) {
      leaflet = value;
      if (value && value.Map) value.Map.addInitHook(function () { window.__captureMap = this; });
    },
  });
})();
// Fuera de las capturas: toasts (pasajeros) y el badge de Netlify si existe
document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = `.toast { visibility: hidden !important; }
    [src*="/.netlify/"], [href*="/.netlify/"] { display: none !important; }`;
  document.head.appendChild(s);
});
"""


# ── Utilidades ─────────────────────────────────────────────────

def new_moon_night():
    """21:00 (hora de Colombia) del día de la luna nueva NEW_MOON_INDEX."""
    instant = KNOWN_NEW + timedelta(days=NEW_MOON_INDEX * MOON_CYCLE)
    day = instant.astimezone(COLOMBIA_TZ).date()
    night = datetime.combine(day, time(21, 0), COLOMBIA_TZ)
    # Comprobación con la fórmula de predictor.js: fase "Nueva" (< 3 % o > 97 % del ciclo)
    age = ((night - KNOWN_NEW).total_seconds() / 86400) % MOON_CYCLE
    fraction = age / MOON_CYCLE
    assert fraction < 0.03 or fraction >= 0.97, f'la fecha no es luna nueva ({fraction:.3f})'
    illumination = round(50 - 50 * math.cos(2 * math.pi * age / MOON_CYCLE))
    return night, illumination


CAPTURE_TIME, MOON_ILLUMINATION = new_moon_night()


def server_is_up():
    try:
        with urllib.request.urlopen(BASE_URL, timeout=5) as res:
            return res.status == 200
    except OSError:
        return False


def open_app(browser, theme, viewport, scale, mobile=False):
    """Contexto nuevo con datos fijos y la app cargada. Devuelve la página."""
    context = browser.new_context(
        viewport=viewport,
        device_scale_factor=scale,
        is_mobile=mobile,
        has_touch=mobile,
        color_scheme=theme,
        reduced_motion='reduce',
        locale='es-CO',
        geolocation=FAKE_LOCATION,
        permissions=['geolocation'],
        service_workers='block',
    )
    context.route(WEATHER_API, lambda route: route.fulfill(
        status=200, content_type='application/json', body=json.dumps(FAKE_WEATHER),
        headers={'Access-Control-Allow-Origin': '*'}))
    context.clock.install(time=CAPTURE_TIME)
    context.clock.resume()  # el reloj avanza desde CAPTURE_TIME (ver docstring)
    context.add_init_script(INIT_SCRIPT
                            .replace('%THEME%', json.dumps(theme))
                            .replace('%RECENT%', json.dumps(json.dumps(RECENT_SEARCHES))))
    page = context.new_page()
    page.goto(BASE_URL)
    page.wait_for_selector('#app-loader', state='detached', timeout=20000)
    page.wait_for_function('window.__captureMap !== undefined')
    page.evaluate('document.fonts.ready.then(() => true)')
    settle(page, 1200)
    return page


def settle(page, extra_ms=700):
    """Espera a que la red quede quieta, a que cada tesela visible termine
    de cargar (networkidle solo no basta: las de OpenWeatherMap llegan
    tarde) y una pausa corta."""
    try:
        page.wait_for_load_state('networkidle', timeout=15000)
    except PlaywrightTimeout:
        pass  # alguna petición lenta: se sigue tras la espera de teselas
    try:
        # Leaflet marca con leaflet-tile-loaded cada tesela ya pintada
        page.wait_for_function("""() => [...document.querySelectorAll('#map img.leaflet-tile')]
            .every(t => t.classList.contains('leaflet-tile-loaded'))""", timeout=15000)
    except PlaywrightTimeout:
        print('  ! algunas teselas no terminaron de cargar a tiempo')
    page.wait_for_timeout(extra_ms)


def rect_of(page, selector):
    """Rectángulo del primer elemento visible que coincide."""
    return rects_of(page, selector)[0]


def rects_of(page, selector):
    """Rectángulos de TODOS los elementos visibles que coinciden."""
    return page.eval_on_selector_all(selector, """els => els
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ x: r.left, y: r.top, width: r.width, height: r.height }))""")


def union_clip(page, selectors, pad=0, within=None):
    """Recorte que abarca todos los elementos de todos los selectores, con
    `pad` px de aire. `within` (selector) lo limita a ese elemento: p. ej.
    el header, para que el aire sea su propio fondo y no el mapa."""
    rects = [r for s in selectors for r in rects_of(page, s)]
    vp = page.viewport_size
    bx0, by0, bx1, by1 = 0, 0, vp['width'], vp['height']
    if within:
        b = rect_of(page, within)
        bx0, by0, bx1, by1 = b['x'], b['y'], b['x'] + b['width'], b['y'] + b['height']
    x0 = max(bx0, min(r['x'] for r in rects) - pad)
    y0 = max(by0, min(r['y'] for r in rects) - pad)
    x1 = min(bx1, max(r['x'] + r['width'] for r in rects) + pad)
    y1 = min(by1, max(r['y'] + r['height'] for r in rects) + pad)
    return {'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0}


def only_controls(page, *keep):
    """Oculta (visibility, sin mover nada) los controles del header que no
    están en `keep`, para que el aire del recorte no muestre trozos de los
    botones vecinos. Sin argumentos los vuelve a mostrar todos."""
    # Sin transición: .icon-btn anima "all" y la visibilidad cambiaría
    # después de la captura
    page.evaluate("""keep => document.querySelectorAll('.header-controls > *').forEach(el => {
        const hide = keep.length && !keep.some(s => el.matches(s));
        el.style.transition = hide ? 'none' : '';
        el.style.visibility = hide ? 'hidden' : '';
    })""", list(keep))


def map_clip(page, height, bottom=None):
    """Recorte de mapa de 800 px de ancho (toda la ventana de MAP_VIEWPORT).
    Por defecto desde el borde superior del mapa; con `bottom`, termina ahí."""
    m = rect_of(page, '#map')
    top = m['y'] if bottom is None else bottom - height
    return {'x': m['x'], 'y': top, 'width': m['width'], 'height': height}


def place(page, lat, lng, zoom, px=None, py=None):
    """Lleva el punto (lat, lng) al píxel (px, py) del mapa (por defecto, su centro)."""
    page.evaluate("""([lat, lng, zoom, px, py]) => {
        const m = window.__captureMap;
        const size = m.getSize();
        const at = L.point(px ?? size.x / 2, py ?? size.y / 2);
        const target = m.project([lat, lng], zoom);
        const center = m.unproject(target.subtract(at.subtract(size.divideBy(2))), zoom);
        m.setView(center, zoom, { animate: false });
    }""", [lat, lng, zoom, px, py])
    settle(page)


def fit_markers(page, top, bottom, side=24, max_zoom=6):
    """Encuadra todos los marcadores del catálogo dejando `top` px libres
    arriba (el pin mide 40 px sobre su coordenada) y `bottom` abajo."""
    page.evaluate("""([top, bottom, side, maxZoom]) => {
        const m = window.__captureMap;
        const pts = [];
        m.eachLayer(l => { if (l instanceof L.Marker && l.options.title) pts.push(l.getLatLng()); });
        m.fitBounds(L.latLngBounds(pts), {
          paddingTopLeft: [side, top], paddingBottomRight: [side, bottom],
          maxZoom, animate: false,
        });
    }""", [top, bottom, side, max_zoom])
    settle(page)


def set_layers(page, base, overlay):
    """base: 'map' | 'satellite'; overlay: 'light' | 'clouds' | None."""
    page.click(f'.layer-btn[data-id="{base}"]')
    active = page.eval_on_selector_all(
        '.layer-group .layer-btn.active', 'els => els.map(e => e.dataset.id)')
    current = next((i for i in active if i in ('light', 'clouds')), None)
    if overlay != current:
        target = overlay or current  # pulsar el activo lo apaga
        btn = page.locator(f'.layer-btn[data-id="{target}"]')
        if btn.is_disabled():
            print(f'  ! capa "{target}" deshabilitada: la captura la mostrará así')
        else:
            btn.click()
    settle(page, 900)


def open_spot(page, name, tap=False):
    """Abre el panel de un sitio del catálogo y espera a que termine el análisis."""
    marker = page.locator(f'.spot-marker[title="{name}"]')
    marker.tap() if tap else marker.click()
    page.wait_for_function("""() =>
        !document.getElementById('gauge-percent').hidden &&
        !document.querySelector('.condition-card.is-loading')""", timeout=20000)
    settle(page, 900)


def close_panel(page):
    if page.locator('#side-panel.open').count():
        page.click('#panel-close')
        page.wait_for_timeout(500)


def record_steps(page, name, clip, found):
    """Posición en % sobre el recorte de cada marcador numerado de `name`."""
    if name not in STEP_TARGETS or name in found:
        return
    points = []
    for selector, index, fx, fy, dx, dy in STEP_TARGETS[name]:
        r = rects_of(page, selector)[index]
        points.append((round((r['x'] + fx * r['width'] + dx - clip['x']) / clip['width'] * 100, 1),
                       round((r['y'] + fy * r['height'] + dy - clip['y']) / clip['height'] * 100, 1)))
    found[name] = points


def check_steps(found, update=False):
    """Compara las posiciones calculadas con las de partials/guide.html y,
    con `update`, reescribe las que no coinciden."""
    html = GUIDE_HTML.read_text(encoding='utf8')
    changed = False
    print('\nMarcadores numerados (partials/guide.html):')
    for name, points in found.items():
        block = re.search(rf'data-shot="{name}"(.*?)</div>', html, re.S)
        current = re.findall(r'left: ([\d.]+)%; top: ([\d.]+)%', block.group(1)) if block else []
        current = [(float(x), float(y)) for x, y in current]
        ok = len(current) == len(points) and all(
            abs(cx - x) <= STEP_TOLERANCE and abs(cy - y) <= STEP_TOLERANCE
            for (cx, cy), (x, y) in zip(current, points))
        if ok:
            print(f'  {name:12s} OK')
        elif update and block and len(current) == len(points):
            values = iter(points)
            fixed = re.sub(r'left: [\d.]+%; top: [\d.]+%',
                           lambda _: 'left: {}%; top: {}%'.format(*next(values)), block.group(0))
            html = html.replace(block.group(0), fixed)
            changed = True
            print(f'  {name:12s} actualizado')
        else:
            print(f'  ! {name:10s} actualizar a: ' +
                  '  '.join(f'{n}) left: {x}%; top: {y}%' for n, (x, y) in enumerate(points, 1)))
    if changed:
        GUIDE_HTML.write_text(html, encoding='utf8')


class Results:
    """Guarda las capturas en WebP y lleva la cuenta para el informe final."""

    def __init__(self, quality):
        self.quality = quality
        self.rows = []  # (archivo, bytes, ancho, alto)

    def save(self, png_bytes, filename):
        img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
        return self.save_image(img, filename)

    def save_image(self, img, filename):
        """Imagen PIL → WebP de máx. MAX_WIDTH px de ancho."""
        if img.width > MAX_WIDTH:
            img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)), Image.LANCZOS)
        path = OUT_DIR / filename
        img.save(path, 'WEBP', quality=self.quality, method=6)
        size = path.stat().st_size
        self.rows.append((filename, size, img.width, img.height))
        print(f'  {filename:32s} {img.width:4d}x{img.height:<5d} {size / 1024:6.1f} KB')
        return size

    def report(self):
        total = sum(r[1] for r in self.rows)
        print(f'\n{"Archivo":32s} {"Tamaño":>9s}  Dimensiones')
        for name, size, w, h in sorted(self.rows):
            print(f'{name:32s} {size / 1024:7.1f} KB  {w}x{h}')
        status = 'OK' if total <= TARGET_BYTES else 'SUPERA el objetivo'
        print(f'\n{len(self.rows)} imágenes, peso total: {total / 1024 / 1024:.2f} MB '
              f'(objetivo < 1,5 MB) — {status}')


# ── Capturas ───────────────────────────────────────────────────

def capture_map_shots(browser, theme, out):
    """Capturas de mapa: densidad 1, ventana de 800 px de ancho."""
    page = open_app(browser, theme, MAP_VIEWPORT, 1)
    shot = lambda clip, name: out.save(page.screenshot(clip=clip), f'{name}-{theme}.webp')
    map_rect = rect_of(page, '#map')
    sel = rect_of(page, '.layer-switcher')
    switcher_top = sel['y'] - map_rect['y']  # dentro del mapa

    # 1. Mapa general (estado inicial: Mapa + Contaminación). Todos los
    #    marcadores enteros: 24 px de aire sobre el pin más alto (que mide
    #    40 px) y por encima del selector de capas
    fit_markers(page, top=24 + 40, bottom=map_rect['height'] - switcher_top + 24)
    shot(map_clip(page, map_rect['height']), 'mapa')

    # 2. Selector de capas: mismo encuadre (zoom 8, Bogotá–Medellín) para
    #    las cuatro, recortado de forma que entre el selector abajo
    clip = map_clip(page, CLIP_H, bottom=sel['y'] + sel['height'] + 16)
    place(page, *LAYERS_CENTER, LAYERS_ZOOM, map_rect['width'] / 2,
          clip['y'] + CLIP_H / 2 - map_rect['y'])  # centro del recorte
    for name, base, overlay in (('capas-mapa', 'map', None),
                                ('capas-satelite', 'satellite', None),
                                ('capas-contaminacion', 'map', 'light'),
                                ('capas-nubosidad', 'map', 'clouds')):
        set_layers(page, base, overlay)
        shot(clip, name)

    # 3. Marcadores del catálogo (solo el mapa base), con el nombre de uno
    #    visible como al pasar el mouse
    set_layers(page, 'map', None)
    place(page, *MARKERS_CENTER, MARKERS_ZOOM, map_rect['width'] / 2, CLIP_H / 2)
    page.hover('.spot-marker[title="Villa de Leyva"]')
    page.wait_for_selector('.gis-tooltip', timeout=5000)
    page.wait_for_timeout(300)
    shot(map_clip(page, CLIP_H), 'marcadores')
    page.mouse.move(5, map_rect['y'] + 5)

    # 4. Mi ubicación: punto azul en Tunja (zoom 12, sin marcadores cerca)
    page.click('#geolocate-btn')
    page.wait_for_selector('.locate-dot', timeout=15000)
    settle(page)
    close_panel(page)
    place(page, FAKE_LOCATION['latitude'], FAKE_LOCATION['longitude'], LOCATE_ZOOM,
          map_rect['width'] / 2, 210)
    shot(map_clip(page, 420), 'ubicacion')

    # 5. Pin rojo tras elegir un resultado del buscador (con su panel abierto)
    page.fill('#search-input', 'Paipa')
    page.wait_for_selector(RESULT_ITEM, timeout=15000)
    page.click(RESULT_ITEM)
    page.wait_for_selector('.search-pin', timeout=10000)
    page.wait_for_function("!document.querySelector('.condition-card.is-loading')", timeout=20000)
    settle(page, 1500)  # el vuelo de openPanel dura 1,2 s
    shot(map_clip(page, map_rect['height']), 'pin')

    page.context.close()


def capture_ui_shots(browser, theme, out, steps):
    """Capturas de interfaz: densidad 2, reducidas a 800 px de ancho como máximo.
    Anota en `steps` la posición de los marcadores numerados. Devuelve el
    PNG del header para componer tema.webp."""
    page = open_app(browser, theme, UI_VIEWPORT, UI_SCALE)

    def shot(clip, name):
        record_steps(page, name, clip, steps)
        out.save(page.screenshot(clip=clip), f'{name}-{theme}.webp')

    # 1. Búsquedas recientes: campo vacío y enfocado (historial precargado)
    only_controls(page, '.search-wrapper')
    page.focus('#search-input')
    page.wait_for_selector('#search-results .search-item-recent', timeout=5000)
    page.wait_for_timeout(300)
    shot(union_clip(page, ['.search-wrapper', '#search-results'], pad=12), 'recientes')

    # 2. Buscador con resultados
    page.fill('#search-input', 'Villa de Leyva')
    page.wait_for_selector(RESULT_ITEM, timeout=15000)
    page.wait_for_timeout(400)
    shot(union_clip(page, ['.search-wrapper', '#search-results'], pad=12), 'buscador')
    page.keyboard.press('Escape')
    page.fill('#search-input', '')
    page.locator('#search-input').blur()
    only_controls(page)

    # 3. Panel de un sitio del catálogo. Ventana alta para que entre
    #    completo, sin scroll; se recorta al final de su contenido
    place(page, *PANEL_VIEW)
    open_spot(page, 'Villa de Leyva')
    page.set_viewport_size(TALL_VIEWPORT)
    page.wait_for_timeout(500)
    overflow = page.evaluate("(() => { const p = document.getElementById('side-panel'); "
                             "return p.scrollHeight - p.clientHeight; })()")
    if overflow > 0:
        print(f'  ! el panel no entra completo ({overflow}px de más): sube TALL_VIEWPORT')
    panel = rect_of(page, '#side-panel')
    last = rects_of(page, '#side-panel > :not([hidden])')[-1]
    bottom = last['y'] + last['height'] + 32  # padding inferior del panel
    shot({'x': panel['x'], 'y': panel['y'], 'width': panel['width'], 'height': bottom - panel['y']}, 'panel')

    # 4. Secciones del panel con 16 px de su propio fondo alrededor. Antes,
    #    ningún hijo debe salirse por la derecha (se cortaría en el recorte)
    for name, selector in (('condiciones', '#side-panel .panel-section >> nth=0'),
                           ('simulador', '#side-panel .panel-section >> nth=1'),
                           ('ficha', '#spot-info-section')):
        section = page.locator(selector)
        spill = section.evaluate("""s => { const r = s.getBoundingClientRect().right;
            return [...s.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > r + 0.5)
              .map(e => e.className || e.tagName); }""")
        if spill:
            print(f'  ! en "{name}" se salen por la derecha: {spill}')
        box = section.bounding_box()
        shot({'x': box['x'] - 16, 'y': box['y'] - 16,
              'width': box['width'] + 32, 'height': box['height'] + 32}, name)
    close_panel(page)
    page.set_viewport_size(UI_VIEWPORT)
    page.wait_for_timeout(300)

    # 5. Header completo en una ventana más angosta (para tema.webp)
    page.set_viewport_size(HEADER_VIEWPORT)
    page.wait_for_timeout(400)
    header_png = page.locator('.app-header').screenshot()
    page.set_viewport_size(UI_VIEWPORT)
    page.wait_for_timeout(300)

    # 6. Botón de la guía y bloque derecho del header ("?" → instalar), con
    #    el fondo del header como marco. El botón instalar solo aparece
    #    cuando el navegador ofrece instalar: se muestra a la fuerza
    only_controls(page, '#guide-btn')
    shot(union_clip(page, ['#guide-btn'], pad=12, within='.app-header'), 'guia-boton')
    page.evaluate("document.getElementById('install-btn').hidden = false")
    only_controls(page, '#guide-btn', '#theme-btn', '#install-btn')
    shot(union_clip(page, ['#guide-btn', '#install-btn'], pad=12, within='.app-header'), 'instalar')

    page.context.close()
    return header_png


def capture_mobile_shot(browser, theme, out):
    """Celular: panel como bottom-sheet con el selector de capas encima."""
    page = open_app(browser, theme, MOBILE_VIEWPORT, UI_SCALE, mobile=True)
    place(page, 5.6333, -73.5250, 8)
    open_spot(page, 'Villa de Leyva', tap=True)
    out.save(page.screenshot(), f'movil-{theme}.webp')
    page.context.close()


def compose_theme(headers, out):
    """tema.webp: el header en oscuro sobre el header en claro."""
    imgs = [Image.open(io.BytesIO(headers[t])).convert('RGB') for t in ('dark', 'light')]
    canvas = Image.new('RGB', (max(i.width for i in imgs), sum(i.height for i in imgs)))
    canvas.paste(imgs[0], (0, 0))
    canvas.paste(imgs[1], (0, imgs[0].height))
    out.save_image(canvas, 'tema.webp')


def main():
    parser = argparse.ArgumentParser(description='Capturas para la Guía de uso (RF13)')
    parser.add_argument('--channel', default='chrome',
                        help='navegador: "chrome" (instalado, por defecto) o "chromium" (de Playwright)')
    parser.add_argument('--quality', type=int, default=75, help='calidad WebP (0-100)')
    parser.add_argument('--actualizar-marcadores', action='store_true',
                        help='escribir en partials/guide.html las posiciones de los marcadores numerados')
    args = parser.parse_args()

    if not server_is_up():
        sys.exit(f'No responde {BASE_URL}. Levanta el servidor con: python -m http.server 8080')
    if not (ROOT / 'js' / 'config.js').exists():
        print('AVISO: js/config.js no existe; las capas de contaminación y nubosidad '
              'saldrán deshabilitadas en las capturas.')
    print(f'Fecha simulada: {CAPTURE_TIME:%Y-%m-%d %H:%M} (Colombia), luna {MOON_ILLUMINATION} % iluminada')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = Results(args.quality)
    headers = {}
    steps = {}
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel=None if args.channel == 'chromium' else args.channel)
        except PlaywrightError as err:
            sys.exit(f'No se pudo abrir el navegador ({args.channel}): {err}\n'
                     'Prueba con --channel chromium tras: python -m playwright install chromium')
        for theme in ('dark', 'light'):
            print(f'\nTema {"oscuro" if theme == "dark" else "claro"}:')
            capture_map_shots(browser, theme, out)
            headers[theme] = capture_ui_shots(browser, theme, out, steps)
            capture_mobile_shot(browser, theme, out)
        print('\nAmbos temas:')
        compose_theme(headers, out)
        browser.close()

    out.report()
    check_steps(steps, update=args.actualizar_marcadores)


if __name__ == '__main__':
    main()
