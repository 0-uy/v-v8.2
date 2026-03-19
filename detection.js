/**
 * detection.js — SSIP v8.6
 * 
 * FIXES v8.6:
 * - [FIX-CONST]   3 constantes indefinidas declaradas: MIN_BODY_CONF, MIN_KPS_FOR_ANALYSIS, EXIT_INTENT_MIN
 * - [FIX-GROUP]   _analyzeGroup ahora se llama en cada ciclo desde _updateTracks
 * - [FIX-TIMERS]  crossedArms, bodyScreen, crouchHide, hipConcealment → time-based (ms) en vez de frame counters
 * - [FIX-GHOST]   Ghost tracks: 10 → 7 frames (balance fantasmas vs re-entradas legítimas)
 * - [FIX-AGACHAR] crouchHide dispara standalone sin postContact (medium) o con (high)
 * - [FIX-TORSO]   _checkTorsoConcealment nuevo, time-based, siempre activo
 */

import { getProfile, getFamily, BAG_IDS, ALERT_IDS, SCORE_BONUS_DEFAULTS, BEHAVIOR_CONFIG } from './store-profiles.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────
const POSE_MODEL   = './yolo26n-pose.onnx';
const OBJ_MODEL    = './yoloe26n.onnx';
const OBJ_FALLBACK = './yolo26n.onnx';
const SEG_MODEL    = './yolov8n-seg.onnx';

const INPUT_W    = 640;
const INPUT_H    = 640;
const CONF_POSE  = 0.25;
const CONF_OBJ   = 0.30;
const KP_THRESH  = 0.18;
const IOU_THRESH = 0.45;

const OBJ_VIS_WINDOW    = 14;
const SAME_OBJ_IOU      = 0.28;
const MIN_BROWSE_MS     = 1500;
const AUTO_EMPLOYEE_MIN = 5;
const SCREEN_MAX_DIST   = 0.35;
const DISTRACTOR_PAY_DIST = 0.30;
const EXIT_SCORE_MEMORY_MS = 30000;
const MAX_HISTORY       = 90;
const SEQ_WINDOW_MS     = 30000;
const VIGILANCE_WINDOW_MS = 8000;
const VIGILANCE_MULTIPLIER = 3.0;
const SEQ_MULTIPLIER    = 1.5;
const HAND_PINCH_DIST   = 0.06;
const BAG_STATIC_FRAMES = 45;
const BAG_MIN_SCALE     = 0.08;
const ZONE_EXIT_BODY_RATIO = 0.55;
const KP_SMOOTH_FRAMES  = 3;
const KP_INTERP_MAX_GAP = 4;
const POCKET_COOLDOWN_MS = 18000;

// ── Constantes faltantes (causaban undefined → análisis nunca corría) ──
const MIN_BODY_CONF       = 0.15;   // conf mínima para contar un keypoint como visible
const MIN_KPS_FOR_ANALYSIS = 6;     // mínimo de kps visibles para analizar el track
const EXIT_INTENT_MIN     = 0.35;   // dot-product mínimo para activar postContact desde zona

// ── Umbrales temporales para detecciones basadas en tiempo (no en frames) ──
const CROSSED_ARMS_MS   = 1200;  // ms sostenido para BRAZOS CRUZADOS
const BODY_SCREEN_MS    = 1000;  // ms sostenido para PANTALLA CORPORAL
const CROUCH_HIDE_MS    =  800;  // ms sostenido para AGACHADO
const HIP_CONCEAL_MS    =  600;  // ms sostenido para CADERA
const TORSO_CONCEAL_MS  = 1000;  // ms sostenido para BAJO ROPA

// Segmentación
const SEG_MASK_SIZE    = 160;
const SEG_CONF         = 0.40;
const SIL_GROW_THRESH  = 0.045;
const SIL_FRAMES_WAIT  = 4;
const SIL_REGION_TORSO = [0.20, 0.80];
const SIL_REGION_HIP   = [0.55, 1.00];

// MediaPipe
const MP_VISION_CDN  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_VISION_ESM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MP_HAND_MODEL  = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const MH = {
  WRIST:0, THUMB_CMC:1, THUMB_MCP:2, THUMB_IP:3, THUMB_TIP:4,
  INDEX_MCP:5, INDEX_PIP:6, INDEX_DIP:7, INDEX_TIP:8,
  MIDDLE_MCP:9, MIDDLE_PIP:10, MIDDLE_DIP:11, MIDDLE_TIP:12,
  RING_MCP:13, RING_PIP:14, RING_DIP:15, RING_TIP:16,
  PINKY_MCP:17, PINKY_PIP:18, PINKY_DIP:19, PINKY_TIP:20,
};

const KP = {
  NOSE:0, L_EYE:1, R_EYE:2, L_EAR:3, R_EAR:4,
  L_SHOULDER:5, R_SHOULDER:6, L_ELBOW:7, R_ELBOW:8,
  L_WRIST:9, R_WRIST:10, L_HIP:11, R_HIP:12,
  L_KNEE:13, R_KNEE:14, L_ANKLE:15, R_ANKLE:16,
};

const BONES = [
  [5,6],[5,7],[7,9],[6,8],[8,10],
  [5,11],[6,12],[11,12],
  [11,13],[13,15],[12,14],[14,16],
];

let _handLandmarker = null;
let _mpReady        = false;
let _mpLoading      = false;

let _poseSession  = null;
let _objSession   = null;
let _posePromise  = null;
let _objPromise   = null;
let _objModelUsed = null;
let _segSession   = null;
let _segLoading   = false;
let _segReady     = false;

const _ok  = p => p && p.c >= KP_THRESH;
const _d   = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const _mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// ─────────────────────────────────────────────────────────────────────────────
//  SuspicionMemory - Memoria de eventos sospechosos
// ─────────────────────────────────────────────────────────────────────────────
class SuspicionMemory {
  constructor(maxAge = 30000) {
    this.events = [];
    this.maxAge = maxAge;
  }

  addEvent(trackId, type, confidence, position, metadata = {}) {
    this.events.push({
      trackId,
      type,
      confidence,
      position,
      metadata,
      timestamp: Date.now()
    });
    this._cleanup();
  }

  getTrackHistory(trackId) {
    this._cleanup();
    return this.events.filter(e => e.trackId === trackId);
  }

  getSuspicionScore(trackId, weights = {}) {
    const history = this.getTrackHistory(trackId);
    if (history.length === 0) return 0;

    let score = 0;
    const now = Date.now();

    for (const event of history) {
      const age = now - event.timestamp;
      const ageFactor = Math.max(0, 1 - age / this.maxAge);
      const weight = weights[event.type] || 10;
      score += event.confidence * weight * ageFactor;
    }

    return Math.min(100, Math.round(score));
  }

  _cleanup() {
    const now = Date.now();
    this.events = this.events.filter(e => now - e.timestamp < this.maxAge);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BehaviorBuffer - Buffer circular para análisis temporal
// ─────────────────────────────────────────────────────────────────────────────
class BehaviorBuffer {
  constructor(maxSize = 30) {
    this.maxSize = maxSize;
    this.buffers = new Map();
  }

  add(trackId, behavior, value) {
    if (!this.buffers.has(trackId)) {
      this.buffers.set(trackId, new Map());
    }
    
    const trackBuffer = this.buffers.get(trackId);
    if (!trackBuffer.has(behavior)) {
      trackBuffer.set(behavior, []);
    }

    const buffer = trackBuffer.get(behavior);
    buffer.push(value);

    if (buffer.length > this.maxSize) {
      buffer.shift();
    }

    return buffer;
  }

  get(trackId, behavior) {
    return this.buffers.get(trackId)?.get(behavior) || [];
  }

  clear(trackId) {
    this.buffers.delete(trackId);
  }

  analyzeWindow(trackId, behavior, config = { minWindow: 5 }) {
    const buffer = this.get(trackId, behavior);
    if (buffer.length < config.minWindow) {
      return { detected: false, confidence: 0 };
    }

    let confidence = 0;
    
    switch(behavior) {
      case 'pocket':
        confidence = this._analyzePocketPattern(buffer);
        break;
      case 'handObj':
        confidence = this._analyzeHandObjPattern(buffer);
        break;
      default:
        confidence = buffer.filter(v => v).length / buffer.length;
    }

    return {
      detected: confidence >= (config.minConfidence || 0.5),
      confidence
    };
  }

  _analyzePocketPattern(window) {
    const depths = window.map(w => typeof w === 'object' ? w.depth : w);
    let maxConfidence = 0;
    
    for (let i = 2; i < depths.length - 2; i++) {
      const before = depths.slice(0, i).reduce((a, b) => a + b, 0) / i;
      const during = depths[i];
      const after = depths.slice(i + 1).reduce((a, b) => a + b, 0) / (depths.length - i - 1);
      
      const downSlope = before - during;
      const upSlope = during - after;
      
      if (downSlope > 0.1 && upSlope > 0.1 && during > 0.15) {
        const conf = Math.min(1, (downSlope + upSlope) / 0.3);
        maxConfidence = Math.max(maxConfidence, conf);
      }
    }
    
    return maxConfidence;
  }

  _analyzeHandObjPattern(window) {
    let disappearances = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i-1] && !window[i]) disappearances++;
    }
    return Math.min(1, disappearances / (window.length / 2));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ObjTracker (sin cambios significativos)
// ─────────────────────────────────────────────────────────────────────────────
class ObjTracker {
  constructor() {
    this._objs   = {};
    this._nextId = 0;
  }

  update(dets) {
    const matched = new Set();
    for (const [id, obj] of Object.entries(this._objs)) {
      let bestIou = SAME_OBJ_IOU;
      let bestDet = null, bestIdx = -1;
      for (let i = 0; i < dets.length; i++) {
        if (matched.has(i)) continue;
        const iou = this._iou(obj.bbox, dets[i]);
        const sameFam = dets[i].family?.key === obj.family?.key;
        if (iou > bestIou || (sameFam && iou > 0.15)) {
          bestIou = iou; bestDet = dets[i]; bestIdx = i;
        }
      }
      obj.history.push(bestDet !== null);
      if (obj.history.length > OBJ_VIS_WINDOW) obj.history.shift();
      if (bestDet) {
        obj.bbox   = { nx1: bestDet.nx1, ny1: bestDet.ny1, nx2: bestDet.nx2, ny2: bestDet.ny2 };
        obj.cls    = bestDet.cls;
        obj.label  = bestDet.label;
        obj.family = bestDet.family;
        obj.conf   = bestDet.conf;
        obj.visible = true;
        obj.lastSeen = Date.now();
        matched.add(bestIdx);
      } else {
        obj.visible = false;
      }
    }
    for (let i = 0; i < dets.length; i++) {
      if (matched.has(i)) continue;
      const d = dets[i];
      const id = `o${this._nextId++}`;
      this._objs[id] = {
        id, cls: d.cls, family: d.family, label: d.label, conf: d.conf,
        bbox: { nx1: d.nx1, ny1: d.ny1, nx2: d.nx2, ny2: d.ny2 },
        history: [true], visible: true, lastSeen: Date.now(), contactStart: null,
      };
    }
    for (const id of Object.keys(this._objs))
      if (Date.now() - this._objs[id].lastSeen > 5000) delete this._objs[id];
  }

  get visible()      { return Object.values(this._objs).filter(o => o.visible); }
  get alertVisible() { return this.visible.filter(o => o.family && ALERT_IDS.has(o.cls)); }

  disappearedAfterContact(objId) {
    const obj = this._objs[objId];
    if (!obj || obj.history.length < 6) return false;
    const half   = Math.floor(obj.history.length / 2);
    const before = obj.history.slice(0, half);
    const after  = obj.history.slice(half);
    const visBefore = before.filter(Boolean).length / before.length;
    const absAfter  = after.filter(v => !v).length  / after.length;
    return visBefore >= 0.60 && absAfter >= 0.60;
  }

  markContact(objId) {
    const obj = this._objs[objId];
    if (obj) {
      obj.contactStart = Date.now();
      obj.history = new Array(Math.floor(OBJ_VIS_WINDOW * 0.7)).fill(true);
    }
  }

