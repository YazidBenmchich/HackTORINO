// Exploitation de la centrale, côté serveur (console opérateur) :
//  - supervision électrique simulée : courant, tension et puissance de chaque panneau,
//    irradiance et température par zone (capteurs de référence), passages nuageux ;
//  - détection : écart du courant mesuré au courant attendu (irradiance de la zone),
//    donc un nuage ne déclenche pas d'alerte, seul un panneau qui décroche en déclenche ;
//  - alertes, envoi autonome du drone sur le panneau suspect, diagnostic (photo du défaut),
//    ordre de travail, puis remise en état ;
//  - journal d'exploitation et dernière image du retour vidéo.
//
// Les défauts « réels » viennent de la simulation 3D (modèle de la centrale) : ils restent
// cachés à l'opérateur jusqu'au diagnostic du drone. Avec les défauts spontanés activés,
// ils se déclarent électriquement un par un, avec une montée progressive.
//
// Démonstration : l'équipe déclenche elle-même des incidents (scenarios.js) — module,
// structure ou terrain. L'incident est posé dans la simulation (défaut visible, objet au sol),
// puis détecté comme il le serait sur le terrain (courant, capteur, météo, onduleur).

import { SCENARIOS, SCENARIO_BY_ID } from './scenarios.js';

const IMP_STC = 10.4;          // A, courant au point de puissance max (1000 W/m², 25 °C)
const VMP_STC = 38.6;          // V
const COEF_I = 0.0005;         // /°C
const COEF_V = -0.0029;        // /°C
const HISTORY_S = 900;         // historique puissance centrale (s)
const PANEL_HISTORY_S = 300;   // historique courant par panneau (s)
const WARN_DEV = -0.06;        // écart déclenchant la surveillance
const CRIT_DEV = -0.15;        // écart critique
const CLEAR_DEV = -0.03;       // retour à la normale
const WARN_SAMPLES = 4;
const CRIT_SAMPLES = 3;
const CLEAR_SAMPLES = 15;
const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_DISPATCH_BATTERY = 30;

// Effet électrique d'un défaut : facteur final sur le courant et constante de temps (s)
export const FAULTS = {
  hotspot: { label: 'hot spot', factor: 0.64, tau: 14 },
  crack: { label: 'cracked cell', factor: 0.79, tau: 18 },
  soiling: { label: 'soiling', factor: 0.88, tau: 24 },
  electrical: { label: 'electrical fault', factor: 0.7, tau: 10 },
  shading: { label: 'shading', factor: 0.9, tau: 12, silent: true }, // végétation : pas d'alerte de module
};
const MAX_FLIGHT_GUST = 36;    // km/h : au-delà, le drone ne décolle pas
const TERRAIN_SURVEY_S = 5;    // durée du survol d'inspection du terrain

const ACTIONS = {
  'hot spot': { title: 'Module replacement', detail: 'Hot spot confirmed by thermography: check the bypass diode, replace the module.', priority: 'high', duration: '2 h' },
  'cracked cell': { title: 'Module replacement', detail: 'Visible cracked cell: replace the module before the crack spreads.', priority: 'high', duration: '2 h' },
  soiling: { title: 'Module cleaning', detail: 'Local soiling (dust, droppings): clean with demineralised water.', priority: 'normal', duration: '30 min' },
  none: { title: 'Electrical check', detail: 'Nothing visible from the drone: check MC4 connectors, bypass diode and string wiring.', priority: 'high', duration: '1 h' },
};

