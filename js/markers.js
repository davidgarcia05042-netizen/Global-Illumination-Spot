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
    showToast('⚠️ No se pudieron cargar los nodos de astroturismo');
    return;
  }

  spots.forEach((spot) => addMarker(map, spot));
  console.log(`[Markers] ${spots.length} nodos cargados.`);
}

/**
 * Crea y agrega un marcador SVG personalizado al mapa.
 * - Verde con estrella: sitio funcional para observación
 * - Naranja con ícono educativo: solo centro educativo/planetario
 *
 * @param {L.Map}   map
 * @param {Object}  spot - Objeto del catálogo
 */
function addMarker(map, spot) {
  const isFunctional = spot.is_functional;

  // Color del marcador según funcionalidad
  const color      = isFunctional ? '#27AE60' : '#F39C12';
  const colorLight = isFunctional ? 'rgba(39,174,96,0.2)' : 'rgba(243,156,18,0.2)';
  const icon       = isFunctional ? '★' : '◎';

  // Marcador SVG personalizado
  const svgIcon = L.divIcon({
    className: '',
    html: `
      <div style="
        position: relative;
        width: 32px;
        height: 40px;
        cursor: pointer;
      ">
        <!-- Pin principal -->
        <svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 0C7.163 0 0 7.163 0 16c0 10 16 24 16 24S32 26 32 16C32 7.163 24.837 0 16 0z"
            fill="${color}" fill-opacity="0.9"/>
          <circle cx="16" cy="16" r="10" fill="${colorLight}" stroke="${color}" stroke-width="1.5"/>
        </svg>
        <!-- Ícono interior -->
        <span style="
          position: absolute;
          top: 7px; left: 0; right: 0;
          text-align: center;
          font-size: 14px;
          color: white;
          pointer-events: none;
          text-shadow: 0 0 4px rgba(0,0,0,0.5);
        ">${icon}</span>
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
