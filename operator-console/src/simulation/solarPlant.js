import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { CONFIG, DEFECT_TYPES, PANEL_STATUS, STRUCT_DEFECT_TYPES } from '../shared/config.js';
import { createValueNoise, mulberry32 } from '../shared/utils.js';
import { CELL_COLS, CELL_ROWS, TEX_W, TEX_H, cellRect, createCellCanvas, drawDefectVisible, createHeatCanvas } from '../shared/panelArt.js';
import { LAYERS } from './scene.js';

const DECAL_W = 1024;    // calque transparent portant le défaut visible
const DECAL_H = 512;
const FRAME_W = 0.035;   // largeur du cadre aluminium
const FRAME_T = 0.04;    // épaisseur du cadre
const GLASS_Y = 0.016;   // hauteur du verre dans le repère du panneau
const ZONE_MARGIN = 1.6; // marge du terrain de zone autour des panneaux
const ZONE_SOUTH = 3.6;  // bande sud de la zone (marquage au sol)

const STATUS_COLORS = {
  scanning: new THREE.Color(PANEL_STATUS.scanning.color),
  ok: new THREE.Color(PANEL_STATUS.ok.color),
  defect: new THREE.Color(PANEL_STATUS.defect.color),
  hover: new THREE.Color(0xffffff),
};

// ---------------------------------------------------------------------------
// Textures procédurales

function makeTexture(canvas, srgb) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function createDecalTexture(defect, rnd) {
  const c = document.createElement('canvas');
  c.width = DECAL_W;
  c.height = DECAL_H;
  const ctx = c.getContext('2d');
  ctx.scale(DECAL_W / TEX_W, DECAL_H / TEX_H);
  drawDefectVisible(ctx, defect, rnd);
  return makeTexture(c, true);
}

let shared = null;

function getSharedTextures() {
  if (!shared) {
    shared = {
      map: makeTexture(createCellCanvas(), true),
      heat: makeTexture(createHeatCanvas(null, 5), false),
    };
  }
  return shared;
}

function createFootprintTexture() {
  // Rectangle aux bords adoucis : empreinte de la caméra sur le verre
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      const ex = Math.min(x, 127 - x) / 16;
      const ey = Math.min(y, 63 - y) / 12;
      const a = Math.min(1, ex) * Math.min(1, ey);
      const line = Math.abs(x - 63.5) < 2 ? 1 : 0.35;
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * a * line;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return makeTexture(c, false);
}

