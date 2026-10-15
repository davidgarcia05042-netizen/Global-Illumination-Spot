/**
 * guide.js — Guía de uso integrada (RF13)
 *
 * Responsabilidades:
 *  - Botón "?" del header y, en ≤480px, un botón flotante bajo el zoom de
 *    Leaflet (a 360px el del header dejaba el buscador con ~45px útiles)
 *  - Abrir la guía en un <dialog> modal (showModal): Esc cierra, el foco
 *    queda atrapado dentro y vuelve al botón que la abrió al cerrar
 *  - Cargar partials/guide.html con fetch la primera vez que se abre
 *  - Índice generado desde las <section id="ayuda-..."> del contenido:
 *    resalta la sección visible (IntersectionObserver) y hace scroll suave
 *  - Enlace directo: #ayuda o #ayuda-<seccion> abre la guía al cargar; al
 *    cerrar se limpia el hash con history.replaceState (sin recargar)
 *
 * Funcionalidad aislada: no toca el mapa, el panel ni los eventos gis:*.
 */

import { icon } from './icons.js';

const PARTIAL_URL    = 'partials/guide.html';
const HASH           = 'ayuda';
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
const FOCUSABLE      = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';
const SCROLL_LOCK_MS = 900; // tras saltar a una sección, ignorar el observer mientras dura el scroll

let dialog     = null;
let contentEl  = null;
let tocEl      = null;
let headerBtn  = null;
let fabBtn     = null;
let opener     = null;  // botón que abrió la guía: recibe el foco al cerrar
let loading    = null;  // promesa de carga en curso o resuelta (null = reintentar)
let observer   = null;
let scrollLock = null;  // id de la sección a la que se está haciendo scroll
let activeId   = null;  // sección resaltada ahora en el índice

export function initGuide() {
  dialog    = document.getElementById('guide-dialog');
  headerBtn = document.getElementById('guide-btn');
  if (!dialog || !headerBtn || typeof dialog.showModal !== 'function') return;

  contentEl = dialog.querySelector('.guide-content');
  tocEl     = dialog.querySelector('.guide-toc');

  headerBtn.addEventListener('click', () => openGuide(null, headerBtn));
  fabBtn = createFloatingButton();

  dialog.querySelector('.guide-close').addEventListener('click', () => dialog.close());
  // Clic en el fondo oscurecido (fuera de la caja del diálogo) también cierra.
  // El destino debe ser el propio <dialog>: los clics generados por teclado
  // (Enter en un enlace o botón) llegan con coordenadas 0,0 y, sin esta
  // condición, cerrarían la guía al navegar con teclado.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('keydown', trapFocus);
  dialog.addEventListener('close', onClose);   // Esc dispara 'cancel' y luego 'close'
  contentEl.addEventListener('scroll', onContentScroll, { passive: true });

  // Enlace directo al cargar, y si el hash cambia con la app abierta
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

// ── Botón flotante (≤480px) ────────────────────────────────────

/**
 * Botón "?" dentro de la esquina superior izquierda de Leaflet, debajo del
 * zoom. El CSS muestra este o el del header según el ancho de pantalla.
 */
function createFloatingButton() {
  const corner = document.querySelector('#map .leaflet-top.leaflet-left');
  if (!corner || !window.L) return null;

  const wrap = document.createElement('div');
  wrap.className = 'leaflet-control guide-fab';
  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'icon-btn';
  btn.title     = 'Guía de uso';
  btn.setAttribute('aria-label', 'Guía de uso');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = icon('circle-help', 18);
  wrap.appendChild(btn);
  corner.appendChild(wrap);

  // Que el clic no llegue al mapa (abriría el panel para ese punto)
  L.DomEvent.disableClickPropagation(wrap);
  btn.addEventListener('click', () => openGuide(null, btn));
  return btn;
}

/** El botón "?" que se ve ahora (header o flotante, según el ancho) */
function visibleGuideButton() {
  if (fabBtn && fabBtn.offsetParent !== null) return fabBtn;
  return headerBtn;
}

// ── Abrir / cerrar ─────────────────────────────────────────────

/**
 * @param {string|null} sectionId - id "ayuda-<slug>" al que saltar; '' para
 *   el inicio de la guía (#ayuda); null para conservar la posición anterior
 *   (apertura con el botón "?")
 * @param {HTMLElement} [from]    - botón que la abre (para devolverle el foco)
 */
async function openGuide(sectionId, from) {
  if (!dialog.open) {
    opener = from || visibleGuideButton();
    dialog.showModal();
  }
  await ensureContent();
  if (sectionId) {
    scrollToSection(sectionId, false);
  } else if (sectionId === '') {
    const first = contentEl.querySelector('section[id^="ayuda-"]');
    if (first) scrollToSection(first.id, false);
    history.replaceState(null, '', `#${HASH}`);
  }
}

function onClose() {
  // El observer sigue conectado: con el diálogo cerrado no reporta nada y
  // al reabrir vuelve a resaltar sin reconstruir el índice
  // Quitar #ayuda... de la URL sin recargar ni crear entrada en el historial
  if (location.hash.slice(1).startsWith(HASH)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  const target = opener && document.contains(opener) && opener.offsetParent !== null
    ? opener
    : visibleGuideButton();
  target?.focus();
  opener = null;
}

/** #ayuda → '' (inicio); #ayuda-<slug> → su id; cualquier otro hash → null */
function sectionFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === HASH) return '';
  if (hash.startsWith(`${HASH}-`)) return hash;
  return null;
}

function openFromHash() {
  const id = sectionFromHash();
  if (id === null) return;
  openGuide(id); // '' = inicio de la guía (no convertir a null)
}

