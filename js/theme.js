/**
 * theme.js — Tema claro / oscuro (RF09)
 *
 * Alterna la clase `html.light-theme` (paleta definida en css/styles.css)
 * y emite 'gis:theme-change' para que map.js cambie el mapa base.
 *
 * Prioridad del tema:
 *   1. La elección explícita del usuario (botón), guardada en localStorage.
 *   2. Si nunca eligió: el tema del sistema/navegador (prefers-color-scheme),
 *      siguiéndolo en vivo si cambia mientras la app está abierta.
 *   3. Oscuro, si el navegador no informa preferencia.
 *
 * El script inline de index.html ya aplicó el tema inicial antes del
 * primer pintado con esta misma regla; aquí solo se sincroniza el botón.
 *
 * Sustituye al antiguo "modo de observación nocturna" (paleta roja).
 */

const STORAGE_KEY  = 'gis-theme';
const THEME_COLORS = { dark: '#0D1B2A', light: '#F4F7FA' };
const systemLight  = window.matchMedia('(prefers-color-scheme: light)');

export function initTheme() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;

  // Preferencia del antiguo modo nocturno: ya no aplica
  safeStorage(() => localStorage.removeItem('gis-night-mode'));

  syncButton(btn, getTheme());

  btn.addEventListener('click', () => {
    const next = getTheme() === 'light' ? 'dark' : 'light';
    safeStorage(() => localStorage.setItem(STORAGE_KEY, next));
    setTheme(next, btn);
  });

  // Seguir al sistema solo mientras el usuario no haya elegido a mano
  systemLight.addEventListener('change', (e) => {
    if (getStoredTheme()) return;
    setTheme(e.matches ? 'light' : 'dark', btn);
  });
}

/** @returns {'light'|'dark'} tema activo según la clase de <html> */
export function getTheme() {
  return document.documentElement.classList.contains('light-theme') ? 'light' : 'dark';
}

function setTheme(theme, btn) {
  if (theme === getTheme()) return;
  document.documentElement.classList.toggle('light-theme', theme === 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  syncButton(btn, theme);
  document.dispatchEvent(new CustomEvent('gis:theme-change', { detail: { theme } }));
}

function getStoredTheme() {
  let stored = null;
  safeStorage(() => { stored = localStorage.getItem(STORAGE_KEY); });
  return stored;
}

function syncButton(btn, theme) {
  const isLight = theme === 'light';
  btn.setAttribute('aria-pressed', String(isLight));
  btn.title = isLight ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
}

// localStorage puede lanzar en modo privado o con datos de sitio bloqueados
function safeStorage(fn) {
  try { fn(); } catch { /* sin persistencia: el tema dura solo esta sesión */ }
}
