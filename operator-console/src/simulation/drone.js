import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../shared/config.js';
import { LAYERS } from './scene.js';
import { clamp, damp, smoothstep } from '../shared/utils.js';

// Modèle procédural d'un quadricoptère d'inspection (≈ 0,9 m d'envergure)
// et toute son animation « visuelle » : la trajectoire est fournie par droneController.

const BODY_Y = 0.3;          // centre du corps au-dessus du bas des patins
const ARM_REACH = 0.31;      // position des moteurs (x et z)
const PROP_RADIUS = 0.24;
const MAX_ROTOR_RAD_S = 150; // vitesse angulaire visuelle à plein régime

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function propDiscTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.15)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function bladeGeometry() {
  // Pale effilée et légèrement vrillée
  const s = new THREE.Shape();
  s.moveTo(0.012, -0.012);
  s.bezierCurveTo(0.08, -0.022, 0.17, -0.018, PROP_RADIUS, -0.006);
  s.quadraticCurveTo(PROP_RADIUS + 0.006, 0.002, PROP_RADIUS - 0.004, 0.008);
  s.bezierCurveTo(0.17, 0.014, 0.08, 0.016, 0.012, 0.01);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.rotateX(THREE.MathUtils.degToRad(9)); // calage
  return geo;
}

export class Drone {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'drone';
    this.bob = new THREE.Group();
    this.tilt = new THREE.Group();
    this.tilt.position.y = BODY_Y;
    this.root.add(this.bob);
    this.bob.add(this.tilt);
    scene.add(this.root);

    this.pitch = 0; this.pitchVel = 0;
    this.roll = 0; this.rollVel = 0;
    this.rotor = 0;
    this.rotorAngle = 0;
    this.gimbalPitch = THREE.MathUtils.degToRad(CONFIG.camera.gimbalRestPitch);
    this.ledTime = 0;
    this.phase = Math.random() * 10;

    this._build();
    this._buildGimbal();
    this._buildScanCone();