  _iou(a, b) {
    const ix1 = Math.max(a.nx1, b.nx1), iy1 = Math.max(a.ny1, b.ny1);
    const ix2 = Math.min(a.nx2, b.nx2), iy2 = Math.min(a.ny2, b.ny2);
    const I = Math.max(0, ix2-ix1) * Math.max(0, iy2-iy1);
    return I / ((a.nx2-a.nx1)*(a.ny2-a.ny1) + (b.nx2-b.nx1)*(b.ny2-b.ny1) - I + 1e-6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DetectionEngine (VERSIÓN COMPLETA CORREGIDA)
// ─────────────────────────────────────────────────────────────────────────────
export class DetectionEngine {
  constructor(canvas, zoneManager, alertManager, config = {}) {
    this.canvas       = canvas;
    this.ctx          = canvas.getContext('2d');
    this.zoneManager  = zoneManager;
    
    // Guardar AlertManager
    this.alertManager = alertManager;
    
    // Cargar perfil
    this._profile     = getProfile(config.storeType || 'generico');
    
    // Sincronizar perfil con AlertManager
    if (this.alertManager && typeof this.alertManager.setProfile === 'function') {
      this.alertManager.setProfile(this._profile);
    }
    
    this.config = {
      movementThreshold: config.movementThreshold ?? 50,
      dwellTime:         config.dwellTime         ?? this._profile.dwellTime,
      cooldown:          config.cooldown          ?? 8,
      storeType:         config.storeType         ?? 'generico',
    };
    
    this.active        = false;
    this._off          = document.createElement('canvas');
    this._off.width    = INPUT_W;
    this._off.height   = INPUT_H;
    this._offCtx       = this._off.getContext('2d', { willReadFrequently: true });
    this._tracks       = [];
    this._nextId       = 0;
    this._maxHistory   = MAX_HISTORY;
    this._objDets      = [];
    this._objTracker   = new ObjTracker();
    this._interactions = {};
    this._lastAlert    = {};
    this._fpsFrames    = 0;
    this._fpsLast      = performance.now();
    this.currentFPS    = 0;
    this._renderLoopId = null;
    this._lastDets     = [];
    this._lastMpHands  = [];
    this._lastMpHandedness = [];
    this.onDetection   = null;
    this._employeeIds  = new Set();
    this._exitScores   = [];
    this._lastSegMasks = [];

    // Sistemas de memoria y buffer
    this.suspicionMemory = new SuspicionMemory();
    this.behaviorBuffer = new BehaviorBuffer(this._profile.buffer?.maxSize || 30);

    console.log(`%c✓ SSIP v8.5 — ${this._profile.icon} ${this._profile.name}`, 'color:#00d4ff;font-weight:bold');
    if (this.alertManager) {
      console.log('%c✓ AlertManager sincronizado', 'color:#ffaa00');
    }
  }

  // Helper para obtener pesos del perfil
  _getWeight(behavior) {
    return this._profile.scoreBonus?.[behavior] || SCORE_BONUS_DEFAULTS[behavior] || 10;
  }

  // ── API pública ─────────────────────────────────────────────────────────────
  markEmployee(trackId) {
    this._employeeIds.add(trackId);
    const t = this._tracks.find(t => t.id === trackId);
    if (t) { t.isEmployee = true; t.suspicionScore = 0; t.badges = []; }
  }

  markCustomer(trackId) {
    this._employeeIds.delete(trackId);
    const t = this._tracks.find(t => t.id === trackId);
    if (t) t.isEmployee = false;
  }

  getTracks() {
    return this._tracks.map(t => ({
      id: t.id, isEmployee: t.isEmployee,
      score: Math.round(t.suspicionScore),
      bbox: { nx1: t.nx1, ny1: t.ny1, nx2: t.nx2, ny2: t.ny2 },
    }));
  }

  getZoneCounts() {
    const byZone = {};
    let inZone = 0;
    for (const t of this._tracks) {
      if (t.missed || t.isEmployee) continue;
      const active = Object.entries(t.inZoneWrist)
        .filter(([, v]) => v)
        .map(([key]) => {
          const zId = key.slice(2);
          return this.zoneManager.zones.find(z => z.id === zId);
        })
        .filter(Boolean);
      if (active.length > 0) {
        inZone++;
        const seen = new Set();
        for (const z of active) {
          if (!seen.has(z.id)) {
            seen.add(z.id);
            byZone[z.name] = (byZone[z.name] || 0) + 1;
          }
        }
      }
    }
    return { total: this._tracks.filter(t => !t.missed && !t.isEmployee).length, inZone, byZone };
  }

setStoreType(type) {
  this._profile = getProfile(type);
  this.config.storeType = type;
  console.log(`%c🏪 Perfil: ${this._profile.icon} ${this._profile.name}`, 'color:#0B7286');
  
  // Actualizar perfil en AlertManager
  if (this.alertManager && typeof this.alertManager.setProfile === 'function') {
    this.alertManager.setProfile(this._profile);  // ← ESTA LLAMADA ES LA PRIMERA
  }
  
  return this._profile;
}

  // ── Init ────────────────────────────────────────────────────────────────────
  async init() {
    if (!_posePromise) _posePromise = this._loadModel(POSE_MODEL, 'pose');
    if (!_objPromise) {
      _objPromise = this._loadModel(OBJ_MODEL, 'obj').then(() => {
        _objModelUsed = 'yoloe';
        console.log('%c🔥 YOLOE 1200+ clases ACTIVO', 'color:#00ff94;font-weight:bold');
      }).catch(() => {
        console.warn('%c⚠ yoloe26n.onnx no encontrado → fallback yolo26n.onnx', 'color:#ffaa00');
        return this._loadModel(OBJ_FALLBACK, 'obj').then(() => { _objModelUsed = 'yolo'; });
      });
    }
    const [pR, oR] = await Promise.allSettled([_posePromise, _objPromise]);
    if (pR.status === 'rejected') throw new Error('No se pudo cargar yolo26n-pose.onnx');
    if (oR.status === 'rejected') console.warn('%c⚠ Modelo de objetos no disponible', 'color:#ffaa00');
    this._loadMediaPipeHands();
    this._loadSegModel();
    this._startRenderLoop();
  }

  async _loadMediaPipeHands() {
    if (_mpLoading || _mpReady) return;
    _mpLoading = true;
    try {
      let FilesetResolverCls, HandLandmarkerCls;
      if (typeof FilesetResolver !== 'undefined' && typeof HandLandmarker !== 'undefined') {
        FilesetResolverCls = FilesetResolver;
        HandLandmarkerCls  = HandLandmarker;
      } else {
        const mp = await import(MP_VISION_ESM);
        FilesetResolverCls = mp.FilesetResolver;
        HandLandmarkerCls  = mp.HandLandmarker;
      }
      if (!FilesetResolverCls) throw new Error('FilesetResolver no disponible');
      const vision = await FilesetResolverCls.forVisionTasks(`${MP_VISION_CDN}/wasm`);
      _handLandmarker = await HandLandmarkerCls.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_HAND_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 4,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence:  0.5,
        minTrackingConfidence:      0.5,
      });
      _mpReady = true;
      console.log('%c🖐 MediaPipe Hand Landmarks ACTIVO (21pts/mano)', 'color:#bf5af2;font-weight:bold');
    } catch(e) {
      _mpLoading = false;
      console.info(`%cℹ MediaPipe Hand no disponible (${e.message})`, 'color:#888');
    }
  }

  async _loadModel(path, name) {
    if (typeof ort === 'undefined') throw new Error('ONNX Runtime no cargado');
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
    for (const ep of ['webgl', 'wasm']) {
      try {
        const s = await ort.InferenceSession.create(path, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        if (name === 'pose') _poseSession = s; else _objSession = s;
        console.log(`%c✓ YOLO26n-${name} (${ep.toUpperCase()})`, 'color:#00e676;font-weight:bold');
        return;
      } catch(e) { console.warn(`ONNX [${name}/${ep}]:`, e.message); }
    }
    throw new Error(`No se pudo cargar ${path}`);
  }

  async _loadSegModel() {
    if (_segLoading || _segReady) return;
    _segLoading = true;
    try {
      if (typeof ort === 'undefined') throw new Error('ort no disponible');
      for (const ep of ['webgl', 'wasm']) {
        try {
          _segSession = await ort.InferenceSession.create(SEG_MODEL, { executionProviders: [ep], graphOptimizationLevel: 'all' });
          _segReady = true;
          console.log(`%c⬟ YOLOv8n-seg ACTIVO (${ep.toUpperCase()})`, 'color:#ff6b35;font-weight:bold');
          return;
        } catch(e) { /* intentar siguiente EP */ }
      }
      throw new Error('no se pudo cargar yolov8n-seg.onnx');
    } catch(e) {
      _segLoading = false;
      console.info('%cℹ YOLOv8n-seg no disponible', 'color:#888');
    }
  }

  _startRenderLoop() {
    const loop = () => {
      if (!this.active) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.zoneManager.drawZone(false);
        this.zoneManager.drawPreview();
        if (this._lastDets.length) this._drawDetections(this._lastDets);
      }
      this._renderLoopId = requestAnimationFrame(loop);
    };
    this._renderLoopId = requestAnimationFrame(loop);
  }

  // ── Pre/post proceso ────────────────────────────────────────────────────────
  _preprocess(video) {
    const vw = video.videoWidth || video.width || 640;
    const vh = video.videoHeight || video.height || 480;
    const scale = Math.min(INPUT_W/vw, INPUT_H/vh);
    const nw = Math.round(vw*scale), nh = Math.round(vh*scale);
    const dx = (INPUT_W-nw)/2, dy = (INPUT_H-nh)/2;
    this._offCtx.fillStyle = '#808080';
    this._offCtx.fillRect(0,0,INPUT_W,INPUT_H);
    this._offCtx.drawImage(video, dx, dy, nw, nh);
    const px = this._offCtx.getImageData(0,0,INPUT_W,INPUT_H).data;
    const N  = INPUT_W*INPUT_H;
    const f32 = new Float32Array(3*N);
    for (let i=0; i<N; i++) {
      f32[i]     = px[i*4]   /255;
      f32[N+i]   = px[i*4+1] /255;
      f32[2*N+i] = px[i*4+2] /255;
    }
    return [new ort.Tensor('float32', f32, [1,3,INPUT_H,INPUT_W]), {dx,dy,scale,vw,vh}];
  }

  _postprocessPose(output, {dx,dy,scale,vw,vh}) {
    const data=output.data, S=output.dims[2], dets=[];
    for (let i=0;i<S;i++) {
      const conf=data[4*S+i]; if (conf<CONF_POSE) continue;
      const cx=data[0*S+i],cy=data[1*S+i],bw=data[2*S+i],bh=data[3*S+i];
      const n=v=>Math.max(0,Math.min(1,v));
      const nx1=n((cx-bw/2-dx)/(vw*scale)),ny1=n((cy-bh/2-dy)/(vh*scale));
      const nx2=n((cx+bw/2-dx)/(vw*scale)),ny2=n((cy+bh/2-dy)/(vh*scale));
      const kps=[];
      for (let k=0;k<17;k++) kps.push({
        x:n((data[(5+k*3)*S+i]-dx)/(vw*scale)),
        y:n((data[(5+k*3+1)*S+i]-dy)/(vh*scale)),
        c:data[(5+k*3+2)*S+i],
      });
      dets.push({conf,kps,nx1,ny1,nx2,ny2});
    }
    return this._nms(dets).slice(0,8);
  }

  _postprocessObj(output, {dx,dy,scale,vw,vh}) {
    const data=output.data, S=output.dims[2], dets=[];
    for (let i=0;i<S;i++) {
      let bestCls=-1, bestConf=CONF_OBJ;
      for (let c=0;c<80;c++) { const sc=data[(4+c)*S+i]; if (sc>bestConf){bestConf=sc;bestCls=c;} }
      if (bestCls<0) continue;
      const family=getFamily(bestCls);
      if (!family||bestConf<family.minConf) continue;
      const cx=data[0*S+i],cy=data[1*S+i],bw=data[2*S+i],bh=data[3*S+i];
      const n=v=>Math.max(0,Math.min(1,v));
      dets.push({cls:bestCls,conf:bestConf,label:family.label,family,
        nx1:n((cx-bw/2-dx)/(vw*scale)),ny1:n((cy-bh/2-dy)/(vh*scale)),
        nx2:n((cx+bw/2-dx)/(vw*scale)),ny2:n((cy+bh/2-dy)/(vh*scale)),
      });
    }
    return this._nms(dets).slice(0,20);
  }

  _postprocessSeg(segOut, meta, poseDets) {
    // Implementación simplificada
    return [];
  }

  _nms(dets) {
    if (!dets.length) return [];
    dets.sort((a,b)=>b.conf-a.conf);
    const keep=[], drop=new Set();
    for (let i=0;i<dets.length;i++) {
      if (drop.has(i)) continue; keep.push(dets[i]);
      for (let j=i+1;j<dets.length;j++) if (!drop.has(j)&&this._iou(dets[i],dets[j])>IOU_THRESH) drop.add(j);
    }
    return keep;
  }

  _iou(a,b) {
    const ix1=Math.max(a.nx1,b.nx1),iy1=Math.max(a.ny1,b.ny1);
    const ix2=Math.min(a.nx2,b.nx2),iy2=Math.min(a.ny2,b.ny2);
    const I=Math.max(0,ix2-ix1)*Math.max(0,iy2-iy1);
    return I/((a.nx2-a.nx1)*(a.ny2-a.ny1)+(b.nx2-b.nx1)*(b.ny2-b.ny1)-I+1e-6);
  }

  // ── Pipeline principal ────────────────────────────────────────────────────────
  async processFrame(video) {
    if (!this.active || !_poseSession) return;
    
    this._fpsFrames++;
    const now = performance.now();
    if (now - this._fpsLast >= 1000) { 
      this.currentFPS = this._fpsFrames; 
      this._fpsFrames = 0; 
      this._fpsLast = now; 
    }
    
    let tensor, meta;
    try { 
      [tensor, meta] = this._preprocess(video); 
    } catch { 
      return; 
    }
    
    // Detección de poses
    let poseDets = [];
    try {
      const out = await _poseSession.run({ images: tensor });
      poseDets = this._postprocessPose(out.output0 || out[Object.keys(out)[0]], meta);
    } catch(e) { 
      console.warn('Pose:', e.message); 
    }
    
    // Detección de objetos (cada 2 frames para rendimiento)
    let objDets = [];
    if (_objSession && this._fpsFrames % 2 === 0) {
      try {
        const out = await _objSession.run({ images: tensor });
        objDets = this._postprocessObj(out.output0 || out[Object.keys(out)[0]], meta);
      } catch(e) { 
        console.warn('Obj:', e.message); 
      }
    }
    
    if (typeof tensor?.dispose === 'function') tensor.dispose();
    
    this._objTracker.update(objDets);
    this._objDets  = objDets;
    this._lastDets = poseDets;

    // MediaPipe Hands
    if (_mpReady && _handLandmarker && this._fpsFrames % 3 === 1) {
      try {
        const mpResult = _handLandmarker.detectForVideo(video, performance.now());
        this._lastMpHands = mpResult?.landmarks || [];
        this._lastMpHandedness = mpResult?.handedness || [];
      } catch(e) { 
        this._lastMpHands = []; 
      }
    }

    // Actualizar tracks
    this._updateTracks(poseDets, Date.now());

    // Análisis de MediaPipe
    if (_mpReady && this._lastMpHands?.length) {
      this._updateMpGrip(Date.now());
    }

    // Renderizar
    this._render();
  }

  // ── Visibilidad del cuerpo ──────────────────────────────────────────────────
  _isBodyVisible(t) {
    const kps = t.kps || [];
    let visible = 0;
    for (const kp of kps) {
      if (kp && kp.c >= MIN_BODY_CONF) visible++;
    }
    return visible >= MIN_KPS_FOR_ANALYSIS;
  }

  _isLowerBodyVisible(t) {
    const kps = t.kps || [];
    const lowerKPs = [KP.L_HIP, KP.R_HIP, KP.L_KNEE, KP.R_KNEE];
    let visible = 0;
    for (const idx of lowerKPs) {
      if (kps[idx] && kps[idx].c >= MIN_BODY_CONF) visible++;
    }
    return visible >= 2;
  }

  // ── Tracking ────────────────────────────────────────────────────────────────
  _makeTrack(d, now) {
    const pocketThresholds = this._profile.thresholds?.pocket || {};
    
    return {
      id: this._nextId++, 
      kps: d.kps, 
      nx1: d.nx1, ny1: d.ny1, nx2: d.nx2, ny2: d.ny2,
      missed: 0, 
      history: [{kps: d.kps, t: now}], 
      firstSeen: now,
      isEmployee: false, 
      staffZoneTime: 0,
      inZoneWrist: {}, 
      dwellStart: {}, 
      zoneEntryFrames: {},
      pocketL: 0, 
      pocketR: 0, 
      crossedArms: 0,         // legacy (no se usa más, timer reemplaza)
      cajaExit: {}, 
      postContact: null,
      zoneVisits: {}, 
      visitedPay: false,
      noseXHist: [], 
      bodyScreen: 0,           // legacy
      crouchHide: 0,           // legacy
      hipConcealment: 0,       // legacy
      directTrajFired: false, 
      firstZoneEntry: null,
      suspicionScore: 0, 
      scoreEvidence: [], 
      badges: [],
      wristVelHist: {L: [], R: []},
      seqState: {scan: 0, zone: 0, post: 0},
      seqBonusFired: false,
      mpGripConf: {L: 0, R: 0},
      mpPalmIn: {L: false, R: false},
      kpSmooth: Array.from({length:17}, () => ({x:0, y:0, c:0, n:0})),
      kpLastValid: Array.from({length:17}, () => null),
      kpMissingFrames: new Array(17).fill(0),
      vigilanceUntil: 0,
      vigilanceCount: 0,
      bagStaticFrames: {},
      
      // Timers basados en tiempo real (reemplazan contadores de frames)
      crossedArmsStart: null,
      bodyScreenStart:  null,
      crouchHideStart:  null,
      hipConcealStart:  null,
      torsoHideStart:   null,
      
      // Thresholds específicos del perfil
      pocketMinFrames: pocketThresholds.minFramesWithContext || 6,
      pocketMaxHorizDist: pocketThresholds.maxHorizontalDist || 0.16,
      pocketMinVerticalBelow: pocketThresholds.minVerticalBelow || 0.02,
    };
  }

  _updateTracks(dets, now) {
    const matched = new Set();
    
    // Matchear tracks existentes
    for (const t of this._tracks) {
      let best = -1, bestIou = 0.10;
      for (let i = 0; i < dets.length; i++) {
        if (matched.has(i)) continue;
        const iou = this._iou(t, dets[i]);
        if (iou > bestIou) { best = i; bestIou = iou; }
      }
      
      if (best >= 0) {
        const d = dets[best];
        Object.assign(t, {
          kps: d.kps,
          nx1: d.nx1, ny1: d.ny1,
          nx2: d.nx2, ny2: d.ny2,
          missed: 0
        });
        t.history.push({kps: d.kps, t: now});
        if (t.history.length > this._maxHistory) t.history.shift();
        matched.add(best);
      } else {
        t.missed = (t.missed || 0) + 1;
      }
    }
    
    // Limpiar tracks perdidos — 7 frames (~700ms a 10fps): balance entre fantasmas y re-entradas
    this._tracks = this._tracks.filter(t => (t.missed || 0) < 7);
    
    // Crear nuevos tracks
    for (let i = 0; i < dets.length; i++) {
      if (matched.has(i)) continue;
      const nt = this._makeTrack(dets[i], now);
      if (this._employeeIds.has(nt.id)) nt.isEmployee = true;
      this._tracks.push(nt);
    }
    
    // Analizar cada track
    for (const t of this._tracks) {
      if (!t.missed) this._analyze(t, now);
    }
    
    // Análisis grupal — cómplices, pantalla humana, coordinación, formación en V
    this._analyzeGroup(now);
  }

  // ── Análisis por track ──────────────────────────────────────────────────────
  _analyze(t, now) {
    const k = this._smoothKps(t, t.kps);
    const lw = k[KP.L_WRIST], rw = k[KP.R_WRIST];
    const lh = k[KP.L_HIP],   rh = k[KP.R_HIP];
    const le = k[KP.L_ELBOW], re = k[KP.R_ELBOW];
    const ls = k[KP.L_SHOULDER], rs = k[KP.R_SHOULDER];
    const nose = k[KP.NOSE];
    
    t.badges = [];
    this._decayScore(t);
    this._checkAutoEmployee(t, now);
    
    if (t.isEmployee) { 
      t.badges.push('👷'); 
      this._detectZoneDwellOnly(t, lw, rw, now); 
      return; 
    }

    // Verificar visibilidad mínima
    if (!this._isBodyVisible(t)) {
      if (t.postContact && !t.postContact.fired) {
        this._checkPostContact(t, lw, rw, le, re, ls, rs, lh, rh, now);
      }
      return;
    }

    // Análisis de comportamientos
    this._detectZone(t, lw, rw, lh, rh, now);
    this._detectPocket(t, lw, lh, ls, 'L', now);
    this._detectPocket(t, rw, rh, rs, 'R', now);
    this._detectCrossedArms(t, le, re, lw, rw, ls, rs, lh, rh);
    this._detectHandObj(t, lw, rw, now);
    this._checkCajaHeist(t, lw, rw, lh, rh, le, re, now);
    this._checkPostContact(t, lw, rw, le, re, ls, rs, lh, rh, now);
    this._checkTorsoConcealment(t, lw, rw, ls, rs, lh, rh, now);
    
    if (this._profile.behaviors.cadera) this._checkHipConcealment(t, lw, rw, lh, rh, now);
    if (this._profile.behaviors.merodeo) this._checkProwling(t, now);
    if (this._profile.behaviors.escaneo) this._checkScanBehavior(t, nose, now);
    if (this._profile.behaviors.pantalla) this._checkBodyScreen(t, nose);
    if (this._profile.behaviors.agachado) this._checkCrouchHide(t, nose, ls, rs, lh, rh, now);
    if (this._profile.behaviors.trayectoria) this._checkDirectTrajectory(t, now);
    
    this._trackWristVelocity(t, lw, rw, now);
    this._checkMpGrip(t, lw, rw, now);
    this._checkSequenceBonus(t, now);
    this._checkSuspicionScore(t, now);
  }

  // ── [FIX-1][FIX-2][FIX-3][FIX-5] Bolsillo mejorado ──────────────────────────
  _detectPocket(t, wrist, hip, shoulder, side, now) {
    const sk = side === 'L' ? 'pocketL' : 'pocketR';
    const hasPostContact = !!t.postContact;
    const hasContext = hasPostContact || t.suspicionScore > 5;
    
    // Obtener thresholds del perfil
    const pocketThresholds = this._profile.thresholds?.pocket || {};
    const minFramesWithContext = pocketThresholds.minFramesWithContext || 6;
    const minFramesWithoutContext = pocketThresholds.minFramesWithoutContext || 12;
    const maxHorizDist = pocketThresholds.maxHorizontalDist || 0.16;
    const minVerticalBelow = pocketThresholds.minVerticalBelow || 0.02;
    const maxVertRange = 0.22;
    
    // Calcular posición de cadera
    const hipX = (hip && hip.c > 0.12) ? hip.x : (t.nx1 + t.nx2) / 2;
    const hipY = (hip && hip.c > 0.12) ? hip.y : t.ny1 + (t.ny2 - t.ny1) * 0.70;
    
    let pocketConfidence = 0;
    let pocketDepth = 0;
    
    if (!wrist || wrist.c < 0.15) {
      // Muñeca invisible
      if (hasContext && this._isLowerBodyVisible(t)) {
        pocketConfidence = 0.6;
        pocketDepth = 0.2;
      }
    } else if (wrist.c < 0.45) {
      // Muñeca baja confianza
      const isBelow = wrist.y > hipY + minVerticalBelow;
      const isHorizClose = Math.abs(wrist.x - hipX) < maxHorizDist;
      const isInRange = wrist.y < hipY + maxVertRange;
      
      if (isBelow && isHorizClose && isInRange) {
        pocketConfidence = 0.5 + (wrist.c * 0.3);
        pocketDepth = wrist.y - hipY;
      }
    } else {
      // Muñeca alta confianza
      const isBelow = wrist.y > hipY + minVerticalBelow;
      const isHorizClose = Math.abs(wrist.x - hipX) < maxHorizDist;
      const isInRange = wrist.y < hipY + maxVertRange;
      
      if (isBelow && isHorizClose && isInRange) {
        pocketConfidence = 0.7 + (wrist.c * 0.2);
        pocketDepth = wrist.y - hipY;
      }
    }
    
    // Guardar en buffer para análisis temporal
    if (pocketConfidence > 0.3) {
      this.behaviorBuffer.add(t.id, 'pocket', {
        depth: pocketDepth,
        confidence: pocketConfidence,
        time: now
      });
      
      const bufferConfig = BEHAVIOR_CONFIG.pocket || { minWindow: 5 };
      const temporalAnalysis = this.behaviorBuffer.analyzeWindow(t.id, 'pocket', bufferConfig);
      
      if (temporalAnalysis.confidence > 0.5) {
        pocketConfidence = Math.max(pocketConfidence, temporalAnalysis.confidence);
      }
    }
    
    const requiredFrames = hasContext ? minFramesWithContext : minFramesWithoutContext;
    const confidenceThreshold = hasContext ? 0.5 : 0.65;
    
    if (pocketConfidence >= confidenceThreshold) {
      t[sk] += Math.round(pocketConfidence);
      
      if (t[sk] >= requiredFrames) {
        t[sk] = 0;
        
        this.suspicionMemory.addEvent(t.id, 'pocket', pocketConfidence, {
          x: wrist?.x || hipX,
          y: wrist?.y || hipY
        }, { side });
        
        if (hasContext) {
          this._fire(
            `pkt_${side}_${t.id}`,
            `MANO ${side === 'L' ? 'IZQ.' : 'DER.'} EN BOLSILLO`,
            'high',
            POCKET_COOLDOWN_MS,
            {
              trackId: t.id,
              side: side,
              confidence: pocketConfidence,
              type: 'pocket'
            }
          );
          
          const pocketWeight = this._getWeight('pocket');
          this._addScore(t, pocketWeight, `BOLSILLO ${side}`);
        } else {
          const pocketWeight = Math.round(this._getWeight('pocket') * 0.4);
          this._addScore(t, pocketWeight, `BOLSILLO ${side} (leve)`);
        }
      }
      
      if (t[sk] > requiredFrames * 0.7) {
        t.badges.push('⚠ BOLSILLO');
      }
    } else {
      t[sk] = Math.max(0, t[sk] - 2);
    }
  }

  // ── Brazos cruzados ─────────────────────────────────────────────────────────
  _detectCrossedArms(t, le, re, lw, rw, ls, rs, lh, rh) {
    if (!le || !re || !ls || !rs) return;
    
    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;
    const hy = (lh && rh) ? (lh.y + rh.y) / 2 : my + 0.3;
    
    const ok = Math.abs(le.x - mx) < 0.20 && 
               Math.abs(re.x - mx) < 0.20 && 
               le.x > mx && re.x < mx &&
               le.y > my && le.y < hy + 0.08 &&
               re.y > my && re.y < hy + 0.08 &&
               ((!lw || lw.c < 0.40) || (!rw || rw.c < 0.40));
    
    const now = Date.now();
    if (ok) {
      if (!t.crossedArmsStart) t.crossedArmsStart = now;
      const elapsed = now - t.crossedArmsStart;
      
      if (elapsed >= CROSSED_ARMS_MS) {
        t.crossedArmsStart = null;
        this._fire(`cross_${t.id}`, 'BRAZOS CRUZADOS — POSIBLE OCULTAMIENTO', 'high', this.config.cooldown * 1000, {
          trackId: t.id, type: 'crossed_arms'
        });
        const weight = this._getWeight('brazoscruzados');
        this._addScore(t, weight, 'BRAZOS CRUZADOS');
        this.suspicionMemory.addEvent(t.id, 'crossedArms', 0.7, { x: mx, y: my });
      }
      if (elapsed > CROSSED_ARMS_MS * 0.5) t.badges.push('⚠ CRUZADO');
    } else {
      t.crossedArmsStart = null;
    }
  }

  // ── Interacción con objetos ────────────────────────────────────────────────
  _detectHandObj(t, lw, rw, now) {
    const alertObjs = this._objTracker.alertVisible;
    if (!alertObjs.length) return;
    
    const enabledFams = new Set(this._profile.families);
    const handObjThresholds = this._profile.thresholds?.handObj || {};
    const minContactMs = handObjThresholds.minContactMs || 400;
    const maxGrabMs = handObjThresholds.maxGrabMs || 700;
    
    for (const [w, side] of [[lw, 'L'], [rw, 'R']]) {
      if (!_ok(w)) continue;
      
      for (const obj of alertObjs) {
        if (!enabledFams.has(obj.family?.key)) continue;
        if (obj.conf < 0.42) continue;
        
        const margin = 0.06;
        const touching = w.x >= obj.bbox.nx1 - margin && 
                        w.x <= obj.bbox.nx2 + margin &&
                        w.y >= obj.bbox.ny1 - margin && 
                        w.y <= obj.bbox.ny2 + margin;
        
        const intKey = `${t.id}_${obj.id}_${side}`;
        
        if (touching) {
          if (!this._interactions[intKey]) {
            this._interactions[intKey] = {
              startT: now,
              objId: obj.id,
              label: obj.label,
              cls: obj.cls
            };
            this._objTracker.markContact(obj.id);
          }
          
          const dur = now - this._interactions[intKey].startT;
          
          this.behaviorBuffer.add(t.id, 'handObj', true);
          
          if (dur >= minContactMs) {
            const zones = this.zoneManager.getZonesForPoint(
              (obj.bbox.nx1 + obj.bbox.nx2) / 2,
              (obj.bbox.ny1 + obj.bbox.ny2) / 2
            );
            
            if (zones.length > 0) {
              this._fire(
                `oz_${intKey}`,
                `CONTACTO: ${obj.label} EN ${zones[0].name.toUpperCase()}`,
                'low',
                3000,
                {
                  trackId: t.id,
                  obj: obj.label,
                  zone: zones[0].name,
                  duration: dur,
                  type: 'object_contact'
                }
              );
              
              const weight = this._getWeight('contacto');
              this._addScore(t, weight, `CONTACTO ${obj.label}`);
              
              this.suspicionMemory.addEvent(t.id, 'handObj', 0.6, {
                x: w.x, y: w.y
              }, { obj: obj.label, duration: dur });
            }
          }
        } else if (this._interactions[intKey]) {
          const d = this._interactions[intKey];
          delete this._interactions[intKey];
          
          const dur = now - d.startT;
          if (dur < 200) continue;
          
          this.behaviorBuffer.add(t.id, 'handObj', false);
          
          if (!this._objTracker.disappearedAfterContact(d.objId)) continue;
          
          const nearby = this._countNearby(t, 0.22);
          
          if (nearby > 0 && this._profile.behaviors.traspaso) {
            this._fire(
              `hof_${t.id}_${obj.id}`,
              `TRASPASO: ${d.label} (${nearby} persona cerca)`,
              'high',
              this.config.cooldown * 1000,
              {
                trackId: t.id,
                obj: d.label,
                nearby: nearby,
                type: 'handoff'
              }
            );
            
            const weight = this._getWeight('traspaso');
            this._addScore(t, weight, 'TRASPASO');
            
            this.suspicionMemory.addEvent(t.id, 'traspaso', 0.8, {
              x: w.x, y: w.y
            }, { obj: d.label });
            
          } else if (dur <= maxGrabMs) {
            this._fire(
              `grab_${t.id}_${obj.id}_${side}`,
              `ARREBATO: ${d.label}`,
              'high',
              this.config.cooldown * 1000,
              {
                trackId: t.id,
                obj: d.label,
                side: side,
                duration: dur,
                type: 'grab'
              }
            );
            
            const weight = this._getWeight('arrebato');
            this._addScore(t, weight, 'ARREBATO');
            
            this.suspicionMemory.addEvent(t.id, 'grab', 0.9, {
              x: w.x, y: w.y
            }, { obj: d.label, duration: dur });
            
          } else {
            const zn = this._getObjZone(obj.bbox);
            this._fire(
              `og_${t.id}_${obj.id}_${side}`,
              `OBJETO TOMADO${zn}`,
              'high',
              this.config.cooldown * 1000,
              {
                trackId: t.id,
                obj: d.label,
                type: 'object_taken'
              }
            );
            
            const weight = this._getWeight('objetoTomado');
            this._addScore(t, weight, `TOMADO ${d.label}`);
            
            this.suspicionMemory.addEvent(t.id, 'taken', 0.7, {
              x: w.x, y: w.y
            }, { obj: d.label });
          }
          
          if (_ok(w)) {
            const elbow = side === 'L' ? t.kps[KP.L_ELBOW] : t.kps[KP.R_ELBOW];
            t.postContact = {
              disappearT: now,
              label: d.label,
              cls: d.cls,
              side,
              wristY0: w.y,
              elbowY0: _ok(elbow) ? elbow.y : null,
              fired: false
            };
          }
        }
      }
      
      for (const k of Object.keys(this._interactions)) {
        if (k.startsWith(`${t.id}_`) && now - this._interactions[k].startT > 8000) {
          delete this._interactions[k];
        }
      }
    }
  }

  // ── Zonas ──────────────────────────────────────────────────────────────────
  _detectZone(t, lw, rw, lh, rh, now) {
    const P = this._profile;
    
    for (const [w, side] of [[lw, 'L'], [rw, 'R']]) {
      if (!_ok(w)) {
        for (const key of Object.keys(t.inZoneWrist)) {
          if (key.startsWith(side + '_')) {
            t.inZoneWrist[key] = false;
            t.dwellStart[key] = null;
            t.zoneEntryFrames[key] = 0;
          }
        }
        continue;
      }
      
      const zones = this.zoneManager.getZonesForPoint(w.x, w.y);
      
      for (const zone of zones) {
        const key = `${side}_${zone.id}`;
        t.zoneEntryFrames[key] = (t.zoneEntryFrames[key] || 0) + 1;
        
        if (!t.inZoneWrist[key]) {
          const minFrames = Math.max(2, P.zoneEntryFrames);
          if (t.zoneEntryFrames[key] >= minFrames) {
            t.inZoneWrist[key] = true;
            t.dwellStart[key] = now;
            zone.alert = true;
            
            setTimeout(() => { if (zone) zone.alert = false; }, 2000);
            
            this._fire(
              `ze_${t.id}_${key}`,
              `MANO EN ${zone.name.toUpperCase()}`,
              'low',
              1500,
              {
                trackId: t.id,
                zone: zone.name,
                side: side,
                type: 'zone_entry'
              }
            );
            
            this._recordVisit(t, zone, now);
            
            if (zone.type === 'pago') t.visitedPay = true;
            if (!t.firstZoneEntry) t.firstZoneEntry = now;
            
            this.suspicionMemory.addEvent(t.id, 'zoneEntry', 0.5, {
              x: w.x, y: w.y
            }, { zone: zone.name });
          }
        } else {
          const elapsed = (now - (t.dwellStart[key] || now)) / 1000;
          if (elapsed >= this.config.dwellTime) {
            t.dwellStart[key] = now + this.config.dwellTime * 1000;
            
            this._fire(
              `dw_${t.id}_${key}`,
              `PERMANENCIA — ${zone.name.toUpperCase()}`,
              'high',
              this.config.cooldown * 1000,
              {
                trackId: t.id,
                zone: zone.name,
                duration: elapsed,
                type: 'dwell'
              }
            );
            
            const weight = this._getWeight('permanencia');
            this._addScore(t, weight, `PERMANENCIA ${zone.name}`);
            
            this.suspicionMemory.addEvent(t.id, 'zoneDwell', 0.6, {
              x: w.x, y: w.y
            }, { zone: zone.name, seconds: elapsed });
          }
          
          if (t.history.length >= 6) this._detectEscape(t, side, zone, lh, rh);
          t.badges.push('⚠ EN ZONA');
        }
      }
      
      if (zones.length === 0) {
        for (const key of Object.keys(t.inZoneWrist)) {
          if (!key.startsWith(side + '_') || !t.inZoneWrist[key]) continue;
          
          t.inZoneWrist[key] = false;
          t.dwellStart[key] = null;
          t.zoneEntryFrames[key] = 0;
          
          const zId = key.slice(2);
          const z = this.zoneManager.zones.find(z => z.id === zId);
          
          if (z?.type === 'pago' && _ok(w)) {
            t.cajaExit[`${side}_${zId}`] = { t: now, wristY: w.y };
          }
          
          if (z && z.type !== 'pago' && !t.postContact && _ok(w)) {
            const bodyCenter = this._getBodyCenter(t);
            const intentScore = this._calcExitIntent(t, side, w, bodyCenter, now);
            
            if (intentScore >= EXIT_INTENT_MIN) {
              const elbow = side === 'L' ? t.kps[KP.L_ELBOW] : t.kps[KP.R_ELBOW];
              t.postContact = {
                disappearT: now,
                label: `OBJETO EN ${z.name.toUpperCase()}`,
                cls: -1,
                side,
                wristY0: w.y,
                elbowY0: _ok(elbow) ? elbow.y : null,
                fired: false,
                fromZoneExit: true,
                intentScore,
              };
              
              if (t.seqState.zone === 0) t.seqState.zone = now;
            }
          }
        }
        
        for (const key of Object.keys(t.zoneEntryFrames)) {
          if (key.startsWith(side + '_') && !t.inZoneWrist[key]) {
            t.zoneEntryFrames[key] = 0;
          }
        }
      }
    }
  }

  _detectEscape(t, side, zone, lh, rh) {
    if (!lh || !rh) return;
    
    const mid = _mid(lh, rh);
    const hLen = t.history.length;
    const old = t.history[Math.max(0, hLen - 6)];
    const cur = t.history[hLen - 1];
    
    if (!old || !cur) return;
    
    const idx = side === 'L' ? KP.L_WRIST : KP.R_WRIST;
    const pw = old.kps[idx];
    const cw = cur.kps[idx];
    
    if (!_ok(pw) || !_ok(cw)) return;
    if (!this.zoneManager.getZonesForPoint(pw.x, pw.y).some(z => z.id === zone.id)) return;
    
    const pd = _d(pw.x, pw.y, mid.x, mid.y);
    const cd = _d(cw.x, cw.y, mid.x, mid.y);
    
    if (cd < pd * 0.65 && pd > 0.08) {
      this._fire(
        `esc_${t.id}_${zone.id}_${side}`,
        `OBJETO OCULTADO — ${zone.name.toUpperCase()}`,
        'high',
        this.config.cooldown * 1000,
        {
          trackId: t.id,
          zone: zone.name,
          side: side,
          type: 'escape'
        }
      );
      
      const weight = this._getWeight('escapeZona');
      this._addScore(t, weight, `ESCAPE DE ${zone.name}`);
      
      this.suspicionMemory.addEvent(t.id, 'escape', 0.8, {
        x: cw.x, y: cw.y
      }, { zone: zone.name });
    }
  }

  _detectZoneDwellOnly(t, lw, rw, now) {
    for (const [w, side] of [[lw, 'L'], [rw, 'R']]) {
      if (!_ok(w)) continue;
      
      const zones = this.zoneManager.getZonesForPoint(w.x, w.y);
      for (const zone of zones) {
        const key = `${side}_${zone.id}`;
        if (!t.dwellStart[key]) t.dwellStart[key] = now;
        
        if ((now - t.dwellStart[key]) / 1000 >= this.config.dwellTime * 3) {
          t.dwellStart[key] = now + this.config.dwellTime * 3000;
          this._fire(
            `emp_dw_${t.id}_${key}`,
            `EMPLEADO — PERMANENCIA INUSUAL EN ${zone.name.toUpperCase()}`,
            'medium',
            30000,
            {
              trackId: t.id,
              zone: zone.name,
              type: 'employee_dwell'
            }
          );
        }
      }
    }
  }

  // ── Post-contact ────────────────────────────────────────────────────────────
  _checkPostContact(t, lw, rw, le, re, ls, rs, lh, rh, now) {
    const pc = t.postContact;
    if (!pc || pc.fired) return;
    
    if (now - pc.disappearT > this._profile.postContactMs) {
      t.postContact = null;
      return;
    }
    
    const w = pc.side === 'L' ? lw : rw;
    const elbow = pc.side === 'L' ? le : re;
    
    if (!_ok(w)) return;
    
    const hcc = this._profile.hipConcealConf ?? 0.55;
    
    if (w.c < hcc) {
      const weight = this._getWeight('wristOculta');
      this._addScore(t, weight, 'WRIST OCULTA');
    }
    
    // Manga
    if (this._profile.behaviors.manga && pc.elbowY0 !== null && _ok(elbow)) {
      if (w.y < pc.wristY0 - 0.07 && w.y < elbow.y - 0.04) {
        this._fire(
          `slv_${t.id}_${pc.cls}`,
          `MANGA — ${pc.label} BAJO MANGA`,
          'high',
          this.config.cooldown * 1000,
          {
            trackId: t.id,
            obj: pc.label,
            type: 'sleeve'
          }
        );
        
        const weight = this._getWeight('manga');
        this._addScore(t, weight, 'BAJO MANGA');
        
        this.suspicionMemory.addEvent(t.id, 'manga', 0.9, {
          x: w.x, y: w.y
        }, { obj: pc.label });
        
        if (t.seqState.post === 0) t.seqState.post = now;
        pc.fired = true;
        t.postContact = null;
        return;
      }
    }
    
    // Bolso
    if (this._profile.behaviors.bagStuffing) {
      const nearBag = this._objTracker.visible.find(o => 
        BAG_IDS.has(o.cls) && 
        _d(w.x, w.y, (o.bbox.nx1 + o.bbox.nx2) / 2, (o.bbox.ny1 + o.bbox.ny2) / 2) < 0.14 &&
        this._isRealBag(o, t)
      );
      
      if (nearBag) {
        this._fire(
          `bag_${t.id}_${pc.cls}`,
          `BOLSO — ${pc.label} EN BOLSO`,
          'high',
          this.config.cooldown * 1000,
          {
            trackId: t.id,
            obj: pc.label,
            type: 'bag_stuffing'
          }
        );
        
        const weight = this._getWeight('bagStuffing');
        this._addScore(t, weight, 'BAG STUFFING');
        
        this.suspicionMemory.addEvent(t.id, 'bagStuffing', 0.9, {
          x: w.x, y: w.y
        }, { obj: pc.label });
        
        if (t.seqState.post === 0) t.seqState.post = now;
        pc.fired = true;
        t.postContact = null;
        return;
      }
    }
    
    // Bajo ropa
    if (_ok(ls) && _ok(rs) && _ok(lh) && _ok(rh)) {
      const bL = Math.min(ls.x, rs.x, lh.x, rh.x);
      const bR = Math.max(ls.x, rs.x, lh.x, rh.x);
      const bw = (bR - bL);
      const tx1 = bL - bw * 0.15;
      const tx2 = bR + bw * 0.15;
      const ty1 = Math.min(ls.y, rs.y);
      const ty2 = Math.max(lh.y, rh.y) + 0.12;
      
      if (w.x > tx1 && w.x < tx2 && w.y > ty1 && w.y < ty2 && w.c < hcc) {
        this._fire(
          `trso_${t.id}_${pc.cls}`,
          `ROPA — ${pc.label} BAJO ROPA`,
          'high',
          this.config.cooldown * 1000,
          {
            trackId: t.id,
            obj: pc.label,
            type: 'under_clothes'
          }
        );
        
        const weight = this._getWeight('bajoropa');
        this._addScore(t, weight, 'BAJO ROPA');
        
        this.suspicionMemory.addEvent(t.id, 'underClothes', 0.85, {
          x: w.x, y: w.y
        }, { obj: pc.label });
        
        if (t.seqState.post === 0) t.seqState.post = now;
        pc.fired = true;
        t.postContact = null;
        return;
      }
    }
  }

  // ── Cadera ──────────────────────────────────────────────────────────────────
  _checkHipConcealment(t, lw, rw, lh, rh, now) {
    const pc = t.postContact;
    if (!pc || pc.fired) return;
    if (now - pc.disappearT > this._profile.postContactMs) return;
    
    const w = pc.side === 'L' ? lw : rw;
    const hip = pc.side === 'L' ? lh : rh;
    
    if (!_ok(w) || !_ok(hip)) {
      t.hipConcealStart = null;
      return;
    }
    
    const nearHip = _d(w.x, w.y, hip.x, hip.y) < 0.22;
    const atLevel = w.y >= hip.y - 0.08 && w.y <= hip.y + 0.20;
    const moved = pc.wristY0 !== undefined ? Math.abs(w.y - pc.wristY0) > 0.06 : true;
    
    if (nearHip && atLevel && moved) {
      if (!t.hipConcealStart) t.hipConcealStart = now;
      const elapsed = now - t.hipConcealStart;
      
      this._addScore(t, 2, `WRIST CADERA ${pc.side}`);
      
      if (elapsed >= HIP_CONCEAL_MS) {
        t.hipConcealStart = null;
        const cl = w.c < (this._profile.hipConcealConf ?? 0.55) ? 'MANO OCULTA' : 'MANO VISIBLE';
        
        this._fire(
          `hip_${t.id}_${pc.cls}`,
          `CADERA ${pc.side === 'L' ? 'IZQ' : 'DER'} — ${pc.label} (${cl})`,
          'high',
          this.config.cooldown * 1000,
          { trackId: t.id, side: pc.side, obj: pc.label, type: 'hip_concealment' }
        );
        const weight = this._getWeight('cadera');
        this._addScore(t, weight, 'CADERA');
        this.suspicionMemory.addEvent(t.id, 'hipConcealment', 0.8,
          { x: w.x, y: w.y }, { obj: pc.label, side: pc.side });
        pc.fired = true;
        t.postContact = null;
        t.badges.push('⚠ CADERA');
      } else if (elapsed > HIP_CONCEAL_MS * 0.4) {
        t.badges.push('⚠ CADERA');
      }
    } else {
      t.hipConcealStart = null;
    }
  }

  // ── Bajo ropa standalone ─────────────────────────────────────────────────────
  // Muñecas dentro del torso con confianza baja = objeto bajo la ropa
  _checkTorsoConcealment(t, lw, rw, ls, rs, lh, rh, now) {
    if (t.isEmployee || !_ok(ls) || !_ok(rs)) return;
    
    const tL = Math.min(ls.x, rs.x) - 0.08;
    const tR = Math.max(ls.x, rs.x) + 0.08;
    const tT = Math.min(ls.y, rs.y);
    const tB = (_ok(lh) && _ok(rh)) ? Math.max(lh.y, rh.y) + 0.10 : tT + 0.45;
    
    let hits = 0;
    for (const w of [lw, rw]) {
      if (!w) continue;
      if (w.x > tL && w.x < tR && w.y > tT && w.y < tB && w.c < 0.35) hits++;
    }
    
    if (hits === 0) {
      t.torsoHideStart = null;
      return;
    }
    
    if (!t.torsoHideStart) t.torsoHideStart = now;
    const elapsed = now - t.torsoHideStart;
    
    if (elapsed >= TORSO_CONCEAL_MS) {
      t.torsoHideStart = null;
      this._fire(
        `torso_${t.id}`,
        'OBJETO BAJO ROPA — MUÑECAS EN TORSO OCULTAS',
        'high',
        this.config.cooldown * 1000,
        { trackId: t.id, type: 'torso_concealment' }
      );
      const weight = this._getWeight('bajoropa');
      this._addScore(t, weight, 'BAJO ROPA');
      this.suspicionMemory.addEvent(t.id, 'torsoConcealment', 0.80,
        { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 }, {});
      t.badges.push('⚠ BAJO ROPA');
    } else if (elapsed > TORSO_CONCEAL_MS * 0.5) {
      t.badges.push('⚠ BAJO ROPA');
    }
  }

  // ── Caja heist ──────────────────────────────────────────────────────────────
  _checkCajaHeist(t, lw, rw, lh, rh, le, re, now) {
    for (const [w, elbow, hip, side] of [[lw, le, lh, 'L'], [rw, re, rh, 'R']]) {
      for (const [key, state] of Object.entries(t.cajaExit)) {
        if (!key.startsWith(side + '_')) continue;
        if (now - state.t > 2000) {
          delete t.cajaExit[key];
          continue;
        }
        
        if (!_ok(w)) continue;
        
        if (_ok(hip) && w.y > state.wristY + 0.06 && 
            Math.abs(w.x - hip.x) < 0.15 && 
            Math.abs(w.y - hip.y) < 0.18) {
          this._fire(
            `cj_pkt_${key}`,
            'CAJA → BOLSILLO: POSIBLE EXTRACCIÓN',
            'high',
            this.config.cooldown * 1000,
            {
              trackId: t.id,
              type: 'cashier_to_pocket'
            }
          );
          
          const weight = this._getWeight('pocket');
          this._addScore(t, weight, 'CAJA A BOLSILLO');
          
          delete t.cajaExit[key];
          continue;
        }
        
        if (_ok(elbow) && w.y < state.wristY - 0.07 && w.y < elbow.y - 0.04) {
          this._fire(
            `cj_slv_${key}`,
            'CAJA → MANGA: POSIBLE EXTRACCIÓN',
            'high',
            this.config.cooldown * 1000,
            {
              trackId: t.id,
              type: 'cashier_to_sleeve'
            }
          );
          
          const weight = this._getWeight('manga');
          this._addScore(t, weight, 'CAJA A MANGA');
          
          delete t.cajaExit[key];
          continue;
        }
      }
    }
  }

  // ── Merodeo ─────────────────────────────────────────────────────────────────
  _recordVisit(t, zone, now) {
    if (zone.type === 'pago') return;
    if (!t.zoneVisits[zone.id]) t.zoneVisits[zone.id] = [];
    t.zoneVisits[zone.id].push(now);
    t.zoneVisits[zone.id] = t.zoneVisits[zone.id].filter(ts => now - ts < 90000);
  }

  _checkProwling(t, now) {
    for (const [zId, tss] of Object.entries(t.zoneVisits)) {
      if (tss.length < 3 || t.visitedPay) continue;
      const z = this.zoneManager.zones.find(z => z.id === zId);
      
      this._fire(
        `prl_${t.id}_${zId}`,
        `MERODEO — ${tss.length} ACCESOS SIN COMPRA EN ${z?.name?.toUpperCase() || 'ZONA'}`,
        'medium',
        this.config.cooldown * 1500,
        {
          trackId: t.id,
          zone: z?.name,
          visits: tss.length,
          type: 'prowling'
        }
      );
      
      const weight = this._getWeight('merodeo');
      this._addScore(t, weight, 'MERODEO');
      t.badges.push('⚠ MERODEO');
      
      this.suspicionMemory.addEvent(t.id, 'prowling', 0.6, {
        x: (t.nx1 + t.nx2) / 2,
        y: (t.ny1 + t.ny2) / 2
      }, { zone: z?.name, visits: tss.length });
    }
  }

  // ── Escaneo ─────────────────────────────────────────────────────────────────
  _checkScanBehavior(t, nose, now) {
    if (!_ok(nose)) return;
    
    t.noseXHist.push({ x: nose.x, t: now });
    t.noseXHist = t.noseXHist.filter(p => now - p.t < 1500);
    
    if (t.noseXHist.length < 6) return;
    
    const xs = t.noseXHist.map(p => p.x);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    
    if (std < 0.06) return;
    
    const inZone = Object.values(t.inZoneWrist).some(v => v);
    const cx = (t.nx1 + t.nx2) / 2;
    const cy = (t.ny1 + t.ny2) / 2;
    const nearObj = this._objTracker.alertVisible.some(o => 
      _d(cx, cy, (o.bbox.nx1 + o.bbox.nx2) / 2, (o.bbox.ny1 + o.bbox.ny2) / 2) < 0.30
    );
    
    if (!inZone && !nearObj) return;
    
    this._fire(
      `scan_${t.id}`,
      'ESCANEO — COMPORTAMIENTO PREVIO A HURTO',
      'medium',
      this.config.cooldown * 1000,
      {
        trackId: t.id,
        headMovement: std,
        type: 'scanning'
      }
    );
    
    const weight = this._getWeight('escaneo');
    this._addScore(t, weight, 'ESCANEO');
    t.badges.push('⚠ ESCANEO');
    t.noseXHist = [];
    
    if (t.seqState.scan === 0) t.seqState.scan = now;
    
    this.suspicionMemory.addEvent(t.id, 'scanning', 0.7, {
      x: nose.x, y: nose.y
    }, { headMovement: std });
  }

  // ── Pantalla corporal ───────────────────────────────────────────────────────
  _checkBodyScreen(t, nose) {
    const nH = !nose || nose.c < KP_THRESH;
    const wZ = Object.values(t.inZoneWrist).some(v => v);
    const now = Date.now();
    
    if (nH && wZ) {
      if (!t.bodyScreenStart) t.bodyScreenStart = now;
      const elapsed = now - t.bodyScreenStart;
      
      if (elapsed >= BODY_SCREEN_MS) {
        t.bodyScreenStart = null;
        this._fire(
          `bsc_${t.id}`,
          'CUERPO COMO PANTALLA — DE ESPALDAS EN ZONA',
          'high',
          this.config.cooldown * 1000,
          { trackId: t.id, type: 'body_screen' }
        );
        const weight = this._getWeight('pantalla');
        this._addScore(t, weight, 'PANTALLA');
        this.suspicionMemory.addEvent(t.id, 'bodyScreen', 0.8, {
          x: (t.nx1 + t.nx2) / 2, y: (t.ny1 + t.ny2) / 2
        });
      }
      if (elapsed > BODY_SCREEN_MS * 0.5) {
        t.badges.push('⚠ PANTALLA');
        const weight = this._getWeight('pantalla');
        this._addScore(t, Math.round(weight * 0.5), 'PANTALLA');
      }
    } else {
      t.bodyScreenStart = null;
    }
  }

  // ── Agachado ─────────────────────────────────────────────────────────────────
  _checkCrouchHide(t, nose, ls, rs, lh, rh, now) {
    // No requiere postContact — dispara standalone (medium) o con postContact (high)
    if (!_ok(nose) || !_ok(ls) || !_ok(rs)) {
      t.crouchHideStart = null;
      return;
    }
    if (!this._isLowerBodyVisible(t)) return;
    
    const sY = (ls.y + rs.y) / 2;
    const hY = _ok(lh) && _ok(rh) ? (lh.y + rh.y) / 2 : sY + 0.3;
    
    if (nose.y > (sY + hY) / 2 + 0.06) {
      if (!t.crouchHideStart) t.crouchHideStart = now;
      const elapsed = now - t.crouchHideStart;
      
      if (elapsed >= CROUCH_HIDE_MS) {
        t.crouchHideStart = null;
        const hasPC = t.postContact && !t.postContact.fired;
        const label = hasPC ? t.postContact.label : 'ZONA BAJA';
        
        this._fire(
          `crch_${t.id}_${hasPC ? t.postContact.cls : 'solo'}`,
          `AGACHADO — ${label}`,
          hasPC ? 'high' : 'medium',
          this.config.cooldown * 1000,
          { trackId: t.id, obj: label, type: 'crouch' }
        );
        const weight = this._getWeight('agachado');
        this._addScore(t, hasPC ? weight : Math.round(weight * 0.6), 'AGACHADO');
        this.suspicionMemory.addEvent(t.id, 'crouch', hasPC ? 0.85 : 0.6,
          { x: nose.x, y: nose.y }, { obj: label });
        if (hasPC) t.postContact.fired = true;
        t.badges.push('⚠ AGACHADO');
      } else if (elapsed > CROUCH_HIDE_MS * 0.5) {
        t.badges.push('⚠ AGACHADO');
      }
    } else {
      t.crouchHideStart = null;
    }
  }

  // ── Trayectoria directa ─────────────────────────────────────────────────────
  _checkDirectTrajectory(t, now) {
    if (t.directTrajFired || !t.firstZoneEntry) return;
    
    const ms = t.firstZoneEntry - t.firstSeen;
    if (ms < MIN_BROWSE_MS && ms > 0) {
      t.directTrajFired = true;
      const zn = this._getFirstZoneName(t);
      
      this._fire(
        `traj_${t.id}`,
        `ACCESO DIRECTO${zn} — SIN BROWSING`,
        'low',
        this.config.cooldown * 1000,
        {
          trackId: t.id,
          timeToZone: ms,
          type: 'direct_trajectory'
        }
      );
      
      const weight = this._getWeight('trayectoria');
      this._addScore(t, weight, 'TRAYECTORIA DIRECTA');
      t.badges.push('⚠ DIRECTO');
      
      this.suspicionMemory.addEvent(t.id, 'directTrajectory', 0.5, {
        x: (t.nx1 + t.nx2) / 2,
        y: (t.ny1 + t.ny2) / 2
      }, { timeToZone: ms });
    } else if (ms >= MIN_BROWSE_MS) {
      t.directTrajFired = true;
    }
  }

  _getFirstZoneName(t) {
    for (const key of Object.keys(t.inZoneWrist)) {
      const z = this.zoneManager.zones.find(z => z.id === key.slice(2));
      if (z) return ` A ${z.name.toUpperCase()}`;
    }
    return '';
  }

  // ── Análisis grupal ─────────────────────────────────────────────────────────
  _analyzeGroup(now) {
    if (this._tracks.length < 2) return;
    
    const active = this._tracks.filter(t => !t.missed && !t.isEmployee);
    
    if (this._profile.behaviors.distractor) {
      const stealers = active.filter(t => t.postContact && !t.postContact.fired);
      const distractors = active.filter(t => {
        if (stealers.includes(t)) return false;
        
        const nearPay = this.zoneManager.zones.filter(z => z.type === 'pago').some(z => {
          const cx = z.points.reduce((s, p) => s + p.x, 0) / z.points.length;
          const cy = z.points.reduce((s, p) => s + p.y, 0) / z.points.length;
          return _d((t.nx1 + t.nx2) / 2, (t.ny1 + t.ny2) / 2, cx, cy) < DISTRACTOR_PAY_DIST;
        });
        
        return nearPay || ((t.ny1 + t.ny2) / 2 < 0.25);
      });
      
      for (const s of stealers) {
        if (!distractors.length) continue;
        
        this._fire(
          `dist_${s.id}`,
          `CÓMPLICE DISTRACTOR — ${distractors.length} persona${distractors.length > 1 ? 's' : ''} en mostrador`,
          'high',
          this.config.cooldown * 1000,
          {
            trackId: s.id,
            accomplices: distractors.length,
            type: 'distractor'
          }
        );
        
        const weight = this._getWeight('distractor');
        this._addScore(s, weight, 'CÓMPLICE DISTRACTOR');
        s.badges.push('⚠ CÓMPLICE');
        
        this.suspicionMemory.addEvent(s.id, 'distractor', 0.8, {
          x: (s.nx1 + s.nx2) / 2,
          y: (s.ny1 + s.ny2) / 2
        }, { accomplices: distractors.length });
      }
    }
    
    for (const tA of active) {
      if (!Object.values(tA.inZoneWrist).some(v => v)) continue;
      
      for (const tB of active) {
        if (tB.id === tA.id) continue;
        
        const aC = { x: (tA.nx1 + tA.nx2) / 2, y: (tA.ny1 + tA.ny2) / 2 };
        const bC = { x: (tB.nx1 + tB.nx2) / 2, y: (tB.ny1 + tB.ny2) / 2 };
        
        if (bC.y < aC.y - 0.10 && 
            bC.x >= tA.nx1 - 0.10 && 
            bC.x <= tA.nx2 + 0.10 && 
            _d(aC.x, aC.y, bC.x, bC.y) < SCREEN_MAX_DIST) {
          
          this._fire(
            `wall_${tA.id}_${tB.id}`,
            'PANTALLA HUMANA — CÓMPLICE BLOQUEANDO VISTA',
            'high',
            this.config.cooldown * 1000,
            {
              trackId: tA.id,
              blockerId: tB.id,
              type: 'human_shield'
            }
          );
          
          const weight = this._getWeight('pantalla');
          this._addScore(tA, 25, 'PANTALLA HUMANA');
          tA.badges.push('⚠ BLOQUEADO');
          tB.badges.push('⚠ CÓMPLICE');
          
          this.suspicionMemory.addEvent(tA.id, 'humanShield', 0.85, aC, { blockerId: tB.id });
          break;
        }
      }
    }
    
    if (active.length >= 2 && this._profile.behaviors.coordinacion) {
      const scanners = active.filter(t => 
        t.badges.includes('⚠ ESCANEO') || (now - t.seqState.scan < 3000)
      );
      
      if (scanners.length >= 2) {
        const s0 = scanners[0], s1 = scanners[1];
        const dist = _d(
          (s0.nx1 + s0.nx2) / 2, (s0.ny1 + s0.ny2) / 2,
          (s1.nx1 + s1.nx2) / 2, (s1.ny1 + s1.ny2) / 2
        );
        
        if (dist < 0.4) {
          this._fire(
            `grp_scan_${s0.id}_${s1.id}`,
            `COORDINACIÓN — ${scanners.length} PERSONAS ESCANEANDO SIMULTÁNEAMENTE`,
            'high',
            this.config.cooldown * 2000,
            {
              groupSize: scanners.length,
              type: 'group_coordination'
            }
          );
          
          const weight = this._getWeight('coordinacion');
          for (const s of scanners) {
            this._addScore(s, weight, 'ESCANEO COORDINADO');
            s.badges.push('⚠ COORDINADO');
            
            this.suspicionMemory.addEvent(s.id, 'groupCoordination', 0.75, {
              x: (s.nx1 + s.nx2) / 2,
              y: (s.ny1 + s.ny2) / 2
            }, { groupSize: scanners.length });
          }
        }
      }
    }
    
    if (active.length >= 3) {
      const sorted = [...active].sort((a, b) => 
        ((a.nx1 + a.nx2) / 2) - ((b.nx1 + b.nx2) / 2)
      );
      
      const leftC = {
        x: (sorted[0].nx1 + sorted[0].nx2) / 2,
        y: (sorted[0].ny1 + sorted[0].ny2) / 2
      };
      const rightC = {
        x: (sorted[sorted.length - 1].nx1 + sorted[sorted.length - 1].nx2) / 2,
        y: (sorted[sorted.length - 1].ny1 + sorted[sorted.length - 1].ny2) / 2
      };
      const span = rightC.x - leftC.x;
      
      if (span > 0.5) {
        const midOnes = sorted.slice(1, -1).filter(t => {
          const cx = (t.nx1 + t.nx2) / 2;
          const cy = (t.ny1 + t.ny2) / 2;
          return cy < Math.max(leftC.y, rightC.y) - 0.08;
        });
        
        if (midOnes.length >= 1) {
          this._fire(
            `vform_${now}`,
            'FORMACIÓN EN V — POSIBLE BLOQUEO DE CÁMARA',
            'high',
            this.config.cooldown * 3000,
            {
              type: 'v_formation'
            }
          );
          
          const weight = this._getWeight('formacionV');
          for (const t of active) {
            this._addScore(t, weight, 'FORMACIÓN EN V');
            
            this.suspicionMemory.addEvent(t.id, 'vFormation', 0.7, {
              x: (t.nx1 + t.nx2) / 2,
              y: (t.ny1 + t.ny2) / 2
            });
          }
        }
      }
    }
  }

  // ── Utilidades ──────────────────────────────────────────────────────────────
  _getObjZone(bbox) {
    const cx = (bbox.nx1 + bbox.nx2) / 2;
    const cy = (bbox.ny1 + bbox.ny2) / 2;
    const z = this.zoneManager.getZonesForPoint(cx, cy);
    return z.length > 0 ? ` EN ${z[0].name.toUpperCase()}` : '';
  }

  _countNearby(t, maxDist) {
    const cx = (t.nx1 + t.nx2) / 2;
    const cy = (t.ny1 + t.ny2) / 2;
    let n = 0;
    
    for (const o of this._tracks) {
      if (o.id !== t.id && !o.missed && 
          _d(cx, cy, (o.nx1 + o.nx2) / 2, (o.ny1 + o.ny2) / 2) < maxDist) {
        n++;
      }
    }
    return n;
  }

  _getBodyCenter(t) {
    const lh = t.kps[KP.L_HIP];
    const rh = t.kps[KP.R_HIP];
    const ls = t.kps[KP.L_SHOULDER];
    const rs = t.kps[KP.R_SHOULDER];
    
    if (_ok(lh) && _ok(rh)) return _mid(lh, rh);
    if (_ok(ls) && _ok(rs)) return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 + 0.2 };
    return { x: (t.nx1 + t.nx2) / 2, y: (t.ny1 + t.ny2) / 2 };
  }

