/**
 * backend-detection.js — Veesion v1.5
 * [v1.5] Maneja eventos de BehaviorAnalyzer (Python) — los comportamientos
 *        ahora corren server-side con keypoints precisos de yolo26n-pose.pt.
 *        detection.js ya no es la fuente de verdad para comportamientos.
 *
 * Tus cambios preservados:
 *   - setGithubEnabled() + _githubEnabled toggle
 *   - ALERTA_YOLO con bbox flash en canvas (2.5s)
 *   - ALERTA_GITHUB handler
 *
 * Eventos del backend:
 *   Comportamiento  → BOLSILLO, BRAZOS_CRUZADOS, AGACHADO, BAJO_ROPA,
 *                     PANTALLA, PERMANENCIA, ESCANEO, ZONA_ENTRADA,
 *                     ROBO_CONFIRMADO, PANTALLA_HUMANA, COMPLICE_DISTRACTOR,
 *                     BAJO_MANGA
 *   Modelos ML      → ALERTA_YOLO, ALERTA_LSTM, ALERTA_GITHUB
 */

const BACKEND_WS = (
  window.VEESION_BACKEND_URL ||
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'ws://localhost:8000'
    : 'wss://veesion-backend.onrender.com')
).replace(/^http/, 'ws');

const BACKEND_HTTP = BACKEND_WS.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const JPEG_QUALITY = 0.72;

const PROFILE_DEFAULTS = {
  generico:     { dwellTime: 4,  scoreThreshold: 72 },
  supermercado: { dwellTime: 5,  scoreThreshold: 75 },
  farmacia:     { dwellTime: 3,  scoreThreshold: 68 },
  kiosco:       { dwellTime: 2,  scoreThreshold: 65 },
  joyeria:      { dwellTime: 2,  scoreThreshold: 55 },
  ropa:         { dwellTime: 6,  scoreThreshold: 78 },
  bazar:        { dwellTime: 4,  scoreThreshold: 70 },
  deposito:     { dwellTime: 2,  scoreThreshold: 60 },
  cocina:       { dwellTime: 8,  scoreThreshold: 82 },
};

export class DetectionEngine {
  constructor(canvas, zoneManager, alertManager, config = {}, cameraId = 1) {
    this._canvas       = canvas;
    this._ctx          = canvas.getContext('2d');
    this._zoneManager  = zoneManager;
    this._alertManager = alertManager;
    this._config       = {
      movementThreshold: config.movementThreshold ?? 50,
      dwellTime:         config.dwellTime ?? 3,
      cooldown:          config.cooldown ?? 6,
      storeType:         config.storeType ?? 'generico',
    };
    this._cameraId        = cameraId;

    this._ws              = null;
    this._wsReady         = false;
    this._active          = false;
    this._processingFrame = false;
    this._pingTimer       = null;
    this._renderRAF       = null;
    this._zoneRAF         = null;

    this._tracks          = [];
    this._objects         = [];
    this._shoplifting     = [];
    this._lastDets        = [];
    this._lastThumb       = null; // último frame thumbnail del backend

    this.currentFPS       = 0;
    this._fpsFrames       = 0;
    this._fpsLast         = performance.now();

    this.onDetection      = null;
    this._font            = '"Share Tech Mono", monospace';

    this._offCanvas       = document.createElement('canvas');
    this._offCtx          = this._offCanvas.getContext('2d');

    this._githubEnabled   = false;
    this._yoloFlashTimer  = null;

    this._startZoneLoop();

    if (this._zoneManager?.onZoneChange) {
      this._zoneManager.onZoneChange(() => {
        console.log('📡 Zonas actualizadas → enviando al backend');
        this._send({
          type: 'zones',
          zones: this._zoneManager.zones
        });
      });
    }
  }

  // ── Zone loop ─────────────────────────────────────────────────────────────
  _startZoneLoop() {
    const loop = () => {
      if (!this._active) {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        this._zoneManager?.drawZone?.(false);
        this._zoneManager?.drawPreview?.();
      }
      this._zoneRAF = requestAnimationFrame(loop);
    };
    this._zoneRAF = requestAnimationFrame(loop);
  }

