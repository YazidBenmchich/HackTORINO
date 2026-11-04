// Courbe temporelle en SVG : une série mesurée (trait + aire), une référence « attendu »
// en pointillés, un seul axe, grille discrète, réticule et infobulle au survol,
// marqueurs d'événements (début d'une alerte). Redessinée au plus une fois par image.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export class TimeChart {
  // fmt(v) -> texte d'une valeur ; span : fenêtre affichée (ms)
  constructor(host, { span = 15 * 60_000, fmt = (v) => v.toFixed(1), unit = '', yMinZero = false, labels = ['Measured', 'Expected'], ticks = 3 } = {}) {
    this.host = host;
    this.span = span;
    this.fmt = fmt;
    this.unit = unit;
    this.yMinZero = yMinZero;
    this.labels = labels;
    this.nTicks = ticks;
    this.points = [];          // [t, mesuré, attendu]
    this.markers = [];         // [{ t, label, sev }]
    this.hoverX = null;
    this.svg = el('svg', { class: 'tchart', role: 'img' }, host);
    this.gGrid = el('g', { class: 'tc-grid' }, this.svg);
    this.area = el('path', { class: 'tc-area' }, this.svg);
    this.refLine = el('path', { class: 'tc-ref' }, this.svg);
    this.line = el('path', { class: 'tc-line' }, this.svg);
    this.gMarks = el('g', { class: 'tc-marks' }, this.svg);
    this.cross = el('line', { class: 'tc-cross' }, this.svg);
    this.dot = el('circle', { r: 4, class: 'tc-dot' }, this.svg);
    this.tip = document.createElement('div');
    this.tip.className = 'tc-tip';
    this.tip.hidden = true;
    host.appendChild(this.tip);
    host.classList.add('tc-host');
    this.svg.addEventListener('pointermove', (ev) => {
      const r = this.svg.getBoundingClientRect();
      this.hoverX = ev.clientX - r.left;
      this._queue();
    });
    this.svg.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this._queue();
    });
    new ResizeObserver(() => this._queue()).observe(host);
  }

  setData(points) {
    this.points = points;
    this._queue();
  }

  push(point, maxLen = 1200) {
    this.points.push(point);
    if (this.points.length > maxLen) this.points.shift();
    this._queue();
  }

  setMarkers(markers) {
    this.markers = markers;
    this._queue();
  }

  _queue() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (W < 20 || H < 20) return;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const padL = 4;
    const padR = 44;
    const padT = 8;
    const padB = 18;
    const now = this.points.length ? this.points[this.points.length - 1][0] : Date.now();
    const t0 = now - this.span;
    const pts = this.points.filter((p) => p[0] >= t0);
    const vals = pts.flatMap((p) => [p[1], p[2]]).filter((v) => Number.isFinite(v));
    let lo = vals.length ? Math.min(...vals) : 0;
    let hi = vals.length ? Math.max(...vals) : 1;
    if (this.yMinZero) lo = 0;
    const pad = Math.max((hi - lo) * 0.15, hi * 0.02, 0.01);
    lo = this.yMinZero ? 0 : lo - pad;
    hi += pad;
    const X = (t) => padL + ((t - t0) / this.span) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    this.X = X;

    // Grille : quelques graduations, texte à droite
    this.gGrid.replaceChildren();
    for (let i = 0; i <= this.nTicks - 1; i++) {
      const v = lo + ((hi - lo) * (i + 0.5)) / this.nTicks;
      const y = Y(v);
      el('line', { x1: padL, x2: W - padR, y1: y, y2: y }, this.gGrid);
      const t = el('text', { x: W - padR + 6, y: y + 3.5 }, this.gGrid);
      t.textContent = this.fmt(v);
    }
    const minutes = this.span / 60_000;
    const pxPerMin = (W - padL - padR) / minutes;
    const step = [0.5, 1, 2, 5, 10, 15].find((m) => m * pxPerMin >= 64) || minutes;
    for (let m = 0; m <= minutes; m += step) {
      const x = X(now - m * 60_000);
      const t = el('text', { x, y: H - 4, 'text-anchor': m === 0 ? 'end' : 'middle', class: 'tc-x' }, this.gGrid);
      t.textContent = m === 0 ? 'now' : `−${m} min`;
      if (m > 0 && x < padL + 24) t.remove();
    }

    const path = (i) => pts.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join('');
    if (pts.length > 1) {
      const d = path(1);
      this.line.setAttribute('d', d);
      this.refLine.setAttribute('d', path(2));
      this.area.setAttribute('d', `${d}L${X(pts[pts.length - 1][0]).toFixed(1)} ${H - padB}L${X(pts[0][0]).toFixed(1)} ${H - padB}Z`);
    }

    // Marqueurs : début des alertes
    this.gMarks.replaceChildren();
    let lastLabel = -Infinity;
    for (const m of [...this.markers].sort((a, b) => a.t - b.t)) {
      if (m.t < t0) continue;
      const x = X(m.t);
      el('line', { x1: x, x2: x, y1: padT, y2: H - padB, 'data-sev': m.sev || '' }, this.gMarks);
      // Étiquettes trop proches : seule la première est écrite, le trait reste
      if (x - lastLabel < 36) continue;
      lastLabel = x;
      const t = el('text', { x: x - 4, y: padT + 9, 'text-anchor': 'end', 'data-sev': m.sev || '' }, this.gMarks);
      t.textContent = m.label;
    }

    // Survol : réticule et valeurs
    if (this.hoverX != null && pts.length) {
      const tH = t0 + ((this.hoverX - padL) / (W - padL - padR)) * this.span;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - tH) < Math.abs(best[0] - tH)) best = p;
      const x = X(best[0]);
      this.cross.setAttribute('x1', x);
      this.cross.setAttribute('x2', x);
      this.cross.setAttribute('y1', padT);
      this.cross.setAttribute('y2', H - padB);
      this.dot.setAttribute('cx', x);
      this.dot.setAttribute('cy', Y(best[1]));
      this.cross.style.display = '';
      this.dot.style.display = '';
      const time = new Date(best[0]).toLocaleTimeString('en-GB');
      const gap = best[2] ? best[1] / best[2] - 1 : 0;
      this.tip.innerHTML = `<b>${time}</b><span class="m">${this.labels[0]} <em>${this.fmt(best[1])} ${this.unit}</em></span><span class="r">${this.labels[1]} <em>${this.fmt(best[2])} ${this.unit}</em></span><span class="g">Deviation <em>${gap <= 0 ? '−' : '+'}${Math.abs(gap * 100).toFixed(1)}%</em></span>`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(Math.max(0, x - tw / 2), W - tw)}px`;
      this.tip.style.top = `${-this.tip.offsetHeight - 6}px`;
    } else {
      this.cross.style.display = 'none';
      this.dot.style.display = 'none';
      this.tip.hidden = true;
    }
  }
}
