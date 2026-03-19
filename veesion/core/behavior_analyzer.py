"""
core/behavior_analyzer.py — Veesion Backend v1.0
Análisis de comportamientos sospechosos usando keypoints del backend (PyTorch YOLO-pose).
Reemplaza la lógica heurística de detection.js — corre server-side con keypoints precisos.

Comportamientos:
  - BOLSILLO       muñeca cerca de cadera con conf baja
  - BRAZOS_CRUZADOS codos cruzados con muñecas ocultas
  - AGACHADO       nariz por debajo del punto medio hombros-caderas
  - BAJO_ROPA      muñecas dentro del torso con conf baja
  - PANTALLA       nariz invisible mientras muñeca en zona
  - PERMANENCIA    muñeca en zona > umbral de tiempo
  - ESCANEO        cabeza moviéndose lateralmente cerca de zona/objeto
  - POST_CONTACT   muñeca baja confianza después de objeto desaparecido
"""

import time
import math
import logging
from collections import deque
from typing import Optional

logger = logging.getLogger(__name__)

# ── Keypoint indices (COCO 17-point) ────────────────────────────────────────
KP_NOSE       = 0
KP_L_SHOULDER = 5
KP_R_SHOULDER = 6
KP_L_ELBOW    = 7
KP_R_ELBOW    = 8
KP_L_WRIST    = 9
KP_R_WRIST    = 10
KP_L_HIP      = 11
KP_R_HIP      = 12
KP_L_KNEE     = 13
KP_R_KNEE     = 14

# ── Thresholds (time-based, independientes del FPS) ─────────────────────────
KP_THRESH           = 0.18   # confianza mínima para usar un keypoint
MIN_BODY_CONF       = 0.15   # conf para contar kp como visible
MIN_KPS_VISIBLE     = 6      # mínimo kps visibles para analizar

CROSSED_ARMS_MS     = 1200
BODY_SCREEN_MS      = 1000
CROUCH_HIDE_MS      =  800
HIP_CONCEAL_MS      =  600
TORSO_CONCEAL_MS    = 1000
POCKET_MS           = 1500   # tiempo muñeca en zona bolsillo para alertar
DWELL_DEFAULT_S     = 3.0    # segundos en zona para PERMANENCIA
SCAN_WINDOW_MS      = 1500   # ventana de escaneo de cabeza
SCAN_STD_THRESH     = 0.055  # varianza lateral de nariz

POCKET_COOLDOWN_MS  = 18000
GENERIC_COOLDOWN_MS = 8000

AUTO_EMPLOYEE_MIN_S = 300    # 5 minutos → auto-empleado

# ── Score weights por comportamiento ────────────────────────────────────────
BEHAVIOR_WEIGHTS = {
    "pocket":          25,
    "crossedArms":     20,
    "crouch":          20,
    "torsoConcealment":30,
    "bodyScreen":      20,
    "zoneDwell":       15,
    "zoneEntry":        5,
    "scanning":        10,
    "postContact":     15,
}

SCORE_THRESHOLD = 70  # score mínimo para ROBO_CONFIRMADO


def _ok(kp: dict) -> bool:
    return kp is not None and kp.get("c", 0) >= KP_THRESH


def _dist(a: dict, b: dict) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _mid(a: dict, b: dict) -> dict:
    return {"x": (a["x"] + b["x"]) / 2, "y": (a["y"] + b["y"]) / 2}


def _iou(a: dict, b: dict) -> float:
    """IoU entre dos bbox normalizados con nx1,ny1,nx2,ny2."""
    ix1 = max(a["nx1"], b["nx1"]); iy1 = max(a["ny1"], b["ny1"])
    ix2 = min(a["nx2"], b["nx2"]); iy2 = min(a["ny2"], b["ny2"])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    aA = (a["nx2"] - a["nx1"]) * (a["ny2"] - a["ny1"])
    bA = (b["nx2"] - b["nx1"]) * (b["ny2"] - b["ny1"])
    return inter / (aA + bA - inter + 1e-6)


def _pip(x: float, y: float, pts: list) -> bool:
    """Point-in-polygon (ray casting)."""
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]["x"], pts[i]["y"]
        xj, yj = pts[j]["x"], pts[j]["y"]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _body_visible(kps: list) -> bool:
    return sum(1 for kp in kps if kp and kp.get("c", 0) >= MIN_BODY_CONF) >= MIN_KPS_VISIBLE


