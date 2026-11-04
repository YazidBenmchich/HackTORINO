// Serveur local : sert l'application, ouvre une WebSocket vers la page
// et expose une API REST qui relaie les commandes au drone simulé.
//
//   npm run dev    -> Vite en middleware (rechargement à chaud)
//   npm start      -> sert le build de production (dist/, après `npm run build`)

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Operations } from './operations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const WS_PATH = '/ws';
const CONSOLE_WS_PATH = '/console-ws';
const ACK_TIMEOUT_MS = 3000;

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket : une ou plusieurs pages de simulation connectées.
// La page « principale » est la plus ancienne connexion encore ouverte :
// c'est elle qui fournit l'état et qui acquitte les commandes.

const wss = new WebSocketServer({ noServer: true });
const clients = []; // ordre de connexion
const pendingAcks = new Map();
let lastStatus = null;
let lastStatusAt = 0;
let nextCommandId = 1;

// Page « principale » : celle qui fait voler le drone pour l'API et les consoles.
// Une page gelée par le navigateur (onglet en arrière-plan, mise en veille) garde sa WebSocket
// ouverte mais n'envoie plus rien : au-delà de LIVE_MS sans message, on passe à une autre page
// active. On ne revient pas à l'ancienne quand elle se réveille (son drone n'est plus le même).
const LIVE_MS = 4000;
let current = null;
const isOpen = (c) => c.readyState === c.OPEN;
const isLive = (c) => Date.now() - c.lastMsgAt < LIVE_MS;

function primary() {
  if (current && isOpen(current) && isLive(current)) return current;
  const open = clients.filter(isOpen);
  const next = open.find(isLive) || (current && isOpen(current) ? current : open[0]) || null;
  if (next !== current) {
    if (current && next) log(`simulation page ${isOpen(current) ? 'not responding' : 'closed'}: switching to another open page`);
    current = next;
    if (next?.plant) ops.setPlantModel(next.plant);
    queueMicrotask(updateStream);
  }
  return current;
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === WS_PATH) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (pathname === CONSOLE_WS_PATH) consoleWss.handleUpgrade(req, socket, head, (ws) => consoleWss.emit('connection', ws, req));
  // autres chemins : laissés au HMR de Vite
});

wss.on('connection', (ws) => {
  ws.lastMsgAt = Date.now();
  clients.push(ws);
  log(`simulation page connected (${clients.length} active)`);
  ws.send(JSON.stringify({ type: 'hello', primary: primary() === ws }));
  updateStream();

  ws.on('message', (raw, isBinary) => {
    ws.lastMsgAt = Date.now();
    if (isBinary) {
      // Retour vidéo (JPEG) de la page principale, relayé aux consoles
      if (ws === primary()) relayFrame(raw);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'status' && ws === primary()) {
      lastStatus = msg.data;
      lastStatusAt = Date.now();
      ops.onStatus(msg.data);
    } else if (msg.type === 'plant') {
      ws.plant = msg.data; // gardé pour une reprise par cette page
      if (ws === primary()) ops.setPlantModel(msg.data);
    } else if (msg.type === 'log' && ws === primary() && typeof msg.msg === 'string') {
      ops.onLog(msg.msg.slice(0, 300), String(msg.level || 'info'));
    } else if (msg.type === 'ack' && pendingAcks.has(msg.id)) {
      const pending = pendingAcks.get(msg.id);
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        pendingAcks.delete(msg.id);
        pending.resolve(msg);
      }
    }
  });

  ws.on('close', () => {
    const i = clients.indexOf(ws);
    if (i >= 0) clients.splice(i, 1);
    for (const [id, p] of pendingAcks) {
      if (p.ws === ws) {
        clearTimeout(p.timer);
        pendingAcks.delete(id);
        p.resolve({ ok: false, error: 'The simulation page disconnected' });
      }
    }
    log(`simulation page disconnected (${clients.length} active)`);
    if (!primary()) lastStatus = null;
    updateStream();
  });
});

// ---------------------------------------------------------------------------
// Consoles opérateur (console.html) : état, alertes, retour vidéo, commandes, manches

const consoleWss = new WebSocketServer({ noServer: true });
const consoles = new Set();
let streamingTo = null; // page qui diffuse actuellement la vidéo

function broadcastConsoles(obj) {
  if (!consoles.size) return;
  const payload = JSON.stringify(obj);
  for (const c of consoles) if (c.readyState === c.OPEN) c.send(payload);
}

