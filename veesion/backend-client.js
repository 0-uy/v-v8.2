/**
 * backend-client.js — Veesion v1.0
 * ═══════════════════════════════════════════════════════════════════
 * Reemplaza el motor ONNX-in-browser de SSIP.
 * Envía frames al backend via WebSocket y recibe detecciones + eventos.
 *
 * Uso en monitor.html / multicam.html:
 *   import { BackendClient } from './backend-client.js';
 *
 *   const client = new BackendClient({
 *     cameraId: 1,
 *     videoEl:  document.getElementById('video'),
 *     canvasEl: document.getElementById('overlay'),
 *     onEvent:  (evt) => console.log(evt),
 *     onStatus: (ready) => console.log('Modelos:', ready),
 *   });
 *
 *   await client.connect();
 *   client.start();
 */

// URL del backend — se puede sobreescribir antes de importar:
//   window.VEESION_BACKEND_URL = 'wss://mi-backend.fly.dev';
const BACKEND_URL = (
  window.VEESION_BACKEND_URL ||
  (location.hostname === 'localhost'
    ? 'ws://localhost:8000'
    : 'wss://veesion-backend.fly.dev')   // ← reemplazar con tu URL de Fly.io
).replace(/^http/, 'ws');

const FRAME_INTERVAL_MS = 80;    // ~12.5 fps al backend
const JPEG_QUALITY      = 0.75;

export class BackendClient {
  constructor(opts) {
    this.cameraId  = opts.cameraId  || 1;
    this.videoEl   = opts.videoEl;
    this.canvasEl  = opts.canvasEl;
    this.onEvent   = opts.onEvent   || (() => {});
    this.onStatus  = opts.onStatus  || (() => {});
    this.onFps     = opts.onFps     || (() => {});

    this._ws        = null;
    this._active    = false;
    this._loopId    = null;
    this._offCanvas = document.createElement('canvas');
    this._offCtx    = this._offCanvas.getContext('2d');
    this._ctx       = this.canvasEl?.getContext('2d');
    this._lastState = null;
    this._fpsFrames = 0;
    this._fpsLast   = performance.now();
    this.currentFPS = 0;
    this._renderRAF = null;
    this._font      = '"Share Tech Mono", monospace';
  }

  // ── Conexión ─────────────────────────────────────────────────────────────
  async connect() {
    return new Promise((resolve, reject) => {
      const url = `${BACKEND_URL}/ws/camera/${this.cameraId}`;
      console.log(`%c🔌 Conectando a ${url}`, 'color:#00c8ff');
      this._ws = new WebSocket(url);

      this._ws.onopen = () => {
        console.log(`%c✅ WS cámara ${this.cameraId} conectado`, 'color:#00e676');
        this._startRender();
        resolve();
      };
      this._ws.onerror  = (e) => reject(new Error('No se pudo conectar al backend'));
      this._ws.onclose  = () => {
        console.warn('⚠ WS desconectado — reintentando en 3s');
        this._active = false;
        setTimeout(() => this.connect().then(() => { if (this._active) this.start(); }), 3000);
      };
      this._ws.onmessage = (e) => this._onMsg(JSON.parse(e.data));
    });
  }

  _onMsg(msg) {
    if (msg.type === 'status') {
      this.onStatus(msg.ready);
    } else if (msg.type === 'detection') {
      this._lastState = msg.state;
      this._fpsFrames++;
      const now = performance.now();
      if (now - this._fpsLast >= 1000) {
        this.currentFPS = this._fpsFrames;
        this._fpsFrames = 0;
        this._fpsLast   = now;
        this.onFps(this.currentFPS);
      }
      if (msg.events?.length) msg.events.forEach(e => this.onEvent(e));
    } else if (msg.type === 'error') {
      console.error('Backend error:', msg.message);
    }
  }

  // ── Control ───────────────────────────────────────────────────────────────
  start()   { this._active = true;  this._loop(); }
  stop()    { this._active = false; clearTimeout(this._loopId); }
  destroy() { this.stop(); cancelAnimationFrame(this._renderRAF); this._ws?.close(); }

  sendConfig(cfg)      { this._send({ type: 'config', ...cfg }); }
  sendZones(zones)     { this._send({ type: 'zones', zones }); }
  markEmployee(id)     { this._send({ type: 'mark_employee', trackId: id }); }
  ping()               { this._send({ type: 'ping' }); }

  _send(obj) {
    if (this._ws?.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(obj));
  }

  // ── Envío de frames ───────────────────────────────────────────────────────
  _loop() {
    if (!this._active) return;
    this._sendFrame();
    this._loopId = setTimeout(() => this._loop(), FRAME_INTERVAL_MS);
  }

