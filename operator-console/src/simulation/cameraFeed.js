import * as THREE from 'three';
import { CONFIG, STATE_LABELS } from '../shared/config.js';
import { clamp, formatClock, formatDateTime } from '../shared/utils.js';

// Retour caméra du drone : rendu dans un WebGLRenderTarget, puis composé dans un
// viewport en incrustation (ou plein écran) avec un post-traitement :
//   - RGB : tone mapping ACES + vignettage + grain
//   - thermique : rendu « chaleur » (matériaux substitués) + fausses couleurs
// Le HUD est dessiné dans un canvas 2D superposé.

const THERMAL_MIN = 0.2; // valeur de chaleur affichée en bas de l'échelle
const THERMAL_MAX = 1.0;

const heatToTemp = (h) => CONFIG.thermal.minTemp + h * (CONFIG.thermal.maxTemp - CONFIG.thermal.minTemp);

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const hashGLSL = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
`;

function createRgbMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: quadVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor;
      uniform float uTime;
      uniform vec2 uRes;
      varying vec2 vUv;
      ${hashGLSL}
      void main() {
        vec4 c = texture2D(tColor, vUv);
        gl_FragColor = vec4(c.rgb, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        vec2 d = vUv - 0.5;
        float vig = 1.0 - dot(d, d) * 0.6;
        float grain = (hash(vUv * uRes + fract(uTime * 7.13) * 91.7) - 0.5) * 0.035;
        gl_FragColor.rgb = gl_FragColor.rgb * vig + grain;
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

function createFalseColorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tHeat: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uMin: { value: THERMAL_MIN },
      uMax: { value: THERMAL_MAX },
    },
    vertexShader: quadVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tHeat;
      uniform vec2 uTexel;
      uniform float uTime;
      uniform float uMin;
      uniform float uMax;
      varying vec2 vUv;
      ${hashGLSL}
      vec3 palette(float t) {
        const vec3 c0 = vec3(0.02, 0.02, 0.10);
        const vec3 c1 = vec3(0.06, 0.16, 0.60);
        const vec3 c2 = vec3(0.10, 0.60, 0.86);
        const vec3 c3 = vec3(0.98, 0.90, 0.22);
        const vec3 c4 = vec3(1.00, 0.52, 0.08);
        const vec3 c5 = vec3(0.92, 0.08, 0.05);
        const vec3 c6 = vec3(1.00, 0.93, 0.90);
        t = clamp(t, 0.0, 1.0);
        if (t < 0.2) return mix(c0, c1, t / 0.2);
        if (t < 0.45) return mix(c1, c2, (t - 0.2) / 0.25);
        if (t < 0.65) return mix(c2, c3, (t - 0.45) / 0.2);
        if (t < 0.8) return mix(c3, c4, (t - 0.65) / 0.15);
        if (t < 0.95) return mix(c4, c5, (t - 0.8) / 0.15);
        return mix(c5, c6, (t - 0.95) / 0.05);
      }
      void main() {
        // Légère diffusion optique (capteur microbolomètre basse résolution)
        float h = texture2D(tHeat, vUv).r * 0.4;
        h += texture2D(tHeat, vUv + vec2(uTexel.x, 0.0)).r * 0.15;
        h += texture2D(tHeat, vUv - vec2(uTexel.x, 0.0)).r * 0.15;
        h += texture2D(tHeat, vUv + vec2(0.0, uTexel.y)).r * 0.15;
        h += texture2D(tHeat, vUv - vec2(0.0, uTexel.y)).r * 0.15;
        h += (hash(floor(vUv / (uTexel * 2.0)) + fract(uTime * 3.7) * 57.0) - 0.5) * 0.018;
        float t = (h - uMin) / (uMax - uMin);
        vec3 col = palette(t);
        vec2 d = vUv - 0.5;
        col *= 1.0 - dot(d, d) * 0.45;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

// Matériau « chaleur » : écrit une valeur scalaire dans le canal rouge
function createThermalMaterial(def, sunDir) {
  const defines = {};
  if (def.heatMap) defines.HAS_HEAT = '';
  else if (def.map) defines.HAS_MAP = '';
  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uBase: { value: def.base ?? 0.4 },
      uSun: { value: def.sun ?? 0 },
      uSunDir: { value: sunDir },
      uMapMix: { value: def.mapMix ?? 0 },
      uNoise: { value: def.noise ?? 0 },
      uMap: { value: def.map ?? null },
      uMapTransform: { value: def.map ? def.map.matrix : new THREE.Matrix3() },
      uHeat: { value: def.heatMap ?? null },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          n = mat3(instanceMatrix) * n;
        #endif
        vec4 wp = modelMatrix * p;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * n);
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBase;
      uniform float uSun;
      uniform vec3 uSunDir;
      uniform float uMapMix;
      uniform float uNoise;
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      uniform sampler2D uMap;
      uniform mat3 uMapTransform;
      uniform sampler2D uHeat;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      void main() {
        vec3 n = normalize(vNormalW);
        if (!gl_FrontFacing) n = -n;
        float heat = uBase + uSun * max(dot(n, uSunDir), 0.0);
        heat += (vnoise(vWorldPos.xz * 0.35) + 0.5 * vnoise(vWorldPos.xz * 1.7) - 0.75) * uNoise;
        #ifdef HAS_HEAT
          heat = texture2D(uHeat, vUv).r;
        #endif
        #ifdef HAS_MAP
          vec3 c = texture2D(uMap, (uMapTransform * vec3(vUv, 1.0)).xy).rgb;
          heat += (dot(c, vec3(0.299, 0.587, 0.114)) - 0.35) * uMapMix;
        #endif
        // Émissivité apparente plus faible en incidence rasante (reflet du ciel froid)
        vec3 v = normalize(cameraPosition - vWorldPos);
        heat -= (1.0 - abs(dot(n, v))) * 0.08;
        gl_FragColor = vec4(heat, heat, heat, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
}

export class CameraFeed {
  constructor({ renderer, scene, drone, controller, plant, viewport, feedEl, hudCanvas, sunDir }) {
    this.renderer = renderer;
    this.scene = scene;
    this.drone = drone;
    this.camera = drone.camera;
    this.controller = controller;
    this.plant = plant;
    this.viewport = viewport;
    this.feedEl = feedEl;
    this.hud = hudCanvas;
    this.ctx = hudCanvas.getContext('2d');
    this.sunDir = sunDir;

    this.fullscreen = false;
    this.thermal = false;
    this.rect = { x: 0, y: 0, w: 1, h: 1 };
    this.dpr = 1;

    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    this.rgbMat = createRgbMaterial();
    this.thermalMat = createFalseColorMaterial();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.rgbMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.thermalCache = new WeakMap();
    this.swapped = [];
    this.coldBackground = new THREE.Color(0.06, 0.06, 0.06);
    this.layout();
  }

  // ------------------------------------------------------------------ mise en page

  layout() {
    const W = this.viewport.clientWidth;
    const H = this.viewport.clientHeight;
    const margin = 16;
    let r;
    if (this.fullscreen) {
      r = { x: 0, y: 0, w: W, h: H };
    } else {
      const w = Math.round(clamp(window.innerWidth * CONFIG.camera.feedWidthRatio, Math.min(CONFIG.camera.feedMinWidth, W - margin * 2), W - margin * 2));
      const h = Math.round((w * 9) / 16);
      r = { x: margin, y: H - h - margin, w, h };
    }
    this.rect = r;
    Object.assign(this.feedEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    this.feedEl.classList.toggle('fullscreen', this.fullscreen);
    this.feedEl.classList.toggle('compact', r.w < 440);

    this.dpr = this.renderer.getPixelRatio();
    const pw = Math.max(2, Math.round(r.w * this.dpr));
    const ph = Math.max(2, Math.round(r.h * this.dpr));
    this.rt.setSize(pw, ph);
    this.hud.width = pw;
    this.hud.height = ph;
    this.rgbMat.uniforms.uRes.value.set(pw, ph);
    this.thermalMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
    this.camera.aspect = r.w / r.h;
    this.camera.updateProjectionMatrix();
  }

  setFullscreen(on) {
    this.fullscreen = on;
    this.layout();
  }

  setThermal(on) {
    this.thermal = on;
    this.quad.material = on ? this.thermalMat : this.rgbMat;
  }

  // ------------------------------------------------------------------ rendu

  _swapToThermal() {
    const swapped = this.swapped;
    swapped.length = 0;
    this.scene.traverse((o) => {
      if (!(o.isMesh || o.isSprite) || !o.visible || !o.layers.test(this.camera.layers)) return;
      const def = o.userData.thermal || {};
      if (def.hidden || o.isSprite) {
        swapped.push([o, null]);
        o.visible = false;
        return;
      }
      let mat = this.thermalCache.get(o);
      if (!mat) {
        const map = def.mapMix ? o.material.map : null;
        if (map) map.updateMatrix();
        mat = createThermalMaterial({ ...def, map }, this.sunDir);
        this.thermalCache.set(o, mat);
      }
      if (def.heatMap) mat.uniforms.uHeat.value = def.heatMap;
      swapped.push([o, o.material]);
      o.material = mat;
    });
    this._savedBackground = this.scene.background;
    this._savedFog = this.scene.fog;
    this.scene.background = this.coldBackground;
    this.scene.fog = null;
  }

  _restoreMaterials() {
    for (const [o, mat] of this.swapped) {
      if (mat) o.material = mat;
      else o.visible = true;
    }
    this.swapped.length = 0;
    this.scene.background = this._savedBackground;
    this.scene.fog = this._savedFog;
  }

  render(time) {
    const r = this.renderer;
    this.camera.updateMatrixWorld();

    r.setRenderTarget(this.rt);
    if (this.thermal) {
      this._swapToThermal();
      r.render(this.scene, this.camera);
      this._restoreMaterials();
    } else {
      r.render(this.scene, this.camera);
    }
    r.setRenderTarget(null);

    const mat = this.quad.material;
    if (this.thermal) mat.uniforms.tHeat.value = this.rt.texture;
    else mat.uniforms.tColor.value = this.rt.texture;
    mat.uniforms.uTime.value = time;

    const H = this.viewport.clientHeight;
    const { x, y, w, h } = this.rect;
    r.setViewport(x, H - y - h, w, h);
    r.setScissor(x, H - y - h, w, h);
    r.setScissorTest(true);
    r.render(this.quadScene, this.quadCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.viewport.clientWidth, H);

    // HUD redessiné à 30 Hz (texte ombré coûteux en canvas 2D), suffisant à l'œil
    if (time - (this._hudTime ?? -1) >= 1 / 30 || time < this._hudTime) {
      this._hudTime = time;
      this.drawHUD(time);
    }
  }

  // ------------------------------------------------------------------ HUD

  _project(v) {
    const p = _p.copy(v).project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return { x: ((p.x + 1) / 2) * this.hud.width, y: ((1 - p.y) / 2) * this.hud.height };
  }

  drawHUD(time) {
    const ctx = this.ctx;
    const W = this.hud.width;
    const H = this.hud.height;
    const c = this.controller;
    const s = Math.max(0.75, Math.min(1.6, W / (520 * this.dpr))) * this.dpr; // échelle typographique
    const fs = (px) => `${Math.round(px * s)}px`;
    const face = `'Inter Variable', 'Inter', 'Segoe UI', sans-serif`;
    const pad = 14 * s;
    const white = 'rgba(240,245,250,0.92)';
    const dim = 'rgba(240,245,250,0.6)';

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 3 * s;
    ctx.textBaseline = 'middle';

    // REC + capteur
    ctx.font = `600 ${fs(11)} ${face}`;
    ctx.textAlign = 'left';
    const recOn = Math.floor(time * 1.6) % 2 === 0;
    ctx.fillStyle = recOn ? '#ff3b30' : 'rgba(255,59,48,0.25)';
    ctx.beginPath();
    ctx.arc(pad + 5 * s, pad + 6 * s, 4.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = white;
    ctx.fillText('REC', pad + 14 * s, pad + 6 * s);
    ctx.fillStyle = dim;
    const wide = W / this.dpr > 640;
    ctx.fillText(this.thermal ? (wide ? 'IR 640×512 · 30 Hz' : 'IR') : (wide ? 'RGB 4K · 30 fps' : 'RGB'), pad + 44 * s, pad + 6 * s);

    // Horodatage
    ctx.textAlign = 'right';
    ctx.fillStyle = white;
    ctx.fillText(wide ? formatDateTime() : formatClock(), W - pad, pad + 6 * s);
    const mt = c.missionTime;
    ctx.fillStyle = dim;
    ctx.fillText(`T+${String(Math.floor(mt / 60)).padStart(2, '0')}:${String(Math.floor(mt % 60)).padStart(2, '0')}`, W - pad, pad + 22 * s);

    this._drawHeadingTape(ctx, W, s, face, fs);

    // Réticule central
    const cx = W / 2;
    const cy = H / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.4 * s;
    const g = 6 * s;
    const L = 16 * s;
    ctx.beginPath();
    ctx.moveTo(cx - g - L, cy); ctx.lineTo(cx - g, cy);
    ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + L, cy);
    ctx.moveTo(cx, cy - g - L); ctx.lineTo(cx, cy - g);
    ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + L);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.6 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Télémétrie gauche
    const rowH = 17 * s;
    const leftY = H / 2 - rowH * 1.5;
    const line = (label, value, x, y, align) => {
      ctx.textAlign = align;
      ctx.font = `500 ${fs(9.5)} ${face}`;
      ctx.fillStyle = dim;
      const lw = ctx.measureText(label + ' ').width;
      if (align === 'left') {
        ctx.fillText(label, x, y);
        ctx.font = `600 ${fs(12)} ${face}`;
        ctx.fillStyle = white;
        ctx.fillText(value, x + lw, y);
      } else {
        ctx.font = `600 ${fs(12)} ${face}`;
        ctx.fillStyle = white;
        const vw = ctx.measureText(value).width;
        ctx.fillText(value, x, y);
        ctx.font = `500 ${fs(9.5)} ${face}`;
        ctx.fillStyle = dim;
        ctx.fillText(label, x - vw - 6 * s, y);
      }
    };
    line('ALT', `${c.altitude.toFixed(1)} m`, pad, leftY, 'left');
    line('SPD', `${c.speed.toFixed(1)} m/s`, pad, leftY + rowH, 'left');
    line('V/S', `${c.vel.y >= 0 ? '+' : ''}${c.vel.y.toFixed(1)} m/s`, pad, leftY + rowH * 2, 'left');
    line('GMB', `${Math.round(THREE.MathUtils.radToDeg(this.drone.gimbalPitch))}°`, pad, leftY + rowH * 3, 'left');

    // Mission droite
    const rx = W - pad - (this.thermal ? 34 * s : 0);
    const target = c.currentPanel ? c.currentPanel.id : '—';
    line('BAT', `${Math.round(c.battery)} %`, rx, leftY, 'right');
    line('MODE', c.mode === 'mission' ? 'AUTO' : c.mode === 'manual' ? 'MANUAL' : c.mode === 'pilot' ? 'PILOT' : '—', rx, leftY + rowH, 'right');
    line('TARGET', target, rx, leftY + rowH * 2, 'right');
    line('STATE', c.paused ? 'PAUSED' : c.state, rx, leftY + rowH * 3, 'right');

    // Position et bandeau d'état
    ctx.textAlign = 'left';
    ctx.font = `500 ${fs(10)} ${face}`;
    ctx.fillStyle = dim;
    ctx.fillText(`X ${c.pos.x.toFixed(1).padStart(6)}  Z ${c.pos.z.toFixed(1).padStart(6)}`, pad, H - pad - 4 * s);
    const status = c.paused ? 'PAUSED · HOLDING POSITION' : (STATE_LABELS[c.state] || c.state).toUpperCase();
    ctx.textAlign = 'center';
    ctx.font = `600 ${fs(11)} ${face}`;
    ctx.fillStyle = c.paused ? '#f5a623' : white;
    ctx.fillText(status, W / 2, H - pad - 4 * s);

    this._drawDetection(ctx, time, s, face, fs);
    if (this.thermal) this._drawThermalScale(ctx, W, H, s, face, fs);

    ctx.restore();
  }

  _drawHeadingTape(ctx, W, s, face, fs) {
    const heading = this.controller.heading;
    const tapeW = Math.min(W * (W / this.dpr > 640 ? 0.4 : 0.3), 340 * s);
    const x0 = W / 2 - tapeW / 2;
    const y = 16 * s;
    const pxPerDeg = tapeW / 90;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, tapeW, y + 30 * s);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2 * s;
    ctx.font = `600 ${fs(9.5)} ${face}`;
    ctx.textAlign = 'center';
    const start = Math.floor((heading - 50) / 5) * 5;
    for (let d = start; d <= heading + 50; d += 5) {
      const x = W / 2 + (d - heading) * pxPerDeg;
      const n = ((d % 360) + 360) % 360;
      const major = n % 15 === 0;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (major ? 8 : 4) * s);
      ctx.stroke();
      if (n % 45 === 0) {
        const card = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[n];
        ctx.fillText(card, x, y + 17 * s);
      } else if (major) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(String(n).padStart(3, '0'), x, y + 17 * s);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
      }
    }
    ctx.restore();
    // Index central et valeur
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${fs(10.5)} ${face}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${String(Math.round(heading) % 360).padStart(3, '0')}°`, W / 2, y + 29.5 * s);
    ctx.beginPath();
    ctx.moveTo(W / 2, y - 1 * s);
    ctx.lineTo(W / 2 - 4 * s, y - 7 * s);
    ctx.lineTo(W / 2 + 4 * s, y - 7 * s);
    ctx.closePath();
    ctx.fill();
  }

  _drawDetection(ctx, time, s, face, fs) {
    const c = this.controller;
    let panel = null;
    let mode = null;
    let type = c.inspectType;
    let leg = null;
    if (c.currentPanel && (c.state === 'POSITIONING' || c.state === 'SCANNING')) {
      panel = c.currentPanel;
      mode = c.state;
      leg = c.currentLeg;
    } else if (c.lastResult && c.time - c.lastResult.at < 2.2) {
      panel = c.lastResult.panel;
      mode = c.lastResult.status;
      type = c.lastResult.type;
      leg = c.lastResult.leg;
    }
    if (!panel) return;
    const struct = type === 'structure';
    const rec = struct ? panel.struct : panel;
    const W = this.hud.width;
    const H = this.hud.height;
    const blue = '#3ec4ff';

    // Cadre bleu : le panneau (modules) ou le pied examiné et sa fondation (structures).
    // Pendant le franchissement d'un panneau (structures), aucun cadre : étiquette seule.
    let box = null;
    const corners = struct ? (leg ? leg.corners : null) : panel.corners;
    if (corners) {
      const pts = corners.map((v) => this._project(v));
      if (pts.every(Boolean)) {
        let x0 = Math.min(...pts.map((p) => p.x));
        let x1 = Math.max(...pts.map((p) => p.x));
        let y0 = Math.min(...pts.map((p) => p.y));
        let y1 = Math.max(...pts.map((p) => p.y));
        if (!(x1 < 0 || y1 < 0 || x0 > W || y0 > H)) {
          const m = 6 * s;
          x0 = Math.max(x0 - m, 12 * s);
          x1 = Math.min(x1 + m, W - 12 * s);
          y0 = Math.max(y0 - m, 72 * s); // sous la bande de cap
          y1 = Math.min(y1 + m, H - 26 * s);
          box = { x0, x1, y0, y1 };
        }
      }
    }
    if (!box && !struct) return;
    if (box) {
      const { x0, x1, y0, y1 } = box;
      ctx.strokeStyle = blue;
      ctx.lineWidth = 2 * s;
      const cl = Math.min(22 * s, (x1 - x0) / 4, (y1 - y0) / 4);
      for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x, y + dy * cl);
        ctx.lineTo(x, y);
        ctx.lineTo(x + dx * cl, y);
        ctx.stroke();
      }
    }

    // Étiquette (texte seul, sans fond)
    const holding = mode === 'SCANNING' && c.holdRemaining > 0 && c.holdDefect;
    const id = leg ? `${panel.id} · ${leg.code}` : panel.id;
    let text;
    let color = blue;
    if (mode === 'POSITIONING') text = `${id}  STABILISING`;
    else if (holding) {
      text = `${id}  ${struct ? 'STRUCTURAL ANOMALY' : 'ANOMALY SPOTTED'} · EXAMINING ${Math.ceil(c.holdRemaining)} s`;
      color = Math.floor(time * 4) % 2 ? '#ffb020' : '#ff6b3d';
    } else if (mode === 'SCANNING') {
      text = `${panel.id}  ${struct ? 'STRUCTURE INSPECTION' : 'CLOSE-RANGE SCAN'} ${Math.round(c.scanProgress * 100)}%  ·  ${this._passLabel()}`;
    } else if (mode === 'ok') {
      text = `${panel.id}  ${struct ? 'STRUCTURE OK' : 'OK'}`;
      color = '#2fe07f';
    } else {
      text = `${panel.id}  DEFECT · ${rec.defect.label.toUpperCase()}`;
      color = '#ff4d4f';
    }
    if (!struct && this.thermal && (mode === 'SCANNING' || mode === 'defect' || mode === 'ok')) {
      const tmax = panel.defect ? heatToTemp(1.0) - (panel.defect.type === 'hotspot' ? 0 : 6) : heatToTemp(0.56);
      text += `  ·  Tmax ${tmax.toFixed(1)}°C`;
    }
    ctx.font = `700 ${fs(10.5)} ${face}`;
    ctx.textAlign = 'left';
    const tw = ctx.measureText(text).width;
    let lx = 12 * s;
    let ly = 88 * s;
    if (box) {
      // Au-dessus du cadre s'il reste de la place sous la bande de cap, sinon à l'intérieur
      ly = box.y0 - 12 * s;
      lx = Math.max(12 * s, Math.min(box.x0, W - tw - 12 * s));
      if (ly < 70 * s) {
        ly = box.y0 + 20 * s;
        lx = Math.max(12 * s, Math.min(box.x0 + 10 * s, W - tw - 12 * s));
      }
    }
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4 * s;
    ctx.fillStyle = color;
    ctx.fillText(text, lx, ly);
    if (mode === 'SCANNING') {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(lx, ly + 8 * s, tw, 2 * s);
      ctx.fillStyle = blue;
      ctx.fillRect(lx, ly + 8 * s, tw * c.scanProgress, 2 * s);
    }

    // Repère du défaut : dès qu'il entre dans le champ pendant l'analyse, puis au résultat
    // (structures : seulement quand la caméra vise le pied concerné)
    const defect = rec.defect;
    const showDefect = defect && (mode === 'defect' || (mode === 'SCANNING' && (!struct || leg === defect.leg)));
    if (showDefect) {
      const p = this._project(defect.position);
      if (p && p.x > 0 && p.x < W && p.y > 0 && p.y < H) {
        const r = (10 + 2 * Math.sin(time * 8)) * s;
        ctx.strokeStyle = '#ff3b30';
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x + r * 0.7, p.y - r * 0.7);
        ctx.lineTo(p.x + r * 1.8, p.y - r * 1.8);
        ctx.lineTo(p.x + r * 1.8 + 8 * s, p.y - r * 1.8);
        ctx.stroke();
        ctx.font = `700 ${fs(9.5)} ${face}`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 3 * s;
        let tag;
        if (struct) tag = { corrosion: 'CORROSION', deformation: 'BENT', fissure: 'CRACK' }[defect.type];
        else tag = `ΔT +${(heatToTemp(defect.type === 'hotspot' ? 1.0 : 0.92) - heatToTemp(0.52)).toFixed(0)}°C`;
        ctx.fillText(tag, p.x + r * 1.8 + 11 * s, p.y - r * 1.8);
      }
    }
  }

  // Nom de la portion de trajectoire en cours
  _passLabel() {
    const c = this.controller;
    const kind = c.scanKinds[c.scanIndex];
    if (kind === 'leg') return `LEG ${c.scanLegs[c.scanIndex].code}`;
    if (kind === 'climb' || kind === 'cross') return 'CROSSING THE PANEL';
    return { top: 'UPPER PASS', side: 'SIDE', bottom: 'LOWER PASS', defect: 'TO THE DEFECT' }[kind] || 'LOWER PASS';
  }

  _drawThermalScale(ctx, W, H, s, face, fs) {
    const bw = 9 * s;
    const bh = H * 0.42;
    const x = W - 22 * s;
    const y = H / 2 - bh / 2;
    const g = ctx.createLinearGradient(0, y + bh, 0, y);
    const stops = [
      [0, '#05051a'], [0.2, '#0f299a'], [0.45, '#1a99db'], [0.65, '#fae638'], [0.8, '#ff850f'], [0.95, '#eb140d'], [1, '#ffeee6'],
    ];
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.shadowBlur = 0;
    ctx.fillStyle = g;
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1 * s;
    ctx.strokeRect(x, y, bw, bh);
    ctx.font = `600 ${fs(9)} ${face}`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.shadowBlur = 3 * s;
    ctx.fillText(`${heatToTemp(THERMAL_MAX).toFixed(0)}°`, x + bw, y - 9 * s);
    ctx.fillText(`${heatToTemp(THERMAL_MIN).toFixed(0)}°`, x + bw, y + bh + 9 * s);
  }
}

const _p = new THREE.Vector3();
