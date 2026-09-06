/**
 * search.js — Buscador de ubicaciones (Nominatim)
 *
 * Responsabilidades:
 *  - Escuchar el input de la barra de búsqueda
 *  - Consultar la API pública de Nominatim (OpenStreetMap) con debounce
 *  - Mostrar resultados en dropdown
 *  - Al seleccionar un resultado, centrar el mapa y abrir el panel lateral
 *  - Filtrar resultados para priorizar Colombia
 *
 * Nominatim es gratuito y no requiere API key.
 * Límite de uso: máximo 1 solicitud por segundo (cumplido con debounce de 500ms).
 */

import { openPanel, showToast } from './map.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS   = 500; // tiempo de espera antes de lanzar la búsqueda

let debounceTimer = null;
let mapInstance   = null;

/**
 * Inicializa el buscador.
 * @param {L.Map} map
 */
export function initSearch(map) {
  mapInstance = map;

  const input   = document.getElementById('search-input');
  const btn     = document.getElementById('search-btn');
  const results = document.getElementById('search-results');

  if (!input || !btn || !results) return;

  // Búsqueda al escribir (con debounce para respetar el rate limit de Nominatim)
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();

    if (query.length < 3) {
      hideResults(results);
      return;
    }

    debounceTimer = setTimeout(() => performSearch(query, results), DEBOUNCE_MS);
  });

  // Búsqueda al presionar el botón o Enter
  btn.addEventListener('click', () => {
    const query = input.value.trim();
    if (query.length >= 3) performSearch(query, results);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      const query = input.value.trim();
      if (query.length >= 3) performSearch(query, results);
    }
    if (e.key === 'Escape') hideResults(results);
  });

  // Cerrar dropdown al hacer click fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) hideResults(results);
  });
}

/**
 * Llama a Nominatim y renderiza los resultados.
 * @param {string}      query
 * @param {HTMLElement} resultsEl
 */
async function performSearch(query, resultsEl) {
  showToast('Buscando...');

  const params = new URLSearchParams({
    q:              query,
    format:         'json',
    limit:          6,
    addressdetails: 1,
    // Priorizar Colombia pero no excluir otros resultados
    // (útil si el usuario busca un lugar fuera de Colombia)
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
      renderResults(data2, resultsEl);
    } else {
      renderResults(data, resultsEl);
    }
  } catch (err) {
    console.error('[Search]', err);
    showToast('⚠️ Error al conectar con el buscador');
    hideResults(resultsEl);
  }
}

/**
 * Dibuja la lista de resultados en el dropdown.
 * @param {Array}       data
 * @param {HTMLElement} resultsEl
 */
function renderResults(data, resultsEl) {
  resultsEl.innerHTML = '';

  if (!data.length) {
    const li = document.createElement('li');
    li.textContent = 'No se encontraron resultados';
    li.style.color = 'var(--text-muted)';
    li.style.cursor = 'default';
    resultsEl.appendChild(li);
    resultsEl.hidden = false;
    return;
  }

  data.forEach((item) => {
    const li = document.createElement('li');

    // Nombre corto: priorizar display_name truncado
    const name = item.display_name.split(',').slice(0, 3).join(', ');
    li.textContent = name;
    li.title       = item.display_name;

    li.addEventListener('click', () => {
      selectResult(item, name);
      hideResults(resultsEl);
      document.getElementById('search-input').value = name;
    });

    resultsEl.appendChild(li);
  });

  resultsEl.hidden = false;
}

/**
 * Centra el mapa en el resultado seleccionado y abre el panel.
 * @param {Object} item - Resultado de Nominatim
 * @param {string} name - Nombre formateado para mostrar
 */
function selectResult(item, name) {
  const lat = parseFloat(item.lat);
  const lng = parseFloat(item.lon);

  mapInstance.flyTo([lat, lng], 12, { duration: 1.2 });

  openPanel(
    { lat, lng },
    name,
    item.address?.country || 'Colombia'
  );
}

function hideResults(resultsEl) {
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
}