    // Le drone n'est visible que dans la vue principale (la caméra embarquée ne se voit pas elle-même)
    this.root.traverse((o) => {
      if (o.isMesh || o.isSprite || o.isLineSegments) o.layers.set(LAYERS.MAIN_ONLY);
    });
  }

  _build() {
    const shell = new THREE.MeshPhysicalMaterial({ color: 0x2b2f36, roughness: 0.42, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.3 });
    const shellLight = new THREE.MeshPhysicalMaterial({ color: 0x4a505a, roughness: 0.5, clearcoat: 0.4 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.35, metalness: 0.4 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x9da4ad, roughness: 0.25, metalness: 0.95 });
    const white = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.4 });
    const black = new THREE.MeshPhysicalMaterial({ color: 0x050608, roughness: 0.1, clearcoat: 1 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xf28c28, roughness: 0.5 });
    const add = (geo, mat, x, y, z, parent = this.tilt) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // Corps central + capot + batteries
    add(new RoundedBoxGeometry(0.3, 0.1, 0.42, 4, 0.04), shell, 0, 0, 0);
    add(new RoundedBoxGeometry(0.22, 0.05, 0.3, 3, 0.02), shellLight, 0, 0.065, 0.02);
    add(new RoundedBoxGeometry(0.09, 0.05, 0.2, 3, 0.015), white, -0.055, 0.105, 0.04);
    add(new RoundedBoxGeometry(0.09, 0.05, 0.2, 3, 0.015), white, 0.055, 0.105, 0.04);
    add(new THREE.CylinderGeometry(0.035, 0.04, 0.025, 24), white, 0, 0.1, -0.13); // GPS
    add(new RoundedBoxGeometry(0.2, 0.035, 0.03, 2, 0.01), black, 0, 0.005, -0.215); // capteurs avant
    add(new RoundedBoxGeometry(0.2, 0.035, 0.03, 2, 0.01), black, 0, 0.005, 0.215);
    add(new THREE.BoxGeometry(0.31, 0.012, 0.06), accent, 0, 0.02, -0.17);

    // Bras, moteurs, hélices, LED
    const armGeo = new THREE.CylinderGeometry(0.018, 0.022, 1, 12);
    armGeo.rotateZ(Math.PI / 2);
    const motorGeo = new THREE.CylinderGeometry(0.036, 0.04, 0.05, 20);
    const bellGeo = new THREE.CylinderGeometry(0.033, 0.035, 0.022, 20);
    const hubGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.018, 12);
    const bladeGeo = bladeGeometry();
    const discGeo = new THREE.CircleGeometry(PROP_RADIUS + 0.01, 48);
    discGeo.rotateX(-Math.PI / 2);

    this.bladeMat = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.5, transparent: true });
    this.discMat = new THREE.MeshBasicMaterial({
      color: 0x15171a, alphaMap: propDiscTexture(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const glow = glowTexture();
    this.leds = [];
    this.props = [];

    const motors = [
      { x: -ARM_REACH, z: -ARM_REACH, dir: 1, color: 0xff2a2a },  // avant gauche
      { x: ARM_REACH, z: -ARM_REACH, dir: -1, color: 0x22ff55 },  // avant droit
      { x: ARM_REACH, z: ARM_REACH, dir: 1, color: 0x22ff55 },    // arrière droit
      { x: -ARM_REACH, z: ARM_REACH, dir: -1, color: 0xff2a2a },  // arrière gauche
    ];
    for (const mDef of motors) {
      const len = Math.hypot(mDef.x, mDef.z) - 0.1;
      const arm = add(armGeo, carbon, mDef.x * 0.55, 0.0, mDef.z * 0.55);
      arm.scale.x = len;
      arm.rotation.y = -Math.atan2(mDef.z, mDef.x);
      // Pied d'articulation du bras
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 14), carbon, mDef.x * 0.32, 0, mDef.z * 0.32);

      add(motorGeo, carbon, mDef.x, 0.02, mDef.z);
      add(bellGeo, metal, mDef.x, 0.055, mDef.z);

      const prop = new THREE.Group();
      prop.position.set(mDef.x, 0.075, mDef.z);
      prop.userData.dir = mDef.dir;
      const hub = new THREE.Mesh(hubGeo, metal);
      prop.add(hub);
      for (let k = 0; k < 2; k++) {
        const blade = new THREE.Mesh(bladeGeo, this.bladeMat);
        blade.rotation.y = k * Math.PI;
        if (mDef.dir < 0) blade.scale.z = -1;
        blade.castShadow = true;
        prop.add(blade);
      }
      const disc = new THREE.Mesh(discGeo, this.discMat);
      disc.position.y = 0.004;
      disc.renderOrder = 4;
      prop.add(disc);
      prop.rotation.y = Math.random() * Math.PI;
      this.tilt.add(prop);
      this.props.push(prop);

      // LED sous le moteur
      const ledMat = new THREE.MeshBasicMaterial({ color: mDef.color, toneMapped: false });
      const led = add(new THREE.SphereGeometry(0.012, 10, 8), ledMat, mDef.x, -0.012, mDef.z);
      led.castShadow = false;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, color: mDef.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      halo.scale.setScalar(0.16);
      halo.position.copy(led.position);
      this.tilt.add(halo);
      this.leds.push({ mat: ledMat, halo, base: new THREE.Color(mDef.color) });
    }

    // Feu anticollision blanc sur le dessus
    const strobeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    add(new THREE.SphereGeometry(0.01, 8, 6), strobeMat, 0, 0.135, 0.12).castShadow = false;
    this.strobe = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.strobe.position.set(0, 0.135, 0.12);
    this.strobe.scale.setScalar(0.3);
    this.tilt.add(this.strobe);
    this.strobeMat = strobeMat;

    // Train d'atterrissage (patins)
    const gearMat = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.4, metalness: 0.5 });
    const strutLen = BODY_Y - 0.05;
    const strutGeo = new THREE.CylinderGeometry(0.009, 0.011, strutLen / Math.cos(0.32), 10);
    const skidGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.44, 12);
    skidGeo.rotateX(Math.PI / 2);
    const footGeo = new THREE.SphereGeometry(0.014, 10, 8);
    for (const side of [-1, 1]) {
      for (const fz of [-0.11, 0.11]) {
        const strut = add(strutGeo, gearMat, side * 0.135, -BODY_Y + 0.012 + strutLen / 2, fz);
        strut.rotation.z = side * 0.32;
      }
      add(skidGeo, gearMat, side * 0.175, -BODY_Y + 0.012, 0);
      add(footGeo, gearMat, side * 0.175, -BODY_Y + 0.012, -0.22);
      add(footGeo, gearMat, side * 0.175, -BODY_Y + 0.012, 0.22);
    }
  }

  _buildGimbal() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2227, roughness: 0.45, metalness: 0.4 });
    const housing = new THREE.MeshPhysicalMaterial({ color: 0x30343b, roughness: 0.35, clearcoat: 0.6 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.02, metalness: 0.2, clearcoat: 1 });
    const ring = new THREE.MeshStandardMaterial({ color: 0x8b929b, metalness: 0.9, roughness: 0.3 });

    const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 16), dark);
    mount.position.set(0, -0.065, -0.14);
    mount.castShadow = true;
    this.tilt.add(mount);

    // Le gimbal (lacet) est stabilisé en orientation monde
    this.gimbal = new THREE.Group();
    this.gimbal.position.set(0, -0.085, -0.14);
    this.tilt.add(this.gimbal);

    const yokeTop = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.014, 0.03), dark);
    const yokeL = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.03), dark);
    const yokeR = yokeL.clone();
    yokeL.position.set(-0.062, -0.035, 0);
    yokeR.position.set(0.062, -0.035, 0);
    this.gimbal.add(yokeTop, yokeL, yokeR);

    this.head = new THREE.Group();
    this.head.position.y = -0.055;
    this.gimbal.add(this.head);
    const box = new THREE.Mesh(new RoundedBoxGeometry(0.105, 0.075, 0.085, 3, 0.018), housing);
    box.castShadow = true;
    this.head.add(box);
    const lensGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 24);
    lensGeo.rotateX(Math.PI / 2);
    const lens = new THREE.Mesh(lensGeo, glass);
    lens.position.set(-0.022, 0.006, -0.046);
    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.023, 0.003, 8, 24), ring);
    lensRing.position.copy(lens.position);
    const ir = new THREE.Mesh(lensGeo, glass);
    ir.scale.setScalar(0.62);
    ir.position.set(0.026, 0.008, -0.046);
    const irRing = new THREE.Mesh(new THREE.TorusGeometry(0.015, 0.003, 8, 20), ring);
    irRing.position.copy(ir.position);
    this.head.add(lens, lensRing, ir, irRing);

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.feedFov, 16 / 9, 0.05, 600);
    this.camera.position.set(-0.022, 0.006, -0.06);
    this.head.add(this.camera);
  }

  _buildScanCone() {
    // Pyramide unitaire (base ±1 à z = -1), mise à l'échelle du champ réel de la caméra
    const tanV = 1;
    const tanH = 1;
    const v = [
      0, 0, 0,
      -tanH, -tanV, -1, tanH, -tanV, -1, tanH, tanV, -1, -tanH, tanV, -1,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x3ec4ff, transparent: true, opacity: 0.09, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, -tanH, -tanV, -1, 0, 0, 0, tanH, -tanV, -1, 0, 0, 0, tanH, tanV, -1, 0, 0, 0, -tanH, tanV, -1,
      -tanH, -tanV, -1, tanH, -tanV, -1, tanH, -tanV, -1, tanH, tanV, -1,
      tanH, tanV, -1, -tanH, tanV, -1, -tanH, tanV, -1, -tanH, -tanV, -1,
    ], 3));
    this.coneEdgeMat = new THREE.LineBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    this.scanCone = new THREE.Group();
    this.scanCone.add(new THREE.Mesh(geo, coneMat), new THREE.LineSegments(edges, this.coneEdgeMat));
    this.scanCone.position.copy(this.camera.position);
    this.scanCone.visible = false;
    this.scanCone.renderOrder = 5;
    this.coneMat = coneMat;
    this.head.add(this.scanCone);
  }

  setScanCone(visible, distance = 2.5) {
    this.scanCone.visible = visible;
    if (visible) {
      const d = Math.max(0.1, distance);
      const { tanH, tanV } = this.fovTangents();
      this.scanCone.scale.set(d * tanH, d * tanV, d);
    }
  }

  // Demi-ouvertures (tangentes) horizontale et verticale de la caméra embarquée
  fovTangents() {
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return { tanH: tanV * this.camera.aspect, tanV };
  }

  // Position de la caméra par rapport à l'origine du drone (bas des patins),
  // drone à plat, cap nord, pour une inclinaison de gimbal donnée.
  cameraOffset(pitch) {
    const local = this.camera.position.clone().applyAxisAngle(_xAxis, pitch);
    return local.add(this.head.position).add(this.gimbal.position).add(this.tilt.position);
  }

  /**
   * @param {number} dt
   * @param {object} s  état cinématique fourni par le contrôleur :
   *   position, velocity, accel (Vector3 monde), yaw (rad), rotor (0..1),
   *   gimbalPitch (rad), airborne (0..1), time (s)
   */
  update(dt, s) {
    const D = CONFIG.drone;
    this.root.position.copy(s.position);
    this.root.rotation.y = s.yaw;

    // Accélération et vitesse exprimées dans le repère du drone (avant = -Z)
    const c = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    const toLocal = (v) => ({ x: v.x * c - v.z * sn, z: v.x * sn + v.z * c });
    const a = toLocal(s.accel);
    const v = toLocal(s.velocity);
    const maxTilt = THREE.MathUtils.degToRad(D.maxTiltDeg);
    const kA = THREE.MathUtils.degToRad(D.tiltPerAccel);
    const kV = THREE.MathUtils.degToRad(D.tiltPerSpeed);
    const targetPitch = clamp(kA * a.z + kV * v.z, -maxTilt, maxTilt) * s.airborne;
    const targetRoll = clamp(-(kA * a.x + kV * v.x), -maxTilt, maxTilt) * s.airborne;

    // Ressort amorti : retour progressif à l'horizontale, légère inertie
    const w = 7.5;
    const zeta = 0.82;
    const h = Math.min(dt, 1 / 30);
    this.pitchVel += (w * w * (targetPitch - this.pitch) - 2 * zeta * w * this.pitchVel) * h;
    this.pitch += this.pitchVel * h;
    this.rollVel += (w * w * (targetRoll - this.roll) - 2 * zeta * w * this.rollVel) * h;
    this.roll += this.rollVel * h;

    // Flottement en vol stationnaire
    const t = s.time + this.phase;
    const hover = s.airborne;
    this.bob.position.y = hover * D.hoverBob * (Math.sin(t * 1.25) + 0.45 * Math.sin(t * 2.3 + 1.7));
    this.bob.position.x = hover * D.hoverBob * 0.5 * Math.sin(t * 0.8 + 0.4);
    this.tilt.rotation.x = this.pitch + hover * 0.012 * Math.sin(t * 1.7 + 0.3);
    this.tilt.rotation.z = this.roll + hover * 0.012 * Math.sin(t * 1.3 + 2.1);

    // Hélices
    this.rotor += (s.rotor - this.rotor) * damp(s.rotor > this.rotor ? 2.2 : 1.2, dt);
    const spin = this.rotor * MAX_ROTOR_RAD_S * dt;
    for (const p of this.props) p.rotation.y += spin * p.userData.dir;
    const blur = smoothstep(0.12, 0.55, this.rotor);
    this.bladeMat.opacity = 1 - blur * 0.88;
    this.bladeMat.depthWrite = blur < 0.5;
    this.discMat.opacity = blur * 0.75;

    // LED : double éclat périodique, plus lent au sol
    this.ledTime += dt;
    const period = s.airborne > 0.5 ? 1.1 : 2.0;
    const ph = this.ledTime % period;
    const on = ph < 0.08 || (ph > 0.18 && ph < 0.26);
    for (const led of this.leds) {
      led.mat.color.copy(led.base).multiplyScalar(on ? 1.6 : 0.18);
      led.halo.material.opacity = on ? 0.95 : 0;
    }
    const strobeOn = (this.ledTime % 1.6) < 0.05 && this.rotor > 0.05;
    this.strobeMat.color.setScalar(strobeOn ? 3 : 0.3);
    this.strobe.material.opacity = strobeOn ? 1 : 0;

    // Gimbal stabilisé : orientation monde indépendante du tangage/roulis du corps
    this.gimbalPitch += (s.gimbalPitch - this.gimbalPitch) * damp(3, dt);
    this.root.updateMatrixWorld(true);
    const parentQ = this.tilt.getWorldQuaternion(_q1);
    const wanted = _q2.setFromEuler(_e.set(0, s.yaw, 0, 'YXZ'));
    this.gimbal.quaternion.copy(parentQ.invert().multiply(wanted));
    this.head.rotation.x = this.gimbalPitch;
    this.gimbal.updateMatrixWorld(true);

    if (this.scanCone.visible) {
      this.coneMat.opacity = 0.07 + 0.03 * Math.sin(s.time * 9);
    }
  }
}

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _xAxis = new THREE.Vector3(1, 0, 0);
