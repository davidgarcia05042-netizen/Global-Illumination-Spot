# Global Illumination Spot 🌑

Sistema de análisis de contaminación lumínica y astroturismo en Colombia.

## Estructura del proyecto

```
global-illumination-spot/
├── index.html          → Página única (SPA shell) — toda la estructura HTML
├── manifest.json       → Configuración PWA (nombre, iconos, colores)
├── sw.js               → Service Worker — caché offline y estrategias de red
├── netlify.toml        → Build command que genera js/config.js en Netlify
├── .gitignore          → Excluye js/config.js (contiene credenciales/URLs reales)
├── css/
│   └── styles.css      → Paleta de colores, tipografía, diseño completo,
│                          incluye el tema del modo de observación nocturna
├── js/
│   ├── app.js           → Coordinador principal — importa y conecta todos los módulos
│   ├── map.js            → Mapa Leaflet, capa lumínica, panel lateral, gauge, toasts
│   ├── markers.js        → Carga spots.json y pinta marcadores en el mapa
│   ├── search.js         → Buscador de ubicaciones via Nominatim (OpenStreetMap)
│   ├── predictor.js       → Algoritmo predictivo: Bortle + clima + luna → % éxito
│   ├── simulator.js       → Sliders interactivos para simular condiciones
│   ├── install.js         → Captura beforeinstallprompt y el botón de instalación
│   ├── nightmode.js       → Alterna el modo de observación nocturna (paleta roja)
│   ├── config.example.js  → Plantilla de configuración (commiteada)
│   └── config.js          → Configuración real con tu API key (NO se commitea)
├── data/
│   └── spots.json      → Catálogo de nodos de astroturismo en Colombia
├── scripts/
│   └── generate_icons.py → Genera los PNG de assets/icons/ (Python + Pillow)
└── assets/
    └── icons/          → Íconos PWA (generados por scripts/generate_icons.py)
```

## Configuración antes de desplegar

### 1. Credenciales y URLs sensibles (RNF07 — nunca en texto plano en el repo)

Dos valores **no se hardcodean** en el código: la API key de OpenWeatherMap
y la URL de teselas de Google Earth Engine (capa de contaminación
lumínica). Ambos se inyectan en `js/config.js`, un archivo que el
repositorio ignora explícitamente (ver `.gitignore`). Si `js/config.js` no
existe, o algún valor viene vacío, la aplicación degrada con elegancia en
vez de romperse:
- Sin `OWM_API_KEY` → clima simulado (modo demo) y capa de nubosidad deshabilitada.
- Sin `GEE_TILE_URL` → capa de contaminación lumínica deshabilitada; el resto del mapa funciona normal.

**Desarrollo local:**
1. Copiar `js/config.example.js` como `js/config.js`
2. Rellenar los valores que tengas:
   - `OWM_API_KEY`: cuenta gratuita en https://openweathermap.org/api
   - `GEE_TILE_URL`: ver "Regenerar la capa de contaminación lumínica (VIIRS)" más abajo

**Producción en Netlify** (recomendado — ver sección de despliegue):
1. En Netlify → Site settings → Environment variables, definir `OWM_API_KEY`
   y `GEE_TILE_URL` con tus valores reales.
2. El build command definido en `netlify.toml` genera `js/config.js`
   automáticamente en cada despliegue a partir de esas variables. Esto
   **requiere que el sitio esté conectado al repositorio por Git** — el
   despliegue por arrastre de carpeta no ejecuta ningún build command y
   dejaría la app en modo demo.

> Nota de transparencia: al ser una PWA 100% cliente sin backend propio,
> estos valores siguen siendo técnicamente visibles en el JavaScript
> servido al navegador (cualquier usuario técnico puede inspeccionarlos).
> Lo que este mecanismo evita es que queden en texto plano en el control
> de versiones. La protección real frente a abuso de la API key se
> configura como restricción de dominio/referrer en el panel de
> OpenWeatherMap (ver RNF07 en el ERS).

### 2. Regenerar la capa de contaminación lumínica (VIIRS)

La URL de `GEE_TILE_URL` proviene de un "Map ID" de Google Earth Engine, que
no está garantizado como permanente indefinidamente (ya expiró una vez).
Si la capa deja de cargar (verás un aviso en la app, no se rompe nada más),
regenera la URL así:

1. Abrir https://code.earthengine.google.com con tu cuenta de Earth Engine
2. Pegar y ejecutar:
   ```javascript
   var year = 2024; // año más reciente disponible del compuesto anual
   var start = ee.Date.fromYMD(year, 1, 1);
   var end = start.advance(1, 'year');

   var viirs = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
     .filterDate(start, end)
     .select('avg_rad')
     .mean();

   var visParams = {
     min: 0,
     max: 60,
     palette: [
       '000000', '0b132b', '1c2541', '3a506b', '5bc0be',
       'ffd60a', 'ff9f1c', 'f25c05', 'd90429', 'ffffff'
     ]
   };

   var colombia = ee.FeatureCollection('FAO/GAUL/2015/level0')
     .filter(ee.Filter.eq('ADM0_NAME', 'Colombia'));
   var viirsClipped = viirs.clip(colombia);

   Map.centerObject(colombia, 6);
   Map.addLayer(viirsClipped, visParams, 'VIIRS ' + year);

   var mapId = viirsClipped.getMapId(visParams);
   print('Tile URL template:', mapId.urlFormat);
   ```
