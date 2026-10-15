/**
 * app.js — Coordinador principal
 *
 * Importa todos los módulos y los conecta entre sí.
 * Es el único archivo cargado desde index.html.
 * El orden de inicialización importa:
 *   1. Config (API key, si existe)
 *   2. Mapa (base de todo)
 *   3. Marcadores (necesitan el mapa listo)
 *   4. Buscador (necesita el mapa listo)
 *   5. Predictor (necesita mapa + marcadores)
 *   6. Simulador (necesita el predictor)
 *   7. Instalación PWA + tema claro/oscuro (independientes del resto)
 */

import { initMap }       from './map.js';
import { initMarkers }   from './markers.js';
import { initSearch }    from './search.js';
import { initLocate }    from './locate.js';
import { initPredictor } from './predictor.js';
import { initSimulator } from './simulator.js';
import { initInstall }   from './install.js';
import { initTheme }     from './theme.js';

// ── Registrar Service Worker ───────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => console.log('[GIS] SW registrado:', reg.scope))
      .catch((err) => console.warn('[GIS] SW no registrado:', err));
  });
}

/**
 * Resuelve las credenciales/URLs sensibles desde js/config.js (RNF07):
 * la API key de OpenWeatherMap y la URL de teselas de Google Earth Engine
 * (capa de contaminación lumínica).
 *
 * Usa import() DINÁMICO a propósito: en un checkout local sin el paso
 * manual de copiar js/config.example.js → js/config.js, ese archivo no
 * existe. Un `import` ESTÁTICO fallaría al resolver el grafo de módulos
 * de forma NO capturable con try/catch, y tumbaría el arranque completo
 * de la app (mapa en blanco, sin ningún mensaje). El import dinámico sí
 * es capturable, así que la ausencia de config.js simplemente activa el
 * modo demo ya existente (sin clima real y sin capa lumínica).
 */
async function resolveConfig() {
  try {
    const { OWM_API_KEY, GEE_TILE_URL } = await import('./config.js');
    return { owmApiKey: OWM_API_KEY || '', geeTileUrl: GEE_TILE_URL || '' };
  } catch {
    console.warn('[GIS] js/config.js no encontrado — modo demo activado (ver README).');
    return { owmApiKey: '', geeTileUrl: '' };
  }
}

// ── Arranque de la aplicación ──────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const { owmApiKey, geeTileUrl } = await resolveConfig();

  // 1. Inicializar mapa
  const map = initMap(owmApiKey, geeTileUrl);

  // 2. Cargar marcadores de astroturismo sobre el mapa
  await initMarkers(map);

  // 3. Inicializar buscador (Nominatim) y "Mi ubicación"
  initSearch(map);
  initLocate(map);

  // 4. Inicializar motor predictivo (OpenWeatherMap + Bortle API)
  initPredictor(owmApiKey);

  // 5. Inicializar simulador de sliders
  initSimulator();

  // 6. Instalación PWA (RF08) y tema claro/oscuro (RF09)
  initInstall();
  initTheme();

  // 7. Quitar loader inicial
  const loader = document.getElementById('app-loader');
  if (loader) {
    setTimeout(() => {
      loader.classList.add('hidden');
      setTimeout(() => loader.remove(), 500);
    }, 900);
  }
});
