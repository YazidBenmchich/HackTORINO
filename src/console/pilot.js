// Entrées de pilotage manuel : clavier (touches physiques, AZERTY comme QWERTY),
// manches virtuels à l'écran (souris, tactile) et manette (API Gamepad, mode 2).
// Les consignes sont envoyées à 20 Hz tant que le pilotage est actif.

const KEYS = {
  KeyW: ['fwd', 1], KeyS: ['fwd', -1],          // Z / S en AZERTY
  KeyA: ['right', -1], KeyD: ['right', 1],      // Q / D en AZERTY
  ArrowUp: ['up', 1], ArrowDown: ['up', -1],
  ArrowLeft: ['yaw', -1], ArrowRight: ['yaw', 1],
};
const DEAD_ZONE = 0.12;

export class PilotInput {
  constructor({ link, sticksEl, gamepadEl, onActivity }) {
    this.link = link;
    this.gamepadEl = gamepadEl;
    this.onActivity = onActivity;
    this.active = false;
    this.keys = new Set();
    this.virtual = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    this.gamepad = null;

    window.addEventListener('keydown', (ev) => {
      if (!this.active || !KEYS[ev.code] || this._typing(ev)) return;
      ev.preventDefault();
      this.keys.add(ev.code);
    });
    window.addEventListener('keyup', (ev) => this.keys.delete(ev.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (ev) => this._gamepadLabel(ev.gamepad));
    window.addEventListener('gamepaddisconnected', () => this._gamepadLabel(null));

    for (const stick of sticksEl.querySelectorAll('.stick')) this._bindStick(stick);
  }

  _typing(ev) {
    const t = ev.target;
    return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox';
  }

  _gamepadLabel(gp) {
    if (this.gamepadEl) this.gamepadEl.textContent = gp ? `Gamepad: ${gp.id.split('(')[0].trim().slice(0, 28)}` : 'Gamepad: not detected';
  }

  _bindStick(stick) {
    const side = stick.dataset.stick;
    const knob = stick.querySelector('.knob');
    let pid = null;
    const set = (ev) => {
      const r = stick.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (ev.clientX - (r.left + R)) / (R * 0.72);
      let dy = (ev.clientY - (r.top + R)) / (R * 0.72);
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      this.virtual[side] = { x: dx, y: -dy };
      knob.style.transform = `translate(${dx * R * 0.72}px, ${dy * R * 0.72}px)`;
    };
    const release = () => {
      pid = null;
      this.virtual[side] = { x: 0, y: 0 };
      knob.style.transform = '';
      stick.classList.remove('held');
    };
    stick.addEventListener('pointerdown', (ev) => {
      if (!this.active) return;
      pid = ev.pointerId;
      stick.setPointerCapture(pid);
      stick.classList.add('held');
      set(ev);
    });
    stick.addEventListener('pointermove', (ev) => {
      if (ev.pointerId === pid) set(ev);
    });
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.keys.clear();
    clearInterval(this.timer);
    if (on) this.timer = setInterval(() => this._send(), 50);
  }

  _readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) return null;
    const ax = (i) => {
      const v = gp.axes[i] || 0;
      return Math.abs(v) < DEAD_ZONE ? 0 : v;
    };
    // Mode 2 : gauche = altitude (Y) / rotation (X), droit = avant (Y) / latéral (X)
    return { fwd: -ax(3), right: ax(2), up: -ax(1), yaw: ax(0) };
  }

  _send() {
    const s = { fwd: 0, right: 0, up: 0, yaw: 0 };
    for (const code of this.keys) {
      const [k, v] = KEYS[code];
      s[k] += v;
    }
    s.yaw += this.virtual.left.x;
    s.up += this.virtual.left.y;
    s.right += this.virtual.right.x;
    s.fwd += this.virtual.right.y;
    const gp = this._readGamepad();
    if (gp) for (const k of Object.keys(s)) s[k] += gp[k];
    for (const k of Object.keys(s)) s[k] = Math.max(-1, Math.min(1, Math.round(s[k] * 100) / 100));
    this.link.sendSticks(s);
    this.onActivity?.(s);
  }
}
