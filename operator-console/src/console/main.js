import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/martian-mono';
import { Link } from './link.js';
import { PlantMap } from './plantMap.js';
import { TimeChart } from './charts.js';
import { VideoFeed } from './video.js';
import { PilotInput } from './pilot.js';
import { Notifier, readPref, writePref } from './notify.js';
import { icon, hydrateIcons } from './icons.js';

// ======================================================================== état

const S = {
  link: 'connecting',
  sim: false,               // simulation (drone + centrale) connectée au serveur
  status: null,
  layout: [],
  values: {},               // id -> [courant, tension, puissance, écart, attendu]
  scada: null,
  plantHistory: [],         // [t, puissance, attendue, irradiance]
  panelHistory: {},         // id -> [[courant, attendu], …] (1 Hz)
  alerts: [],
  workOrders: [],
  logs: [],
  settings: { autoDispatch: true, autoFaults: true },
  dispatch: null,
  view: 'supervision',
  sub: null,
  selectedAlert: null,
  drawerPanel: null,
  missionType: 'modules',
  missionZone: '',
  panelFilter: 'all',
  sort: { key: 'id', dir: 1 },
  alertTab: 'active',
  woFilter: 'open',
  // Ancien nom par défaut (version française) remplacé par le nouveau
  operator: ((v) => (v === 'Opérateur de quart' ? 'Operator on duty' : v))(readPref('helio.operator', 'Operator on duty')),
  scenarios: [],
  incidents: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nf1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (dev, digits = 0) => `${dev < -0.0005 ? '−' : dev > 0.0005 ? '+' : ''}${Math.abs(dev * 100).toFixed(digits)}%`;
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function since(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} ago`;
}

const SEV_LABEL = { warning: 'Watch', critical: 'Critical' };
const INSPECT_LABEL = { modules: 'close-range module scan', structure: 'leg and footing inspection', terrain: 'ground survey, camera pointing down' };
const INSPECT_VERB = { modules: 'diagnose the module', structure: 'inspect the structure', terrain: 'survey the ground' };
const KIND_LABEL = { current: 'Module', structure: 'Structure', terrain: 'Terrain' };
const GROUP_TITLE = { modules: 'Modules · current drop', structure: 'Structures · legs, beams, footings', terrain: 'Terrain · ground, water, vegetation' };
const DISPATCH_LABEL = {
  pending: 'Drone about to leave',
  queued: 'Queued',
  waiting: 'Waiting',
  manual: 'Manual dispatch',
  'en-route': 'Drone en route',
  inspecting: 'Inspection in progress',
  done: 'Diagnosed',
  interrupted: 'Dispatch interrupted',
  cancelled: 'Cancelled',
};
const WO_STATUS = { open: 'To schedule', planned: 'Scheduled', done: 'Closed' };
const TEAMS = ['North maintenance team', 'South maintenance team', 'On-call electrician'];
const INSPECTION = { pending: 'Not inspected', scanning: 'In progress', ok: 'Healthy', defect: 'Defect' };

// ======================================================================== services

hydrateIcons();
const link = new Link();
const video = new VideoFeed(link);
const notifier = new Notifier({ host: $('#toasts'), soundBtn: $('#btn-sound'), notifyBtn: $('#btn-notify') });
for (const box of $$('[data-video]')) video.attach(box);

const tooltip = $('#tooltip');
function hoverPanel(id, ev) {
  if (!id) {
    tooltip.hidden = true;
    return;
  }
  const v = S.values[id];
  const sp = S.status?.panels?.find((p) => p.id === id);
  const alert = openAlertFor(id);
  tooltip.innerHTML = `<b>${id}</b>${v ? `<span>${nf2.format(v[0])} A <em>/ ${nf2.format(v[4])} A expected</em></span><span>Deviation ${pct(v[3], 1)}</span>` : ''}${sp ? `<span>${INSPECTION[sp.status]}${sp.defect ? ` · ${esc(sp.defect)}` : ''}</span>` : ''}${alert ? `<span class="t-sev" data-sev="${alert.severity}">${SEV_LABEL[alert.severity]}</span>` : ''}`;
  tooltip.hidden = false;
  const x = Math.min(window.innerWidth - tooltip.offsetWidth - 8, ev.clientX + 14);
  const y = Math.min(window.innerHeight - tooltip.offsetHeight - 8, ev.clientY + 14);
  tooltip.style.transform = `translate(${x}px, ${y}px)`;
}

const maps = {
  sup: new PlantMap($('#map-sup'), { onPanel: (id) => openDrawer(id), onHover: hoverPanel }),
  panels: new PlantMap($('#map-panels'), { onPanel: (id) => openDrawer(id), onHover: hoverPanel }),
  flight: new PlantMap($('#map-flight'), {
    compact: true,
    onPanel: (id) => cmd('goto', { panel: id, type: S.missionType }, `Drone sent to inspect ${id}`),
    onGround: (x, z) => cmd('goto', { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }, `Flying over point ${nf1.format(x)}, ${nf1.format(z)} m`),
  }),
};

const powerChart = new TimeChart($('#chart-power'), { span: 15 * 60_000, fmt: (v) => nf1.format(v / 1000), unit: 'kW', labels: ['Measured', 'Expected'] });

const pilot = new PilotInput({ link, sticksEl: $('#sticks'), gamepadEl: $('#gamepad-state') });

async function cmd(action, params = {}, okTitle) {
  const r = await link.command(action, params);
  if (r.ok === false) notifier.toast({ level: 'warn', title: 'Command refused', text: r.error });
  else if (okTitle) notifier.toast({ level: 'drone', title: okTitle, timeout: 3500 });
  return r;
}

// ======================================================================== liaison

link.addEventListener('link', (ev) => {
  S.link = ev.detail;
  renderLink();
});

link.addEventListener('hello', ({ detail: m }) => {
  S.sim = m.connected;
  S.status = m.status;
  S.settings = m.settings;
  S.alerts = m.alerts;
  S.workOrders = m.workOrders;
  S.logs = m.logs;
  S.dispatch = m.dispatch;
  S.scenarios = m.scenarios || [];
  S.incidents = m.incidents || [];
  S.plantHistory = m.plantHistory || [];
  S.panelHistory = m.panelHistory || {};
  if (m.scada) applyScada(m.scada, false);
  setLayout(m.layout || []);
  powerChart.setData(S.plantHistory.map((h) => [h[0], h[1], h[2]]));
  renderAll();
});

link.addEventListener('status', ({ detail: m }) => {
  const wasSim = S.sim;
  S.sim = m.connected;
  S.status = m.data;
  S.dispatch = m.dispatch;
  if (wasSim !== S.sim) {
    renderLink();
    if (!S.sim) notifier.toast({ level: 'warn', title: 'Drone link lost', text: 'The plant simulation is not responding. Reopen it in another window.' });
  }
  renderStatus();
});

link.addEventListener('scada', ({ detail: m }) => {
  applyScada(m.data, true);
  renderElectrical();
});

link.addEventListener('alert', ({ detail: m }) => {
  upsert(S.alerts, m.alert, true);
  const a = m.alert;
  const cur = a.kind === 'current';
  const measure = cur ? `${nf1.format(a.measured)} A for ${nf1.format(a.expected)} A expected (${pct(a.deviation)})` : `${a.sensor}: ${a.reading}`;
  const view = { label: 'View', primary: true, run: () => go(`alertes/${a.id}`) };
  const watch = { label: 'Video', run: () => go('vol') };
  if (m.event === 'new') {
    notifier.toast({
      level: a.severity === 'critical' && !cur ? 'critical' : 'warn', sound: true, system: true, title: `${a.title} · ${a.target}`,
      text: `${measure}. ${S.settings.autoDispatch ? `The drone is on its way to ${INSPECT_VERB[a.inspection]}.` : 'Drone dispatch waiting for your decision.'}`,
      actions: S.settings.autoDispatch ? [view, watch] : [{ label: 'Send drone', primary: true, run: () => alertAction('alertDispatch', a.id) }, view],
    });
  } else if (m.event === 'escalate') {
    notifier.toast({ level: 'critical', sound: true, system: true, title: `Critical alert · ${a.target}`, text: measure, actions: [view, watch] });
  } else if (m.event === 'dispatch') {
    notifier.toast({ level: 'drone', title: `Drone en route · ${a.target}`, text: `${a.dispatch.note === 'Automatic dispatch' ? 'Autonomous departure' : 'Sent by the operator'}: ${INSPECT_LABEL[a.inspection]}.`, actions: [watch] });
  } else if (m.event === 'diagnosis') {
    const found = a.diagnosis.result === 'defect';
    notifier.toast({
      level: found ? 'critical' : cur ? 'warn' : 'ok', sound: true, system: true,
      title: found ? `Finding confirmed · ${a.target}` : cur ? `${a.target}: no visible defect` : `${a.target}: nothing abnormal`,
      text: found ? `Drone diagnosis: ${a.diagnosis.label}. Work order ${a.workOrder} created.` : cur ? `Electrical check required. Work order ${a.workOrder} created.` : 'The drone found nothing at the reported location.',
      actions: a.workOrder ? [{ label: 'Work order', primary: true, run: () => go('interventions') }, view] : [view],
    });
  } else if (m.event === 'resolve') {
    notifier.toast({ level: 'ok', title: `${a.target}: ${cur ? 'current back to normal' : 'alert cleared'}`, text: `${a.id} closed.`, timeout: 5000 });
  }
  renderAlertsAll();
  renderElectrical();
});

link.addEventListener('incidents', ({ detail: m }) => {
  S.incidents = m.incidents;
  renderScenarios();
});

link.addEventListener('layout', ({ detail: m }) => setLayout(m.layout || []));

link.addEventListener('workorder', ({ detail: m }) => {
  upsert(S.workOrders, m.workOrder, true);
  renderWorkOrders();
  renderBadges();
  if (S.selectedAlert) renderAlertDetail();
});

link.addEventListener('log', ({ detail: m }) => {
  S.logs.push(m.entry);
  if (S.logs.length > 300) S.logs.shift();
  renderLogs();
});

link.addEventListener('settings', ({ detail: m }) => {
  S.settings = m.settings;
  renderSettings();
});

function upsert(list, item, front) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else if (front) list.unshift(item);
  else list.push(item);
}

function applyScada(d, live) {
  S.scada = d;
  for (const [id, cur, volt, power, dev, exp] of d.panels) {
    S.values[id] = [cur, volt, power, dev, exp];
    if (live) {
      const h = (S.panelHistory[id] ||= []);
      h.push([cur, exp]);
      if (h.length > 300) h.shift();
    }
  }
  if (live && d.plant.point) {
    const p = d.plant.point;
    const last = S.plantHistory[S.plantHistory.length - 1];
    if (!last || last[0] !== p[0]) {
      S.plantHistory.push(p);
      if (S.plantHistory.length > 900) S.plantHistory.shift();
      powerChart.push([p[0], p[1], p[2]], 900);
    }
  }
}

function setLayout(layout) {
  const known = S.layout.map((p) => p.id).join();
  if (!layout.length || (known === layout.map((p) => p.id).join() && layout[0].x === S.layout[0]?.x)) return;
  S.layout = layout;
  const base = S.status?.base || { x: 0, z: 17 };
  for (const m of Object.values(maps)) m.build(layout, base);
  renderElectrical();
  renderStatus();
}

// ======================================================================== navigation

const TITLES = { supervision: 'Overview', vol: 'Flight control', panneaux: 'Panels', alertes: 'Alerts', interventions: 'Work orders', scenarios: 'Demo scenarios' };

function go(hash) {
  if (location.hash === `#${hash}`) route();
  else location.hash = hash;
}