3. Copiar el `urlFormat` impreso en la consola (debe terminar literalmente
   en `.../tiles/{z}/{x}/{y}`) y actualizar `GEE_TILE_URL` en `js/config.js`
   (local) y en la variable de entorno de Netlify (producción).

### 3. Íconos PWA

Ya vienen generados en `assets/icons/` con un script propio (no hace falta
ningún servicio externo). Para regenerarlos si cambia el branding:

```
python scripts/generate_icons.py
```

Requiere Python 3 y Pillow (`pip install pillow`). Genera `icon-192.png`,
`icon-512.png` (maskable), `apple-touch-icon.png` y `favicon-32.png`.

## Despliegue

### Opción A — Netlify conectado por Git (recomendado)

1. Subir el proyecto a un repositorio Git (GitHub/GitLab/Bitbucket)
2. En Netlify: "Add new site" → "Import an existing project" → conectar el repo
3. Definir las variables de entorno `OWM_API_KEY` y `GEE_TILE_URL` (ver sección anterior)
4. Netlify detecta `netlify.toml`, ejecuta el build command y publica con HTTPS automático

> El despliegue por arrastre de carpeta ("Deploys" → drag & drop) también
> funciona, pero **no ejecuta el build command**: la app quedará en modo
> demo hasta que subas manualmente un `js/config.js` con tu key.

### Opción B — GitHub Pages

1. Subir el proyecto a un repositorio GitHub
2. Ir a Settings → Pages
3. Seleccionar la rama `main` como fuente
4. El sitio queda disponible en `https://usuario.github.io/repositorio`
5. Para tener clima real, subir manualmente un `js/config.js` con tu key
   (ideal: generarlo en un GitHub Action a partir de un Secret, análogo al
   build command de Netlify)

> **Importante:** El Service Worker y las funciones PWA requieren HTTPS
> obligatorio. Ambas opciones lo proveen automáticamente. Todas las rutas
> del proyecto son relativas, así que funciona igual en la raíz de un
> dominio o en un subpath como el de GitHub Pages.

## Agregar nuevos sitios de observación

Editar `data/spots.json` y agregar un objeto con este formato:

```json
{
  "id": "id-unico-001",
  "name": "Nombre del lugar",
  "region": "Departamento, Colombia",
  "coordinates": { "lat": 0.0000, "lng": -75.0000 },
  "altitude_m": 1000,
  "bortle_index": 4,
  "bortle_source": "World Atlas",
  "is_functional": true,
  "observation_types": ["visual", "fotografía"],
  "infrastructure": {
    "observatory": false,
    "camping": true,
    "accessibility": "Media"
  },
  "best_months": [12, 1, 2],
  "description": "Descripción del sitio."
}
```

Valores de `bortle_index`:
| Valor | Descripción |
|---|---|
| 1–2 | Cielo negro excepcional |
| 3–4 | Rural verdadero — óptimo para observación |
| 5–6 | Suburbano — aceptable |
| 7–8 | Urbano — solo educativo |
| 9 | Urbano intenso — no funcional |

## Escala de colores de contaminación lumínica

La capa superpuesta en el mapa usa un compuesto **histórico anual** (no en
tiempo real) del dataset VIIRS/NASA vía Google Earth Engine:
- **Negro/azul oscuro** → cielo muy oscuro (Bortle 1–3)
- **Verde/amarillo** → contaminación moderada (Bortle 4–6)
- **Naranja/rojo/blanco** → alta contaminación (Bortle 7–9)

## Algoritmo predictivo

```
Éxito (%) = (Bortle_factor × 40%) + (Nubes_factor × 40%) + (Luna_factor × 20%)

Bortle_factor = (9 - bortle) / 8 × 100   → Bortle 1 = 100%, Bortle 9 = 0%
Nubes_factor  = 100 - nubosidad_%         → 0% nubes = 100%, 100% nubes = 0%
Luna_factor   = 100 - (luna_% × 0.7)     → Luna nueva = 100%, Luna llena = 30%
```

| Resultado | Interpretación |
|---|---|
| ≥ 70% | ✦ Condiciones óptimas |
| 40–69% | ◑ Condiciones aceptables |
| < 40% | ✕ Condiciones desfavorables |

## Funciones adicionales (v2)

- **Instalación como app (RF08):** botón de instalación en el header
  (aparece cuando el navegador dispara `beforeinstallprompt`; en iOS
  Safari se muestra una instrucción manual una sola vez).
- **Modo de observación nocturna (RF09):** botón en el header que alterna
  una paleta roja de bajo brillo (preserva la visión nocturna en campo) y
  persiste la preferencia entre sesiones.
- **Manejo de errores (RF10):** avisos no técnicos cuando falla el clima,
  el buscador o las teselas del mapa, sin bloquear el resto de la interfaz.
- **Accesibilidad (RNF08):** navegación por teclado con foco visible,
  skip-link al mapa, etiquetas ARIA en controles e íconos, contraste AA.
