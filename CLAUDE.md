# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Proyecto

PWA 100 % cliente de astroturismo y contaminación lumínica en Colombia, desplegada en Netlify. Todo el proyecto (UI, comentarios, README, commits) está en **español**. Los comentarios citan requisitos del documento ERS (`RF01`, `RF08`, `RNF07`, …): conservar esas referencias al modificar el código asociado.

## Comandos

No hay bundler, dependencias npm, linter ni tests. Es HTML/CSS/JS estático con módulos ES.

```
python -m http.server 8080        # servir en local (file:// no funciona: módulos ES + Service Worker)
node --check js/<archivo>.js      # verificación rápida de sintaxis
python scripts/generate_icons.py  # regenerar assets/icons/ (requiere Pillow)
```

`.vscode/launch.json` lanza Chrome contra `http://localhost:8080`.

**Probar animaciones:** si Windows tiene apagados los "Efectos de animación", Chrome informa `prefers-reduced-motion: reduce` y la app desactiva todo el movimiento (comportamiento correcto). El panel Rendering de DevTools de algunas versiones solo ofrece emular `reduce`, no `no-preference`; para ver las animaciones sin tocar el sistema, abrir una ventana aparte:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%TEMP%\chrome-animaciones" --force-prefers-no-reduced-motion http://localhost:8080
```

El perfil aparte es necesario: el flag se ignora si Chrome ya está abierto con el perfil normal. Ese perfil limpio también evita la caché vieja del Service Worker.

## Configuración y secretos

- `js/config.js` (ignorado por git) exporta `OWM_API_KEY` y `GEE_TILE_URL`. En local se copia desde `js/config.example.js`; en Netlify lo genera el `command` de `netlify.toml` a partir de variables de entorno (solo si el sitio está conectado por Git).
- `app.js` lo carga con `import()` **dinámico** a propósito: si falta, la app entra en modo demo en vez de romper el grafo de módulos. No convertirlo en import estático.
- Sin `OWM_API_KEY`: clima aleatorio y capa de nubes deshabilitada. Sin `GEE_TILE_URL`: capa lumínica deshabilitada. Toda funcionalidad nueva que dependa de estos valores debe degradar igual.

## Arquitectura

- `index.html` es la única página; carga Leaflet 1.9.4 desde unpkg como global `L` (con SRI) y `js/app.js` como módulo, que inicializa el resto en orden: mapa → marcadores → buscador y ubicación (`locate.js`) → predictor → simulador → instalación/tema.
- `map.js` es el hub de UI: además del mapa y el selector de capas, exporta `openPanel`, `setGauge` y `showToast`, que usan los demás módulos.
- `openPanel(latlng, nombre, region, spot, { zoom, pin })` es quien mueve el mapa (con desplazamiento para que el punto no quede tapado por el panel). No llamar a `flyTo()` antes: el desplazamiento de `openPanel` cancelaría la animación. Para acercar, pasar `zoom`; `pin: true` pone el pin rojo de búsqueda, que se retira con cualquier otra apertura o al cerrar el panel.
- Los módulos se comunican por `CustomEvent` sobre `document`, no por llamadas directas:
  - `gis:predict` `{latlng, spot}` — lo emite `openPanel()` (clic en mapa, marcador, buscador o geolocalización); lo consume `predictor.js`.
  - `gis:conditions-loaded` `{clouds, moon, bortle, temp}` — lo emite el predictor; `simulator.js` sincroniza los sliders.
  - `gis:theme-change` `{theme}` — lo emite `theme.js`; `map.js` funde el mapa base con `crossfadeBase()`.
- `calculateSuccess()` en `predictor.js` es la fórmula única (Bortle 40 % + nubes 40 % + luna 20 %), compartida por el gauge real y el simulador. Umbrales 70/40 repetidos en `setGauge()` y `simulator.js`.
- Bortle: los spots de `data/spots.json` traen `bortle_index`; para cualquier otro punto se consulta lightpollutionmap.info, que hoy exige key y siempre cae al valor por defecto 5.
- Geocodificación: Nominatim (búsqueda en `search.js`; inversa con `reverseGeocode()` de `map.js`, usada por el clic en el mapa y por `locate.js`, que la cachea). Respetar su límite de 1 req/s (debounce de 500 ms).
- Búsquedas recientes: `search.js` guarda en `localStorage` (`gis-recent-searches`) el lugar ya resuelto `{name, region, lat, lng, zoom}` para no repetir la consulta; `loadRecent()` descarta entradas que no cumplan ese formato, así que cambiarlo no rompe historiales viejos.
- `locate.js` usa `watchPosition`: solo el primer fix abre el panel; las actualizaciones posteriores solo mueven el punto azul.
- Iconos: Lucide como SVG inline, sin CDN. Desde JS con `icon(nombre, size)` de `js/icons.js`; en `index.html` pegados directamente. Para uno nuevo, copiar el contenido del SVG oficial de `https://unpkg.com/lucide-static@<versión>/icons/<nombre>.svg` (no escribir paths de memoria; `circle-half` no existe, su equivalente es `contrast`). El ✦ de la marca y del loader es el logotipo: no reemplazarlo.
- Fundido entre capas (`map.js`): cada `L.tileLayer` lleva `className: 'gis-fade'` (transición CSS de `opacity`) y `setLayerOpacity()` anima vía `setOpacity()` de Leaflet. Cambiar de base siempre con `crossfadeBase(from, to)` y los overlays con `fadeInOverlay`/`fadeOutOverlay`, nunca con `addTo`/`removeLayer` directos: llevan el control de cambios interrumpidos (`desiredBase`, `fadeTokens`) y la limpieza de bases sobrantes. `FADE_MS` debe coincidir con `.gis-fade` en el CSS.
- Marcadores `L.divIcon`: Leaflet posiciona la raíz con `transform`, así que toda animación o transform (caída, hover) va en un **hijo** (`.spot-pin`), nunca en la raíz. Usar `animation-fill-mode: backwards` (no `both`) si después hace falta un `transform` en hover.
- Movimiento: todo CSS nuevo con movimiento se desactiva en `@media (prefers-reduced-motion: reduce)`, y las animaciones en JS consultan `REDUCED_MOTION` y saltan al estado final. Los bloques reduce que deben ganar a reglas declaradas antes con la misma especificidad van al final de `styles.css`.
- Tema: elección guardada del usuario > `prefers-color-scheme` del sistema > oscuro. `html.light-theme` redefine las variables CSS en `css/styles.css` (los colores de la UI deben salir de variables, no de valores fijos, para que el tema claro los cubra). Preferencia en `localStorage` (`gis-theme`); un script inline en `<head>` la aplica antes del primer pintado, y `theme.js` emite `gis:theme-change` para que `map.js` cambie el mapa base (Esri Gray Canvas Dark/Light).

## Service Worker (`sw.js`)

- Al agregar un archivo propio (JS, CSS, datos, iconos), añadirlo a `PRECACHE_ASSETS`.
- Cambiar `CACHE_NAME` en cada versión publicada; si no, los usuarios con la PWA instalada siguen con archivos viejos.
- Las listas `NETWORK_ONLY_HOSTS` y `TILE_HOSTS` se comparan con `hostname.includes()` y se evalúan en ese orden: un host genérico en la primera captura subdominios de la segunda.
- Si se cambia la versión de Leaflet, actualizar a la vez las URLs y los hashes `integrity` de `index.html` y las URLs precacheadas en `sw.js`.
- Todas las rutas son relativas (sin `/` inicial) para funcionar tanto en raíz de dominio como en subpath.