  _calcExitIntent(t, side, wristNow, bodyCenter, now) {
    const hist = t.history;
    const pastIdx = Math.max(0, hist.length - 8);
    const past = hist[pastIdx];
    if (!past) return 0;
    
    const wIdx = side === 'L' ? KP.L_WRIST : KP.R_WRIST;
    const pastW = past.kps[wIdx];
    if (!_ok(pastW)) return 0;
    
    const dx = wristNow.x - pastW.x;
    const dy = wristNow.y - pastW.y;
    const toBx = bodyCenter.x - wristNow.x;
    const toBy = bodyCenter.y - wristNow.y;
    const toBLen = Math.hypot(toBx, toBy) + 1e-6;
    const dot = (dx * toBx + dy * toBy) / (Math.hypot(dx, dy) + 1e-6) / toBLen;
    const vel = Math.hypot(dx, dy);
    
    if (vel < 0.015) return 0;
    return dot;
  }

  _trackWristVelocity(t, lw, rw, now) {
    for (const [w, side] of [[lw, 'L'], [rw, 'R']]) {
      if (!_ok(w)) {
        t.wristVelHist[side] = [];
        continue;
      }
      
      t.wristVelHist[side].push({ x: w.x, y: w.y, t: now });
      if (t.wristVelHist[side].length > 8) t.wristVelHist[side].shift();
    }
  }

