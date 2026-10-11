import '@fontsource-variable/inter';
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createWorld, createLandingPad, LAYERS } from './scene.js';
import { SolarPlant } from './solarPlant.js';
import { Drone } from './drone.js';
import { DroneController } from './droneController.js';
import { CameraFeed } from './cameraFeed.js';
import { UI } from './ui.js';
import { Network } from './network.js';
import { FeedStreamer } from './streamer.js';
import { TerrainIssues, TERRAIN_TYPES } from './terrain.js';
import { damp } from '../shared/utils.js';
import { CONFIG, DEFECT_TYPES } from '../shared/config.js';

const viewport = document.getElementById('viewport');
const world = createWorld(viewport);
const { renderer, scene, camera, controls } = world;
const DEFAULT_VIEW = { position: camera.position.clone(), target: controls.target.clone() };

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'css2d-layer';
viewport.appendChild(labelRenderer.domElement);

const pad = createLandingPad();
scene.add(pad);

const plant = new SolarPlant(scene);
plant.randomizeDefects();
const terrain = new TerrainIssues(scene);

const drone = new Drone(scene);
const controller = new DroneController({ drone, plant });
let network = null; // liaison serveur (créée plus bas)
const plantEpoch0 = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let plantEpochN = 0;
let plantEpoch = `${plantEpoch0}:0`;

const feed = new CameraFeed({
  renderer,
  scene,
  drone,
  controller,
  plant,
  viewport,
  feedEl: document.getElementById('feed'),
  hudCanvas: document.getElementById('hud'),
  sunDir: world.sunDir,
});

const view = { follow: false, labels: true, speed: 1, transition: null, zone: null };

// ---------------------------------------------------------------- aides visuelles 3D (vue principale)

const marker = new THREE.Group();
{
  const ringGeo = new THREE.RingGeometry(0.42, 0.55, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x3ec4ff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
  const ring = new THREE.Mesh(ringGeo, mat);
  const dotGeo = new THREE.CircleGeometry(0.1, 24);
  dotGeo.rotateX(-Math.PI / 2);
  marker.add(ring, new THREE.Mesh(dotGeo, mat));
  marker.userData.ring = ring;
  marker.traverse((o) => o.layers.set(LAYERS.MAIN_ONLY));
  marker.visible = false;
  scene.add(marker);
}

const dropLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.45, depthWrite: false }),
);
dropLine.layers.set(LAYERS.MAIN_ONLY);
dropLine.frustumCulled = false;
scene.add(dropLine);

// ---------------------------------------------------------------- actions

function doReset({ clean = false } = {}) {
  plantEpoch = `${plantEpoch0}:${++plantEpochN}`;
  controller.reset();
  terrain.clear();
  const defects = plant.randomizeDefects(undefined, { clean });
  ui.buildPanelList(plant.panels);
  ui.updateProgress(plant.panels);
  ui.setTargetPanel(null);
  ui.updateZones(plant, null);
  const structDefects = plant.panels.filter((p) => p.struct.defect).length;
  network?.sendPlantModel();
  ui.log(clean
    ? 'Reset · healthy plant, no hidden faults (guided demo)'
    : `Reset · ${defects.length} module faults and ${structDefects} structure faults generated (hidden until inspected)`);
  return { ok: true };
}

function report(result, okMessage) {
  if (result && result.ok === false) ui.toast(result.error);
  else if (okMessage) ui.toast(okMessage);
  return result;
}

function setFollow(on) {
  view.follow = on;
  view.transition = null;
  ui.setToggle('follow', on);
}

function flyTo(position, target) {
  setFollow(false);
  view.transition = {
    t: 0,
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: position.clone(),
    toTarget: target.clone(),
  };
}

function overview() {
  closeZone();
  flyTo(DEFAULT_VIEW.position, DEFAULT_VIEW.target);
}

