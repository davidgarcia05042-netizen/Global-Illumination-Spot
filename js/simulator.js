/**
 * simulator.js — Simulador interactivo de condiciones
 *
 * Responsabilidades:
 *  - Escuchar los tres sliders del panel (nubosidad, Bortle, luna)
 *  - Cuando el predictor termina su cálculo real, inicializar los sliders
 *    con esos valores para que el usuario parta de la realidad
 *  - Recalcular en tiempo real el porcentaje de éxito simulado al mover
 *    cualquier slider, sin tocar el gauge principal (que muestra la predicción real)
 *  - Mostrar el resultado simulado en el campo "Resultado simulado"
 *  - Colorear el resultado según el mismo umbral verde/ámbar/rojo
 */

import { calculateSuccess } from './predictor.js';

export function initSimulator() {
  const sliderClouds = document.getElementById('sim-clouds');
  const sliderBortle = document.getElementById('sim-bortle');
  const sliderMoon   = document.getElementById('sim-moon');

  const valClouds    = document.getElementById('sim-clouds-val');
  const valBortle    = document.getElementById('sim-bortle-val');
  const valMoon      = document.getElementById('sim-moon-val');
  const resultEl     = document.getElementById('sim-result');

  if (!sliderClouds || !sliderBortle || !sliderMoon) return;

  // Cuando el predictor termina, sincronizar sliders con valores reales
  document.addEventListener('gis:conditions-loaded', (e) => {
    const { clouds, moon, bortle } = e.detail;

    sliderClouds.value = clouds;
    sliderBortle.value = bortle;
    sliderMoon.value   = moon;

    updateLabels();
    updateSimResult();
  });

  // Listeners de los sliders
  sliderClouds.addEventListener('input', () => { updateLabels(); updateSimResult(); });
  sliderBortle.addEventListener('input', () => { updateLabels(); updateSimResult(); });
  sliderMoon.addEventListener('input',   () => { updateLabels(); updateSimResult(); });

  // Actualizar etiquetas de valor junto al slider
  function updateLabels() {
    valClouds.textContent = `${sliderClouds.value}%`;
    valBortle.textContent = `Bortle ${sliderBortle.value}`;
    valMoon.textContent   = `${sliderMoon.value}%`;
  }

  // Recalcular y mostrar el resultado simulado
  function updateSimResult() {
    const clouds  = parseInt(sliderClouds.value);
    const bortle  = parseInt(sliderBortle.value);
    const moon    = parseInt(sliderMoon.value);

    const percent = calculateSuccess(clouds, moon, bortle);
    resultEl.textContent = `${percent}%`;

    // Color del resultado según umbrales
    if (percent >= 70) {
      resultEl.style.color = 'var(--good)';
    } else if (percent >= 40) {
      resultEl.style.color = 'var(--medium)';
    } else {
      resultEl.style.color = 'var(--bad)';
    }
  }

  // Estado inicial
  updateLabels();
  updateSimResult();
}