  // ── init ──────────────────────────────────────────────────────────────────
  async init() {
    return new Promise((resolve, reject) => {
      if (
        this._ws &&
        (this._ws.readyState === WebSocket.OPEN ||
         this._ws.readyState === WebSocket.CONNECTING)
      ) {
        resolve();
        return;
      }

      const url = `${BACKEND_WS}/ws/camera/${this._cameraId}`;
      console.log(`%c🔌 Conectando: ${url}`, 'color:#00c8ff');
      this._ws = new WebSocket(url);

      this._ws.onopen = () => {
        console.log('%c✅ Backend conectado', 'color:#00e676');
        this._wsReady = true;
        this._syncConfig();
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this._send({ type: 'ping' }), 15000);
        resolve();
      };

      this._ws.onerror = () => {
        reject(new Error(`No se pudo conectar a ${url}`));
      };

      this._ws.onclose = (e) => {
        this._wsReady         = false;
        this._processingFrame = false;
        clearInterval(this._pingTimer);
        this._pingTimer = null;
        console.warn(`%c⚠ WS cerrado (${e.code})`, 'color:#ffaa00');
        if (this._active && e.code !== 1000) {
          setTimeout(() => this._reconnectSilent(), 10000);
        }
      };

      this._ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    });
  }

  // ── Reconexión silenciosa ─────────────────────────────────────────────────
  _reconnectSilent() {
    if (
      this._ws?.readyState === WebSocket.OPEN ||
      this._ws?.readyState === WebSocket.CONNECTING
    ) return;
    if (!this._active) return;

    const url = `${BACKEND_WS}/ws/camera/${this._cameraId}`;
    console.log('%c🔄 Reconectando...', 'color:#ffaa00');
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      this._wsReady         = true;
      this._processingFrame = false;
      console.log('%c🔄 Reconectado', 'color:#00e676');
      this._syncConfig();
      this._syncZones();
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), 15000);
    };

    this._ws.onclose = (e) => {
      this._wsReady         = false;
      this._processingFrame = false;
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      if (this._active && e.code !== 1000) {
        setTimeout(() => this._reconnectSilent(), 10000);
      }
    };

    this._ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    this._ws.onerror   = () => {};
  }

  setGithubEnabled(enabled) {
    this._githubEnabled = enabled;
    this._send({
      type: 'github_toggle',
      enabled
    });
    console.log(
      `%c🧠 GitHub ${enabled ? 'ACTIVADO' : 'DESACTIVADO'}`,
      enabled ? 'color:#00ff94' : 'color:#ffaa00'
    );
  }

  // ── Mensajes del backend ──────────────────────────────────────────────────
  _onMessage(msg) {
    if (msg.type === 'pong') return;

    if (msg.type === 'status') {
      console.log(`%c🤖 Modelos: ${msg.ready ? 'listos ✓' : 'cargando...'}`, 'color:#00d4ff');
      return;
    }

    if (msg.type === 'ip_stream_ack') {
      console.log(`%c✅ Backend leyendo cámara IP: ${msg.url}`, 'color:#00ff94');
      return;
    }

    if (msg.type === 'ip_stream_error') {
      console.error(`%c❌ Error stream IP: ${msg.message}`, 'color:#ff3d3d');
      this.onDetection?.(`Error cámara IP: ${msg.message}`, 'err');
      return;
    }

    if (msg.type === 'detection') {
      this._processingFrame = false;

      const state       = msg.state || {};
      this._tracks      = state.tracks || [];
      this._objects     = state.objects || [];
      this._shoplifting = state.shoplifting || [];
      this._lastDets    = this._tracks;

      // Guardar thumbnail del frame procesado por el backend (viene cuando hay eventos)
      if (msg.thumb) this._lastThumb = msg.thumb;
      this._objects     = state.objects || [];
      this._shoplifting = state.shoplifting || [];
      this._lastDets    = this._tracks;

      this._fpsFrames++;
      const now = performance.now();
      if (now - this._fpsLast >= 1000) {
        this.currentFPS = this._fpsFrames;
        this._fpsFrames = 0;
        this._fpsLast   = now;
      }

      if (Array.isArray(msg.events) && msg.events.length) {
        for (const evt of msg.events) this._handleEvent(evt);
      }
    }
  }

  _handleEvent(evt) {
    if (!evt || typeof evt !== 'object') {
      console.warn('⚠ Evento inválido recibido:', evt);
      return;
    }

    if (!evt.type || typeof evt.type !== 'string') {
      console.warn('⚠ Evento sin type válido:', evt);
      return;
    }

    const BEHAVIOR_EVENTS = {
      'BOLSILLO':            { icon: '🤚', label: 'Mano en bolsillo',            color: '#ffaa00' },
      'BRAZOS_CRUZADOS':     { icon: '🙅', label: 'Brazos cruzados / ocultando', color: '#ffaa00' },
      'AGACHADO':            { icon: '⬇',  label: 'Agachado sospechoso',         color: '#ff6d00' },
      'BAJO_ROPA':           { icon: '👕', label: 'Objeto bajo ropa',            color: '#ff3d3d' },
      'BAJO_MANGA':          { icon: '🧥', label: 'Objeto bajo manga',           color: '#ff3d3d' },
      'PANTALLA':            { icon: '🚧', label: 'Pantalla corporal',           color: '#ff6d00' },
      'PERMANENCIA':         { icon: '⏱',  label: 'Permanencia en zona',         color: '#ff3d3d' },
      'ESCANEO':             { icon: '👀', label: 'Escaneo previo a hurto',      color: '#ffaa00' },
      'ZONA_ENTRADA':        { icon: '📍', label: 'Entrada a zona vigilada',     color: '#ffee58' },
      'ROBO_CONFIRMADO':     { icon: '🚨', label: 'ROBO CONFIRMADO',             color: '#ff1744' },
      'PANTALLA_HUMANA':     { icon: '👥', label: 'Pantalla humana / cómplice',  color: '#ff3d3d' },
      'COMPLICE_DISTRACTOR': { icon: '👥', label: 'Cómplice distractor',         color: '#ff3d3d' },
    };

    if (BEHAVIOR_EVENTS[evt.type]) {
      const { icon, label, color } = BEHAVIOR_EVENTS[evt.type];
      const sev      = evt.severity || 'high';
      const score    = evt.score ?? 0;
      const evidence = Array.isArray(evt.evidence) ? evt.evidence : [];
      const trackId  = evt.trackId ?? null;

      console.warn(
        `%c${icon} ${label}${trackId != null ? ` — #${trackId}` : ''} | score:${score}`,
        `color:${color};font-weight:bold`
      );

      this._alertManager?.trigger?.(evt.type, sev, {
        score,
        evidence: [evt.msg || label, ...evidence],
        trackId,
      });

      if (this.onDetection) this.onDetection(evt.type, sev);
      this._saveEvent(evt.type, sev, score, [evt.msg || label, ...evidence]);
      return;
    }

    if (evt.type === 'ALERTA_LSTM') {
      const prob = Number(evt.prob || 0);
      const score = Math.round(prob * 100);
      const trackId = evt.trackId ?? null;

      console.warn(
        `%c🧠 LSTM Hurto${trackId != null ? ` — track #${trackId}` : ''} (${score}%)`,
        'color:#ff3d3d;font-weight:bold'
      );

      this._alertManager?.trigger?.('ALERTA_LSTM', 'high', {
        score,
        evidence: [
          trackId != null ? `Track #${trackId}` : 'Track desconocido',
          `Prob: ${score}%`
        ],
        trackId,
        confidence: prob
      });

      if (this.onDetection) this.onDetection('ALERTA_LSTM', 'high');

      this._saveEvent('ALERTA_LSTM', 'high', score, [
        trackId != null ? `Track:${trackId}` : 'Track:NA',
        `LSTM:${score}%`
      ]);
      return;
    }

    if (evt.type === 'ALERTA_YOLO') {
      const conf = Number(evt.conf || 0);
      const score = Math.round(conf * 100);

      console.warn(
        `%c👁 YOLO Hurto — confianza ${score}%`,
        'color:#ff3d3d;font-weight:bold'
      );

      if (evt.bbox) {
        this._shoplifting.push({ conf, bbox: evt.bbox });
        clearTimeout(this._yoloFlashTimer);
        this._yoloFlashTimer = setTimeout(() => {
          this._shoplifting = [];
        }, 2500);
      }

      this._alertManager?.trigger?.('ALERTA_YOLO', 'high', {
        score,
        evidence: [
          `Conf: ${score}%`,
          'YOLO shoplifting'
        ],
        confidence: conf,
        bbox: evt.bbox || null
      });

      if (this.onDetection) this.onDetection('ALERTA_YOLO', 'high');
      this._saveEvent('ALERTA_YOLO', 'high', score, [`YOLO:${score}%`]);
      return;
    }

    if (evt.type === 'ALERTA_GITHUB') {
      const prob = Number(evt.prob || 0);
      const score = Math.round(prob * 100);

      console.warn(
        `%c🎯 GitHub Hurto — probabilidad ${score}%`,
        'color:#ff3d3d;font-weight:bold'
      );

      this._alertManager?.trigger?.('ALERTA_GITHUB', 'high', {
        score,
        evidence: [`GitHub: ${score}%`],
        confidence: prob
      });

      if (this.onDetection) this.onDetection('ALERTA_GITHUB', 'high');
      this._saveEvent('ALERTA_GITHUB', 'high', score, [`GH:${score}%`]);
      return;
    }

    const sev = evt.severity || 'low';
    const score = evt.score || 0;
    const evidence = Array.isArray(evt.evidence) ? evt.evidence : [];

    this._alertManager?.trigger?.(evt.type, sev, {
      score,
      evidence
    });

    if (this.onDetection) this.onDetection(evt.type, sev);
    this._saveEvent(evt.type, sev, score, evidence);
  }

  _saveEvent(type, severity, score, evidence) {
    // Deshabilitado — eventos guardados solo en Firebase via alerts.js
  }

  // ── start / stop ──────────────────────────────────────────────────────────
  start() {
    this._active = true;
    this._syncZones();
    this._syncConfig();
    this._startRenderLoop();
    console.log('%c▶ Análisis iniciado', 'color:#00e676');
  }

  stop() {
    this._active          = false;
    this._processingFrame = false;
    clearInterval(this._pingTimer);
    this._pingTimer = null;

    if (this._renderRAF) {
      cancelAnimationFrame(this._renderRAF);
      this._renderRAF = null;
    }

    this._tracks      = [];
    this._objects     = [];
    this._shoplifting = [];
    this._lastDets    = [];

    console.log('%c■ Análisis detenido', 'color:#ffaa00');
  }

  // ── processFrame ──────────────────────────────────────────────────────────
  processFrame(videoEl) {
    if (!this._active || !this._wsReady) return;
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    if (this._processingFrame) return;

    this._processingFrame = true;

    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;

    this._offCanvas.width  = Math.min(vw, 320);
    this._offCanvas.height = Math.min(vh, 240);

    this._offCtx.drawImage(videoEl, 0, 0, this._offCanvas.width, this._offCanvas.height);
    const b64 = this._offCanvas.toDataURL('image/jpeg', JPEG_QUALITY);

    this._send({ type: 'frame', data: b64 });
  }

  // ── Config / Zonas ────────────────────────────────────────────────────────
  updateConfig(patch) {
    Object.assign(this._config, patch);
    this._syncConfig();
  }

  setStoreType(type) {
    this._config.storeType = type;
    this._send({ type: 'config', storeType: type });
    const p = PROFILE_DEFAULTS[type] || PROFILE_DEFAULTS.generico;
    return { dwellTime: p.dwellTime, scoreThreshold: p.scoreThreshold };
  }

  _syncConfig() {
    this._send({
      type: 'config',
      storeType: this._config.storeType,
      dwellTime: this._config.dwellTime,
      cooldown: this._config.cooldown,
    });
  }

  _syncZones() {
    const zones = this._zoneManager?.zones || [];
    this._send({ type: 'zones', zones });
  }

  // ── Tracks / Counts ───────────────────────────────────────────────────────
  getTracks() {
    return this._tracks.map(t => ({
      id:         t.id,
      isEmployee: t.isEmployee,
      bbox: {
        nx1: t.bbox?.nx1 ?? 0,
        ny1: t.bbox?.ny1 ?? 0,
        nx2: t.bbox?.nx2 ?? 1,
        ny2: t.bbox?.ny2 ?? 1
      },
      score:     t.score || 0,
      badges:    t.badges || [],
      kps:       t.kps || [],
      lstm_prob: t.lstm_prob ?? 0,
    }));
  }

  getZoneCounts() {
    const zones  = this._zoneManager?.zones || [];
    const tracks = this._tracks.filter(t => !t.isEmployee);
    let inZone   = 0;
    const byZone = {};

    for (const t of tracks) {
      if (!t.inZone) continue;
      inZone++;

      const cx = (t.bbox.nx1 + t.bbox.nx2) / 2;
      const cy = (t.bbox.ny1 + t.bbox.ny2) / 2;

      for (const z of zones) {
        if (this._pip(cx, cy, z.points || [])) {
          byZone[z.name] = (byZone[z.name] || 0) + 1;
        }
      }
    }

    return { total: tracks.length, inZone, byZone };
  }

  markEmployee(trackId) {
    this._send({ type: 'mark_employee', trackId });
  }

  markCustomer(_trackId) {}

  /** Inicia análisis de cámara IP desde el backend (sin CORS). */
  startIPStream(url, protocol = 'mjpeg') {
    this._send({ type: 'ip_stream', url, protocol });
    console.log(`%c📡 IP stream enviado al backend: ${url}`, 'color:#00d4ff');
  }

  /** Detiene el stream IP en el backend. */
  stopIPStream() {
    this._send({ type: 'ip_stream_stop' });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _pip(x, y, pts) {
    let inside = false;
    let j = pts.length - 1;

    for (let i = 0; i < pts.length; i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;

      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
      j = i;
    }

    return inside;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  _startRenderLoop() {
    if (this._renderRAF) cancelAnimationFrame(this._renderRAF);

    const loop = () => {
      if (!this._active) return;
      this._render();
      this._renderRAF = requestAnimationFrame(loop);
    };

    this._renderRAF = requestAnimationFrame(loop);
  }

  _render() {
    const cw = this._canvas.width;
    const ch = this._canvas.height;
    const ctx = this._ctx;

    ctx.clearRect(0, 0, cw, ch);
    this._zoneManager?.drawZone?.(false);
    this._zoneManager?.drawPreview?.();

    // ── YOLOv8 shoplifting bboxes ──
    for (const det of this._shoplifting) {
      const { nx1, ny1, nx2, ny2 } = det.bbox;
      const [x1, y1, x2, y2] = [nx1 * cw, ny1 * ch, nx2 * cw, ny2 * ch];

      ctx.save();
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth   = 2.5;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);

      const lbl = `🚨 HURTO ${Math.round(det.conf * 100)}%`;
      ctx.font = `bold 11px ${this._font}`;
      const lw = ctx.measureText(lbl).width + 8;

      ctx.fillStyle = 'rgba(255,23,68,0.85)';
      ctx.fillRect(x1, y1 - 18, lw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(lbl, x1 + 4, y1 - 5);
      ctx.restore();
    }

    // ── Objetos ──
    for (const obj of this._objects) {
      const { nx1, ny1, nx2, ny2 } = obj.bbox;
      const [x1, y1, x2, y2] = [nx1 * cw, ny1 * ch, nx2 * cw, ny2 * ch];

      const col = obj.bySize
        ? 'rgba(255,255,100,0.75)'
        : obj.label?.includes('BOLSO')
          ? 'rgba(191,90,242,0.9)'
          : 'rgba(255,170,0,0.85)';

      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);

      const lbl = `${obj.label} ${Math.round((obj.conf || 0) * 100)}%${obj.bySize ? ' ≈' : ''}`;
      ctx.font = `9px ${this._font}`;
      const lw = ctx.measureText(lbl).width + 6;

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x1, y1 - 14, lw, 13);
      ctx.fillStyle = col;
      ctx.fillText(lbl, x1 + 3, y1 - 4);
      ctx.restore();
    }

    // ── Personas ──
    const BONES = [[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
    const KP_T  = 0.25;

    for (const tr of this._tracks) {
      const { nx1, ny1, nx2, ny2 } = tr.bbox;
      const [x1, y1, x2, y2] = [nx1 * cw, ny1 * ch, nx2 * cw, ny2 * ch];

      const isEmployee   = tr.is_employee ?? tr.isEmployee ?? false;
      const inZone       = tr.in_zone ?? tr.inZone ?? false;
      const hasPC        = tr.has_post_contact ?? tr.hasPostContact ?? false;
      const score        = tr.score ?? 0;
      const hasLstmAlert = (tr.lstm_prob ?? 0) >= 0.65;
      const isConfirmed  = score >= 70 || (tr.badges || []).some(b => b.includes('ROBO'));

      const col = isEmployee
        ? 'rgba(0,230,118,0.65)'
        : isConfirmed
          ? '#ff1744'
          : hasLstmAlert
            ? '#ff3d3d'
            : inZone
              ? '#ff6d00'
              : hasPC
                ? '#ffaa00'
                : 'rgba(0,200,255,0.5)';

      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = (inZone || hasPC || hasLstmAlert || isConfirmed) ? 2.2 : 1.5;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      ctx.font = `10px ${this._font}`;
      ctx.fillStyle = col;

      let label = `${isEmployee ? '👷 ' : ''}#${tr.id} ${score}pts`;
      if (hasLstmAlert) label += ` 🧠${Math.round((tr.lstm_prob || 0) * 100)}%`;
      ctx.fillText(label, x1 + 3, y1 - 4);

      if (score > 20 && !isEmployee) {
        const bw = x2 - x1;
        const fw = bw * Math.min(score, 100) / 100;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x1, y2 - 4, bw, 4);
        ctx.fillStyle = score >= 70 ? '#ff1744' : score >= 40 ? '#ffaa00' : '#ffee58';
        ctx.fillRect(x1, y2 - 4, fw, 4);
      }

      const kps = tr.kps || [];

      for (const [a, b] of BONES) {
        if ((kps[a]?.c || 0) < KP_T || (kps[b]?.c || 0) < KP_T) continue;

        ctx.beginPath();
        ctx.moveTo(kps[a].x * cw, kps[a].y * ch);
        ctx.lineTo(kps[b].x * cw, kps[b].y * ch);
        ctx.strokeStyle = isEmployee
          ? 'rgba(0,230,118,0.4)'
          : isConfirmed
            ? 'rgba(255,23,68,0.6)'
            : hasLstmAlert
              ? 'rgba(255,61,61,0.6)'
              : 'rgba(0,200,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (let i = 0; i < 17; i++) {
        const p = kps[i];
        if (!p || p.c < KP_T) continue;

        const isW = i === 9 || i === 10;
        const isH = i === 11 || i === 12;

        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, isW ? 6 : isH ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isEmployee
          ? 'rgba(0,230,118,0.85)'
          : isConfirmed
            ? '#ff1744'
            : isW
              ? '#ffb800'
              : isH
                ? '#bf5af2'
                : 'rgba(255,255,255,0.7)';
        ctx.fill();
      }

      const allBadges = [...(tr.badges || [])];
      if (hasLstmAlert && !allBadges.includes('HURTO-LSTM')) {
        allBadges.push('HURTO-LSTM');
      }

      if (allBadges.length) {
        ctx.font = `bold 9px ${this._font}`;
        let bx = x1;
        let by = y2 + 13;

        for (const badge of allBadges) {
          const isAlert = badge.includes('HURTO') || badge.includes('ROBO') || badge.includes('ALERTA');

          ctx.fillStyle = isAlert
            ? '#ff1744'
            : badge.includes('ZONA') || badge.includes('PERMANENCIA')
              ? '#ff6d00'
              : badge.includes('👷')
                ? '#00e676'
                : '#ffaa00';

          ctx.fillText(badge, bx, by);
          bx += ctx.measureText(badge).width + 8;
        }
      }

      ctx.restore();
    }
  }
}