// Clic sur une zone : le drone part la survoler (vue d'ensemble dans le retour caméra),
// sans analyse ; la fiche de zone suit son activité. La caméra principale ne bouge pas.
function selectZone(id) {
  const zone = plant.getZone(id);
  if (!zone) return { ok: false, code: 404, error: `Unknown zone: ${id}` };
  const result = report(controller.surveyZone(zone.id), `Drone sent to survey ${zone.name}`);
  if (result.ok === false) return result;
  view.zone = zone;
  plant.setSelectedZone(zone);
  ui.setListZone(zone.id);
  ui.showZoneCard(zone);
  ui.updateZoneCard(plant, controller);
  return result;
}

function closeZone() {
  view.zone = null;
  plant.setSelectedZone(null);
  ui.hideZoneCard();
}

// Type d'inspection affiché (statuts des panneaux, progression) et lancé par les commandes
function setInspectionType(type) {
  if (type !== 'modules' && type !== 'structure') return;
  ui.setInspectionType(type);
  plant.setInspectionView(type);
  for (const p of plant.panels) ui.updatePanel(p);
  ui.updateProgress(plant.panels);
  ui.updateZones(plant, controller.state === 'IDLE' ? null : plant.zoneAt(controller.pos.x, controller.pos.z)?.id);
  ui.updateZoneCard(plant, controller);
}

function setFullscreen(on) {
  feed.setFullscreen(on);
  viewport.classList.toggle('feed-fullscreen', on);
  clipLabelsAroundFeed();
  controls.enabled = !on;
  labelRenderer.domElement.style.display = on ? 'none' : '';
  ui.setToggle('expand', on);
}

const ui = new UI({
  startMission: () => report(controller.startMission(null, ui.view)),
  togglePause: () => report(controller.togglePause()),
  returnToBase: () => report(controller.returnToBase()),
  reset: () => doReset(),
  inspectPanel: (id) => report(controller.inspectPanel(id, ui.view), `Drone sent to ${id}`),
  setInspectionType,
  hoverPanel: (id) => plant.setHover(plant.getPanel(id)),
  toggleFollow: () => setFollow(!view.follow),
  overview,
  toggleLabels: () => {
    view.labels = !view.labels;
    plant.setLabelsVisible(view.labels);
    ui.setToggle('labels', view.labels);
  },
  toggleThermal: () => setThermal(!feed.thermal),
  toggleFullscreen: () => setFullscreen(!feed.fullscreen),
  escape: () => (feed.fullscreen ? setFullscreen(false) : closeZone()),
  selectZone: (id) => selectZone(id),
  closeZone: () => closeZone(),
  inspectZone: (id) => report(controller.startMission(id, ui.view), `Zone ${id} inspection started`),
  setSpeed: (v) => {
    view.speed = v;
    ui.setSpeed(v);
  },
});

plant.onZoneClick = (id) => selectZone(id);
ui.buildZoneTabs(plant.zones);
ui.buildPanelList(plant.panels);
ui.updateProgress(plant.panels);
ui.updateZones(plant, null);
ui.setMissionState(controller.snapshotState());
ui.log(`System ready · drone on its pad, ${plant.zones.length} zones, ${plant.panels.length} panels to inspect`);

controller.on('log', ({ msg, level }) => {
  ui.log(msg, level);
  network?.sendLog(msg, level);
});
controller.on('state', (s) => ui.setMissionState(s));
controller.on('panel', (p) => {
  ui.updatePanel(p);
  ui.updateProgress(plant.panels);
  ui.updateZones(plant, plant.zoneAt(controller.pos.x, controller.pos.z)?.id);
});
controller.on('target', (p) => ui.setTargetPanel(p ? p.id : null));

// ---------------------------------------------------------------- serveur local

function setThermal(on) {
  feed.setThermal(on);
  ui.setToggle('thermal', feed.thermal);
}

