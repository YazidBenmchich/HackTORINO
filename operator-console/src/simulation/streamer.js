import * as THREE from 'three';

// Retour vidéo vers la console opérateur, sans bloquer le rendu de la simulation :
//  1. l'image du drone (déjà composée par CameraFeed) est redessinée dans une petite cible
//     hors écran, sans le HUD de la page (la console affiche sa propre instrumentation) ;
//  2. ses pixels sont lus de façon asynchrone (tampon PBO + fence WebGL 2) : pas d'attente du GPU ;
//  3. l'encodage JPEG se fait dans un Web Worker (OffscreenCanvas), hors du fil principal ;
//  4. l'image part en binaire sur la WebSocket.
// Onglet masqué : la lecture asynchrone attend des minuteries bridées par le navigateur ;
// on lit alors la petite image de façon synchrone (≈ 1 ms), l'encodage reste dans le Worker.
// Sans OffscreenCanvas : copie du canvas et encodage sur le fil principal, à cadence réduite.

const WORKER_SRC = `
let canvas = null;
self.onmessage = async (e) => {
  const { buf, w, h, q } = e.data;
  try {
    const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(buf), w, h), { imageOrientation: 'flipY' });
    if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    const out = await blob.arrayBuffer();
    self.postMessage(out, [out]);
  } catch {
    self.postMessage(null);
  }
};`;

export class FeedStreamer {
  constructor({ renderer, feed, network, fps = 20, maxWidth = 1024, quality = 0.7 }) {
    this.renderer = renderer;
    this.feed = feed;
    this.network = network;
    this.fps = fps;
    this.maxWidth = maxWidth;
    this.quality = quality;
    this.active = false;
    this.busy = false;     // copie synchrone en cours (sans Worker)
    this.inflight = 0;     // images en cours d'encodage dans le Worker (2 au plus)
    this.last = -Infinity;
    // Copie synchrone (onglet masqué, ou navigateur sans OffscreenCanvas)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.rt = null;
    this.worker = null;
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && renderer.getContext() instanceof WebGL2RenderingContext;
    if (gl2 && typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype) {
      try {
        this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
        this.worker.onmessage = (e) => {
          this.inflight = Math.max(0, this.inflight - 1);
          if (e.data) this.network.sendFrame(e.data);
        };
      } catch {
        this.worker = null;
      }
    }
  }

  setActive(on, { fps, maxWidth, quality } = {}) {
    this.active = on;
    if (Number.isFinite(fps)) this.fps = Math.min(30, Math.max(2, fps));
    if (Number.isFinite(maxWidth)) this.maxWidth = Math.min(1280, Math.max(320, maxWidth));
    if (Number.isFinite(quality)) this.quality = Math.min(0.92, Math.max(0.4, quality));
  }

  capture(time) {
    if (!this.active || this.busy || this.inflight >= 2) return;
    const fps = this.worker ? this.fps : Math.min(this.fps, 10);
    // Tolérance : sans elle, la gigue des images fait sauter une capture sur deux
    if (time - this.last < 1 / fps - 0.012) return;
    this.last = time;
    if (this.worker) this._captureTarget(document.hidden);
    else this._captureSync();
  }

  // Taille envoyée : celle de l'incrustation en pixels réels, plafonnée (dimensions paires)
  _size() {
    const r = this.feed.rect;
    const dpr = this.renderer.getPixelRatio();
    const w = Math.round(Math.min(this.maxWidth, Math.max(480, r.w * dpr)) / 2) * 2;
    const h = Math.round((w * r.h) / r.w / 2) * 2;
    return { w, h };
  }

  _captureTarget(sync) {
    const { w, h } = this._size();
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
      this.rt.texture.colorSpace = THREE.SRGBColorSpace; // même conversion de sortie que le canvas
      this.buf = new Uint8Array(w * h * 4);
    }
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    r.render(this.feed.quadScene, this.feed.quadCam);
    r.setRenderTarget(prev);
    this.inflight++;
    const buf = this.buf;
    const post = () => {
      const copy = buf.slice().buffer;
      this.worker.postMessage({ buf: copy, w, h, q: this.quality }, [copy]);
    };
    if (sync) {
      r.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
      post();
    } else {
      // Tampon propre à cette lecture : deux lectures peuvent se chevaucher
      const own = new Uint8Array(buf.length);
      r.readRenderTargetPixelsAsync(this.rt, 0, 0, w, h, own).then(() => {
        this.worker.postMessage({ buf: own.buffer, w, h, q: this.quality }, [own.buffer]);
      }, () => {
        this.inflight = Math.max(0, this.inflight - 1);
      });
    }
  }

  // Copie du canvas WebGL : doit suivre le rendu dans la même image (pas de preserveDrawingBuffer)
  _captureSync() {
    const src = this.renderer.domElement;
    const dpr = this.renderer.getPixelRatio();
    const r = this.feed.rect;
    const sw = r.w * dpr;
    const sh = r.h * dpr;
    if (sw < 2 || sh < 2) return;
    const w = Math.round(Math.min(this.maxWidth, sw));
    const h = Math.round((w * r.h) / r.w);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(src, r.x * dpr, r.y * dpr, sw, sh, 0, 0, w, h);
    // toBlob est fortement différé onglet masqué : encodage synchrone
    const b64 = this.canvas.toDataURL('image/jpeg', this.quality).split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    this.network.sendFrame(bytes);
  }
}
