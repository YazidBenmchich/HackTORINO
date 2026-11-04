// Dessin procédural d'un panneau (cellules, défauts visibles, carte de chaleur).
// Partagé par la simulation 3D (textures des panneaux) et le prototype mobile
// (panneaux imprimés) : sans dépendance à Three.js.

import { createValueNoise } from './utils.js';

export const CELL_COLS = 12;
export const CELL_ROWS = 6;
export const TEX_W = 2048;      // texture des cellules (partagée par tous les panneaux)
export const TEX_H = 1024;
const S = TEX_W / 1024;         // facteur d'échelle des tracés
export const HEAT_W = 256;
export const HEAT_H = 128;

export function cellRect(col, row) {
  const margin = 6 * S;
  const gap = 3 * S;
  const cw = (TEX_W - margin * 2 - gap * (CELL_COLS - 1)) / CELL_COLS;
  const ch = (TEX_H - margin * 2 - gap * (CELL_ROWS - 1)) / CELL_ROWS;
  return { x: margin + col * (cw + gap), y: margin + row * (ch + gap), w: cw, h: ch };
}

// Centre d'un défaut (pixels de texture) : centre de sa cellule, décalé de `offset` (en cellules)
export function defectCenter(defect) {
  const r = cellRect(defect.cell.col, defect.cell.row);
  const o = defect.offset || { x: 0, y: 0 };
  return { x: r.x + r.w * (0.5 + o.x), y: r.y + r.h * (0.5 + o.y), r };
}