network = new Network({
  // Panneaux et défauts réels (non révélés à l'opérateur) : base de la simulation électrique du serveur
  // epoch : change à chaque réinitialisation (nouveau tirage), pas lors d'un défaut ajouté à la main
  getPlantModel: () => ({
    epoch: plantEpoch,
    panels: plant.panels.map((p) => ({
      id: p.id, zone: p.zone.id, row: p.row + 1, col: p.col + 1,
      x: Math.round(p.center.x * 100) / 100, z: Math.round(p.center.z * 100) / 100,
      fault: p.defect ? p.defect.type : null,
    })),
  }),
  onSticks: (s) => controller.setSticks(s),
  onStream: (on, opts) => {
    streamer.setActive(on, opts);
    ui.log(on ? 'Operator console connected · streaming video' : 'Video stream to the console stopped', 'net');
  },
  getStatus: () => ({
    ...controller.getStatus(),
    base: { x: controller.home.x, z: controller.home.z },
    view: { thermal: feed.thermal, cameraFullscreen: feed.fullscreen, follow: view.follow, selectedZone: view.zone ? view.zone.id : null, simSpeed: view.speed, fps: Math.round(fps) },
  }),
  onConnection: (state) => {
    if (state === 'on') ui.log('Connected to the local server (REST API active)', 'net');
  },
  // Prototype : un téléphone sert de caméra drone au-dessus d'un panneau imprimé
  onEvent: (event, data) => {
    if (event !== 'mobileReport') return;
    const list = (data.defects || []).map((d) => `${(d.label || DEFECT_TYPES[d.type] || d.type).toLowerCase()}${d.where ? ` at ${d.where}` : ''} (ΔT +${d.deltaT} °C)`).join(', ');
    if (data.kind === 'defect') ui.log(`Mobile camera · ${data.panel}: ${list}`, 'defect');
    else if (data.kind === 'ok') ui.log(`Mobile camera · ${data.panel} scanned: healthy`, 'ok');
    else ui.log(`Mobile camera · ${data.panel} scanned: ${list}`, 'defect');
  },
  handleCommand: (action, params) => {
    let result;
    let desc = action;
    switch (action) {
      case 'goto':
        if (params.panel) {
          const type = params.type || 'modules';
          desc = `inspect ${params.panel}${type === 'structure' ? ' (structure)' : ''}`;
          result = controller.inspectPanel(params.panel, type);
          if (result.ok !== false) setInspectionType(type);
        } else {
          desc = `fly over (${Number(params.x).toFixed(1)}, ${Number(params.z).toFixed(1)})`;
          result = controller.gotoPoint(Number(params.x), Number(params.z));
        }
        break;
      case 'missionStart':
        desc = params.zone ? `inspect zone ${params.zone}` : 'start the mission';
        result = controller.startMission(params.zone || null, params.type || 'modules');
        if (params.type === 'structure') desc += ' (structures)';
        if (result.ok !== false) setInspectionType(params.type || 'modules');
        break;
      case 'zoneView': desc = `survey zone ${params.zone}`; result = selectZone(params.zone); break;
      case 'pause': desc = 'pause'; result = controller.pause(); break;
      case 'resume': desc = 'resume'; result = controller.resume(); break;
      case 'returnToBase': desc = 'return to base'; result = controller.returnToBase(); break;
      case 'reset': desc = params.clean ? 'reset (healthy plant)' : 'reset'; result = doReset({ clean: Boolean(params.clean) }); break;
      // Démonstration : incidents posés à la demande par la console
      case 'injectDefect': {
        const panel = plant.getPanel(String(params.panel || ''));
        desc = `simulated ${params.kind === 'structure' ? 'structure' : 'module'} fault on ${params.panel}`;
        if (!panel) result = { ok: false, code: 404, error: `Unknown panel: ${params.panel}` };
        else {
          const done = params.kind === 'structure' ? plant.injectStructDefect(panel, params.type) : plant.injectModuleDefect(panel, params.type);
          if (!done) result = { ok: false, code: 400, error: `Unknown fault type: ${params.type}` };
          else {
            ui.updatePanel(panel);
            ui.updateProgress(plant.panels);
            if (params.kind !== 'structure') network.sendPlantModel();
            result = { ok: true, result: { panel: panel.id, label: params.kind === 'structure' ? panel.struct.defect.label : panel.defect.label } };
          }
        }
        break;
      }
      case 'repairStructure': {
        const panel = plant.getPanel(String(params.panel || ''));
        desc = `structure of ${params.panel} repaired`;
        if (!panel) result = { ok: false, code: 404, error: `Unknown panel: ${params.panel}` };
        else {
          result = { ok: true, result: { repaired: plant.repairStruct(panel) } };
          ui.updatePanel(panel);
        }
        break;
      }
      case 'terrainAdd':
        desc = `simulated ground issue (${TERRAIN_TYPES[params.type] || params.type})`;
        result = terrain.add(String(params.id), params.type, Number(params.x), Number(params.z))
          ? { ok: true }
          : { ok: false, code: 400, error: `Unknown ground issue type: ${params.type}` };
        break;
      case 'terrainRemove': desc = 'ground repaired'; terrain.remove(String(params.id)); result = { ok: true }; break;
      case 'surveyPoint':
        desc = `ground survey (${Number(params.x).toFixed(1)}, ${Number(params.z).toFixed(1)})`;
        result = controller.surveyPoint(Number(params.x), Number(params.z));
        break;
      case 'repair': {
        const panel = plant.getPanel(String(params.panel || ''));
        desc = `${params.panel} repaired`;
        if (!panel) result = { ok: false, code: 404, error: `Unknown panel: ${params.panel}` };
        else {
          const fixed = plant.repairPanel(panel);
          ui.updatePanel(panel);
          ui.updateProgress(plant.panels);
          network.sendPlantModel();
          result = { ok: true, result: { repaired: fixed } };
        }
        break;
      }
      case 'takeoff': desc = 'take-off'; result = controller.takeoff({ pilot: Boolean(params.pilot) }); break;
      case 'land': desc = 'land here'; result = controller.landHere(); break;
      case 'pilot': desc = params.on ? 'take control' : 'release manual control'; result = controller.setPilot(Boolean(params.on)); break;
      case 'gimbal': desc = `gimbal ${Math.round(Number(params.pitch))}°`; result = controller.setGimbal(params.pitch); break;
      case 'thermal': desc = params.on ? 'thermal camera' : 'RGB camera'; setThermal(Boolean(params.on)); result = { ok: true }; break;
      case 'simSpeed': {
        const v = Number(params.speed);
        desc = `simulation speed ×${v}`;
        if (![1, 2, 4, 8].includes(v)) result = { ok: false, code: 400, error: 'Expected speed: 1, 2, 4 or 8' };
        else { view.speed = v; ui.setSpeed(v); result = { ok: true }; }
        break;
      }
      default: result = { ok: false, code: 400, error: `Unknown command: ${action}` };
    }
    if (action === 'gimbal' && result.ok !== false) return result;
    ui.log(`Command received: ${desc}${result.ok === false ? ` · refused: ${result.error}` : ''}`, result.ok === false ? 'warn' : 'net');
    return result;
  },
});