function route() {
  const [view, sub] = (location.hash.slice(1) || 'supervision').split('/');
  S.view = TITLES[view] ? view : 'supervision';
  S.sub = sub || null;
  $('#app').dataset.view = S.view;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${S.view}`;
  for (const a of $$('.rail .nav')) {
    if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('#view-title').textContent = TITLES[S.view];
  if (S.view === 'alertes') {
    if (S.sub === 'journal') S.alertTab = 'journal';
    else if (S.sub) {
      S.selectedAlert = S.sub;
      if (S.alertTab === 'journal') S.alertTab = 'active';
      const a = S.alerts.find((x) => x.id === S.sub);
      if (a && a.state === 'resolved') S.alertTab = 'all';
    }
  }
  renderAll();
  video.repaintAll();
  tooltip.hidden = true;
  updatePilotInput();
}
window.addEventListener('hashchange', route);

// ======================================================================== rendu : liaison, horloge, réglages

function renderLink() {
  const chip = $('#chip-link');
  const st = S.link !== 'on' ? 'off' : !S.sim ? 'warn' : 'on';
  chip.dataset.state = st;
  const age = S.status ? '' : '';
  $('.txt', chip).textContent = S.link === 'connecting' ? 'Connecting to server…'
    : S.link === 'off' ? 'Server unreachable' : !S.sim ? 'Plant not connected' : `Drone link · ${Math.round(video.fps) || 0} fps${age}`;
  $('#rail-link').dataset.state = st;
  $('#rail-link').title = $('.txt', chip).textContent;
  $('#sup-empty').hidden = S.layout.length > 0;
}

function renderSettings() {
  $('#auto-dispatch').checked = Boolean(S.settings.autoDispatch);
  $('#sc-autodispatch').checked = Boolean(S.settings.autoDispatch);
  $('#sc-autofaults').checked = Boolean(S.settings.autoFaults);
  const b = $('[data-demo="autofaults"] b');
  if (b) b.textContent = S.settings.autoFaults ? 'on' : 'off';
}

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('en-GB');
  renderLink();
  const stale = video.stale;
  for (const e of $$('[data-bind="videoEmpty"]')) {
    e.hidden = !stale;
    e.textContent = !S.sim ? 'Drone offline' : 'Waiting for the video feed…';
  }
  for (const e of $$('[data-bind="rec"]')) e.textContent = stale ? '' : `${Math.round(video.fps)} fps`;
}, 500);
setInterval(() => {
  renderAlertMini();
  if (S.view === 'alertes') renderAlertRows();
  if (S.view === 'interventions') renderWorkOrders();
  if (S.view === 'scenarios') renderScenarios();
}, 5000);

// ======================================================================== rendu : électrique

function openAlertFor(id) {
  return S.alerts.find((a) => a.state !== 'resolved' && (a.panel === id || (a.kind === 'structure' && a.targets?.includes(id)))) || null;
}

function alertSevMap() {
  const m = {};
  for (const a of S.alerts) {
    if (a.state === 'resolved') continue;
    if (a.kind === 'current' && a.panel) m[a.panel] = a.severity;
    if (a.kind === 'structure') for (const p of a.targets || []) m[p] = a.severity;
  }
  return m;
}

// Problèmes signalés au sol (alertes de terrain) : repères sur la carte
function alertMarkers() {
  return S.alerts.filter((a) => a.state !== 'resolved' && a.kind === 'terrain' && a.point).map((a) => ({ x: a.point.x, z: a.point.z, sev: a.severity, label: a.title }));
}

// Libellé court d'une alerte dans les listes
// Cible en grand dans les listes : identifiant du module, ou lettre de zone
function shortTarget(a) {
  return a.panel || `${a.zone}<small class="az">zone</small>`;
}

function alertHead(a) {
  return a.kind === 'current' ? `Current ${pct(a.deviation)} · ${SEV_LABEL[a.severity].toLowerCase()}` : `${a.title} · ${SEV_LABEL[a.severity].toLowerCase()}`;
}

// Chiffres clés : la valeur glisse vers la nouvelle mesure au lieu de sauter
function tweenNum(el, value, fmt, ms = 600) {
  const from = Number.isFinite(el._v) ? el._v : value;
  el._v = value;
  if (from === value || matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) {
    el.textContent = fmt(value);
    return;
  }
  const t0 = performance.now();
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (value - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

function renderElectrical() {
  const d = S.scada;
  if (!d) return;
  const pairs = Object.fromEntries(Object.entries(S.values).map(([id, v]) => [id, [v[0], v[4]]]));
  const sev = alertSevMap();
  const markers = alertMarkers();
  for (const m of Object.values(maps)) {
    m.updateElectrical(pairs, sev);
    m.setMarkers(markers);
  }

  // Statistiques par zone
  const zones = {};
  for (const [id, v] of Object.entries(S.values)) {
    const z = (zones[id[0]] ||= { n: 0, cur: 0, power: 0, alerts: 0 });
    z.n++;
    z.cur += v[0];
    z.power += v[2];
  }
  for (const id of Object.keys(sev)) if (zones[id[0]]) zones[id[0]].alerts++;
  const stats = Object.fromEntries(Object.entries(zones).map(([z, s]) => [z, `${nf1.format(s.power / 1000)} kW · ${nf1.format(s.cur / s.n)} A avg.`]));
  maps.sup.updateZoneStats(stats);
  maps.panels.updateZoneStats(stats);

  // Indicateurs
  tweenNum($('#k-power'), d.plant.power / 1000, (v) => nf1.format(v));
  $('#k-power-sub').textContent = `expected ${nf1.format(d.plant.expected / 1000)} kW · ${nf0.format(d.plant.energyKWh)} kWh since start-up`;
  if (d.plant.performance != null) tweenNum($('#k-pr'), d.plant.performance * 100, (v) => `${nf1.format(v)}%`);
  tweenNum($('#k-irr'), d.plant.irradiance, (v) => nf0.format(v));
  $('#k-temp').textContent = `${nf1.format(d.weather.ambient)} °C ambient${d.weather.cloud ? ' · passing cloud' : ''}`;
  const kmh = d.weather.wind;
  tweenNum($('#k-wind'), kmh, (v) => nf0.format(v));
  const gust = d.weather.gust;
  $('#k-wind-sub').textContent = `gusts ${nf0.format(gust)} km/h · ${gust < 36 ? 'flight allowed' : 'flight suspended'}${d.weather.rain > 0 ? ` · rain ${nf0.format(d.weather.rain)} mm/h` : ''}`;
  $('#kpi-wind').dataset.sev = gust >= 36 ? 'critical' : '';
  const active = Object.keys(sev).length;
  $('#k-alerts').textContent = active;
  const crit = Object.values(sev).filter((s) => s === 'critical').length;
  $('#kpi-alerts').dataset.sev = crit ? 'critical' : active ? 'warning' : '';
  $('#k-alerts-sub').textContent = active ? `${crit} critical · ${active - crit} on watch` : 'no current drop';
  powerChart.setMarkers(S.alerts.filter((a) => a.openedAt > Date.now() - 15 * 60_000).map((a) => ({ t: a.openedAt, label: a.target, sev: a.severity })));

  if (S.view === 'panneaux') {
    renderZonesStrip(zones);
    renderPanelTable();
  }
  if (S.drawerPanel) renderDrawerLive();
  if (S.view === 'alertes' && S.selectedAlert) renderAlertLive();
}

// ======================================================================== rendu : drone

function droneTarget() {
  const m = S.status?.mission;
  return S.dispatch?.panel || m?.currentPanel || null;
}

function dronePoint() {
  return S.dispatch?.point || null;
}

function droneTag() {
  const s = S.status;
  if (!S.sim || !s) return { text: 'Drone offline', state: 'off' };
  const m = s.mission;
  if (m.pilot) return { text: 'Manual control', state: 'pilot' };
  if (S.dispatch) {
    const a = S.alerts.find((x) => x.id === S.dispatch.alertId);
    if (a?.inspection === 'terrain') {
      return { text: `Ground survey · ${a.target}${a.dispatch.status === 'inspecting' ? ' · surveying' : ' · en route'}`, state: 'dispatch' };
    }
    if (m.defectHold != null) return { text: `Anomaly spotted · ${S.dispatch.panel} · examining ${Math.ceil(m.defectHold)} s`, state: 'anomaly' };
    if (a?.inspection === 'structure') {
      return { text: `Structure inspection · ${S.dispatch.panel}${m.currentLeg ? ` · leg ${m.currentLeg}` : ''}`, state: 'dispatch' };
    }
    const prog = m.state === 'SCANNING' && m.currentPanel === S.dispatch.panel ? ` · scanning ${Math.round((m.scanProgress || 0) * 100)}%` : a?.dispatch.status === 'en-route' ? ' · en route' : '';
    return { text: `Auto diagnosis · ${S.dispatch.panel}${prog}`, state: 'dispatch' };
  }
  if (m.paused) return { text: `Pause · ${m.label}`, state: 'paused' };
  if (m.defectHold != null && m.currentPanel) return { text: `Anomaly spotted · ${m.currentPanel} · examining ${Math.ceil(m.defectHold)} s`, state: 'anomaly' };
  if (m.state === 'SCANNING' && m.currentPanel) return { text: `Scanning ${m.currentPanel} · ${Math.round((m.scanProgress || 0) * 100)}%`, state: 'busy' };
  if (m.currentPanel) return { text: `${m.label} · ${m.currentPanel}`, state: 'busy' };
  if (m.state === 'IDLE') return { text: s.drone.onPad ? 'Landed · base' : 'Landed · off base', state: 'idle' };
  return { text: m.label, state: 'busy' };
}

let lastCtrlKey = '';
function renderStatus() {
  const s = S.status;
  const tag = droneTag();
  for (const e of $$('[data-bind="droneTag"]')) {
    e.textContent = tag.text;
    e.dataset.state = tag.state;
  }
  if (s) {
    const d = s.drone;
    for (const e of $$('[data-bind="alt"]')) e.textContent = `ALT ${nf1.format(d.altitude)} m`;
    for (const e of $$('[data-bind="spd"]')) e.textContent = `${nf1.format(d.speed)} m/s`;
    for (const e of $$('[data-bind="vspd"]')) e.textContent = `V ${d.verticalSpeed >= 0 ? '+' : '−'}${nf1.format(Math.abs(d.verticalSpeed))} m/s`;
    for (const e of $$('[data-bind="hdg"]')) e.textContent = `HDG ${String(Math.round(d.heading) % 360).padStart(3, '0')}°`;
    for (const e of $$('[data-bind="bat"]')) {
      e.textContent = `BAT ${Math.round(d.battery)}%`;
      e.dataset.low = d.battery < 25 ? 'true' : '';
    }
    for (const m of Object.values(maps)) m.updateDrone(s, droneTarget(), dronePoint());
    for (const m of Object.values(maps)) m.updateInspection(s.panels || []);
  } else {
    for (const m of Object.values(maps)) m.updateDrone(null);
  }
  const key = s ? `${S.sim}|${s.mission.state}|${s.mission.paused}|${s.mission.pilot}|${s.drone.onPad}|${s.mission.mode}` : 'none';
  if (key !== lastCtrlKey) {
    lastCtrlKey = key;
    renderSupControls();
    renderFlightControls();
  }
  renderFlightTelemetry();
  updatePilotInput();
}

function flightFlags() {
  const s = S.status;
  const m = s?.mission;
  const flying = Boolean(s && m.state !== 'IDLE');
  return {
    ok: S.sim && Boolean(s),
    flying,
    idle: Boolean(s && m.state === 'IDLE'),
    paused: Boolean(m?.paused),
    pilot: Boolean(m?.pilot),
    returning: Boolean(m && (m.state === 'RETURN' || m.state === 'LANDING') && !m.paused),
    landing: m?.state === 'LANDING',
    onPad: Boolean(s?.drone.onPad),
  };
}

function renderSupControls() {
  const f = flightFlags();
  const host = $('#sup-ctrl');
  const b = (act, label, ic, { primary, disabled, active } = {}) => `<button class="btn${primary ? ' primary' : ''}${active ? ' active' : ''}" data-act="${act}"${disabled ? ' disabled' : ''}>${icon(ic)}<span>${label}</span></button>`;
  if (!f.ok) {
    host.innerHTML = `${b('takeoff', 'Take off', 'up', { disabled: true })}${b('pilot', 'Take control', 'stick', { disabled: true })}${b('return', 'Return to base', 'home', { disabled: true })}`;
  } else if (f.idle) {
    host.innerHTML = `${b('takeoff', 'Take off', 'up', { primary: true })}${b('pilot', 'Take control', 'stick')}${b(f.onPad ? 'mission' : 'return', f.onPad ? 'Inspect' : 'Return to base', f.onPad ? 'target' : 'home')}`;
  } else {
    host.innerHTML = `${b('pause', f.paused ? 'Resume' : 'Pause', f.paused ? 'play' : 'pause', { active: f.paused })}${b('pilot', f.pilot ? 'Release control' : 'Take control', 'stick', { active: f.pilot, disabled: f.landing })}${b('return', 'Return to base', 'home', { disabled: f.returning })}`;
  }
}

function renderFlightControls() {
  const f = flightFlags();
  const set = (act, disabled) => {
    const el = $(`#flight-btns [data-act="${act}"]`);
    el.disabled = disabled;
    return el;
  };
  set('takeoff', !f.ok || !f.idle);
  set('land', !f.ok || !f.flying || f.landing);
  const p = set('pause', !f.ok || !f.flying);
  $('span', p).textContent = f.paused ? 'Resume' : 'Pause';
  p.classList.toggle('active', f.paused);
  set('return', !f.ok || f.returning || (f.idle && f.onPad));
  const pb = $('#btn-pilot');
  pb.disabled = !f.ok || f.landing;
  pb.classList.toggle('active', f.pilot);
  $('span', pb).textContent = f.pilot ? 'Release control' : f.idle ? 'Take off and take control' : 'Take control';
  $('#pilot-hint').hidden = !f.pilot;
  $('#sticks').hidden = !f.pilot;
  $('#gimbal').disabled = !f.pilot;
  $('#btn-mission').disabled = !f.ok;
  $('#view-vol').classList.toggle('piloting', f.pilot);
}

