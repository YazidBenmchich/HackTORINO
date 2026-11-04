// Jeu d'icônes de la console : tracés 24×24, trait 1,6, angles vifs (même langage que les filets busbar)

const PATHS = {
  grid: '<path d="M3 4h18v16H3zM3 10.5h18M3 15.5h18M9 4v16M15 4v16"/>',
  drone: '<path d="M9 9h6v6H9zM9 9 5.5 5.5M15 9l3.5-3.5M9 15l-3.5 3.5M15 15l3.5 3.5"/><path d="M2.5 5.5h6M15.5 5.5h6M2.5 18.5h6M15.5 18.5h6"/>',
  panel: '<path d="M4 6h16l2 12H2zM9.3 6l-.8 12M14.7 6l.8 12M3 12h18"/>',
  bell: '<path d="M6 16V10a6 6 0 0 1 12 0v6l2 2H4zM10 20.5h4"/>',
  wrench: '<path d="M14.5 3.5a5 5 0 0 0-4.6 6.9L3.5 16.8l3.7 3.7 6.4-6.4a5 5 0 0 0 6.9-4.6l-3 3-3.6-.9-.9-3.6z"/>',
  sound: '<path d="M4 9.5h4L13 5v14l-5-4.5H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h4L13 5v14l-5-4.5H4zM16.5 9.5l5 5M21.5 9.5l-5 5"/>',
  notify: '<path d="M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  up: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 4v15M6 13l6 6 6-6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  home: '<path d="M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-5h4v5"/>',
  stick: '<path d="M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 9v7M5 16h14v5H5z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  target: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M7 7h10v10H7z"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><path d="M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  flash: '<path d="M13 2 5 13.5h6L10 22l9-12.5h-6z"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  play2: '<path d="M7 5v14l11-7z"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
}

// Remplace les <i data-icon="…"> du document par leur SVG
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon);
  }
}
