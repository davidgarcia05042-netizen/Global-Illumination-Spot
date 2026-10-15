/**
 * search.js — Buscador de ubicaciones (Nominatim)
 *
 * Responsabilidades:
 *  - Escuchar el input de la barra de búsqueda
 *  - Consultar la API pública de Nominatim (OpenStreetMap) con debounce
 *  - Mostrar resultados en dropdown
 *  - Al seleccionar un resultado, centrar el mapa y abrir el panel lateral
 *  - Filtrar resultados para priorizar Colombia
 *  - Guardar los lugares elegidos y mostrarlos como "Búsquedas recientes"
 *    al pulsar el buscador (solo en este dispositivo, vía localStorage)
 *
 * Nominatim es gratuito y no requiere API key.
 * Límite de uso: máximo 1 solicitud por segundo (cumplido con debounce de 500ms).
 * Elegir una búsqueda reciente no consulta Nominatim: se guardan las
 * coordenadas y el zoom ya resueltos.
 */

import { openPanel, showToast } from './map.js';
import { icon }                 from './icons.js';

const NOMINATIM_URL   = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS     = 500; // tiempo de espera antes de lanzar la búsqueda
const MIN_QUERY       = 3;
const MAX_SEARCH_ZOOM = 14;  // tope para lugares puntuales (calles, edificios)
const FALLBACK_ZOOM   = 12;
const RECENT_KEY      = 'gis-recent-searches';
const MAX_RECENT      = 5;

const CLOCK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

let debounceTimer = null;
let mapInstance   = null;
let inputEl       = null;
let resultsEl     = null;

/**
 * Inicializa el buscador.
 * @param {L.Map} map
 */
export function initSearch(map) {
  mapInstance = map;

  inputEl   = document.getElementById('search-input');
  resultsEl = document.getElementById('search-results');
  const btn = document.getElementById('search-btn');

  if (!inputEl || !btn || !resultsEl) return;

  // Búsqueda al escribir (con debounce para respetar el rate limit de Nominatim).
  // Por debajo del mínimo de caracteres se vuelven a ver las recientes.
  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = inputEl.value.trim();

    if (query.length < MIN_QUERY) {
      showRecent();
      return;
    }

    debounceTimer = setTimeout(() => performSearch(query), DEBOUNCE_MS);
  });

  // Al pulsar el buscador: seleccionar el texto (escribir lo reemplaza) y
  // desplegar las búsquedas recientes. La selección se repite en el primer
  // click porque en Chrome/Safari el mouseup deshace la hecha en focus.
  let selectOnClick = false;
  inputEl.addEventListener('focus', () => {
    selectOnClick = true;
    inputEl.select();
    if (resultsEl.hidden) showRecent();
  });
  inputEl.addEventListener('click', () => {
    if (selectOnClick) {
      inputEl.select();
      selectOnClick = false;
    }
    if (resultsEl.hidden) showRecent(); // p. ej. tras cerrarlo con Escape
  });

  // Búsqueda al presionar el botón o Enter
  btn.addEventListener('click', () => {
    const query = inputEl.value.trim();
    if (query.length >= MIN_QUERY) performSearch(query);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      const query = inputEl.value.trim();
      if (query.length >= MIN_QUERY) performSearch(query);
    }
    if (e.key === 'Escape') hideResults();
  });

  // Cerrar dropdown al hacer click fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) hideResults();
  });
}

/**
 * Llama a Nominatim y renderiza los resultados.
 * @param {string} query
 */
async function performSearch(query) {
  showToast('Buscando...');

  const params = new URLSearchParams({
    q:              query,
    format:         'json',
    limit:          6,
    addressdetails: 1,
    // Primero solo Colombia; si no hay resultados se repite la búsqueda
    // a nivel global más abajo (útil para lugares fuera de Colombia)
    countrycodes:   'co',
  });

  try {
    const res  = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'Accept-Language': 'es' }
    });
    const data = await res.json();

    if (!data.length) {
      // Si no hay resultados en Colombia, buscar globalmente
      const paramsGlobal = new URLSearchParams({
        q: query, format: 'json', limit: 4, addressdetails: 1
      });
      const res2  = await fetch(`${NOMINATIM_URL}?${paramsGlobal}`, {
        headers: { 'Accept-Language': 'es' }
      });
      const data2 = await res2.json();
      renderResults(data2);
    } else {
      renderResults(data);
    }
  } catch (err) {
    console.error('[Search]', err);
    showToast('Error al conectar con el buscador');
    hideResults();
  }
}

/**
 * Dibuja la lista de resultados de Nominatim en el dropdown.
 * @param {Array} data
 */
function renderResults(data) {
  resultsEl.innerHTML = '';

  if (!data.length) {
    const li = document.createElement('li');
    li.textContent = 'No se encontraron resultados';
    li.className   = 'search-empty';
    resultsEl.appendChild(li);
    resultsEl.hidden = false;
    return;
  }

  data.forEach((item) => {
    const place = toPlace(item);
    resultsEl.appendChild(buildItem(place, item.display_name));
  });

  resultsEl.hidden = false;
}