  _sendFrame() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const v = this.videoEl;
    if (!v || v.readyState < 2) return;
    this._offCanvas.width  = Math.min(v.videoWidth  || 640, 640);
    this._offCanvas.height = Math.min(v.videoHeight || 480, 480);
    this._offCtx.drawImage(v, 0, 0, this._offCanvas.width, this._offCanvas.height);
    this._send({ type: 'frame', data: this._offCanvas.toDataURL('image/jpeg', JPEG_QUALITY) });
  }

  // ── Render overlay ────────────────────────────────────────────────────────
  _startRender() {
    const loop = () => { this._render(); this._renderRAF = requestAnimationFrame(loop); };
    this._renderRAF = requestAnimationFrame(loop);
  }

  _render() {
    if (!this._ctx) return;
    const cw = this.canvasEl.width, ch = this.canvasEl.height;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, cw, ch);
    const state = this._lastState;
    if (!state) return;

    // Objetos
    for (const obj of (state.objects || [])) {
      const { nx1,ny1,nx2,ny2 } = obj.bbox;
      const [x1,y1,x2,y2] = [nx1*cw, ny1*ch, nx2*cw, ny2*ch];
      const col = obj.bySize ? 'rgba(255,255,100,0.7)'
                : obj.label?.includes('BOLSO') ? 'rgba(191,90,242,0.9)'
                : 'rgba(255,170,0,0.85)';
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 1.8;
      ctx.setLineDash([4,3]); ctx.strokeRect(x1,y1,x2-x1,y2-y1); ctx.setLineDash([]);
      ctx.font = `9px ${this._font}`;
      const lbl = `${obj.label} ${Math.round(obj.conf*100)}%${obj.bySize?' ≈':''}`;
      const lw  = ctx.measureText(lbl).width + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x1, y1-14, lw, 13);
      ctx.fillStyle = col; ctx.fillText(lbl, x1+3, y1-4);
      ctx.restore();
    }

    // Personas
    const BONES = [[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
    const KP_T  = 0.25;

    for (const tr of (state.tracks || [])) {
      const { nx1,ny1,nx2,ny2 } = tr.bbox;
      const [x1,y1,x2,y2] = [nx1*cw, ny1*ch, nx2*cw, ny2*ch];
      const col = tr.isEmployee      ? 'rgba(0,230,118,0.6)'
                : tr.inZone          ? '#ff3d3d'
                : tr.hasPostContact  ? '#ffaa00'
                : 'rgba(0,200,255,0.5)';

      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = (tr.inZone || tr.hasPostContact) ? 2 : 1.5;
      ctx.strokeRect(x1,y1,x2-x1,y2-y1);
      ctx.fillStyle = col; ctx.font = `10px ${this._font}`;
      ctx.fillText(`${tr.isEmployee ? '👷 ' : ''}${tr.score||0}pts`, x1+3, y1-3);

      // Esqueleto
      const kps = tr.kps || [];
      for (const [a,b] of BONES) {
        if ((kps[a]?.c||0)<KP_T || (kps[b]?.c||0)<KP_T) continue;
        ctx.beginPath();
        ctx.moveTo(kps[a].x*cw, kps[a].y*ch); ctx.lineTo(kps[b].x*cw, kps[b].y*ch);
        ctx.strokeStyle = tr.isEmployee ? 'rgba(0,230,118,0.4)' : 'rgba(0,200,255,0.45)';
        ctx.globalAlpha = 0.7; ctx.stroke(); ctx.globalAlpha = 1;
      }
      for (let i=0; i<17; i++) {
        if (!kps[i] || kps[i].c < KP_T) continue;
        const isW = i===9||i===10; const isH = i===11||i===12;
        ctx.beginPath(); ctx.arc(kps[i].x*cw, kps[i].y*ch, isW?6:isH?4:3, 0, Math.PI*2);
        ctx.fillStyle = tr.isEmployee ? 'rgba(0,230,118,0.8)' : isW ? '#ffb800' : isH ? '#bf5af2' : 'rgba(255,255,255,0.7)';
        ctx.fill();
      }

      // Badges
      if (tr.badges?.length) {
        let bx = x1; const by = y2 + 13;
        ctx.font = `bold 9px ${this._font}`;
        for (const badge of tr.badges) {
          ctx.fillStyle = badge.includes('ZONA') ? '#ff3d3d'
                        : badge.includes('pts')  ? '#ff3d3d'
                        : badge === '👷'          ? '#00e676'
                        : '#ffaa00';
          ctx.fillText(badge, bx, by);
          bx += ctx.measureText(badge).width + 8;
        }
      }
      ctx.restore();
    }
  }
}

/** Guarda un evento en la API REST del backend */
export async function saveEvent(event, backendHttpUrl) {
  try {
    await fetch(`${backendHttpUrl}/api/events`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        camera_id:  event.camera_id || 1,
        event_type: event.type,
        severity:   event.severity,
        score:      event.score || 0,
        evidence:   event.evidence || [],
      }),
    });
  } catch (e) {
    console.warn('No se pudo guardar evento:', e.message);
  }
}
