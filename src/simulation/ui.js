import { INSPECTION_TYPES, PANEL_STATUS } from '../shared/config.js';
import { formatClock } from '../shared/utils.js';

// Interface de supervision : panneau latéral, barre d'outils, infobulle, notifications.
// Ne contient aucune logique de simulation : tout passe par les callbacks `actions`.

const $ = (id) => document.getElementById(id);
const MAX_LOG = 250;
const DEFECT_SHORT = { hotspot: 'Hot spot', crack: 'Crack', soiling: 'Soiling' };
const STATUS_SHORT = { pending: 'Pending', scanning: 'Scanning', ok: 'Healthy' };
const STRUCT_SHORT = { corrosion: 'Leg', deformation: 'Leg', fissure: 'Footing' }; // + code du pied (NO, NE, SO, SE)
const LOG_TAGS = { info: 'INFO', ok: 'OK', warn: 'ALERT', defect: 'DEFECT', net: 'API' };

export class UI {
  constructor(actions) {
    this.actions = actions;
    this.el = {
      state: $('mission-state'),
      mode: $('mission-mode'),
      time: $('mission-time'),
      start: $('btn-start'),
      pause: $('btn-pause'),
      ret: $('btn-return'),
      reset: $('btn-reset'),
      progressText: $('progress-text'),
      progressFill: $('progress-fill'),
      progressPct: $('progress-pct'),
      countOk: $('count-ok'),
      countDefect: $('count-defect'),
      countPending: $('count-pending'),
      alt: $('t-alt'),
      speed: $('t-speed'),
      heading: $('t-heading'),
      battery: $('t-battery'),
      list: $('panel-list'),
      log: $('event-log'),
      tooltip: $('tooltip'),
      toast: $('toast'),
      follow: $('btn-follow'),
      labels: $('btn-labels'),
      thermal: $('btn-thermal'),
      expand: $('btn-expand'),
      feed: $('feed'),
      toolbar: $('toolbar'),
      zoneTabs: $('zone-tabs'),
      zoneCard: $('zone-card'),
      zcTitle: $('zc-title'),
      zcFill: $('zc-fill'),
      zcText: $('zc-text'),
      zcMap: $('zc-map'),
      zcDrone: $('zc-drone'),
      zcInspect: $('zc-inspect'),
    };
    this.view = 'modules'; // type d'inspection affiché et lancé : 'modules' | 'structure'
    this.lastState = null;
    this.chips = new Map();
    this.tabs = new Map();
    this.listZone = null;
    this.cardZone = null;
    this.cardCells = new Map();
    this._bind();
  }

  _bind() {
    const a = this.actions;
    const e = this.el;
    e.start.addEventListener('click', () => a.startMission());
    e.pause.addEventListener('click', () => a.togglePause());
    e.ret.addEventListener('click', () => a.returnToBase());
    e.reset.addEventListener('click', () => a.reset());
    e.follow.addEventListener('click', () => a.toggleFollow());
    $('btn-overview').addEventListener('click', () => a.overview());
    e.labels.addEventListener('click', () => a.toggleLabels());
    e.thermal.addEventListener('click', () => a.toggleThermal());
    e.expand.addEventListener('click', () => a.toggleFullscreen());
    $('zc-close').addEventListener('click', () => a.closeZone());
    e.zcInspect.addEventListener('click', () => this.cardZone && a.inspectZone(this.cardZone.id));
    document.querySelectorAll('#insp-type button').forEach((b) => {
      b.addEventListener('click', () => a.setInspectionType(b.dataset.type));
    });
    $('btn-clear-log').addEventListener('click', () => {
      e.log.innerHTML = '';
    });
    document.querySelectorAll('.speed button').forEach((b) => {
      b.addEventListener('click', () => a.setSpeed(Number(b.dataset.speed)));
    });

    window.addEventListener('keydown', (ev) => {
      if (ev.target.closest('input, textarea') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === ' ') { ev.preventDefault(); a.togglePause(); }
      else if (k === 'f') a.toggleFollow();
      else if (k === 'v') a.overview();
      else if (k === 't') a.toggleThermal();
      else if (k === 'c') a.toggleFullscreen();
      else if (k === 'escape') a.escape();
      else if (k === '1' || k === '2' || k === '3') a.selectZone(['A', 'B', 'C'][Number(k) - 1]);
    });
  }

  // ---------------------------------------------------------------- panneaux

  rec(p) {
    return this.view === 'structure' ? p.struct : p;
  }

