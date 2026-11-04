// Carte schématique de la centrale en SVG, nord en haut.
// Chaque zone est une grille dense de 5 × 4 modules (format paysage 2:1) : le schéma garde
// l'ordre des rangées et des colonnes du terrain, pas ses distances (4,5 m entre rangées
// pour l'ombrage). Les zones sont côte à côte, sur deux colonnes si le cadre est plus haut,
// ou empilées sur un écran étroit : la disposition qui donne les plus grands modules l'emporte.
// Chaque module est une cellule PV : sa luminosité suit le courant mesuré rapporté au courant
// attendu, il s'assombrit donc quand il décroche. Une marque dans une case fixe (coin
// nord-ouest) donne l'état d'inspection : pleine = conforme, creuse = non inspecté,
// barrée = défaut. Le drone, sa trace et sa route sont en violet. Sa position réelle est
// projetée sur le schéma par interpolation entre les centres des colonnes et des rangées.

const NS = 'http://www.w3.org/2000/svg';
const MW = 2.0;                 // module : largeur (unités du schéma)
const MD = 1.0;                 // module : hauteur
const GX = 0.2;                 // espace entre deux modules d'une rangée
const GY = 0.36;                // espace entre deux rangées
const ZONE_GAP = 1.7;           // espace entre zones côte à côte
const STACK_GAP = 2.4;          // espace entre zones empilées
const STACK_BELOW = 600;        // largeur de cadre (px) sous laquelle les zones s'empilent
const DEAD = [7, 14, 34];       // module éteint
const LIVE = [47, 98, 224];     // module à son courant attendu
let uid = 0;

const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

