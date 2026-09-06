/**
 * config.example.js — Plantilla de configuración (RNF07)
 *
 * En producción (Netlify), js/config.js se genera automáticamente en el
 * build a partir de variables de entorno (ver netlify.toml). Ese archivo
 * generado NUNCA se sube al repositorio (ver .gitignore).
 *
 * Para desarrollo local:
 *   1. Copia este archivo como js/config.js
 *   2. Reemplaza los valores por los tuyos
 *
 * Si dejas algo vacío, la aplicación degrada con elegancia en vez de
 * romperse: sin OWM_API_KEY, clima simulado y capa de nubosidad
 * deshabilitada; sin GEE_TILE_URL, capa de contaminación lumínica
 * deshabilitada (el resto del mapa sigue funcionando normalmente).
 */

// API key gratuita de https://openweathermap.org/api
export const OWM_API_KEY = '';

// URL de teselas de Google Earth Engine (capa VIIRS de contaminación
// lumínica). Se genera desde code.earthengine.google.com — ver README,
// sección "Regenerar la capa de contaminación lumínica (VIIRS)".
// Debe conservar el patrón "{z}/{x}/{y}" literal al final, ej.:
// 'https://earthengine.googleapis.com/v1/projects/TU-PROYECTO/maps/TU-HASH/tiles/{z}/{x}/{y}'
export const GEE_TILE_URL = '';
