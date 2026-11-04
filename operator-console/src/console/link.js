// Liaison WebSocket console ↔ serveur d'exploitation.
//  - messages JSON : hello, status (5 Hz), scada (1 Hz), alert, workorder, log, settings, ack ;
//  - messages binaires : images JPEG du retour vidéo ;
//  - command() renvoie une promesse résolue par l'acquittement ;
//  - sendSticks() : consignes de pilotage, sans acquittement.

export class Link extends EventTarget {
  constructor(path = '/console-ws') {
    super();
    this.path = path;
    this.ws = null;
    this.state = 'connecting';
    this.retry = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.ws) this.connect();
    });
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    } catch {
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'blob';
    this.ws = ws;
    this._setState('connecting');
    ws.addEventListener('open', () => {
      this.retry = 0;
      this._setState('on');
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        this.dispatchEvent(new CustomEvent('frame', { detail: ev.data }));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'ack') {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        return;
      }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'Connection to the server lost' });
        this.pending.delete(id);
      }
      this._setState('off');
      this._scheduleReconnect();
    });
    ws.addEventListener('error', () => {});
  }

  _setState(s) {
    this.state = s;
    this.dispatchEvent(new CustomEvent('link', { detail: s }));
  }

  _scheduleReconnect() {
    const delay = Math.min(10000, 800 * 2 ** this.retry);
    this.retry = Math.min(this.retry + 1, 4);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  command(action, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: 'Server unreachable: reconnecting' });
    }
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ type: 'cmd', id, action, params }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'No answer from the server (timed out)' });
      }, 6000);
      this.pending.set(id, { resolve, timer });
    });
  }

  sendSticks(s) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 64_000) {
      this.ws.send(JSON.stringify({ type: 'sticks', ...s }));
    }
  }
}