const streamer = new FeedStreamer({ renderer, feed, network });

// ---------------------------------------------------------------- souris : survol, clic

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();
let downAt = null;

function pick(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(plant.pickables, false)[0];
  if (hit) return { panel: plant.getPanel(hit.object.userData.panelId) };
  // Le terrain est plat dans la zone utile : intersection analytique (bien plus rapide)
  if (raycaster.ray.intersectPlane(groundPlane, hitPoint) && Math.abs(hitPoint.x) < 140 && Math.abs(hitPoint.z) < 140) {
    return { point: hitPoint.clone(), zone: plant.zoneAt(hitPoint.x, hitPoint.z) };
  }
  return null;
}

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (ev) => {
  downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  view.transition = null;
});
canvas.addEventListener('pointerup', (ev) => {
  if (!downAt || ev.button !== 0 || feed.fullscreen) return;
  const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
  const quick = performance.now() - downAt.t < 450;
  downAt = null;
  if (moved > 5 || !quick) return;
  const res = pick(ev);
  if (!res) return;
  if (res.panel) report(controller.inspectPanel(res.panel.id, ui.view), `Drone sent to ${res.panel.id}`);
  else if (res.zone && !ev.shiftKey) selectZone(res.zone.id);
  else report(controller.gotoPoint(res.point.x, res.point.z), `Flying over (${res.point.x.toFixed(1)}, ${res.point.z.toFixed(1)})`);
});
canvas.addEventListener('pointermove', (ev) => {
  if (ev.buttons || feed.fullscreen) return;
  const res = pick(ev);
  const panel = res?.panel || null;
  const zone = !panel && !ev.shiftKey ? res?.zone || null : null;
  plant.setHover(panel);
  plant.setHoverZone(zone);
  ui.setHoverPanel(panel ? panel.id : null);
  const rect = viewport.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  if (panel) ui.showTooltip(x, y, panel);
  else if (zone) {
    const st = plant.zoneStats(zone);
    ui.showTooltipHtml(x, y, `<b>${zone.name}</b><span class="s">${st.done}/${st.total} scanned</span>`);
  } else ui.showTooltip(x, y, null);
  viewport.classList.toggle('picking', Boolean(res));
});
canvas.addEventListener('pointerleave', () => {
  plant.setHover(null);
  plant.setHoverZone(null);
  ui.setHoverPanel(null);
  ui.showTooltip(0, 0, null);
});

