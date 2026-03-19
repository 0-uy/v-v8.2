"""
api/websocket.py — Veesion Backend v7
"""

import asyncio
import base64
import json
import logging
import numpy as np
import torch
import time

from concurrent.futures import ThreadPoolExecutor

import httpx

import cv2
from fastapi import WebSocket, WebSocketDisconnect
from ultralytics import YOLO

from core.inference import engine as inference_engine
from core.detection import DetectionEngine
from core.person_tracker import PersonTracker
from core.detector_github import GitHubShopliftingDetector
from core.behavior_analyzer import BehaviorAnalyzer
from core.fusion_engine import FusionEngine
from core.person_timeline import PersonTimeline
from core.person_reid import PersonReID
from core.product_interaction import ProductInteractionDetector
from core.pocket_detector import PocketDetector

logger = logging.getLogger(__name__)

# ─────────────────────────────
# CONFIG
# ─────────────────────────────

THREADS = 3
SL_EVERY_N_FRAMES = 12
GITHUB_EVERY_N_FRAMES = 18
DEBUG_SCORES = True

_executor = ThreadPoolExecutor(max_workers=THREADS)

_engines = {}
_trackers = {}
_analyzers = {}
_TIMELINES = {}
_REID = {}
_INTERACTIONS = {}
_POCKETS = {}
_ZONES = {}

_DETECTOR_GITHUB = None
_SHOPLIFTING_MODEL = None

_FUSION_ENGINE = FusionEngine()
_last_thumbs: dict = {}  # camera_id → último thumbnail generado

# ─────────────────────────────
# HELPERS
# ─────────────────────────────

def _bbox_iou(a, b):
    ax1, ay1, ax2, ay2 = a["nx1"], a["ny1"], a["nx2"], a["ny2"]
    bx1, by1, bx2, by2 = b["nx1"], b["ny1"], b["nx2"], b["ny2"]

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih

    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)

    union = area_a + area_b - inter + 1e-6
    return inter / union


def _deduplicate_tracks(tracks):
    """
    Elimina tracks duplicados cuando dos bbox se pisan demasiado.
    Conserva el track con mejor score visible.
    """
    if not tracks:
        return tracks

    filtered = []

    for t in tracks:
        bbox_a = t.get("bbox")
        if not bbox_a:
            filtered.append(t)
            continue

        duplicate_idx = None

        for i, f in enumerate(filtered):
            bbox_b = f.get("bbox")
            if not bbox_b:
                continue

            iou = _bbox_iou(bbox_a, bbox_b)

            if iou > 0.55:
                duplicate_idx = i
                break

        if duplicate_idx is None:
            filtered.append(t)
            continue

        old = filtered[duplicate_idx]

        old_score = float(old.get("behavior_score", 0.0) or 0.0) + float(old.get("lstm_prob", 0.0) or 0.0)
        new_score = float(t.get("behavior_score", 0.0) or 0.0) + float(t.get("lstm_prob", 0.0) or 0.0)

        if new_score > old_score:
            filtered[duplicate_idx] = t

    return filtered


# ─────────────────────────────
# MODELOS
# ─────────────────────────────

def get_shoplifting_model():
    global _SHOPLIFTING_MODEL

    if _SHOPLIFTING_MODEL is None:
        try:
            _SHOPLIFTING_MODEL = YOLO("models/shoplifting_wights.pt")
            logger.info("YOLO shoplifting cargado")
        except Exception as e:
            logger.error(f"Error cargando YOLO shoplifting: {e}")

    return _SHOPLIFTING_MODEL


def get_detector_github():
    global _DETECTOR_GITHUB

    if _DETECTOR_GITHUB is None:
        try:
            _DETECTOR_GITHUB = GitHubShopliftingDetector(
                "models/shoplifting_detector.pth"
            )
            logger.info("Detector GitHub cargado")
        except Exception as e:
            logger.error(f"Error cargando detector GitHub: {e}")

    return _DETECTOR_GITHUB


# ─────────────────────────────
# INSTANCIAS POR CAMARA
# ─────────────────────────────

def get_engine(camera_id):
    if camera_id not in _engines:
        _engines[camera_id] = DetectionEngine(camera_id)
    return _engines[camera_id]


def get_tracker(camera_id):
    if camera_id not in _trackers:
        _trackers[camera_id] = PersonTracker()
    return _trackers[camera_id]


def get_analyzer(camera_id):
    if camera_id not in _analyzers:
        _analyzers[camera_id] = BehaviorAnalyzer()
    return _analyzers[camera_id]