function renderFlightTelemetry() {
  const s = S.status;
  if (!s) return;
  const d = s.drone;
  const m = s.mission;
  const st = $('#f-state');
  st.textContent = m.paused ? `Pause · ${m.label}` : m.label;
  st.dataset.state = m.pilot ? 'pilot' : m.state === 'IDLE' ? 'idle' : 'busy';
  if (S.view !== 'vol') return;
  $('#t-alt').textContent = `${nf1.format(d.altitude)} m`;
  $('#t-spd').textContent = `${nf1.format(d.speed)} m/s`;
  $('#t-vspd').textContent = `${d.verticalSpeed >= 0 ? '+' : '−'}${nf1.format(Math.abs(d.verticalSpeed))} m/s`;
  $('#t-hdg').textContent = `${String(Math.round(d.heading) % 360).padStart(3, '0')}°`;
  const base = s.base || { x: 0, z: 17 };
  $('#t-dist').textContent = `${nf0.format(Math.hypot(d.position.x - base.x, d.position.z - base.z))} m`;
  $('#t-pos').textContent = `${d.position.x >= 0 ? 'E' : 'W'} ${nf1.format(Math.abs(d.position.x))} · ${d.position.z <= 0 ? 'N' : 'S'} ${nf1.format(Math.abs(d.position.z))}`;
  $('#t-bat').textContent = `${Math.round(d.battery)}%`;
  const bar = $('#t-bat-bar');
  bar.style.width = `${d.battery}%`;
  bar.dataset.low = d.battery < 25 ? 'true' : '';
  $('#t-gimbal').textContent = `Gimbal ${Math.round(d.gimbalPitch)}°`;
  const g = $('#gimbal');
  if (document.activeElement !== g || g.disabled) g.value = Math.round(d.gimbalPitch);
  const thermal = Boolean(s.view?.thermal);
  for (const b of $$('[data-cam]')) b.classList.toggle('on', (b.dataset.cam === 'thermal') === thermal);
}