function relayFrame(buf) {
  ops.onFrame(buf);
  for (const c of consoles) {
    // Console lente : on saute des images plutôt que d'accumuler du retard
    if (c.readyState === c.OPEN && c.bufferedAmount < 1_000_000) c.send(buf, { binary: true });
  }
}

// La vidéo n'est produite que si une console la regarde, et par la page principale seulement
function updateStream() {
  const target = consoles.size ? primary() : null;
  if (target === streamingTo) return;
  if (streamingTo && streamingTo.readyState === streamingTo.OPEN) streamingTo.send(JSON.stringify({ type: 'stream', on: false }));
  streamingTo = target;
  if (target) target.send(JSON.stringify({ type: 'stream', on: true, fps: 20, maxWidth: 1024, quality: 0.7 }));
}

const ops = new Operations({
  relay: (action, params) => relay(action, params),
  isConnected: () => Boolean(primary()),
  broadcast: broadcastConsoles,
  log,
});
// Bascule vers une page active même sans trafic (page principale gelée)
setInterval(primary, 1000).unref();

// État de la simulation vers les consoles, 5 fois par seconde
setInterval(() => {
  if (!consoles.size) return;
  broadcastConsoles({
    type: 'status',
    connected: Boolean(primary()),
    ageMs: lastStatus ? Date.now() - lastStatusAt : null,
    data: lastStatus,
    dispatch: ops.dispatch ? { alertId: ops.dispatch.alertId, panel: ops.dispatch.panel, point: ops.dispatch.point } : null,
  });
}, 200);

// Commandes de la console : actions du drone (relayées à la simulation) ou de l'exploitation
const DRONE_ACTIONS = new Set(['goto', 'missionStart', 'pause', 'resume', 'returnToBase', 'zoneView', 'reset', 'takeoff', 'land', 'pilot', 'gimbal', 'thermal', 'simSpeed']);

async function consoleCommand(action, params = {}) {
  if (DRONE_ACTIONS.has(action)) {
    const ack = await relay(action, params);
    if (!ack) return { ok: false, code: 503, error: 'Simulation not connected: open the simulation page' };
    // L'acquittement de la page porte son propre identifiant : on ne renvoie que le résultat
    const { type, id, ...result } = ack; // eslint-disable-line no-unused-vars
    return result;
  }
  switch (action) {
    case 'alertAck': return ops.acknowledge(params.id, params.by);
    case 'alertDispatch': return ops.dispatchAlert(params.id, params.by);
    case 'alertClose': return ops.closeAlert(params.id, params.by);
    case 'workOrder': return ops.updateWorkOrder(params.id, params);
    case 'settings': return ops.setSettings(params);
    case 'injectFault': return ops.injectFault(params.panel);
    case 'scenario': return ops.injectScenario(params.id, { panel: params.panel, zone: params.zone });
    case 'repairIncident': return ops.repairIncident(params.id);
    case 'repairAll': return ops.repairAll();
    default: return { ok: false, code: 400, error: `Unknown command: ${action}` };
  }
}

consoleWss.on('connection', (ws) => {
  consoles.add(ws);
  log(`operator console connected (${consoles.size})`);
  ws.send(JSON.stringify({ type: 'hello', connected: Boolean(primary()), status: lastStatus, ...ops.snapshot() }));
  if (ops.lastFrame) ws.send(ops.lastFrame, { binary: true });
  updateStream();

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'sticks') {
      // Pilotage manuel : relais direct, sans acquittement (cadence ~20 Hz)
      const target = primary();
      if (target) target.send(JSON.stringify({ type: 'sticks', fwd: msg.fwd, right: msg.right, up: msg.up, yaw: msg.yaw }));
      return;
    }
    if (msg.type !== 'cmd' || typeof msg.action !== 'string') return;
    let result;
    try {
      result = await consoleCommand(msg.action, msg.params || {});
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'ack', id: msg.id, ...result }));
  });

  ws.on('close', () => {
    consoles.delete(ws);
    log(`operator console disconnected (${consoles.size})`);
    updateStream();
  });
});

// Envoie une commande à toutes les pages et attend l'acquittement de la page principale.
function relay(action, params = {}) {
  const target = primary();
  if (!target) return Promise.resolve(null);
  const id = nextCommandId++;
  const payload = JSON.stringify({ type: 'command', id, action, params });
  for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(id);
      resolve({ ok: false, error: 'No answer from the simulation page (timed out)' });
    }, ACK_TIMEOUT_MS);
    pendingAcks.set(id, { ws: target, resolve, timer });
  });
}

// ---------------------------------------------------------------------------
// API REST

