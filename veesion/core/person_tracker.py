"""
core/person_tracker.py — Veesion Backend (optimizado v2)

Re-identificación de personas por bbox + buffer de keypoints
para alimentar modelo LSTM de detección de hurto.
"""

import time
import logging
from collections import deque

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────

LSTM_FRAMES = 15
MAX_ABSENCE_S = 12.0
MAX_DIST = 0.35
MAX_PERSONS = 40
MAX_SCORE_HISTORY = 20
MIN_IOU_SAME_PERSON = 0.18


# ─────────────────────────────────────────────
# UTILIDADES
# ─────────────────────────────────────────────

def _bbox_center(bbox):
    return (
        (bbox.get("nx1", 0.0) + bbox.get("nx2", 0.0)) / 2.0,
        (bbox.get("ny1", 0.0) + bbox.get("ny2", 0.0)) / 2.0,
    )


def _dist(bbox1, bbox2):
    cx1, cy1 = _bbox_center(bbox1)
    cx2, cy2 = _bbox_center(bbox2)

    dx = cx1 - cx2
    dy = cy1 - cy2

    return (dx * dx + dy * dy) ** 0.5


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


# ─────────────────────────────────────────────
# PERSONA
# ─────────────────────────────────────────────

class TrackedPerson:

    def __init__(self, slot_id, track_id, bbox, source_track_id=None, source_index=None):
        self.slot_id = slot_id
        self.track_id = track_id
        self.bbox = bbox

        # id original que vino del analyzer
        self.source_track_id = source_track_id
        self.source_index = source_index

        self.kp_buffer = deque(maxlen=LSTM_FRAMES)
        self.last_seen = time.time()

        self.score_hist = deque(maxlen=MAX_SCORE_HISTORY)
        self.lstm_prob = 0.0
        self.actions = []

    def update(self, track_id, bbox, kp_vec=None, source_track_id=None, source_index=None):
        self.track_id = track_id
        self.bbox = bbox
        self.last_seen = time.time()

        if source_track_id is not None:
            self.source_track_id = source_track_id

        if source_index is not None:
            self.source_index = source_index

        if kp_vec is not None:
            self.kp_buffer.append(kp_vec)

    @property
    def ready_for_lstm(self):
        return len(self.kp_buffer) >= LSTM_FRAMES


# ─────────────────────────────────────────────
# TRACKER
# ─────────────────────────────────────────────

class PersonTracker:

    def __init__(self):
        self._persons = {}
        self._next_slot = 1

    # ─────────────────────────

    def _cleanup(self):
        now = time.time()
        to_delete = []

        for sid, p in self._persons.items():
            if now - p.last_seen > MAX_ABSENCE_S:
                to_delete.append(sid)

        for sid in to_delete:
            del self._persons[sid]

    # ─────────────────────────

    def _build_kp_vec(self, kps):
        kp_vec = []

        for kp in kps:
            kp_vec.extend([kp.get("x", 0.0), kp.get("y", 0.0)])

        for kp in kps:
            kp_vec.append(kp.get("c", 0.0))

        kp_vec = kp_vec[:51]

        if len(kp_vec) < 51:
            kp_vec += [0.0] * (51 - len(kp_vec))

        return kp_vec

    # ─────────────────────────

    def _match_person(self, tid, bbox, matched_slots):
        # 1) match exacto por track_id
        for p in self._persons.values():
            if p.slot_id in matched_slots:
                continue
            if p.track_id == tid:
                return p

        # 2) match por IoU
        best_person = None
        best_iou = MIN_IOU_SAME_PERSON

        for p in self._persons.values():
            if p.slot_id in matched_slots:
                continue

            iou = _bbox_iou(bbox, p.bbox)

            if iou > best_iou:
                best_iou = iou
                best_person = p

        if best_person is not None:
            return best_person

        # 3) match por distancia
        best_person = None
        best_dist = MAX_DIST

        for p in self._persons.values():
            if p.slot_id in matched_slots:
                continue

            d = _dist(bbox, p.bbox)

            if d < best_dist:
                best_dist = d
                best_person = p

        return best_person

    # ─────────────────────────

    def update(self, tracks):
        self._cleanup()

        matched_slots = set()
        result = []

        for idx, track in enumerate(tracks):
            tid = track.get("id")
            bbox = track.get("bbox", {})
            kps = track.get("kps", [])

            kp_vec = self._build_kp_vec(kps)
            has_kps = any(v != 0.0 for v in kp_vec)

            source_track_id = track.get("id")
            source_index = idx

            person = self._match_person(tid, bbox, matched_slots)

            if person is not None:
                person.update(
                    tid,
                    bbox,
                    kp_vec if has_kps else None,
                    source_track_id=source_track_id,
                    source_index=source_index,
                )
            else:
                if len(self._persons) >= MAX_PERSONS:
                    continue

                slot_id = self._next_slot
                self._next_slot += 1

                person = TrackedPerson(
                    slot_id=slot_id,
                    track_id=tid,
                    bbox=bbox,
                    source_track_id=source_track_id,
                    source_index=source_index,
                )

                if has_kps:
                    person.kp_buffer.append(kp_vec)

                self._persons[slot_id] = person

            matched_slots.add(person.slot_id)

            enriched = dict(track)
            enriched["slot_id"] = person.slot_id
            enriched["source_track_id"] = person.source_track_id
            enriched["source_index"] = person.source_index
            enriched["buffer_len"] = len(person.kp_buffer)
            enriched["lstm_ready"] = person.ready_for_lstm
            enriched["lstm_prob"] = person.lstm_prob

            result.append(enriched)

        return result

    # ─────────────────────────

    def set_lstm_prob(self, slot_id, prob):
        p = self._persons.get(slot_id)

        if not p:
            return

        p.lstm_prob = prob
        p.score_hist.append(prob)

    # ─────────────────────────

    def get_buffers_for_lstm(self):
        buffers = {}

        for sid, p in self._persons.items():
            if p.ready_for_lstm:
                buffers[sid] = list(p.kp_buffer)

        return buffers

    # ─────────────────────────

    def summary(self):
        return {
            sid: {
                "track": p.track_id,
                "source_track_id": p.source_track_id,
                "source_index": p.source_index,
                "buf": len(p.kp_buffer),
                "prob": p.lstm_prob,
            }
            for sid, p in self._persons.items()
        }