function updatePilotInput() {
  const m = S.status?.mission;
  pilot.setActive(Boolean(S.view === 'vol' && m?.pilot && m.state === 'MANUAL'));
}

// Commandes du drone (supervision et pilotage)
async function droneAction(act) {
  const f = flightFlags();
  switch (act) {
    case 'takeoff': return cmd('takeoff', {}, 'Taking off');
    case 'land': return cmd('land', {}, 'Landing here');
    case 'pause': return cmd(f.paused ? 'resume' : 'pause', {}, f.paused ? 'Resuming' : 'Paused: the drone holds its position');
    case 'return': return cmd('returnToBase', {}, 'Returning to base');
    case 'mission': return startMission();
    case 'pilot':
      if (!f.pilot) {
        if (S.view !== 'vol') go('vol');
        return cmd('pilot', { on: true }, f.idle ? 'Taking off, then manual control' : 'You have control');
      }
      return cmd('pilot', { on: false }, 'Control released: hovering');
    default: return null;
  }
}

function startMission() {
  const params = { type: S.missionType, ...(S.missionZone ? { zone: S.missionZone } : {}) };
  return cmd('missionStart', params, `${S.missionType === 'structure' ? 'Structure' : 'Module'} inspection started${S.missionZone ? ` · zone ${S.missionZone}` : ''}`);
}

$('#sup-ctrl').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (b) droneAction(b.dataset.act);
});
$('#flight-btns').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (b) droneAction(b.dataset.act);
});
$('#btn-pilot').addEventListener('click', () => droneAction('pilot'));
$('#btn-mission').addEventListener('click', startMission);
for (const b of $$('[data-cam]')) b.addEventListener('click', () => cmd('thermal', { on: b.dataset.cam === 'thermal' }));
for (const b of $$('[data-type]')) {
  b.addEventListener('click', () => {
    S.missionType = b.dataset.type;
    for (const x of $$('[data-type]')) x.classList.toggle('on', x === b);
  });
}
for (const b of $$('[data-zone]')) {
  b.addEventListener('click', () => {
    S.missionZone = b.dataset.zone;
    for (const x of $$('[data-zone]')) x.classList.toggle('on', x === b);
  });
}
let gimbalTimer = 0;
$('#gimbal').addEventListener('input', (ev) => {
  clearTimeout(gimbalTimer);
  gimbalTimer = setTimeout(() => link.command('gimbal', { pitch: Number(ev.target.value) }), 60);
});

// ======================================================================== rendu : alertes

function activeAlerts() {
  return S.alerts.filter((a) => a.state !== 'resolved').sort((a, b) => (a.severity === b.severity ? b.openedAt - a.openedAt : a.severity === 'critical' ? -1 : 1));
}

function renderBadges() {
  const n = activeAlerts().length;
  const crit = activeAlerts().some((a) => a.severity === 'critical');
  const b = $('#badge-alerts');
  b.hidden = !n;
  b.textContent = n;
  b.dataset.sev = crit ? 'critical' : 'warning';
  const wo = S.workOrders.filter((w) => w.status !== 'done').length;
  const w = $('#badge-wo');
  w.hidden = !wo;
  w.textContent = wo;
  notifier.setCount(n);
}

function pipeline(a) {
  const ds = a.dispatch.status;
  const sent = ['en-route', 'inspecting', 'done'].includes(ds) || a.diagnosis;
  const steps = [
    { k: 'Detection', done: true },
    { k: 'Drone sent', done: sent, now: ['pending', 'queued', 'waiting', 'manual'].includes(ds) },
    { k: 'Inspection', done: ds === 'done' || Boolean(a.diagnosis), now: ds === 'en-route' || ds === 'inspecting' },
    { k: 'Diagnosis', done: Boolean(a.diagnosis) },
    { k: 'Work order', done: Boolean(a.workOrder) },
  ];
  return steps;
}

function pipelineHtml(a, compact) {
  return `<ol class="pipe${compact ? ' compact' : ''}" aria-label="Progress">${pipeline(a).map((s) => `<li class="${s.done ? 'done' : s.now ? 'now' : ''}"><span class="pm"></span>${compact ? '' : `<span class="pk">${s.k}</span>`}</li>`).join('')}</ol>`;
}

function alertLine(a) {
  if (a.diagnosis) {
    if (a.diagnosis.result === 'defect') return `Finding: ${a.diagnosis.label}`;
    return a.kind === 'current' ? 'No visible defect · electrical check' : 'Nothing abnormal found';
  }
  return DISPATCH_LABEL[a.dispatch.status] + (a.dispatch.note && ['waiting', 'queued'].includes(a.dispatch.status) ? ` · ${a.dispatch.note.replace(/^(Waiting|Queued): /, '')}` : '');
}