// backsheet : couleur visible entre les cellules (argentée par défaut, sombre pour un module « full black »)
// scale : résolution du canevas (1 = TEX_W × TEX_H ; plus pour l'impression grand format)
export function createCellCanvas({ backsheet = '#aab3bf', busbar = 'rgba(200,208,222,0.6)', scale = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.round(TEX_W * scale);
  c.height = Math.round(TEX_H * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = backsheet;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  const noise = createValueNoise(17, 256);
  for (let row = 0; row < CELL_ROWS; row++) {
    for (let col = 0; col < CELL_COLS; col++) {
      const r = cellRect(col, row);
      const cut = r.w * 0.11; // coins chanfreinés (silicium monocristallin)
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(r.x + cut, r.y);
      ctx.lineTo(r.x + r.w - cut, r.y);
      ctx.lineTo(r.x + r.w, r.y + cut);
      ctx.lineTo(r.x + r.w, r.y + r.h - cut);
      ctx.lineTo(r.x + r.w - cut, r.y + r.h);
      ctx.lineTo(r.x + cut, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h - cut);
      ctx.lineTo(r.x, r.y + cut);
      ctx.closePath();
      ctx.clip();
      const shade = noise(col * 3.1, row * 2.7) * 0.25;
      const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
      g.addColorStop(0, `rgb(${18 + shade * 20}, ${32 + shade * 22}, ${70 + shade * 30})`);
      g.addColorStop(1, `rgb(${10 + shade * 14}, ${20 + shade * 16}, ${50 + shade * 24})`);
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // doigts de collecte (très fins)
      ctx.strokeStyle = 'rgba(150,165,190,0.12)';
      ctx.lineWidth = 0.8 * S;
      for (let k = 1; k < 22; k++) {
        const yy = r.y + (k / 22) * r.h;
        ctx.beginPath();
        ctx.moveTo(r.x, yy);
        ctx.lineTo(r.x + r.w, yy);
        ctx.stroke();
      }
      // busbars
      ctx.strokeStyle = busbar;
      ctx.lineWidth = 1.6 * S;
      for (let k = 1; k <= 3; k++) {
        const xx = r.x + (k / 4) * r.w;
        ctx.beginPath();
        ctx.moveTo(xx, r.y);
        ctx.lineTo(xx, r.y + r.h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Défauts visibles (coordonnées de la texture pleine résolution)

// Contour fermé irrégulier et lissé (tache, brûlure, fiente)
function irregularPath(ctx, cx, cy, rx, ry, rnd, jag = 0.3, rot = 0, n = 36) {
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + jag * (0.55 * Math.sin(2 * a + ph[0]) + 0.3 * Math.sin(5 * a + ph[1]) + 0.15 * Math.sin(11 * a + ph[2]))
      + (rnd() - 0.5) * jag * 0.35;
    const x = Math.cos(a) * rx * k;
    const y = Math.sin(a) * ry * k;
    pts.push([cx + x * cos - y * sin, cy + x * sin + y * cos]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  const m0 = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i], pts[(i + 1) % n]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
  }
  ctx.closePath();
}

// Ligne brisée irrégulière partant de (x, y) dans la direction `ang`
function jaggedLine(x, y, ang, len, rnd, wobble = 0.35, steps = 10) {
  const pts = [[x, y]];
  for (let i = 0; i < steps; i++) {
    ang += (rnd() - 0.5) * wobble;
    x += Math.cos(ang) * (len / steps);
    y += Math.sin(ang) * (len / steps);
    pts.push([x, y]);
  }
  return pts;
}

function strokePolyline(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

// Limite le dessin à la cellule (les défauts réels restent confinés à une cellule)
function clipCell(ctx, r) {
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
}

// Point chaud : petite tache brune (EVA bruni) avec cœur sombre, ruban légèrement roussi
function drawBurn(ctx, cx, cy, r, size, rnd) {
  const R = r.w * 0.15 * size;
  ctx.save();
  clipCell(ctx, r);
  ctx.lineCap = 'round';

  // Auréole de brunissement, diffuse
  irregularPath(ctx, cx, cy, R * 2.2, R * 2.5, rnd, 0.3);
  let g = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2.6);
  g.addColorStop(0, 'rgba(120,82,40,0.45)');
  g.addColorStop(0.6, 'rgba(110,80,45,0.18)');
  g.addColorStop(1, 'rgba(100,80,50,0)');
  ctx.fillStyle = g;
  ctx.fill();

  // Ruban le plus proche, roussi sur une courte longueur
  let bx = r.x + r.w / 4;
  for (let k = 2; k <= 3; k++) {
    const x = r.x + (k / 4) * r.w;
    if (Math.abs(x - cx) < Math.abs(bx - cx)) bx = x;
  }
  if (Math.abs(bx - cx) < R * 2.5) {
    const lg = ctx.createLinearGradient(bx, cy - R * 3, bx, cy + R * 3);
    lg.addColorStop(0, 'rgba(90,55,25,0)');
    lg.addColorStop(0.5, 'rgba(80,48,20,0.6)');
    lg.addColorStop(1, 'rgba(90,55,25,0)');
    ctx.strokeStyle = lg;
    ctx.lineWidth = 2 * S;
    ctx.beginPath();
    ctx.moveTo(bx, cy - R * 3);
    ctx.lineTo(bx, cy + R * 3);
    ctx.stroke();
  }

  // Tache brune
  irregularPath(ctx, cx, cy, R, R * 0.9, rnd, 0.35, rnd() * 3);
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
  g.addColorStop(0, 'rgba(70,40,18,0.9)');
  g.addColorStop(0.7, 'rgba(105,66,30,0.65)');
  g.addColorStop(1, 'rgba(125,85,42,0.25)');
  ctx.fillStyle = g;
  ctx.fill();

  // Cœur sombre
  irregularPath(ctx, cx + (rnd() - 0.5) * R * 0.3, cy + (rnd() - 0.5) * R * 0.3, R * 0.32, R * 0.28, rnd, 0.5, rnd() * 3);
  ctx.fillStyle = 'rgba(30,18,10,0.85)';
  ctx.fill();
  ctx.restore();
}

// Verre fissuré (impact de grêle ou de caillou) : petit point d'impact, quelques fissures
// rayonnantes fines et claires (reflet des faces de rupture), un ou deux arcs. Rayon < 1 cellule.
function drawCracks(ctx, cx, cy, r, size, rnd) {
  const R = r.w * 0.75 * size;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const lines = [];
  const rays = [];
  const n = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
    const len = R * (0.45 + rnd() * 0.55);
    const ray = jaggedLine(cx, cy, a, len, rnd, 0.3, 9);
    rays.push({ pts: ray, len });
    lines.push(ray);
    if (rnd() < 0.45) {
      const [px, py] = ray[4 + Math.floor(rnd() * 3)];
      lines.push(jaggedLine(px, py, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.4), len * (0.2 + rnd() * 0.2), rnd, 0.35, 4));
    }
  }
  // Un ou deux arcs reliant des rayons voisins, près de l'impact
  const pointAt = (ray, d) => ray.pts[Math.min(ray.pts.length - 1, Math.round((d / ray.len) * (ray.pts.length - 1)))];
  const d = R * 0.22;
  for (let i = 0; i < n; i++) {
    const a = rays[i];
    const b = rays[(i + 1) % n];
    if (a.len < d || b.len < d || rnd() > 0.45) continue;
    const p = pointAt(a, d);
    const q = pointAt(b, d);
    lines.push([p, [(p[0] + q[0]) / 2 + (rnd() - 0.5) * d * 0.2, (p[1] + q[1]) / 2 + (rnd() - 0.5) * d * 0.2], q]);
  }

  // Halo diffus des faces de rupture, puis trait clair et fin
  ctx.strokeStyle = 'rgba(190,205,228,0.22)';
  ctx.lineWidth = 3.5 * S;
  for (const l of lines) strokePolyline(ctx, l);
  ctx.strokeStyle = 'rgba(232,238,248,0.88)';
  ctx.lineWidth = 1.3 * S;
  for (const l of lines) strokePolyline(ctx, l);

  // Point d'impact : petit éclat de verre étoilé
  irregularPath(ctx, cx, cy, 4.5 * S * size, 4 * S * size, rnd, 0.6);
  ctx.fillStyle = 'rgba(236,241,250,0.92)';
  ctx.fill();
  ctx.restore();
}

// Fiente : petit dépôt blanc cassé, centre plus sombre, courte coulure vers le bas, rares éclaboussures
function drawSplat(ctx, x, y, R, rnd) {
  const rot = rnd() * Math.PI;
  // Bord translucide
  irregularPath(ctx, x, y, R * 1.25, R * 1.05, rnd, 0.4, rot, 32);
  ctx.fillStyle = 'rgba(200,198,186,0.3)';
  ctx.fill();

  // Courte coulure
  irregularPath(ctx, x + (rnd() - 0.5) * R * 0.2, y + R * 0.7, R * 0.22, R * 0.5, rnd, 0.3);
  ctx.fillStyle = 'rgba(212,210,198,0.7)';
  ctx.fill();

  irregularPath(ctx, x, y, R, R * 0.85, rnd, 0.45, rot, 32);
  const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.1);
  g.addColorStop(0, 'rgba(228,226,214,0.95)');
  g.addColorStop(0.75, 'rgba(214,211,196,0.9)');
  g.addColorStop(1, 'rgba(190,188,172,0.75)');
  ctx.fillStyle = g;
  ctx.fill();

  // Partie sombre, décentrée
  irregularPath(ctx, x + (rnd() - 0.5) * R * 0.4, y + (rnd() - 0.5) * R * 0.3, R * 0.32, R * 0.25, rnd, 0.6, rnd() * 3);
  ctx.fillStyle = 'rgba(75,74,60,0.75)';
  ctx.fill();

  // Éclaboussures
  ctx.fillStyle = 'rgba(218,216,202,0.85)';
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = R * (1.3 + rnd() * 0.6);
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, R * (0.06 + rnd() * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDroppings(ctx, cx, cy, r, size, rnd) {
  ctx.save();
  const n = 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < n; k++) {
    const x = k === 0 ? cx : cx + (rnd() - 0.5) * r.w * 0.9 * size;
    const y = k === 0 ? cy : cy + (rnd() - 0.5) * r.h * 0.7 * size;
    const R = (k === 0 ? 10 + rnd() * 5 : 4 + rnd() * 3) * S * size;
    drawSplat(ctx, x, y, R, rnd);
  }
  ctx.restore();
}

// defect : { type: 'hotspot' | 'crack' | 'soiling', cell: { col, row }, scale?, offset? }
export function drawDefectVisible(ctx, defect, rnd) {
  const { x, y, r } = defectCenter(defect);
  const size = defect.scale ?? 1;
  if (defect.type === 'hotspot') drawBurn(ctx, x, y, r, size, rnd);
  else if (defect.type === 'crack') drawCracks(ctx, x, y, r, size, rnd);
  else if (defect.type === 'soiling') drawDroppings(ctx, x, y, r, size, rnd);
}

// ---------------------------------------------------------------------------

// Carte de chaleur en niveaux de gris (0 = froid, 255 = chaud).
// `defects` : un défaut, une liste de défauts, ou null pour un panneau sain.
export function createHeatCanvas(defects, seed) {
  const list = defects ? [].concat(defects) : [];
  const c = document.createElement('canvas');
  c.width = HEAT_W;
  c.height = HEAT_H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(HEAT_W, HEAT_H);
  const noise = createValueNoise(seed, 256);
  const sx = HEAT_W / TEX_W;
  const sy = HEAT_H / TEX_H;
  for (let y = 0; y < HEAT_H; y++) {
    for (let x = 0; x < HEAT_W; x++) {
      // Panneau sain : chaleur homogène, plus chaud en haut (convection)
      const v = 0.5 + (1 - y / HEAT_H) * 0.04 + (noise(x / 9, y / 9) - 0.5) * 0.03;
      const i = (y * HEAT_W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Cellules légèrement plus chaudes que les interstices
  ctx.fillStyle = 'rgba(140,140,140,0.18)';
  for (let row = 0; row < CELL_ROWS; row++) {
    for (let col = 0; col < CELL_COLS; col++) {
      const r = cellRect(col, row);
      ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
    }
  }

  for (const defect of list) {
    const { x, y, r } = defectCenter(defect);
    const cx = x * sx;
    const cy = y * sy;
    const blob = (bx, by, rad, peak) => {
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
      const p = Math.round(peak * 255);
      g.addColorStop(0, `rgba(${p},${p},${p},1)`);
      g.addColorStop(0.45, `rgba(${p},${p},${p},0.7)`);
      g.addColorStop(1, `rgba(${p},${p},${p},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
    };
    if (defect.type === 'hotspot') {
      blob(cx, cy, r.w * sx * 1.6, 0.85);
      blob(cx, cy, r.w * sx * 0.6, 1.0);
    } else if (defect.type === 'crack') {
      ctx.fillStyle = 'rgba(215,215,215,0.9)';
      ctx.fillRect(r.x * sx, r.y * sy, r.w * sx * 0.62, r.h * sy);
      blob(cx, cy, r.w * sx * 0.7, 0.95);
    } else if (defect.type === 'soiling') {
      const g = ctx.createLinearGradient(0, HEAT_H * 0.6, 0, HEAT_H);
      g.addColorStop(0, 'rgba(175,175,175,0)');
      g.addColorStop(1, 'rgba(175,175,175,0.8)');
      ctx.fillStyle = g;
      ctx.fillRect(0, HEAT_H * 0.6, HEAT_W, HEAT_H * 0.4);
      blob(cx, cy, r.w * sx * 1.2, 0.9);
    }
  }
  return c;
}