/**
 * Convierte un resultado de Nominatim en el "lugar" que usa la app (y que
 * se guarda en el historial).
 * @returns {{name: string, region: string, lat: number, lng: number, zoom: number}}
 */
function toPlace(item) {
  const addr = item.address || {};
  return {
    // Nombre corto: las 3 primeras partes de display_name
    name:   item.display_name.split(',').slice(0, 3).map((s) => s.trim()).join(', '),
    region: [addr.state, addr.country].filter(Boolean).join(', ') || 'Colombia',
    lat:    parseFloat(item.lat),
    lng:    parseFloat(item.lon),
    zoom:   zoomForResult(item),
  };
}

/**
 * Zoom acorde al tamaño del lugar: un departamento se ve completo y un
 * municipio o vereda de cerca, en vez de un zoom fijo para todo.
 * Nominatim entrega boundingbox como [sur, norte, oeste, este] (strings).
 */
function zoomForResult(item) {
  const bb = (item.boundingbox || []).map(parseFloat);
  if (bb.length !== 4 || bb.some(Number.isNaN)) return FALLBACK_ZOOM;
  const bounds = L.latLngBounds([bb[0], bb[2]], [bb[1], bb[3]]);
  return Math.min(mapInstance.getBoundsZoom(bounds), MAX_SEARCH_ZOOM);
}

/**
 * Acerca el mapa al lugar, lo marca con un pin, abre el panel y lo guarda
 * en el historial. El vuelo lo hace openPanel() (ver su JSDoc en map.js).
 */
function goToPlace(place) {
  openPanel({ lat: place.lat, lng: place.lng }, place.name, place.region, null,
    { zoom: place.zoom, pin: true });
  saveRecent(place);
  hideResults();
  inputEl.value = place.name;
  inputEl.blur(); // en móvil, cierra el teclado para que se vea el mapa
}

/**
 * <li> navegable con teclado (RNF08) para un lugar del dropdown.
 * @param {Object}   place
 * @param {string}   title      - texto completo para el tooltip
 * @param {Function} [onRemove] - si se da, agrega el botón ✕ (recientes)
 */
function buildItem(place, title, onRemove) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  li.title    = title;

  if (onRemove) {
    li.className = 'search-item-recent';
    const icon = document.createElement('span');
    icon.className = 'search-item-icon';
    icon.innerHTML = CLOCK_ICON;
    const text = document.createElement('span');
    text.className   = 'search-item-text';
    text.textContent = place.name;
    const remove = document.createElement('button');
    remove.type      = 'button';
    remove.className = 'search-item-remove';
    remove.innerHTML = icon('x', 14);
    remove.setAttribute('aria-label', `Quitar ${place.name} del historial`);
    remove.addEventListener('click', (e) => {
      // Sin esto, el clic llega a document con el <li> ya quitado del DOM
      // y el "click fuera" cerraría el dropdown
      e.stopPropagation();
      onRemove();
    });
    li.append(icon, text, remove);
  } else {
    li.textContent = place.name;
  }

  li.addEventListener('click', () => goToPlace(place));
  li.addEventListener('keydown', (e) => {
    // Solo el propio <li>: Enter sobre el botón ✕ no debe navegar
    if (e.target === li && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      goToPlace(place);
    }
  });
  return li;
}

// ── Búsquedas recientes ───────────────────────────────────────

function showRecent() {
  const recent = loadRecent();
  resultsEl.innerHTML = '';
  if (!recent.length) {
    resultsEl.hidden = true;
    return;
  }

  const heading = document.createElement('li');
  heading.className   = 'search-section-title';
  heading.textContent = 'Búsquedas recientes';
  heading.setAttribute('role', 'presentation');
  resultsEl.appendChild(heading);

  recent.forEach((place) => {
    resultsEl.appendChild(buildItem(place, `${place.name} — ${place.region}`, () => {
      storeRecent(loadRecent().filter((p) => p.name !== place.name));
      showRecent();
      inputEl.focus();
    }));
  });

  const clear = document.createElement('li');
  clear.className = 'search-clear';
  const clearBtn = document.createElement('button');
  clearBtn.type        = 'button';
  clearBtn.textContent = 'Borrar historial';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // ver el comentario del botón ✕
    storeRecent([]);
    hideResults();
    inputEl.focus();
  });
  clear.appendChild(clearBtn);
  resultsEl.appendChild(clear);

  resultsEl.hidden = false;
}

/** El más reciente primero, sin duplicados y como máximo MAX_RECENT. */
function saveRecent(place) {
  const others = loadRecent().filter((p) => p.name !== place.name);
  storeRecent([place, ...others].slice(0, MAX_RECENT));
}

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    // Descartar entradas corruptas o de un formato anterior
    return Array.isArray(list)
      ? list.filter((p) => p && typeof p.name === 'string'
          && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.zoom))
      : [];
  } catch {
    return []; // localStorage bloqueado o JSON inválido
  }
}

function storeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* sin persistencia (modo privado): el historial no se guarda */ }
}

function hideResults() {
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
}