function renderAlertMini() {
  const list = activeAlerts().slice(0, 4);
  const host = $('#sup-alerts');
  if (!list.length) {
    host.innerHTML = `<li class="empty">No alerts. The current of all 60 modules matches the measured irradiance.</li>`;
  } else {
    host.innerHTML = list.map((a) => `
      <li><a href="#alertes/${a.id}" class="amini" data-sev="${a.severity}">
        <span class="sev-mark" data-sev="${a.severity}" aria-hidden="true"></span>
        <b class="apanel">${shortTarget(a)}</b>
        <span class="atext"><span>${esc(alertHead(a))}</span><span class="sub">${esc(alertLine(a))} · ${since(a.openedAt)}</span></span>
        ${pipelineHtml(a, true)}
      </a></li>`).join('');
  }
  renderBadges();
}

function renderAlertRows() {
  // Rien de sélectionné : la plus grave des alertes actives s'ouvre d'elle-même
  if (!S.selectedAlert && S.alertTab !== 'journal') S.selectedAlert = activeAlerts()[0]?.id || null;
  const tabs = $$('#alert-tabs button');
  for (const t of tabs) {
    t.classList.toggle('on', t.dataset.tab === S.alertTab);
    t.setAttribute('aria-selected', String(t.dataset.tab === S.alertTab));
  }
  const journal = S.alertTab === 'journal';
  $('#journal').hidden = !journal;
  $('#alert-rows').hidden = journal;
  if (journal) {
    renderJournal();
    $('#alert-count').textContent = `${S.logs.length} entries`;
    return;
  }
  const list = S.alertTab === 'active' ? activeAlerts() : [...S.alerts].sort((a, b) => b.openedAt - a.openedAt);
  $('#alert-count').textContent = `${list.length} alert${list.length !== 1 ? 's' : ''}`;
  const host = $('#alert-rows');
  if (!list.length) {
    host.innerHTML = `<li class="empty">${S.alertTab === 'active' ? 'No active alerts. A sustained current drop on a module opens an alert, and the drone flies out by itself to diagnose it.' : 'No alerts since start-up.'}</li>`;
    return;
  }
  host.innerHTML = list.map((a) => `
    <li><button class="arow${a.id === S.selectedAlert ? ' sel' : ''}" data-id="${a.id}" data-state="${a.state}">
      <span class="sev-mark" data-sev="${a.state === 'resolved' ? 'resolved' : a.severity}" aria-hidden="true"></span>
      <b class="apanel">${shortTarget(a)}</b>
      <span class="atext"><span>${a.kind === 'current' ? `Current drop · ${pct(a.worstDeviation)} at worst` : esc(a.title)}</span><span class="sub">${a.state === 'resolved' ? 'Closed' : SEV_LABEL[a.severity]} · ${esc(alertLine(a))}</span></span>
      ${pipelineHtml(a, true)}
      <span class="atime mono">${clock(a.openedAt)}<span class="sub">${since(a.openedAt)}</span></span>
    </button></li>`).join('');
}

$('#alert-rows').addEventListener('click', (ev) => {
  const b = ev.target.closest('.arow');
  if (b) go(`alertes/${b.dataset.id}`);
});
for (const t of $$('#alert-tabs button')) {
  t.addEventListener('click', () => {
    S.alertTab = t.dataset.tab;
    if (t.dataset.tab === 'journal') go('alertes/journal');
    else {
      if (S.sub === 'journal') history.replaceState(null, '', S.selectedAlert ? `#alertes/${S.selectedAlert}` : '#alertes');
      renderAlertRows();
    }
  });
}

let detailChart = null;
function renderAlertDetail() {
  const host = $('#alert-detail');
  const a = S.alerts.find((x) => x.id === S.selectedAlert);
  detailChart = null;
  if (!a) {
    host.innerHTML = '<p class="empty-state">Select an alert to see the measurement, the drone diagnosis and the history.</p>';
    return;
  }
  const wo = a.workOrder ? S.workOrders.find((w) => w.id === a.workOrder) : null;
  const ds = a.dispatch.status;
  const canSend = a.state !== 'resolved' && !a.diagnosis && !['en-route', 'inspecting'].includes(ds);
  const flying = ['en-route', 'inspecting'].includes(ds);
  const cur = a.kind === 'current';
  // Courbe de courant : le module de l'alerte, ou le premier module ombragé / inspecté
  const chartPanel = cur ? a.panel : a.kind === 'structure' ? a.targets?.[0] || null : null;
  host.innerHTML = `
    <header class="ad-head">
      <div>
        <h2><span class="ad-panel">${esc(a.target)}</span> ${esc(a.title)}</h2>
        <p class="sub">${a.id} · ${KIND_LABEL[a.kind]} · ${a.panel && a.row ? `zone ${a.zone}, row ${a.row}, column ${a.col}` : `zone ${a.zone}`} · opened at ${clock(a.openedAt)}${a.scenario ? ' · simulated incident' : ''}</p>
      </div>
      <span class="sev-pill" data-sev="${a.state === 'resolved' ? 'resolved' : a.severity}">${a.state === 'resolved' ? 'Closed' : SEV_LABEL[a.severity]}</span>
    </header>
    ${cur ? `<div class="ad-metrics">
      <div><span class="label">Measured</span><b class="mid" id="ad-cur">${nf2.format(a.measured)}<small>A</small></b></div>
      <div><span class="label">Expected</span><b class="mid" id="ad-exp">${nf2.format(a.expected)}<small>A</small></b></div>
      <div><span class="label">Deviation</span><b class="mid" id="ad-dev" data-sev="${a.severity}">${pct(a.deviation)}</b></div>
      <div><span class="label">Worst</span><b class="mid">${pct(a.worstDeviation)}</b></div>
    </div>` : `<dl class="ad-sensor">
      <div><dt>Detected by</dt><dd>${esc(a.sensor)}</dd></div>
      <div><dt>Reading</dt><dd class="ad-reading" data-sev="${a.severity}">${esc(a.reading)}</dd></div>
      <div><dt>Drone response</dt><dd>${esc(INSPECT_LABEL[a.inspection])}${a.targets?.length > 1 ? ` : ${a.targets.join(', ')}` : ''}</dd></div>
    </dl>`}
    ${pipelineHtml(a, false)}
    <div class="ad-media">
    ${chartPanel ? `<div class="ad-chart"><div class="legend"><span class="lg-measured">Current ${chartPanel}</span><span class="lg-expected">Expected</span><span class="lg-span">5 min</span></div><div class="chart" id="ad-chart"></div></div>` : ''}
    ${a.snapshot ? `<figure class="ad-shot"><img src="/api/alerts/${a.id}/snapshot.jpg" alt="Drone image of ${esc(a.target)} during the inspection" loading="lazy" /><figcaption>${a.diagnosis?.result === 'defect' ? `${a.kind === 'terrain' ? 'Overhead survey' : 'Close-range view'}: ${esc(a.diagnosis.label)}` : 'Image taken during the inspection'} · ${clock(a.diagnosis?.at || a.updatedAt)}</figcaption></figure>` : ''}
    </div>
    ${wo ? `<a class="ad-wo" href="#interventions"><span class="label">Work order</span><b>${wo.id} · ${esc(wo.title)}</b><span class="sub">${WO_STATUS[wo.status]} · ${wo.priority} priority</span></a>` : ''}
    <div class="ad-actions">
      ${a.state !== 'resolved' && !a.acknowledged ? '<button class="btn primary" data-aact="alertAck">Acknowledge</button>' : ''}
      ${canSend ? '<button class="btn" data-aact="alertDispatch">' + icon('drone') + '<span>Send drone</span></button>' : ''}
      ${flying ? '<a class="btn" href="#vol">' + icon('eye') + '<span>Watch video</span></a>' : ''}
      ${a.panel || a.targets?.length ? `<button class="btn ghost" data-aact="openPanel">${icon('panel')}<span>Module details</span></button>` : ''}
      ${a.state !== 'resolved' ? '<button class="btn ghost" data-aact="alertClose">Close</button>' : ''}
    </div>
    <section class="ad-history"><h3>History</h3><ol>${[...a.history].reverse().map((h) => `<li><time class="mono">${clock(h.at)}</time><span>${esc(h.text)}</span></li>`).join('')}</ol></section>`;
  if (chartPanel) {
    detailChart = new TimeChart($('#ad-chart'), { span: 5 * 60_000, fmt: (v) => nf1.format(v), unit: 'A', labels: [`Current ${chartPanel}`, 'Expected'] });
    detailChart.setMarkers([{ t: a.openedAt, label: 'alert', sev: a.severity }]);
    detailChart.panel = chartPanel;
  }
  renderAlertLive();
}

