/**
 * locate.js — "Mi ubicación" estilo Google Maps
 *
 * Responsabilidades:
 *  - Primer clic en el botón: pedir permiso, empezar a seguir la posición
 *    (watchPosition), volar hasta ella y abrir su ficha en el panel.
 *  - Mostrar un punto azul con halo pulsante y un círculo de precisión,
 *    que se actualizan solos mientras el usuario se mueve.
 *  - Clics siguientes: re-centrar el mapa en el punto (sin pedir de nuevo).
 *  - Sin permiso o sin señal: volar a Villa de Leyva y avisar (RF10).
 *
 * Solo el primer fix abre el panel; las actualizaciones posteriores
 * mueven el punto sin interrumpir lo que el usuario esté viendo.
 */

import { openPanel, showToast, reverseGeocode, DEFAULT_CENTER, DEFAULT_ZOOM } from './map.js';

const LOCATE_ZOOM = 12;
const MY_LOCATION = 'Mi ubicación';

let map            = null;
let btn            = null;
let watchId        = null;
let lastLatLng     = null;   // última posición conocida (null = aún sin fix)
let dot            = null;   // L.marker con el punto azul
let accuracyCircle = null;   // L.circle con el radio de precisión
let lastPlace      = null;   // { key, place } — evita repetir Nominatim al re-centrar

/**
 * @param {L.Map} mapInstance
 */
export function initLocate(mapInstance) {
  map = mapInstance;
  btn = document.getElementById('geolocate-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Geolocalización no disponible en este navegador');
      return;
    }
    if (lastLatLng) {      // ya hay posición: solo re-centrar
      showMyLocation();
      return;
    }
    if (watchId !== null) return; // esperando el primer fix

    btn.classList.add('locating');
    showToast('Buscando tu ubicación...');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000,
    });
  });
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const isFirstFix = !lastLatLng;
  lastLatLng = L.latLng(lat, lng);
  drawLocation(lastLatLng, accuracy);

  if (isFirstFix) {
    btn.classList.remove('locating');
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    btn.title = 'Centrar en mi ubicación';
    showMyLocation();
  }
}

function onError(err) {
  // Con una posición ya conocida, un fallo puntual (túnel, sin señal) no
  // merece aviso: se conserva el último punto y watchPosition reintenta.
  if (lastLatLng) return;

  stopTracking();
  map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 1.5 });
  const denied = err && err.code === err.PERMISSION_DENIED;
  showToast(
    denied
      ? 'Permiso de ubicación denegado. Mostrando Villa de Leyva.'
      : 'No se pudo obtener tu ubicación. Mostrando Villa de Leyva.',
    3500
  );
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  btn.classList.remove('locating', 'active');
  btn.setAttribute('aria-pressed', 'false');
}

// ── Punto azul + círculo de precisión ──────────────────────────

function drawLocation(latlng, accuracy) {
  if (!dot) {
    dot = L.marker(latlng, {
      icon: L.divIcon({
        className: 'locate-marker',
        html: '<span class="locate-dot"></span>',
        iconSize:   [18, 18],
        iconAnchor: [9, 9],
      }),
      title: MY_LOCATION,
      keyboard: false,
      zIndexOffset: 900, // sobre el catálogo, bajo el pin de búsqueda
    });
    dot.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showMyLocation();
    });
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      className: 'locate-accuracy',
      interactive: false,
    });
    accuracyCircle.addTo(map);
    dot.addTo(map);
  } else {
    dot.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng).setRadius(accuracy);
  }
}

// ── Ficha de "Mi ubicación" ────────────────────────────────────

async function showMyLocation() {
  const latlng = { lat: lastLatLng.lat, lng: lastLatLng.lng };
  // Acercar a LOCATE_ZOOM, sin alejar si el usuario ya estaba más cerca
  openPanel(latlng, MY_LOCATION, 'Ubicando zona...', null, {
    zoom: Math.max(LOCATE_ZOOM, map.getZoom()),
  });

  // El nombre de la zona llega después; se escribe solo si el panel sigue
  // mostrando "Mi ubicación" (el usuario pudo abrir otro lugar mientras)
  const place = await getPlace(latlng);
  const nameEl   = document.getElementById('panel-location-name');
  const regionEl = document.getElementById('panel-location-region');
  if (nameEl?.textContent === MY_LOCATION && regionEl) {
    regionEl.textContent = place
      ? [place.name, place.region].filter(Boolean).join(', ')
      : `${latlng.lat.toFixed(4)}°, ${latlng.lng.toFixed(4)}°`;
  }
}

// Cachea por coordenadas redondeadas (~100 m) para no consultar Nominatim
// en cada re-centrado: respeta su límite de 1 req/s.
async function getPlace({ lat, lng }) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (lastPlace?.key === key) return lastPlace.place;
  const place = await reverseGeocode(lat, lng);
  if (place) lastPlace = { key, place };
  return place;
}