  _getWristVelocity(t, side) {
    const hist = t.wristVelHist[side];
    if (hist.length < 2) return 0;
    
    const a = hist[0];
    const b = hist[hist.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.01) return 0;
    
    return _d(a.x, a.y, b.x, b.y) / dt;
  }

  // ── MediaPipe ───────────────────────────────────────────────────────────────
  _updateMpGrip(now) {
    if (!this._lastMpHands?.length) return;
    
    for (const t of this._tracks) {
      if (t.missed || t.isEmployee) continue;
      
      t.mpGripConf = { L: 0, R: 0 };
      t.mpPalmIn = { L: false, R: false };
      
      for (let hi = 0; hi < this._lastMpHands.length; hi++) {
        const hand = this._lastMpHands[hi];
        const handedness = this._lastMpHandedness?.[hi]?.[0]?.categoryName || 'Right';
        const side = handedness === 'Left' ? 'R' : 'L';
        const mpWrist = hand[MH.WRIST];
        
        if (!mpWrist) continue;
        
        const lw = t.kps[KP.L_WRIST];
        const rw = t.kps[KP.R_WRIST];
        const refW = side === 'L' ? lw : rw;
        
        if (!_ok(refW)) continue;
        
        const dist = _d(mpWrist.x, mpWrist.y, refW.x, refW.y);
        if (dist > 0.15) continue;
        
        const thumbTip = hand[MH.THUMB_TIP];
        const indexTip = hand[MH.INDEX_TIP];
        
        if (thumbTip && indexTip) {
          const pinchDist = _d(thumbTip.x, thumbTip.y, indexTip.x, indexTip.y);
          t.mpGripConf[side] = Math.max(0, 1 - pinchDist / HAND_PINCH_DIST);
        }
        
        const wrist = hand[MH.WRIST];
        const middleMcp = hand[MH.MIDDLE_MCP];
        
        if (wrist && middleMcp) {
          const px = middleMcp.x - wrist.x;
          const py = middleMcp.y - wrist.y;
          t.mpPalmIn[side] = py > 0.05 || Math.abs(px) < 0.1;
        }
      }
    }
  }