function panelSeries(id) {
  const h = S.panelHistory[id] || [];
  const now = S.scada?.t || Date.now();
  return h.map((p, i) => [now - (h.length - 1 - i) * 1000, p[0], p[1]]);
}

function renderAlertLive() {
  const a = S.alerts.find((x) => x.id === S.selectedAlert);
  if (!a || !detailChart) return;
  detailChart.setData(panelSeries(detailChart.panel));
  if (a.state !== 'resolved' && a.kind === 'current') {
    const v = S.values[a.panel];
    if (v) {
      $('#ad-cur').innerHTML = `${nf2.format(v[0])}<small>A</small>`;
      $('#ad-exp').innerHTML = `${nf2.format(v[4])}<small>A</small>`;
      $('#ad-dev').textContent = pct(v[3]);
    }
  }
}

$('#alert-detail').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-aact]');
  if (!b) return;
  if (b.dataset.aact === 'openPanel') {
    const a = S.alerts.find((x) => x.id === S.selectedAlert);
    if (a) openDrawer(a.panel || a.diagnosis?.panels?.[0] || a.targets[0]);
    return;
  }
  alertAction(b.dataset.aact, S.selectedAlert);
});

async function alertAction(action, id) {
  const titles = { alertAck: 'Alert acknowledged', alertDispatch: 'Drone sent', alertClose: 'Alert closed' };
  await cmd(action, { id, by: S.operator }, titles[action]);
  renderAlertsAll();
}

function renderJournal() {
  const host = $('#journal');
  const list = [...S.logs].reverse().slice(0, 250);
  host.innerHTML = list.length ? list.map((l) => `<li data-level="${esc(l.level)}"><time class="mono">${clock(l.at)}</time><span class="src">${l.source === 'drone' ? 'Drone' : l.source === 'scada' ? 'Sensors' : 'Operations'}</span><span>${esc(tidy(l.msg))}</span></li>`).join('') : '<li class="empty">Log is empty.</li>';
}

// Le journal du drone sépare ses propositions par des tirets longs : un point médian suffit ici
const tidy = (msg) => msg.replace(/ — /g, ' · ');

function renderLogs() {
  const host = $('#sup-log');
  const list = [...S.logs].reverse().slice(0, 6);
  host.innerHTML = list.length ? list.map((l) => `<li data-level="${esc(l.level)}"><time class="mono">${clock(l.at).slice(0, 5)}</time><span>${esc(tidy(l.msg))}</span></li>`).join('') : '<li class="empty">No activity yet.</li>';
  if (S.view === 'alertes' && S.alertTab === 'journal') renderJournal();
}

function renderAlertsAll() {
  renderAlertMini();
  if (S.view === 'alertes') {
    renderAlertRows();
    renderAlertDetail();
  }
  if (S.drawerPanel) renderDrawer();
  if (S.view === 'scenarios') renderScenarios();
}

// ======================================================================== rendu : panneaux

function renderZonesStrip(zones) {
  const host = $('#zones-strip');
  host.innerHTML = Object.entries(zones).sort().map(([z, s]) => {
    const irr = S.scada?.zones.find((x) => x.id === z);
    return `<div class="zcard${s.alerts ? ' alerting' : ''}"><h2>Zone ${z}</h2><b class="mid">${nf1.format(s.power / 1000)}<small>kW</small></b><span class="sub">${nf1.format(s.cur / s.n)} A avg. · ${irr ? `${nf0.format(irr.irradiance)} W/m²` : ''}${s.alerts ? ` · <em>${s.alerts} in alert</em>` : ''}</span></div>`;
  }).join('');
}

function panelRows() {
  const insp = Object.fromEntries((S.status?.panels || []).map((p) => [p.id, p]));
  const sev = alertSevMap();
  let rows = S.layout.map((p) => {
    const v = S.values[p.id] || [0, 0, 0, 0, 0];
    return { id: p.id, zone: p.zone, current: v[0], expected: v[4], deviation: v[3], power: v[2], voltage: v[1], inspection: insp[p.id]?.status || 'pending', defect: insp[p.id]?.defect || null, sev: sev[p.id] || null };
  });
  const f = S.panelFilter;
  if (f === 'alert') rows = rows.filter((r) => r.sev);
  else if (f !== 'all') rows = rows.filter((r) => r.zone === f);
  const { key, dir } = S.sort;
  rows.sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : a.id < b.id ? -1 : 1));
  return rows;
}