def _lower_body_visible(kps: list) -> bool:
    count = sum(
        1 for idx in [KP_L_HIP, KP_R_HIP, KP_L_KNEE, KP_R_KNEE]
        if kps[idx] and kps[idx].get("c", 0) >= MIN_BODY_CONF
    )
    return count >= 2


# ─────────────────────────────────────────────────────────────────────────────
#  TrackState — estado de comportamiento por persona
# ─────────────────────────────────────────────────────────────────────────────
class TrackState:
    def __init__(self, track_id: int, now: float):
        self.id            = track_id
        self.first_seen    = now
        self.last_seen     = now
        self.bbox          = {}
        self.kps           = []
        self.missed        = 0
        self.is_employee   = False
        self.score         = 0.0
        self.evidence      = []
        self.badges        = []
        self.in_zone       = False
        self.post_contact  = None   # {disappear_t, label, side, wrist_y0, fired}

        # Timers (None = no está activo)
        self.crossed_arms_start: Optional[float] = None
        self.body_screen_start:  Optional[float] = None
        self.crouch_start:       Optional[float] = None
        self.hip_conceal_start:  Optional[float] = None
        self.torso_start:        Optional[float] = None
        self.pocket_L_start:     Optional[float] = None
        self.pocket_R_start:     Optional[float] = None

        # Zona dwell
        self.zone_entry:   dict = {}   # zone_id -> enter_time
        self.zone_in:      dict = {}   # zone_id -> bool
        self.zone_visits:  dict = {}   # zone_id -> [timestamps]
        self.visited_pay:  bool = False

        # Escaneo
        self.nose_x_hist: deque = deque(maxlen=20)

        # Cooldowns de alertas
        self.last_alert: dict = {}

    def add_score(self, pts: float, reason: str):
        if self.is_employee:
            return
        self.score = min(100.0, self.score + pts)
        if reason and reason not in self.evidence:
            self.evidence.append(reason)
            if len(self.evidence) > 8:
                self.evidence.pop(0)

    def decay(self, now: float):
        """Decaimiento natural del score."""
        rate = 6.0 if self.score > 50 else 3.0 if self.score > 25 else 2.0
        self.score = max(0.0, self.score - rate)
        if self.score == 0:
            self.evidence = []

    def can_fire(self, key: str, cooldown_ms: float, now: float) -> bool:
        last = self.last_alert.get(key, 0)
        if (now - last) * 1000 >= cooldown_ms:
            self.last_alert[key] = now
            return True
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  BehaviorAnalyzer
# ─────────────────────────────────────────────────────────────────────────────
class BehaviorAnalyzer:
    def __init__(self, dwell_time_s: float = DWELL_DEFAULT_S, cooldown_s: float = 8.0):
        self._states:    dict[int, TrackState] = {}
        self._next_id    = 0
        self._zones:     list = []
        self._dwell_time = dwell_time_s
        self._cooldown   = cooldown_s
        self._employee_ids: set = set()

    # ── Config ──────────────────────────────────────────────────────────────
    def set_zones(self, zones: list):
        self._zones = zones or []

    def set_dwell_time(self, seconds: float):
        self._dwell_time = max(1.0, seconds)

    def set_cooldown(self, seconds: float):
        self._cooldown = max(1.0, seconds)

    def mark_employee(self, track_id: int):
        self._employee_ids.add(track_id)
        if track_id in self._states:
            self._states[track_id].is_employee = True

    # ── Main entry point ────────────────────────────────────────────────────
    def process(self, poses: list, now: Optional[float] = None) -> tuple[list, list]:
        """
        Recibe poses del frame actual.
        Retorna (enriched_tracks, events).
        
        enriched_tracks: lista de dicts con bbox, kps, id, score, badges, in_zone, etc.
        events: lista de dicts con type, severity, trackId, msg, evidence
        """
        if now is None:
            now = time.time()

        events = []

        # Match poses → states
        matched_state_ids = set()
        matched_pose_idxs = set()

        # Match existentes por IoU
        for sid, state in list(self._states.items()):
            if not state.bbox:
                continue
            best_iou = 0.15
            best_idx = -1
            for i, pose in enumerate(poses):
                if i in matched_pose_idxs:
                    continue
                iou = _iou(state.bbox, pose["bbox"])
                if iou > best_iou:
                    best_iou = iou
                    best_idx = i
            if best_idx >= 0:
                pose = poses[best_idx]
                state.bbox     = pose["bbox"]
                state.kps      = pose["kps"]
                state.last_seen = now
                state.missed   = 0
                matched_state_ids.add(sid)
                matched_pose_idxs.add(best_idx)
            else:
                state.missed += 1

        # Crear nuevos states para poses sin match
        for i, pose in enumerate(poses):
            if i in matched_pose_idxs:
                continue
            new_id = self._next_id
            self._next_id += 1
            st = TrackState(new_id, now)
            st.bbox = pose["bbox"]
            st.kps  = pose["kps"]
            if new_id in self._employee_ids:
                st.is_employee = True
            self._states[new_id] = st

        # Eliminar tracks perdidos (>7 frames sin ver = ~700ms a 10fps)
        to_delete = [sid for sid, st in self._states.items() if st.missed >= 7]
        for sid in to_delete:
            del self._states[sid]

        # Analizar cada track activo
        enriched = []
        for sid, state in self._states.items():
            if state.missed > 0:
                continue
            state.badges = []
            state.in_zone = False
            state.decay(now)
            self._check_auto_employee(state, now)

            if not state.is_employee and _body_visible(state.kps):
                evts = self._analyze(state, now)
                events.extend(evts)

            enriched.append(self._export_track(state))

        # Análisis grupal
        if len(enriched) >= 2:
            grp_evts = self._analyze_group(
                [s for s in self._states.values() if s.missed == 0],
                now
            )
            events.extend(grp_evts)

        return enriched, events

    # ── Análisis por track ───────────────────────────────────────────────────
    def _analyze(self, t: TrackState, now: float) -> list:
        events = []
        kps = t.kps
        lw  = kps[KP_L_WRIST];   rw  = kps[KP_R_WRIST]
        lh  = kps[KP_L_HIP];     rh  = kps[KP_R_HIP]
        le  = kps[KP_L_ELBOW];   re  = kps[KP_R_ELBOW]
        ls  = kps[KP_L_SHOULDER]; rs = kps[KP_R_SHOULDER]
        nose = kps[KP_NOSE]

        events += self._check_zone(t, lw, rw, now)
        events += self._check_pocket(t, lw, lh, ls, "L", now)
        events += self._check_pocket(t, rw, rh, rs, "R", now)
        events += self._check_crossed_arms(t, le, re, lw, rw, ls, rs, lh, rh, now)
        events += self._check_crouch(t, nose, ls, rs, lh, rh, now)
        events += self._check_torso_concealment(t, lw, rw, ls, rs, lh, rh, now)
        events += self._check_body_screen(t, nose, now)
        events += self._check_scan(t, nose, now)
        events += self._check_post_contact(t, lw, rw, le, re, ls, rs, lh, rh, now)
        events += self._check_score(t, now)

        return events

    # ── Zona ─────────────────────────────────────────────────────────────────
    def _check_zone(self, t: TrackState, lw, rw, now: float) -> list:
        events = []
        for zone in self._zones:
            pts = zone.get("points", [])
            if not pts:
                continue
            zid   = zone.get("id", "")
            zname = zone.get("name", zid)
            zpay  = zone.get("type") == "pago"

            for w, side in [(lw, "L"), (rw, "R")]:
                if not _ok(w):
                    continue
                key = f"{side}_{zid}"
                inside = _pip(w["x"], w["y"], pts)

                if inside:
                    t.in_zone = True
                    if not t.zone_in.get(key):
                        t.zone_in[key] = True
                        t.zone_entry[key] = now
                        if zpay:
                            t.visited_pay = True
                        # Registrar visita
                        t.zone_visits.setdefault(zid, [])
                        t.zone_visits[zid].append(now)
                        # Purgar visitas viejas
                        t.zone_visits[zid] = [ts for ts in t.zone_visits[zid] if now - ts < 90]

                        if t.can_fire(f"ze_{key}", 1500, now):
                            events.append(self._evt(
                                "ZONA_ENTRADA", "low", t,
                                f"MANO EN {zname.upper()}",
                                ["zona", zname]
                            ))
                            t.add_score(BEHAVIOR_WEIGHTS["zoneEntry"], f"ZONA {zname}")

                    # Dwell
                    enter = t.zone_entry.get(key, now)
                    elapsed = now - enter
                    if elapsed >= self._dwell_time:
                        t.zone_entry[key] = now + self._dwell_time  # reiniciar
                        if t.can_fire(f"dw_{key}", self._cooldown * 1000, now):
                            events.append(self._evt(
                                "PERMANENCIA", "high", t,
                                f"PERMANENCIA — {zname.upper()} ({elapsed:.0f}s)",
                                ["permanencia", zname, f"{elapsed:.0f}s"]
                            ))
                            t.add_score(BEHAVIOR_WEIGHTS["zoneDwell"], f"PERMANENCIA {zname}")
                            t.badges.append("⚠ PERMANENCIA")
                else:
                    if t.zone_in.get(key):
                        t.zone_in[key] = False
                        t.zone_entry.pop(key, None)

        return events

    # ── Bolsillo ─────────────────────────────────────────────────────────────
    def _check_pocket(self, t: TrackState, wrist, hip, shoulder, side: str, now: float) -> list:
        events = []
        timer_key = f"pocket_{side}"
        has_ctx = (t.post_contact is not None) or (t.score > 5)

        hip_x = hip["x"] if _ok(hip) else (t.bbox.get("nx1", 0) + t.bbox.get("nx2", 0)) / 2
        hip_y = hip["y"] if _ok(hip) else t.bbox.get("ny1", 0) + (t.bbox.get("ny2", 0) - t.bbox.get("ny1", 0)) * 0.70

        in_pocket = False
        low_conf  = False

        if not _ok(wrist):
            # Muñeca invisible — con contexto es sospechoso
            if has_ctx and _lower_body_visible(t.kps):
                in_pocket = True
                low_conf  = True
        else:
            below  = wrist["y"] > hip_y + 0.02
            hclose = abs(wrist["x"] - hip_x) < 0.18
            inrang = wrist["y"] < hip_y + 0.25
            in_pocket = below and hclose and inrang
            low_conf  = wrist["c"] < 0.40

        if in_pocket:
            attr = f"{timer_key}_start"
            if getattr(t, attr, None) is None:
                setattr(t, attr, now)
            elapsed = (now - getattr(t, attr)) * 1000

            threshold_ms = POCKET_MS * (0.6 if has_ctx else 1.0)

            if elapsed > threshold_ms * 0.5:
                t.badges.append(f"⚠ BOLSILLO {side}")

            if elapsed >= threshold_ms:
                setattr(t, attr, None)
                if t.can_fire(f"pkt_{side}_{t.id}", POCKET_COOLDOWN_MS, now):
                    sev = "high" if has_ctx else "medium"
                    msg = f"MANO {'IZQ' if side == 'L' else 'DER'} EN BOLSILLO"
                    if low_conf:
                        msg += " (OCULTA)"
                    events.append(self._evt("BOLSILLO", sev, t, msg, ["bolsillo", side]))
                    pts = BEHAVIOR_WEIGHTS["pocket"] if has_ctx else BEHAVIOR_WEIGHTS["pocket"] * 0.5
                    t.add_score(pts, f"BOLSILLO {side}")
        else:
            setattr(t, f"{timer_key}_start", None)

        return events

    # ── Brazos cruzados ──────────────────────────────────────────────────────
    def _check_crossed_arms(self, t, le, re, lw, rw, ls, rs, lh, rh, now) -> list:
        if not _ok(le) or not _ok(re) or not _ok(ls) or not _ok(rs):
            t.crossed_arms_start = None
            return []

        mx = (ls["x"] + rs["x"]) / 2
        my = (ls["y"] + rs["y"]) / 2
        hy = (lh["y"] + rh["y"]) / 2 if (_ok(lh) and _ok(rh)) else my + 0.3

        crossed = (
            abs(le["x"] - mx) < 0.20 and
            abs(re["x"] - mx) < 0.20 and
            le["x"] > mx and re["x"] < mx and
            le["y"] > my and le["y"] < hy + 0.08 and
            re["y"] > my and re["y"] < hy + 0.08 and
            (not _ok(lw) or not _ok(rw) or lw["c"] < 0.40 or rw["c"] < 0.40)
        )

        if crossed:
            if t.crossed_arms_start is None:
                t.crossed_arms_start = now
            elapsed = (now - t.crossed_arms_start) * 1000
            if elapsed > CROSSED_ARMS_MS * 0.5:
                t.badges.append("⚠ CRUZADO")
            if elapsed >= CROSSED_ARMS_MS:
                t.crossed_arms_start = None
                if t.can_fire(f"cross_{t.id}", self._cooldown * 1000, now):
                    evt = self._evt("BRAZOS_CRUZADOS", "high", t,
                                   "BRAZOS CRUZADOS — POSIBLE OCULTAMIENTO",
                                   ["brazos_cruzados"])
                    t.add_score(BEHAVIOR_WEIGHTS["crossedArms"], "BRAZOS CRUZADOS")
                    return [evt]
        else:
            t.crossed_arms_start = None
        return []

    # ── Agachado ──────────────────────────────────────────────────────────────
    def _check_crouch(self, t, nose, ls, rs, lh, rh, now) -> list:
        if not _ok(nose) or not _ok(ls) or not _ok(rs):
            t.crouch_start = None
            return []
        if not _lower_body_visible(t.kps):
            return []

        sY = (ls["y"] + rs["y"]) / 2
        hY = (lh["y"] + rh["y"]) / 2 if (_ok(lh) and _ok(rh)) else sY + 0.3

        crouching = nose["y"] > (sY + hY) / 2 + 0.06

        if crouching:
            if t.crouch_start is None:
                t.crouch_start = now
            elapsed = (now - t.crouch_start) * 1000
            if elapsed > CROUCH_HIDE_MS * 0.5:
                t.badges.append("⚠ AGACHADO")
            if elapsed >= CROUCH_HIDE_MS:
                t.crouch_start = None
                has_pc = t.post_contact and not t.post_contact.get("fired")
                label  = t.post_contact["label"] if has_pc else "ZONA BAJA"
                sev    = "high" if has_pc else "medium"
                key    = f"crch_{t.id}_{label}"
                if t.can_fire(key, self._cooldown * 1000, now):
                    pts = BEHAVIOR_WEIGHTS["crouch"] if has_pc else BEHAVIOR_WEIGHTS["crouch"] * 0.6
                    t.add_score(pts, "AGACHADO")
                    if has_pc:
                        t.post_contact["fired"] = True
                    return [self._evt("AGACHADO", sev, t,
                                     f"AGACHADO — {label}",
                                     ["agachado", label])]
        else:
            t.crouch_start = None
        return []

    # ── Bajo ropa (torso) ─────────────────────────────────────────────────────
    def _check_torso_concealment(self, t, lw, rw, ls, rs, lh, rh, now) -> list:
        if t.is_employee or not _ok(ls) or not _ok(rs):
            t.torso_start = None
            return []

        tL = min(ls["x"], rs["x"]) - 0.08
        tR = max(ls["x"], rs["x"]) + 0.08
        tT = min(ls["y"], rs["y"])
        tB = max(lh["y"], rh["y"]) + 0.10 if (_ok(lh) and _ok(rh)) else tT + 0.45

        hits = 0
        for w in [lw, rw]:
            if w and tL < w["x"] < tR and tT < w["y"] < tB and w.get("c", 1) < 0.35:
                hits += 1

        if hits == 0:
            t.torso_start = None
            return []

        if t.torso_start is None:
            t.torso_start = now
        elapsed = (now - t.torso_start) * 1000
        if elapsed > TORSO_CONCEAL_MS * 0.5:
            t.badges.append("⚠ BAJO ROPA")
        if elapsed >= TORSO_CONCEAL_MS:
            t.torso_start = None
            if t.can_fire(f"torso_{t.id}", self._cooldown * 1000, now):
                t.add_score(BEHAVIOR_WEIGHTS["torsoConcealment"], "BAJO ROPA")
                return [self._evt("BAJO_ROPA", "high", t,
                                 "OBJETO BAJO ROPA — MUÑECAS EN TORSO OCULTAS",
                                 ["bajo_ropa"])]
        return []

    # ── Pantalla corporal ─────────────────────────────────────────────────────
    def _check_body_screen(self, t, nose, now) -> list:
        nose_hidden = not _ok(nose)
        in_zone     = t.in_zone

        if nose_hidden and in_zone:
            if t.body_screen_start is None:
                t.body_screen_start = now
            elapsed = (now - t.body_screen_start) * 1000
            if elapsed > BODY_SCREEN_MS * 0.5:
                t.badges.append("⚠ PANTALLA")
                t.add_score(BEHAVIOR_WEIGHTS["bodyScreen"] * 0.5, "PANTALLA")
            if elapsed >= BODY_SCREEN_MS:
                t.body_screen_start = None
                if t.can_fire(f"bsc_{t.id}", self._cooldown * 1000, now):
                    t.add_score(BEHAVIOR_WEIGHTS["bodyScreen"], "PANTALLA")
                    return [self._evt("PANTALLA", "high", t,
                                     "CUERPO COMO PANTALLA — DE ESPALDAS EN ZONA",
                                     ["pantalla"])]
        else:
            t.body_screen_start = None
        return []

    # ── Escaneo ──────────────────────────────────────────────────────────────
    def _check_scan(self, t, nose, now) -> list:
        if not _ok(nose):
            return []
        t.nose_x_hist.append({"x": nose["x"], "t": now})
        # Mantener solo ventana de 1.5s
        cutoff = now - SCAN_WINDOW_MS / 1000
        while t.nose_x_hist and t.nose_x_hist[0]["t"] < cutoff:
            t.nose_x_hist.popleft()
        if len(t.nose_x_hist) < 6:
            return []

        xs   = [p["x"] for p in t.nose_x_hist]
        mean = sum(xs) / len(xs)
        std  = math.sqrt(sum((x - mean) ** 2 for x in xs) / len(xs))

        if std < SCAN_STD_THRESH:
            return []
        if not t.in_zone:
            return []

        if t.can_fire(f"scan_{t.id}", self._cooldown * 1000, now):
            t.add_score(BEHAVIOR_WEIGHTS["scanning"], "ESCANEO")
            t.nose_x_hist.clear()
            t.badges.append("⚠ ESCANEO")
            return [self._evt("ESCANEO", "medium", t,
                             "ESCANEO — COMPORTAMIENTO PREVIO A HURTO",
                             ["escaneo", f"std={std:.3f}"])]
        return []

    # ── Post-contact ─────────────────────────────────────────────────────────
    def _check_post_contact(self, t, lw, rw, le, re, ls, rs, lh, rh, now) -> list:
        pc = t.post_contact
        if not pc or pc.get("fired"):
            return []
        if now - pc.get("disappear_t", now) > 8.0:
            t.post_contact = None
            return []

        w  = lw if pc["side"] == "L" else rw
        if not _ok(w):
            t.add_score(5, "WRIST OCULTA PC")
            return []

        events = []
        # Bajo manga — muñeca sube sobre el codo
        elbow = le if pc["side"] == "L" else re
        if _ok(elbow) and pc.get("wrist_y0") is not None:
            if w["y"] < pc["wrist_y0"] - 0.07 and w["y"] < elbow["y"] - 0.04:
                if t.can_fire(f"slv_{t.id}", self._cooldown * 1000, now):
                    t.add_score(BEHAVIOR_WEIGHTS["postContact"] + 10, "BAJO MANGA")
                    pc["fired"] = True
                    t.post_contact = None
                    events.append(self._evt("BAJO_MANGA", "high", t,
                                          f"MANGA — {pc['label']} BAJO MANGA",
                                          ["bajo_manga", pc["label"]]))
                return events

        # Bajo ropa (post-contact version — más rápida)
        if _ok(ls) and _ok(rs) and _ok(lh) and _ok(rh):
            bL = min(ls["x"], rs["x"]) - 0.15
            bR = max(ls["x"], rs["x"]) + 0.15
            bT = min(ls["y"], rs["y"])
            bB = max(lh["y"], rh["y"]) + 0.12
            if bL < w["x"] < bR and bT < w["y"] < bB and w["c"] < 0.45:
                if t.can_fire(f"trso_{t.id}", self._cooldown * 1000, now):
                    t.add_score(BEHAVIOR_WEIGHTS["torsoConcealment"] + 5, "BAJO ROPA PC")
                    pc["fired"] = True
                    t.post_contact = None
                    events.append(self._evt("BAJO_ROPA", "high", t,
                                          f"ROPA — {pc['label']} BAJO ROPA",
                                          ["bajo_ropa", pc["label"]]))
                return events

        return events

    # ── Score threshold ───────────────────────────────────────────────────────
    def _check_score(self, t: TrackState, now: float) -> list:
        if t.score >= SCORE_THRESHOLD:
            evidence = t.evidence[-3:]
            if t.can_fire(f"score_{t.id}", self._cooldown * 1000, now):
                t.score = SCORE_THRESHOLD * 0.15
                return [self._evt("ROBO_CONFIRMADO", "high", t,
                                 f"ROBO CONFIRMADO — SCORE {t.score:.0f}/100 | {' + '.join(evidence)}",
                                 evidence)]
        return []

    # ── Análisis grupal ───────────────────────────────────────────────────────
    def _analyze_group(self, states: list, now: float) -> list:
        events = []
        active = [s for s in states if not s.is_employee]

        # Pantalla humana
        for sA in active:
            if not sA.in_zone:
                continue
            cAx = (sA.bbox.get("nx1", 0) + sA.bbox.get("nx2", 0)) / 2
            cAy = (sA.bbox.get("ny1", 0) + sA.bbox.get("ny2", 0)) / 2
            for sB in active:
                if sB.id == sA.id:
                    continue
                cBx = (sB.bbox.get("nx1", 0) + sB.bbox.get("nx2", 0)) / 2
                cBy = (sB.bbox.get("ny1", 0) + sB.bbox.get("ny2", 0)) / 2
                dist = math.hypot(cAx - cBx, cAy - cBy)
                if cBy < cAy - 0.10 and abs(cBx - cAx) < 0.20 and dist < 0.35:
                    key = f"wall_{sA.id}_{sB.id}"
                    if sA.can_fire(key, self._cooldown * 1000, now):
                        sA.add_score(25, "PANTALLA HUMANA")
                        sA.badges.append("⚠ BLOQUEADO")
                        sB.badges.append("⚠ CÓMPLICE")
                        events.append(self._evt("PANTALLA_HUMANA", "high", sA,
                                               "PANTALLA HUMANA — CÓMPLICE BLOQUEANDO VISTA",
                                               ["pantalla_humana", f"blocker#{sB.id}"]))
                    break

        # Cómplice distractor
        stealers = [s for s in active if s.post_contact and not s.post_contact.get("fired")]
        pay_zones = [z for z in self._zones if z.get("type") == "pago"]
        for s in stealers:
            distractors = []
            for other in active:
                if other.id == s.id:
                    continue
                cx = (other.bbox.get("nx1", 0) + other.bbox.get("nx2", 0)) / 2
                cy = (other.bbox.get("ny1", 0) + other.bbox.get("ny2", 0)) / 2
                near_pay = any(
                    math.hypot(cx - sum(p["x"] for p in z["points"]) / len(z["points"]),
                               cy - sum(p["y"] for p in z["points"]) / len(z["points"])) < 0.30
                    for z in pay_zones if z.get("points")
                )
                if near_pay or cy < 0.25:
                    distractors.append(other)
            if distractors and s.can_fire(f"dist_{s.id}", self._cooldown * 1000, now):
                s.add_score(20, "CÓMPLICE DISTRACTOR")
                s.badges.append("⚠ CÓMPLICE")
                events.append(self._evt("COMPLICE_DISTRACTOR", "high", s,
                                       f"CÓMPLICE DISTRACTOR — {len(distractors)} persona cerca",
                                       ["complice_distractor", f"{len(distractors)} personas"]))

        return events

    # ── Auto-empleado ─────────────────────────────────────────────────────────
    def _check_auto_employee(self, t: TrackState, now: float):
        if t.is_employee or t.score > 20:
            return
        if (now - t.first_seen) >= AUTO_EMPLOYEE_MIN_S and t.score < 5:
            t.is_employee = True
            self._employee_ids.add(t.id)
            logger.info(f"👷 Track #{t.id} marcado auto-empleado")

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _evt(self, evt_type: str, severity: str, t: TrackState,
             msg: str, evidence: list) -> dict:
        return {
            "type":     evt_type,
            "severity": severity,
            "trackId":  t.id,
            "msg":      msg,
            "score":    round(t.score, 1),
            "evidence": evidence,
            "badges":   t.badges[:],
        }

    def _export_track(self, t: TrackState) -> dict:
        return {
            "id":             t.id,
            "bbox":           t.bbox,
            "kps":            t.kps,
            "score":          round(t.score, 1),
            "badges":         t.badges,
            "in_zone":        t.in_zone,
            "is_employee":    t.is_employee,
            "has_post_contact": t.post_contact is not None and not t.post_contact.get("fired"),
        }