  _checkMpGrip(t, lw, rw, now) {
    if (!_mpReady) return;
    
    for (const side of ['L', 'R']) {
      const grip = t.mpGripConf[side];
      if (grip < 0.6) continue;
      
      const w = side === 'L' ? lw : rw;
      if (!_ok(w)) continue;
      
      const inZone = this.zoneManager.getZonesForPoint(w.x, w.y).length > 0;
      
      if (inZone) {
        const weight = this._getWeight('pinchGrip');
        this._addScore(t, weight, 'PINCH GRIP EN ZONA');
        t.badges.push('✋ GRIP');
        
        this.suspicionMemory.addEvent(t.id, 'pinchGrip', grip, {
          x: w.x, y: w.y
        }, { side, inZone });
      }
      
      if (t.postContact && !t.postContact.fired && t.mpPalmIn[side]) {
        this._fire(
          `mpgrip_${t.id}_${side}`,
          `GRIP CONFIRMADO — OBJETO EN MANO (palma oculta)`,
          'high',
          this.config.cooldown * 1000,
          {
            trackId: t.id,
            side: side,
            grip: grip,
            type: 'pinch_grip'
          }
        );
        
        const weight = this._getWeight('pinchGrip') + 15;
        this._addScore(t, weight, 'GRIP MEDIAPIPE');
        t.postContact.mpConfirmed = true;
        t.badges.push('✋ OCULTO');
      }
    }
  }