function renderPanelTable() {
  const rows = panelRows();
  $('#panel-count').textContent = `${rows.length} module${rows.length !== 1 ? 's' : ''}`;
  const body = $('#panel-table tbody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${S.panelFilter === 'alert' ? 'No module in alert.' : 'Waiting for measurements.'}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr data-id="${r.id}" class="${r.sev ? `sev-${r.sev}` : ''}${r.id === S.drawerPanel ? ' sel' : ''}" tabindex="0">
      <th scope="row"><span class="sev-mark" data-sev="${r.sev || 'none'}" aria-hidden="true"></span>${r.id}</th>
      <td class="num mono">${nf2.format(r.current)} A</td>
      <td class="num mono">${nf2.format(r.expected)} A</td>
      <td class="num mono dev" data-sev="${r.sev || ''}">${pct(r.deviation, 1)}</td>
      <td class="num mono">${nf0.format(r.power)} W</td>
      <td><span class="insp" data-s="${r.inspection}">${INSPECTION[r.inspection]}${r.defect ? ` · ${esc(r.defect)}` : ''}</span></td>
    </tr>`).join('');
}

$('#panel-table tbody').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr) openDrawer(tr.dataset.id);
});
$('#panel-table tbody').addEventListener('keydown', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    openDrawer(tr.dataset.id);
  }
});
for (const th of $$('#panel-table th[data-sort]')) {
  th.querySelector('button').addEventListener('click', () => {
    const key = th.dataset.sort;
    S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === 'deviation' ? 1 : 1 };
    for (const x of $$('#panel-table th[data-sort]')) x.removeAttribute('aria-sort');
    th.setAttribute('aria-sort', S.sort.dir > 0 ? 'ascending' : 'descending');
    renderPanelTable();
  });
}
for (const b of $$('#panel-filter button')) {
  b.addEventListener('click', () => {
    S.panelFilter = b.dataset.f;
    for (const x of $$('#panel-filter button')) x.classList.toggle('on', x === b);
    renderPanelTable();
  });
}

// ======================================================================== fiche d'un module (tiroir)

let drawerChart = null;
function openDrawer(id) {
  S.drawerPanel = id;
  $('#drawer').hidden = false;
  requestAnimationFrame(() => $('#drawer').classList.add('open'));
  for (const m of Object.values(maps)) m.setSelected(id);
  renderDrawer();
  $('#drawer .drawer-close')?.focus();
}

function closeDrawer() {
  if (!S.drawerPanel) return;
  S.drawerPanel = null;
  drawerChart = null;
  for (const m of Object.values(maps)) m.setSelected(null);
  const d = $('#drawer');
  d.classList.remove('open');
  setTimeout(() => {
    if (!S.drawerPanel) d.hidden = true;
  }, 200);
}

function renderDrawer() {
  const id = S.drawerPanel;
  const lay = S.layout.find((p) => p.id === id);
  const sp = S.status?.panels?.find((p) => p.id === id);
  const alert = openAlertFor(id);
  const last = S.alerts.find((a) => a.panel === id || a.targets?.includes(id));
  $('#drawer-body').innerHTML = `
    <header class="dr-head">
      <div><h2 id="drawer-title">Module ${id}</h2><p class="sub">Zone ${id[0]}${lay?.row ? ` · row ${lay.row} · column ${lay.col}` : ''}</p></div>
      <button class="icon-btn drawer-close" aria-label="Close details">${icon('close')}</button>
    </header>
    <div class="dr-now"><b class="big" id="dr-cur">—</b><span class="sub" id="dr-exp">—</span></div>
    <div class="ad-chart"><div class="legend"><span class="lg-measured">Current</span><span class="lg-expected">Expected</span><span class="lg-span">5 min</span></div><div class="chart" id="dr-chart"></div></div>
    <dl class="telemetry">
      <div><dt>Voltage</dt><dd class="mono" id="dr-v">—</dd></div>
      <div><dt>Power</dt><dd class="mono" id="dr-p">—</dd></div>
      <div><dt>Modules</dt><dd><span class="insp" data-s="${sp?.status || 'pending'}">${INSPECTION[sp?.status || 'pending']}${sp?.defect ? ` · ${esc(sp.defect)}` : ''}</span></dd></div>
      <div><dt>Structure</dt><dd><span class="insp" data-s="${sp?.structure?.status || 'pending'}">${INSPECTION[sp?.structure?.status || 'pending']}${sp?.structure?.defect ? ` · ${esc(sp.structure.defect)}` : ''}</span></dd></div>
    </dl>
    ${alert ? `<a class="ad-wo" href="#alertes/${alert.id}" data-sev="${alert.severity}"><span class="label">Open alert</span><b>${alert.id} · ${SEV_LABEL[alert.severity]}</b><span class="sub">${esc(alertLine(alert))}</span></a>` : last ? `<a class="ad-wo" href="#alertes/${last.id}"><span class="label">Last alert</span><b>${last.id} · closed</b><span class="sub">${since(last.openedAt)}</span></a>` : ''}
    <div class="dr-actions">
      <button class="btn primary" data-dact="modules">${icon('drone')}<span>Inspect module</span></button>
      <button class="btn" data-dact="structure">Inspect structure</button>
      <button class="btn ghost small" data-dact="fault" title="Demo: causes a current drop on this module">Simulate a current drop</button>
    </div>`;
  drawerChart = new TimeChart($('#dr-chart'), { span: 5 * 60_000, fmt: (v) => nf1.format(v), unit: 'A', labels: ['Current', 'Expected'] });
  if (alert) drawerChart.setMarkers([{ t: alert.openedAt, label: 'alert', sev: alert.severity }]);
  renderDrawerLive();
}

function renderDrawerLive() {
  const id = S.drawerPanel;
  const v = S.values[id];
  if (!v || !drawerChart) return;
  $('#dr-cur').innerHTML = `${nf2.format(v[0])}<small>A</small>`;
  const sev = alertSevMap()[id];
  $('#dr-exp').innerHTML = `expected ${nf2.format(v[4])} A · deviation <em data-sev="${sev || ''}">${pct(v[3], 1)}</em>`;
  $('#dr-v').textContent = `${nf1.format(v[1])} V`;
  $('#dr-p').textContent = `${nf0.format(v[2])} W`;
  drawerChart.setData(panelSeries(id));
}

$('#drawer').addEventListener('click', (ev) => {
  if (ev.target.closest('.drawer-close')) return closeDrawer();
  const b = ev.target.closest('[data-dact]');
  if (!b) return;
  const id = S.drawerPanel;
  if (b.dataset.dact === 'fault') cmd('injectFault', { panel: id }, `Current drop triggered on ${id}`);
  else cmd('goto', { panel: id, type: b.dataset.dact }, `Drone sent to inspect ${id}`);
});

// ======================================================================== interventions

function renderWorkOrders() {
  const host = $('#wo-list');
  let list = S.workOrders;
  if (S.woFilter === 'open') list = list.filter((w) => w.status !== 'done');
  else if (S.woFilter === 'done') list = list.filter((w) => w.status === 'done');
  if (!list.length) {
    host.innerHTML = `<li class="empty">${S.woFilter === 'open' ? 'Nothing to do. A work order is created as soon as the drone has diagnosed an alert.' : 'No work orders.'}</li>`;
    return;
  }
  host.innerHTML = list.map((w) => `
    <li class="wo" data-id="${w.id}" data-status="${w.status}">
      <div class="wo-shot">${w.snapshot ? `<img src="/api/alerts/${w.alertId}/snapshot.jpg" alt="Drone image of ${esc(w.target)}" loading="lazy" />` : '<span class="wo-noshot">No image</span>'}</div>
      <div class="wo-main">
        <div class="wo-title"><b>${esc(w.title)}</b><span class="wo-id mono">${w.id}</span></div>
        <p><a href="#alertes/${w.alertId}">${esc(w.target)}</a> · ${KIND_LABEL[w.kind || 'current']} · drone finding: ${esc(w.finding)}</p>
        <p class="sub">${esc(w.detail)}</p>
      </div>
      <dl class="wo-facts">
        <div><dt>Priority</dt><dd data-prio="${w.priority}">${w.priority}</dd></div>
        <div><dt>Estimated time</dt><dd>${w.duration}</dd></div>
        <div><dt>Loss</dt><dd class="mono">${w.loss != null ? `${nf0.format(w.loss)} W` : '—'}</dd></div>
        <div><dt>Created</dt><dd>${since(w.createdAt)}</dd></div>
      </dl>
      <div class="wo-act">
        <span class="wo-status" data-status="${w.status}">${WO_STATUS[w.status]}</span>
        ${w.status === 'done' ? `<span class="sub">by ${esc(w.assignee || 'maintenance team')}</span>` : `
        <label class="select"><span class="sr">Team</span><select data-assign="${w.id}"><option value="">Assign to…</option>${TEAMS.map((t) => `<option${w.assignee === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <div class="wo-btns">${w.status === 'open' ? `<button class="btn small" data-wo="planned">Schedule</button>` : ''}<button class="btn small primary" data-wo="done">Close · repaired</button></div>`}
      </div>
    </li>`).join('');
}

$('#wo-list').addEventListener('change', (ev) => {
  const s = ev.target.closest('select[data-assign]');
  if (s) cmd('workOrder', { id: s.dataset.assign, assignee: s.value || null, by: S.operator }, s.value ? `Assigned to ${s.value}` : null);
});
$('#wo-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-wo]');
  if (!b) return;
  const id = b.closest('.wo').dataset.id;
  cmd('workOrder', { id, status: b.dataset.wo, by: S.operator }, b.dataset.wo === 'done' ? `${id} closed: repaired` : `${id} scheduled`);
});
for (const b of $$('#wo-filter button')) {
  b.addEventListener('click', () => {
    S.woFilter = b.dataset.f;
    for (const x of $$('#wo-filter button')) x.classList.toggle('on', x === b);
    renderWorkOrders();
  });
}

// ======================================================================== barre supérieure, démo, opérateur

$('#auto-dispatch').addEventListener('change', (ev) => {
  cmd('settings', { autoDispatch: ev.target.checked }, ev.target.checked ? 'Automatic drone dispatch on' : 'Automatic dispatch off: you decide each dispatch');
});

const demoMenu = $('#demo-menu');
const demoPop = $('.menu-pop', demoMenu);
function toggleMenu(open) {
  demoPop.hidden = !open;
  $('#btn-demo').setAttribute('aria-expanded', String(open));
}
$('#btn-demo').addEventListener('click', () => toggleMenu(demoPop.hidden));
// Vitesse de simulation : boutons du menu Démo et de la vue Scénarios
document.addEventListener('click', async (ev) => {
  const sp = ev.target.closest('[data-speed]');
  if (!sp) return;
  const r = await cmd('simSpeed', { speed: Number(sp.dataset.speed) }, `Simulation ×${sp.dataset.speed}`);
  if (r.ok !== false) for (const x of $$('[data-speed]')) x.classList.toggle('on', x.dataset.speed === sp.dataset.speed);
});