def get_timeline(camera_id):
    if camera_id not in _TIMELINES:
        _TIMELINES[camera_id] = PersonTimeline()
    return _TIMELINES[camera_id]


def get_reid(camera_id):
    if camera_id not in _REID:
        _REID[camera_id] = PersonReID()
    return _REID[camera_id]


def get_pocket_detector(camera_id):
    if camera_id not in _POCKETS:
        _POCKETS[camera_id] = PocketDetector()
    return _POCKETS[camera_id]


def get_interaction_detector(camera_id):
    if camera_id not in _INTERACTIONS:
        detector = ProductInteractionDetector()

        detector.set_zones([
            {
                "points": [
                    {"x": 0.2, "y": 0.2},
                    {"x": 0.8, "y": 0.2},
                    {"x": 0.8, "y": 0.6},
                    {"x": 0.2, "y": 0.6},
                ],
                "type": "alerta",
                "name": "default",
            }
        ])

        _INTERACTIONS[camera_id] = detector

    return _INTERACTIONS[camera_id]


# ─────────────────────────────
# ZONAS DESDE FRONTEND
# ─────────────────────────────

def set_camera_zones(camera_id, zones):
    _ZONES[camera_id] = zones

    detector = get_interaction_detector(camera_id)
    detector.set_zones(zones)

    logger.info(f"Cam {camera_id} zonas cargadas: {len(zones)}")


# ─────────────────────────────
# UTILIDADES
# ─────────────────────────────

def decode_frame(frame_bytes):
    try:
        nparr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return frame
    except Exception:
        return None


def infer_frame(frame):
    return inference_engine.process_frame(frame)


# ─────────────────────────────
# YOLO SHOPLIFTING
# ─────────────────────────────

def run_sl_yolo(frame):
    model = get_shoplifting_model()

    if model is None:
        return []

    try:
        h, w = frame.shape[:2]
        results = model(frame, verbose=False, conf=0.25)

        detections = []

        for r in results:
            if r.boxes is None:
                continue

            for box in r.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])

                if cls != 1:
                    continue

                x1, y1, x2, y2 = box.xyxy[0]

                detections.append(
                    {
                        "conf": round(conf, 2),
                        "bbox": {
                            "nx1": float(x1 / w),
                            "ny1": float(y1 / h),
                            "nx2": float(x2 / w),
                            "ny2": float(y2 / h),
                        },
                    }
                )

        return detections

    except Exception as e:
        logger.error(f"YOLO shoplifting error: {e}")
        return []


# ─────────────────────────────
# LSTM
# ─────────────────────────────

def run_lstm(buffers):
    scores = {}

    if inference_engine._sl_lstm is None:
        return scores

    for slot_id, kp_list in buffers.items():
        try:
            seq = np.array(kp_list, dtype=np.float32)
            tensor = torch.FloatTensor(seq).unsqueeze(0)

            with torch.no_grad():
                logits = inference_engine._sl_lstm(tensor)
                prob = torch.softmax(logits, dim=1)[0][1].item()

            scores[slot_id] = prob

        except Exception as e:
            logger.warning(f"LSTM error slot {slot_id}: {e}")

    return scores


# ─────────────────────────────
# FRAME PIPELINE
# ─────────────────────────────