  // ── Secuencia completa ──────────────────────────────────────────────────────
  _checkSequenceBonus(t, now) {
    if (t.seqBonusFired || t.isEmployee) return;
    
    const { scan, zone, post } = t.seqState;
    if (!scan || !zone || !post) return;
    
    const span = post - scan;
    if (span > 0 && span <= SEQ_WINDOW_MS && zone >= scan && post >= zone) {
      const weight = this._getWeight('secuencia');
      const bonus = Math.round(t.suspicionScore * (SEQ_MULTIPLIER - 1)) + weight;
      
      t.suspicionScore = Math.min(100, t.suspicionScore + bonus);
      t.seqBonusFired = true;
      t.scoreEvidence.push('SECUENCIA COMPLETA');
      
      this._fire(
        `seq_${t.id}`,
        `SECUENCIA COMPLETA — ESCANEO → ZONA → OCULTAMIENTO (${Math.round(span / 1000)}s)`,
        'high',
        this.config.cooldown * 1000,
        {
          trackId: t.id,
          duration: span,
          type: 'full_sequence'
        }
      );
      
      t.badges.push('🔴 SECUENCIA');
      
      this.suspicionMemory.addEvent(t.id, 'fullSequence', 1.0, {
        x: (t.nx1 + t.nx2) / 2,
        y: (t.ny1 + t.ny2) / 2
      }, { duration: span });
    }
  }

