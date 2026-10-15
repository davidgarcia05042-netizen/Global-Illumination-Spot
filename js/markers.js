/**
 * markers.js — Catálogo de nodos de astroturismo
 *
 * Responsabilidades:
 *  - Leer el archivo data/spots.json
 *  - Pintar un marcador en el mapa por cada nodo
 *  - Diferenciar visualmente sitios funcionales vs educativos
 *  - Al hacer clic en un marcador, abrir el panel lateral con la ficha técnica
 */

import { openPanel, showToast } from './map.js';
import { icon }                 from './icons.js';

/**
 * Carga los spots del JSON y los agrega al mapa.
 * @param {L.Map} map - Instancia del mapa Leaflet
 */
export async function initMarkers(map) {
  let spots = [];

  try {
    const res = await fetch('data/spots.json');
    if (!res.ok) throw new Error('No se pudo cargar spots.json');
    spots = await res.json();
  } catch (err) {
    console.error('[Markers]', err);
    showToast('No se pudieron cargar los nodos de astroturismo');
    return;
  }

  // Caída escalonada: el último pin empieza a ~600 ms como máximo, sin
  // importar cuántos haya en el catálogo
  const step = spots.length > 1 ? Math.min(DROP_STEP_MS, DROP_TOTAL_MS / (spots.length - 1)) : 0;
  spots.forEach((spot, i) => addMarker(map, spot, Math.round(i * step)));
  console.log(`[Markers] ${spots.length} nodos cargados.`);
}

const DROP_STEP_MS  = 70;
const DROP_TOTAL_MS = 600;

/**
 * Crea y agrega un marcador SVG personalizado al mapa.
 * - Verde con estrella: sitio funcional para observación
 * - Naranja con telescopio: solo centro educativo/planetario
 *
 * Estilos y colores en styles.css (.spot-marker / .spot-pin). Las
 * animaciones van en el div interior .spot-pin, NUNCA en la raíz del
 * divIcon: Leaflet la posiciona con transform y se rompería.
 *
 * @param {L.Map}   map
 * @param {Object}  spot    - Objeto del catálogo
 * @param {number}  delayMs - retardo de la animación de caída
 */
function addMarker(map, spot, delayMs = 0) {
  const isFunctional = spot.is_functional;
  const kind  = isFunctional ? 'functional' : 'educational';
  const glyph = icon(isFunctional ? 'star' : 'telescope', 14);

  // Marcador SVG personalizado (fill/stroke en currentColor = color del tipo)
  const svgIcon = L.divIcon({
    className: `spot-marker spot-marker--${kind}`,
    html: `
      <div class="spot-pin" style="animation-delay: ${delayMs}ms">
        <svg width="32" height="40" viewBox="0 0 32 40" aria-hidden="true">
          <path class="spot-pin-body" d="M16 0C7.163 0 0 7.163 0 16c0 10 16 24 16 24S32 26 32 16C32 7.163 24.837 0 16 0z"/>
          <circle class="spot-pin-ring" cx="16" cy="16" r="10"/>
        </svg>
        <span class="spot-pin-glyph">${glyph}</span>
      </div>
    `,
    iconSize:   [32, 40],
    iconAnchor: [16, 40],   // La punta del pin en la coordenada exacta
    popupAnchor:[0, -42],
  });

  const marker = L.marker(
    [spot.coordinates.lat, spot.coordinates.lng],
    { icon: svgIcon, title: spot.name }
  );

  // Tooltip siempre visible con el nombre del lugar
  marker.bindTooltip(spot.name, {
    permanent: false,
    direction: 'top',
    offset: [0, -40],
    className: 'gis-tooltip',
  });

  // Click: abrir panel lateral con ficha técnica completa
  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e); // evitar que dispare el click del mapa también
    openPanel(
      { lat: spot.coordinates.lat, lng: spot.coordinates.lng },
      spot.name,
      spot.region,
      spot // pasar el objeto completo para renderizar la ficha técnica
    );
  });

  marker.addTo(map);
}