async def process_frame(camera_id, frame_bytes, frame_count):
    start = time.time()

    frame = decode_frame(frame_bytes)
    if frame is None:
        return {}, []

    loop = asyncio.get_running_loop()

    result = await loop.run_in_executor(
        _executor,
        infer_frame,
        frame
    )

    poses = result.get("poses", [])

    analyzer = get_analyzer(camera_id)
    tracks, behavior_events = analyzer.process(
        poses,
        now=time.time()
    )

    if DEBUG_SCORES and behavior_events:
        logger.info(f"Cam {camera_id} behavior_events={behavior_events}")

    behavior_weights = {
        "BOLSILLO": 0.35,
        "AGACHADO": 0.30,
        "BAJO_ROPA": 0.70,
        "BRAZOS_CRUZADOS": 0.25,
        "PANTALLA": 0.20,
        "PERMANENCIA": 0.20,
        "ESCANEO": 0.15,
        "ROBO_CONFIRMADO": 1.00,
        "BAJO_MANGA": 0.60,
        "PANTALLA_HUMANA": 0.40,
        "COMPLICE_DISTRACTOR": 0.35,
    }

    # mapear score por id original del analyzer
    behavior_scores_by_track_id = {}
    behavior_scores_by_index = {}

    for evt in behavior_events:
        evt_type = evt.get("type")
        w = behavior_weights.get(evt_type, 0.0)
        if w <= 0:
            continue

        analyzer_track_id = evt.get("trackId")
        if analyzer_track_id is None:
            analyzer_track_id = evt.get("track_id")
        if analyzer_track_id is None:
            analyzer_track_id = evt.get("id")

        if analyzer_track_id is not None:
            prev = behavior_scores_by_track_id.get(analyzer_track_id, 0.0)
            behavior_scores_by_track_id[analyzer_track_id] = max(prev, w)

        # fallback por índice interno, solo si coincide
        if analyzer_track_id is not None and isinstance(analyzer_track_id, int):
            if 0 <= analyzer_track_id < len(tracks):
                prev = behavior_scores_by_index.get(analyzer_track_id, 0.0)
                behavior_scores_by_index[analyzer_track_id] = max(prev, w)

    eng = get_engine(camera_id)
    eng.process_detections(result)
    legacy_events = eng.pop_events()

    state = eng.get_state()
    state["tracks"] = tracks
    state["shoplifting"] = []

    events = behavior_events + legacy_events

    tracker = get_tracker(camera_id)
    state["tracks"] = tracker.update(tracks)

    # inyectar behavior_score priorizando source_track_id / source_index
    for track in state["tracks"]:
        score = 0.0

        source_track_id = track.get("source_track_id")
        source_index = track.get("source_index")

        if source_track_id in behavior_scores_by_track_id:
            score = max(score, behavior_scores_by_track_id[source_track_id])

        if source_index in behavior_scores_by_index:
            score = max(score, behavior_scores_by_index[source_index])

        # fallback final por bbox
        if score <= 0.0:
            best_score = 0.0
            best_iou = 0.0

            track_bbox = track.get("bbox")
            if track_bbox:
                for idx, src_track in enumerate(tracks):
                    src_bbox = src_track.get("bbox")
                    if not src_bbox:
                        continue

                    iou = _bbox_iou(track_bbox, src_bbox)
                    if iou > best_iou:
                        best_iou = iou
                        best_score = behavior_scores_by_index.get(idx, 0.0)

                if best_iou >= 0.20:
                    score = max(score, best_score)

        track["behavior_score"] = round(score, 2)

    # PRODUCT INTERACTION
    interaction_detector = get_interaction_detector(camera_id)
    interaction_events = interaction_detector.detect(state["tracks"])
    events.extend(interaction_events)

    # POCKET DETECTOR
    pocket_detector = get_pocket_detector(camera_id)
    pocket_events = pocket_detector.detect(state["tracks"])
    events.extend(pocket_events)

    # REID
    reid = get_reid(camera_id)

    for track in state["tracks"]:
        slot_id = track.get("slot_id")
        bbox = track.get("bbox")

        if slot_id is None or bbox is None:
            continue

        new_slot = reid.match(frame, slot_id, bbox)

        track["slot_id"] = new_slot
        track["reid_slot"] = new_slot
        track["id"] = new_slot

    # eliminar duplicados de persona ya con score calculado
    state["tracks"] = _deduplicate_tracks(state["tracks"])

    # TIMELINE
    timeline = get_timeline(camera_id)

    for track in state["tracks"]:
        slot_id = track.get("slot_id")

        if slot_id is None:
            continue

        actions = track.get("actions", [])
        timeline.update(slot_id, actions)

        pattern = timeline.detect_pattern(slot_id)

        if pattern:
            events.append(
                {
                    "type": "ALERTA_PATTERN",
                    "slot_id": slot_id,
                    "pattern": pattern,
                }
            )

    # LSTM
    if frame_count % SL_EVERY_N_FRAMES == 0:
        buffers = tracker.get_buffers_for_lstm()

        if buffers:
            lstm_scores = await loop.run_in_executor(
                _executor,
                run_lstm,
                buffers
            )

            for track in state["tracks"]:
                slot_id = track.get("slot_id")
                prob = lstm_scores.get(slot_id)

                if prob is None:
                    continue

                track["lstm_prob"] = round(prob, 2)

                if prob > 0.65:
                    events.append(
                        {
                            "type": "ALERTA_LSTM",
                            "slot_id": slot_id,
                            "prob": round(prob, 2),
                        }
                    )

    # YOLO
    if frame_count % SL_EVERY_N_FRAMES == 0:
        sl = await loop.run_in_executor(
            _executor,
            run_sl_yolo,
            frame
        )

        state["shoplifting"] = sl

        for det in sl:
            if det["conf"] > 0.65:
                events.append(
                    {
                        "type": "ALERTA_YOLO",
                        "conf": det["conf"],
                        "bbox": det["bbox"],
                    }
                )

    # GITHUB
    github_score = 0.0

    if frame_count % GITHUB_EVERY_N_FRAMES == 0:
        try:
            detector = get_detector_github()

            if detector:
                detected, prob = detector.procesar_frame(
                    camera_id,
                    frame
                )

                github_score = float(prob or 0.0)

                if detected:
                    events.append(
                        {
                            "type": "ALERTA_GITHUB",
                            "prob": round(prob, 2),
                        }
                    )

        except Exception as e:
            logger.error(f"GITHUB detector error: {e}")

    # FUSION + DEBUG
    for track in state.get("tracks", []):
        slot_id = track.get("slot_id")

        if slot_id is None:
            continue

        behavior_score = float(track.get("behavior_score", 0.0) or 0.0)
        lstm_score = float(track.get("lstm_prob", 0.0) or 0.0)

        yolo_score = 0.0
        if state.get("shoplifting"):
            yolo_score = max(
                float(d.get("conf", 0.0) or 0.0)
                for d in state["shoplifting"]
            )

        risk = _FUSION_ENGINE.compute_risk(
            behavior_score=behavior_score,
            lstm_score=lstm_score,
            yolo_score=yolo_score,
            github_score=github_score,
        )

        track["risk_score"] = round(risk, 3)

        if DEBUG_SCORES:
            logger.info(
                f"Cam {camera_id} track={slot_id} "
                f"behavior={behavior_score:.2f} "
                f"lstm={lstm_score:.2f} "
                f"yolo={yolo_score:.2f} "
                f"github={github_score:.2f} "
                f"risk={risk:.2f}"
            )

        fusion_event = _FUSION_ENGINE.evaluate(
            slot_id,
            behavior_score,
            lstm_score,
            yolo_score,
            github_score,
        )

        if fusion_event:
            events.append(fusion_event)

    elapsed = (time.time() - start) * 1000

    if DEBUG_SCORES:
        logger.info(
            f"Cam {camera_id} resumen: "
            f"personas={len(state.get('tracks', []))} "
            f"objetos={len(state.get('objects', [])) if state.get('objects') else 0} "
            f"shoplifting={len(state.get('shoplifting', []))} "
            f"eventos={len(events)}"
        )

    if frame_count % 30 == 0:
        logger.info(
            f"Cam {camera_id} | {elapsed:.0f} ms | {len(poses)} personas"
        )

    # Guardar thumbnail cada 5 frames en variable de estado del proceso
    # Solo se envía al frontend cuando hay alertas reales
    thumb_b64 = None
    try:
        if frame_count % 5 == 0:
            thumb = cv2.resize(frame, (320, 240))
            _, buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 70])
            _last_thumbs[camera_id] = "data:image/jpeg;base64," + base64.b64encode(buf).decode()
        if events:
            thumb_b64 = _last_thumbs.get(camera_id)
    except Exception:
        pass

    return state, events, thumb_b64