  // ── Auto-empleado ───────────────────────────────────────────────────────────
  _checkAutoEmployee(t, now) {
    if (t.isEmployee || t.suspicionScore > 20) return;
    
    if ((now - t.firstSeen) / 60000 >= AUTO_EMPLOYEE_MIN && t.suspicionScore < 5) {
      t.isEmployee = true;
      this._employeeIds.add(t.id);
      console.log(`%c👷 Track #${t.id} auto-empleado`, 'color:#00e676');
    }
  }

  // ── Score ───────────────────────────────────────────────────────────────────
  _addScore(t, pts, reason) {
    if (t.isEmployee) return;
    
    t.suspicionScore = Math.min(100, t.suspicionScore + pts);
    
    if (reason && !t.scoreEvidence.includes(reason)) {
      t.scoreEvidence.push(reason);
      if (t.scoreEvidence.length > 8) t.scoreEvidence.shift();
    }
  }

  _decayScore(t) {
    if (!t.postContact && Object.values(t.inZoneWrist).every(v => !v)) {
      const rate = t.suspicionScore > 50 ? 6 : t.suspicionScore > 25 ? 3 : 2;
      t.suspicionScore = Math.max(0, t.suspicionScore - rate);
    }
    
    if (t.suspicionScore === 0) t.scoreEvidence = [];
  }

  _checkSuspicionScore(t, now) {
    const th = this._profile.scoreThreshold;
    
    if (t.suspicionScore >= th) {
      this._fire(
        `score_${t.id}`,
        `ROBO CONFIRMADO — SCORE ${Math.round(t.suspicionScore)}/100 | ${t.scoreEvidence.slice(-3).join(' + ')}`,
        'high',
        this.config.cooldown * 1000,
        {
          trackId: t.id,
          score: t.suspicionScore,
          evidence: t.scoreEvidence.join(', '),
          type: 'high_score'
        }
      );
      
      t.scoreEvidence = [];
      t.suspicionScore = th * 0.15;
    }
    
    if (t.suspicionScore >= th * 0.55) {
      t.badges.push(`⚠ ${Math.round(t.suspicionScore)}pts`);
    }
  }

  // ── Utilidades de objetos ───────────────────────────────────────────────────
  _isRealBag(obj, t) {
    const personH = t.ny2 - t.ny1;
    const bagH = obj.bbox.ny2 - obj.bbox.ny1;
    const bagW = obj.bbox.nx2 - obj.bbox.nx1;
    
    if (personH > 0 && (bagH / personH < BAG_MIN_SCALE || bagW / personH < BAG_MIN_SCALE)) {
      return false;
    }
    
    const key = obj.id;
    if (!t.bagStaticFrames[key]) {
      t.bagStaticFrames[key] = { frames: 0, lastX: obj.bbox.nx1, lastY: obj.bbox.ny1 };
    }
    
    const bs = t.bagStaticFrames[key];
    const moved = Math.hypot(obj.bbox.nx1 - bs.lastX, obj.bbox.ny1 - bs.lastY) > 0.005;
    
    if (moved) {
      bs.frames = 0;
      bs.lastX = obj.bbox.nx1;
      bs.lastY = obj.bbox.ny1;
    } else {
      bs.frames++;
    }
    
    if (bs.frames >= BAG_STATIC_FRAMES) return false;
    return true;
  }

