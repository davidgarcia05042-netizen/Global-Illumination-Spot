/**
 * sw.js — Service Worker
 *
 * Estrategias de caché:
 *  - Assets propios (HTML, CSS, JS, JSON):  Cache-First con actualización en background
 *  - APIs externas (clima, geocodificación): Network-Only (siempre datos frescos)
 *  - Tiles de mapa y capa lumínica:         Network-First con fallback a caché
 *
 * La versión del caché (CACHE_NAME) debe cambiarse al hacer un redeploy
 * para que los usuarios reciban los archivos actualizados.
 *
 * Todas las rutas de precacheo son RELATIVAS (sin "/" inicial) para que el
 * sitio funcione igual si se despliega en la raíz de un dominio o en un
 * subpath (ej. GitHub Pages tipo usuario.github.io/repo/).
 */

const CACHE_NAME = 'gis-v2.3';

// Archivos críticos precargados en la instalación del SW.
// Estos estarán disponibles sin internet desde el primer uso.
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/icons.js',
  './js/map.js',
  './js/markers.js',
  './js/search.js',
  './js/locate.js',
  './js/predictor.js',
  './js/simulator.js',
  './js/install.js',
  './js/theme.js',
  './js/guide.js',
  './partials/guide.html',
  // Capturas de la guía de uso (RF13), para que se vea completa sin conexión
  './assets/guide/buscador-dark.webp',
  './assets/guide/buscador-light.webp',
  './assets/guide/capas-contaminacion-dark.webp',
  './assets/guide/capas-contaminacion-light.webp',
  './assets/guide/capas-mapa-dark.webp',
  './assets/guide/capas-mapa-light.webp',
  './assets/guide/capas-nubosidad-dark.webp',
  './assets/guide/capas-nubosidad-light.webp',
  './assets/guide/capas-satelite-dark.webp',
  './assets/guide/capas-satelite-light.webp',
  './assets/guide/condiciones-dark.webp',
  './assets/guide/condiciones-light.webp',
  './assets/guide/ficha-dark.webp',
  './assets/guide/ficha-light.webp',
  './assets/guide/guia-boton-dark.webp',
  './assets/guide/guia-boton-light.webp',
  './assets/guide/instalar-dark.webp',
  './assets/guide/instalar-light.webp',
  './assets/guide/mapa-dark.webp',
  './assets/guide/mapa-light.webp',
  './assets/guide/marcadores-dark.webp',
  './assets/guide/marcadores-light.webp',
  './assets/guide/movil-dark.webp',
  './assets/guide/movil-light.webp',
  './assets/guide/panel-dark.webp',
  './assets/guide/panel-light.webp',
  './assets/guide/pin-dark.webp',
  './assets/guide/pin-light.webp',
  './assets/guide/recientes-dark.webp',
  './assets/guide/recientes-light.webp',
  './assets/guide/simulador-dark.webp',
  './assets/guide/simulador-light.webp',
  './assets/guide/tema.webp',
  './assets/guide/ubicacion-dark.webp',
  './assets/guide/ubicacion-light.webp',
  './js/config.js',
  './data/spots.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  // Leaflet desde CDN: sin él la app no arranca offline. index.html lo
  // carga con crossorigin, así que la respuesta cacheada (CORS) es válida
  // para la verificación de integridad (SRI).
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Dominios de APIs externas: NUNCA cachear, siempre usar la red.
// Ojo: se compara con includes(), así que 'api.openweathermap.org' (y no
// 'openweathermap.org') para no capturar también las teselas de nubes.
const NETWORK_ONLY_HOSTS = [
  'api.openweathermap.org',
  'nominatim.openstreetmap.org',
  'lightpollutionmap.info',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// Dominios de teselas de mapa: Network-First con fallback a caché
const TILE_HOSTS = [
  'earthengine.googleapis.com',
  'tile.openweathermap.org',
  'server.arcgisonline.com',
];

// ── Instalación ───────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cachear cada recurso por separado: si uno falla (ej. js/config.js
      // no existe todavía en un checkout local sin build), el resto del
      // precacheo NO debe abortarse. cache.addAll() es todo-o-nada y
      // tumbaría el offline completo por un solo 404.
      Promise.all(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] No se pudo precachear', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// ── Activación: limpiar versiones anteriores ──────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => {
            console.log('[SW] Eliminando caché antigua:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: estrategia según el tipo de recurso ────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIs externas: nunca interceptar, dejar pasar a la red
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    return; // el navegador maneja la petición normalmente
  }

  // Tiles de mapas (base + overlays): Network-First
  // Si la red falla (zona rural sin señal), intenta la caché
  const isTile = TILE_HOSTS.some((host) => url.hostname.includes(host));

  if (isTile) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Las peticiones cross-origin de Leaflet llegan como respuestas
          // "opacas" (status 0, type 'opaque') porque el navegador oculta
          // los detalles entre orígenes distintos. Deben cachearse igual,
          // si no, esta rama nunca guarda nada realmente en caché.
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Assets propios (HTML, CSS, JS, JSON, iconos): Cache-First
  // Responde inmediatamente desde caché y actualiza en background
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      if (cached) {
        // Sin red, la actualización en background falla: no es un error real
        networkFetch.catch(() => {});
        return cached;
      }
      return networkFetch;
    })
  );
});