_IP_TASKS: dict = {}  # camera_id → asyncio.Task


async def read_mjpeg_stream(url: str, camera_id: int, websocket: WebSocket, frame_count_ref: list):
    """
    Lee el stream MJPEG directamente desde la URL en el servidor.
    Extrae frames JPEG del multipart stream y los procesa como si
    vinieran del frontend. Así no hay CORS ni canvas bloqueado.
    """
    logger.info(f"Cam {camera_id} iniciando lectura MJPEG directo: {url}")
    buffer = b""

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=5.0, pool=5.0),
            follow_redirects=True
        ) as client:
            async with client.stream("GET", url) as response:
                logger.info(f"Cam {camera_id} MJPEG conectado — HTTP {response.status_code}")

                async for chunk in response.aiter_bytes(chunk_size=8192):
                    buffer += chunk

                    # Extraer todos los frames JPEG completos del buffer
                    while True:
                        start = buffer.find(b'\xff\xd8')
                        if start == -1:
                            break
                        end = buffer.find(b'\xff\xd9', start + 2)
                        if end == -1:
                            break

                        frame_bytes = buffer[start:end + 2]
                        buffer = buffer[end + 2:]

                        if len(frame_bytes) < 100:
                            continue  # frame corrupto

                        frame_count_ref[0] += 1

                        try:
                            state, events, thumb = await process_frame(camera_id, frame_bytes, frame_count_ref[0])
                            msg = {
                                "type":       "detection",
                                "cameraId":   camera_id,
                                "frameIndex": frame_count_ref[0],
                                "state":      state,
                                "events":     events,
                            }
                            if thumb:
                                msg["thumb"] = thumb
                            await websocket.send_json(msg)
                        except WebSocketDisconnect:
                            return
                        except Exception as e:
                            logger.warning(f"Cam {camera_id} error enviando detección: {e}")
                            return

                        # ~15 fps máximo para no saturar el servidor
                        await asyncio.sleep(0.067)

    except asyncio.CancelledError:
        logger.info(f"Cam {camera_id} MJPEG stream detenido")
    except httpx.ConnectTimeout:
        logger.error(f"Cam {camera_id} timeout conectando a: {url}")
        try:
            await websocket.send_json({"type": "ip_stream_error", "message": "Timeout — la cámara no responde"})
        except Exception:
            pass
    except Exception as e:
        logger.error(f"Cam {camera_id} MJPEG stream error: {e}")
        try:
            await websocket.send_json({"type": "ip_stream_error", "message": str(e)})
        except Exception:
            pass


