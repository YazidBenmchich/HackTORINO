import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG } from '../shared/config.js';
import { createValueNoise, mulberry32, smoothstep } from '../shared/utils.js';

// Calque 0 : monde visible par toutes les caméras.
// Calque 1 : éléments visibles uniquement dans la vue principale (drone, aides visuelles).
export const LAYERS = { WORLD: 0, MAIN_ONLY: 1 };

const SUN_ELEVATION = 42;
const SUN_AZIMUTH = 28; // depuis le sud (+Z) vers l'est (+X)
const FOG_COLOR = new THREE.Color(0xbfcfdc);

export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.render.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // La carte d'ombres est calculée une seule fois par image (vue principale),
  // puis réutilisée pour le rendu de la caméra du drone.
  renderer.shadowMap.autoUpdate = false;
  // Les journaux de compilation HLSL d'ANGLE (avertissements bénins) polluent la console :
  // la vérification n'est active qu'avec ?debug dans l'URL.
  renderer.debug.checkShaderErrors = new URLSearchParams(location.search).has('debug');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, 120, 520);
  scene.background = FOG_COLOR.clone();

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  camera.position.set(0, 40, 62);
  camera.layers.enable(LAYERS.MAIN_ONLY);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 3);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
  controls.minDistance = 3;
  controls.maxDistance = 220;
  controls.update();

  const sunDir = new THREE.Vector3(
    Math.sin(THREE.MathUtils.degToRad(SUN_AZIMUTH)) * Math.cos(THREE.MathUtils.degToRad(SUN_ELEVATION)),
    Math.sin(THREE.MathUtils.degToRad(SUN_ELEVATION)),
    Math.cos(THREE.MathUtils.degToRad(SUN_AZIMUTH)) * Math.cos(THREE.MathUtils.degToRad(SUN_ELEVATION)),
  ).normalize();

  const sky = createSky(sunDir);
  scene.add(sky);
  scene.userData.sky = sky;

  // Carte d'environnement générée à partir du ciel (reflets des panneaux)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = createSky(sunDir);
  envSky.material.uniforms.showSunDisc.value = 0;
  envSky.scale.setScalar(100);
  envScene.add(envSky);
  const envRT = pmrem.fromScene(envScene, 0.02, 0.1, 1000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.55;
  envSky.geometry.dispose();
  envSky.material.dispose();
  pmrem.dispose();

  const lights = createLights(scene, sunDir);
  const ground = createGround();
  scene.add(ground);

  return { renderer, scene, camera, controls, sky, sunDir, ground, lights };
}

function createSky(sunDir) {
  const sky = new Sky();
  sky.scale.setScalar(1500);
  const u = sky.material.uniforms;
  u.turbidity.value = 3.2;
  u.rayleigh.value = 1.1;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
  u.cloudCoverage.value = 0.32;
  u.cloudDensity.value = 0.45;
  u.sunPosition.value.copy(sunDir);
  sky.userData.thermal = { hidden: true };
  return sky;
}

function createLights(scene, sunDir) {
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6f6440, 0.45);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  // La zone d'ombre couvre les trois zones de panneaux et la plateforme
  sun.target.position.set(0, 0, 4);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
  const s = sun.shadow.camera;
  s.left = -38; s.right = 38; s.top = 26; s.bottom = -26;
  s.near = 30; s.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = CONFIG.render.shadowRadius;
  scene.add(sun, sun.target);
  return { hemi, sun };
}


// ---------------------------------------------------------------------------
// Terrain : prairie (texture d'herbe procédurale), plat sur la centrale,
// collines douces au loin pour casser l'horizon

function createGrassTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n1 = createValueNoise(11, 16);
  const n2 = createValueNoise(23, 32);
  const n3 = createValueNoise(37, 128);
  const rand = mulberry32(5);

  const grass = [104, 118, 62];
  const dry = [150, 140, 86];
  const dirt = [128, 106, 74];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = n1.fbm(u * 16, v * 16, 4);
      const b = n2.fbm(u * 32, v * 32, 3);
      const blades = n3(u * 128, v * 128);
      const dryMix = smoothstep(0.42, 0.66, a);
      const dirtMix = smoothstep(0.62, 0.78, b) * 0.75;
      const speck = (rand() - 0.5) * 0.12 + (blades - 0.5) * 0.22;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        let c = grass[k] + (dry[k] - grass[k]) * dryMix;
        c += (dirt[k] - c) * dirtMix;
        img.data[i + k] = Math.max(0, Math.min(255, c * (1 + speck)));
      }
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(90, 90);
  tex.anisotropy = 8;
  return tex;
}

function createGround() {
  const size = 1200;
  const seg = 200;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  // Variations de teinte à grande échelle (évite la répétition visible de la texture)
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const lowFreq = createValueNoise(77, 256);
  const hills = createValueNoise(91, 256);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = hills.fbm(x * 0.006 + 10, z * 0.006 + 10, 4);
    pos.setY(i, smoothstep(160, 360, Math.hypot(x, z)) * (h - 0.3) * 38);
    const v = 0.86 + lowFreq.fbm(x * 0.02 + 3, z * 0.02 + 3, 3) * 0.28;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v * 0.98;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: createGrassTexture(),
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    envMapIntensity: 0.4,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.name = 'ground';
  ground.userData.thermal = { base: 0.3, sun: 0.12, noise: 0.06 };
  return ground;
}

// ---------------------------------------------------------------------------
// Plateforme de décollage

function createPadTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2b2f35';
  ctx.fillRect(0, 0, 512, 512);
  const noise = createValueNoise(3, 64);
  const img = ctx.getImageData(0, 0, 512, 512);
  for (let i = 0; i < 512 * 512; i++) {
    const v = (noise((i % 512) / 6, Math.floor(i / 512) / 6) - 0.5) * 18;
    img.data[i * 4] += v; img.data[i * 4 + 1] += v; img.data[i * 4 + 2] += v;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(256, 256, 200, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#f2b705';
  ctx.lineWidth = 6;
  ctx.setLineDash([22, 14]);
  ctx.beginPath();
  ctx.arc(256, 256, 236, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#e8e8e8';
  ctx.font = 'bold 230px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('H', 256, 268);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createLandingPad() {
  const { x, z, padRadius, padHeight } = CONFIG.base;
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.8, metalness: 0.3 });
  const topMat = new THREE.MeshStandardMaterial({ map: createPadTexture(), roughness: 0.85 });
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(padRadius, padRadius + 0.05, padHeight, 48),
    [sideMat, topMat, sideMat],
  );
  pad.position.y = padHeight / 2;
  pad.receiveShadow = true;
  pad.castShadow = true;
  pad.userData.thermal = { base: 0.55, sun: 0.1 };
  group.add(pad);

  // Balises lumineuses autour de la plateforme
  const beaconGeo = new THREE.SphereGeometry(0.028, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0x8fdcff });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const b = new THREE.Mesh(beaconGeo, beaconMat);
    b.position.set(Math.cos(a) * (padRadius - 0.06), padHeight, Math.sin(a) * (padRadius - 0.06));
    b.userData.thermal = { base: 0.7 };
    group.add(b);
  }
  group.userData.beaconMat = beaconMat;
  return group;
}
