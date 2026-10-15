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

Salida en assets/guide/<nombre>-dark.webp y <nombre>-light.webp
(máx. 800px de ancho, capturadas a 2x de densidad).

Notas:
  - La geolocalización se simula en Villa de Leyva con el permiso concedido:
    NUNCA se usa la ubicación real de quien ejecuta el script.
  - Si js/config.js no existe, las capas de contaminación y nubosidad
    salen deshabilitadas en las capturas (el script avisa).
  - Cada tema se captura en una sesión que arranca con ese tema guardado
    (gis-theme en localStorage), como haría un usuario: así cambian la
    interfaz Y el mapa base. Solo alternar html.light-theme dejaría la
    interfaz clara sobre el mapa oscuro.
  - Se emula prefers-reduced-motion: reduce para capturar estados finales
    (sin fotogramas a mitad de una animación).
"""

import argparse
import io
import sys
import urllib.request
from pathlib import Path

from PIL import Image
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE_URL = 'http://localhost:8080/'
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'assets' / 'guide'

# Villa de Leyva (Boyacá): ubicación simulada para las capturas
FAKE_LOCATION = {'latitude': 5.6333, 'longitude': -73.5250, 'accuracy': 80}
COLOMBIA = (4.2, -73.3)

VIEWPORT = {'width': 1280, 'height': 800}
SCALE = 2
MAX_WIDTH = 800
TARGET_BYTES = int(1.5 * 1024 * 1024)

# Antes de cargar la app: tema guardado y acceso a la instancia del mapa.
# Leaflet hace window.L = ...; al ocurrir, se registra un hook que guarda
# cada L.Map creado en window.__captureMap (solo para esta herramienta).
INIT_SCRIPT = """
try { localStorage.setItem('gis-theme', '%THEME%'); } catch (e) {}
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
// Los toasts son pasajeros: fuera de las capturas
document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = '.toast { visibility: hidden !important; }';
  document.head.appendChild(s);
});
"""


# ── Utilidades ─────────────────────────────────────────────────

def server_is_up():
    try:
        with urllib.request.urlopen(BASE_URL, timeout=5) as res:
            return res.status == 200
    except OSError:
        return False


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


def save_webp(png_bytes, name, theme, quality):
    """PNG → WebP de máx. MAX_WIDTH px de ancho. Devuelve el peso en bytes."""
    img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    if img.width > MAX_WIDTH:
        img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)), Image.LANCZOS)
    path = OUT_DIR / f'{name}-{theme}.webp'
    img.save(path, 'WEBP', quality=quality, method=6)
    size = path.stat().st_size
    print(f'  {path.relative_to(ROOT).as_posix():42s} {img.width}x{img.height}  {size / 1024:6.1f} KB')
    return size


def rect_of(page, selector):
    """Rectángulo del primer elemento que coincide."""
    return rects_of(page, selector)[0]


def rects_of(page, selector):
    """Rectángulos de TODOS los elementos visibles que coinciden."""
    return page.eval_on_selector_all(selector, """els => els
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ x: r.left, y: r.top, width: r.width, height: r.height }))""")


def union_clip(page, selectors, pad=0):
    """Recorte que abarca todos los elementos de todos los selectores."""
    rects = [r for s in selectors for r in rects_of(page, s)]
    x0 = max(0, min(r['x'] for r in rects) - pad)
    y0 = max(0, min(r['y'] for r in rects) - pad)
    x1 = min(VIEWPORT['width'], max(r['x'] + r['width'] for r in rects) + pad)
    y1 = min(VIEWPORT['height'], max(r['y'] + r['height'] for r in rects) + pad)
    return {'x': x0, 'y': y0, 'width': x1 - x0, 'height': y1 - y0}


def center_clip(cx, cy, width, height):
    x = min(max(0, cx - width / 2), VIEWPORT['width'] - width)
    y = min(max(0, cy - height / 2), VIEWPORT['height'] - height)
    return {'x': x, 'y': y, 'width': width, 'height': height}


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


def close_panel(page):
    if page.locator('#side-panel.open').count():
        page.click('#panel-close')
        page.wait_for_timeout(500)


# ── Capturas ───────────────────────────────────────────────────

def capture_theme(browser, theme, quality):
    print(f'\nTema {"oscuro" if theme == "dark" else "claro"}:')
    context = browser.new_context(
        viewport=VIEWPORT,
        device_scale_factor=SCALE,
        color_scheme=theme,
        reduced_motion='reduce',
        locale='es-CO',
        geolocation=FAKE_LOCATION,
        permissions=['geolocation'],
    )
    context.add_init_script(INIT_SCRIPT.replace('%THEME%', theme))
    page = context.new_page()
    page.goto(BASE_URL)
    page.wait_for_selector('#app-loader', state='detached', timeout=20000)
    page.wait_for_function('window.__captureMap !== undefined')
    settle(page, 1200)

    sizes = []
    shot = lambda png, name: sizes.append(save_webp(png, name, theme, quality))

    # 1. Mapa general (estado inicial: Mapa + Contaminación), recortado al
    #    centro (Colombia + selector de capas completo): el mapa entero
    #    reducido a 800px dejaba la interfaz diminuta
    map_rect = rect_of(page, '#map')
    place(page, *COLOMBIA, 6, map_rect['width'] / 2, map_rect['height'] / 2 - 40)
    shot(page.screenshot(clip={'x': (VIEWPORT['width'] - 800) / 2, 'y': map_rect['y'],
                               'width': 800, 'height': map_rect['height']}), 'mapa')

    # 2. Selector de capas, una captura por capa activa. Colombia (zoom 5)
    #    queda centrada sobre el selector y el recorte incluye ambos
    sel = rect_of(page, '.layer-switcher')
    clip = {'x': VIEWPORT['width'] / 2 - 330, 'y': sel['y'] - 430,
            'width': 660, 'height': sel['height'] + 442}
    place(page, *COLOMBIA, 5, map_rect['width'] / 2, (sel['y'] - 215) - map_rect['y'])
    for name, base, overlay in (('capas-mapa', 'map', None),
                                ('capas-satelite', 'satellite', None),
                                ('capas-contaminacion', 'map', 'light'),
                                ('capas-nubosidad', 'map', 'clouds')):
        set_layers(page, base, overlay)
        shot(page.screenshot(clip=clip), name)

    # 3. Marcadores del catálogo (solo el mapa base, sin capa encima)
    set_layers(page, 'map', None)
    place(page, 6.0, -74.6, 6)
    shot(page.screenshot(clip=union_clip(page, ['.spot-marker'], pad=48)), 'marcadores')

    # 4. Buscador con resultados
    page.fill('#search-input', 'Villa de Leyva')
    page.wait_for_selector('#search-results li', timeout=15000)
    page.wait_for_timeout(400)
    shot(page.screenshot(clip=union_clip(page, ['.search-wrapper', '#search-results'], pad=10)), 'buscador')
    page.keyboard.press('Escape')
    page.locator('#search-input').blur()

    # 5. Mi ubicación: punto azul (ubicación simulada en Villa de Leyva)
    page.click('#geolocate-btn')
    page.wait_for_selector('.locate-dot', timeout=15000)
    settle(page)
    close_panel(page)
    dot = rect_of(page, '.locate-dot')
    shot(page.screenshot(clip=center_clip(dot['x'] + dot['width'] / 2, dot['y'] + dot['height'] / 2, 520, 320)), 'ubicacion')

    # 6. Panel de un sitio del catálogo: completo, condiciones, simulador y ficha
    # Zoom 9: separa el marcador del punto azul simulado, que está a ~20 km
    place(page, 5.55, -73.45, 9)
    page.click('.spot-marker[title="Villa de Leyva"]')
    page.wait_for_function("""() =>
        !document.getElementById('gauge-percent').hidden &&
        !document.querySelector('.condition-card.is-loading')""", timeout=20000)
    settle(page, 900)
    shot(page.locator('#side-panel').screenshot(), 'panel')
    sections = page.locator('#side-panel .panel-section')
    shot(sections.nth(0).screenshot(), 'condiciones')
    shot(sections.nth(1).screenshot(), 'simulador')
    shot(page.locator('#spot-info-section').screenshot(), 'ficha')
    close_panel(page)

    # 7. Botón instalar: solo aparece cuando el navegador ofrece instalar,
    #    así que se muestra a la fuerza para la captura
    page.fill('#search-input', '')
    page.evaluate("document.getElementById('install-btn').hidden = false")
    # Desde el "?" (no desde ubicación, que sigue activa tras el paso 5)
    shot(page.screenshot(clip=union_clip(page, ['#guide-btn', '#install-btn'], pad=8)), 'instalar')

    context.close()
    return sum(sizes)


def main():
    parser = argparse.ArgumentParser(description='Capturas para la Guía de uso (RF13)')
    parser.add_argument('--channel', default='chrome',
                        help='navegador: "chrome" (instalado, por defecto) o "chromium" (de Playwright)')
    parser.add_argument('--quality', type=int, default=75, help='calidad WebP (0-100)')
    args = parser.parse_args()

    if not server_is_up():
        sys.exit(f'No responde {BASE_URL}. Levanta el servidor con: python -m http.server 8080')
    if not (ROOT / 'js' / 'config.js').exists():
        print('AVISO: js/config.js no existe; las capas de contaminación y nubosidad '
              'saldrán deshabilitadas en las capturas.')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel=None if args.channel == 'chromium' else args.channel)
        except PlaywrightError as err:
            sys.exit(f'No se pudo abrir el navegador ({args.channel}): {err}\n'
                     'Prueba con --channel chromium tras: python -m playwright install chromium')
        for theme in ('dark', 'light'):
            total += capture_theme(browser, theme, args.quality)
        browser.close()

    status = 'OK' if total <= TARGET_BYTES else 'SUPERA el objetivo'
    print(f'\nPeso total: {total / 1024 / 1024:.2f} MB (objetivo < 1,5 MB) — {status}')


if __name__ == '__main__':
    main()