# ─────────────────────────────
# WEBSOCKET
# ─────────────────────────────

async def handle_camera_ws(websocket: WebSocket, camera_id: int):
    await websocket.accept()

    logger.info(f"WS conectado cam {camera_id}")

    get_shoplifting_model()
    get_detector_github()

    try:
        await websocket.send_json(
            {"type": "status", "ready": inference_engine.ready}
        )
    except Exception:
        return

    frame_count = 0
    frame_count_ref = [0]  # referencia mutable para el task MJPEG

    try:
        async for raw in websocket.iter_text():
            msg = json.loads(raw)
            t = msg.get("type")

            if t == "frame":
                b64 = msg.get("data")

                if not b64:
                    continue

                if "," in b64:
                    b64 = b64.split(",", 1)[1]

                frame_bytes = base64.b64decode(b64)
                frame_count += 1

                state, events, thumb = await process_frame(
                    camera_id,
                    frame_bytes,
                    frame_count,
                )

                try:
                    msg = {
                        "type": "detection",
                        "cameraId": camera_id,
                        "frameIndex": frame_count,
                        "state": state,
                        "events": events,
                    }
                    if thumb:
                        msg["thumb"] = thumb
                    await websocket.send_json(msg)
                except WebSocketDisconnect:
                    break
                except Exception:
                    break

            elif t == "ip_stream":
                # El frontend manda la URL y el backend lee el stream directamente.
                # Así se evita CORS/canvas completamente para cámaras IP.
                url = msg.get("url", "").strip()
                protocol = msg.get("protocol", "mjpeg")

                # Cancelar stream previo si existía
                prev = _IP_TASKS.get(camera_id)
                if prev and not prev.done():
                    prev.cancel()
                    try:
                        await asyncio.wait_for(asyncio.shield(prev), timeout=2.0)
                    except Exception:
                        pass

                if url and protocol == "mjpeg":
                    task = asyncio.create_task(
                        read_mjpeg_stream(url, camera_id, websocket, frame_count_ref)
                    )
                    _IP_TASKS[camera_id] = task
                    logger.info(f"Cam {camera_id} ip_stream iniciado: {url}")
                    try:
                        await websocket.send_json({"type": "ip_stream_ack", "url": url})
                    except Exception:
                        break
                else:
                    logger.warning(f"Cam {camera_id} protocolo '{protocol}' no soportado en backend-read mode")

            elif t == "ip_stream_stop":
                prev = _IP_TASKS.pop(camera_id, None)
                if prev and not prev.done():
                    prev.cancel()
                logger.info(f"Cam {camera_id} ip_stream detenido")

            elif t == "zones":
                zones = msg.get("zones", [])
                set_camera_zones(camera_id, zones)

                try:
                    await websocket.send_json(
                        {
                            "type": "zones_ack",
                            "cameraId": camera_id,
                            "count": len(zones)
                        }
                    )
                except WebSocketDisconnect:
                    break
                except Exception:
                    break

            elif t == "ping":
                try:
                    await websocket.send_json({"type": "pong"})
                except WebSocketDisconnect:
                    break
                except Exception:
                    break

    except WebSocketDisconnect:
        logger.info(f"WS desconectado cam {camera_id}")

    except Exception as e:
        logger.error(f"WS error cam {camera_id}: {e}")

    finally:
        # Cancelar stream IP si sigue corriendo
        prev = _IP_TASKS.pop(camera_id, None)
        if prev and not prev.done():
            prev.cancel()

        total_frames = frame_count + frame_count_ref[0]
        logger.info(
            f"WS cerrado cam {camera_id} frames={total_frames}"
        )