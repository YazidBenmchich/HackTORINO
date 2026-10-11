// Tous les paramètres réglables de la simulation.
// Unités : mètres, secondes, degrés.
// Repère : +Y = haut, -Z = nord, +Z = sud, +X = est.

export const CONFIG = {
  plant: {
    // Trois zones identiques de rows × cols panneaux, alignées d'ouest en est
    zones: [
      { id: 'A', name: 'Zone A', center: { x: -24, z: 0 } },
      { id: 'B', name: 'Zone B', center: { x: 0, z: 0 } },
      { id: 'C', name: 'Zone C', center: { x: 24, z: 0 } },
    ],
    rows: 4,
    cols: 5,
    panelWidth: 2.0,        // côté long (est-ouest)
    panelLength: 1.0,       // côté incliné (nord-sud)
    tiltDeg: 30,            // inclinaison vers le sud
    colGap: 1.0,            // espace entre deux panneaux d'une même rangée
    rowGap: 4.5,            // espace entre deux rangées (évite l'ombrage)
    lowEdgeHeight: 0.6,     // hauteur du bord bas du panneau au-dessus du sol
    defectsPerZone: { min: 3, max: 4 },
    structDefectsPerZone: { min: 2, max: 3 }, // pieds / fondations endommagés
  },

  base: { x: 0, z: 17, padRadius: 1.4, padHeight: 0.15 },

  drone: {
    transitAltitude: 7.0,   // altitude de croisière (sol)
    hopHeight: 1.6,         // hauteur au-dessus du centre du panneau pour les sauts courts
    safeHeight: 2.0,        // en dessous : le drone remonte avant de se déplacer latéralement
    strafeDistance: 6.5,    // en dessous : déplacement latéral sans changer de cap
    // Analyse rapprochée : trajectoire en U le long des grands côtés du panneau
    scanStandoff: 0.65,     // distance caméra ↔ verre, selon la normale du panneau (vue perpendiculaire)
    scanSpeed: 0.7,         // m/s le long du panneau
    scanEdgeOffset: 0.25,   // décalage des deux passes par rapport à l'axe du panneau
    scanOvershoot: 0.12,    // dépassement au-delà des petits côtés
    maxSpeed: 5.0,          // m/s horizontal
    maxClimbSpeed: 2.0,     // m/s vertical
    landingSpeed: 0.9,      // m/s vertical en fin d'atterrissage
    maxAccel: 3.2,          // m/s²
    brakeDecel: 2.2,        // m/s² utilisé pour le profil de freinage
    jerkRate: 5.0,          // lissage de l'accélération (1/s) — plus bas = plus doux
    maxYawRate: 75,         // °/s
    maxTiltDeg: 16,         // inclinaison max du corps
    tiltPerAccel: 4.2,      // ° d'inclinaison par m/s²
    tiltPerSpeed: 0.9,      // ° d'inclinaison par m/s (traînée)
    spoolUpTime: 1.4,       // montée en régime des moteurs avant décollage
    stabilizeTime: 0.6,     // stabilisation avant scan
    defectHoldTime: 5,      // examen prolongé devant un défaut (s)
    zoneOverviewAltitude: 22, // altitude du survol de zone (vue d'ensemble)
    terrainSurveyAltitude: 9, // altitude d'inspection du terrain (caméra à la verticale)
    // Inspection des structures : vol bas dans les allées, arrêt devant chaque pied
    structure: {
      backAltitude: 0.95,   // hauteur caméra côté nord (pieds arrière, hauts)
      frontAltitude: 0.6,   // hauteur caméra côté sud (pieds avant, courts)
      backStandoff: 1.5,    // distance horizontale caméra ↔ pied, côté nord
      frontStandoff: 1.35,  // distance horizontale caméra ↔ pied, côté sud
      crossClearance: 0.9,  // marge au-dessus du bord haut du panneau pour le franchir
      legHold: 0.8,         // arrêt devant chaque pied (s)
      speed: 0.8,           // m/s entre deux pieds
      crossSpeed: 1.4,      // m/s pendant le franchissement du panneau
    },
    // Pilotage manuel à distance (console opérateur)
    pilot: {
      maxSpeed: 6.0,        // m/s horizontal, manche en butée
      maxClimb: 2.5,        // m/s vertical
      yawRate: 70,          // °/s
      deadman: 0.6,         // s sans consigne -> freinage et maintien
      minAlt: 0.8,          // plancher hors des zones (m)
      minAltPanels: 2.2,    // plancher au-dessus des zones de panneaux (m)
      maxAlt: 40,           // plafond (m)
      geofence: 120,        // périmètre autorisé |x|, |z| (m)
    },
    minTakeoffBattery: 25,  // % minimum pour décoller
    hoverBob: 0.035,        // amplitude du flottement (m)
    batteryDrainPerSec: 0.22,
  },

  camera: {
    feedFov: 52,
    feedWidthRatio: 0.30,   // largeur de l'incrustation / largeur de la fenêtre
    feedMinWidth: 300,
    gimbalRestPitch: -8,     // au sol
    gimbalTransitPitch: -35,
    // pendant l'analyse, la caméra vise perpendiculairement au verre : -(90° - inclinaison)
  },

  render: {
    maxPixelRatio: 1.75,
    shadowMapSize: 2048,
    shadowRadius: 3,
    exposure: 0.62,
  },

  network: {
    wsPath: '/ws',
    statusHz: 5,
  },

  thermal: {
    minTemp: 12,            // °C associés à la valeur de chaleur 0
    maxTemp: 82,            // °C associés à la valeur de chaleur 1
  },
};

export const STATE_LABELS = {
  IDLE: 'Landed',
  TAKEOFF: 'Take-off',
  TRANSIT: 'Transit',
  POSITIONING: 'Positioning',
  SCANNING: 'Scanning',
  HOVER: 'Hovering',
  MANUAL: 'Manual control',
  OVERVIEW: 'Zone survey',
  RETURN: 'Returning',
  LANDING: 'Landing',
};

export const PANEL_STATUS = {
  pending: { label: 'not scanned', color: '#59626d' },
  scanning: { label: 'in progress', color: '#d0952e' },
  ok: { label: 'OK', color: '#3c9d68' },
  defect: { label: 'defect', color: '#cf4a43' },
};

export const INSPECTION_TYPES = {
  modules: 'Modules',
  structure: 'Structures',
};

export const STRUCT_DEFECT_TYPES = {
  corrosion: 'corroded leg',
  deformation: 'bent leg',
  fissure: 'cracked footing',
};

export const DEFECT_TYPES = {
  hotspot: 'hot spot',
  crack: 'cracked cell',
  soiling: 'soiling',
};
