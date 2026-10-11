// Catalogue des incidents simulables (démonstration pilotée par l'équipe).
// Chaque scénario dit ce qui le détecte sur le terrain, ce que fait le drone et ce qu'il trouve.
// Textes affichés en anglais (jury international).
//
//   kind       current   : détecté par la mesure du courant du module (optimiseur / onduleur)
//              structure : détecté par un capteur de structure ou la météo, inspection des pieds
//              terrain   : détecté par la météo, l'onduleur ou les courants, survol du sol
//   target     panel : un module choisi · zone : une zone choisie (emplacement tiré dans la zone)
//   inspection modules | structure | terrain (survol caméra verticale)

export const SCENARIOS = [
  // ---------------------------------------------------------------- modules (current drop)
  {
    id: 'hotspot', group: 'modules', kind: 'current', target: 'panel', inspection: 'modules', fault: 'hotspot',
    title: 'Hot spot', severity: 'critical',
    sensor: 'Module current (optimizer)',
    detection: 'Current falls to −35%: warning at −6%, critical at −15%.',
    response: 'Close-range module scan with thermal check of the cell.',
    finding: 'Hot spot (overheating cell, bypass diode).',
    action: { title: 'Module replacement', detail: 'Hot spot confirmed by thermography: check the bypass diode, replace the module.', priority: 'high', duration: '2 h' },
  },
  {
    id: 'crack', group: 'modules', kind: 'current', target: 'panel', inspection: 'modules', fault: 'crack',
    title: 'Cracked cell', severity: 'critical',
    sensor: 'Module current (optimizer)',
    detection: 'Drop down to −21% (critical).',
    response: 'Close-range module scan.',
    finding: 'Cracked cell (visible micro-cracks).',
    action: { title: 'Module replacement', detail: 'Visible cracked cell: replace the module before the crack spreads.', priority: 'high', duration: '2 h' },
  },
  {
    id: 'soiling', group: 'modules', kind: 'current', target: 'panel', inspection: 'modules', fault: 'soiling',
    title: 'Soiling, bird droppings', severity: 'warning',
    sensor: 'Module current (optimizer)',
    detection: 'Slow drop of about −12% (watch).',
    response: 'Close-range module scan.',
    finding: 'Local soiling.',
    action: { title: 'Module cleaning', detail: 'Local soiling (dust, droppings): clean with demineralised water.', priority: 'normal', duration: '30 min' },
  },
  {
    id: 'electrical', group: 'modules', kind: 'current', target: 'panel', inspection: 'modules', fault: 'electrical',
    title: 'Electrical fault', severity: 'critical',
    sensor: 'Module current (optimizer)',
    detection: 'Fast drop of about −30%, no visible cause.',
    response: 'Close-range module scan.',
    finding: 'Nothing visible: the cause is electrical.',
    action: { title: 'Electrical check', detail: 'Nothing visible from the drone: check MC4 connectors, bypass diode and string wiring.', priority: 'high', duration: '1 h' },
  },

  // ---------------------------------------------------------------- structures (legs, beams, foundations)
  {
    id: 'tilt', group: 'structure', kind: 'structure', target: 'panel', inspection: 'structure', struct: 'deformation',
    title: 'Abnormal tilt', severity: 'critical',
    sensor: 'Table inclinometer',
    reading: 'Tilt 32.6° vs 30.0° nominal (+2.6°)',
    detection: 'More than 1.5° away from the nominal tilt.',
    response: 'Low flight in the aisle, stop in front of each of the 4 legs and their footing.',
    finding: 'Bent leg (buckling).',
    action: { title: 'Leg replacement', detail: 'Buckled leg: prop the table, replace the leg, check fastener torque.', priority: 'high', duration: '3 h' },
  },
  {
    id: 'settlement', group: 'structure', kind: 'structure', target: 'panel', inspection: 'structure', struct: 'fissure',
    title: 'Footing settlement', severity: 'warning',
    sensor: 'Table inclinometer (slow drift)',
    reading: '0.9° drift over 30 days',
    detection: 'Continuous tilt drift without any wind event.',
    response: 'Inspection of the module legs and footings.',
    finding: 'Cracked footing.',
    action: { title: 'Footing repair', detail: 'Cracked, tilted footing: concrete repair and table realignment.', priority: 'normal', duration: '1 day' },
  },
  {
    id: 'corrosion', group: 'structure', kind: 'structure', target: 'panel', inspection: 'structure', struct: 'corrosion',
    title: 'Corrosion', severity: 'warning',
    sensor: 'Weather station (humidity, fog)',
    reading: 'Humidity > 90% for 120 h cumulated',
    detection: 'Cumulated corrosive exposure above the inspection threshold.',
    response: 'Leg inspection of the most exposed module.',
    finding: 'Corroded leg.',
    action: { title: 'Anti-corrosion treatment', detail: 'Brush, treat and paint the leg; check the remaining steel section.', priority: 'normal', duration: '2 h' },
  },
  {
    id: 'storm', group: 'structure', kind: 'structure', target: 'zone', inspection: 'structure', struct: 'deformation',
    title: 'Wind storm', severity: 'critical',
    sensor: 'Plant anemometer',
    reading: 'Gust at 96 km/h (design limit 70 km/h)',
    detection: 'Gust above the design limit: preventive inspection of exposed structures.',
    response: 'Waits for the gusts to end (no flight above 36 km/h), then inspects the legs of 3 edge modules.',
    finding: 'Bent leg on one of the exposed modules.',
    action: { title: 'Leg replacement', detail: 'Leg buckled by the wind: prop, replace the leg, check the neighbouring tables.', priority: 'high', duration: '3 h' },
  },

  // ---------------------------------------------------------------- terrain
  {
    id: 'rain', group: 'terrain', kind: 'terrain', target: 'zone', inspection: 'terrain', terrain: 'erosion',
    title: 'Heavy rain', severity: 'warning',
    sensor: 'Rain gauge',
    reading: '48 mm in 1 h (threshold 30 mm)',
    detection: 'Rainfall above the run-off threshold.',
    response: 'Ground survey of the zone, camera pointing straight down.',
    finding: 'Erosion gully in an aisle.',
    action: { title: 'Fill and drainage', detail: 'Fill the gully, regrade the aisle, check the nearby footings.', priority: 'normal', duration: '1 day' },
  },
  {
    id: 'vegetation', group: 'terrain', kind: 'terrain', target: 'zone', inspection: 'terrain', terrain: 'vegetation',
    title: 'Vegetation shading', severity: 'warning',
    sensor: 'South row currents',
    reading: '3 to 4 neighbouring modules between −8 and −11%',
    detection: 'Grouped drop on neighbouring bottom-row modules: a shading pattern.',
    response: 'Survey of the foot of the row.',
    finding: 'Overgrown vegetation in front of the modules.',
    action: { title: 'Vegetation clearing', detail: 'Clear the foot of the row (shading and fire risk).', priority: 'normal', duration: '2 h' },
  },
  {
    id: 'isolation', group: 'terrain', kind: 'terrain', target: 'zone', inspection: 'terrain', terrain: 'water',
    title: 'Insulation fault', severity: 'critical',
    sensor: 'Zone inverter (Riso)',
    reading: 'Insulation resistance 180 kΩ (threshold 1 MΩ)',
    detection: 'Leakage current to ground: the inverter reports an insulation fault.',
    response: 'Ground survey of the zone, looking for water or damaged cables.',
    finding: 'Standing water around the cables.',
    action: { title: 'Drainage and cable check', detail: 'Drain the water, check junction boxes and conduits, measure insulation.', priority: 'high', duration: '4 h' },
  },
  {
    id: 'subsidence', group: 'terrain', kind: 'terrain', target: 'zone', inspection: 'terrain', terrain: 'subsidence',
    title: 'Ground subsidence', severity: 'warning',
    sensor: 'Inclinometers of several tables',
    reading: '3 neighbouring tables tilted by 0.6 to 0.9°',
    detection: 'Correlated drift of several neighbouring inclinometers.',
    response: 'Ground survey of the zone.',
    finding: 'Ground subsidence in an aisle.',
    action: { title: 'Geotechnical survey', detail: 'Have the ground assessed, monitor the nearby footings.', priority: 'normal', duration: '2 days' },
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
