/**
 * map.js — Mapa base + capa de contaminación lumínica
 *
 * Responsabilidades:
 *  - Crear el mapa Leaflet centrado en Colombia
 *  - Agregar capa base Esri Gray Canvas (oscura o clara según el tema)
 *  - Superponer capa de contaminación lumínica (Google Earth Engine / VIIRS)
 *  - Widget selector de capas (base oscura/satélite + overlays)
 *  - Abrir/cerrar el panel lateral
 *  - Actualizar el gauge de éxito
 *  - Renderizar la ficha técnica de un spot
 *  - Mostrar toasts de notificación
 *
 * Exporta:
 *  - initMap(owmApiKey, geeTileUrl) → devuelve la instancia del mapa
 *  - openPanel() → abre el panel con datos de un punto
 *  - setGauge()  → actualiza el indicador de éxito
 *  - showToast() → muestra una notificación temporal
 *  - reverseGeocode() → nombre y región de unas coordenadas (Nominatim)
 */

import { getTheme } from './theme.js';
import { icon }     from './icons.js';

export const DEFAULT_CENTER = [5.5353, -73.3678]; // Villa de Leyva
export const DEFAULT_ZOOM   = 6;
const MAX_ZOOM       = 16;

// Mismo breakpoint que el CSS: por debajo, el panel es un bottom-sheet
const MOBILE_MQ = window.matchMedia('(max-width: 640px)');

let map                 = null;
let lightPollutionLayer = null;
let searchPin           = null; // pin del último lugar elegido en el buscador

// ── Inicialización del mapa ────────────────────────────────────

/**
 * @param {string} [owmApiKey]  - API key de OpenWeatherMap (ver js/config.js).
 *   Si viene vacía, la capa de nubes en tiempo real queda deshabilitada
 *   (modo demo) en vez de fallar silenciosamente con teselas 401.
 * @param {string} [geeTileUrl] - URL de teselas de Google Earth Engine para
 *   la capa de contaminación lumínica (ver js/config.js). Si viene vacía,
 *   esa capa queda deshabilitada en el selector en vez de intentar cargar
 *   una URL inexistente.
 */
