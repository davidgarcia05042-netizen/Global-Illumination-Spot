/**
 * map.js — Mapa base + capa de contaminación lumínica
 *
 * Responsabilidades:
 *  - Crear el mapa Leaflet centrado en Colombia
 *  - Agregar capa base oscura (Esri Dark Gray Canvas)
 *  - Superponer capa de contaminación lumínica (Google Earth Engine / VIIRS)
 *  - Manejar botón toggle de la capa lumínica
 *  - Manejar botón de geolocalización (fallback: Villa de Leyva)
 *  - Abrir/cerrar el panel lateral
 *  - Actualizar el gauge de éxito
 *  - Renderizar la ficha técnica de un spot
 *  - Mostrar toasts de notificación
 *
 * Exporta:
 *  - initMap(owmApiKey) → devuelve la instancia del mapa
 *  - openPanel() → abre el panel con datos de un punto
 *  - setGauge()  → actualiza el indicador de éxito
 *  - showToast() → muestra una notificación temporal
 */

const DEFAULT_CENTER = [5.5353, -73.3678]; // Villa de Leyva
const DEFAULT_ZOOM   = 6;
const MAX_ZOOM       = 16;

let map               = null;
let lightPollutionLayer = null;
let lightLayerVisible   = true;

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
  // Se compone de dos teselas: el relieve gris oscuro + una capa de
  // referencia con los nombres de lugares (el base solo no trae etiquetas).
  const darkBase = L.layerGroup([
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: MAX_ZOOM, zIndex: 1, attribution: '&copy; <a href="https://www.esri.com">Esri</a>' }
    ),
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: MAX_ZOOM, zIndex: 1 }
    ),
  ]);
  darkBase.addTo(map);

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
  buildLayerSwitcher(map, { darkBase, lightPollutionLayer, cloudsLayer, satelliteBase });

  // Click en el mapa abre el panel para ese punto
  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    // Obtener nombre real del lugar via Nominatim reverse geocoding
    let nombre = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
    let region = '';
    try {
      const res  = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=es`
      );
      const data = await res.json();
      const addr = data.address || {};
      nombre = addr.city || addr.town || addr.village || addr.county || nombre;
      region = [addr.state, addr.country].filter(Boolean).join(', ');
    } catch { /* fallback a coordenadas si falla */ }
    openPanel({ lat, lng }, nombre, region);
  });

  // Botón toggle de la capa lumínica
  document.getElementById('layer-toggle-btn')?.addEventListener('click', () => {
    lightLayerVisible = !lightLayerVisible;
    if (lightLayerVisible) {
      lightPollutionLayer.addTo(map);
      document.getElementById('layer-toggle-btn').classList.add('active');
      showToast('Capa lumínica activada');
    } else {
      map.removeLayer(lightPollutionLayer);
      document.getElementById('layer-toggle-btn').classList.remove('active');
      showToast('Capa lumínica oculta');
    }
  });

  // Botón de geolocalización
  document.getElementById('geolocate-btn')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Geolocalización no disponible');
      return;
    }
    const btn = document.getElementById('geolocate-btn');
    btn.style.opacity = '0.5';
    showToast('Buscando tu ubicación...');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.style.opacity = '1';
        const { latitude: lat, longitude: lng } = pos.coords;
        map.flyTo([lat, lng], 12, { duration: 1.5 });
        openPanel({ lat, lng }, 'Mi ubicación', 'Colombia');
      },
      (err) => {
        btn.style.opacity = '1';
        map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { duration: 1.5 });
        const denied = err && err.code === err.PERMISSION_DENIED;
        showToast(
          denied
            ? 'Permiso de ubicación denegado. Mostrando Villa de Leyva.'
            : '📍 Mostrando Villa de Leyva (ubicación por defecto)'
        );
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  });

  // Botón cerrar panel
  document.getElementById('panel-close')?.addEventListener('click', closePanel);

  return map;
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
      showToast(`⚠️ ${message}`, 3500);
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
 */
export function openPanel(latlng, nombre, region, spot = null) {
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

  document.getElementById('side-panel').classList.add('open');
  document.getElementById('side-panel').removeAttribute('aria-hidden');
  // Usado por el CSS mobile para reposicionar el widget de capas por
  // encima del bottom-sheet solo mientras el panel está abierto.
  document.body.classList.add('panel-open');

  map.panTo([latlng.lat, latlng.lng], { animate: true, duration: 0.5 });

  // Evento que el predictor escucha para lanzar el cálculo
  document.dispatchEvent(
    new CustomEvent('gis:predict', { detail: { latlng, spot } })
  );
}

function closePanel() {
  const panel = document.getElementById('side-panel');
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
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
    verdict.textContent = '✦ Condiciones óptimas para observar';
  } else if (percent >= 40) {
    fill.setAttribute('class', 'gauge-fill medium');
    verdict.textContent = '◑ Condiciones aceptables';
  } else {
    fill.setAttribute('class', 'gauge-fill bad');
    verdict.textContent = '✕ Condiciones desfavorables';
  }
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
        ${spot.is_functional ? '✔ Sí' : '✘ Solo educativo'}
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
 *   - Base map: oscuro (Esri Dark Gray Canvas) o satélite (Esri World Imagery)
 *   - Overlay:  ninguno, contaminación lumínica (GEE) o nubosidad (OWM)
 */
function buildLayerSwitcher(map, { darkBase, lightPollutionLayer, cloudsLayer, satelliteBase }) {

  // darkBase ya está añadido al mapa desde initMap(); se reutiliza la
  // misma instancia aquí para no duplicar teselas.

  const lightAvailable  = Boolean(lightPollutionLayer);
  const cloudsAvailable = Boolean(cloudsLayer);

  // Estado inicial
  let currentBase    = 'dark';                          // 'dark' | 'satellite'
  let currentOverlay = lightAvailable ? 'light' : 'none'; // 'none' | 'light' | 'clouds'

  // RF01: la capa de contaminación lumínica es un compuesto histórico
  // anual, no una medición en tiempo real. Se avisa una sola vez por
  // sesión, ya sea al cargar (es el overlay activo por defecto) o si el
  // usuario vuelve a activarla manualmente más tarde.
  let lightDisclaimerShown = false;
  const showLightDisclaimer = () => {
    if (lightDisclaimerShown) return;
    lightDisclaimerShown = true;
    showToast('ℹ️ Contaminación lumínica: compuesto histórico anual (no en tiempo real)', 3500);
  };
  if (lightAvailable) setTimeout(showLightDisclaimer, 1500);

  const layers = [
    { id: 'dark',      icon: '🌑', label: 'Cielo oscuro',   type: 'base' },
    { id: 'satellite', icon: '🛰️', label: 'Satélite',       type: 'base' },
    {
      id: 'light', icon: '💡', label: 'Contaminación', type: 'overlay',
      disabled: !lightAvailable,
      title: lightAvailable
        ? 'Compuesto histórico anual VIIRS/NASA — no es una medición en tiempo real'
        : 'No disponible en modo demo (sin URL de Earth Engine configurada)',
    },
    {
      id: 'clouds', icon: '☁️', label: 'Nubosidad', type: 'overlay',
      disabled: !cloudsAvailable,
      title: cloudsAvailable ? undefined : 'No disponible en modo demo (sin API key configurada)',
    },
  ];

  // Contenedor del widget
  const container = document.createElement('div');
  container.className = 'layer-switcher';
  // Evitar que clicks en el widget disparen el click del mapa debajo
  L.DomEvent.disableClickPropagation(container);

  // Separador visual entre bases y overlays
  const groupBase    = document.createElement('div');
  const groupOverlay = document.createElement('div');
  groupBase.className    = 'layer-group';
  groupOverlay.className = 'layer-group';

  const sep = document.createElement('div');
  sep.className = 'layer-sep';

  layers.forEach(({ id, icon, label, type, title, disabled }) => {
    const btn = document.createElement('button');
    const isActive = (type === 'base' && id === currentBase) ||
                     (type === 'overlay' && id === currentOverlay && !disabled);
    btn.className  = 'layer-btn' + (isActive ? ' active' : '');
    btn.dataset.id = id;
    btn.setAttribute('aria-pressed', String(isActive));
    btn.innerHTML  = `<span class="layer-btn-icon" aria-hidden="true">${icon}</span><span class="layer-btn-label">${label}</span>`;
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
          // Quitar base oscura (grupo Esri Dark Gray), añadir satélite
          if (map.hasLayer(darkBase)) map.removeLayer(darkBase);
          satelliteBase.addTo(map);
          satelliteBase.setZIndex(1);
          // Asegurar que los overlays activos queden encima
          if (lightPollutionLayer && map.hasLayer(lightPollutionLayer)) lightPollutionLayer.setZIndex(2);
          if (cloudsLayer && map.hasLayer(cloudsLayer)) cloudsLayer.setZIndex(2);
        } else {
          // Quitar satélite, restaurar oscuro
          if (map.hasLayer(satelliteBase)) map.removeLayer(satelliteBase);
          darkBase.addTo(map);
          if (lightPollutionLayer && map.hasLayer(lightPollutionLayer)) lightPollutionLayer.setZIndex(2);
          if (cloudsLayer && map.hasLayer(cloudsLayer)) cloudsLayer.setZIndex(2);
        }

        currentBase = id;
        // Actualizar botones del grupo base
        groupBase.querySelectorAll('.layer-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });

      } else {
        // Overlay
        if (id === currentOverlay) return;

        // Quitar overlay anterior
        if (currentOverlay === 'light' && lightPollutionLayer && map.hasLayer(lightPollutionLayer)) map.removeLayer(lightPollutionLayer);
        if (currentOverlay === 'clouds' && cloudsLayer && map.hasLayer(cloudsLayer)) map.removeLayer(cloudsLayer);

        // Activar nuevo overlay
        if (id === 'light' && lightPollutionLayer) {
          lightPollutionLayer.addTo(map);
          lightPollutionLayer.setZIndex(2);
          showLightDisclaimer();
        } else if (id === 'clouds' && cloudsLayer) {
          cloudsLayer.addTo(map);
          cloudsLayer.setZIndex(2);
        }
        // 'none' = no añadir nada

        currentOverlay = id;
        groupOverlay.querySelectorAll('.layer-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
      }

      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      showToast(`Capa: ${label}`);
    });

    if (type === 'base')    groupBase.appendChild(btn);
    else                    groupOverlay.appendChild(btn);
  });

  container.appendChild(groupBase);
  container.appendChild(sep);
  container.appendChild(groupOverlay);

  document.getElementById('map').appendChild(container);
}