  setInspectionType(type) {
    this.view = type;
    document.querySelectorAll('#insp-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
    if (this.lastState) this.setMissionState(this.lastState);
  }

  // Matrice des panneaux de la zone choisie, disposée comme sur le terrain
  // (rangées R1…R4 du nord au sud, colonnes 1…5 d'ouest en est)
  buildPanelList(panels) {
    const list = this.el.list;
    list.innerHTML = '';
    this.chips.clear();
    const rows = Math.max(...panels.map((p) => p.row)) + 1;
    const cols = Math.max(...panels.map((p) => p.col)) + 1;
    list.style.gridTemplateColumns = `22px repeat(${cols}, minmax(0, 1fr))`;
    const head = (text, row, col) => {
      const h = document.createElement('span');
      h.className = 'pg-head';
      h.textContent = text;
      h.style.gridRow = String(row);
      h.style.gridColumn = String(col);
      list.appendChild(h);
    };
    for (let c = 0; c < cols; c++) head(String(c + 1), 1, c + 2);
    for (let r = 0; r < rows; r++) head(`R${r + 1}`, r + 2, 1);
    for (const p of panels) {
      const b = document.createElement('button');
      b.className = 'panel-chip';
      b.dataset.zone = p.zone.id;
      b.hidden = this.listZone !== null && p.zone.id !== this.listZone;
      b.style.gridRow = String(p.row + 2);
      b.style.gridColumn = String(p.col + 2);
      b.innerHTML = `<span class="id">${p.id}</span><span class="st"></span>`;
      b.addEventListener('click', () => this.actions.inspectPanel(p.id));
      b.addEventListener('mouseenter', () => this.actions.hoverPanel(p.id));
      b.addEventListener('mouseleave', () => this.actions.hoverPanel(null));
      this.el.list.appendChild(b);
      this.chips.set(p.id, b);
      this.updatePanel(p);
    }
  }

  // ---------------------------------------------------------------- zones

  buildZoneTabs(zones) {
    this.el.zoneTabs.innerHTML = '';
    this.tabs.clear();
    for (const z of zones) {
      const b = document.createElement('button');
      b.className = 'zone-tab';
      b.setAttribute('role', 'tab');
      b.title = `${z.name}: show the panels of this zone`;
      b.innerHTML = `<span class="zt-name">${z.name}<i class="zt-drone" title="Drone in this zone"></i></span><span class="zt-stats"></span>`;
      b.addEventListener('click', () => this.setListZone(z.id));
      this.el.zoneTabs.appendChild(b);
      this.tabs.set(z.id, b);
    }
    if (!this.listZone) this.setListZone(zones[0].id);
  }

  // Le panneau latéral liste les 20 panneaux de la zone choisie
  setListZone(id) {
    this.listZone = id;
    for (const [zid, tab] of this.tabs) tab.classList.toggle('active', zid === id);
    for (const chip of this.chips.values()) chip.hidden = chip.dataset.zone !== id;
  }

  updateZones(plant, droneZoneId) {
    for (const z of plant.zones) {
      const tab = this.tabs.get(z.id);
      if (!tab) continue;
      const st = plant.zoneStats(z);
      tab.querySelector('.zt-stats').innerHTML = `${st.done}/${st.total}${st.defect ? ` · <span class="d">${st.defect} def.</span>` : ''}`;
      tab.classList.toggle('drone-here', z.id === droneZoneId);
    }
  }

  showZoneCard(zone) {
    const e = this.el;
    this.cardZone = zone;
    e.zoneCard.hidden = false;
    e.zcTitle.textContent = zone.name;
    e.zcMap.innerHTML = '';
    this.cardCells.clear();
    for (const p of zone.panels) {
      const cell = document.createElement('button');
      cell.className = 'zc-cell';
      cell.textContent = p.id;
      cell.style.gridRow = String(p.row + 1);
      cell.style.gridColumn = String(p.col + 1);
      cell.addEventListener('click', () => this.actions.inspectPanel(p.id));
      cell.addEventListener('mouseenter', () => this.actions.hoverPanel(p.id));
      cell.addEventListener('mouseleave', () => this.actions.hoverPanel(null));
      e.zcMap.appendChild(cell);
      this.cardCells.set(p.id, cell);
    }
    this.droneDot = document.createElement('div');
    this.droneDot.className = 'zc-drone-dot';
    e.zcMap.appendChild(this.droneDot);
  }

  hideZoneCard() {
    this.cardZone = null;
    this.el.zoneCard.hidden = true;
  }

  // Rafraîchissement (~10 Hz) de la vue de zone : uniquement ce qui se passe
  // (position et activité du drone), aucune information sur les défauts.
  updateZoneCard(plant, controller) {
    const zone = this.cardZone;
    if (!zone) return;
    const e = this.el;
    const st = plant.zoneStats(zone);
    e.zcText.textContent = `${st.done} / ${st.total} scanned`;
    e.zcFill.style.width = `${(st.done / st.total) * 100}%`;

    const target = controller.currentPanel;
    for (const p of zone.panels) {
      const cell = this.cardCells.get(p.id);
      const { status } = this.rec(p);
      const state = status === 'scanning' ? 'scanning' : status === 'pending' ? 'pending' : 'done';
      cell.dataset.state = state;
      cell.classList.toggle('target', p === target);
      cell.title = `${p.id}: ${{ pending: 'not scanned', scanning: 'scanning', done: 'scanned' }[state]}`;
    }

    // Position du drone projetée sur la carte de la zone
    const cells = zone.panels.map((p) => ({ p, el: this.cardCells.get(p.id) }));
    const first = cells.find((c) => c.p.row === 0 && c.p.col === 0);
    const last = cells.find((c) => c.p.row === 3 && c.p.col === 4) || cells[cells.length - 1];
    const x0 = first.el.offsetLeft + first.el.offsetWidth / 2;
    const y0 = first.el.offsetTop + first.el.offsetHeight / 2;
    const x1 = last.el.offsetLeft + last.el.offsetWidth / 2;
    const y1 = last.el.offsetTop + last.el.offsetHeight / 2;
    const u = (controller.pos.x - first.p.center.x) / (last.p.center.x - first.p.center.x || 1);
    const v = (controller.pos.z - first.p.center.z) / (last.p.center.z - first.p.center.z || 1);
    const inside = u > -0.35 && u < 1.35 && v > -0.35 && v < 1.35 && controller.state !== 'IDLE';
    this.droneDot.style.display = inside ? 'block' : 'none';
    if (inside) {
      this.droneDot.style.left = `${x0 + u * (x1 - x0)}px`;
      this.droneDot.style.top = `${y0 + v * (y1 - y0)}px`;
    }

    // Activité du drone vis-à-vis de cette zone
    let activity;
    const surveying = controller.overviewZone === zone || controller.pendingOverview === zone;
    if (controller.state === 'IDLE') activity = 'Drone <b>landed</b> on its pad';
    else if (surveying && controller.state === 'OVERVIEW') activity = `Drone <b>surveying the zone</b> at ${Math.round(controller.altitude)} m, camera pointing down`;
    else if (surveying) activity = 'Drone <b>on its way to survey</b> the zone';
    else if (target && target.zone === zone) {
      const scanning = controller.inspectType === 'structure' ? 'inspecting the structure of' : 'scanning';
      const what = { TRANSIT: 'approaching', POSITIONING: 'positioning over', SCANNING: scanning }[controller.state] || 'targeting';
      activity = `Drone: <b>${what} ${target.id}</b>${controller.state === 'SCANNING' ? ` (${Math.round(controller.scanProgress * 100)}%)` : ''}`;
    } else if (inside) activity = 'Drone <b>above the zone</b>';
    else activity = `Drone <b>outside the zone</b>${target ? ` (target ${target.id})` : ''}`;
    if (controller.paused) activity += ' · <b>paused</b>';
    if (e.zcDrone.innerHTML !== activity) e.zcDrone.innerHTML = activity;

    const missionHere = controller.mode === 'mission' && controller.missionZone === zone && controller.state !== 'IDLE'
      && controller.inspectType === this.view;
    const what = this.view === 'structure' ? 'structures' : 'modules';
    e.zcInspect.disabled = missionHere;
    e.zcInspect.querySelector('span').textContent = missionHere ? 'Zone inspection running' : `Inspect ${what} · ${zone.name}`;
  }

  updatePanel(p) {
    const chip = this.chips.get(p.id);
    if (!chip) return;
    const r = this.rec(p);
    chip.dataset.status = r.status;
    const st = chip.querySelector('.st');
    if (r.status !== 'defect') st.textContent = STATUS_SHORT[r.status];
    else st.textContent = this.view === 'structure' ? `${STRUCT_SHORT[r.defect.type]} ${r.defect.leg.code}` : DEFECT_SHORT[r.defect.type];
    chip.title = `${p.id}: ${p.zone.name}, row ${p.row + 1}, column ${p.col + 1}\n${this.statusText(p)}`;
  }

  statusText(p) {
    const r = this.rec(p);
    const what = this.view === 'structure' ? 'Structure' : 'Modules';
    if (r.status === 'defect') return `${what}: defect, ${r.defect.label}`;
    return `${what}: ${PANEL_STATUS[r.status].label}`;
  }

  setTargetPanel(id) {
    for (const [pid, chip] of this.chips) chip.classList.toggle('target', pid === id);
  }

  setHoverPanel(id) {
    for (const [pid, chip] of this.chips) chip.classList.toggle('hover', pid === id);
  }

  updateProgress(panels) {
    const ok = panels.filter((p) => this.rec(p).status === 'ok').length;
    const defect = panels.filter((p) => this.rec(p).status === 'defect').length;
    const done = ok + defect;
    const total = panels.length;
    this.el.progressText.textContent = `${done} / ${total}`;
    this.el.progressPct.textContent = `${Math.round((done / total) * 100)}%`;
    this.el.progressFill.style.width = `${(done / total) * 100}%`;
    this.el.countOk.textContent = ok;
    this.el.countDefect.textContent = defect;
    this.el.countPending.textContent = total - done;
  }

  // ---------------------------------------------------------------- mission

  setMissionState(s) {
    const { state, label, paused, mode, type } = s;
    this.lastState = s;
    const e = this.el;
    e.state.textContent = paused ? `Paused · ${label}` : label;
    e.state.title = e.state.textContent;
    e.state.dataset.state = state;
    e.state.classList.toggle('paused', paused);
    e.mode.textContent = mode === 'mission' ? `Auto · ${INSPECTION_TYPES[type]}` : mode === 'manual' ? `Manual · ${INSPECTION_TYPES[type]}` : mode === 'pilot' ? 'Remote piloting' : '—';
    const flying = state !== 'IDLE';
    e.pause.disabled = !flying;
    e.pause.classList.toggle('active', paused);
    e.pause.querySelector('span').textContent = paused ? 'Reprendre' : 'Pause';
    e.ret.disabled = !flying || ((state === 'RETURN' || state === 'LANDING') && !paused);
    // Une mission d'un autre type que celui affiché peut être remplacée
    const running = mode === 'mission' && flying && type === this.view;
    e.start.disabled = running;
    e.start.textContent = running ? 'Mission running' : this.view === 'structure' ? 'Inspect structures' : 'Inspect modules';
  }

  updateTelemetry(c) {
    const e = this.el;
    e.alt.textContent = `${c.altitude.toFixed(1)} m`;
    e.speed.textContent = `${c.speed.toFixed(1)} m/s`;
    e.heading.textContent = `${String(Math.round(c.heading) % 360).padStart(3, '0')}°`;
    e.battery.textContent = `${Math.round(c.battery)}%`;
    const t = c.missionTime;
    e.time.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------- journal

  log(msg, level = 'info') {
    const li = document.createElement('li');
    li.className = `${level} new`;
    const time = document.createElement('time');
    time.textContent = formatClock();
    const tag = document.createElement('em');
    tag.textContent = LOG_TAGS[level] || 'INFO';
    const span = document.createElement('span');
    span.textContent = msg;
    li.append(time, tag, span);
    this.el.log.prepend(li);
    setTimeout(() => li.classList.remove('new'), 1300);
    while (this.el.log.children.length > MAX_LOG) this.el.log.lastChild.remove();
  }

  // ---------------------------------------------------------------- divers

  setToggle(name, on) {
    const el = { follow: this.el.follow, labels: this.el.labels, thermal: this.el.thermal, expand: this.el.expand }[name];
    el?.classList.toggle('active', on);
    if (name === 'thermal') el.querySelector('span').textContent = on ? 'Vue RGB' : 'Thermique';
    if (name === 'expand') {
      this.el.toolbar.style.display = on ? 'none' : '';
      el.title = on ? 'Shrink the camera feed' : 'Enlarge the camera feed';
    }
  }

  setSpeed(v) {
    document.querySelectorAll('.speed button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === v));
  }

  showTooltip(x, y, panel) {
    const t = this.el.tooltip;
    if (!panel) {
      t.style.display = 'none';
      return;
    }
    const r = this.rec(panel);
    const color = PANEL_STATUS[r.status].color;
    const label = r.status === 'defect' ? `defect: ${r.defect.label}` : PANEL_STATUS[r.status].label;
    t.innerHTML = `<b>${panel.id}</b><span class="s"><i style="background:${color}"></i>${label}</span>`;
    t.style.display = 'block';
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }

  showTooltipHtml(x, y, html) {
    const t = this.el.tooltip;
    t.innerHTML = html;
    t.style.display = 'block';
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }

  toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
}
