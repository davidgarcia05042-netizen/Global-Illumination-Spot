"""
generate_icons.py — Genera los íconos PWA de Global Illumination Spot.

Dibuja el motivo de "estrella de cuatro puntas" (✦, el mismo símbolo usado
como brand-icon en el header) como polígono vectorial en vez de renderizar
el glifo con una fuente del sistema, para que el resultado sea idéntico sin
importar qué fuentes tenga instaladas la máquina que ejecuta este script.

Genera en assets/icons/:
  icon-192.png          — maskable, con zona de seguridad del 20%
  icon-512.png          — maskable, con zona de seguridad del 20%
  apple-touch-icon.png  — 180x180, RGB opaco (iOS no soporta alfa aquí)
  favicon-32.png        — para la pestaña del navegador

Ejecutar con: python scripts/generate_icons.py
Requiere: Pillow (pip install pillow)
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BG_COLOR = (13, 27, 42, 255)      # --bg-deep: #0D1B2A
STAR_COLOR = (46, 134, 171, 255)  # --accent:  #2E86AB
STAR_GLOW = (46, 134, 171, 110)   # halo suave alrededor de la estrella

OUT_DIR = Path(__file__).resolve().parent.parent / 'assets' / 'icons'


def four_point_star(center, outer_r, inner_r, rotation_deg=0):
    """Vértices de una estrella de 4 puntas tipo sparkle (✦)."""
    cx, cy = center
    points = []
    for i in range(8):
        angle = math.radians(i * 45 + rotation_deg)
        r = outer_r if i % 2 == 0 else inner_r
        points.append((cx + r * math.sin(angle), cy - r * math.cos(angle)))
    return points


def draw_star_icon(size, safe_margin_ratio=0.0):
    """
    Ícono size x size con fondo sólido y la estrella centrada.
    safe_margin_ratio reduce el radio útil para dejar zona de seguridad en
    íconos "maskable" (el SO puede recortar hasta ~20% del borde exterior).
    """
    img = Image.new('RGBA', (size, size), BG_COLOR)
    cx = cy = size / 2
    max_r = (size / 2) * (1 - safe_margin_ratio)

    # Halo suave detrás de la estrella principal
    glow_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    glow_r = max_r * 0.85
    glow_draw.ellipse(
        [cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r],
        fill=STAR_GLOW,
    )
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=size * 0.06))
    img = Image.alpha_composite(img, glow_layer)

    draw = ImageDraw.Draw(img)

    # Estrella principal
    outer_r = max_r * 0.72
    inner_r = outer_r * 0.32
    draw.polygon(four_point_star((cx, cy), outer_r, inner_r), fill=STAR_COLOR)

    # Chispa satélite pequeña (el glifo ✦ real trae una mini estrella junto
    # a la principal) para dar más carácter de "sparkle" astronómico.
    small_cx, small_cy = cx + max_r * 0.50, cy - max_r * 0.42
    small_outer = outer_r * 0.28
    draw.polygon(
        four_point_star((small_cx, small_cy), small_outer, small_outer * 0.32),
        fill=STAR_COLOR,
    )

    return img


def save_flat_rgb(img, path):
    """Aplana sobre el fondo a RGB opaco (para apple-touch-icon, sin alfa)."""
    flat = Image.new('RGB', img.size, BG_COLOR[:3])
    flat.paste(img, mask=img.split()[3])
    flat.save(path)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    icon_192 = draw_star_icon(192, safe_margin_ratio=0.20)
    icon_192.save(OUT_DIR / 'icon-192.png')

    icon_512 = draw_star_icon(512, safe_margin_ratio=0.20)
    icon_512.save(OUT_DIR / 'icon-512.png')

    apple_icon = draw_star_icon(180, safe_margin_ratio=0.12)
    save_flat_rgb(apple_icon, OUT_DIR / 'apple-touch-icon.png')

    favicon = Image.new('RGBA', (32, 32), BG_COLOR)
    fdraw = ImageDraw.Draw(favicon)
    fdraw.polygon(four_point_star((16, 16), 12, 12 * 0.32), fill=STAR_COLOR)
    favicon.save(OUT_DIR / 'favicon-32.png')

    print(f'Iconos generados en {OUT_DIR}')


if __name__ == '__main__':
    main()