app.use('/api', express.json({ limit: '16kb' }));

// Prototype mobile : résultat d'inspection relayé aux pages de simulation (journal)
app.post('/api/mobile/report', (req, res) => {
  const body = req.body || {};
  if (typeof body.panel !== 'string' || !/^[A-Z]\d{2}$/.test(body.panel) || !['defect', 'ok', 'complete'].includes(body.kind)) {
    return res.status(400).json({ ok: false, error: 'Expected body: { "panel": "B07", "kind": "defect" | "ok" | "complete", ... }' });
  }
  const data = {
    panel: body.panel,
    kind: body.kind,
    defects: Array.isArray(body.defects) ? body.defects.slice(0, 8).map((d) => ({
      type: String(d.type || '').slice(0, 20),
      label: String(d.label || '').slice(0, 40),
      deltaT: Number(d.deltaT) || 0,
      // Position sur le panneau grand format (cellule repérée par les marqueurs)
      ...(d.cell && Number.isInteger(d.cell.col) && Number.isInteger(d.cell.row)
        ? { cell: { col: d.cell.col, row: d.cell.row }, where: String(d.where || '').slice(0, 12) }
        : {}),
    })) : [],
  };
  const payload = JSON.stringify({ type: 'event', event: 'mobileReport', data });
  let delivered = 0;
  for (const c of clients) {
    if (c.readyState === c.OPEN) { c.send(payload); delivered++; }
  }
  log(`mobile : ${data.panel} ${data.kind}${data.defects.length ? ` (${data.defects.map((d) => `${d.label || d.type}${d.where ? ` at ${d.where}` : ''}`).join(', ')})` : ''}`);
  res.json({ ok: true, delivered });
});

async function sendCommand(res, action, params) {
  const ack = await relay(action, params);
  if (!ack) {
    return res.status(503).json({ ok: false, error: 'No simulation page connected. Open http://localhost:' + PORT });
  }
  if (!ack.ok) return res.status(ack.code || 409).json({ ok: false, error: ack.error });
  res.json({ ok: true, action, ...(ack.result ? { result: ack.result } : {}) });
}

// Type d'inspection optionnel : "modules" (défaut) ou "structure" (pieds et fondations)
function parseType(body) {
  if (body.type === undefined) return { type: 'modules' };
  const t = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
  if (t === 'modules' || t === 'module') return { type: 'modules' };
  if (t === 'structure' || t === 'structures') return { type: 'structure' };
  return { error: 'Invalid type (expected "modules" or "structure")' };
}

app.post('/api/goto', (req, res) => {
  const body = req.body || {};
  if (typeof body.panel === 'string') {
    if (!/^[A-Z]\d{2}$/i.test(body.panel.trim())) {
      return res.status(400).json({ ok: false, error: 'Invalid panel id (expected zone + number, e.g. A01 to C20)' });
    }
    const { type, error } = parseType(body);
    if (error) return res.status(400).json({ ok: false, error });
    return sendCommand(res, 'goto', { panel: body.panel.trim().toUpperCase(), type });
  }
  const x = Number(body.x);
  const z = Number(body.z);
  if (body.x === undefined || body.z === undefined || !Number.isFinite(x) || !Number.isFinite(z)) {
    return res.status(400).json({ ok: false, error: 'Expected body: { "x": number, "z": number } or { "panel": "B07" }' });
  }
  return sendCommand(res, 'goto', { x, z });
});

// Corps optionnel { "zone": "B", "type": "structure" } : une seule zone, type d'inspection
app.post('/api/mission/start', (req, res) => {
  const body = req.body || {};
  const zone = body.zone;
  if (zone !== undefined && !(typeof zone === 'string' && /^[A-Z]$/i.test(zone.trim()))) {
    return res.status(400).json({ ok: false, error: 'Invalid zone (expected "A", "B" or "C")' });
  }
  const { type, error } = parseType(body);
  if (error) return res.status(400).json({ ok: false, error });
  return sendCommand(res, 'missionStart', zone ? { zone: zone.trim().toUpperCase(), type } : { type });
});
// Vue de zone dans la page (caméra au-dessus de la zone + fiche de synthèse)
app.post('/api/zone/:id/view', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  if (!/^[A-Z]$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid zone (expected A, B or C)' });
  return sendCommand(res, 'zoneView', { zone: id });
});
app.post('/api/mission/pause', (req, res) => sendCommand(res, 'pause'));
app.post('/api/mission/resume', (req, res) => sendCommand(res, 'resume'));
app.post('/api/mission/reset', (req, res) => sendCommand(res, 'reset', { clean: Boolean(req.body?.clean) }));
app.post('/api/return', (req, res) => sendCommand(res, 'returnToBase'));