// Con showModal() el resto de la página ya es inerte; esto además hace que
// Tab circule dentro del diálogo en vez de salir a la barra del navegador
function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last  = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── Carga del contenido ────────────────────────────────────────

function ensureContent() {
  if (!loading) loading = loadContent();
  return loading;
}

async function loadContent() {
  contentEl.innerHTML = '<p class="guide-status">Cargando la guía...</p>';
  try {
    const res = await fetch(PARTIAL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    contentEl.innerHTML = await res.text(); // archivo propio del sitio
    buildToc();
  } catch {
    // Sin error en consola: se avisa dentro del diálogo y se permite reintentar
    loading = null;
    contentEl.innerHTML = `
      <div class="guide-status">
        <p>No se pudo cargar la guía. Revisa tu conexión e inténtalo de nuevo.</p>
        <button type="button" class="guide-retry">Reintentar</button>
      </div>`;
    contentEl.querySelector('.guide-retry').addEventListener('click', ensureContent);
  }
}

// ── Índice ─────────────────────────────────────────────────────

function buildToc() {
  const sections = [...contentEl.querySelectorAll('section[id^="ayuda-"]')];
  const list = document.createElement('ul');
  list.className = 'guide-toc-list';

  sections.forEach((section) => {
    const li = document.createElement('li');
    const a  = document.createElement('a');
    a.href           = `#${section.id}`;
    a.className      = 'guide-toc-link';
    a.dataset.target = section.id;
    a.textContent    = section.querySelector('h2')?.textContent.trim() || section.id;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToSection(section.id, true);
    });
    li.appendChild(a);
    list.appendChild(li);
  });

  tocEl.replaceChildren(list);
  activeId = null; // enlaces nuevos: el primer setActive debe marcarlos
  observeSections(sections);
  if (sections[0]) setActive(sections[0].id);
}

// Línea de lectura: la sección activa es la última cuyo inicio ya la cruzó
const READING_LINE = 0.3; // fracción de la altura del área de lectura

/**
 * El IntersectionObserver avisa cuando una sección cruza la línea de
 * lectura (franja superior del 30 %); quien decide cuál resaltar es
 * updateActive(), que también corre en el scroll.
 */
function observeSections(sections) {
  observer?.disconnect();
  observer = new IntersectionObserver(updateActive, {
    root: contentEl,
    rootMargin: `0px 0px -${(1 - READING_LINE) * 100}% 0px`,
    threshold: 0,
  });
  sections.forEach((s) => observer.observe(s));
}

// El scroll se necesita para el final del contenido: las últimas secciones,
// si son cortas, nunca cruzan la línea de lectura y el observer no avisa
function onContentScroll() {
  updateActive();
}

/**
 * Única fuente de verdad del resaltado (observer y scroll pasan por aquí;
 * antes el observer, que corre después del scroll, pisaba la última sección).
 */
function updateActive() {
  if (scrollLock) return;
  const sections = [...contentEl.querySelectorAll('section[id^="ayuda-"]')];
  if (!sections.length) return;

  // Extremos: arriba del todo, la primera; al tocar fondo, la última
  if (contentEl.scrollTop <= 0) {
    setActive(sections[0].id);
    return;
  }
  const atBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2;
  if (atBottom) {
    setActive(sections[sections.length - 1].id);
    return;
  }

  const line = contentEl.getBoundingClientRect().top + contentEl.clientHeight * READING_LINE;
  let current = sections[0];
  for (const s of sections) {
    if (s.getBoundingClientRect().top <= line) current = s;
    else break;
  }
  setActive(current.id);
}

function scrollToSection(id, smooth) {
  const section = contentEl.querySelector(`#${CSS.escape(id)}`);
  if (!section) return;
  const animate = smooth && !REDUCED_MOTION.matches;

  // Bloqueo también en el salto instantáneo: si la sección no puede subir
  // hasta arriba (final del contenido), el observer marcaría la anterior
  setActive(id);
  scrollLock = id;
  section.scrollIntoView({ behavior: animate ? 'smooth' : 'auto', block: 'start' });
  setTimeout(() => { if (scrollLock === id) scrollLock = null; }, SCROLL_LOCK_MS);

  // URL compartible mientras la guía está abierta (se limpia al cerrar)
  history.replaceState(null, '', `#${id}`);
}

function setActive(id) {
  if (id === activeId) return; // se llama en cada scroll: no tocar el DOM si no cambió
  activeId = id;
  let activeLink = null;
  tocEl.querySelectorAll('.guide-toc-link').forEach((a) => {
    const on = a.dataset.target === id;
    a.classList.toggle('is-active', on);
    if (on) {
      a.setAttribute('aria-current', 'true');
      activeLink = a;
    } else {
      a.removeAttribute('aria-current');
    }
  });
  if (activeLink) keepVisible(activeLink);
}

/**
 * Mantiene visible el enlace activo dentro del índice: centra el chip en
 * la fila horizontal (móvil) o lo trae a la vista en la columna (escritorio).
 * Scroll instantáneo a propósito: Chrome cancela un scroll suave si se
 * inicia otro a la vez (el del contenido).
 */
function keepVisible(link) {
  if (tocEl.scrollWidth > tocEl.clientWidth) {
    tocEl.scrollLeft = link.offsetLeft - (tocEl.clientWidth - link.offsetWidth) / 2;
  } else if (link.offsetTop < tocEl.scrollTop ||
             link.offsetTop + link.offsetHeight > tocEl.scrollTop + tocEl.clientHeight) {
    tocEl.scrollTop = link.offsetTop - tocEl.clientHeight / 3;
  }
}
