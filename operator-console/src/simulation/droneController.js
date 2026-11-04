import * as THREE from 'three';
import { CONFIG, INSPECTION_TYPES, STATE_LABELS } from '../shared/config.js';
import { clamp, damp, smoothstep, wrapAngle } from '../shared/utils.js';

// Machine à états de la mission + cinématique « lissée » du drone (aucune physique).
//   IDLE → TAKEOFF → TRANSIT → POSITIONING → SCANNING → (panneau suivant) → RETURN → LANDING
// HOVER : vol stationnaire en mode manuel (après un survol ou une inspection isolée).
// MANUAL : pilotage à distance (console opérateur) — consignes de vitesse « manches »,
//          coupées automatiquement si la liaison se tait (homme mort).
// Deux types d'inspection partagent cette machine à états :
//   'modules'   : analyse rapprochée du verre (trajectoire en U au-dessus du panneau)
//   'structure' : vol bas dans les allées, arrêt devant chacun des 4 pieds et leurs fondations

const SUBSTEP = 1 / 120;
const deg = THREE.MathUtils.degToRad;

export class DroneController {
  constructor({ drone, plant }) {
    this.drone = drone;
    this.plant = plant;
    this.listeners = {};

    const B = CONFIG.base;
    this.padTop = B.padHeight;
    this.home = new THREE.Vector3(B.x, this.padTop, B.z);

    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this.yaw = 0;
    this.yawRate = 0;
    this.yawTarget = 0;
    this.rotorTarget = 0;
    this.gimbalPitch = deg(CONFIG.camera.gimbalRestPitch);
    this.airborne = 0;
    this.battery = 100;

    this.state = 'IDLE';
    this.stateTime = 0;
    this.paused = false;
    this.holdPoint = null;
    this.mode = null;             // 'mission' | 'manual' | 'pilot' | null
    this.missionZone = null;     // zone ciblée par la mission (null = toute la centrale)
    this.inspectType = 'modules';
    this.scanPath = [];           // positions du drone
    this.scanHolds = [];          // arrêt (s) à l'arrivée de chaque point
    this.scanKinds = [];          // nature du segment menant à chaque point
    this.scanYaws = [];           // cap à tenir vers chaque point
    this.scanPitches = [];        // inclinaison de la nacelle vers chaque point
    this.scanSpeeds = [];         // vitesse horizontale vers chaque point
    this.scanLegs = [];           // pied examiné à ce point (structures)
    this.scanDefects = [];        // true : arrêt prolongé devant un défaut
    this.holdDefect = false;
    this.scanIndex = 0;
    this.holdRemaining = 0;     // > 0 : examen prolongé d'un défaut en cours
    this.overviewZone = null;   // zone survolée (vue d'ensemble)
    this.pendingOverview = null;
    this.queue = [];
    this.currentPanel = null;
    this.pendingGoto = null;
    this.target = new THREE.Vector3();
    this.transitAlt = CONFIG.drone.transitAltitude;
    this.faceTarget = true;
    this.scanProgress = 0;
    this.stableTime = 0;
    this.missionTime = 0;
    this.lastResult = null;
    this.time = 0;

    this.landSpot = this.home.clone(); // point d'atterrissage (plateforme par défaut)
    this.sticks = { fwd: 0, right: 0, up: 0, yaw: 0 };
    this.sticksAt = -Infinity;
    this.pilotGimbal = CONFIG.camera.gimbalTransitPitch;

    this._desired = new THREE.Vector3();
    this._aDes = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- événements

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners[type] || []) fn(payload);
  }

  log(msg, level = 'info') {
    this.emit('log', { msg, level });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateTime = 0;
    this.emit('state', this.snapshotState());
  }

  snapshotState() {
    return { state: this.state, label: STATE_LABELS[this.state], paused: this.paused, mode: this.mode, type: this.inspectType };
  }

  // ---------------------------------------------------------------- commandes

  // Mission automatique sur toute la centrale, ou sur une seule zone (zoneId = 'A', 'B', 'C'),
  // pour l'un des deux types d'inspection ('modules' | 'structure')
  startMission(zoneId = null, type = 'modules') {
    if (!INSPECTION_TYPES[type]) return { ok: false, code: 400, error: `Unknown inspection type: ${type}` };
    this._clearOverview();
    const zone = zoneId ? this.plant.getZone(zoneId) : null;
    if (zoneId && !zone) return { ok: false, code: 404, error: `Unknown zone: ${zoneId}` };
    if (this.mode === 'mission' && this.state !== 'IDLE' && this.inspectType === type && (this.missionZone === zone || !zone)) {
      if (this.paused) return this.resume();
      return { ok: false, error: 'Mission already running' };
    }
    const scope = zone ? zone.panels : this.plant.panels;
    const rec = (p) => this.plant.record(p, type);
    let pending = scope.filter((p) => rec(p).status === 'pending' || rec(p).status === 'scanning');
    if (pending.length === 0) {
      for (const p of scope) {
        this.plant.setStatus(p, 'pending', type);
        this.emit('panel', p);
      }
      pending = [...scope];
      this.log(`All panels${zone ? ' of ' + zone.name : ''} were already inspected (${INSPECTION_TYPES[type].toLowerCase()}): starting a new full pass`);
    }
    this._abortScan();
    this.inspectType = type;
    this.queue = this.plant.missionOrder(this.pos.x, this.pos.z, pending);
    this.mode = 'mission';
    this.missionZone = zone;
    this.pendingGoto = null;
    this.paused = false;
    this.missionTime = 0;
    const n = this.queue.length;
    const what = type === 'structure' ? 'structures (legs and footings)' : 'modules (close-range scan)';
    this.log(`Mission started · ${zone ? zone.name + ': ' : ''}${n} panel${n > 1 ? 's' : ''} to inspect, ${what}`);
    if (this.state === 'IDLE' || this.state === 'TAKEOFF') this._takeoff();
    else this._next();
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  inspectPanel(id, type = 'modules') {
    if (!INSPECTION_TYPES[type]) return { ok: false, code: 400, error: `Unknown inspection type: ${type}` };
    this._clearOverview();
    const panel = this.plant.getPanel(id);
    if (!panel) return { ok: false, code: 404, error: `Unknown panel: ${id}` };
    if (this.mode === 'mission') this.log('Mission interrupted · switching to manual mode', 'warn');
    this._abortScan();
    this.inspectType = type;
    this.mode = 'manual';
    this.queue = [panel];
    this.pendingGoto = null;
    this.paused = false;
    this.log(`Manual inspection requested: ${panel.id} (${INSPECTION_TYPES[type].toLowerCase()})`);
    if (this.state === 'IDLE' || this.state === 'TAKEOFF') this._takeoff();
    else this._next();
    this.emit('state', this.snapshotState());
    return { ok: true, result: { panel: panel.id, type } };
  }

  gotoPoint(x, z) {
    this._clearOverview();
    const lim = 140;
    if (Math.abs(x) > lim || Math.abs(z) > lim) {
      return { ok: false, code: 400, error: `Point out of range (|x|, |z| ≤ ${lim} m)` };
    }
    if (this.mode === 'mission') this.log('Mission interrupted · switching to manual mode', 'warn');
    this._abortScan();
    this.mode = 'manual';
    this.queue = [];
    this.pendingGoto = new THREE.Vector3(x, CONFIG.drone.transitAltitude, z);
    this.paused = false;
    this.log(`Fly-over requested: x ${x.toFixed(1)} m, z ${z.toFixed(1)} m`);
    if (this.state === 'IDLE' || this.state === 'TAKEOFF') this._takeoff();
    else this._next();
    this.emit('state', this.snapshotState());
    return { ok: true, result: { x, z } };
  }

  // Le drone part survoler une zone : simple vue d'ensemble, aucune analyse
  surveyZone(id) {
    const zone = this.plant.getZone(id);
    if (!zone) return { ok: false, code: 404, error: `Unknown zone: ${id}` };
    if (this.mode === 'mission') this.log('Mission interrupted · zone survey', 'warn');
    this._abortScan();
    this._clearOverview();
    this.mode = 'manual';
    this.queue = [];
    const xs = zone.panels.map((p) => p.center.x);
    const zs = zone.panels.map((p) => p.center.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    this.pendingGoto = new THREE.Vector3(cx, CONFIG.drone.zoneOverviewAltitude, cz);
    this.pendingOverview = zone;
    this.paused = false;
    this.log(`${zone.name} survey requested`);
    if (this.state === 'IDLE' || this.state === 'TAKEOFF') this._takeoff();
    else this._next();
    this.emit('state', this.snapshotState());
    return { ok: true, result: { zone: zone.id } };
  }

  // Sortie de la base : décollage puis vol stationnaire (ou pilotage manuel si pilot = true)
  takeoff({ pilot = false } = {}) {
    if (this.state !== 'IDLE') return { ok: false, error: 'The drone is already flying' };
    if (this.battery < CONFIG.drone.minTakeoffBattery) {
      return { ok: false, error: `Battery too low to take off (${Math.round(this.battery)}%)` };
    }
    this._clearOverview();
    this.pendingReturn = false;
    this.mode = pilot ? 'pilot' : 'manual';
    this.queue = [];
    this.pendingGoto = null;
    this.paused = false;
    this.sticksAt = -Infinity;
    this.log(pilot ? 'Take-off requested · manual control once airborne' : 'Take-off requested · hovering above the base');
    this._takeoff();
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  // Pilotage à distance : on = prise en main, off = rendu au vol stationnaire
  setPilot(on) {
    if (on) {
      if (this.state === 'IDLE') return this.takeoff({ pilot: true });
      if (this.state === 'LANDING') return { ok: false, error: 'Landing in progress' };
      if (this.mode === 'pilot') return { ok: true };
      if (this.mode === 'mission') this.log('Mission interrupted · manual control', 'warn');
      this._clearOverview();
      this._abortScan();
      this.mode = 'pilot';
      this.queue = [];
      this.pendingGoto = null;
      this.currentPanel = null;
      this.paused = false;
      this.sticksAt = -Infinity;
      this.pilotGimbal = THREE.MathUtils.radToDeg(this.gimbalPitch);
      this.emit('target', null);
      if (this.state !== 'TAKEOFF') this.setState('MANUAL');
      this.log('Manual control · remote commands active', 'warn');
      this.emit('state', this.snapshotState());
      return { ok: true };
    }
    if (this.mode !== 'pilot') return { ok: true };
    this.mode = 'manual';
    if (this.state === 'MANUAL') {
      this.target.copy(this.pos);
      this.setState('HOVER');
    }
    this.log('Manual control released · hovering');
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  // Consignes des manches, normalisées entre -1 et 1 (repère du drone)
  setSticks({ fwd = 0, right = 0, up = 0, yaw = 0 } = {}) {
    if (this.state !== 'MANUAL') return { ok: false, error: 'The drone is not under manual control' };
    const n = (v) => clamp(Number(v) || 0, -1, 1);
    this.sticks = { fwd: n(fwd), right: n(right), up: n(up), yaw: n(yaw) };
    this.sticksAt = this.time;
    return { ok: true };
  }

  // Inclinaison de la nacelle en pilotage manuel (degrés, 0 = horizon, -90 = verticale)
  setGimbal(pitchDeg) {
    const v = Number(pitchDeg);
    if (!Number.isFinite(v)) return { ok: false, code: 400, error: 'Invalid gimbal angle' };
    this.pilotGimbal = clamp(v, -90, 0);
    return { ok: true, result: { pitch: this.pilotGimbal } };
  }

  // Atterrissage sur place (hors des zones de panneaux)
  landHere() {
    if (this.state === 'IDLE') return { ok: false, error: 'The drone is already on the ground' };
    if (this.state === 'LANDING') return { ok: true };
    const zone = this.plant.zoneAt(this.pos.x, this.pos.z);
    if (zone) return { ok: false, error: `Cannot land over ${zone.name}: move the drone away from the panels` };
    this._clearOverview();
    if (this.mode === 'mission') this.log('Mission interrupted · landing here', 'warn');
    this._abortScan();
    this.mode = null;
    this.queue = [];
    this.pendingGoto = null;
    this.currentPanel = null;
    this.paused = false;
    this.landSpot.set(this.pos.x, this._groundAt(this.pos.x, this.pos.z), this.pos.z);
    this.emit('target', null);
    this.setState('LANDING');
    this.log('Landing here');
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  _groundAt(x, z) {
    return Math.hypot(x - this.home.x, z - this.home.z) < CONFIG.base.padRadius ? this.padTop : 0;
  }

  get onPad() {
    return Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z) < CONFIG.base.padRadius;
  }

  // Inspection du terrain : survol d'un point à basse altitude, caméra à la verticale
  surveyPoint(x, z, altitude = CONFIG.drone.terrainSurveyAltitude) {
    const lim = 140;
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > lim || Math.abs(z) > lim) {
      return { ok: false, code: 400, error: `Point out of range (|x|, |z| ≤ ${lim} m)` };
    }
    if (this.mode === 'mission') this.log('Mission interrupted · ground survey', 'warn');
    this._abortScan();
    this._clearOverview();
    this.mode = 'manual';
    this.queue = [];
    const zone = this.plant.zoneAt(x, z);
    this.pendingGoto = new THREE.Vector3(x, altitude, z);
    this.pendingOverview = { id: zone ? zone.id : null, name: zone ? `${zone.name} (ground)` : 'reported area', panels: zone ? zone.panels : [], point: true };
    this.paused = false;
    this.log(`Ground survey requested: x ${x.toFixed(1)} m, z ${z.toFixed(1)} m`);
    if (this.state === 'IDLE' || this.state === 'TAKEOFF') this._takeoff();
    else this._next();
    this.emit('state', this.snapshotState());
    return { ok: true, result: { x, z } };
  }

  _clearOverview() {
    this.overviewZone = null;
    this.pendingOverview = null;
  }

  returnToBase() {
    if (this.state === 'IDLE' && !this.onPad) {
      // Posé hors base : redécollage puis retour
      if (this.battery < 8) return { ok: false, error: 'Battery depleted: the drone must be recovered manually' };
      this.mode = null;
      this.queue = [];
      this.pendingGoto = null;
      this.pendingReturn = true;
      this.log('Return to base requested · taking off again');
      this._takeoff();
      this.emit('state', this.snapshotState());
      return { ok: true };
    }
    if (this.state === 'IDLE') return { ok: false, error: 'The drone is already on its pad' };
    if (this.state === 'RETURN' || this.state === 'LANDING') {
      if (this.paused) this.resume();
      return { ok: true };
    }
    this._clearOverview();
    if (this.mode === 'mission') this.log('Mission interrupted · returning to base', 'warn');
    else this.log('Returning to base');
    this._abortScan();
    this.mode = null;
    this.queue = [];
    this.pendingGoto = null;
    this.currentPanel = null;
    this.paused = false;
    this._enterReturn();
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  pause() {
    if (this.state === 'IDLE') return { ok: false, error: 'Nothing to pause: the drone is on the ground' };
    if (this.paused) return { ok: true };
    this.paused = true;
    this.holdPoint = null;
    this.log('Paused · holding position', 'warn');
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  resume() {
    if (!this.paused) return { ok: false, error: 'Not paused' };
    this.paused = false;
    this.log('Reprise');
    this.emit('state', this.snapshotState());
    return { ok: true };
  }

  togglePause() {
    return this.paused ? this.resume() : this.pause();
  }

  // Replace le drone sur sa plateforme (réinitialisation complète)
  reset() {
    this._clearOverview();
    this._abortScan();
    this.pos.copy(this.home);
    this.landSpot.copy(this.home);
    this.sticksAt = -Infinity;
    this.vel.set(0, 0, 0);
    this.acc.set(0, 0, 0);
    this.yaw = 0;
    this.yawRate = 0;
    this.yawTarget = 0;
    this.rotorTarget = 0;
    this.airborne = 0;
    this.battery = 100;
    this.mode = null;
    this.missionZone = null;
    this.queue = [];
    this.pendingGoto = null;
    this.currentPanel = null;
    this.paused = false;
    this.missionTime = 0;
    this.lastResult = null;
    this.inspectType = 'modules';
    this.state = '';
    this.setState('IDLE');
  }

  // ---------------------------------------------------------------- transitions

  _takeoff() {
    if (this.state !== 'TAKEOFF') {
      this.setState('TAKEOFF');
      this.log('Arming motors · take-off');
    }
  }

  _next() {
    const D = CONFIG.drone;
    this.currentPanel = null;
    if (this.pendingReturn) {
      this.pendingReturn = false;
      this._enterReturn();
      return;
    }
    if (this.queue.length) {
      const panel = this.queue.shift();
      this.currentPanel = panel;
      const c = panel.center;
      this.scanPath = this.inspectType === 'structure' ? this._buildStructPath(panel) : this._buildScanPath(panel);
      const start = this.scanPath[0];
      const dH = Math.hypot(start.x - this.pos.x, start.z - this.pos.z);
      const short = dH <= D.strafeDistance && this.pos.y > 1;
      this.transitAlt = short ? c.y + D.hopHeight : D.transitAltitude;
      this.faceTarget = !short;
      this.target.set(start.x, this.transitAlt, start.z);
      this.emit('target', panel);
      this.setState('TRANSIT');
      return;
    }
    if (this.pendingGoto) {
      this.overviewZone = this.pendingOverview;
      this.pendingOverview = null;
      this.target.copy(this.pendingGoto);
      this.transitAlt = this.pendingGoto.y;
      this.faceTarget = true;
      this.pendingGoto = null;
      this.emit('target', null);
      this.setState('TRANSIT');
      return;
    }
    this.emit('target', null);
    if (this.mode === 'mission') {
      const panels = this.missionZone ? this.missionZone.panels : this.plant.panels;
      const rec = (p) => this.plant.record(p, this.inspectType);
      const defects = panels.filter((p) => rec(p).status === 'defect').length;
      const done = panels.filter((p) => rec(p).status === 'ok' || rec(p).status === 'defect').length;
      const what = this.inspectType === 'structure' ? 'structures inspected' : 'panels scanned';
      this.log(`Mission complete · ${this.missionZone ? this.missionZone.name + ': ' : ''}${done}/${panels.length} ${what}, ${defects} defect${defects !== 1 ? 's' : ''}`, defects ? 'warn' : 'ok');
      this.mode = null;
      this._enterReturn();
      return;
    }
    if (this.mode === 'pilot') {
      this.setState('MANUAL');
      this.log('Manual control · remote commands active', 'warn');
      return;
    }
    // Inspection isolée terminée : remontée au-dessus des panneaux, puis stationnaire
    this.target.copy(this.pos);
    this.target.y = Math.max(this.pos.y, D.safeHeight + 1);
    this.setState('HOVER');
  }

  // Trajectoire d'analyse rapprochée, en U le long des deux grands côtés du panneau :
  // passe haute, descente le long du petit côté, passe basse. Chaque point place la
  // caméra à scanStandoff du verre, sur la normale : la vue est perpendiculaire au panneau.
  _buildScanPath(panel) {
    const D = CONFIG.drone;
    const hw = CONFIG.plant.panelWidth / 2 + D.scanOvershoot;
    const e = D.scanEdgeOffset;
    const sx = this.pos.x >= panel.center.x ? 1 : -1;
    const camOffset = this.drone.cameraOffset(this.scanPitch());
    const pts = [[sx * hw, -e], [-sx * hw, -e], [-sx * hw, e], [sx * hw, e]];
    const holds = [0, 0, 0, 0];
    const kinds = ['start', 'top', 'side', 'bottom']; // nature du segment menant à chaque point
    // Panneau défectueux : arrêt supplémentaire caméra centrée sur le défaut,
    // inséré dans la passe (haute ou basse) la plus proche du défaut
    if (panel.defect) {
      const d = panel.pivot.worldToLocal(panel.defect.position.clone());
      const pass = Math.abs(d.z + e) <= Math.abs(d.z - e) ? 1 : 3;
      pts.splice(pass, 0, [d.x, d.z]);
      holds.splice(pass, 0, D.defectHoldTime);
      kinds.splice(pass, 0, 'defect');
    }
    this.scanHolds = holds;
    this.scanKinds = kinds;
    this.scanDefects = kinds.map((k) => k === 'defect');
    this.scanYaws = kinds.map(() => 0);
    this.scanPitches = kinds.map(() => this.scanPitch());
    this.scanSpeeds = kinds.map(() => D.scanSpeed);
    this.scanLegs = kinds.map(() => null);
    return pts.map(([x, z]) =>
      new THREE.Vector3(x, 0.016, z)
        .applyMatrix4(panel.pivot.matrixWorld)
        .addScaledVector(panel.normal, D.scanStandoff)
        .sub(camOffset));
  }

  scanPitch() {
    return -deg(90 - CONFIG.plant.tiltDeg);
  }

  // Inspection des structures : le drone descend dans l'allée, caméra presque à l'horizontale,
  // et s'arrête devant chaque pied (et sa fondation). Côté nord, les pieds arrière (hauts) ;
  // il franchit ensuite le panneau par le dessus et inspecte les pieds avant (courts) côté sud.
  _buildStructPath(panel) {
    const D = CONFIG.drone;
    const S = D.structure;
    const P = CONFIG.plant;
    const startNorth = this.pos.z <= panel.center.z;
    const startWest = this.pos.x <= panel.center.x;
    const sides = startNorth ? ['back', 'front'] : ['front', 'back'];
    const topY = P.lowEdgeHeight + P.panelLength * Math.sin(deg(P.tiltDeg)) + S.crossClearance;
    const defectLeg = panel.struct.defect ? panel.struct.defect.leg : null;
    const wp = [];

    // Point de vue devant un pied : caméra sur l'axe du pied, nacelle visant sa mi-hauteur
    const view = (leg) => {
      const back = leg.end === 'back';
      const alt = back ? S.backAltitude : S.frontAltitude;
      const standoff = back ? S.backStandoff : S.frontStandoff;
      const yaw = back ? Math.PI : 0; // face au sud (côté nord) / face au nord (côté sud)
      const pitch = -Math.atan2(alt - leg.height * 0.45, standoff);
      const cam = new THREE.Vector3(leg.x, alt, leg.z + (back ? -standoff : standoff));
      const pos = cam.sub(this.drone.cameraOffset(pitch).applyAxisAngle(_yAxis, yaw));
      return { pos, yaw, pitch };
    };

    let west = startWest;
    sides.forEach((end, i) => {
      const legs = panel.legs.filter((l) => l.end === end).sort((a, b) => (west ? a.x - b.x : b.x - a.x));
      if (i > 0) {
        // Franchissement : montée, passage au-dessus du panneau, descente côté opposé
        const last = wp[wp.length - 1];
        const next = view(legs[0]);
        wp.push({ pos: new THREE.Vector3(last.pos.x, topY, last.pos.z), yaw: last.yaw, pitch: last.pitch, kind: 'climb', speed: S.crossSpeed });
        wp.push({ pos: new THREE.Vector3(next.pos.x, topY, next.pos.z), yaw: next.yaw, pitch: next.pitch, kind: 'cross', speed: S.crossSpeed });
      }
      for (const leg of legs) {
        const v = view(leg);
        const isDefect = leg === defectLeg;
        wp.push({ ...v, kind: 'leg', leg, speed: S.speed, hold: isDefect ? D.defectHoldTime : S.legHold, defect: isDefect });
      }
      west = !west; // retour dans l'autre sens : pas de demi-tour latéral inutile
    });

    wp[0].kind = 'start';
    this.scanHolds = wp.map((w) => w.hold || 0);
    this.scanKinds = wp.map((w) => w.kind);
    this.scanDefects = wp.map((w) => Boolean(w.defect));
    this.scanYaws = wp.map((w) => w.yaw);
    this.scanPitches = wp.map((w) => w.pitch);
    this.scanSpeeds = wp.map((w) => w.speed);
    this.scanLegs = wp.map((w) => w.leg || null);
    return wp.map((w) => w.pos);
  }

  // Pied visé par la caméra (structures) : celui du point en cours d'approche ou d'examen
  get currentLeg() {
    if (this.inspectType !== 'structure' || !this.currentPanel) return null;
    if (this.state === 'POSITIONING') return this.scanLegs[0];
    if (this.state !== 'SCANNING') return null;
    return this.scanKinds[this.scanIndex] === 'leg' ? this.scanLegs[this.scanIndex] : null;
  }

  _pathProgress() {
    const path = this.scanPath;
    let total = 0;
    let done = 0;
    for (let i = 1; i < path.length; i++) {
      const len = path[i].distanceTo(path[i - 1]);
      total += len;
      if (i < this.scanIndex) done += len;
      else if (i === this.scanIndex) done += Math.max(0, len - this.pos.distanceTo(path[i]));
    }
    return clamp(done / total, 0, 1);
  }

  _enterReturn() {
    this.currentPanel = null;
    this.landSpot.copy(this.home);
    this.target.set(this.home.x, CONFIG.drone.transitAltitude, this.home.z);
    this.faceTarget = true;
    this.setState('RETURN');
  }

  _abortScan() {
    this.pendingReturn = false;
    const p = this.currentPanel;
    const type = this.inspectType;
    if (p && (this.state === 'SCANNING' || this.state === 'POSITIONING') && this.plant.record(p, type).status === 'scanning') {
      this.plant.setStatus(p, 'pending', type);
      this.emit('panel', p);
    }
    this.plant.endScan();
    this.drone.setScanCone(false);
    this.scanProgress = 0;
    this.holdRemaining = 0;
    this.holdDefect = false;
  }

  _finishScan() {
    const p = this.currentPanel;
    const type = this.inspectType;
    const rec = this.plant.record(p, type);
    this.plant.endScan();
    this.drone.setScanCone(false);
    const status = rec.defect ? 'defect' : 'ok';
    this.plant.setStatus(p, status, type);
    this.lastResult = { panel: p, status, type, leg: rec.defect ? rec.defect.leg : null, at: this.time };
    this.emit('panel', p);
    if (type === 'structure') {
      if (rec.defect) this.log(`${p.id} structure inspected · defect: ${rec.defect.label}`, 'defect');
      else this.log(`${p.id} structure inspected · 4 legs and footings healthy`, 'ok');
    } else if (rec.defect) this.log(`${p.id} scanned · defect found: ${rec.defect.label}`, 'defect');
    else this.log(`${p.id} scanned · OK`, 'ok');
    this._next();
  }

  // ---------------------------------------------------------------- simulation

  update(dt) {
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-6) {
      const h = Math.min(SUBSTEP, remaining);
      this._step(h);
      remaining -= h;
    }
  }

  _step(dt) {
    const D = CONFIG.drone;
    this.time += dt;
    this.stateTime += dt;
    if (this.mode === 'mission' && !this.paused) this.missionTime += dt;

    if (this.paused && this.state !== 'IDLE') {
      // Freinage doux puis maintien au point d'arrêt
      if (!this.holdPoint) {
        this._steerVelocity(dt, this._desired.set(0, 0, 0));
        if (this.vel.length() < 0.05) this.holdPoint = this.pos.clone();
      } else {
        this._steer(dt, this.holdPoint);
      }
      this.rotorTarget = 0.7;
      this._updateYaw(dt);
      this._post(dt);
      return;
    }
    this.holdPoint = null;

    switch (this.state) {
      case 'IDLE':
        this.vel.set(0, 0, 0);
        this.acc.set(0, 0, 0);
        this.rotorTarget = 0;
        this.gimbalPitch = deg(CONFIG.camera.gimbalRestPitch);
        if (this.onPad) this.battery = Math.min(100, this.battery + dt * 1.5);
        break;

      case 'TAKEOFF': {
        if (this.stateTime < D.spoolUpTime) {
          this.rotorTarget = 0.5;
          this.vel.set(0, 0, 0);
        } else {
          this.rotorTarget = 1;
          this.gimbalPitch = deg(CONFIG.camera.gimbalTransitPitch);
          this.target.set(this.pos.x, D.transitAltitude, this.pos.z);
          const r = this._steer(dt, this.target, { maxV: D.maxClimbSpeed, decelV: 1.2 });
          if (Math.abs(r.dy) < 0.12 && Math.abs(this.vel.y) < 0.25) this._next();
        }
        break;
      }

      case 'TRANSIT': {
        const dx = this.target.x - this.pos.x;
        const dz = this.target.z - this.pos.z;
        const dH = Math.hypot(dx, dz);
        if (this.faceTarget && dH > 1.2) this.yawTarget = Math.atan2(-dx, -dz);
        // Rotation vers la cible avant (ou pendant) le déplacement
        const err = Math.abs(wrapAngle(this.yawTarget - this.yaw));
        const align = this.faceTarget ? smoothstep(0.25, 0.85, Math.cos(err)) : 1;
        // Trop bas (près des panneaux) : remonter d'abord, presque à la verticale
        const climbFirst = this.pos.y < D.safeHeight && dH > 0.6 ? 0.12 : 1;
        const r = this._steer(dt, this.target, { hScale: Math.max(align, dH < 1.2 ? 1 : 0) * climbFirst });
        this.rotorTarget = 0.78 + 0.18 * Math.min(1, this.acc.length() / D.maxAccel);
        this.gimbalPitch = this.overviewZone && dH < 10 ? -Math.PI / 2 : deg(CONFIG.camera.gimbalTransitPitch);
        // Vers un panneau : la descente enchaîne sans arrêt complet (fin de transit fluide)
        const arrived = this.currentPanel
          ? r.dH < 0.9 && Math.abs(r.dy) < 0.6
          : r.dH < 0.25 && Math.abs(r.dy) < 0.3 && this.vel.length() < 0.6;
        if (arrived) {
          if (this.currentPanel) {
            this.plant.setStatus(this.currentPanel, 'scanning', this.inspectType);
            this.emit('panel', this.currentPanel);
            this.stableTime = 0;
            this.setState('POSITIONING');
          } else if (this.overviewZone) {
            this.target.copy(this.pos);
            this.setState('OVERVIEW');
            this.log(`${this.overviewZone.name} survey · overview in progress`);
          } else {
            this.target.copy(this.pos);
            this.setState('HOVER');
            this.log('Fly-over point reached · hovering');
          }
        }
        break;
      }

      case 'POSITIONING': {
        // Approche du début de la trajectoire, au cap du premier point (modules : au nord, face au verre)
        this.target.copy(this.scanPath[0]);
        this.yawTarget = this.scanYaws[0];
        // Structures : point de départ bas (≈ 1 m), freinage vertical plus progressif pour ne pas dépasser
        const low = this.inspectType === 'structure';
        const r = this._steer(dt, this.target, { maxH: 1.5, maxV: low ? 1.2 : 1.4, decelV: low ? 0.6 : 1.6 });
        this.rotorTarget = 0.7;
        this.gimbalPitch = this.scanPitches[0];
        const yawOk = Math.abs(wrapAngle(this.yawTarget - this.yaw)) < deg(3);
        if (r.dist < 0.08 && this.vel.length() < 0.1 && yawOk) {
          this.stableTime += dt;
          if (this.stableTime >= D.stabilizeTime) {
            this.scanProgress = 0;
            this.scanIndex = 1;
            this.holdDefect = false;
            if (this.inspectType === 'modules') this.plant.startScan(this.currentPanel);
            this.setState('SCANNING');
          }
        } else {
          this.stableTime = Math.max(0, this.stableTime - dt);
        }
        break;
      }

      case 'SCANNING': {
        // Déplacement lent d'un point à l'autre (côtés du panneau ou pieds), arrêt doux à chaque point
        const i = this.scanIndex;
        const tgt = this.scanPath[i];
        const kind = this.scanKinds[i];
        this.target.copy(tgt);
        this.yawTarget = this.scanYaws[i];
        const vertical = kind === 'climb' || kind === 'cross';
        const r = this._steer(dt, tgt, { maxH: this.scanSpeeds[i], maxV: vertical ? 1.0 : 0.6, decelV: 1.0 });
        this.rotorTarget = 0.7;
        this.gimbalPitch = this.scanPitches[i];
        const hold = this.scanHolds[i] || 0;
        const yawOk = Math.abs(wrapAngle(this.yawTarget - this.yaw)) < deg(4);
        if (this.holdRemaining > 0) {
          // Arrêt devant le point : bref pour un pied, prolongé (durée exacte) devant un défaut
          this.holdRemaining -= dt;
          if (this.holdRemaining <= 0) {
            this.holdRemaining = 0;
            this.holdDefect = false;
            this.scanHolds[i] = 0;
            this.scanIndex++;
          }
        } else if (r.dist < (vertical ? 0.15 : 0.05) && yawOk) {
          if (hold > 0) {
            this.holdRemaining = hold;
            this.holdDefect = this.scanDefects[i];
            if (this.holdDefect) {
              const where = this.scanLegs[i] ? ` (${this.scanLegs[i].name})` : '';
              this.log(`${this.currentPanel.id} · anomaly spotted${where}, extended look (${hold} s)`, 'warn');
            }
          } else {
            this.scanIndex++;
          }
        }
        this.scanProgress = this.scanIndex >= this.scanPath.length ? 1 : this._pathProgress();

        if (this.inspectType === 'modules') {
          // Empreinte de la caméra sur le verre (repère local du panneau)
          const cam = this.currentPanel.pivot.worldToLocal(this.drone.camera.getWorldPosition(_v));
          const d = Math.max(0.15, cam.y - 0.016);
          const { tanH, tanV } = this.drone.fovTangents();
          this.plant.updateScan(cam.x, cam.z, 2 * d * tanH, 2 * d * tanV);
          this.drone.setScanCone(true, d);
        } else {
          // Cône de visée vers le pied examiné
          const leg = this.currentLeg;
          this.drone.setScanCone(Boolean(leg), leg ? Math.hypot(leg.x - this.pos.x, leg.z - this.pos.z) : 1);
        }
        if (this.scanIndex >= this.scanPath.length) this._finishScan();
        break;
      }

      case 'MANUAL': {
        // Homme mort : sans consigne récente, le drone freine et tient sa position
        const P = CONFIG.drone.pilot;
        const live = this.time - this.sticksAt < P.deadman;
        const s = live ? this.sticks : _zeroSticks;
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        const d = this._desired.set(
          (fx * s.fwd + Math.cos(this.yaw) * s.right) * P.maxSpeed,
          s.up * P.maxClimb,
          (fz * s.fwd - Math.sin(this.yaw) * s.right) * P.maxSpeed,
        );
        // Barrière virtuelle : plafond, plancher (plus haut au-dessus des panneaux), périmètre
        const floor = this._groundAt(this.pos.x, this.pos.z) + (this.plant.zoneAt(this.pos.x, this.pos.z) ? P.minAltPanels : P.minAlt);
        if (this.pos.y < floor && d.y < 0.6) d.y = Math.min(P.maxClimb, (floor - this.pos.y) * 2 + 0.3);
        else if (this.pos.y < floor + 0.8 && d.y < 0) d.y *= Math.max(0, (this.pos.y - floor) / 0.8);
        if (this.pos.y > P.maxAlt && d.y > 0) d.y = (P.maxAlt - this.pos.y) * 2;
        for (const axis of ['x', 'z']) {
          const over = Math.abs(this.pos[axis]) - P.geofence;
          if (over > -2 && Math.sign(d[axis]) === Math.sign(this.pos[axis])) d[axis] *= Math.max(0, -over / 2);
        }
        this._steerVelocity(dt, d);
        this.yawTarget = this.yaw + s.yaw * deg(P.yawRate) / 2.2;
        this.rotorTarget = 0.72 + 0.2 * Math.min(1, this.acc.length() / D.maxAccel);
        this.gimbalPitch += (deg(this.pilotGimbal) - this.gimbalPitch) * damp(6, dt);
        break;
      }

      case 'HOVER':
        this._steer(dt, this.target);
        this.rotorTarget = 0.7;
        break;

      case 'OVERVIEW':
        // Vol stationnaire haut au-dessus de la zone, caméra à la verticale
        this._steer(dt, this.target);
        this.yawTarget = 0;
        this.rotorTarget = 0.72;
        this.gimbalPitch = -Math.PI / 2;
        break;

      case 'RETURN': {
        const dx = this.target.x - this.pos.x;
        const dz = this.target.z - this.pos.z;
        const dH = Math.hypot(dx, dz);
        if (dH > 1.2) this.yawTarget = Math.atan2(-dx, -dz);
        const err = Math.abs(wrapAngle(this.yawTarget - this.yaw));
        const align = smoothstep(0.25, 0.85, Math.cos(err));
        // Remonte d'abord si le drone est bas (près des panneaux)
        const low = this.pos.y < D.safeHeight ? 0.12 : this.pos.y < D.transitAltitude - 1.2 ? 0.5 : 1;
        const r = this._steer(dt, this.target, { hScale: Math.max(dH < 1.2 ? 1 : align * low, 0) });
        this.rotorTarget = 0.8;
        this.gimbalPitch = deg(CONFIG.camera.gimbalTransitPitch);
        if (r.dH < 0.12 && Math.abs(r.dy) < 0.3 && this.vel.length() < 0.25) {
          this.setState('LANDING');
          this.log('Above the pad · landing');
        }
        break;
      }

      case 'LANDING': {
        this.target.copy(this.landSpot);
        const h = this.pos.y - this.landSpot.y;
        const maxV = D.landingSpeed + (D.maxClimbSpeed - D.landingSpeed) * smoothstep(0.8, 3, h);
        const r = this._steer(dt, this.target, { maxV, decelV: 0.45 });
        this.rotorTarget = 0.55 + 0.1 * smoothstep(0, 2, h);
        if (h < 0.015 && r.dH < 0.1) {
          this.pos.copy(this.landSpot);
          this.vel.set(0, 0, 0);
          this.acc.set(0, 0, 0);
          this.mode = null;
          this.setState('IDLE');
          this.log(this.onPad ? 'Landed · motors off' : 'Landed off base · motors off', 'ok');
        }
        break;
      }
    }

    this._updateYaw(dt);
    this._post(dt);
  }

  _post(dt) {
    // Sol / plateforme : jamais en dessous
    const floor = this._groundAt(this.pos.x, this.pos.z);
    if (this.pos.y < floor) {
      this.pos.y = floor;
      if (this.vel.y < 0) this.vel.y = 0;
    }
    const alt = this.pos.y - floor;
    const targetAir = this.state === 'IDLE' ? 0 : smoothstep(0.02, 0.5, alt);
    this.airborne += (targetAir - this.airborne) * damp(6, dt);
    if (this.state !== 'IDLE') this.battery = Math.max(0, this.battery - CONFIG.drone.batteryDrainPerSec * dt);
  }

  _updateYaw(dt) {
    const D = CONFIG.drone;
    const err = wrapAngle(this.yawTarget - this.yaw);
    const maxRate = deg(D.maxYawRate);
    const wanted = clamp(err * 2.2, -maxRate, maxRate);
    this.yawRate += (wanted - this.yawRate) * damp(4, dt);
    if (this.state === 'IDLE') this.yawRate = 0;
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
  }

  // Déplacement vers une cible avec profil de vitesse « freinage » et accélération lissée.
  _steer(dt, target, { maxH = CONFIG.drone.maxSpeed, maxV = CONFIG.drone.maxClimbSpeed, decelV = CONFIG.drone.brakeDecel, hScale = 1 } = {}) {
    const D = CONFIG.drone;
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dz = target.z - this.pos.z;
    const dH = Math.hypot(dx, dz);
    const vH = Math.min(maxH * hScale, Math.sqrt(2 * D.brakeDecel * dH) * 0.92, dH * 1.6);
    const d = this._desired;
    if (dH > 1e-5) d.set((dx / dH) * vH, 0, (dz / dH) * vH);
    else d.set(0, 0, 0);
    const aY = Math.abs(dy);
    d.y = Math.sign(dy) * Math.min(maxV, Math.sqrt(2 * decelV * aY) * 0.92, aY * 1.6);
    this._steerVelocity(dt, d);
    return { dH, dy, dist: Math.hypot(dH, dy) };
  }

  _steerVelocity(dt, desired) {
    const D = CONFIG.drone;
    const a = this._aDes.subVectors(desired, this.vel).multiplyScalar(2.4);
    const h = Math.hypot(a.x, a.z);
    if (h > D.maxAccel) {
      a.x *= D.maxAccel / h;
      a.z *= D.maxAccel / h;
    }
    a.y = clamp(a.y, -2.2, 2.2);
    this.acc.lerp(a, damp(D.jerkRate, dt));
    this.vel.addScaledVector(this.acc, dt);
    this.pos.addScaledVector(this.vel, dt);
  }

  // ---------------------------------------------------------------- lecture

  get heading() {
    return (THREE.MathUtils.radToDeg(-this.yaw) + 360) % 360;
  }

  get altitude() {
    return Math.max(0, this.pos.y - this.padTop); // hauteur relative au point de décollage
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  kinematics() {
    return {
      position: this.pos,
      velocity: this.vel,
      accel: this.acc,
      yaw: this.yaw,
      rotor: this.rotorTarget,
      gimbalPitch: this.gimbalPitch,
      airborne: this.airborne,
      time: this.time,
    };
  }

  getStatus() {
    const panels = this.plant.panels;
    const analyzed = panels.filter((p) => p.status === 'ok' || p.status === 'defect').length;
    const structDone = panels.filter((p) => p.struct.status === 'ok' || p.struct.status === 'defect').length;
    const r = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
    return {
      drone: {
        position: { x: r(this.pos.x), y: r(this.pos.y), z: r(this.pos.z) },
        altitude: r(this.altitude),
        speed: r(this.speed),
        verticalSpeed: r(this.vel.y),
        heading: r(this.heading, 1),
        battery: r(this.battery, 1),
        gimbalPitch: r(THREE.MathUtils.radToDeg(this.gimbalPitch), 1),
        onPad: this.onPad,
        airborne: this.state !== 'IDLE',
      },
      mission: {
        state: this.state,
        label: STATE_LABELS[this.state],
        mode: this.mode,
        type: this.inspectType,
        paused: this.paused,
        pilot: this.mode === 'pilot',
        zone: this.missionZone ? this.missionZone.id : null,
        overviewZone: this.overviewZone ? this.overviewZone.id : null,
        terrainSurvey: Boolean(this.overviewZone?.point) && this.state === 'OVERVIEW',
        defectHold: this.holdRemaining > 0 ? Math.round(this.holdRemaining * 10) / 10 : null,
        currentPanel: this.currentPanel ? this.currentPanel.id : null,
        currentLeg: this.currentLeg ? this.currentLeg.code : null,
        scanProgress: this.state === 'SCANNING' ? r(this.scanProgress) : null,
        queue: this.queue.map((p) => p.id),
        analyzed,
        total: panels.length,
        defects: panels.filter((p) => p.status === 'defect').length,
        structure: {
          inspected: structDone,
          total: panels.length,
          defects: panels.filter((p) => p.struct.status === 'defect').length,
        },
        elapsed: r(this.missionTime, 1),
      },
      zones: this.plant.zones.map((z) => ({
        id: z.id,
        name: z.name,
        ...this.plant.zoneStats(z, 'modules'),
        structure: this.plant.zoneStats(z, 'structure'),
      })),
      panels: panels.map((p) => ({
        id: p.id,
        zone: p.zone.id,
        row: p.row + 1,
        col: p.col + 1,
        x: r(p.center.x),
        z: r(p.center.z),
        status: p.status,
        defect: p.status === 'defect' ? p.defect.label : null,
        structure: {
          status: p.struct.status,
          defect: p.struct.status === 'defect' ? p.struct.defect.label : null,
        },
      })),
    };
  }
}

const _v = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _zeroSticks = { fwd: 0, right: 0, up: 0, yaw: 0 };