function confirmReset(clean) {
  notifier.toast({
    level: 'warn', timeout: 10000,
    title: clean ? 'Healthy plant?' : 'Random faults?',
    text: clean
      ? 'No hidden faults left: only your simulated incidents will exist. Drone back on its base, alerts closed.'
      : 'New hidden faults drawn at random (found during inspections). Drone back on its base, alerts closed.',
    actions: [{ label: 'Reset', primary: true, run: () => cmd('reset', { clean }, clean ? 'Healthy plant' : 'Plant reset') }],
  });
}

demoPop.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-demo]');
  if (!b) return;
  toggleMenu(false);
  if (b.dataset.demo === 'scenarios') go('scenarios');
  else if (b.dataset.demo === 'autofaults') cmd('settings', { autoFaults: !S.settings.autoFaults });
  else if (b.dataset.demo === 'clean') confirmReset(true);
  else if (b.dataset.demo === 'reset') confirmReset(false);
});
document.addEventListener('click', (ev) => {
  if (!demoMenu.contains(ev.target)) toggleMenu(false);
  const pop = $('#operator-pop');
  if (!pop.hidden && !pop.contains(ev.target) && ev.target !== $('#operator-btn')) pop.hidden = true;
});

function renderOperator() {
  const words = S.operator.split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w));
  const initials = S.operator === 'Operator on duty' ? 'OP' : words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'OP';
  $('#operator-btn').textContent = initials;
  $('#operator-btn').title = `${S.operator} (edit)`;
}
$('#operator-btn').addEventListener('click', () => {
  const pop = $('#operator-pop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) {
    const r = $('#operator-btn').getBoundingClientRect();
    pop.style.left = `${r.right + 10}px`;
    pop.style.top = `${Math.max(8, r.bottom - pop.offsetHeight)}px`;
    $('#operator-name').value = S.operator;
    $('#operator-name').focus();
  }
});
$('#operator-name').addEventListener('input', (ev) => {
  S.operator = ev.target.value.trim() || 'Operator on duty';
  writePref('helio.operator', S.operator);
  renderOperator();
});

window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!demoPop.hidden) toggleMenu(false);
  else if (!$('#operator-pop').hidden) $('#operator-pop').hidden = true;
  else closeDrawer();
});

// ======================================================================== scénarios de démonstration

let scKey = '';
function renderScenarios() {
  const active = S.incidents.filter((i) => i.state === 'active');
  const badge = $('#badge-inc');
  badge.hidden = !active.length;
  badge.textContent = active.length;
  if (S.view !== 'scenarios') return;

  // Catalogue : reconstruit seulement si le catalogue ou la centrale changent (garde les choix)
  const key = `${S.scenarios.length}|${S.layout.length}`;
  if (key !== scKey) {
    scKey = key;
    const zones = [...new Set(S.layout.map((p) => p.zone))].sort();
    const panelOpts = `<option value="">Random module</option>${zones.map((z) => `<optgroup label="Zone ${z}">${S.layout.filter((p) => p.zone === z).map((p) => `<option>${p.id}</option>`).join('')}</optgroup>`).join('')}`;
    const zoneOpts = `<option value="">Random zone</option>${zones.map((z) => `<option value="${z}">Zone ${z}</option>`).join('')}`;
    const groups = ['modules', 'structure', 'terrain'];
    $('#sc-groups').innerHTML = groups.map((g) => `
      <section class="sc-group">
        <h2>${GROUP_TITLE[g]}</h2>
        <ol class="sc-list">${S.scenarios.filter((sc) => sc.group === g).map((sc) => `
          <li class="sc-row" data-id="${sc.id}">
            <div class="sc-title"><span class="sev-mark" data-sev="${sc.severity}" aria-hidden="true"></span><b>${esc(sc.title)}</b><span class="sub">${SEV_LABEL[sc.severity]}</span></div>
            <dl class="sc-facts">
              <div><dt>Detected by</dt><dd>${esc(sc.sensor)}${sc.reading ? ` · <span class="mono">${esc(sc.reading)}</span>` : ''}<span class="sub">${esc(sc.detection)}</span></dd></div>
              <div><dt>The drone</dt><dd>${esc(sc.response)}</dd></div>
              <div><dt>Expected finding</dt><dd>${esc(sc.finding)}</dd></div>
            </dl>
            <div class="sc-act">
              <label class="select"><span class="sr">Cible</span><select data-target="${sc.target}">${sc.target === 'panel' ? panelOpts : zoneOpts}</select></label>
              <button class="btn primary small" data-trigger="${sc.id}">${icon('flash')}<span>Trigger</span></button>
            </div>
          </li>`).join('')}</ol>
      </section>`).join('') || '<p class="empty-state">Waiting for the plant: open the simulation.</p>';
  }

  const host = $('#inc-list');
  if (!S.incidents.length) {
    host.innerHTML = '<li class="empty">No simulated incident. Trigger a scenario on the left: the alert will appear just like in the field.</li>';
    return;
  }
  const STATE = { active: 'Active', repaired: 'Repaired', reset: 'Cleared (reset)' };
  host.innerHTML = S.incidents.map((i) => {
    const a = i.alertId ? S.alerts.find((x) => x.id === i.alertId) : null;
    const where = i.panel || i.damaged || `Zone ${i.zone}`;
    const status = i.state !== 'active' ? STATE[i.state] : a ? (a.diagnosis ? alertLine(a) : DISPATCH_LABEL[a.dispatch.status]) : 'Detection in progress…';
    return `<li class="inc" data-state="${i.state}">
      <span class="sev-mark" data-sev="${i.state === 'active' ? (a?.severity || 'none') : 'resolved'}" aria-hidden="true"></span>
      <div class="inc-main"><b>${esc(i.title)}</b><span class="sub">${i.id} · ${esc(where)} · ${since(i.createdAt)}</span><span class="inc-status">${esc(status)}</span></div>
      <div class="inc-act">${a ? `<a class="link" href="#alertes/${a.id}">${a.id}</a>` : ''}${i.state === 'active' ? `<button class="btn ghost small" data-repair="${i.id}">Repair</button>` : ''}</div>
    </li>`;
  }).join('');
}

$('#sc-groups').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-trigger]');
  if (!b) return;
  const sel = b.closest('.sc-row').querySelector('select');
  const sc = S.scenarios.find((x) => x.id === b.dataset.trigger);
  const params = { id: sc.id, ...(sel.value ? { [sel.dataset.target]: sel.value } : {}) };
  b.disabled = true;
  const r = await link.command('scenario', params);
  b.disabled = false;
  if (r.ok === false) notifier.toast({ level: 'warn', title: 'Scenario refused', text: r.error });
  else {
    const where = r.result.panel || `zone ${r.result.zone}`;
    notifier.toast({ level: 'info', title: `Simulated incident: ${sc.title.toLowerCase()} · ${where}`, text: sc.kind === 'current' ? 'The module current starts dropping; the alert opens as soon as the drop is confirmed.' : 'The alert opens in a few seconds, on detection.', timeout: 5000 });
  }
});
$('#inc-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-repair]');
  if (b) cmd('repairIncident', { id: b.dataset.repair }, 'Incident repaired');
});
$('#sc-repair-all').addEventListener('click', () => cmd('repairAll', {}, 'All simulated incidents repaired'));
$('#sc-autofaults').addEventListener('change', (ev) => cmd('settings', { autoFaults: ev.target.checked }, ev.target.checked ? 'Spontaneous faults on' : 'Spontaneous faults off: only your alerts will appear'));
$('#sc-autodispatch').addEventListener('change', (ev) => cmd('settings', { autoDispatch: ev.target.checked }, ev.target.checked ? 'Automatic drone dispatch on' : 'Automatic dispatch off'));
$('#sc-clean').addEventListener('click', () => confirmReset(true));
$('#sc-random').addEventListener('click', () => confirmReset(false));

// ======================================================================== tout

function renderAll() {
  renderLink();
  renderSettings();
  renderOperator();
  renderStatus();
  renderElectrical();
  renderAlertMini();
  renderLogs();
  renderBadges();
  if (S.view === 'alertes') {
    renderAlertRows();
    renderAlertDetail();
  }
  if (S.view === 'interventions') renderWorkOrders();
  if (S.view === 'panneaux') renderPanelTable();
  renderScenarios();
  lastCtrlKey = '';
  renderStatus();
}

route();