  // ── Smoothing de keypoints ──────────────────────────────────────────────────
  _smoothKps(t, rawKps) {
    const smoothed = [];
    
    for (let i = 0; i < 17; i++) {
      const raw = rawKps[i];
      const sm = t.kpSmooth[i];
      const lv = t.kpLastValid[i];
      
      if (raw && raw.c >= KP_THRESH) {
        const alpha = 1 / KP_SMOOTH_FRAMES;
        
        if (sm.n === 0) {
          sm.x = raw.x;
          sm.y = raw.y;
          sm.c = raw.c;
        } else {
          sm.x = sm.x * (1 - alpha) + raw.x * alpha;
          sm.y = sm.y * (1 - alpha) + raw.y * alpha;
          sm.c = sm.c * (1 - alpha) + raw.c * alpha;
        }
        
        sm.n++;
        t.kpLastValid[i] = { x: sm.x, y: sm.y, c: sm.c };
        t.kpMissingFrames[i] = 0;
        smoothed.push({ x: sm.x, y: sm.y, c: sm.c });
      } else {
        t.kpMissingFrames[i]++;
        
        if (lv && t.kpMissingFrames[i] <= KP_INTERP_MAX_GAP) {
          const decayedConf = lv.c * (1 - t.kpMissingFrames[i] / KP_INTERP_MAX_GAP);
          smoothed.push({ x: lv.x, y: lv.y, c: Math.max(0, decayedConf) });
        } else {
          smoothed.push(raw || { x: 0, y: 0, c: 0 });
        }
      }
    }
    
    return smoothed;
  }

  // ── Fire alert (VERSIÓN CORREGIDA) ───────────────────
  _fire(key, type, severity = 'medium', coolMs = 3000, metadata = {}) {
    const now = Date.now();
    
    if (now - (this._lastAlert[key] || 0) < coolMs) return;
    this._lastAlert[key] = now;
    
    const enrichedMetadata = {
      ...metadata,
      trackId: metadata.trackId || this._getCurrentTrackId(),
      profile: this._profile?.name,
      storeType: this._profile?.key,
      timestamp: now,
      confidence: metadata.confidence || 0.8,
    };
    
    if (metadata.trackId) {
      const track = this._tracks.find(t => t.id === metadata.trackId);
      if (track) {
        enrichedMetadata.score = track.suspicionScore;
        enrichedMetadata.badges = track.badges?.slice(-3).join(', ');
      }
    }
    
    if (this.alertManager && typeof this.alertManager.trigger === 'function') {
      this.alertManager.trigger(type, severity, enrichedMetadata);
    }
    
    if (this.onDetection) {
      this.onDetection(type, severity);
    }
    
    // Log para debug
    console.log(`%c🚨 ALERTA: ${type} (${severity})`, 'color:#ffaa00');
  }

  // Helper para obtener track ID actual
  _getCurrentTrackId() {
    const activeTrack = this._tracks.find(t => 
      !t?.missed && !t?.isEmployee && 
      t?.inZoneWrist && Object.values(t.inZoneWrist).some(v => v)
    );
    return activeTrack?.id;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  _render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.zoneManager.drawZone(this.zoneManager.zones.some(z => z.alert));
    this.zoneManager.drawPreview();
    this._drawDetections(this._lastDets);
    this._drawModelBadges();
    this._drawScores();
  }

  _drawModelBadges() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 9px "Share Tech Mono", monospace';
    let y = 14;
    
    if (_objModelUsed === 'yoloe') {
      ctx.fillStyle = 'rgba(0,255,148,0.85)';
      ctx.fillText('⬡ YOLOE 1200+', 6, y);
      y += 13;
    } else if (_objModelUsed === 'yolo') {
      ctx.fillStyle = 'rgba(255,170,0,0.70)';
      ctx.fillText('⬡ YOLO 80cls', 6, y);
      y += 13;
    }
    
    if (_mpReady) {
      ctx.fillStyle = 'rgba(191,90,242,0.85)';
      ctx.fillText('🖐 MP-HAND', 6, y);
      y += 13;
    }
    
    if (_segReady) {
      ctx.fillStyle = 'rgba(255,107,53,0.85)';
      ctx.fillText('⬟ SEG-SIL', 6, y);
    }
    
    ctx.restore();
  }

  _drawScores() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 9px "Share Tech Mono", monospace';
    
    for (const t of this._tracks) {
      if (t.missed || t.isEmployee || t.suspicionScore < 10) continue;
      
      const x = (t.nx1 * this.canvas.width + t.nx2 * this.canvas.width) / 2;
      const y = t.ny1 * this.canvas.height - 15;
      
      ctx.fillStyle = t.suspicionScore >= this._profile.scoreThreshold ? '#ff3d3d' : '#ffaa00';
      ctx.fillText(`${Math.round(t.suspicionScore)}pts`, x - 15, y);
    }
    
    ctx.restore();
  }

  _drawDetections(poseDets) {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    
    for (const obj of this._objTracker.alertVisible) {
      const { nx1, ny1, nx2, ny2 } = obj.bbox;
      const x1 = nx1 * cw;
      const y1 = ny1 * ch;
      const x2 = nx2 * cw;
      const y2 = ny2 * ch;
      
      const isBag = BAG_IDS.has(obj.cls);
      const confPct = Math.round(obj.conf * 100);
      const isBagLow = isBag && obj.conf < 0.62;
      const isAnyLow = obj.conf < 0.45;
      
      const col = isBagLow ? 'rgba(140,140,160,0.6)' : 
                  isBag ? 'rgba(191,90,242,0.9)' : 
                  isAnyLow ? 'rgba(180,130,0,0.65)' : 
                  'rgba(255,170,0,0.85)';
      
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      
      const dispLabel = isBagLow ? `OBJETO? ${confPct}%` : 
                        isAnyLow ? `${obj.label}? ${confPct}%` : 
                        `${obj.label} ${confPct}%`;
      
      ctx.font = '9px "Share Tech Mono", monospace';
      const lw2 = ctx.measureText(dispLabel).width + 6;
      
      ctx.fillStyle = isBag ? 'rgba(191,90,242,0.15)' : 'rgba(255,170,0,0.15)';
      ctx.fillRect(x1, y1 - 14, lw2, 13);
      ctx.fillStyle = col;
      ctx.fillText(dispLabel, x1 + 3, y1 - 4);
      ctx.restore();
    }
    
    for (const det of poseDets) {
      const k = det.kps;
      const x1 = det.nx1 * cw;
      const y1 = det.ny1 * ch;
      const x2 = det.nx2 * cw;
      const y2 = det.ny2 * ch;
      
      const track = this._tracks.find(t => !t.missed && this._iou(t, det) > 0.3);
      const isEmp = track?.isEmployee;
      const inZone = track && Object.values(track.inZoneWrist || {}).some(v => v);
      const hasPost = track?.postContact && !track.postContact.fired;
      const scanning = track?.badges?.includes('⚠ ESCANEO');
      const pocket = track?.badges?.some(b => b.includes('BOLSILLO'));
      const hipHide = (track?.hipConcealment ?? 0) > 2;
      const hasCom = track?.badges?.some(b => b.includes('CÓMPLICE') || b.includes('BLOQUEADO'));
      
      const boxCol = isEmp ? 'rgba(0,230,118,0.6)' : 
                     hasCom ? '#ff6b35' : 
                     inZone ? '#ff3d3d' : 
                     hipHide ? '#ff6b35' : 
                     hasPost ? '#ffaa00' : 
                     scanning ? '#bf5af2' : 
                     pocket ? '#ffaa00' : 
                     'rgba(0,200,255,0.45)';
      
      ctx.save();
      ctx.strokeStyle = boxCol;
      ctx.lineWidth = (inZone || hasPost) ? 2 : 1.5;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      
      ctx.fillStyle = boxCol;
      ctx.font = '10px "Share Tech Mono", monospace';
      ctx.fillText(`${isEmp ? '👷' : ''}${Math.round(det.conf * 100)}%`, x1 + 3, y1 - 3);
      
      ctx.save();
      ctx.lineWidth = 1.8;
      for (const [a, b] of BONES) {
        const pa = k[a];
        const pb = k[b];
        if (!_ok(pa) || !_ok(pb)) continue;
        
        ctx.beginPath();
        ctx.moveTo(pa.x * cw, pa.y * ch);
        ctx.lineTo(pb.x * cw, pb.y * ch);
        ctx.strokeStyle = isEmp ? 'rgba(0,230,118,0.4)' : 'rgba(0,200,255,0.5)';
        ctx.globalAlpha = 0.75;
        ctx.stroke();
      }
      ctx.restore();
      
      ctx.globalAlpha = 1;
      for (let i = 0; i < 17; i++) {
        const p = k[i];
        if (!_ok(p)) continue;
        
        const isW = i === KP.L_WRIST || i === KP.R_WRIST;
        const isH = i === KP.L_HIP || i === KP.R_HIP;
        const inZ = isW && this.zoneManager.getZonesForPoint(p.x, p.y).length > 0;
        const onO = isW && this._objTracker.alertVisible.some(o => {
          const m = 0.06;
          return p.x >= o.bbox.nx1 - m && 
                 p.x <= o.bbox.nx2 + m && 
                 p.y >= o.bbox.ny1 - m && 
                 p.y <= o.bbox.ny2 + m;
        });
        
        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, isW ? 6 : isH ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isEmp ? 'rgba(0,230,118,0.8)' : 
                        inZ ? '#ff3d3d' : 
                        isW ? '#ffb800' : 
                        isH ? '#bf5af2' : 
                        'rgba(255,255,255,0.7)';
        ctx.fill();
        
        if ((inZ || onO) && !isEmp) {
          ctx.beginPath();
          ctx.arc(p.x * cw, p.y * ch, 11, 0, Math.PI * 2);
          ctx.strokeStyle = inZ ? '#ff3d3d' : '#ffb800';
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.5 + 0.5 * Math.sin(Date.now() / 200);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        
        if (isH && (track?.hipConcealment ?? 0) > 0) {
          ctx.beginPath();
          ctx.arc(p.x * cw, p.y * ch, 13, 0, Math.PI * 2);
          ctx.strokeStyle = '#ff6b35';
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.3 + 0.4 * Math.sin(Date.now() / 250);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      
      ctx.restore();
    }
  }

  // ── Control ─────────────────────────────────────────────────────────────────
  start() {
    this.active = true;
    this._lastAlert = {};
    this._interactions = {};
    
    for (const t of this._tracks) {
      Object.assign(t, {
        inZoneWrist: {},
        dwellStart: {},
        zoneEntryFrames: {},
        pocketL: 0,
        pocketR: 0,
        crossedArms: 0,
        cajaExit: {},
        postContact: null,
        zoneVisits: {},
        visitedPay: false,
        noseXHist: [],
        bodyScreen: 0,
        crouchHide: 0,
        hipConcealment: 0,
        directTrajFired: false,
        firstZoneEntry: null,
        suspicionScore: 0,
        scoreEvidence: [],
        badges: [],
        wristVelHist: { L: [], R: [] },
        seqState: { scan: 0, zone: 0, post: 0 },
        seqBonusFired: false,
        mpGripConf: { L: 0, R: 0 },
        mpPalmIn: { L: false, R: false },
        kpSmooth: Array.from({ length: 17 }, () => ({ x: 0, y: 0, c: 0, n: 0 })),
        kpLastValid: Array.from({ length: 17 }, () => null),
        kpMissingFrames: new Array(17).fill(0),
        vigilanceUntil: 0,
        vigilanceCount: 0,
        bagStaticFrames: {},
        crossedArmsStart: null,
        bodyScreenStart:  null,
        crouchHideStart:  null,
        hipConcealStart:  null,
        torsoHideStart:   null,
      });
    }
  }

  stop() {
    this.active = false;
  }

  updateConfig(c) {
    Object.assign(this.config, c);
    if (c.storeType) this.setStoreType(c.storeType);
  }

  destroy() {
    if (this._renderLoopId) cancelAnimationFrame(this._renderLoopId);
  }
}