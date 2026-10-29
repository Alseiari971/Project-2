import { raw } from './lib.js';

// 24×24 icons. Line icons use the stroke; the sidebar's solid icons set their own fill.
const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/>',
  'star-outline': '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  bag: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sort: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  // Solid icons for the sidebar, like a game launcher's.
  'solid-home': '<path d="M12 2.5 2 10.6V21h7.5v-6.5h5V21H22V10.6z" fill="currentColor" stroke="none"/>',
  'solid-browse': '<circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none"/><path d="m15.8 8.2-2.4 5.2-5.2 2.4 2.4-5.2z" fill="var(--sidebar-bg)" stroke="none"/>',
  'solid-library': '<rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor" stroke="none"/><rect x="13" y="3" width="8" height="8" rx="2" fill="currentColor" stroke="none"/><rect x="3" y="13" width="8" height="8" rx="2" fill="currentColor" stroke="none"/><rect x="13" y="13" width="8" height="8" rx="2" fill="currentColor" stroke="none"/>',
  'solid-users': '<circle cx="9" cy="7.5" r="4" fill="currentColor" stroke="none"/><path d="M1.5 21c0-4.3 3.2-7 7.5-7s7.5 2.7 7.5 7z" fill="currentColor" stroke="none"/><circle cx="17.5" cy="8.5" r="3" fill="currentColor" stroke="none"/><path d="M18 21h4.5c0-3.4-2-5.6-5-6.1 1.6 1.4 2.5 3.4 2.5 6.1z" fill="currentColor" stroke="none"/>',
  'solid-import': '<path d="M10.5 3h3v8.3l3-3 2.1 2.1L12 17l-6.6-6.6 2.1-2.1 3 3z" fill="currentColor" stroke="none"/><rect x="3" y="18.5" width="18" height="2.5" rx="1.2" fill="currentColor" stroke="none"/>',
  'solid-tag': '<path d="M3 3h8.6L21 12.4 12.4 21 3 11.6zM7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" fill="currentColor" stroke="none" fill-rule="evenodd"/>',
};

export const icon = (name, cls = '') =>
  raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`);