export function initMap(owmApiKey = '', geeTileUrl = '') {
  map = L.map('map', {
    center:  DEFAULT_CENTER,
    zoom:    DEFAULT_ZOOM,
    minZoom: 4,
    maxZoom: MAX_ZOOM,
    zoomControl: true,
  });

  // Capa base: Esri Dark Gray Canvas (gratuita, sin API key).
  // Reemplaza a CartoDB Dark Matter: desde 2023 CARTO exige una API key de
  // pago para basemaps.cartocdn.com, y sin ella las teselas devuelven una
  // marca de agua "API KEY REQUIRED" en vez de mapa — se confirmó en
  // pruebas que esto estaba rompiendo visualmente el mapa base completo,
  // no solo un overlay. Es la misma familia de servicio (Esri ArcGIS
  // Online) que ya se usa sin problemas para la capa "Satélite" más abajo.
  // Se compone de dos teselas: el relieve gris + una capa de referencia
  // con los nombres de lugares (el base solo no trae etiquetas).
  // Hay una variante oscura y una clara; se usa la del tema activo (RF09).
  const canvasBase = (style) => L.layerGroup([
    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      { maxZoom: MAX_ZOOM, zIndex: 1, attribution: '&copy; <a href="https://www.esri.com">Esri</a>' }
    ),
    L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
      { maxZoom: MAX_ZOOM, zIndex: 1 }
    ),
  ]);
  const mapBases = { dark: canvasBase('Dark'), light: canvasBase('Light') };
  mapBases[getTheme()].addTo(map);

  // Capa de contaminación lumínica — Google Earth Engine (VIIRS).
  // Dataset: NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG — promedio anual.
  // Paleta: negro = cielo oscuro, azul/verde = moderado, rojo/blanco = alta contaminación
  // NOTA (RF01): es un compuesto histórico anual, NO una medición en tiempo real.
  // La URL se inyecta desde js/config.js (RNF07) en vez de hardcodearse:
  // incluye un identificador de proyecto de Earth Engine que, aunque no es
  // un secreto crítico, tampoco debe quedar en texto plano en el control
  // de versiones. Sin ella, la capa queda deshabilitada (ver más abajo).
  lightPollutionLayer = geeTileUrl
    ? L.tileLayer(geeTileUrl, {
        opacity: 0.75,
        maxZoom: MAX_ZOOM,
        zIndex: 2, // siempre sobre el mapa base, aunque este se re-añada
        attribution: 'Contaminación lumínica: <a href="https://earthengine.google.com">Google Earth Engine / VIIRS</a>',
        errorTileUrl: '',
      })
    : null;
  if (lightPollutionLayer) {
    lightPollutionLayer.addTo(map);
    attachTileErrorHandler(
      lightPollutionLayer,
      'La capa de contaminación lumínica no está disponible temporalmente'
    );
  }

  // Capa de nubosidad en tiempo real (OpenWeatherMap tiles).
  // Sin API key el sistema opera en modo demo: la capa queda deshabilitada
  // en el selector en vez de fallar con teselas 401 sin explicación.
  const cloudsLayer = owmApiKey
    ? L.tileLayer(
        `https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${owmApiKey}`,
        {
          opacity: 0.65,
          maxZoom: MAX_ZOOM,
          zIndex: 2,
          attribution: 'Nubes: <a href="https://openweathermap.org">OpenWeatherMap</a>',
          errorTileUrl: '',
        }
      )
    : null;
  if (cloudsLayer) {
    attachTileErrorHandler(cloudsLayer, 'La capa de nubosidad no está disponible temporalmente');
  }

  // Capa satelital — Esri World Imagery (pública, sin API key)
  const satelliteBase = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: MAX_ZOOM,
      attribution: 'Satélite: &copy; <a href="https://www.esri.com">Esri</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }
  );

  // Widget de capas
  buildLayerSwitcher(map, { mapBases, lightPollutionLayer, cloudsLayer, satelliteBase });

  // Click en el mapa abre el panel para ese punto, con su nombre real
  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const place = await reverseGeocode(lat, lng);
    openPanel(
      { lat, lng },
      place?.name || `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`,
      place?.region || ''
    );
  });

  // Botón cerrar panel
  document.getElementById('panel-close')?.addEventListener('click', closePanel);

  return map;
}

// ── Geocodificación inversa (Nominatim) ────────────────────────

/**
 * Nombre del lugar (municipio/ciudad) y región para unas coordenadas.
 * @returns {Promise<{name: string, region: string}|null>} null si falla
 */
