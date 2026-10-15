/**
 * predictor.js — Motor predictivo de observación astronómica
 *
 * Escucha el evento 'gis:predict', obtiene datos de clima y Bortle,
 * calcula el porcentaje de éxito y actualiza el gauge y las tarjetas.
 *
 * El panel lateral abre SIEMPRE — este módulo opera de forma completamente
 * asíncrona e independiente, sin bloquear la UI bajo ninguna circunstancia.
 */

import { setGauge, showToast } from './map.js';

// API key de OpenWeatherMap inyectada desde js/config.js (ver RNF07 y
// js/app.js). Si viene vacía, el sistema opera en modo demo.
let OWM_API_KEY = '';

export let currentConditions = {
  clouds: 50,
  moon:   50,
  bortle: 5,
  temp:   20,
};

export function initPredictor(owmApiKey = '') {
  OWM_API_KEY = owmApiKey;

  document.addEventListener('gis:predict', (e) => {
    // setTimeout(0) garantiza que el panel ya esté abierto y visible
    // antes de que empiece cualquier operación asíncrona
    setTimeout(() => {
      runPrediction(e.detail.latlng, e.detail.spot);
    }, 0);
  });
}

async function runPrediction(latlng, spot) {
  // Mostrar estado de carga en las tarjetas
  updateConditionsUI({ clouds: LOADING, moon: LOADING, bortle: LOADING, temp: LOADING });
  setGauge(null);

  try {
    // Clima real o demo si no hay API key
    const weather = await fetchWeather(latlng.lat, latlng.lng);

    // Bortle: del JSON si es marcador registrado, si no estimar por coordenada
    const bortle = (spot && spot.bortle_index)
      ? spot.bortle_index
      : await fetchBortle(latlng.lat, latlng.lng);

    // Fase lunar (cálculo local, sin API)
    const moon = getMoonIllumination();

    currentConditions = {
      clouds: weather.clouds,
      moon,
      bortle,
      temp: weather.temp,
    };

    const percent = calculateSuccess(weather.clouds, moon, bortle);

    updateConditionsUI({
      clouds: `${weather.clouds}%`,
      moon:   `${getMoonPhaseName()} (${Math.round(moon)}%)`,
      bortle: `${bortle}/9`,
      temp:   `${weather.temp}°C`,
    });

    setGauge(percent);

    document.dispatchEvent(
      new CustomEvent('gis:conditions-loaded', { detail: currentConditions })
    );

  } catch (err) {
    console.warn('[Predictor]', err);
    // No se pudo calcular con datos reales: se avisa (RF10/RNF09) y se
    // muestra una estimación neutra sin romper el resto del panel.
    showToast('No se pudo obtener el clima en tiempo real. Mostrando una estimación aproximada.', 3500);
    updateConditionsUI({ clouds: 'N/D', moon: 'N/D', bortle: 'N/D', temp: 'N/D' });
    setGauge(50);
  }
}

// ── Algoritmo ponderado ────────────────────────────────────────
// Bortle 40% + Nubosidad 40% + Luna 20%

export function calculateSuccess(clouds, moon, bortle) {
  const bortleFactor = ((9 - bortle) / 8) * 100;
  const cloudsFactor = 100 - clouds;
  const moonFactor   = 100 - (moon * 0.7);

  const score =
    (bortleFactor * 0.40) +
    (cloudsFactor * 0.40) +
    (moonFactor   * 0.20);

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── OpenWeatherMap ─────────────────────────────────────────────

async function fetchWeather(lat, lng) {
  if (!OWM_API_KEY) {
    // Modo demo: valores simulados realistas
    return {
      clouds: Math.floor(Math.random() * 60),
      temp:   Math.floor(Math.random() * 15) + 12,
    };
  }

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OWM_API_KEY}&units=metric`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OWM ${res.status}`);
  const data = await res.json();

  return {
    clouds: data.clouds?.all ?? 0,
    temp:   Math.round(data.main?.temp ?? 20),
  };
}

// ── Bortle via Light Pollution Map ─────────────────────────────
// NOTA: la API QueryRaster exige una key desde hace tiempo; sin ella
// responde texto plano ("Invalid or missing authentication"), res.json()
// falla y se usa el valor conservador (Bortle 5). Los spots del catálogo
// no dependen de esto porque traen su propio bortle_index.

async function fetchBortle(lat, lng) {
  try {
    const url  = `https://www.lightpollutionmap.info/QueryRaster/?ql=wa_2015&qt=point&qd=${lng},${lat}`;
    const res  = await fetch(url);
    const data = await res.json();
    return radianceToBortle(data?.result ?? -1);
  } catch {
    return 5; // valor conservador si la API falla
  }
}

function radianceToBortle(r) {
  if (r < 0)    return 5;
  if (r < 0.01) return 1;
  if (r < 0.05) return 2;
  if (r < 0.15) return 3;
  if (r < 0.50) return 4;
  if (r < 1.50) return 5;
  if (r < 5.0)  return 6;
  if (r < 15.0) return 7;
  if (r < 50.0) return 8;
  return 9;
}

// ── Fase lunar ─────────────────────────────────────────────────

const MOON_CYCLE = 29.53058867;
const KNOWN_NEW  = new Date('2024-01-11T11:57:00Z'); // luna nueva de referencia (UTC)

// Edad de la luna en días desde la última luna nueva (0 – 29.53)
function getMoonAge() {
  const days = (new Date() - KNOWN_NEW) / 86400000;
  return ((days % MOON_CYCLE) + MOON_CYCLE) % MOON_CYCLE;
}

function getMoonIllumination() {
  return Math.round(50 - 50 * Math.cos((2 * Math.PI * getMoonAge()) / MOON_CYCLE));
}

// El nombre se deriva de la edad (no del % de iluminación), porque el mismo
// porcentaje ocurre dos veces por ciclo: una creciendo y otra menguando.
function getMoonPhaseName() {
  const fraction = getMoonAge() / MOON_CYCLE;
  if (fraction < 0.03 || fraction >= 0.97) return 'Nueva';
  if (fraction < 0.22) return 'Creciente';
  if (fraction < 0.28) return 'Cuarto creciente';
  if (fraction < 0.47) return 'Gibosa creciente';
  if (fraction < 0.53) return 'Llena';
  if (fraction < 0.72) return 'Gibosa menguante';
  if (fraction < 0.78) return 'Cuarto menguante';
  return 'Menguante';
}

// ── UI ─────────────────────────────────────────────────────────

// '...' es el estado de carga: la tarjeta muestra un shimmer (is-loading).
// Cuando llega cualquier otro valor (incluido 'N/D') entra con fade +
// slide-up, escalonada por su posición (--i; ver styles.css).
const LOADING = '...';

function updateConditionsUI({ clouds, moon, bortle, temp }) {
  const set = (id, val, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;

    const card = el.closest('.condition-card');
    if (!card) return;
    card.style.setProperty('--i', i);
    if (val === LOADING) {
      card.classList.remove('is-entering');
      card.classList.add('is-loading');
    } else if (card.classList.contains('is-loading')) {
      card.classList.remove('is-loading');
      card.classList.remove('is-entering');
      void card.offsetWidth; // reinicia la animación de entrada
      card.classList.add('is-entering');
    }
  };
  set('cond-clouds', clouds, 0);
  set('cond-moon',   moon,   1);
  set('cond-bortle', bortle, 2);
  set('cond-temp',   temp,   3);
}
