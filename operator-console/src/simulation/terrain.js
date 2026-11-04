import * as THREE from 'three';
import { mulberry32 } from '../shared/utils.js';

// Problèmes de terrain posés à la demande (démonstration) : visibles par le drone en survol,
// et dans la vue thermique (l'eau est froide, la végétation tiède, la terre nue chaude).
//   erosion      ravinement après de fortes pluies : saignée de terre nue et cailloux
//   water        eau stagnante (défaut d'isolement à l'onduleur) : flaque sombre et réfléchissante
//   vegetation   végétation envahissante au pied d'une rangée (ombrage, risque d'incendie)
//   subsidence   affaissement / tassement : cuvette et fissures concentriques

export const TERRAIN_TYPES = {
  erosion: 'erosion gully',
  water: 'standing water',
  vegetation: 'overgrown vegetation',
  subsidence: 'ground subsidence',
};

const Y = 0.035; // au-dessus du gravier des zones

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function flatDecal(w, d, map, opts = {}) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    map,
    transparent: true,
    depthWrite: false,
    roughness: opts.roughness ?? 0.95,
    metalness: opts.metalness ?? 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = Y;
  m.receiveShadow = true;
  m.renderOrder = 2;
  return m;
}

function makeErosion(rand) {
  const tex = canvasTexture(512, 256, (g, w, h) => {
    // Saignée sinueuse de terre brune, bords effrangés, cailloux
    for (let pass = 0; pass < 3; pass++) {
      g.beginPath();
      const amp = 26 - pass * 7;
      const width = 54 - pass * 16;
      for (let x = 0; x <= w; x += 8) {
        const y = h / 2 + Math.sin(x / 47 + pass) * amp + Math.sin(x / 13) * 6;
        if (x === 0) g.moveTo(x, y - width / 2);
        else g.lineTo(x, y - width / 2 + (rand() - 0.5) * 8);
      }
      for (let x = w; x >= 0; x -= 8) {
        const y = h / 2 + Math.sin(x / 47 + pass) * amp + Math.sin(x / 13) * 6;
        g.lineTo(x, y + width / 2 + (rand() - 0.5) * 8);
      }
      g.closePath();
      g.fillStyle = ['rgba(121,92,62,.85)', 'rgba(92,66,43,.95)', 'rgba(58,40,26,1)'][pass];
      g.fill();
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(${150 + rand() * 40},${140 + rand() * 30},${120 + rand() * 30},.9)`;
      g.beginPath();
      g.arc(rand() * w, h / 2 + (rand() - 0.5) * 70, 1.5 + rand() * 3.5, 0, Math.PI * 2);
      g.fill();
    }
    // Fondu sur les extrémités
    const fade = g.createLinearGradient(0, 0, w, 0);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.12, 'rgba(0,0,0,0)');
    fade.addColorStop(0.88, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
  });
  const m = flatDecal(7, 2.4, tex);
  m.rotation.y = (rand() - 0.5) * 0.6;
  m.userData.thermal = { base: 0.62, sun: 0.2 };
  return m;
}

function makeWater(rand) {
  const tex = canvasTexture(512, 512, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(58,74,82,.95)');
    grad.addColorStop(0.75, 'rgba(70,86,92,.85)');
    grad.addColorStop(0.92, 'rgba(96,84,64,.6)');
    grad.addColorStop(1, 'rgba(96,84,64,0)');
    g.fillStyle = grad;
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.15) {
      const r = w * (0.36 + 0.12 * Math.sin(a * 3 + rand() * 0.5) + 0.03 * rand());
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r * 0.8;
      if (a === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.fill();
  });
  const m = flatDecal(4.6, 3.6, tex, { roughness: 0.08, metalness: 0.2 });
  m.material.envMapIntensity = 1.4;
  m.userData.thermal = { base: 0.05, sun: 0.02 };
  return m;
}

function makeVegetation(rand) {
  const group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mats = [0x4f7a2e, 0x5f8a36, 0x3f6526, 0x6b8f3a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
  for (let i = 0; i < 46; i++) {
    const m = new THREE.Mesh(geo, mats[i % mats.length]);
    const s = 0.18 + rand() * 0.26;
    m.scale.set(s * (1 + rand() * 0.6), s * (1.2 + rand() * 1.4), s * (1 + rand() * 0.6));
    m.position.set((rand() - 0.5) * 9, m.scale.y * 0.7, (rand() - 0.5) * 1.2);
    m.rotation.y = rand() * Math.PI;
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.thermal = { base: 0.3, sun: 0.08 };
    group.add(m);
  }
  const tex = canvasTexture(512, 128, (g, w, h) => {
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${60 + rand() * 30},${100 + rand() * 40},${40 + rand() * 20},${0.5 + rand() * 0.4})`;
      g.fillRect(rand() * w, h * 0.2 + rand() * h * 0.6, 2 + rand() * 4, 2 + rand() * 4);
    }
  });
  const base = flatDecal(10, 1.8, tex);
  base.position.y = Y - 0.005;
  base.userData.thermal = { base: 0.32, sun: 0.08 };
  group.add(base);
  return group;
}

function makeSubsidence(rand) {
  const tex = canvasTexture(512, 512, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(70,58,44,.75)');
    grad.addColorStop(0.6, 'rgba(90,76,58,.45)');
    grad.addColorStop(1, 'rgba(90,76,58,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(38,30,22,.9)';
    for (let k = 0; k < 3; k++) {
      const R = w * (0.16 + k * 0.1);
      g.lineWidth = 3 - k * 0.7;
      g.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.2) {
        if (rand() < 0.22) {
          g.stroke();
          g.beginPath();
          continue;
        }
        const r = R * (1 + (rand() - 0.5) * 0.08);
        g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      g.stroke();
    }
  });
  const m = flatDecal(4.2, 4.2, tex);
  m.userData.thermal = { base: 0.45, sun: 0.14 };
  return m;
}

const MAKERS = { erosion: makeErosion, water: makeWater, vegetation: makeVegetation, subsidence: makeSubsidence };

export class TerrainIssues {
  constructor(scene) {
    this.scene = scene;
    this.items = new Map(); // id -> { type, x, z, object }
  }

  add(id, type, x, z) {
    if (!MAKERS[type]) return false;
    this.remove(id);
    const object = MAKERS[type](mulberry32((x * 73856093) ^ (z * 19349663) ^ type.length));
    object.position.x = x;
    object.position.z = z;
    this.scene.add(object);
    this.items.set(id, { type, x, z, object });
    return true;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    this.scene.remove(it.object);
    it.object.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    this.items.delete(id);
    return true;
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  list() {
    return [...this.items].map(([id, it]) => ({ id, type: it.type, label: TERRAIN_TYPES[it.type], x: it.x, z: it.z }));
  }
}