// ---------------------------------------------------------------- redimensionnement

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  feed.layout();
  clipLabelsAroundFeed();
}

// L'image du drone est dessinée dans le canvas WebGL, sous le calque des étiquettes :
// on découpe ce calque (règle evenodd) pour qu'aucune étiquette ne passe sur le retour caméra.
function clipLabelsAroundFeed() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  const r = feed.rect;
  labelRenderer.domElement.style.clipPath =
    `path(evenodd, 'M0 0 H${w} V${h} H0 Z M${r.x} ${r.y} h${r.w} v${r.h} h${-r.w} Z')`;
}
new ResizeObserver(resize).observe(viewport);
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- boucle principale

// Non relié à la visibilité de la page : la simulation continue onglet masqué (voir plus bas)
const timer = new THREE.Timer();
const fpsEl = document.createElement('span');
fpsEl.className = 'fps mono';
document.getElementById('toolbar').appendChild(fpsEl);
let fps = 60;
let uiClock = 0;
let frameCount = 0;

// Qualité adaptative : si la fluidité chute, la résolution de rendu baisse par paliers
// (puis la carte d'ombres n'est plus recalculée qu'une image sur deux) ; elle remonte
// quand la marge revient. L'écran Retina reste net tant que la machine suit.
const quality = (() => {
  const top = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxPixelRatio);
  const levels = [...new Set([top, 1.5, 1.25, 1, 0.8].filter((v) => v <= top))].sort((a, b) => b - a);
  return { levels, level: 0, acc: 0, low: 0, high: 0 };
})();

function governQuality(dt) {
  if (document.hidden) return;
  quality.acc += dt;
  if (quality.acc < 1) return;
  quality.acc = 0;
  if (fps < 50) {
    quality.low++;
    quality.high = 0;
  } else if (fps > 57) {
    quality.high++;
    quality.low = 0;
  } else {
    quality.low = 0;
    quality.high = 0;
  }
  const max = quality.levels.length; // dernier palier : ombres une image sur deux
  let next = quality.level;
  if (quality.low >= 2 && quality.level < max) next++;
  else if (quality.high >= 8 && quality.level > 0) next--;
  if (next === quality.level) return;
  quality.level = next;
  quality.low = 0;
  quality.high = 0;
  renderer.setPixelRatio(quality.levels[Math.min(next, quality.levels.length - 1)]);
  resize();
}
const followTarget = new THREE.Vector3();
const prevTarget = new THREE.Vector3();
const offset = new THREE.Vector3();