export async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`
    );
    const data = await res.json();
    const addr = data.address || {};
    return {
      name:   addr.city || addr.town || addr.village || addr.county || '',
      region: [addr.state, addr.country].filter(Boolean).join(', '),
    };
  } catch {
    return null;
  }
}

// ── Manejo de errores de teselas (RF10 / RNF09) ────────────────

/**
 * Escucha 'tileerror'/'load' de una capa Leaflet y muestra un único toast
 * por "episodio" de fallo (no un toast por cada tesela caída), para no
 * saturar al usuario cuando fallan varias teselas a la vez.
 * @param {L.TileLayer} layer
 * @param {string}      message
 */
function attachTileErrorHandler(layer, message) {
  let errorShown = false;
  layer.on('tileerror', () => {
    if (!errorShown) {
      errorShown = true;
      showToast(message, 3500);
    }
  });
  layer.on('load', () => {
    errorShown = false;
  });
}

// ── Panel lateral ──────────────────────────────────────────────

/**
 * Abre el panel lateral para un punto geográfico.
 * @param {{ lat: number, lng: number }} latlng
 * @param {string} nombre   - Nombre a mostrar en el encabezado del panel
 * @param {string} region   - Región/departamento
 * @param {Object} [spot]   - Objeto del catálogo si es un nodo registrado
 * @param {Object}  [opts]
 * @param {number}  [opts.zoom] - Volar a este zoom. Sin él, solo se
 *   desplaza el mapa manteniendo el zoom actual. El movimiento se hace AQUÍ y no en
 *   quien llama: un flyTo() previo quedaría cancelado por el desplazamiento.
 * @param {boolean} [opts.pin]  - Marcar el punto con el pin de búsqueda.
 *   Cualquier otra apertura (clic en mapa, marcador) retira el pin anterior.
 */
export function openPanel(latlng, nombre, region, spot = null, { zoom, pin = false } = {}) {
  document.getElementById('panel-location-name').textContent  = nombre;
  document.getElementById('panel-location-region').textContent = region;

  const spotSection = document.getElementById('spot-info-section');
  if (spot) {
    renderSpotInfo(spot);
    spotSection.hidden = false;
  } else {
    spotSection.hidden = true;
  }

  setGauge(null); // estado "cargando" mientras llega la respuesta del predictor

  const panel = document.getElementById('side-panel');
  panel.classList.add('open');
  panel.removeAttribute('aria-hidden');
  panel.inert = false; // cerrado queda inert: fuera del orden de tabulación
  // Usado por el CSS mobile para reposicionar el widget de capas por
  // encima del bottom-sheet solo mientras el panel está abierto.
  document.body.classList.add('panel-open');

  if (pin) placeSearchPin(latlng, nombre, region);
  else     removeSearchPin();

  focusPoint(latlng, zoom);

  // Evento que el predictor escucha para lanzar el cálculo
  document.dispatchEvent(
    new CustomEvent('gis:predict', { detail: { latlng, spot } })
  );
}

function closePanel() {
  const panel = document.getElementById('side-panel');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  document.body.classList.remove('panel-open');
  removeSearchPin();
}

/**
 * Lleva el mapa a un punto dejándolo visible FUERA del panel lateral: a la
 * izquierda de él en escritorio y por encima del bottom-sheet en móvil.
 * Centrarlo sin más lo dejaría tapado justo detrás del panel.
 * @param {{ lat: number, lng: number }} latlng
 * @param {number} [zoom] - si se da, vuela hasta ese zoom
 */
function focusPoint(latlng, zoom) {
  const targetZoom = zoom ?? map.getZoom();
  const panel  = document.getElementById('side-panel');
  const offset = MOBILE_MQ.matches
    ? L.point(0, panel.offsetHeight / 2)
    : L.point(panel.offsetWidth / 2, 0);
  const center = map.unproject(map.project(latlng, targetZoom).add(offset), targetZoom);

  if (zoom) map.flyTo(center, targetZoom, { duration: 1.2 });
  else      map.panTo(center, { animate: true, duration: 0.5 });
}

// ── Pin de búsqueda ────────────────────────────────────────────

function placeSearchPin(latlng, nombre, region) {
  removeSearchPin();
  searchPin = L.marker([latlng.lat, latlng.lng], {
    icon: L.divIcon({
      className: 'search-pin',
      html: `
        <svg width="30" height="42" viewBox="0 0 30 42" aria-hidden="true">
          <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.716 23.284 0 15 0z"/>
          <circle cx="15" cy="15" r="5.5"/>
        </svg>`,
      iconSize:   [30, 42],
      iconAnchor: [15, 42], // la punta del pin en la coordenada exacta
    }),
    title: nombre,
    keyboard: false,
    zIndexOffset: 1000, // por encima de los marcadores del catálogo
  });
  searchPin.bindTooltip(nombre, { direction: 'top', offset: [0, -42], className: 'gis-tooltip' });
  // Volver a abrir la ficha del lugar si el usuario cerró el panel
  searchPin.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    openPanel(latlng, nombre, region, null, { pin: true });
  });
  searchPin.addTo(map);
}

function removeSearchPin() {
  if (searchPin) {
    map.removeLayer(searchPin);
    searchPin = null;
  }
}

// ── Gauge de éxito ─────────────────────────────────────────────

/**
 * Actualiza el anillo de probabilidad de éxito.
 * @param {number|null} percent - 0–100, o null para estado "cargando"
 */
export function setGauge(percent) {
  const fill    = document.getElementById('gauge-fill');
  const label   = document.getElementById('gauge-percent');
  const verdict = document.getElementById('gauge-verdict');
  const spinner = document.getElementById('gauge-spinner');

  if (percent === null) {
    label.hidden = true;
    if (spinner) spinner.hidden = false;
    verdict.textContent = 'Calculando condiciones...';
    fill.style.strokeDashoffset = '314';
    fill.setAttribute('class', 'gauge-fill');
    return;
  }

  label.hidden = false;
  if (spinner) spinner.hidden = true;

  const offset = 314 - (314 * percent) / 100;
  fill.style.strokeDashoffset = offset.toString();
  label.textContent = `${Math.round(percent)}%`;

  if (percent >= 70) {
    fill.setAttribute('class', 'gauge-fill good');
    setVerdict(verdict, 'sparkles', 'Condiciones óptimas para observar');
  } else if (percent >= 40) {
    fill.setAttribute('class', 'gauge-fill medium');
    setVerdict(verdict, 'contrast', 'Condiciones aceptables');
  } else {
    fill.setAttribute('class', 'gauge-fill bad');
    setVerdict(verdict, 'circle-x', 'Condiciones desfavorables');
  }
}

// Icono (SVG propio, vía innerHTML) + texto (nodo de texto, nunca HTML)
function setVerdict(el, iconName, text) {
  el.innerHTML = icon(iconName, 14);
  el.append(document.createTextNode(text));
}

// ── Ficha técnica ──────────────────────────────────────────────

function renderSpotInfo(spot) {
  const container = document.getElementById('spot-info-content');
  const bortleLabels = ['', 'Cielo negro', 'Cielo negro', 'Rural verdadero',
    'Rural/suburbano', 'Suburbano', 'Suburbano brillante',
    'Transición', 'Urbano', 'Urbano intenso'];

  const tagsHtml = (spot.observation_types || [])
    .map(t => `<span class="obs-tag">${t}</span>`)
    .join('');

  container.innerHTML = `
    <div class="spot-info-row">
      <span class="spot-info-key">Escala Bortle</span>
      <span class="spot-info-val">
        <span class="bortle-badge bortle-${spot.bortle_index}">
          ${spot.bortle_index} — ${bortleLabels[spot.bortle_index] || ''}
        </span>
      </span>
    </div>
    <div class="spot-info-row">
      <span class="spot-info-key">Altitud</span>
      <span class="spot-info-val">${spot.altitude_m ?? '—'} m s.n.m.</span>
    </div>
    <div class="spot-info-row">
      <span class="spot-info-key">Funcional</span>
      <span class="spot-info-val" style="color:${spot.is_functional ? 'var(--good)' : 'var(--bad)'}">
        <span class="spot-functional">${spot.is_functional ? `${icon('check', 14)}Sí` : `${icon('x', 14)}Solo educativo`}</span>
      </span>
    </div>
    <div class="spot-info-row">
      <span class="spot-info-key">Acceso</span>
      <span class="spot-info-val">${spot.infrastructure?.accessibility ?? '—'}</span>
    </div>
    <div class="spot-info-row">
      <span class="spot-info-key">Observación</span>
      <span class="spot-info-val"><div class="obs-tags">${tagsHtml}</div></span>
    </div>
    ${spot.description ? `
    <div class="spot-info-row" style="flex-direction:column;gap:4px;">
      <span class="spot-info-key">Descripción</span>
      <span style="font-family:var(--font-body);font-size:11px;color:var(--text-secondary);line-height:1.5;margin-top:4px;">
        ${spot.description}
      </span>
    </div>` : ''}
  `;
}

// ── Toast ──────────────────────────────────────────────────────

/**
 * Muestra una notificación temporal en la parte inferior de la pantalla.
 * @param {string}  message
 * @param {number}  [duration=2500]
 */
export function showToast(message, duration = 2500) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Widget selector de capas ───────────────────────────────────

/**
 * Selector de capas tipo Google Maps.
 * Gestiona dos dimensiones independientes:
 *   - Base map: mapa (Esri Gray Canvas, oscuro o claro según el tema) o
 *               satélite (Esri World Imagery)
 *   - Overlay:  ninguno, contaminación lumínica (GEE) o nubosidad (OWM)
 * Los overlays se crean con zIndex 2, así quedan encima de cualquier base.
 */
function buildLayerSwitcher(map, { mapBases, lightPollutionLayer, cloudsLayer, satelliteBase }) {

  // La base del tema activo ya está añadida desde initMap(); se reutilizan
  // las mismas instancias aquí para no duplicar teselas.
  const activeMapBase = () => mapBases[getTheme()];

  const lightAvailable  = Boolean(lightPollutionLayer);
  const cloudsAvailable = Boolean(cloudsLayer);

  // Estado inicial
  let currentBase    = 'map';                           // 'map' | 'satellite'
  let currentOverlay = lightAvailable ? 'light' : 'none'; // 'none' | 'light' | 'clouds'

  // Cambio de tema (theme.js): si el usuario está en la vista "Mapa",
  // reemplazar las teselas oscuras por las claras o viceversa. En
  // satélite no se toca nada; al volver a "Mapa" se usará la del tema.
  document.addEventListener('gis:theme-change', () => {
    if (currentBase !== 'map') return;
    Object.values(mapBases).forEach((base) => {
      if (map.hasLayer(base)) map.removeLayer(base);
    });
    activeMapBase().addTo(map);
  });

  // RF01: la capa de contaminación lumínica es un compuesto histórico
  // anual, no una medición en tiempo real. Se avisa una sola vez por
  // sesión, ya sea al cargar (es el overlay activo por defecto) o si el
  // usuario vuelve a activarla manualmente más tarde.
  let lightDisclaimerShown = false;
  const showLightDisclaimer = () => {
    if (lightDisclaimerShown) return;
    lightDisclaimerShown = true;
    showToast('Contaminación lumínica: compuesto histórico anual (no en tiempo real)', 3500);
  };
  if (lightAvailable) setTimeout(showLightDisclaimer, 1500);

  const layers = [
    { id: 'map',       icon: 'map',       label: 'Mapa',     type: 'base' },
    { id: 'satellite', icon: 'satellite', label: 'Satélite', type: 'base' },
    {
      id: 'light', icon: 'lightbulb', label: 'Contaminación', type: 'overlay',
      disabled: !lightAvailable,
      title: lightAvailable
        ? 'Compuesto histórico anual VIIRS/NASA — no es una medición en tiempo real'
        : 'No disponible en modo demo (sin URL de Earth Engine configurada)',
    },
    {
      id: 'clouds', icon: 'cloud', label: 'Nubosidad', type: 'overlay',
      disabled: !cloudsAvailable,
      title: cloudsAvailable ? undefined : 'No disponible en modo demo (sin API key configurada)',
    },
  ];

  // Contenedor del widget
  const container = document.createElement('div');
  container.className = 'layer-switcher';
  // Evitar que clicks en el widget disparen el click del mapa debajo
  L.DomEvent.disableClickPropagation(container);

  // Un grupo para bases y otro para overlays, cada uno con su píldora
  const groupBase    = createLayerGroup();
  const groupOverlay = createLayerGroup();

  // Separador visual entre bases y overlays
  const sep = document.createElement('div');
  sep.className = 'layer-sep';

  // Marca el botón activo de un grupo (o ninguno) y mueve su píldora
  const setActive = (group, activeBtn) => {
    group.querySelectorAll('.layer-btn').forEach((b) => {
      const on = b === activeBtn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    updatePill(group);
  };

  layers.forEach(({ id, icon: iconName, label, type, title, disabled }) => {
    const btn = document.createElement('button');
    const isActive = (type === 'base' && id === currentBase) ||
                     (type === 'overlay' && id === currentOverlay && !disabled);
    btn.className  = 'layer-btn' + (isActive ? ' active' : '');
    btn.dataset.id = id;
    btn.setAttribute('aria-pressed', String(isActive));
    btn.innerHTML  = `<span class="layer-btn-icon" aria-hidden="true">${icon(iconName, 20)}</span><span class="layer-btn-label">${label}</span>`;
    if (title) btn.title = title;

    if (disabled) {
      btn.disabled = true;
      btn.classList.add('disabled');
      if (type === 'base') groupBase.appendChild(btn); else groupOverlay.appendChild(btn);
      return;
    }

    btn.addEventListener('click', () => {
      if (type === 'base') {
        if (id === currentBase) return;

        if (id === 'satellite') {
          // Quitar el mapa (grupo Esri Gray Canvas del tema), añadir satélite
          if (map.hasLayer(activeMapBase())) map.removeLayer(activeMapBase());
          satelliteBase.addTo(map);
          satelliteBase.setZIndex(1);
        } else {
          // Quitar satélite, restaurar el mapa del tema activo
          if (map.hasLayer(satelliteBase)) map.removeLayer(satelliteBase);
          activeMapBase().addTo(map);
        }

        currentBase = id;
        setActive(groupBase, btn);

      } else {
        // Overlay: pulsar el activo lo apaga (queda sin overlay)
        const next = id === currentOverlay ? 'none' : id;

        // Quitar overlay anterior
        if (currentOverlay === 'light' && lightPollutionLayer && map.hasLayer(lightPollutionLayer)) map.removeLayer(lightPollutionLayer);
        if (currentOverlay === 'clouds' && cloudsLayer && map.hasLayer(cloudsLayer)) map.removeLayer(cloudsLayer);

        // Activar nuevo overlay
        if (next === 'light' && lightPollutionLayer) {
          lightPollutionLayer.addTo(map);
          lightPollutionLayer.setZIndex(2);
          showLightDisclaimer();
        } else if (next === 'clouds' && cloudsLayer) {
          cloudsLayer.addTo(map);
          cloudsLayer.setZIndex(2);
        }
        // 'none' = no añadir nada

        currentOverlay = next;
        setActive(groupOverlay, next === 'none' ? null : btn);
      }
      // Sin toast "Capa: X": la píldora ya muestra el cambio
    });

    if (type === 'base')    groupBase.appendChild(btn);
    else                    groupOverlay.appendChild(btn);
  });

  container.appendChild(groupBase);
  container.appendChild(sep);
  container.appendChild(groupOverlay);

  document.getElementById('map').appendChild(container);

  // Primera colocación sin transición (si no, la píldora "volaría" desde
  // x=0 al cargar). Las medidas cambian cuando carga la fuente Outfit o
  // al pasar al layout móvil: se recoloca también sin transición.
  const placeAll = () => {
    updatePill(groupBase, { instant: true });
    updatePill(groupOverlay, { instant: true });
  };
  placeAll();
  if ('ResizeObserver' in window) new ResizeObserver(placeAll).observe(container);
  document.fonts?.ready.then(placeAll);
}

/** .layer-group con su .layer-pill (indicador deslizante) detrás de los botones */
function createLayerGroup() {
  const group = document.createElement('div');
  group.className = 'layer-group';
  const pill = document.createElement('span');
  pill.className = 'layer-pill is-hidden';
  pill.setAttribute('aria-hidden', 'true');
  group.appendChild(pill);
  return group;
}

/**
 * Lleva la píldora del grupo bajo su botón activo, o la desvanece si no
 * hay ninguno (overlay apagado, o ambos deshabilitados en modo demo).
 * Los botones disabled nunca son "active", así que nunca la reciben.
 * @param {HTMLElement} group
 * @param {{instant?: boolean}} [opts] - recolocar sin animar
 */
function updatePill(group, { instant = false } = {}) {
  const pill   = group.querySelector('.layer-pill');
  const active = group.querySelector('.layer-btn.active:not(:disabled)');

  if (!active) {
    pill.classList.add('is-hidden');
    return;
  }

  // Si estaba oculta, aparece directamente en su sitio (solo fade), en vez
  // de deslizarse desde el botón donde estuvo la última vez
  const wasHidden = pill.classList.contains('is-hidden');
  const noSlide   = instant || wasHidden;
  if (noSlide) pill.classList.add('no-transition');

  pill.style.width     = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft}px)`;

  if (noSlide) {
    void pill.offsetWidth; // aplica la posición antes de reactivar la transición
    pill.classList.remove('no-transition');
  }
  pill.classList.remove('is-hidden');
}