const pad = (n, w = 4) => String(n).padStart(w, '0');
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class Operations {
  constructor({ relay, isConnected, broadcast, log }) {
    this.relay = relay;             // (action, params) => Promise<ack|null>
    this.isConnected = isConnected; // () => boolean (simulation connectée)
    this.broadcast = broadcast;     // (obj) => void, vers les consoles
    this.serverLog = log;

    this.settings = { autoDispatch: true, autoFaults: false, autoReturn: true };
    this.panels = [];               // état électrique
    this.byId = new Map();
    this.zones = new Map();         // id -> { irradiance, temp }
    this.plantHistory = [];         // [{ t, power, irradiance }]
    this.energyWh = 0;
    this.weather = { ambient: 24, wind: 12, gust: 18, rain: 0 };
    this.storm = null;              // coup de vent simulé { start, peak }
    this.rainEvent = null;          // averse simulée { start, peak }
    this.incidents = [];            // incidents simulés (démonstration)
    this.incSeq = 0;
    this.epoch = null;
    this.cloud = null;
    this.nextCloudAt = Date.now() + 90_000;

    this.alerts = [];
    this.workOrders = [];
    this.logs = [];
    this.alertSeq = 0;
    this.woSeq = 0;
    this.faultQueue = [];
    this.nextFaultAt = Infinity;

    this.status = null;             // dernier état de la simulation
    this.statusAt = 0;
    this.prevPanelStatus = new Map();
    this.dispatch = null;           // intervention du drone en cours
    this.dispatchBusy = false;
    this.lastFrame = null;          // Buffer JPEG
    this.lastFrameAt = 0;

    this.timer = setInterval(() => this._tick(), 1000);
    this.dispatchTimer = setInterval(() => this._dispatchLoop(), 500);
  }

  // ------------------------------------------------------------------ entrées simulation

  // Modèle de la centrale (connexion ou réinitialisation de la simulation)
  setPlantModel(model) {
    const list = Array.isArray(model?.panels) ? model.panels : [];
    if (!list.length) return;
    const fresh = !this.panels.length;
    const sameLayout = !fresh && list.length === this.panels.length && list.every((p) => this.byId.has(p.id));
    if (!sameLayout) {
      this.panels = list.map((p) => this._newPanel(p));
      this.byId = new Map(this.panels.map((p) => [p.id, p]));
      for (const z of new Set(this.panels.map((p) => p.zone))) this.zones.set(z, { irradiance: 0, temp: 25 });
      this._backfill();
      this.broadcast({ type: 'layout', layout: this.panels.map((p) => ({ id: p.id, zone: p.zone, row: p.row, col: p.col, x: p.x, z: p.z })) });
    }
    for (const p of list) {
      const st = this.byId.get(p.id);
      st.truth = p.fault || null;
    }
    // Nouvelle centrale (connexion, réinitialisation) : on repart d'une centrale électriquement
    // saine. Un défaut ajouté à la main (même époque) ne fait que mettre à jour la vérité terrain.
    const epoch = model.epoch ?? null;
    if (fresh || epoch !== this.epoch) {
      this.epoch = epoch;
      this._rescheduleFaults(fresh);
    }
  }

  _newPanel(p) {
    return {
      id: p.id, zone: p.zone, row: p.row, col: p.col, x: p.x, z: p.z,
      truth: p.fault || null,
      fault: null,            // défaut déclaré électriquement { type, factor, tau, since }
      health: 1,
      current: 0, voltage: 0, power: 0, expected: 0, deviation: 0, cellTemp: 25,
      warnCount: 0, critCount: 0, clearCount: 0,
      history: [],
    };
  }

  // Les défauts réels se déclarent un par un : le premier ~25 s après la connexion
  _rescheduleFaults(fresh) {
    for (const p of this.panels) {
      p.fault = null;
      p.health = 1;
    }
    for (const inc of this.incidents) if (inc.state === 'active') inc.state = 'reset';
    this.storm = null;
    this.rainEvent = null;
    if (this.dispatch) this.dispatch = null;
    this._broadcastIncidents();
    const pending = this.panels.filter((p) => p.truth && !p.fault).map((p) => p.id);
    for (let i = pending.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    this.faultQueue = pending;
    this.nextFaultAt = Date.now() + 25_000;
    if (!fresh) {
      for (const a of this.alerts) {
        if (a.state !== 'resolved') this._resolveAlert(a, 'Plant reset');
      }
    }
  }

  onStatus(status) {
    const st = status?.mission?.state;
    if (st !== this.status?.mission?.state) this.stateSince = Date.now();
    this.status = status;
    this.statusAt = Date.now();
    this._watchPanels(status);
  }

  onLog(msg, level) {
    this.addLog(msg, level, 'drone');
  }

  onFrame(buf) {
    this.lastFrame = buf;
    this.lastFrameAt = Date.now();
    const d = this.dispatch;
    const s = this.status;
    if (!d || !s) return;
    if (d.inspection === 'terrain') {
      // Preuve : l'image prise pendant le survol vertical du point
      if (d.surveyStart) d.evidence = { buf, hold: true };
      return;
    }
    if (s.mission?.currentPanel === d.panel && s.mission.state === 'SCANNING') {
      // Preuve : l'image prise pendant l'arrêt devant le défaut, sinon au milieu de la passe
      if (s.mission.defectHold != null) d.evidence = { buf, hold: true };
      else if (!d.evidence?.hold && (s.mission.scanProgress ?? 0) >= 0.35) d.evidence = { buf, hold: false };
    }
  }

  // ------------------------------------------------------------------ journal

  addLog(msg, level = 'info', source = 'ops') {
    const entry = { at: Date.now(), msg, level, source };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.broadcast({ type: 'log', entry });
    return entry;
  }

  // ------------------------------------------------------------------ modèle électrique

  _environment(now) {
    const t = now / 1000;
    const W = this.weather;
    W.ambient = 24 + 1.6 * Math.sin(t / 900) + 0.3 * Math.sin(t / 97);
    W.wind = Math.max(2, 12 + 4 * Math.sin(t / 140) + 2.2 * Math.sin(t / 23) + gauss() * 0.6);
    W.gust = W.wind * (1.35 + 0.1 * Math.sin(t / 31));
    // Coup de vent simulé : rafales au pic ~15 s, puis retour au calme en ~30 s
    if (this.storm) {
      const k = (now - this.storm.start) / 1000;
      const f = k < 15 ? 1 : Math.exp(-(k - 15) / 9);
      W.gust = Math.max(W.gust, this.storm.peak * f * (0.94 + 0.06 * Math.random()));
      W.wind = Math.max(W.wind, W.gust / 1.45);
      if (k > 60) this.storm = null;
    }
    W.rain = 0;
    if (this.rainEvent) {
      const k = (now - this.rainEvent.start) / 1000;
      W.rain = this.rainEvent.peak * (k < 20 ? 1 : Math.exp(-(k - 20) / 25));
      if (k > 120) this.rainEvent = null;
    }

    // Passage nuageux : un nuage traverse la centrale d'ouest en est en ~50 s
    if (!this.cloud && now >= this.nextCloudAt) {
      this.cloud = { start: now, depth: 0.25 + Math.random() * 0.25, width: 16 + Math.random() * 10 };
    }
    let cloudX = null;
    if (this.cloud) {
      const k = (now - this.cloud.start) / 50_000;
      if (k > 1) {
        this.cloud = null;
        this.nextCloudAt = now + 150_000 + Math.random() * 150_000;
      } else cloudX = -70 + 140 * k;
    }
    const base = 872 + 22 * Math.sin(t / 420) + 6 * Math.sin(t / 37);
    const zoneX = new Map();
    for (const p of this.panels) {
      const e = zoneX.get(p.zone) || [0, 0];
      zoneX.set(p.zone, [e[0] + p.x, e[1] + 1]);
    }
    for (const [id, z] of this.zones) {
      const [sx, n] = zoneX.get(id) || [0, 1];
      const cx = sx / n;
      const shade = cloudX == null ? 0 : this.cloud.depth * Math.exp(-(((cx - cloudX) / this.cloud.width) ** 2));
      const rainShade = W.rain > 1 ? Math.min(0.6, W.rain / 80) : 0;
      z.irradiance = Math.max(80, base * (1 - shade) * (1 - rainShade) + gauss() * 3);
      z.temp = W.ambient;
    }
  }

  _sample(p, now, dt) {
    const z = this.zones.get(p.zone);
    const G = z.irradiance;
    // Dégradation progressive vers le facteur final du défaut
    const targetHealth = p.fault ? p.fault.factor : 1;
    const tau = p.fault ? p.fault.tau : 6;
    p.health += (targetHealth - p.health) * (1 - Math.exp(-dt / tau));
    p.cellTemp = z.temp + (G / 800) * 24 + (1 - p.health) * 30;
    const expected = IMP_STC * (G / 1000) * (1 + COEF_I * (p.cellTemp - 25));
    p.expected = expected;
    p.current = Math.max(0, expected * p.health * (1 + gauss() * 0.004));
    p.voltage = VMP_STC * (1 + COEF_V * (p.cellTemp - 25)) * (p.fault?.type === 'hotspot' ? 0.97 : 1);
    p.power = p.current * p.voltage;
    p.deviation = expected > 0.5 ? p.current / expected - 1 : 0;
    p.history.push([round(p.current, 3), round(p.expected, 3)]);
    if (p.history.length > PANEL_HISTORY_S) p.history.shift();
  }

  // Historique pré-rempli (centrale saine) pour que les courbes aient un passé
  _backfill() {
    const now = Date.now();
    this.plantHistory = [];
    for (const p of this.panels) p.history = [];
    for (let i = HISTORY_S; i > 0; i--) {
      const t = now - i * 1000;
      this._environment(t);
      let power = 0;
      let expected = 0;
      for (const p of this.panels) {
        this._sample(p, t, 1);
        power += p.power;
        expected += p.expected * p.voltage;
      }
      this.plantHistory.push({ t, power: round(power, 1), expected: round(expected, 1), irradiance: round(this._meanIrradiance(), 1) });
      this.energyWh += power / 3600;
    }
    this.cloud = null;
    this.nextCloudAt = now + 70_000;
  }

  _meanIrradiance() {
    let s = 0;
    for (const z of this.zones.values()) s += z.irradiance;
    return this.zones.size ? s / this.zones.size : 0;
  }

  _tick() {
    if (!this.panels.length) return;
    const now = Date.now();
    this._environment(now);

    // Défaut réel qui se déclare électriquement
    if (this.settings.autoFaults && now >= this.nextFaultAt && this.faultQueue.length) {
      const id = this.faultQueue.shift();
      const p = this.byId.get(id);
      if (p && p.truth && !p.fault) this._startFault(p, p.truth);
      this.nextFaultAt = now + 70_000 + Math.random() * 50_000;
    }

    let power = 0;
    let expected = 0;
    for (const p of this.panels) {
      this._sample(p, now, 1);
      power += p.power;
      expected += p.expected * p.voltage;
      this._detect(p, now);
    }
    this.energyWh += power / 3600;
    this.plantHistory.push({ t: now, power: round(power, 1), expected: round(expected, 1), irradiance: round(this._meanIrradiance(), 1) });
    if (this.plantHistory.length > HISTORY_S) this.plantHistory.shift();
    this.broadcast({ type: 'scada', data: this.scadaFrame(now) });
  }

  _startFault(p, type) {
    const f = FAULTS[type] || FAULTS.electrical;
    p.fault = { type, factor: f.factor * (0.97 + Math.random() * 0.05), tau: f.tau, since: Date.now(), silent: Boolean(f.silent) };
  }

  // Détection : écart soutenu au courant attendu de la zone
  _detect(p, now) {
    if (p.fault?.silent && !this.openAlertFor(p.id)) return; // ombrage : signalé par l'alerte de terrain
    const dev = p.deviation;
    p.warnCount = dev <= WARN_DEV ? p.warnCount + 1 : 0;
    p.critCount = dev <= CRIT_DEV ? p.critCount + 1 : 0;
    p.clearCount = dev > CLEAR_DEV ? p.clearCount + 1 : 0;
    let alert = this.openAlertFor(p.id);
    if (!alert && p.warnCount >= WARN_SAMPLES) {
      alert = this._openAlert(p, now);
    }
    if (!alert) return;
    alert.measured = round(p.current, 2);
    alert.expected = round(p.expected, 2);
    alert.deviation = round(dev, 4);
    if (dev < alert.worstDeviation) alert.worstDeviation = round(dev, 4);
    if (alert.severity === 'warning' && p.critCount >= CRIT_SAMPLES) {
      alert.severity = 'critical';
      alert.updatedAt = now;
      this._history(alert, `Escalated to critical: current ${pct(dev)} below expected`);
      this.addLog(`${p.id} · current ${pct(dev)} below expected: critical alert`, 'critical', 'scada');
      this.broadcast({ type: 'alert', event: 'escalate', alert: this.publicAlert(alert) });
    }
    if (p.clearCount >= CLEAR_SAMPLES && alert.state !== 'resolved') {
      this._resolveAlert(alert, 'Current back to normal');
    }
  }

  _openAlert(p, now) {
    const inc = this.incidents.find((i) => i.state === 'active' && i.kind === 'current' && i.panel === p.id && !i.alertId);
    const alert = {
      id: `AL-${pad(++this.alertSeq)}`,
      panel: p.id, zone: p.zone, row: p.row, col: p.col,
      kind: 'current',
      title: 'Current drop',
      target: p.id,
      inspection: 'modules',
      targets: [p.id],
      sensor: 'Module current (optimizer)',
      scenario: inc ? inc.scenario : null,
      incident: inc ? inc.id : null,
      severity: 'warning',
      state: 'open',
      openedAt: now, updatedAt: now,
      measured: round(p.current, 2), expected: round(p.expected, 2),
      deviation: round(p.deviation, 4), worstDeviation: round(p.deviation, 4),
      dispatch: { status: this.settings.autoDispatch ? 'pending' : 'manual', at: now, note: null },
      diagnosis: null,
      snapshot: false,
      workOrder: null,
      acknowledged: false,
      history: [],
    };
    this._history(alert, `Current drop detected: ${round(p.current, 1)} A for ${round(p.expected, 1)} A expected (${pct(p.deviation)})`);
    if (inc) {
      inc.alertId = alert.id;
      this._broadcastIncidents();
    }
    this.alerts.unshift(alert);
    if (this.alerts.length > 200) this.alerts.pop();
    this.addLog(`${p.id} · current drop (${pct(p.deviation)}): alert ${alert.id} opened`, 'warn', 'scada');
    this.broadcast({ type: 'alert', event: 'new', alert: this.publicAlert(alert) });
    return alert;
  }

  _resolveAlert(alert, reason) {
    alert.state = 'resolved';
    alert.resolvedAt = Date.now();
    alert.updatedAt = alert.resolvedAt;
    if (['pending', 'queued', 'waiting', 'manual'].includes(alert.dispatch.status)) {
      alert.dispatch = { status: 'cancelled', at: Date.now(), note: reason };
    }
    this._history(alert, `Closed: ${reason}`);
    this.addLog(`${alert.target} · ${alert.id} closed (${reason.toLowerCase()})`, 'ok', 'scada');
    this.broadcast({ type: 'alert', event: 'resolve', alert: this.publicAlert(alert) });
  }

  _history(alert, text) {
    alert.history.push({ at: Date.now(), text });
  }

  openAlertFor(panelId) {
    return this.alerts.find((a) => a.kind === 'current' && a.panel === panelId && a.state !== 'resolved') || null;
  }

  // Alerte venant d'un capteur (structure, météo, onduleur) ou d'un motif de courants (terrain)
  _openSensorAlert(sc, inc) {
    const now = Date.now();
    const p = inc.panel ? this.byId.get(inc.panel) : null;
    const alert = {
      id: `AL-${pad(++this.alertSeq)}`,
      panel: inc.panel || null, zone: inc.zone, row: p?.row ?? null, col: p?.col ?? null,
      kind: sc.kind,
      title: sc.title,
      target: inc.panel || `Zone ${inc.zone}`,
      inspection: sc.inspection,
      targets: inc.targets || (inc.panel ? [inc.panel] : []),
      point: inc.point || null,
      sensor: sc.sensor,
      reading: sc.reading,
      scenario: sc.id,
      incident: inc.id,
      severity: sc.severity,
      state: 'open',
      openedAt: now, updatedAt: now,
      dispatch: { status: this.settings.autoDispatch ? 'pending' : 'manual', at: now, note: null },
      diagnosis: null,
      snapshot: false,
      workOrder: null,
      acknowledged: false,
      history: [],
    };
    this._history(alert, `${sc.sensor} : ${sc.reading}`);
    inc.alertId = alert.id;
    this.alerts.unshift(alert);
    if (this.alerts.length > 200) this.alerts.pop();
    this.addLog(`${alert.target} · ${sc.title.toLowerCase()} (${sc.reading}): alert ${alert.id} opened`, sc.severity === 'critical' ? 'critical' : 'warn', 'scada');
    this.broadcast({ type: 'alert', event: 'new', alert: this.publicAlert(alert) });
    this._broadcastIncidents();
    return alert;
  }

  // ------------------------------------------------------------------ drone : envoi autonome

  _droneAvailability(alert) {
    const s = this.status;
    if (!s || !this.isConnected()) return { ok: false, note: 'Drone link unavailable' };
    const m = s.mission;
    if (m.pilot) return { ok: false, wait: 'waiting', note: 'Waiting: drone under manual control' };
    if (this.weather.gust >= MAX_FLIGHT_GUST && m.state === 'IDLE') {
      return { ok: false, wait: 'waiting', note: `Waiting: gusts at ${Math.round(this.weather.gust)} km/h, no flight` };
    }
    if (s.drone.battery < MIN_DISPATCH_BATTERY && m.state === 'IDLE') return { ok: false, wait: 'waiting', note: `Waiting: battery at ${Math.round(s.drone.battery)}%, charging` };
    if (m.state === 'LANDING' && !s.drone.onPad) return { ok: false, wait: 'waiting', note: 'Waiting: landing in progress' };
    // Ordre de l'opérateur en cours. Un survol stationnaire de zone n'est plus un ordre en
    // cours au bout de 20 s, et le survol d'inspection du terrain est le nôtre.
    const holding = m.state === 'OVERVIEW' && (m.terrainSurvey || Date.now() - (this.stateSince || 0) > 20_000);
    if (m.mode === 'manual' && ['TRANSIT', 'POSITIONING', 'SCANNING', 'OVERVIEW'].includes(m.state) && !holding && !this.dispatch) {
      return { ok: false, wait: 'waiting', note: 'Waiting: the drone is executing an operator order' };
    }
    if (m.mode === 'mission' && m.state !== 'IDLE' && alert.severity !== 'critical') {
      return { ok: false, wait: 'queued', note: 'Queued: inspection mission in progress' };
    }
    return { ok: true };
  }

  async _dispatchLoop() {
    if (this.dispatchBusy) return;
    if (this.dispatch) return this._followDispatch();
    // Un envoi interrompu est relancé de lui-même quand le drone se libère (envoi automatique actif)
    const retry = (a) => a.dispatch.status === 'interrupted' && this.settings.autoDispatch && Date.now() - a.dispatch.at > 15_000;
    const candidates = this.alerts
      .filter((a) => a.state !== 'resolved' && !a.diagnosis && (['pending', 'queued', 'waiting'].includes(a.dispatch.status) || retry(a)))
      .sort((a, b) => (a.severity === b.severity ? a.openedAt - b.openedAt : a.severity === 'critical' ? -1 : 1));
    for (const a of candidates) {
      const av = this._droneAvailability(a);
      if (av.ok) {
        await this.sendDrone(a, 'auto');
        return;
      }
      if (av.wait && (a.dispatch.status !== av.wait || a.dispatch.note !== av.note)) {
        a.dispatch = { status: av.wait, at: Date.now(), note: av.note };
        this.broadcast({ type: 'alert', event: 'update', alert: this.publicAlert(a) });
      }
    }
  }

  // Envoi du drone sur le panneau de l'alerte (automatique ou demandé par l'opérateur)
  async sendDrone(alert, by = 'operator') {
    if (this.dispatch && this.dispatch.alertId !== alert.id) {
      return { ok: false, code: 409, error: `Drone already busy with ${this.dispatch.panel || 'a ground survey'}` };
    }
    this.dispatchBusy = true;
    try {
      const targets = alert.targets?.length ? alert.targets : alert.panel ? [alert.panel] : [];
      const inspection = alert.inspection || 'modules';
      const ack = inspection === 'terrain'
        ? await this.relay('surveyPoint', { x: alert.point.x, z: alert.point.z })
        : await this.relay('goto', { panel: targets[0], type: inspection });
      if (!ack) return { ok: false, code: 503, error: 'No simulation connected' };
      if (!ack.ok) {
        alert.dispatch = { status: 'waiting', at: Date.now(), note: ack.error };
        this.broadcast({ type: 'alert', event: 'update', alert: this.publicAlert(alert) });
        return { ok: false, code: ack.code || 409, error: ack.error };
      }
      this.dispatch = {
        alertId: alert.id, inspection, targets, idx: 0, panel: targets[0] || null, point: alert.point || null,
        startedAt: Date.now(), sawScan: false, evidence: null, evidences: [], findings: [], surveyStart: 0, by,
      };
      alert.dispatch = { status: 'en-route', at: Date.now(), note: by === 'auto' ? 'Automatic dispatch' : `Sent by ${by}` };
      this._history(alert, by === 'auto' ? 'Drone dispatched automatically for diagnosis' : `Drone sent by ${by}`);
      const what = inspection === 'terrain' ? 'ground survey' : inspection === 'structure' ? `structure inspection${targets.length > 1 ? ` (${targets.join(', ')})` : ''}` : 'diagnosis';
      this.addLog(`${alert.target} · drone ${by === 'auto' ? 'dispatched automatically' : 'sent'}: ${what} (${alert.id})`, 'drone', 'ops');
      this.broadcast({ type: 'alert', event: 'dispatch', alert: this.publicAlert(alert) });
      return { ok: true };
    } finally {
      this.dispatchBusy = false;
    }
  }

  _followDispatch() {
    const d = this.dispatch;
    const alert = this.alerts.find((a) => a.id === d.alertId);
    const s = this.status;
    if (!alert || !s) return;
    if (alert.state === 'resolved') {
      this.dispatch = null;
      return;
    }
    const m = s.mission;
    const setStatus = (status, note) => {
      if (alert.dispatch.status === status && alert.dispatch.note === note) return;
      alert.dispatch = { status, at: Date.now(), note };
      this.broadcast({ type: 'alert', event: 'update', alert: this.publicAlert(alert) });
    };

    if (d.inspection === 'terrain') {
      const pos = s.drone.position;
      const near = Math.hypot(pos.x - d.point.x, pos.z - d.point.z) < 2.5;
      if (m.terrainSurvey && near) {
        if (!d.surveyStart) d.surveyStart = Date.now();
        setStatus('inspecting', 'Ground survey, camera pointing down');
        if (Date.now() - d.surveyStart >= TERRAIN_SURVEY_S * 1000) {
          const inc = this.incidents.find((i) => i.id === alert.incident);
          const sc = SCENARIO_BY_ID[alert.scenario];
          const found = inc && inc.state === 'active';
          this._conclude(alert, found ? { result: 'defect', label: inc.findingLabel || sc.finding } : { result: 'none', label: null }, d.evidence);
          this._afterDispatch(s);
        }
        return;
      }
      if (m.state === 'TAKEOFF' || m.state === 'TRANSIT' || (m.state === 'OVERVIEW' && !near)) return this._checkInterrupted(d, alert, false);
      return this._checkInterrupted(d, alert, true);
    }

    // Modules ou structures : un module après l'autre
    const target = d.targets[d.idx];
    const here = m.currentPanel === target;
    if (here && (m.state === 'POSITIONING' || m.state === 'SCANNING')) {
      d.sawScan = true;
      const n = d.targets.length;
      setStatus('inspecting', d.inspection === 'structure'
        ? `Inspecting the legs of ${target}${n > 1 ? ` (${d.idx + 1}/${n})` : ''}`
        : 'Close-range scan in progress');
      return;
    }
    const panel = s.panels?.find((p) => p.id === target);
    const rec = panel ? (d.inspection === 'structure' ? panel.structure : panel) : null;
    if (d.sawScan && rec && (rec.status === 'ok' || rec.status === 'defect')) {
      d.findings.push({ panel: target, defect: rec.status === 'defect' ? rec.defect : null });
      if (d.evidence) d.evidences.push({ ...d.evidence, defect: rec.status === 'defect' });
      if (d.idx + 1 < d.targets.length) {
        d.idx++;
        d.panel = d.targets[d.idx];
        d.sawScan = false;
        d.evidence = null;
        d.startedAt = Date.now();
        this.relay('goto', { panel: d.panel, type: d.inspection });
        return;
      }
      if (alert.kind === 'current') {
        this._diagnose(alert, panel, d.evidence);
      } else {
        const bad = d.findings.filter((f) => f.defect);
        const evidence = d.evidences.find((e) => e.defect) || d.evidences[d.evidences.length - 1];
        this._conclude(alert, bad.length
          ? { result: 'defect', label: bad.map((f) => `${f.panel}: ${f.defect}`).join(' · '), panels: bad.map((f) => f.panel) }
          : { result: 'none', label: null }, evidence);
      }
      this._afterDispatch(s);
      return;
    }
    this._checkInterrupted(d, alert, (m.currentPanel && !here) || m.state === 'RETURN' || m.state === 'IDLE' || m.state === 'OVERVIEW');
  }

  // L'opérateur a repris la main, ou autre intervention : envoi interrompu
  _checkInterrupted(d, alert, elsewhere) {
    const m = this.status.mission;
    const other = elsewhere || m.pilot || m.mode === 'mission';
    const stale = Date.now() - d.startedAt > DISPATCH_TIMEOUT_MS;
    // Délai de grâce : l'état du drone peut arriver avec un léger retard après l'ordre
    if ((other && Date.now() - d.startedAt > 4000) || stale) {
      alert.dispatch = { status: 'interrupted', at: Date.now(), note: stale ? 'Timed out' : 'Interrupted: the drone received another order' };
      this._history(alert, `Drone dispatch interrupted${stale ? ' (timed out)' : ''}`);
      this.addLog(`${alert.target} · drone dispatch interrupted`, 'warn', 'ops');
      this.broadcast({ type: 'alert', event: 'update', alert: this.publicAlert(alert) });
      this.dispatch = null;
    }
  }

  // Plus rien à diagnostiquer : retour à la base
  _afterDispatch(s) {
    this.dispatch = null;
    const more = this.alerts.some((a) => a.state !== 'resolved' && !a.diagnosis && ['pending', 'queued', 'waiting'].includes(a.dispatch.status));
    if (!more && this.settings.autoReturn && !s.mission.pilot && s.mission.mode !== 'mission') {
      this.relay('returnToBase').then((ack) => {
        if (ack?.ok) this.addLog('Diagnosis complete: drone returning to base automatically', 'drone', 'ops');
      });
    }
  }

  // Diagnostic d'une alerte de structure ou de terrain
  _conclude(alert, diag, evidence) {
    alert.diagnosis = { ...diag, at: Date.now() };
    alert.dispatch = { status: 'done', at: Date.now(), note: 'Diagnosis done' };
    if (evidence?.buf) {
      alert.snapshotBuf = evidence.buf;
      alert.snapshot = true;
    }
    const found = diag.result === 'defect';
    this._history(alert, found ? `Drone diagnosis: ${diag.label}` : 'Drone diagnosis: nothing abnormal found');
    this.addLog(`${alert.target} · diagnosis: ${found ? diag.label : 'nothing abnormal found'}`, found ? 'defect' : 'ok', 'drone');
    if (found) {
      const wo = this._createWorkOrder(alert);
      this.broadcast({ type: 'workorder', event: 'new', workOrder: wo });
    }
    this.broadcast({ type: 'alert', event: 'diagnosis', alert: this.publicAlert(alert) });
  }

  _diagnose(alert, panel, evidence) {
    const found = panel.status === 'defect';
    const label = found ? panel.defect : null;
    alert.diagnosis = { result: found ? 'defect' : 'none', label, at: Date.now() };
    alert.dispatch = { status: 'done', at: Date.now(), note: 'Diagnosis done' };
    if (evidence?.buf) {
      alert.snapshotBuf = evidence.buf;
      alert.snapshot = true;
    }
    this._history(alert, found ? `Drone diagnosis: ${label}` : 'Drone diagnosis: no visible defect');
    this.addLog(`${alert.target} · diagnosis: ${found ? label : 'no visible defect, electrical check required'}`, found ? 'defect' : 'warn', 'drone');
    const wo = this._createWorkOrder(alert);
    this.broadcast({ type: 'alert', event: 'diagnosis', alert: this.publicAlert(alert) });
    this.broadcast({ type: 'workorder', event: 'new', workOrder: wo });
  }

  // Diagnostic obtenu hors envoi (mission, inspection manuelle) : rattaché à l'alerte ouverte
  _watchPanels(status) {
    for (const p of status.panels || []) {
      const prev = this.prevPanelStatus.get(p.id);
      this.prevPanelStatus.set(p.id, p.status);
      if (!prev || prev === p.status || (p.status !== 'ok' && p.status !== 'defect')) continue;
      if (prev !== 'scanning') continue;
      if (this.dispatch?.panel === p.id) continue;
      const alert = this.openAlertFor(p.id);
      if (alert && !alert.diagnosis) this._diagnose(alert, p, null);
    }
  }

  // ------------------------------------------------------------------ ordres de travail

  _createWorkOrder(alert) {
    const key = alert.diagnosis.result === 'defect' ? alert.diagnosis.label : 'none';
    const sc = alert.scenario ? SCENARIO_BY_ID[alert.scenario] : null;
    const action = alert.kind === 'current' ? ACTIONS[key] || ACTIONS.none : sc.action;
    const wo = {
      id: `OT-${pad(++this.woSeq)}`,
      alertId: alert.id,
      kind: alert.kind,
      panel: alert.panel,
      target: alert.diagnosis.panels?.length === 1 ? alert.diagnosis.panels[0] : alert.target,
      zone: alert.zone,
      title: action.title,
      detail: action.detail,
      finding: alert.diagnosis.result === 'defect' ? alert.diagnosis.label : 'no visible defect',
      priority: alert.severity === 'critical' ? 'high' : action.priority,
      duration: action.duration,
      status: 'open',
      assignee: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: alert.snapshot,
      loss: alert.kind === 'current' ? round(Math.max(0, alert.expected - alert.measured) * VMP_STC, 0) : null,
    };
    this.workOrders.unshift(wo);
    alert.workOrder = wo.id;
    this._history(alert, `Work order ${wo.id} created: ${wo.title.toLowerCase()}`);
    this.addLog(`${wo.id} created · ${wo.target}: ${wo.title.toLowerCase()} (${wo.priority} priority)`, 'info', 'ops');
    return wo;
  }

  async updateWorkOrder(id, { status, assignee, by } = {}) {
    const wo = this.workOrders.find((w) => w.id === id);
    if (!wo) return { ok: false, code: 404, error: `Unknown work order: ${id}` };
    if (assignee !== undefined) wo.assignee = assignee ? String(assignee).slice(0, 40) : null;
    if (status !== undefined) {
      if (!['open', 'planned', 'done'].includes(status)) return { ok: false, code: 400, error: 'Expected status: open, planned or done' };
      if (wo.status === 'done') return { ok: false, code: 409, error: 'Work order already closed' };
      wo.status = status;
      if (status === 'planned') this.addLog(`${wo.id} scheduled${wo.assignee ? ` · ${wo.assignee}` : ''}`, 'info', 'ops');
      if (status === 'done') {
        wo.closedAt = Date.now();
        // Intervention réalisée : remise en état (électriquement et dans la simulation)
        const alert = this.alerts.find((a) => a.id === wo.alertId);
        const inc = alert?.incident ? this.incidents.find((i) => i.id === alert.incident) : null;
        if (inc) await this._repairIncident(inc);
        else if (wo.panel) {
          const p = this.byId.get(wo.panel);
          if (p) {
            p.fault = null;
            p.truth = null;
            this.faultQueue = this.faultQueue.filter((x) => x !== p.id);
          }
          await this.relay('repair', { panel: wo.panel });
        }
        if (alert && alert.kind !== 'current' && alert.state !== 'resolved') this._resolveAlert(alert, 'Repair done');
        this.addLog(`${wo.id} closed by ${operatorName(by)} · ${wo.target} repaired`, 'ok', 'ops');
      }
    }
    wo.updatedAt = Date.now();
    this.broadcast({ type: 'workorder', event: 'update', workOrder: wo });
    return { ok: true, result: wo };
  }

  // ------------------------------------------------------------------ actions opérateur

  acknowledge(id, by) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return { ok: false, code: 404, error: `Unknown alert: ${id}` };
    if (!a.acknowledged) {
      a.acknowledged = true;
      a.acknowledgedBy = operatorName(by);
      a.updatedAt = Date.now();
      this._history(a, `Acknowledged by ${a.acknowledgedBy}`);
      this.addLog(`${a.target} · ${a.id} acknowledged by ${a.acknowledgedBy}`, 'info', 'ops');
      this.broadcast({ type: 'alert', event: 'update', alert: this.publicAlert(a) });
    }
    return { ok: true };
  }

  async dispatchAlert(id, by) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return { ok: false, code: 404, error: `Unknown alert: ${id}` };
    if (a.state === 'resolved') return { ok: false, code: 409, error: 'Alert already closed' };
    return this.sendDrone(a, operatorName(by));
  }

  closeAlert(id, by) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return { ok: false, code: 404, error: `Unknown alert: ${id}` };
    if (a.state === 'resolved') return { ok: true };
    this._resolveAlert(a, `Closed by ${operatorName(by)}`);
    return { ok: true };
  }

  // Démo : un panneau décroche maintenant (défaut réel s'il en a un, sinon défaut électrique invisible)
  injectFault(panelId) {
    if (!this.panels.length) return { ok: false, code: 503, error: 'Plant not connected' };
    let p = panelId ? this.byId.get(String(panelId).toUpperCase()) : null;
    if (panelId && !p) return { ok: false, code: 404, error: `Unknown panel: ${panelId}` };
    if (!p) {
      const id = this.faultQueue.shift();
      p = id ? this.byId.get(id) : null;
      if (!p) {
        const healthy = this.panels.filter((x) => !x.fault && !this.openAlertFor(x.id));
        p = healthy[Math.floor(Math.random() * healthy.length)];
      }
    }
    if (!p) return { ok: false, code: 409, error: 'No panel available' };
    if (p.fault) return { ok: false, code: 409, error: `${p.id} already has a fault` };
    this.faultQueue = this.faultQueue.filter((x) => x !== p.id);
    this._startFault(p, p.truth || 'electrical');
    this.nextFaultAt = Math.max(this.nextFaultAt, Date.now() + 60_000);
    this.serverLog(`demo: fault triggered on ${p.id}`);
    return { ok: true, result: { panel: p.id } };
  }

  // ------------------------------------------------------------------ démonstration : incidents simulés

  _broadcastIncidents() {
    this.broadcast({ type: 'incidents', incidents: this.incidents.slice(0, 40) });
  }

  _zoneGeometry(zoneId) {
    const ps = this.panels.filter((p) => p.zone === zoneId);
    if (!ps.length) return null;
    const rows = [...new Set(ps.map((p) => p.z))].sort((a, b) => a - b);
    const cols = [...new Set(ps.map((p) => p.x))].sort((a, b) => a - b);
    return { ps, rows, cols, cx: (cols[0] + cols[cols.length - 1]) / 2 };
  }

  // Déclenche un incident simulé. target : { panel } ou { zone } selon le scénario.
  async injectScenario(id, { panel, zone } = {}) {
    const sc = SCENARIO_BY_ID[id];
    if (!sc) return { ok: false, code: 404, error: `Unknown scenario: ${id}` };
    if (!this.panels.length || !this.isConnected()) return { ok: false, code: 503, error: 'Simulation not connected: open the simulation page' };
    const rnd = (a) => a[Math.floor(Math.random() * a.length)];
    const now = Date.now();
    const inc = { id: `INC-${pad(++this.incSeq, 3)}`, scenario: sc.id, title: sc.title, kind: sc.kind, group: sc.group, createdAt: now, state: 'active', alertId: null };

    if (sc.target === 'panel') {
      let p = panel ? this.byId.get(String(panel).toUpperCase()) : null;
      if (panel && !p) return { ok: false, code: 404, error: `Unknown module: ${panel}` };
      const busy = (x) => this.incidents.some((i) => i.state === 'active' && i.panel === x.id);
      if (!p) p = rnd(this.panels.filter((x) => !x.fault && !busy(x)));
      if (!p) return { ok: false, code: 409, error: 'No module available' };
      if (busy(p) || (sc.kind === 'current' && p.fault)) return { ok: false, code: 409, error: `${p.id} already has an incident in progress` };
      inc.panel = p.id;
      inc.zone = p.zone;
      if (sc.kind === 'current') {
        if (sc.fault !== 'electrical') {
          const ack = await this.relay('injectDefect', { panel: p.id, kind: 'module', type: sc.fault });
          if (!ack?.ok) return { ok: false, code: ack?.code || 503, error: ack?.error || 'Simulation not connected' };
        }
        p.truth = sc.fault === 'electrical' ? null : sc.fault;
        this._startFault(p, sc.fault);
      } else {
        const ack = await this.relay('injectDefect', { panel: p.id, kind: 'structure', type: sc.struct });
        if (!ack?.ok) return { ok: false, code: ack?.code || 503, error: ack?.error || 'Simulation not connected' };
        setTimeout(() => inc.state === 'active' && this._openSensorAlert(sc, inc), 3000);
      }
    } else {
      const zoneId = String(zone || rnd([...this.zones.keys()])).toUpperCase();
      const g = this._zoneGeometry(zoneId);
      if (!g) return { ok: false, code: 404, error: `Unknown zone: ${zone}` };
      inc.zone = zoneId;
      if (sc.id === 'storm') {
        // Rafale : un module de bordure ouest est endommagé, on inspecte ses voisins de rangée
        const row = rnd(g.rows);
        const rowPanels = g.ps.filter((x) => x.z === row).sort((a, b) => a.x - b.x);
        const victim = rowPanels[Math.floor(Math.random() * 3)];
        const ack = await this.relay('injectDefect', { panel: victim.id, kind: 'structure', type: sc.struct });
        if (!ack?.ok) return { ok: false, code: ack?.code || 503, error: ack?.error || 'Simulation not connected' };
        inc.panel = null;
        inc.damaged = victim.id;
        inc.targets = rowPanels.slice(0, 3).map((x) => x.id);
        this.storm = { start: now, peak: 96 };
        setTimeout(() => inc.state === 'active' && this._openSensorAlert(sc, inc), 6000);
      } else {
        // Emplacement du problème de terrain : allée entre deux rangées, ou pied de la rangée sud
        const south = g.rows[g.rows.length - 1];
        const aisle = (i) => (g.rows[i] + g.rows[i + 1]) / 2 + 0.35;
        const x = g.cx + (Math.random() - 0.5) * 6;
        let point;
        if (sc.terrain === 'vegetation') point = { x: g.cx + (Math.random() - 0.5) * 4, z: south + 1.25 };
        else if (sc.terrain === 'water') point = { x, z: south + 2.4 };
        else if (sc.terrain === 'subsidence') point = { x, z: aisle(0) };
        else point = { x, z: aisle(Math.min(1, g.rows.length - 2)) };
        point = { x: round(point.x, 2), z: round(point.z, 2) };
        const ack = await this.relay('terrainAdd', { id: inc.id, type: sc.terrain, x: point.x, z: point.z });
        if (!ack?.ok) return { ok: false, code: ack?.code || 503, error: ack?.error || 'Simulation not connected' };
        inc.point = point;
        if (sc.terrain === 'vegetation') {
          // Ombrage : les modules du bas de rangée devant la végétation perdent du courant
          inc.shaded = g.ps.filter((x) => x.z === south && Math.abs(x.x - point.x) < 5.2).map((x) => x.id);
          for (const pid of inc.shaded) this._startFault(this.byId.get(pid), 'shading');
          inc.findingLabel = `Overgrown vegetation in front of ${inc.shaded.join(', ')}`;
        }
        if (sc.id === 'rain') this.rainEvent = { start: now, peak: 48 };
        setTimeout(() => inc.state === 'active' && this._openSensorAlert(sc, inc), sc.terrain === 'vegetation' ? 14000 : 4000);
      }
    }
    this.incidents.unshift(inc);
    this.addLog(`Demo · simulated incident ${inc.id}: ${sc.title.toLowerCase()} (${inc.panel || `zone ${inc.zone}`})`, 'info', 'ops');
    this._broadcastIncidents();
    return { ok: true, result: { incident: inc.id, panel: inc.panel || null, zone: inc.zone, point: inc.point || null } };
  }

  async _repairIncident(inc) {
    if (inc.state !== 'active') return;
    inc.state = 'repaired';
    inc.repairedAt = Date.now();
    const sc = SCENARIO_BY_ID[inc.scenario];
    if (sc.kind === 'current') {
      const p = this.byId.get(inc.panel);
      if (p) {
        p.fault = null;
        p.truth = null;
      }
      await this.relay('repair', { panel: inc.panel });
    } else if (sc.kind === 'structure') {
      const pid = inc.damaged || inc.panel;
      if (pid) await this.relay('repairStructure', { panel: pid });
      if (sc.id === 'storm') this.storm = null;
    } else {
      await this.relay('terrainRemove', { id: inc.id });
      for (const pid of inc.shaded || []) {
        const p = this.byId.get(pid);
        if (p?.fault?.type === 'shading') p.fault = null;
      }
      if (sc.id === 'rain') this.rainEvent = null;
    }
    this._broadcastIncidents();
  }

  async repairIncident(id) {
    const inc = this.incidents.find((i) => i.id === id);
    if (!inc) return { ok: false, code: 404, error: `Unknown incident: ${id}` };
    await this._repairIncident(inc);
    const alert = this.alerts.find((a) => a.id === inc.alertId);
    if (alert && alert.state !== 'resolved' && alert.kind !== 'current') this._resolveAlert(alert, 'Simulated incident repaired');
    return { ok: true };
  }

  async repairAll() {
    for (const inc of this.incidents.filter((i) => i.state === 'active')) await this.repairIncident(inc.id);
    return { ok: true };
  }

  setSettings(patch = {}) {
    for (const k of Object.keys(this.settings)) {
      if (typeof patch[k] === 'boolean') this.settings[k] = patch[k];
    }
    if (patch.autoDispatch === true) {
      for (const a of this.alerts) {
        if (a.state !== 'resolved' && a.dispatch.status === 'manual') a.dispatch = { status: 'pending', at: Date.now(), note: null };
      }
    }
    if (patch.autoDispatch === false) {
      for (const a of this.alerts) {
        if (a.state !== 'resolved' && ['pending', 'queued', 'waiting'].includes(a.dispatch.status)) a.dispatch = { status: 'manual', at: Date.now(), note: null };
      }
    }
    this.broadcast({ type: 'settings', settings: this.settings });
    return { ok: true, result: this.settings };
  }

  // ------------------------------------------------------------------ lecture

  publicAlert(a) {
    // eslint-disable-next-line no-unused-vars
    const { snapshotBuf, ...rest } = a;
    return rest;
  }

  scadaFrame(now = Date.now()) {
    const power = this.panels.reduce((s, p) => s + p.power, 0);
    const expected = this.panels.reduce((s, p) => s + p.expected * p.voltage, 0);
    const last = this.plantHistory[this.plantHistory.length - 1];
    return {
      t: now,
      plant: {
        power: round(power, 1),
        expected: round(expected, 1),
        performance: expected > 0 ? round(power / expected, 4) : null,
        energyKWh: round(this.energyWh / 1000, 2),
        irradiance: round(this._meanIrradiance(), 0),
        point: last ? [last.t, last.power, last.expected, last.irradiance] : null,
      },
      weather: { ambient: round(this.weather.ambient, 1), wind: round(this.weather.wind * 1, 1), gust: round(this.weather.gust, 1), rain: round(this.weather.rain, 0), cloud: Boolean(this.cloud), flight: this.weather.gust < MAX_FLIGHT_GUST },
      zones: [...this.zones].map(([id, z]) => ({ id, irradiance: round(z.irradiance, 0), temp: round(z.temp, 1) })),
      // [id, courant A, tension V, puissance W, écart, courant attendu A]
      panels: this.panels.map((p) => [p.id, round(p.current, 2), round(p.voltage, 1), round(p.power, 0), round(p.deviation, 4), round(p.expected, 2)]),
    };
  }

  snapshot() {
    return {
      settings: this.settings,
      layout: this.panels.map((p) => ({ id: p.id, zone: p.zone, row: p.row, col: p.col, x: p.x, z: p.z })),
      scada: this.panels.length ? this.scadaFrame() : null,
      plantHistory: this.plantHistory.map((h) => [h.t, h.power, h.expected, h.irradiance]),
      panelHistory: Object.fromEntries(this.panels.map((p) => [p.id, p.history])),
      alerts: this.alerts.map((a) => this.publicAlert(a)),
      workOrders: this.workOrders,
      logs: this.logs.slice(-200),
      dispatch: this.dispatch ? { alertId: this.dispatch.alertId, panel: this.dispatch.panel, point: this.dispatch.point } : null,
      scenarios: SCENARIOS,
      incidents: this.incidents.slice(0, 40),
    };
  }

  alertSnapshot(id) {
    return this.alerts.find((a) => a.id === id)?.snapshotBuf || null;
  }
}

function operatorName(by) {
  return typeof by === 'string' && by.trim() ? by.trim().slice(0, 40) : 'the operator';
}

function pct(dev) {
  return `${dev < 0 ? '−' : '+'}${Math.abs(Math.round(dev * 100))}%`;
}