function createZoneGroundTexture(zone, w, d) {
  const px = 64; // pixels par mètre
  const c = document.createElement('canvas');
  c.width = Math.round(w * px / 2);
  c.height = Math.round(d * px / 2);
  const k = c.width / w;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b4ae9f';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(245,245,240,0.9)';
  ctx.lineWidth = 0.12 * k;
  const inset = 0.35 * k;
  ctx.strokeRect(inset, inset, c.width - inset * 2, c.height - inset * 2);
  ctx.fillStyle = 'rgba(245,245,240,0.88)';
  ctx.font = `700 ${1.5 * k}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`ZONE ${zone.id}`, c.width / 2, c.height - (ZONE_SOUTH / 2 + 0.1) * k);
  return makeTexture(c, true);
}

// Acier galvanisé corrodé : rouille concentrée au pied, coulures vers le bas
function createRustCanvas() {
  const W = 64;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const n = createValueNoise(41, 32);
  const rand = mulberry32(17);
  const steel = [128, 135, 143];
  const rustA = [122, 62, 28];
  const rustB = [84, 44, 22];
  for (let y = 0; y < H; y++) {
    const fromBottom = 1 - y / H; // 0 en bas
    for (let x = 0; x < W; x++) {
      const k = n.fbm(x / 10, y / 22, 4);
      const streak = n(x / 3, y / 90);
      // Rouille dense sur le tiers bas, plaques éparses au-dessus
      const amount = Math.min(1, Math.max(0, (0.55 - fromBottom) * 2.4 + (k - 0.5) * 1.4 + (streak - 0.6) * 0.8));
      const dark = Math.max(0, k - 0.55) * 1.6;
      const i = (y * W + x) * 4;
      const sp = (rand() - 0.5) * 0.14;
      for (let j = 0; j < 3; j++) {
        const rust = rustA[j] + (rustB[j] - rustA[j]) * dark;
        img.data[i + j] = Math.max(0, Math.min(255, (steel[j] + (rust - steel[j]) * amount) * (1 + sp)));
      }
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Béton fissuré : fissures ramifiées et éclat d'angle
function createCrackCanvas() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = createValueNoise(57, 64);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 125 + (n.fbm(x / 9, y / 9, 3) - 0.5) * 40;
      const i = (y * S + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v * 0.98;
      img.data[i + 2] = v * 0.93;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rand = mulberry32(29);
  const crack = (x, y, ang, len, w) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let t = 0; t < len; t += 6) {
      ang += (rand() - 0.5) * 0.7;
      x += Math.cos(ang) * 6;
      y += Math.sin(ang) * 6;
      ctx.lineTo(x, y);
      if (rand() < 0.08 && w > 1.2) crack(x, y, ang + (rand() < 0.5 ? 0.9 : -0.9), len * 0.4, w * 0.6);
    }
    ctx.strokeStyle = 'rgba(28,24,20,0.92)';
    ctx.lineWidth = w;
    ctx.stroke();
  };
  crack(10, S * 0.3, 0.25, S * 1.1, 3.2);
  crack(S * 0.55, 0, 1.45, S * 0.9, 2.4);
  // Éclat : béton arraché dans un angle
  ctx.fillStyle = 'rgba(70,64,58,0.9)';
  ctx.beginPath();
  ctx.moveTo(S, S * 0.62);
  ctx.lineTo(S * 0.78, S * 0.82);
  ctx.lineTo(S * 0.86, S);
  ctx.lineTo(S, S);
  ctx.fill();
  return c;
}

let structTex = null;
function getStructTextures() {
  if (!structTex) {
    structTex = { rust: makeTexture(createRustCanvas(), true), crack: makeTexture(createCrackCanvas(), true) };
  }
  return structTex;
}

// Barre (boîte) reliant deux points
function segmentMesh(a, b, thickness, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, dir.length(), thickness), material);
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

const LEG_NAMES = { NW: 'north-west', NE: 'north-east', SW: 'south-west', SE: 'south-east' };

// ---------------------------------------------------------------------------

export class SolarPlant {
  constructor(scene) {
    const P = CONFIG.plant;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'solarPlant';
    scene.add(this.group);

    this.tilt = THREE.MathUtils.degToRad(P.tiltDeg);
    this.glassW = P.panelWidth - FRAME_W * 2;
    this.glassL = P.panelLength - FRAME_W * 2;
    this.panels = [];
    this.zones = [];
    this.hovered = null;
    this.hoveredZone = null;
    this.selectedZone = null;
    this.scanning = null;
    this.onZoneClick = null;
    this.view = 'modules'; // type d'inspection affiché : 'modules' | 'structure'

    this._buildPanels();
    this._buildZones();
    this._buildScanEffect();
  }

  _buildPanels() {
    const P = CONFIG.plant;
    const depth = P.panelLength * Math.cos(this.tilt);
    const rise = P.panelLength * Math.sin(this.tilt);
    const pitchX = P.panelWidth + P.colGap;
    const pitchZ = depth + P.rowGap;
    const centerY = P.lowEdgeHeight + rise / 2;
    const count = P.zones.length * P.rows * P.cols;

    const glassGeo = new THREE.PlaneGeometry(this.glassW, this.glassL);
    glassGeo.rotateX(-Math.PI / 2);
    const tex = getSharedTextures();
    // Un seul matériau pour tous les verres : la texture haute résolution est partagée
    // MeshStandardMaterial (sans clearcoat) : rendu quasi identique, nettement moins coûteux
    // quand les 60 verres remplissent l'écran
    const glassMat = new THREE.MeshStandardMaterial({
      map: tex.map,
      color: 0x8a93a3,
      roughness: 0.08,
      metalness: 0.2,
      envMapIntensity: 1.7,
    });

    // Contour d'état (anneau rectangulaire)
    const ringShape = new THREE.Shape();
    const ow = P.panelWidth / 2 + 0.08;
    const ol = P.panelLength / 2 + 0.08;
    ringShape.moveTo(-ow, -ol); ringShape.lineTo(ow, -ol); ringShape.lineTo(ow, ol); ringShape.lineTo(-ow, ol);
    const hole = new THREE.Path();
    const iw = P.panelWidth / 2 + 0.01;
    const il = P.panelLength / 2 + 0.01;
    hole.moveTo(-iw, -il); hole.lineTo(-iw, il); hole.lineTo(iw, il); hole.lineTo(iw, -il);
    ringShape.holes.push(hole);
    const ringGeo = new THREE.ShapeGeometry(ringShape);
    ringGeo.rotateX(-Math.PI / 2);

    // Pièces instanciées
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const alu = new THREE.MeshStandardMaterial({ color: 0xa4aab2, metalness: 0.85, roughness: 0.35 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x80878f, metalness: 0.65, roughness: 0.55 });
    const backsheetMat = new THREE.MeshStandardMaterial({ color: 0xe4e6e8, roughness: 0.7 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x7d7b74, roughness: 0.95 });

    const frames = new THREE.InstancedMesh(unitBox, alu, count * 4);
    const structure = new THREE.InstancedMesh(unitBox, steel, count * 6);
    const legsMesh = new THREE.InstancedMesh(unitBox, steel, count * 4); // un pied ↔ une fondation (même indice)
    const backsheets = new THREE.InstancedMesh(unitBox, backsheetMat, count);
    const footings = new THREE.InstancedMesh(unitBox, concrete, count * 4);
    for (const m of [frames, structure, legsMesh, backsheets, footings]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    frames.userData.thermal = { base: 0.4, sun: 0.08 };
    structure.userData.thermal = { base: 0.36, sun: 0.1 };
    legsMesh.userData.thermal = { base: 0.36, sun: 0.1 };
    backsheets.userData.thermal = { base: 0.5 };
    footings.userData.thermal = { base: 0.4, sun: 0.1 };
    this.group.add(frames, structure, legsMesh, backsheets, footings);
    this.legsMesh = legsMesh;
    this.footings = footings;
    this.steelMat = steel;
    this.concreteMat = concrete;

    const m4 = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const identityQ = new THREE.Quaternion();
    const counters = { frames: 0, structure: 0, footings: 0 };

    const putLocal = (mesh, key, panelMatrix, x, y, z, sx, sy, sz) => {
      local.compose(pos.set(x, y, z), identityQ, scl.set(sx, sy, sz));
      mesh.setMatrixAt(counters[key]++, m4.multiplyMatrices(panelMatrix, local));
    };
    const putWorld = (mesh, key, p, quat, s) => {
      mesh.setMatrixAt(counters[key]++, m4.compose(p, quat, s));
    };

    let index = 0;
    for (const zoneDef of P.zones) {
      const zone = { ...zoneDef, panels: [] };
      this.zones.push(zone);
      for (let r = 0; r < P.rows; r++) {
        for (let c = 0; c < P.cols; c++) {
          const id = `${zone.id}${String(r * P.cols + c + 1).padStart(2, '0')}`;
          const x = zone.center.x + (c - (P.cols - 1) / 2) * pitchX;
          const z = zone.center.z + (r - (P.rows - 1) / 2) * pitchZ;

          const pivot = new THREE.Group();
          pivot.position.set(x, centerY, z);
          pivot.rotation.x = this.tilt; // la face pointe vers le sud (+Z)
          this.group.add(pivot);
          pivot.updateMatrixWorld(true);
          const pm = pivot.matrixWorld;

          const glass = new THREE.Mesh(glassGeo, glassMat);
          glass.position.y = GLASS_Y;
          glass.receiveShadow = true;
          glass.userData.panelId = id;
          glass.userData.thermal = { heatMap: tex.heat };
          pivot.add(glass);

          const ringMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            toneMapped: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
          });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.position.y = FRAME_T / 2 + 0.006;
          ring.visible = false;
          ring.renderOrder = 2;
          ring.layers.set(LAYERS.MAIN_ONLY); // le flux caméra a son propre cadre de détection (HUD)
          ring.userData.thermal = { hidden: true };
          pivot.add(ring);

          // Étiquette d'identification (vue principale)
          const labelEl = document.createElement('div');
          labelEl.className = 'panel-label';
          labelEl.textContent = id;
          const label = new CSS2DObject(labelEl);
          label.position.set(0, 0.25, -P.panelLength / 2 - 0.05);
          label.layers.set(LAYERS.MAIN_ONLY);
          pivot.add(label);

          // Cadre aluminium (repère du panneau)
          const hw = P.panelWidth / 2;
          const hl = P.panelLength / 2;
          putLocal(frames, 'frames', pm, 0, 0, -hl + FRAME_W / 2, P.panelWidth, FRAME_T, FRAME_W);
          putLocal(frames, 'frames', pm, 0, 0, hl - FRAME_W / 2, P.panelWidth, FRAME_T, FRAME_W);
          putLocal(frames, 'frames', pm, -hw + FRAME_W / 2, 0, 0, FRAME_W, FRAME_T, P.panelLength - FRAME_W * 2);
          putLocal(frames, 'frames', pm, hw - FRAME_W / 2, 0, 0, FRAME_W, FRAME_T, P.panelLength - FRAME_W * 2);
          local.compose(pos.set(0, -0.004, 0), identityQ, scl.set(P.panelWidth - 0.02, 0.022, P.panelLength - 0.02));
          backsheets.setMatrixAt(index, m4.multiplyMatrices(pm, local));

          // Rails sous le panneau (repère incliné)
          const legX = hw - 0.35;
          putLocal(structure, 'structure', pm, -legX, -0.06, 0, 0.045, 0.06, P.panelLength + 0.06);
          putLocal(structure, 'structure', pm, legX, -0.06, 0, 0.045, 0.06, P.panelLength + 0.06);
          putLocal(structure, 'structure', pm, 0, -0.035, -hl * 0.6, P.panelWidth - 0.1, 0.04, 0.04);
          putLocal(structure, 'structure', pm, 0, -0.035, hl * 0.6, P.panelWidth - 0.1, 0.04, 0.04);

          // Pieds verticaux (repère monde) : avant courts (sud), arrière hauts (nord)
          const frontZ = z + depth / 2 - 0.12;
          const backZ = z - depth / 2 + 0.12;
          const frontTop = P.lowEdgeHeight + 0.12 * Math.tan(this.tilt) - 0.08;
          const backTop = P.lowEdgeHeight + rise - 0.12 * Math.tan(this.tilt) - 0.08;
          const legs = [];
          for (const sx of [-legX, legX]) {
            for (const [end, lz, top] of [['back', backZ, backTop], ['front', frontZ, frontTop]]) {
              const li = index * 4 + legs.length;
              legsMesh.setMatrixAt(li, m4.compose(pos.set(x + sx, top / 2, lz), identityQ, scl.set(0.05, top, 0.05)));
              footings.setMatrixAt(li, m4.compose(pos.set(x + sx, 0.05, lz), identityQ, scl.set(0.24, 0.12, 0.24)));
              const code = (end === 'back' ? 'N' : 'S') + (sx < 0 ? 'W' : 'E');
              const lx = x + sx;
              const corners = [];
              for (const cx of [-0.17, 0.17]) for (const cy of [0, top + 0.06]) for (const cz of [-0.17, 0.17]) corners.push(new THREE.Vector3(lx + cx, cy, lz + cz));
              legs.push({ code, name: LEG_NAMES[code], end, side: Math.sign(sx), x: lx, z: lz, height: top, instance: li, corners });
            }
            // Contreventement diagonal : pied avant (bas) -> pied arrière (aux 3/4)
            const dz = frontZ - backZ;
            const dy = backTop * 0.75;
            const len = Math.hypot(dz, dy);
            q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.atan2(-dz, dy));
            putWorld(structure, 'structure', pos.set(x + sx, dy / 2 + 0.05, (frontZ + backZ) / 2), q, scl.set(0.03, len, 0.03));
          }

          // Coins du verre dans le repère monde (cadre de détection caméra)
          const corners = [
            new THREE.Vector3(-hw, GLASS_Y, -hl), new THREE.Vector3(hw, GLASS_Y, -hl),
            new THREE.Vector3(hw, GLASS_Y, hl), new THREE.Vector3(-hw, GLASS_Y, hl),
          ].map((v) => v.applyMatrix4(pm));

          const center = new THREE.Vector3(0, GLASS_Y, 0).applyMatrix4(pm);
          const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(pivot.quaternion);

          const panel = {
            id, index, row: r, col: c, zone,
            pivot, glass, ring, label, labelEl, decal: null,
            center, normal, corners,
            status: 'pending',
            defect: null,
            heat: tex.heat,
            legs,
            // Inspection des structures : état et défaut indépendants de ceux des modules
            struct: { status: 'pending', defect: null, decor: null },
          };
          zone.panels.push(panel);
          this.panels.push(panel);
          index++;
        }
      }
    }
    for (const m of [frames, structure, legsMesh, backsheets, footings]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    // Matrices d'origine : restaurées quand un pied ou une fondation endommagé est réparé
    this.legMatrices = legsMesh.instanceMatrix.array.slice();
    this.footingMatrices = footings.instanceMatrix.array.slice();
    this.pickables = this.panels.map((p) => p.glass);
    this.decalGeo = glassGeo;
  }

  _buildZones() {
    for (const zone of this.zones) {
      const xs = zone.panels.map((p) => p.center.x);
      const zs = zone.panels.map((p) => p.center.z);
      const P = CONFIG.plant;
      const b = {
        minX: Math.min(...xs) - P.panelWidth / 2 - ZONE_MARGIN,
        maxX: Math.max(...xs) + P.panelWidth / 2 + ZONE_MARGIN,
        minZ: Math.min(...zs) - P.panelLength / 2 - ZONE_MARGIN,
        maxZ: Math.max(...zs) + P.panelLength / 2 + ZONE_SOUTH,
      };
      zone.bounds = b;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      zone.groundCenter = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);

      // Terrain de la zone : gravillons + marquage au sol
      const padGeo = new THREE.PlaneGeometry(w, d);
      padGeo.rotateX(-Math.PI / 2);
      const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({
        map: createZoneGroundTexture(zone, w, d),
        roughness: 0.95,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }));
      pad.position.set(zone.groundCenter.x, 0.002, zone.groundCenter.z);
      pad.receiveShadow = true;
      pad.userData.thermal = { base: 0.34, sun: 0.12, noise: 0.05 };
      this.group.add(pad);

      // Contour de survol / sélection (vue principale uniquement)
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 - 0.25, -d / 2 - 0.25); shape.lineTo(w / 2 + 0.25, -d / 2 - 0.25);
      shape.lineTo(w / 2 + 0.25, d / 2 + 0.25); shape.lineTo(-w / 2 - 0.25, d / 2 + 0.25);
      const h = new THREE.Path();
      h.moveTo(-w / 2, -d / 2); h.lineTo(-w / 2, d / 2); h.lineTo(w / 2, d / 2); h.lineTo(w / 2, -d / 2);
      shape.holes.push(h);
      const outlineGeo = new THREE.ShapeGeometry(shape);
      outlineGeo.rotateX(-Math.PI / 2);
      zone.outline = new THREE.Mesh(outlineGeo, new THREE.MeshBasicMaterial({
        color: 0x3aa0ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      }));
      zone.outline.position.set(zone.groundCenter.x, 0.02, zone.groundCenter.z);
      zone.outline.layers.set(LAYERS.MAIN_ONLY);
      zone.outline.visible = false;
      this.group.add(zone.outline);

      // Étiquette cliquable : ouvre la vue de zone
      const el = document.createElement('button');
      el.className = 'zone-label';
      el.innerHTML = `<b>${zone.name}</b><span class="zl-stats"></span>`;
      el.title = zone.name;
      el.addEventListener('click', () => this.onZoneClick && this.onZoneClick(zone.id));
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      zone.labelEl = el;
      const label = new CSS2DObject(el);
      label.position.set(zone.groundCenter.x, 0.3, b.maxZ - 0.4);
      label.layers.set(LAYERS.MAIN_ONLY);
      this.group.add(label);
      this.updateZoneLabel(zone);
    }
  }

  _buildScanEffect() {
    this.scanBand = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x58d8ff,
        alphaMap: createFootprintTexture(),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.scanBand.position.y = GLASS_Y + 0.01;
    this.scanBand.renderOrder = 3;
    this.scanBand.userData.thermal = { hidden: true };
    this.scanBand.layers.set(LAYERS.MAIN_ONLY); // l'empreinte correspond déjà au champ de la caméra : inutile dans le flux

    const glowGeo = new THREE.PlaneGeometry(this.glassW, this.glassL);
    glowGeo.rotateX(-Math.PI / 2);
    this.scanGlow = new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        color: 0x2aa8ff,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.scanGlow.position.y = GLASS_Y + 0.005;
    this.scanGlow.renderOrder = 3;
    this.scanGlow.layers.set(LAYERS.MAIN_ONLY);
    this.scanGlow.userData.thermal = { hidden: true };
    this.scanBand.visible = this.scanGlow.visible = false;
  }

  getPanel(id) {
    if (!id) return null;
    const key = String(id).toUpperCase();
    return this.panels.find((p) => p.id === key) || null;
  }

  getZone(id) {
    if (!id) return null;
    const key = String(id).toUpperCase().replace(/^ZONE\s*/, '');
    return this.zones.find((z) => z.id === key) || null;
  }

  zoneAt(x, z) {
    return this.zones.find((zn) => x >= zn.bounds.minX && x <= zn.bounds.maxX && z >= zn.bounds.minZ && z <= zn.bounds.maxZ) || null;
  }

  // Nouveaux défauts aléatoires (3 à 4 par zone) + remise à zéro des états
  // clean = true : centrale saine, aucun défaut caché (démonstration pilotée à la main)
  randomizeDefects(seed = (Math.random() * 1e9) | 0, { clean = false } = {}) {
    const P = CONFIG.plant;
    const rand = mulberry32(seed);

    for (const p of this.panels) this._clearModuleDefect(p);

    const types = Object.keys(DEFECT_TYPES);
    const { min, max } = clean ? { min: 0, max: 0 } : P.defectsPerZone;
    for (const zone of this.zones) {
      const n = min + Math.floor(rand() * (max - min + 1));
      const pool = [...zone.panels];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const p of pool.slice(0, n)) this._applyModuleDefect(p, types[Math.floor(rand() * types.length)], rand);
    }

    this._randomizeStructDefects(rand, clean);

    for (const p of this.panels) {
      p.glass.userData.thermal.heatMap = p.heat;
      this.setStatus(p, 'pending', 'modules');
      this.setStatus(p, 'pending', 'structure');
    }
    return this.panels.filter((p) => p.defect).map((p) => p.id);
  }

  _clearModuleDefect(p) {
    const healthy = getSharedTextures();
    if (p.decal) {
      p.decal.material.map.dispose();
      p.decal.material.dispose();
      p.pivot.remove(p.decal);
      p.decal = null;
    }
    if (p.heat !== healthy.heat) p.heat.dispose();
    p.heat = healthy.heat;
    p.defect = null;
  }

  // Défaut de module sur une cellule tirée au hasard (hors bords)
  _applyModuleDefect(p, type, rand = Math.random) {
    const cell = { col: 1 + Math.floor(rand() * (CELL_COLS - 2)), row: 1 + Math.floor(rand() * (CELL_ROWS - 2)) };
    p.defect = { type, label: DEFECT_TYPES[type], cell };
    p.heat = makeTexture(createHeatCanvas(p.defect, 100 + p.index * 13), false);

    // Défaut visible : calque transparent posé sur le verre.
    // Un point chaud n'a pas de trace visible : il n'apparaît qu'en thermique.
    if (type !== 'hotspot') {
      const decal = new THREE.Mesh(this.decalGeo, new THREE.MeshStandardMaterial({
        map: createDecalTexture(p.defect, rand),
        color: 0x8a93a3,
        transparent: true,
        roughness: 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }));
      decal.position.y = GLASS_Y + 0.001;
      decal.renderOrder = 1;
      decal.userData.thermal = { hidden: true };
      p.pivot.add(decal);
      p.decal = decal;
    }

    // Position du défaut (centre de cellule) dans le repère monde
    const rc = cellRect(cell.col, cell.row);
    const u = (rc.x + rc.w / 2) / TEX_W;
    const v = (rc.y + rc.h / 2) / TEX_H;
    p.defect.position = new THREE.Vector3((u - 0.5) * this.glassW, GLASS_Y, (v - 0.5) * this.glassL)
      .applyMatrix4(p.pivot.matrixWorld);
    p.glass.userData.thermal.heatMap = p.heat;
  }

  // Démonstration : défaut de module posé à la demande (remplace un défaut existant)
  injectModuleDefect(p, type) {
    if (!DEFECT_TYPES[type]) return false;
    this._clearModuleDefect(p);
    this._applyModuleDefect(p, type);
    this.setStatus(p, 'pending', 'modules');
    return true;
  }

  // Démonstration : défaut de structure posé à la demande sur un pied tiré au hasard
  injectStructDefect(p, type) {
    if (!STRUCT_DEFECT_TYPES[type]) return false;
    this.repairStruct(p);
    const leg = p.legs[Math.floor(Math.random() * p.legs.length)];
    this._applyStructDefect(p, type, leg, Math.random);
    this.legsMesh.instanceMatrix.needsUpdate = true;
    this.footings.instanceMatrix.needsUpdate = true;
    this.setStatus(p, 'pending', 'structure');
    return true;
  }

  // Pied ou fondation remis en état : instance d'origine restaurée
  repairStruct(p) {
    if (!p.struct.decor) return false;
    this.group.remove(p.struct.decor);
    p.struct.decor.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material !== this.steelMat) o.material.dispose();
      }
    });
    const leg = p.struct.defect?.leg;
    if (leg) {
      const m = new THREE.Matrix4();
      m.fromArray(this.legMatrices, leg.instance * 16);
      this.legsMesh.setMatrixAt(leg.instance, m);
      m.fromArray(this.footingMatrices, leg.instance * 16);
      this.footings.setMatrixAt(leg.instance, m);
      this.legsMesh.instanceMatrix.needsUpdate = true;
      this.footings.instanceMatrix.needsUpdate = true;
    }
    p.struct.decor = null;
    p.struct.defect = null;
    this.setStatus(p, 'pending', 'structure');
    return true;
  }

  // Module remplacé ou nettoyé (ordre de travail clôturé) : le défaut disparaît,
  // le panneau redevient « non analysé » pour une prochaine inspection
  repairPanel(p) {
    if (!p.defect) return false;
    const healthy = getSharedTextures();
    if (p.decal) {
      p.decal.material.map.dispose();
      p.decal.material.dispose();
      p.pivot.remove(p.decal);
      p.decal = null;
    }
    if (p.heat !== healthy.heat) p.heat.dispose();
    p.heat = healthy.heat;
    p.glass.userData.thermal.heatMap = p.heat;
    p.defect = null;
    this.setStatus(p, 'pending', 'modules');
    return true;
  }

  // Pieds corrodés ou déformés, fondations fissurées : 2 à 3 par zone
  _randomizeStructDefects(rand, clean = false) {
    const P = CONFIG.plant;
    for (const p of this.panels) {
      if (p.struct.decor) {
        this.group.remove(p.struct.decor);
        p.struct.decor.traverse((o) => {
          if (o.isMesh) {
            o.geometry.dispose();
            if (o.material !== this.steelMat) o.material.dispose();
          }
        });
      }
      p.struct.decor = null;
      p.struct.defect = null;
    }
    this.legsMesh.instanceMatrix.array.set(this.legMatrices);
    this.footings.instanceMatrix.array.set(this.footingMatrices);

    const types = Object.keys(STRUCT_DEFECT_TYPES);
    const { min, max } = clean ? { min: 0, max: 0 } : P.structDefectsPerZone;
    for (const zone of this.zones) {
      const n = min + Math.floor(rand() * (max - min + 1));
      const pool = [...zone.panels];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const p of pool.slice(0, n)) {
        const type = types[Math.floor(rand() * types.length)];
        this._applyStructDefect(p, type, p.legs[Math.floor(rand() * p.legs.length)], rand);
      }
    }
    this.legsMesh.instanceMatrix.needsUpdate = true;
    this.footings.instanceMatrix.needsUpdate = true;
  }

  _applyStructDefect(p, type, leg, rand) {
    const hide = new THREE.Matrix4().makeScale(0, 0, 0);
    const tex = getStructTextures();
    const decor = new THREE.Group();
    let position;
    if (type === 'corrosion') {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.052, leg.height, 0.052),
        new THREE.MeshStandardMaterial({ map: tex.rust, metalness: 0.35, roughness: 0.85 }),
      );
      mesh.position.set(leg.x, leg.height / 2, leg.z);
      mesh.userData.thermal = { base: 0.4, sun: 0.12 };
      decor.add(mesh);
      this.legsMesh.setMatrixAt(leg.instance, hide);
      position = new THREE.Vector3(leg.x, Math.min(0.3, leg.height * 0.4), leg.z);
    } else if (type === 'deformation') {
      // Pied flambé : pliure franche à mi-hauteur, déport latéral visible des deux côtés
      const dir = rand() < 0.5 ? -1 : 1;
      const a = new THREE.Vector3(leg.x, 0.1, leg.z);
      const m = new THREE.Vector3(leg.x + dir * 0.11, leg.height * 0.48, leg.z + 0.02);
      const b = new THREE.Vector3(leg.x, leg.height, leg.z);
      for (const seg of [segmentMesh(a, m, 0.05, this.steelMat), segmentMesh(m, b, 0.05, this.steelMat)]) {
        seg.userData.thermal = { base: 0.36, sun: 0.1 };
        decor.add(seg);
      }
      this.legsMesh.setMatrixAt(leg.instance, hide);
      position = m.clone();
    } else {
      // Fondation fissurée, légèrement basculée et enfoncée
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.12, 0.24),
        new THREE.MeshStandardMaterial({ map: tex.crack, roughness: 0.95 }),
      );
      mesh.position.set(leg.x, 0.035, leg.z);
      mesh.rotation.set(0.05, rand() * 0.6, 0.07);
      mesh.userData.thermal = { base: 0.4, sun: 0.1 };
      decor.add(mesh);
      this.footings.setMatrixAt(leg.instance, hide);
      position = new THREE.Vector3(leg.x, 0.1, leg.z);
    }
    decor.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(decor);
    p.struct.decor = decor;
    p.struct.defect = { type, label: `${STRUCT_DEFECT_TYPES[type]} (${leg.name})`, leg, position };
  }

  // Enregistrement d'inspection d'un panneau pour un type donné :
  // le panneau lui-même (modules) ou panel.struct (structures) — tous deux ont status/defect
  record(panel, type = this.view) {
    return type === 'structure' ? panel.struct : panel;
  }

  setInspectionView(type) {
    this.view = type;
    for (const p of this.panels) {
      p.labelEl.dataset.status = this.record(p).status;
      this._refreshRing(p);
    }
    for (const z of this.zones) this.updateZoneLabel(z);
  }

  setStatus(panel, status, type = 'modules') {
    this.record(panel, type).status = status;
    if (type !== this.view) return;
    panel.labelEl.dataset.status = status;
    this._refreshRing(panel);
    this.updateZoneLabel(panel.zone);
  }

  zoneStats(zone, type = this.view) {
    const ok = zone.panels.filter((p) => this.record(p, type).status === 'ok').length;
    const defect = zone.panels.filter((p) => this.record(p, type).status === 'defect').length;
    return { ok, defect, done: ok + defect, total: zone.panels.length };
  }

  updateZoneLabel(zone) {
    if (!zone.labelEl) return;
    const s = this.zoneStats(zone);
    zone.labelEl.querySelector('.zl-stats').textContent = `${s.done}/${s.total}${s.defect ? ` · ${s.defect} defect${s.defect > 1 ? 's' : ''}` : ''}`;
    zone.labelEl.classList.toggle('has-defect', s.defect > 0);
  }

  setHover(panel) {
    if (this.hovered === panel) return;
    const prev = this.hovered;
    this.hovered = panel;
    if (prev) this._refreshRing(prev);
    if (panel) this._refreshRing(panel);
  }

  setHoverZone(zone) {
    this.hoveredZone = zone;
    this._refreshZoneOutlines();
  }

  setSelectedZone(zone) {
    this.selectedZone = zone;
    this._refreshZoneOutlines();
    for (const z of this.zones) z.labelEl.classList.toggle('selected', z === zone);
  }

  _refreshZoneOutlines() {
    for (const z of this.zones) {
      const on = z === this.hoveredZone || z === this.selectedZone;
      z.outline.visible = on;
      z.outline.material.opacity = z === this.selectedZone ? 0.85 : 0.45;
    }
  }

  _refreshRing(panel) {
    const { ring } = panel;
    const { status } = this.record(panel);
    if (status === 'pending') {
      ring.visible = this.hovered === panel;
      ring.material.color.copy(STATUS_COLORS.hover);
      ring.material.opacity = 0.55;
    } else {
      ring.visible = true;
      ring.material.color.copy(STATUS_COLORS[status]);
      ring.material.opacity = 0.95;
    }
  }

  startScan(panel) {
    this.scanning = panel;
    panel.pivot.add(this.scanBand, this.scanGlow);
    this.scanBand.visible = this.scanGlow.visible = true;
    this.setStatus(panel, 'scanning', 'modules');
  }

  // Empreinte de la caméra sur le verre, en coordonnées locales du panneau
  updateScan(localX, localZ, footW, footL) {
    if (!this.scanning) return;
    const hw = this.glassW / 2;
    const hl = this.glassL / 2;
    const w = Math.min(footW, this.glassW);
    const l = Math.min(footL, this.glassL);
    this.scanBand.scale.set(w, 1, l);
    this.scanBand.position.x = THREE.MathUtils.clamp(localX, -hw + w / 2, hw - w / 2);
    this.scanBand.position.z = THREE.MathUtils.clamp(localZ, -hl + l / 2, hl - l / 2);
  }

  endScan() {
    if (!this.scanning) return;
    this.scanning.pivot.remove(this.scanBand, this.scanGlow);
    this.scanBand.visible = this.scanGlow.visible = false;
    this.scanning = null;
  }

  update(time) {
    const pulse = 0.55 + 0.45 * Math.sin(time * 6.5);
    for (const p of this.panels) {
      const { status } = this.record(p);
      if (status === 'defect') p.ring.material.opacity = 0.35 + 0.65 * pulse;
      else if (status === 'scanning') p.ring.material.opacity = 0.6 + 0.4 * Math.sin(time * 10);
    }
    if (this.scanning) {
      this.scanGlow.material.opacity = 0.06 + 0.04 * Math.sin(time * 12);
      this.scanBand.material.opacity = 0.45 + 0.15 * Math.sin(time * 9);
    }
    if (this.selectedZone) this.selectedZone.outline.material.opacity = 0.6 + 0.3 * Math.sin(time * 3);
  }

  setLabelsVisible(visible) {
    for (const p of this.panels) p.label.visible = visible;
  }

  // Ordre de passage : zone la plus proche d'abord, puis serpentin rangée par rangée
  missionOrder(fromX, fromZ, panels = this.panels) {
    const byZone = new Map();
    for (const p of panels) {
      if (!byZone.has(p.zone)) byZone.set(p.zone, []);
      byZone.get(p.zone).push(p);
    }
    const order = [];
    let cx = fromX;
    let cz = fromZ;
    while (byZone.size) {
      let best = null;
      let bestD = Infinity;
      for (const [zone, list] of byZone) {
        const d = Math.min(...list.map((p) => Math.hypot(p.center.x - cx, p.center.z - cz)));
        if (d < bestD) { bestD = d; best = zone; }
      }
      const seq = this._serpentine(byZone.get(best), cx, cz);
      order.push(...seq);
      byZone.delete(best);
      const last = seq[seq.length - 1];
      cx = last.center.x;
      cz = last.center.z;
    }
    return order;
  }

  _serpentine(list, fromX, fromZ) {
    const rows = [...new Set(list.map((p) => p.row))];
    const rowZ = (r) => list.find((p) => p.row === r).center.z;
    rows.sort((a, b) => Math.abs(rowZ(a) - fromZ) - Math.abs(rowZ(b) - fromZ));
    const xs = list.map((p) => p.center.x);
    let leftToRight = Math.abs(Math.min(...xs) - fromX) <= Math.abs(Math.max(...xs) - fromX);
    const order = [];
    for (const r of rows) {
      const rowPanels = list.filter((p) => p.row === r).sort((a, b) => a.col - b.col);
      if (!leftToRight) rowPanels.reverse();
      order.push(...rowPanels);
      leftToRight = !leftToRight;
    }
    return order;
  }
}
