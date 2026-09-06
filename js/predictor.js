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
  updateConditionsUI({ clouds: '...', moon: '...', bortle: '...', temp: '...' });
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
      moon:   `${getMoonPhaseName(moon)} (${Math.round(moon)}%)`,
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

function getMoonIllumination() {
  const now       = new Date();
  const KNOWN_NEW = new Date('2024-01-11');
  const CYCLE     = 29.53058867;
  const days      = (now - KNOWN_NEW) / 86400000;
  const phase     = ((days % CYCLE) + CYCLE) % CYCLE;
  return Math.round(50 - 50 * Math.cos((2 * Math.PI * phase) / CYCLE));
}

function getMoonPhaseName(percent) {
  if (percent <= 5)  return 'Nueva';
  if (percent <= 30) return 'Creciente';
  if (percent <= 55) return 'Cuarto creciente';
  if (percent <= 70) return 'Gibosa creciente';
  if (percent <= 85) return 'Casi llena';
  if (percent <= 95) return 'Llena';
  if (percent <= 70) return 'Gibosa menguante';
  return 'Menguante';
}

// ── UI ─────────────────────────────────────────────────────────

function updateConditionsUI({ clouds, moon, bortle, temp }) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set('cond-clouds', clouds);
  set('cond-moon',   moon);
  set('cond-bortle', bortle);
  set('cond-temp',   temp);
}
