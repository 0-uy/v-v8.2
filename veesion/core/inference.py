"""
core/inference.py — Backend optimizado

Motor de inferencia:
- YOLO26n pose
- YOLO26n objetos
"""

import os
import numpy as np
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

MODELS_DIR = Path(os.getenv("MODELS_DIR", "./models"))

POSE_MODEL = MODELS_DIR / "yolo26n-pose.pt"
OBJ_MODEL = MODELS_DIR / "yolo26n.pt"

INPUT_SIZE = 640

CONF_POSE = 0.35
CONF_OBJ = 0.55

MAX_PEOPLE = 6
MAX_OBJECTS = 12


# ─────────────────────────
# BOLSOS / MOCHILAS
# ─────────────────────────

BAG_IDS = [
    24,  # backpack
    26,  # handbag
    28   # suitcase
]


# ─────────────────────────
# OBJETOS ROBABLES
# ─────────────────────────

ALERT_IDS = [

    # comida
    46, 47, 48, 49, 50,
    51, 52, 53, 54, 55,

    # bebidas
    39, 40, 41,

    # electrónicos
    63, 64, 65, 66, 67,

    # pequeños
    73, 74, 75, 76,

    # cubiertos
    42, 43, 44,
]


class InferenceEngine:

    def __init__(self):

        self._pose_model = None
        self._obj_model = None

        self._ready = False

        self._frame_id = 0
        self._last_objects = []

        # compat websocket
        self._sl_lstm = None


    # ─────────────────────────
    # CARGA MODELOS
    # ─────────────────────────

    def load_models(self):

        from ultralytics import YOLO

        try:

            logger.info("📦 Cargando modelo pose")
            self._pose_model = YOLO(str(POSE_MODEL))

            logger.info("📦 Cargando modelo objetos")
            self._obj_model = YOLO(str(OBJ_MODEL))

            self._ready = True

            logger.info("🔥 Warmup modelos")

            dummy = np.zeros((640, 640, 3), dtype=np.uint8)

            self._pose_model(dummy, imgsz=INPUT_SIZE, verbose=False)
            self._obj_model(dummy, imgsz=INPUT_SIZE, verbose=False)

            logger.info("✅ Inference listo")

        except Exception as e:

            logger.error(f"Error cargando modelos: {e}")
            raise


    # ─────────────────────────

    @property
    def ready(self):
        return self._ready


    # ─────────────────────────
    # PROCESAMIENTO FRAME
    # ─────────────────────────

    def process_frame(self, frame):

        if not self._ready:

            return {
                "poses": [],
                "objects": [],
                "shoplifting": []
            }

        self._frame_id += 1

        poses = self._run_pose(frame)

        # objetos cada 3 frames (optimización)
        if self._frame_id % 3 == 0:

            objects = self._run_obj(frame)
            self._last_objects = objects

        else:

            objects = self._last_objects

        return {

            "poses": poses,
            "objects": objects,
            "shoplifting": []
        }


    # ─────────────────────────
    # POSE
    # ─────────────────────────

    def _run_pose(self, frame):

        poses = []

        try:

            results = self._pose_model(
                frame,
                imgsz=INPUT_SIZE,
                conf=CONF_POSE,
                verbose=False
            )

            if not results:
                return poses

            r = results[0]

            if r.keypoints is None:
                return poses

            boxes = r.boxes

            xy = r.keypoints.xyn.cpu().numpy()

            if r.keypoints.conf is not None:
                conf = r.keypoints.conf.cpu().numpy()
            else:
                conf = None

            for i in range(min(len(boxes), MAX_PEOPLE)):

                x1, y1, x2, y2 = boxes.xyxyn[i].cpu().numpy()

                kp_list = []

                kp_count = min(len(xy[i]), 17)

                for k in range(kp_count):

                    c = float(conf[i][k]) if conf is not None else 1.0

                    kp_list.append({

                        "x": float(xy[i][k][0]),
                        "y": float(xy[i][k][1]),
                        "c": c

                    })

                poses.append({

                    "id": i,

                    "bbox": {

                        "nx1": float(x1),
                        "ny1": float(y1),
                        "nx2": float(x2),
                        "ny2": float(y2),

                    },

                    "kps": kp_list

                })

        except Exception as e:

            logger.warning(f"Pose error: {e}")

        return poses


    # ─────────────────────────
    # OBJETOS
    # ─────────────────────────

    def _run_obj(self, frame):

        objects = []

        try:

            results = self._obj_model(
                frame,
                imgsz=INPUT_SIZE,
                conf=CONF_OBJ,
                verbose=False
            )

            if not results:
                return objects

            r = results[0]

            boxes = r.boxes

            count = 0

            for i in range(len(boxes)):

                if count >= MAX_OBJECTS:
                    break

                cls_id = int(boxes.cls[i])
                conf = float(boxes.conf[i])

                # ignorar persona
                if cls_id == 0:
                    continue

                x1, y1, x2, y2 = boxes.xyxyn[i].cpu().numpy()

                objects.append({

                    "cls": cls_id,
                    "conf": conf,

                    "bbox": {

                        "nx1": float(x1),
                        "ny1": float(y1),
                        "nx2": float(x2),
                        "ny2": float(y2),

                    }

                })

                count += 1

        except Exception as e:

            logger.warning(f"Object error: {e}")

        return objects


engine = InferenceEngine()