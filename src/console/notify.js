// Notifications de l'opérateur : bandeaux à l'écran, signal sonore (Web Audio),
// notifications système quand l'onglet n'est pas au premier plan, compteur dans le titre.

import { icon } from './icons.js';

export class Notifier {
  constructor({ host, soundBtn, notifyBtn }) {
    this.host = host;
    this.soundBtn = soundBtn;
    this.notifyBtn = notifyBtn;
    this.sound = read('helio.sound', '1') === '1';
    this.audio = null;
    this.baseTitle = document.title;
    this._renderSound();
    this._renderNotify();
    soundBtn.addEventListener('click', () => {
      this.sound = !this.sound;
      write('helio.sound', this.sound ? '1' : '0');
      this._renderSound();
      if (this.sound) this.chime('info');
    });
    notifyBtn.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      this._renderNotify();
      if (Notification.permission === 'granted') this.toast({ level: 'info', title: 'Notifications on', text: 'Alerts will also show up when the console is in the background.' });
    });
    // Le contexte audio ne démarre qu'après un geste de l'opérateur
    window.addEventListener('pointerdown', () => this._audio(), { once: true });
  }

  _renderSound() {
    this.soundBtn.setAttribute('aria-pressed', String(this.sound));
    this.soundBtn.innerHTML = icon(this.sound ? 'sound' : 'mute');
    this.soundBtn.title = this.sound ? 'Alert sound: on' : 'Alert sound: off';
  }

  _renderNotify() {
    const p = 'Notification' in window ? Notification.permission : 'unsupported';
    this.notifyBtn.dataset.state = p;
    this.notifyBtn.title = p === 'granted' ? 'Browser notifications: on'
      : p === 'denied' ? 'Browser notifications: blocked (browser settings)'
        : p === 'unsupported' ? 'Notifications not supported' : 'Enable browser notifications';
  }

  _audio() {
    if (!this.audio) {
      try {
        this.audio = new AudioContext();
      } catch {
        this.audio = null;
      }
    }
    return this.audio;
  }

  // Deux notes pour une alerte, trois pour une critique, une note brève pour une info
  chime(level) {
    if (!this.sound) return;
    const ctx = this._audio();
    if (!ctx || ctx.state === 'suspended') return;
    const notes = level === 'critical' ? [880, 660, 880] : level === 'warn' ? [740, 988] : [988];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.16;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  }

  // level : info | ok | warn | critical | drone
  toast({ level = 'info', title, text, actions = [], timeout, sound = false, system = false }) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.dataset.level = level;
    t.setAttribute('role', level === 'critical' ? 'alert' : 'status');
    t.innerHTML = `<span class="toast-mark" aria-hidden="true"></span><div class="toast-body"><b></b><p></p><div class="toast-actions"></div></div><button class="toast-x" aria-label="Close">${icon('close')}</button>`;
    t.querySelector('b').textContent = title;
    t.querySelector('p').textContent = text || '';
    const bar = t.querySelector('.toast-actions');
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn small ${a.primary ? 'primary' : 'ghost'}`;
      b.textContent = a.label;
      b.addEventListener('click', () => {
        a.run();
        close();
      });
      bar.appendChild(b);
    }
    const close = () => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    };
    t.querySelector('.toast-x').addEventListener('click', close);
    this.host.append(t);
    while (this.host.children.length > 4) this.host.firstElementChild.remove();
    const ms = timeout ?? (level === 'critical' ? 14000 : level === 'warn' ? 10000 : 6000);
    if (ms) setTimeout(close, ms);
    if (sound) this.chime(level);
    if (system && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`HelioScan — ${title}`, { body: text || '', tag: title, silent: !this.sound });
      n.onclick = () => {
        window.focus();
        actions[0]?.run();
        n.close();
      };
    }
    return t;
  }

  setCount(n) {
    document.title = n > 0 ? `(${n}) ${this.baseTitle}` : this.baseTitle;
  }
}

function read(k, d) {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
}

function write(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // stockage indisponible : préférence non conservée
  }
}

export { read as readPref, write as writePref };
