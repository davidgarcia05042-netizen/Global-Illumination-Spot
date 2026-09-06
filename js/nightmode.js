/**
 * nightmode.js — Modo de observación nocturna (RF09)
 *
 * Alterna una paleta roja/oscura de bajo brillo (definida en css/styles.css
 * bajo `html.night-mode`) para preservar la adaptación de la vista del
 * observador en campo. La preferencia se persiste en localStorage y se
 * aplica antes de la primera interacción del usuario.
 */

const STORAGE_KEY = 'gis-night-mode';

export function initNightMode() {
  const btn = document.getElementById('night-mode-btn');
  if (!btn) return;

  const enabled = localStorage.getItem(STORAGE_KEY) === '1';
  applyState(enabled, btn);

  btn.addEventListener('click', () => {
    const next = !document.documentElement.classList.contains('night-mode');
    applyState(next, btn);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  });
}

function applyState(enabled, btn) {
  document.documentElement.classList.toggle('night-mode', enabled);
  btn.classList.toggle('active', enabled);
  btn.setAttribute('aria-pressed', String(enabled));
  btn.title = enabled ? 'Desactivar modo de observación nocturna' : 'Activar modo de observación nocturna';
}