function frame(now) {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  const t = timer.getElapsed();
  const simDt = dt * view.speed;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;

  controller.update(simDt);
  drone.update(simDt, controller.kinematics());
  plant.update(t);
  world.sky.material.uniforms.time.value = t;
  pad.userData.beaconMat.color.setHSL(0.55, 0.9, 0.45 + 0.25 * Math.sin(t * 3));

  // Marqueur de destination (survol d'un point) et ligne de hauteur
  const pointTarget = !controller.currentPanel && (controller.state === 'TRANSIT' || controller.state === 'HOVER');
  marker.visible = pointTarget;
  if (pointTarget) {
    marker.position.set(controller.target.x, 0.03, controller.target.z);
    marker.userData.ring.scale.setScalar(1 + 0.12 * Math.sin(t * 5));
  }
  dropLine.visible = controller.airborne > 0.5;
  if (dropLine.visible) {
    const p = drone.root.position;
    const pos = dropLine.geometry.attributes.position;
    pos.setXYZ(0, p.x, p.y + 0.05, p.z);
    pos.setXYZ(1, p.x, 0.02, p.z);
    pos.needsUpdate = true;
    dropLine.computeLineDistances();
  }

  // Caméra : transition « vue d'ensemble » ou suivi du drone
  if (view.transition) {
    const tr = view.transition;
    tr.t = Math.min(1, tr.t + dt / 1.2);
    const e = tr.t < 0.5 ? 4 * tr.t ** 3 : 1 - (-2 * tr.t + 2) ** 3 / 2;
    camera.position.lerpVectors(tr.fromPos, tr.toPos, e);
    controls.target.lerpVectors(tr.fromTarget, tr.toTarget, e);
    if (tr.t >= 1) view.transition = null;
  } else if (view.follow) {
    followTarget.copy(drone.root.position).y += 0.3;
    prevTarget.copy(controls.target);
    controls.target.lerp(followTarget, damp(5, dt));
    camera.position.add(offset.subVectors(controls.target, prevTarget));
    offset.subVectors(camera.position, controls.target);
    const d = offset.length();
    if (d > 15) camera.position.copy(controls.target).addScaledVector(offset, (d + (14 - d) * damp(1.5, dt)) / d);
  }
  controls.update();

  // Rendu : la carte d'ombres est calculée une fois, pour la vue principale
  frameCount++;
  governQuality(dt);
  renderer.shadowMap.needsUpdate = quality.level < quality.levels.length || (frameCount & 1) === 0;
  if (!feed.fullscreen && !document.hidden) {
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  feed.render(t);
  streamer.capture(t);
  network.tick();

  uiClock += dt;
  if (uiClock > 0.1) {
    uiClock = 0;
    ui.updateTelemetry(controller);
    ui.updateZones(plant, controller.state === 'IDLE' ? null : plant.zoneAt(controller.pos.x, controller.pos.z)?.id);
    ui.updateZoneCard(plant, controller);
    fpsEl.textContent = `${Math.round(fps)} fps`;
    fpsEl.title = `Render resolution ×${renderer.getPixelRatio()}${quality.level >= quality.levels.length ? ', shadows every other frame' : ''} (adaptive quality)`;
  }
}
renderer.setAnimationLoop(frame);

// Onglet masqué : le navigateur suspend requestAnimationFrame. La centrale et le drone
// doivent pourtant continuer à vivre (la console opérateur les pilote et les regarde) :
// un Web Worker, dont les minuteries ne sont pas bridées, cadence alors la simulation à 20 Hz.
{
  const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
  const ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (document.hidden) frame(performance.now());
  };
  const sync = () => ticker.postMessage(document.hidden ? 50 : 0);
  document.addEventListener('visibilitychange', sync);
  sync();
}

if (import.meta.env.DEV) window.__sim = { world, plant, drone, controller, feed, ui, network, streamer, terrain };
