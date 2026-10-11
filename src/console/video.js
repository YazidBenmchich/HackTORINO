// Retour vidéo du drone : les images JPEG reçues sont décodées une fois (ImageBitmap)
// puis dessinées dans chaque canvas visible, ajustées sans déformation.

export class VideoFeed {
  constructor(link) {
    this.boxes = new Set();
    this.frame = null;
    this.lastAt = 0;
    this.times = [];
    this.decoding = false;
    this.queued = null;
    link.addEventListener('frame', (ev) => this._receive(ev.detail));
  }

  attach(box) {
    const canvas = box.querySelector('canvas');
    const entry = { box, canvas, ctx: canvas.getContext('2d') };
    this.boxes.add(entry);
    new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(2, Math.round(r.width * dpr));
      canvas.height = Math.max(2, Math.round(r.height * dpr));
      this._paint(entry);
    }).observe(canvas);
  }

  async _receive(blob) {
    if (this.decoding) {
      this.queued = blob; // on ne garde que la plus récente
      return;
    }
    this.decoding = true;
    try {
      const bmp = await createImageBitmap(blob);
      this.frame?.close?.();
      this.frame = bmp;
      this.lastAt = performance.now();
      this.times.push(this.lastAt);
      while (this.times.length && this.lastAt - this.times[0] > 2000) this.times.shift();
      for (const e of this.boxes) this._paint(e);
    } catch {
      // image corrompue : ignorée
    } finally {
      this.decoding = false;
      if (this.queued) {
        const next = this.queued;
        this.queued = null;
        this._receive(next);
      }
    }
  }

  _paint({ canvas, ctx }) {
    if (!this.frame || !canvas.offsetParent) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const fw = this.frame.width;
    const fh = this.frame.height;
    const s = Math.min(cw / fw, ch / fh);
    const w = fw * s;
    const h = fh * s;
    ctx.fillStyle = '#050608'; // --video-bg
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(this.frame, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  repaintAll() {
    for (const e of this.boxes) this._paint(e);
  }

  get fps() {
    return this.times.length > 1 ? (this.times.length - 1) / ((this.times[this.times.length - 1] - this.times[0]) / 1000) : 0;
  }

  get stale() {
    return !this.frame || performance.now() - this.lastAt > 2500;
  }
}