// Rampe resserrée sur la zone utile : −5 % se voit, −25 % est presque noir
export function cellColor(ratio) {
  const k = Math.max(0, Math.min(1, (ratio - 0.75) / 0.26));
  const e = k ** 1.25;
  const c = DEAD.map((d, i) => Math.round(d + (LIVE[i] - d) * e));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Interpolation linéaire par morceaux (abscisses croissantes), prolongée aux extrémités
function piecewise(xs, ys) {
  const f = (v) => {
    const n = xs.length;
    if (n === 1) return ys[0] + (v - xs[0]);
    let i = 1;
    while (i < n - 1 && v > xs[i]) i++;
    const t = (v - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  };
  f.inverse = piecewise.bind(null, ys, xs);
  return f;
}

const uniqSorted = (a) => [...new Set(a.map((v) => Math.round(v * 100) / 100))].sort((x, y) => x - y);

export class PlantMap {
  constructor(host, { onPanel, onGround, onHover, compact = false, trail = true } = {}) {
    this.host = host;
    this.onPanel = onPanel;
    this.onGround = onGround;
    this.onHover = onHover;
    this.compact = compact;
    this.showTrail = trail;
    this.panels = new Map();
    this.trail = [];
    this.trailAt = 0;
    this.id = `pm${uid++}`;
    this.mode = 'row';
    this.last = {};
    this.svg = el('svg', { class: 'plant-svg', role: 'img', 'aria-label': 'Plant map and drone position' }, host);
    this.built = false;
    new ResizeObserver(() => {
      if (this.layout && this._mode() !== this.mode) this.build(this.layout, this.base);
    }).observe(host);
  }

  _mode() {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (this.compact || W <= 0) return 'row';
    if (W < STACK_BELOW) return 'stack';
    // Échelle obtenue (px par unité) : trois zones de front, ou deux colonnes
    const row = Math.min(W / 38, H / 10.5);
    const grid = Math.min(W / 25.6, H / 16.5);
    return grid > row * 1.08 ? 'grid' : 'row';
  }

  // Projection terrain (m) -> schéma, et son inverse (zones côte à côte seulement)
  _buildProjection(layout, base) {
    const ids = [...new Set(layout.map((p) => p.zone))].sort();
    const zw = 5 * MW + 4 * GX;
    const zones = ids.map((id) => {
      const ps = layout.filter((p) => p.zone === id);
      return { id, ps, cols: uniqSorted(ps.map((p) => p.x)), rows: uniqSorted(ps.map((p) => p.z)), cx: ps.reduce((s, p) => s + p.x, 0) / ps.length };
    });
    const pitchX = MW + GX;
    const pitchY = MD + GY;
    if (this.mode === 'row') {
      // Une seule correspondance continue sur toute la centrale
      const xs = [];
      const sx = [];
      zones.forEach((z, i) => z.cols.forEach((x, c) => {
        xs.push(x);
        sx.push(i * (zw + ZONE_GAP) + c * pitchX + MW / 2);
      }));
      const rows = zones[0].rows;
      const zs = [...rows];
      const sz = rows.map((r, k) => k * pitchY + MD / 2);
      const lastRow = sz[sz.length - 1];
      if (base.z > rows[rows.length - 1]) {
        zs.push(base.z);
        sz.push(lastRow + MD / 2 + 2.3);
      }
      const fx = piecewise(xs, sx);
      const fz = piecewise(zs, sz);
      this.project = (x, z) => [fx(x), fz(z)];
      this.unproject = (u, v) => [fx.inverse(u), fz.inverse(v)];
      this.zoneBoxes = zones.map((z, i) => ({ id: z.id, x: i * (zw + ZONE_GAP), y: 0, w: zw, h: rows.length * pitchY - GY }));
    } else {
      // Zones en colonnes (1 empilée, 2 en grille) : chaque zone a sa propre correspondance,
      // choisie selon l'abscisse ; la base se place sous sa zone
      const ncol = this.mode === 'stack' ? 1 : 2;
      const baseZone = zones.reduce((b, z) => (Math.abs(z.cx - base.x) < Math.abs(b.cx - base.x) ? z : b), zones[0]);
      const h = zones[0].rows.length * pitchY - GY;
      const baseIdx = zones.indexOf(baseZone);
      const hasBelow = (i) => i + ncol < zones.length;
      const rowTop = [];
      let y = 0;
      for (let r = 0; r * ncol < zones.length; r++) {
        rowTop.push(y);
        const extra = Math.floor(baseIdx / ncol) === r && hasBelow(baseIdx) ? 3.2 : 0;
        y += h + STACK_GAP + extra;
      }
      const maps = zones.map((z, i) => {
        const left = (i % ncol) * (zw + ZONE_GAP + 0.5);
        const top = rowTop[Math.floor(i / ncol)];
        const fx = piecewise(z.cols, z.cols.map((_, c) => left + c * pitchX + MW / 2));
        const zs = [...z.rows];
        const sz = z.rows.map((_, k) => top + k * pitchY + MD / 2);
        if (z === baseZone && base.z > z.rows[z.rows.length - 1]) {
          zs.push(base.z);
          sz.push(top + h + 2.3);
        }
        const fz = piecewise(zs, sz);
        return { z, fx, fz, box: { id: z.id, x: left, y: top, w: zw, h } };
      });
      const pick = (x) => maps.reduce((b, m) => (Math.abs(m.z.cx - x) < Math.abs(b.z.cx - x) ? m : b), maps[0]);
      this.project = (x, z) => {
        const m = pick(x);
        return [m.fx(x), m.fz(z)];
      };
      this.unproject = null;
      this.zoneBoxes = maps.map((m) => m.box);
    }
  }

  build(layout, base = { x: 0, z: 17 }) {
    this.svg.replaceChildren();
    this.panels.clear();
    this.layout = layout;
    this.base = base;
    this.mode = this._mode();
    this.trail = [];
    if (!layout.length) return;
    this._buildProjection(layout, base);
    this.svg.dataset.mode = this.mode;

    const [bx, by] = this.project(base.x, base.z);
    const boxes = this.zoneBoxes;
    const minX = Math.min(...boxes.map((b) => b.x)) - (this.compact ? 0.8 : 1.1);
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + (this.compact ? 0.8 : 1.1);
    const minY = Math.min(...boxes.map((b) => b.y)) - (this.compact ? 0.8 : 1.9);
    const maxY = Math.max(by + (this.compact ? 1.1 : 2.1), ...boxes.map((b) => b.y + b.h + 0.8));
    this.svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.style.setProperty('--ar', `${(maxX - minX) / (maxY - minY)}`);

    const defs = el('defs', {}, this.svg);
    // Filets busbar : deux rubans verticaux et une trame de cellules, en argent
    const pat = el('pattern', { id: `${this.id}-cells`, width: MW, height: MD, patternUnits: 'userSpaceOnUse' }, defs);
    for (let i = 1; i < 10; i++) el('line', { x1: (i * MW) / 10, y1: 0, x2: (i * MW) / 10, y2: MD, class: 'pm-cell-line' }, pat);
    for (let j = 1; j < 6; j++) el('line', { x1: 0, y1: (j * MD) / 6, x2: MW, y2: (j * MD) / 6, class: 'pm-cell-line' }, pat);
    el('line', { x1: MW * 0.333, y1: 0, x2: MW * 0.333, y2: MD, class: 'pm-bus' }, pat);
    el('line', { x1: MW * 0.667, y1: 0, x2: MW * 0.667, y2: MD, class: 'pm-bus' }, pat);

    const ground = el('rect', { x: minX, y: minY, width: maxX - minX, height: maxY - minY, class: 'pm-ground' }, this.svg);
    if (this.onGround && this.unproject) {
      this.svg.classList.add('pm-goto');
      ground.addEventListener('click', (ev) => {
        const [u, v] = this._toSvg(ev);
        const [x, z] = this.unproject(u, v);
        this.onGround(x, z);
      });
    }

    // Zones : cadre et nom
    this.zoneLabels = new Map();
    for (const b of boxes) {
      el('rect', { x: b.x - 0.45, y: b.y - 0.45, width: b.w + 0.9, height: b.h + 0.9, class: 'pm-zone' }, this.svg);
      if (!this.compact) {
        const t = el('text', { x: b.x - 0.45, y: b.y - 0.85, class: 'pm-zone-name' }, this.svg);
        t.textContent = `ZONE ${b.id}`;
        const s = el('text', { x: b.x + b.w + 0.45, y: b.y - 0.85, class: 'pm-zone-stat', 'text-anchor': 'end' }, this.svg);
        this.zoneLabels.set(b.id, s);
      }
    }

    // Plateforme de décollage
    const bg = el('g', { class: 'pm-base', transform: `translate(${bx} ${by})` }, this.svg);
    el('rect', { x: -0.75, y: -0.75, width: 1.5, height: 1.5 }, bg);
    el('path', { d: 'M-0.32 -0.38v0.76M0.32 -0.38v0.76M-0.32 0h0.64' }, bg);
    if (!this.compact) {
      const t = el('text', { x: 1.1, y: 0.2, class: 'pm-base-name' }, bg);
      t.textContent = 'BASE';
    }

    // Modules
    const layer = el('g', { class: 'pm-panels' }, this.svg);
    for (const p of layout) {
      const [cx, cy] = this.project(p.x, p.z);
      const g = el('g', { class: 'pm-panel', transform: `translate(${(cx - MW / 2).toFixed(3)} ${(cy - MD / 2).toFixed(3)})`, 'data-id': p.id, tabindex: this.onPanel ? '0' : '-1', role: this.onPanel ? 'button' : 'presentation', 'aria-label': `Module ${p.id}` }, layer);
      const body = el('rect', { width: MW, height: MD, class: 'pm-body' }, g);
      el('rect', { width: MW, height: MD, fill: `url(#${this.id}-cells)`, class: 'pm-grid' }, g);
      const out = el('rect', { x: -0.11, y: -0.11, width: MW + 0.22, height: MD + 0.22, class: 'pm-out' }, g);
      const mark = el('rect', { x: 0.09, y: 0.09, width: 0.2, height: 0.2, class: 'pm-mark', 'data-s': 'pending' }, g);
      const strike = el('path', { d: 'M0.05 0.33 L0.33 0.05', class: 'pm-strike' }, g);
      if (this.onPanel) {
        g.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onPanel(p.id);
        });
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this.onPanel(p.id);
          }
        });
      }
      const pn = { g, body, out, mark, strike, tag: null, data: p, cx, cy, sev: null, status: null, sel: false, target: false, hover: false };
      g.addEventListener('pointerenter', (ev) => {
        pn.hover = true;
        this._tag(pn);
        this.onHover?.(p.id, ev);
      });
      g.addEventListener('pointermove', (ev) => this.onHover?.(p.id, ev));
      g.addEventListener('pointerleave', () => {
        pn.hover = false;
        this._tag(pn);
        this.onHover?.(null);
      });
      this.panels.set(p.id, pn);
    }

    // Repères des problèmes signalés au sol (alertes de terrain)
    this.markerLayer = el('g', { class: 'pm-markers' }, this.svg);

    // Drone : route, trace, losange orienté
    this.route = el('line', { class: 'pm-route' }, this.svg);
    this.trailLine = el('polyline', { class: 'pm-trail' }, this.svg);
    this.drone = el('g', { class: 'pm-drone' }, this.svg);
    this.droneHalo = el('circle', { r: 0.85, class: 'pm-drone-halo' }, this.drone);
    this.droneRot = el('g', {}, this.drone);
    el('path', { d: 'M0 -0.5 L0.36 0 L0 0.5 L-0.36 0 Z', class: 'pm-drone-body' }, this.droneRot);
    el('path', { d: 'M0 -0.5 L0 -1.05', class: 'pm-drone-head' }, this.droneRot);
    if (!this.compact) this.droneAlt = el('text', { x: -0.7, y: -0.55, class: 'pm-drone-alt', 'text-anchor': 'end' }, this.drone);

    // Identifiants au-dessus de tout (drone compris), seulement quand ils comptent :
    // module en alerte, visé par le drone, sélectionné ou survolé
    if (!this.compact) {
      const labels = el('g', { class: 'pm-labels' }, this.svg);
      for (const pn of this.panels.values()) {
        pn.tag = el('text', { x: pn.cx + MW / 2, y: pn.cy - MD / 2 - 0.17, class: 'pm-id', 'text-anchor': 'end' }, labels);
        pn.tag.textContent = pn.data.id;
      }
    }
    this.built = true;

    // Réapplique le dernier état connu après une reconstruction
    const L = this.last;
    if (L.values) this.updateElectrical(L.values, L.alerts);
    if (L.zones) this.updateZoneStats(L.zones);
    if (L.inspection) this.updateInspection(L.inspection);
    if (L.selected) this.setSelected(L.selected);
    if (L.markers) this.setMarkers(L.markers);
    if (L.status) this.updateDrone(L.status, L.target, L.point);
  }

  // Repères : [{ x, z, sev, label }] en coordonnées terrain
  setMarkers(markers) {
    this.last.markers = markers;
    if (!this.markerLayer) return;
    const key = markers.map((m) => `${m.x},${m.z},${m.sev}`).join('|');
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.markerLayer.replaceChildren();
    for (const m of markers) {
      const [u, v] = this.project(m.x, m.z);
      const g = el('g', { class: 'pm-marker', 'data-sev': m.sev, transform: `translate(${u.toFixed(3)} ${v.toFixed(3)})` }, this.markerLayer);
      el('circle', { r: 0.62, class: 'pm-marker-ring' }, g);
      el('path', { d: 'M-0.95 0h0.5M0.45 0h0.5M0 -0.95v0.5M0 0.45v0.5', class: 'pm-marker-tick' }, g);
      if (!this.compact) {
        const t = el('text', { x: 0.85, y: -0.55, class: 'pm-marker-label' }, g);
        t.textContent = m.label;
      }
    }
  }

  _tag(pn) {
    if (!pn.tag) return;
    const on = Boolean(pn.sev || pn.target || pn.sel || pn.hover);
    pn.tag.classList.toggle('on', on);
    pn.tag.dataset.sev = pn.target ? 'target' : pn.sev || '';
  }

  _toSvg(ev) {
    const pt = this.svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  // Courants : { id: [courant, attendu] } ; alertes : { id: 'warning' | 'critical' }
  updateElectrical(values, alerts = {}) {
    this.last.values = values;
    this.last.alerts = alerts;
    for (const [id, pn] of this.panels) {
      const v = values[id];
      if (v) {
        const ratio = v[1] > 0.3 ? v[0] / v[1] : 0;
        pn.body.style.fill = cellColor(ratio);
      }
      const sev = alerts[id] || null;
      if (sev !== pn.sev) {
        pn.sev = sev;
        if (sev) {
          pn.out.dataset.sev = sev;
          pn.g.dataset.sev = sev;
        } else {
          delete pn.out.dataset.sev;
          delete pn.g.dataset.sev;
        }
        this._tag(pn);
      }
    }
  }

  updateZoneStats(stats) {
    this.last.zones = stats;
    for (const [id, text] of Object.entries(stats)) {
      const t = this.zoneLabels?.get(id);
      if (t) t.textContent = text;
    }
  }

  // États d'inspection (modules) issus de la simulation
  updateInspection(panels) {
    this.last.inspection = panels;
    for (const p of panels) {
      const pn = this.panels.get(p.id);
      if (!pn || pn.status === p.status) continue;
      pn.status = p.status;
      pn.mark.dataset.s = p.status;
      pn.strike.classList.toggle('on', p.status === 'defect');
    }
  }

  setSelected(id) {
    this.last.selected = id;
    for (const [pid, pn] of this.panels) {
      pn.sel = pid === id;
      pn.g.classList.toggle('sel', pn.sel);
      this._tag(pn);
    }
  }

  updateDrone(status, targetId, point = null) {
    this.last.status = status;
    this.last.target = targetId;
    this.last.point = point;
    if (!this.built || !status) {
      if (this.drone) this.drone.style.display = 'none';
      return;
    }
    const d = status.drone;
    const [x, z] = this.project(d.position.x, d.position.z);
    this.drone.style.display = '';
    this.drone.setAttribute('transform', `translate(${x.toFixed(3)} ${z.toFixed(3)})`);
    this.droneRot.setAttribute('transform', `rotate(${d.heading})`);
    this.drone.classList.toggle('grounded', !d.airborne);
    // Altitude masquée au-dessus d'un module : elle cacherait l'objet de l'inspection
    let overPanel = false;
    for (const pn of this.panels.values()) {
      if (Math.abs(pn.cx - x) < MW * 0.75 && Math.abs(pn.cy - z) < MD * 0.9) {
        overPanel = true;
        break;
      }
    }
    if (this.droneAlt) this.droneAlt.textContent = d.airborne && !overPanel ? `${d.altitude.toFixed(0)} m` : '';

    const now = performance.now();
    if (this.showTrail && d.airborne && now - this.trailAt > 350) {
      this.trailAt = now;
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last[0] - x, last[1] - z) > 0.08) this.trail.push([x, z]);
      if (this.trail.length > 90) this.trail.shift();
    }
    if (!d.airborne && this.trail.length) this.trail = [];
    this.trailLine.setAttribute('points', this.trail.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' '));

    const target = targetId ? this.panels.get(targetId) : null;
    const dest = target ? [target.cx, target.cy] : point ? this.project(point.x, point.z) : null;
    if (dest && d.airborne) {
      this.route.style.display = '';
      this.route.setAttribute('x1', x);
      this.route.setAttribute('y1', z);
      this.route.setAttribute('x2', dest[0]);
      this.route.setAttribute('y2', dest[1]);
    } else this.route.style.display = 'none';
    for (const [id, pn] of this.panels) {
      const t = id === targetId && d.airborne;
      if (t !== pn.target) {
        pn.target = t;
        pn.g.classList.toggle('target', t);
        this._tag(pn);
      }
    }
  }
}
