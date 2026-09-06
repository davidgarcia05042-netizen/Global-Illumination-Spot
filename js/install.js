/**
 * install.js — Instalación de la PWA (RF08)
 *
 * Responsabilidades:
 *  - Capturar 'beforeinstallprompt' (Chrome/Edge/Android) y mostrar un
 *    botón explícito de instalación en el header, oculto por defecto.
 *  - Lanzar el prompt nativo al hacer click y ocultar el botón según el
 *    resultado, o cuando la app ya fue instalada por otra vía.
 *  - En iOS Safari, donde 'beforeinstallprompt' no existe, mostrar una
 *    única vez instrucciones manuales (Compartir → Agregar a inicio).
 */

import { showToast } from './map.js';

export function initInstall() {
  const btn = document.getElementById('install-btn');
  if (!btn) return;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    btn.hidden = true;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'accepted') {
      showToast('¡Instalación en progreso!');
    } else {
      btn.hidden = false; // el usuario canceló: seguir ofreciendo el botón
    }
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    deferredPrompt = null;
    showToast('✦ Global Illumination Spot instalada');
  });

  maybeShowIosInstallHint();
}

// ── Fallback informativo para iOS Safari ────────────────────────
// iOS no dispara 'beforeinstallprompt'; la única forma de instalar es
// manual desde el menú Compartir. Se avisa una sola vez por dispositivo.

function maybeShowIosInstallHint() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const alreadyShown = localStorage.getItem('gis-ios-install-hint-shown') === '1';

  if (!isIos || isStandalone || alreadyShown) return;

  setTimeout(() => {
    showToast('Para instalar: toca Compartir → "Agregar a inicio"', 5000);
    localStorage.setItem('gis-ios-install-hint-shown', '1');
  }, 4000);
}
