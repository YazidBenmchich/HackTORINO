// HelioScan Edge — phone page served by the Arduino UNO Q (WebUI brick).
//
// The phone is only the camera and the display:
//   1. the visible part of the camera image is encoded as JPEG and sent to the board ("frame");
//   2. the board runs the whole pipeline (panel, ArUco marker, YOLO, tracking, inspection path)
//      and answers with "frame_response";
//   3. the page draws the result over the live video.
// One frame is in flight at a time (stop-and-wait), so the stream adapts to the board's speed.

(() => {
  const SEND_LONG_SIDE = 640;  // px, long side of the frames sent to the board
  const JPEG_QUALITY = 0.72;
  const MIN_INTERVAL_MS = 80;  // never more than ~12 frames/s
  const TIMEOUT_MS = 4000;     // frame considered lost after this delay
  const COLOR = { blue: '#3ec4ff', green: '#2fe07f', amber: '#ffb020', red: '#ff3b30', grey: 'rgba(255,255,255,0.55)' };

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), video: $('video'), overlay: $('overlay'), map: $('map'),
    stepCount: $('step-count'), stepTitle: $('step-title'), stepHint: $('step-hint'),
    linkDot: $('link-dot'), edgeText: $('edge-text'),
    counter: $('counter'), defectCount: $('defect-count'), defectWord: $('defect-word'),
    btnNext: $('btn-next'), btnSettings: $('btn-settings'), btnRestart: $('btn-restart'),
    settings: $('settings'), setConf: $('set-conf'), outConf: $('out-conf'), setPrint: $('set-print'),
    setRaw: $('set-raw'), btnCloseSettings: $('btn-close-settings'),
    result: $('result'), resultBadge: $('result-badge'), resultTitle: $('result-title'), resultList: $('result-list'),
    btnReport: $('btn-report'), btnAgain: $('btn-again'),
    intro: $('intro'), btnStart: $('btn-start'), introError: $('intro-error'), toast: $('toast'),
  };
  const ctx = el.overlay.getContext('2d');
  const grab = document.createElement('canvas');
  const gctx = grab.getContext('2d');

  // ---------------------------------------------------------------- settings

  const settings = { conf: 0.35, print_mode: 'bw', raw: false };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('helioscan-edge') || '{}')); } catch { /* no storage */ }

  function applySettings(send) {
    el.setConf.value = settings.conf;
    el.outConf.textContent = Number(settings.conf).toFixed(2);
    el.setPrint.value = settings.print_mode;
    el.setRaw.checked = settings.raw;
    try { localStorage.setItem('helioscan-edge', JSON.stringify(settings)); } catch { /* idem */ }
    if (send && socket.connected) socket.emit('config', { conf: Number(settings.conf), print_mode: settings.print_mode });
  }
  el.setConf.addEventListener('input', () => { settings.conf = Number(el.setConf.value); applySettings(true); });
  el.setPrint.addEventListener('change', () => { settings.print_mode = el.setPrint.value; applySettings(true); });
  el.setRaw.addEventListener('change', () => { settings.raw = el.setRaw.checked; applySettings(false); });
  el.btnSettings.addEventListener('click', () => { el.settings.hidden = !el.settings.hidden; });
  el.btnCloseSettings.addEventListener('click', () => { el.settings.hidden = true; });

  // ---------------------------------------------------------------- link to the board

  const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
  let connected = false;
  let inFlight = null;     // { id, sentAt, scale }
  let frameId = 0;
  let lastSent = 0;
  let last = null;         // last result
  let lastScale = 1;       // result pixels → screen pixels
  let lastAt = 0;
  let latency = 0;
  let fps = 0;
  let lastStepId = 'marker';

  socket.on('connect', () => {
    connected = true;
    setLink();
    applySettings(true);
  });
  socket.on('disconnect', () => {
    connected = false;
    inFlight = null;
    setLink();
  });

  socket.on('frame_response', (res) => {
    if (!inFlight || res.id !== inFlight.id) return;
    const now = performance.now();
    const dt = now - inFlight.sentAt;
    latency = latency ? latency * 0.8 + dt * 0.2 : dt;
    fps = 1000 / latency;
    lastScale = inFlight.scale;
    inFlight = null;
    if (res.error) return;
    last = res;
    lastAt = now;
    handleEvents(res);
    updateBanner(res);
    setLink();
  });
  socket.on('skip_response', (r) => { if (r.done) requestReport(true); });
  socket.on('reset_response', () => { last = null; lastStepId = 'marker'; el.result.hidden = true; updateBanner(null); });
  socket.on('report_response', (report) => {
    if (pendingReport === 'show') showResult(report.findings);
    if (pendingReport === 'download') download(report);
    pendingReport = null;
  });

  function setLink() {
    el.linkDot.className = connected ? 'on' : 'off';
    el.edgeText.textContent = !connected
      ? 'UNO Q · disconnected'
      : last ? `UNO Q · YOLO ${last.timings.yolo_ms.toFixed(0)} ms · ${fps.toFixed(1)} fps` : 'UNO Q · connected';
  }

  // ---------------------------------------------------------------- camera

  let starting = false;
  let running = false;
  el.btnStart.addEventListener('click', startCamera);

  async function startCamera() {
    if (starting) return;
    el.introError.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      showIntroError('The camera needs a secure page: open this page with https:// (accept the certificate warning).');
      return;
    }
    starting = true;
    el.btnStart.disabled = true;
    try {
      const old = el.video.srcObject;
      if (old) old.getTracks().forEach((tr) => tr.stop());
      el.video.srcObject = await openCamera();
      await el.video.play().catch((err) => { if (err.name !== 'AbortError') throw err; });
    } catch (err) {
      showIntroError(err.name === 'NotAllowedError'
        ? 'Camera access was refused. Allow it in the browser settings, then reload.'
        : err.name === 'NotReadableError'
          ? 'The camera is busy. Close other apps or tabs using the camera, then try again.'
          : `Camera error: ${err.message || err.name}`);
      return;
    } finally {
      starting = false;
      el.btnStart.disabled = false;
    }
    el.intro.hidden = true;
    try { await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  }

  async function openCamera() {
    const attempts = [
      { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      { facingMode: { ideal: 'environment' } },
      true,
    ];
    let lastErr;
    for (const video of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video });
      } catch (err) {
        if (err.name === 'NotAllowedError') throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  function showIntroError(msg) {
    el.introError.textContent = msg;
    el.introError.hidden = false;
  }

  // ---------------------------------------------------------------- frame loop

  function loop(now) {
    requestAnimationFrame(loop);
    resizeOverlay();
    if (inFlight && now - inFlight.sentAt > TIMEOUT_MS) inFlight = null;
    if (connected && !inFlight && el.video.readyState >= 2 && now - lastSent >= MIN_INTERVAL_MS) sendFrame(now);
    draw(now);
  }

  function resizeOverlay() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(el.stage.clientWidth * dpr);
    const h = Math.round(el.stage.clientHeight * dpr);
    if (el.overlay.width !== w || el.overlay.height !== h) {
      el.overlay.width = w;
      el.overlay.height = h;
    }
  }

  // Only the part of the video visible on screen is sent (object-fit: cover)
  function sendFrame(now) {
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    const cw = el.stage.clientWidth, ch = el.stage.clientHeight;
    if (!vw || !vh || !cw || !ch) return;
    const cover = Math.max(cw / vw, ch / vh);
    const sw = cw / cover, sh = ch / cover;
    const k = Math.min(1, SEND_LONG_SIDE / Math.max(sw, sh));
    const pw = Math.round(sw * k), ph = Math.round(sh * k);
    if (grab.width !== pw || grab.height !== ph) {
      grab.width = pw;
      grab.height = ph;
    }
    gctx.drawImage(el.video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, pw, ph);
    const jpeg = grab.toDataURL('image/jpeg', JPEG_QUALITY);
    frameId += 1;
    inFlight = { id: frameId, sentAt: now, scale: cw / pw };
    lastSent = now;
    socket.emit('frame', { id: frameId, jpeg });
  }

  // ---------------------------------------------------------------- drawing

  function draw(now) {
    const W = el.stage.clientWidth, H = el.stage.clientHeight;
    const dpr = el.overlay.width / W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 14, H / 2); ctx.lineTo(W / 2 + 14, H / 2);
    ctx.moveTo(W / 2, H / 2 - 14); ctx.lineTo(W / 2, H / 2 + 14);
    ctx.stroke();
    if (!last) return;

    const s = lastScale;
    const stale = now - lastAt > 1500;
    ctx.globalAlpha = stale ? 0.35 : 1;

    const step = last.step;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (!last.panel.edges[side]) continue;
      ctx.fillStyle = side === step.end ? COLOR.green : 'rgba(62,196,255,0.75)';
      if (side === 'top') ctx.fillRect(0, 0, W, 6);
      if (side === 'bottom') ctx.fillRect(0, H - 6, W, 6);
      if (side === 'left') ctx.fillRect(0, 0, 6, H);
      if (side === 'right') ctx.fillRect(W - 6, 0, 6, H);
    }

    if (last.marker) {
      const [x0, y0, x1, y1] = last.marker.map((v) => v * s);
      ctx.strokeStyle = COLOR.blue;
      ctx.lineWidth = step.id === 'marker' ? 3 : 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (step.id === 'marker') {
        const p = Math.min(1, step.progress || 0);
        ctx.fillStyle = 'rgba(62,196,255,0.25)';
        ctx.fillRect(x0, y1 - (y1 - y0) * p, x1 - x0, (y1 - y0) * p);
        label('START · ArUco', x0, y0 - 6, COLOR.blue);
      }
    }

    if (settings.raw) {
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      for (const d of last.detections) {
        const [x0, y0, x1, y1] = d.box.map((v) => v * s);
        ctx.strokeStyle = COLOR.grey;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = COLOR.grey;
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(`${d.type} ${d.conf.toFixed(2)}`, x0 + 2, y1 + 12);
      }
      ctx.setLineDash([]);
    }

    for (const tr of last.tracks) {
      const [x0, y0, x1, y1] = tr.box.map((v) => v * s);
      const pad = 8;
      if (tr.counted) {
        ctx.strokeStyle = COLOR.red;
        ctx.lineWidth = 3;
        ctx.globalAlpha = (stale ? 0.35 : 1) * (0.6 + 0.4 * Math.sin(now / 160));
        ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
        ctx.globalAlpha = stale ? 0.35 : 1;
        label(`#${tr.number} ${tr.label.toUpperCase()} · ${tr.sheet}  ${Math.round(tr.conf * 100)}%`, x0 - pad, y0 - pad - 6, COLOR.red);
      } else {
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = COLOR.amber;
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
        ctx.setLineDash([]);
        label(`${tr.label} ${Math.round(tr.conf * 100)}%`, x0 - pad, y0 - pad - 6, COLOR.amber);
      }
    }
    ctx.globalAlpha = 1;

    if (step.arrow && step.end) drawArrow(step.end, W, H, now / 1000);
  }

  function label(text, x, y, color) {
    ctx.font = '700 13px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x, y - 16, w, 20);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 5, y - 1);
  }

  function drawArrow(side, W, H, t) {
    const off = 6 * Math.sin(t * 4);
    const dir = { right: [1, 0], left: [-1, 0], bottom: [0, 1], top: [0, -1] }[side];
    const cx = W / 2 + dir[0] * (W / 2 - 50 + off), cy = H / 2 + dir[1] * (H / 2 - 90 + off);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(dir[1], dir[0]));
    ctx.fillStyle = 'rgba(62,196,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(18, 0); ctx.lineTo(-10, -18); ctx.lineTo(-10, 18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- interface

  const MAP_LEGS = [[[12, 12], [84, 12]], [[84, 12], [84, 52]], [[84, 52], [12, 52]]];
  (function buildMap() {
    const ns = 'http://www.w3.org/2000/svg';
    const set = (node, attrs) => { Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); return node; };
    ['A1', 'B1', 'C1', 'A2', 'B2', 'C2'].forEach((n, i) => {
      const x = (i % 3) * 32, y = Math.floor(i / 3) * 32;
      el.map.append(set(document.createElementNS(ns, 'rect'), { x: x + 1, y: y + 1, width: 30, height: 30, rx: 2, class: 'sheet-rect' }));
      const tx = set(document.createElementNS(ns, 'text'), { x: x + 16, y: y + 19, class: 'sheet-label' });
      tx.textContent = n;
      el.map.append(tx);
    });
    MAP_LEGS.forEach(([a, b], i) => {
      const p = set(document.createElementNS(ns, 'path'), { d: `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, class: 'leg' });
      p.dataset.leg = i + 1;
      el.map.append(p);
    });
    el.map.append(set(document.createElementNS(ns, 'circle'), { cx: 12, cy: 12, r: 4, class: 'start' }));
  })();

  function updateBanner(res) {
    const step = res ? res.step : { index: 0, count: 4, id: 'marker', title: 'Find the start marker', hint: '', warn: false };
    el.stepCount.textContent = res && res.done ? 'Done' : `Step ${Math.min(step.index + 1, step.count)} / ${step.count}`;
    el.stepTitle.innerHTML = step.arrow ? `<span class="arrow">${step.arrow}</span>${step.title}` : step.title;
    el.stepHint.textContent = step.hint || '';
    el.stepHint.classList.toggle('warn', !!step.warn);
    el.map.querySelectorAll('.leg').forEach((p) => {
      const leg = Number(p.dataset.leg);
      p.classList.toggle('done', leg < step.index);
      p.classList.toggle('current', leg === step.index);
    });
    const n = res ? res.findings.length : 0;
    el.defectCount.textContent = n;
    el.defectWord.textContent = n === 1 ? 'defect' : 'defects';
    el.counter.classList.toggle('has', n > 0);
  }

  function handleEvents(res) {
    for (const e of res.events) {
      if (e.type === 'defect') {
        const f = e.finding;
        toast(`Defect #${f.number}: ${f.label} · sheet ${f.sheet}`, true);
        navigator.vibrate?.([120, 60, 120]);
      }
    }
    if (res.step.id !== lastStepId) {
      lastStepId = res.step.id;
      navigator.vibrate?.(40);
      if (res.done) showResult(res.findings);
      else if (res.step.arrow) toast(`${res.step.arrow} ${res.step.title}`);
    }
  }

  function showResult(findings) {
    el.result.classList.toggle('ok', findings.length === 0);
    el.result.classList.toggle('bad', findings.length > 0);
    el.resultBadge.textContent = findings.length ? '!' : '✓';
    el.resultTitle.textContent = findings.length
      ? `${findings.length} defect${findings.length > 1 ? 's' : ''} found`
      : 'Panel OK — no defect found';
    el.resultList.replaceChildren(...findings.map((d) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="num">#${d.number}</span><span>${d.label} · sheet ${d.sheet}</span><span class="where">${Math.round(d.confidence * 100)}% · ${d.pass}</span>`;
      return li;
    }));
    el.settings.hidden = true;
    el.result.hidden = false;
    navigator.vibrate?.(findings.length ? [200, 80, 200] : 80);
  }

  let pendingReport = null;
  function requestReport(show) {
    pendingReport = show ? 'show' : 'download';
    socket.emit('report');
  }

  function download(report) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `helioscan-${report.panel_id}-report.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  el.btnNext.addEventListener('click', () => socket.emit('skip'));
  el.btnRestart.addEventListener('click', () => socket.emit('reset'));
  el.btnAgain.addEventListener('click', () => socket.emit('reset'));
  el.btnReport.addEventListener('click', () => requestReport(false));

  let toastTimer = 0;
  function toast(text, red = false) {
    el.toast.textContent = text;
    el.toast.classList.toggle('red', red);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1600);
  }

  applySettings(false);
  updateBanner(null);
  setLink();
})();