// Sortie de base, pilotage, caméra
app.post('/api/takeoff', (req, res) => sendCommand(res, 'takeoff', { pilot: Boolean(req.body?.pilot) }));
app.post('/api/land', (req, res) => sendCommand(res, 'land'));
app.post('/api/pilot', (req, res) => sendCommand(res, 'pilot', { on: req.body?.on !== false }));
app.post('/api/gimbal', (req, res) => sendCommand(res, 'gimbal', { pitch: Number(req.body?.pitch) }));
app.post('/api/thermal', (req, res) => sendCommand(res, 'thermal', { on: req.body?.on !== false }));

// Exploitation : supervision électrique, alertes, ordres de travail
const reply = (res, r) => (r.ok === false ? res.status(r.code || 409).json(r) : res.json(r));
app.get('/api/scada', (req, res) => {
  if (!ops.panels.length) return res.status(503).json({ ok: false, error: 'Plant not connected' });
  res.json(ops.scadaFrame());
});
app.get('/api/alerts', (req, res) => res.json(ops.alerts.map((a) => ops.publicAlert(a))));
app.post('/api/alerts/:id/ack', (req, res) => reply(res, ops.acknowledge(req.params.id)));
app.post('/api/alerts/:id/dispatch', async (req, res) => reply(res, await ops.dispatchAlert(req.params.id)));
app.post('/api/alerts/:id/close', (req, res) => reply(res, ops.closeAlert(req.params.id)));
app.get('/api/alerts/:id/snapshot.jpg', (req, res) => {
  const buf = ops.alertSnapshot(req.params.id);
  if (!buf) return res.status(404).json({ ok: false, error: 'No image for this alert' });
  res.type('image/jpeg').send(buf);
});
app.get('/api/workorders', (req, res) => res.json(ops.workOrders));
app.post('/api/workorders/:id', async (req, res) => reply(res, await ops.updateWorkOrder(req.params.id, req.body || {})));
app.get('/api/frame.jpg', (req, res) => {
  if (!ops.lastFrame) return res.status(404).json({ ok: false, error: 'No image (no console is watching the video feed)' });
  res.type('image/jpeg').send(ops.lastFrame);
});
// Démo : faire décrocher un panneau maintenant ({ "panel": "B07" } facultatif)
app.post('/api/demo/fault', (req, res) => reply(res, ops.injectFault(req.body?.panel)));
// Démo : incidents simulés (catalogue, déclenchement, réparation)
app.get('/api/demo/scenarios', (req, res) => res.json(ops.snapshot().scenarios));
app.get('/api/demo/incidents', (req, res) => res.json(ops.incidents));
app.post('/api/demo/scenario', async (req, res) => {
  const b = req.body || {};
  if (typeof b.id !== 'string') return res.status(400).json({ ok: false, error: 'Expected body: { "id": "hotspot", "panel": "B07" } or { "id": "rain", "zone": "A" }' });
  reply(res, await ops.injectScenario(b.id, { panel: b.panel, zone: b.zone }));
});
app.post('/api/demo/incidents/:id/repair', async (req, res) => reply(res, await ops.repairIncident(req.params.id)));
app.post('/api/demo/repair-all', async (req, res) => reply(res, await ops.repairAll()));

app.get('/api/status', (req, res) => {
  if (!lastStatus) {
    return res.status(503).json({ connected: false, error: 'No simulation page connected' });
  }
  res.json({
    connected: Boolean(primary()),
    updatedAt: new Date(lastStatusAt).toISOString(),
    ageMs: Date.now() - lastStatusAt,
    ...lastStatus,
  });
});

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: `Unknown route: ${req.method} ${req.originalUrl}` }));

// JSON mal formé, etc.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ ok: false, error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message });
});

// ---------------------------------------------------------------------------
// Application

// Adresse courte de la console
app.get('/console', (req, res) => res.redirect('/console.html'));

if (PROD) {
  const dist = path.join(root, 'dist');
  app.use(express.static(dist));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

server.listen(PORT, () => {
  log(`${PROD ? 'production' : 'development'}: http://localhost:${PORT}`);
  log(`API: http://localhost:${PORT}/api/status`);
  log(`Operator console: http://localhost:${PORT}/console.html`);
});

function log(msg) {
  const t = new Date().toLocaleTimeString('en-GB');
  console.log(`[${t}] ${msg}`);
}
