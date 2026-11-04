import { CONFIG } from '../shared/config.js';

// Liaison WebSocket avec le serveur local :
//  - reçoit les commandes relayées depuis l'API REST et renvoie un acquittement ;
//  - publie l'état de la simulation ~5 fois par seconde ;
//  - reçoit les événements diffusés par le serveur (ex. résultats du prototype mobile) ;
//  - console opérateur : reçoit les manches (pilotage manuel, sans acquittement),
//    envoie le retour vidéo (images JPEG binaires) quand une console le regarde,
//    le journal du drone et l'état réel des panneaux pour la supervision électrique.
// Reconnexion automatique avec temporisation exponentielle.

export class Network {
  constructor({ getStatus, handleCommand, onConnection, onEvent, onSticks, onStream, getPlantModel }) {
    this.getStatus = getStatus;
    this.onSticks = onSticks;
    this.onStream = onStream;
    this.getPlantModel = getPlantModel;
    this.streaming = false;
    this.handleCommand = handleCommand;
    this.onConnection = onConnection;
    this.onEvent = onEvent;
    this.ws = null;
    this.retry = 0;
    this.timer = null;
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
      ws = new WebSocket(`${proto}://${location.host}${CONFIG.network.wsPath}`);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.onConnection('connecting');

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.onConnection('on');
      this.sendStatus();
      this.sendPlantModel();
      clearInterval(this.timer);
      // Filet de sécurité : la cadence normale vient de tick(), appelé à chaque image
      this.timer = setInterval(() => this.tick(), 1000 / CONFIG.network.statusHz);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'sticks') {
        this.onSticks?.(msg);
        return;
      }
      if (msg.type === 'stream') {
        this.streaming = Boolean(msg.on);
        this.onStream?.(this.streaming, msg);
        return;
      }
      if (msg.type === 'event') {
        this.onEvent?.(msg.event, msg.data || {});
        return;
      }
      if (msg.type !== 'command') return;
      let result;
      try {
        result = this.handleCommand(msg.action, msg.params || {}) || { ok: true };
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      this._send({ type: 'ack', id: msg.id, ...result });
    });

    ws.addEventListener('close', () => {
      clearInterval(this.timer);
      this.ws = null;
      if (this.streaming) this.onStream?.(false, {});
      this.streaming = false;
      this.onConnection('off');
      this._scheduleReconnect();
    });
    // Les erreurs sont suivies d'un « close » : la reconnexion s'y fait.
    ws.addEventListener('error', () => {});
  }

  _scheduleReconnect() {
    const delay = Math.min(15000, 1000 * 2 ** this.retry);
    this.retry = Math.min(this.retry + 1, 4);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  // Appelé à chaque image de la simulation. Onglet masqué depuis plus de 5 min, Chrome
  // ne déclenche plus les minuteries qu'une fois par minute : la boucle de rendu (entretenue
  // par un Web Worker) garde ainsi l'état à jour côté serveur.
  tick() {
    const now = performance.now();
    if (now - (this.lastStatusAt || 0) < 1000 / CONFIG.network.statusHz - 5) return;
    this.sendStatus();
  }

  sendStatus() {
    this.lastStatusAt = performance.now();
    this._send({ type: 'status', data: this.getStatus() });
  }

  // Journal du drone, relayé aux consoles
  sendLog(msg, level = 'info') {
    this._send({ type: 'log', msg, level });
  }

  // Modèle « terrain » des panneaux (défauts réels) : sert à la simulation électrique du serveur
  sendPlantModel() {
    if (this.getPlantModel) this._send({ type: 'plant', data: this.getPlantModel() });
  }

  // Image du retour caméra (Blob JPEG), seulement si la liaison n'est pas engorgée
  sendFrame(blob) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 400_000) return false;
    ws.send(blob);
    return true;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
