"""
core/detection.py — Veesion Backend
Puerto completo de detection.js v5.2 a Python.

FIX principal: postContact se activa cuando la muñeca SALE de una zona,
aunque YOLO no haya detectado ningún objeto. Esto permite detectar
agachado/cadera/manga/bagStuffing con CUALQUIER objeto robado.
"""
import time
import math
import logging
from .profiles import Profile, get_profile
from .inference import BAG_IDS, ALERT_IDS

logger = logging.getLogger(__name__)

KP_THRESH           = 0.25
IOU_THRESH          = 0.45
OBJ_VIS_WINDOW      = 14
SAME_OBJ_IOU        = 0.28
MIN_BROWSE_MS       = 1500
AUTO_EMPLOYEE_MIN   = 5
SCREEN_MAX_DIST     = 0.35
DISTRACTOR_PAY_DIST = 0.30
EXIT_SCORE_MEMORY_MS = 30000

KP = {
    "NOSE":0,"L_EYE":1,"R_EYE":2,"L_EAR":3,"R_EAR":4,
    "L_SHOULDER":5,"R_SHOULDER":6,"L_ELBOW":7,"R_ELBOW":8,
    "L_WRIST":9,"R_WRIST":10,"L_HIP":11,"R_HIP":12,
    "L_KNEE":13,"R_KNEE":14,"L_ANKLE":15,"R_ANKLE":16,
}


def _ok(kp) -> bool:
    return kp is not None and kp["c"] >= KP_THRESH

def _d(ax, ay, bx, by) -> float:
    return math.hypot(ax - bx, ay - by)

def _mid(a, b) -> dict:
    return {"x": (a["x"]+b["x"])/2, "y": (a["y"]+b["y"])/2}

def _iou(a: dict, b: dict) -> float:
    ix1 = max(a["nx1"], b["nx1"]); iy1 = max(a["ny1"], b["ny1"])
    ix2 = min(a["nx2"], b["nx2"]); iy2 = min(a["ny2"], b["ny2"])
    I   = max(0, ix2-ix1) * max(0, iy2-iy1)
    ua  = (a["nx2"]-a["nx1"]) * (a["ny2"]-a["ny1"])
    ub  = (b["nx2"]-b["nx1"]) * (b["ny2"]-b["ny1"])
    return I / (ua + ub - I + 1e-6)

def _ms() -> int:
    return int(time.time() * 1000)


# ── ObjTracker ────────────────────────────────────────────────────────────────
class ObjTracker:
    def __init__(self):
        self._objs   = {}
        self._next_id = 0

    def update(self, dets: list):
        matched = set()
        for obj in self._objs.values():
            best_iou, best_det, best_idx = SAME_OBJ_IOU, None, -1
            for i, d in enumerate(dets):
                if i in matched: continue
                iou = _iou(obj["bbox"], d["bbox"])
                same = d.get("family_key") == obj.get("family_key")
                if iou > best_iou or (same and iou > 0.15):
                    best_iou, best_det, best_idx = iou, d, i
            obj["history"].append(best_det is not None)
            if len(obj["history"]) > OBJ_VIS_WINDOW: obj["history"].pop(0)
            if best_det:
                obj.update({"bbox": best_det["bbox"], "cls": best_det.get("cls",-1),
                            "label": best_det.get("label","OBJETO"),
                            "family_key": best_det.get("family_key","MEDIUM"),
                            "conf": best_det.get("conf",0),
                            "visible": True, "last_seen": _ms()})
                matched.add(best_idx)
            else:
                obj["visible"] = False

        for i, d in enumerate(dets):
            if i in matched: continue
            oid = f"o{self._next_id}"; self._next_id += 1
            self._objs[oid] = {
                "id": oid, "cls": d.get("cls",-1),
                "family_key": d.get("family_key","MEDIUM"),
                "label": d.get("label","OBJETO"), "conf": d.get("conf",0),
                "bbox": d["bbox"], "history": [True], "visible": True,
                "last_seen": _ms(), "contact_start": None,
            }

        now = _ms()
        for k in [k for k,v in self._objs.items() if now - v["last_seen"] > 5000]:
            del self._objs[k]

    @property
    def visible(self):
        return [o for o in self._objs.values() if o["visible"]]

    @property
    def alert_visible(self):
        return [o for o in self.visible if o.get("cls",-1) in ALERT_IDS]

    def disappeared_after_contact(self, obj_id: str) -> bool:
        obj = self._objs.get(obj_id)
        if not obj or len(obj["history"]) < 6: return False
        half   = len(obj["history"]) // 2
        before = obj["history"][:half]; after = obj["history"][half:]
        return (sum(before)/len(before) >= 0.60 and
                sum(1 for v in after if not v)/len(after) >= 0.60)

    def mark_contact(self, obj_id: str):
        obj = self._objs.get(obj_id)
        if obj:
            obj["contact_start"] = _ms()
            obj["history"] = [True] * int(OBJ_VIS_WINDOW * 0.7)


# ── DetectionEngine ────────────────────────────────────────────────────────────
class DetectionEngine:
    def __init__(self, camera_id: int, store_type: str = "generico", config: dict = None):
        self.camera_id    = camera_id
        self._profile     = get_profile(store_type)
        cfg               = config or {}
        self.config = {
            "movementThreshold": cfg.get("movementThreshold", 50),
            "dwellTime":         cfg.get("dwellTime", self._profile.dwell_time),
            "cooldown":          cfg.get("cooldown", 8),
            "storeType":         store_type,
        }
        self._tracks          = []
        self._next_id         = 0
        self._obj_tracker     = ObjTracker()
        self._interactions    = {}
        self._last_alert      = {}
        self._employee_ids    = set()
        self._exit_scores     = []
        self._zones           = []
        self._pending_events: list[dict] = []

    def set_zones(self, zones: list):
        self._zones = zones

    def set_store_type(self, store_type: str):
        self._profile = get_profile(store_type)
        self.config["storeType"] = store_type

    def mark_employee(self, track_id: int):
        self._employee_ids.add(track_id)
        t = next((t for t in self._tracks if t["id"] == track_id), None)
        if t: t["isEmployee"] = True; t["suspicionScore"] = 0; t["badges"] = []

    def pop_events(self) -> list[dict]:
        evs = list(self._pending_events); self._pending_events = []; return evs

    def process_detections(self, inference_result: dict):
        self._obj_tracker.update(inference_result.get("objects", []))
        self._update_tracks(inference_result.get("poses", []), _ms())

    # ── Polygon hit-test ──────────────────────────────────────────────────────
    def _zones_for_point(self, x, y) -> list:
        result = []
        for z in self._zones:
            pts = z.get("points", [])
            if len(pts) < 3: continue
            if self._pip(x, y, pts): result.append(z)
        return result

    @staticmethod
    def _pip(x, y, pts) -> bool:
        inside = False; j = len(pts) - 1
        for i in range(len(pts)):
            xi,yi = pts[i]["x"],pts[i]["y"]; xj,yj = pts[j]["x"],pts[j]["y"]
            if ((yi>y)!=(yj>y)) and (x < (xj-xi)*(y-yi)/(yj-yi+1e-9)+xi):
                inside = not inside
            j = i
        return inside

    # ── Tracking ──────────────────────────────────────────────────────────────
    def _make_track(self, det, now) -> dict:
        return {
            "id": self._next_id, "kps": det["kps"],
            "nx1":det["bbox"]["nx1"],"ny1":det["bbox"]["ny1"],
            "nx2":det["bbox"]["nx2"],"ny2":det["bbox"]["ny2"],
            "missed":0, "history":[{"kps":det["kps"],"t":now}],
            "firstSeen":now, "isEmployee":False,
            "inZoneWrist":{}, "dwellStart":{}, "zoneEntryFrames":{},
            "pocketL":0,"pocketR":0,"crossedArms":0,
            "cajaExit":{},"postContact":None,
            "zoneVisits":{},"visitedPay":False,
            "noseXHist":[],"bodyScreen":0,"crouchHide":0,"hipConcealment":0,
            "directTrajFired":False,"firstZoneEntry":None,
            "suspicionScore":0.0,"scoreEvidence":[],"badges":[],
        }

    def _update_tracks(self, dets, now):
        matched = set()
        for t in self._tracks:
            best, best_iou = -1, 0.10
            for i,d in enumerate(dets):
                if i in matched: continue
                iou = _iou(t, d["bbox"])
                if iou > best_iou: best, best_iou = i, iou
            if best >= 0:
                d = dets[best]
                t.update({"kps":d["kps"],
                          "nx1":d["bbox"]["nx1"],"ny1":d["bbox"]["ny1"],
                          "nx2":d["bbox"]["nx2"],"ny2":d["bbox"]["ny2"],"missed":0})
                t["history"].append({"kps":d["kps"],"t":now})
                if len(t["history"]) > 30: t["history"].pop(0)
                matched.add(best)
            else:
                t["missed"] = t.get("missed",0) + 1

        # Tracks que salen con score alto → alerta
        for t in [x for x in self._tracks if x.get("missed",0) >= 10]:
            if t["suspicionScore"] >= 50 and not t["isEmployee"]:
                self._exit_scores.append({
                    "score":t["suspicionScore"],"evidence":t["scoreEvidence"][-3:],
                    "timestamp":now,"cx":(t["nx1"]+t["nx2"])/2,"cy":(t["ny1"]+t["ny2"])/2,
                })
                self._fire(f"exit_{t['id']}",
                    f"SOSPECHOSO SALIÓ — SCORE {round(t['suspicionScore'])}","medium",5000)

        self._tracks = [t for t in self._tracks if t.get("missed",0) < 10]
        self._exit_scores = [e for e in self._exit_scores if now-e["timestamp"] < EXIT_SCORE_MEMORY_MS]

        for i,d in enumerate(dets):
            if i in matched: continue
            self._next_id += 1
            nt = self._make_track(d, now)
            nt["id"] = self._next_id
            if nt["id"] in self._employee_ids: nt["isEmployee"] = True
            cx=(d["bbox"]["nx1"]+d["bbox"]["nx2"])/2; cy=(d["bbox"]["ny1"]+d["bbox"]["ny2"])/2
            prev = next((e for e in self._exit_scores if _d(cx,cy,e["cx"],e["cy"])<0.20), None)
            if prev: nt["suspicionScore"]=prev["score"]*0.6; nt["scoreEvidence"]=list(prev["evidence"])
            self._tracks.append(nt)

        for t in self._tracks:
            if not t.get("missed"): self._analyze(t, now)

    # ── Análisis ──────────────────────────────────────────────────────────────
    def _analyze(self, t, now):
        k   = t["kps"]
        lw  = k[KP["L_WRIST"]];  rw  = k[KP["R_WRIST"]]
        lh  = k[KP["L_HIP"]];    rh  = k[KP["R_HIP"]]
        le  = k[KP["L_ELBOW"]];  re  = k[KP["R_ELBOW"]]
        ls  = k[KP["L_SHOULDER"]]; rs = k[KP["R_SHOULDER"]]
        nose = k[KP["NOSE"]]
        t["badges"] = []
        self._decay_score(t)
        self._check_auto_employee(t, now)
        if t["isEmployee"]:
            t["badges"].append("👷")
            self._zone_dwell_employee(t, lw, rw, now)
            return
        P = self._profile
        self._detect_zone(t, lw, rw, lh, rh, now)
        self._detect_pocket(t, lw, lh, ls, "L")
        self._detect_pocket(t, rw, rh, rs, "R")
        self._detect_crossed_arms(t, le, re, lw, rw, ls, rs, lh, rh)
        self._detect_hand_obj(t, lw, rw, now)
        self._check_caja_heist(t, lw, rw, lh, rh, le, re, now)
        self._check_post_contact(t, lw, rw, le, re, ls, rs, lh, rh, now)
        if P.behaviors.get("cadera"):      self._check_hip(t, lw, rw, lh, rh, now)
        if P.behaviors.get("merodeo"):     self._check_prowling(t, now)
        if P.behaviors.get("escaneo"):     self._check_scan(t, nose, now)
        if P.behaviors.get("pantalla"):    self._check_body_screen(t, nose)
        if P.behaviors.get("agachado"):    self._check_crouch(t, nose, ls, rs, lh, rh)
        if P.behaviors.get("trayectoria"): self._check_trajectory(t, now)
        self._check_score(t, now)

    def _check_auto_employee(self, t, now):
        if t["isEmployee"] or t["suspicionScore"] > 20: return
        if (now - t["firstSeen"]) / 60000 >= AUTO_EMPLOYEE_MIN and t["suspicionScore"] < 5:
            t["isEmployee"] = True; self._employee_ids.add(t["id"])

    def _zone_dwell_employee(self, t, lw, rw, now):
        for w, side in [(lw,"L"),(rw,"R")]:
            if not _ok(w): continue
            for z in self._zones_for_point(w["x"], w["y"]):
                key = f"{side}_{z['id']}"
                t["dwellStart"].setdefault(key, now)
                if (now - t["dwellStart"][key]) / 1000 >= self.config["dwellTime"] * 3:
                    t["dwellStart"][key] = now + self.config["dwellTime"] * 3000
                    self._fire(f"emp_dw_{t['id']}_{key}",
                               f"EMPLEADO — PERMANENCIA INUSUAL EN {z['name'].upper()}","medium",30000)

    # ── Zonas ─────────────────────────────────────────────────────────────────
    def _detect_zone(self, t, lw, rw, lh, rh, now):
        P = self._profile
        for w, side in [(lw,"L"),(rw,"R")]:
            if not _ok(w):
                for key in t["inZoneWrist"]:
                    if key.startswith(side+"_"):
                        t["inZoneWrist"][key]=False; t["dwellStart"][key]=None; t["zoneEntryFrames"][key]=0
                continue
            zones = self._zones_for_point(w["x"], w["y"])
            for z in zones:
                key = f"{side}_{z['id']}"
                t["zoneEntryFrames"][key] = t["zoneEntryFrames"].get(key,0) + 1
                if not t["inZoneWrist"].get(key):
                    if t["zoneEntryFrames"].get(key,0) >= P.zone_entry_frames:
                        t["inZoneWrist"][key]=True; t["dwellStart"][key]=now
                        self._fire(f"ze_{t['id']}_{key}",f"MANO EN {z['name'].upper()}","low",1500)
                        self._record_visit(t, z, now)
                        if z.get("type")=="pago": t["visitedPay"]=True
                        if not t["firstZoneEntry"]: t["firstZoneEntry"]=now
                else:
                    elapsed = (now - (t["dwellStart"].get(key) or now)) / 1000
                    if elapsed >= self.config["dwellTime"]:
                        t["dwellStart"][key] = now + self.config["dwellTime"] * 1000
                        self._fire(f"dw_{t['id']}_{key}",f"PERMANENCIA — {z['name'].upper()}","high",self.config["cooldown"]*1000)
                    if len(t["history"]) >= 6: self._detect_escape(t, side, z, lh, rh)
                    t["badges"].append("⚠ EN ZONA")
            if not zones:
                for key in list(t["inZoneWrist"]):
                    if not key.startswith(side+"_") or not t["inZoneWrist"].get(key): continue
                    t["inZoneWrist"][key]=False; t["dwellStart"][key]=None; t["zoneEntryFrames"][key]=0
                    z_id = key[2:]
                    z_   = next((z for z in self._zones if z["id"]==z_id), None)
                    if z_ and z_.get("type")=="pago" and _ok(w):
                        t["cajaExit"][f"{side}_{z_id}"] = {"t":now,"wristY":w["y"]}
                    # ── FIX PRINCIPAL: postContact por salida de zona ──────────
                    # Funciona aunque YOLO no haya visto el objeto (papel higiénico, etc.)
                    if not t["postContact"]:
                        elbow = t["kps"][KP["L_ELBOW"] if side=="L" else KP["R_ELBOW"]]
                        t["postContact"] = {
                            "disappearT": now, "label": "OBJETO",
                            "cls": -1, "side": side,
                            "wristY0": w["y"],
                            "elbowY0": elbow["y"] if _ok(elbow) else None,
                            "fired": False, "from_zone": True,
                        }
                        self._add_score(t, P.bonus("zonePostContact"), "SALIÓ DE ZONA")
                for key in list(t["zoneEntryFrames"]):
                    if key.startswith(side+"_") and not t["inZoneWrist"].get(key):
                        t["zoneEntryFrames"][key] = 0

    def _detect_escape(self, t, side, zone, lh, rh):
        if not lh or not rh: return
        mid = _mid(lh, rh); hl = len(t["history"])
        old = t["history"][max(0,hl-6)]; cur = t["history"][hl-1]
        if not old or not cur: return
        idx = KP["L_WRIST"] if side=="L" else KP["R_WRIST"]
        pw = old["kps"][idx]; cw = cur["kps"][idx]
        if not _ok(pw) or not _ok(cw): return
        if not self._zones_for_point(pw["x"], pw["y"]): return
        pd = _d(pw["x"],pw["y"],mid["x"],mid["y"]); cd = _d(cw["x"],cw["y"],mid["x"],mid["y"])
        if cd < pd*0.65 and pd > 0.08:
            self._fire(f"esc_{t['id']}_{zone['id']}_{side}",
                       f"OBJETO OCULTADO — {zone['name'].upper()}","high",self.config["cooldown"]*1000)

    # ── Bolsillo / Brazos ─────────────────────────────────────────────────────
    def _detect_pocket(self, t, wrist, hip, shoulder, side):
        if not hip or not shoulder: return
        hx,hy = hip["x"],hip["y"]
        if not wrist or wrist["c"]<0.20: pocket=True
        elif wrist["c"]<0.50: pocket=abs(wrist["x"]-hx)<0.18 and abs(wrist["y"]-hy)<0.22
        else: pocket=wrist["y"]>hy-0.05 and abs(wrist["x"]-hx)<0.15 and abs(wrist["y"]-hy)<0.19
        sk = "pocketL" if side=="L" else "pocketR"
        if pocket:
            t[sk]+=1
            if t[sk]>=12:
                t[sk]=0
                self._fire(f"pkt_{side}_{t['id']}",f"MANO {'IZQ.' if side=='L' else 'DER.'} EN BOLSILLO","high",self.config["cooldown"]*1000)
            if t[sk]>6: t["badges"].append("⚠ BOLSILLO")
        else: t[sk]=max(0,t[sk]-2)

    def _detect_crossed_arms(self, t, le, re, lw, rw, ls, rs, lh, rh):
        if not all([le,re,ls,rs,lh,rh]): return
        mx=(ls["x"]+rs["x"])/2; my=(ls["y"]+rs["y"])/2; hy=(lh["y"]+rh["y"])/2
        ok=(abs(le["x"]-mx)<0.20 and abs(re["x"]-mx)<0.20 and
            le["x"]>mx and re["x"]<mx and le["y"]>my and le["y"]<hy+0.08 and
            re["y"]>my and re["y"]<hy+0.08 and
            (not lw or lw["c"]<0.40 or not rw or rw["c"]<0.40))
        if ok:
            t["crossedArms"]+=1
            if t["crossedArms"]>=15:
                t["crossedArms"]=0
                self._fire(f"cross_{t['id']}","BRAZOS CRUZADOS — POSIBLE OCULTAMIENTO","high",self.config["cooldown"]*1000)
            if t["crossedArms"]>8: t["badges"].append("⚠ CRUZADO")
            if t["postContact"] and not t["postContact"]["fired"]:
                self._add_score(t, self._profile.bonus("brazoscruzados"),"BRAZOS CRUZADOS")
        else: t["crossedArms"]=max(0,t["crossedArms"]-2)

    # ── Objetos ───────────────────────────────────────────────────────────────
    def _detect_hand_obj(self, t, lw, rw, now):
        alert_objs = self._obj_tracker.alert_visible
        if not alert_objs: return
        enabled = set(self._profile.families)
        for w, side in [(lw,"L"),(rw,"R")]:
            if not _ok(w): continue
            for obj in alert_objs:
                if obj["family_key"] not in enabled: continue
                b=obj["bbox"]; m=0.06
                touching=(w["x"]>=b["nx1"]-m and w["x"]<=b["nx2"]+m and
                          w["y"]>=b["ny1"]-m and w["y"]<=b["ny2"]+m)
                ik=f"{t['id']}_{obj['id']}_{side}"
                if touching:
                    if ik not in self._interactions:
                        self._interactions[ik]={"startT":now,"objId":obj["id"],"label":obj["label"],"cls":obj.get("cls",-1)}
                        self._obj_tracker.mark_contact(obj["id"])
                    dur=now-self._interactions[ik]["startT"]
                    if dur>=self._profile.contact_min_ms:
                        cx=(b["nx1"]+b["nx2"])/2; cy=(b["ny1"]+b["ny2"])/2
                        zs=self._zones_for_point(cx,cy)
                        if zs:
                            self._fire(f"oz_{ik}",f"CONTACTO: {obj['label']} EN {zs[0]['name'].upper()}","low",3000)
                            self._add_score(t,self._profile.bonus("contacto"),f"CONTACTO {obj['label']}")
                elif ik in self._interactions:
                    d=self._interactions.pop(ik); dur=now-d["startT"]
                    if dur<200: continue
                    if not self._obj_tracker.disappeared_after_contact(d["objId"]): continue
                    nearby=sum(1 for o in self._tracks if o["id"]!=t["id"] and not o.get("missed") and
                               _d((t["nx1"]+t["nx2"])/2,(t["ny1"]+t["ny2"])/2,(o["nx1"]+o["nx2"])/2,(o["ny1"]+o["ny2"])/2)<0.22)
                    if nearby>0 and self._profile.behaviors.get("traspaso"):
                        self._fire(f"hof_{t['id']}_{obj['id']}",f"TRASPASO: {d['label']}","high",self.config["cooldown"]*1000)
                        self._add_score(t,self._profile.bonus("traspaso"),"TRASPASO")
                    elif dur<=self._profile.grab_max_ms:
                        self._fire(f"grab_{t['id']}_{obj['id']}_{side}",f"ARREBATO: {d['label']}","high",self.config["cooldown"]*1000)
                        self._add_score(t,self._profile.bonus("arrebato"),"ARREBATO")
                    else:
                        zn_list=self._zones_for_point((b["nx1"]+b["nx2"])/2,(b["ny1"]+b["ny2"])/2)
                        zn=f" EN {zn_list[0]['name'].upper()}" if zn_list else ""
                        self._fire(f"og_{t['id']}_{obj['id']}_{side}",f"OBJETO TOMADO{zn}","high",self.config["cooldown"]*1000)
                        self._add_score(t,self._profile.bonus("objetoTomado"),f"TOMADO {d['label']}")
                    if _ok(w):
                        elbow=t["kps"][KP["L_ELBOW"] if side=="L" else KP["R_ELBOW"]]
                        t["postContact"]={"disappearT":now,"label":d["label"],"cls":d["cls"],
                                          "side":side,"wristY0":w["y"],
                                          "elbowY0":elbow["y"] if _ok(elbow) else None,
                                          "fired":False,"from_zone":False}
        for k in [k for k in self._interactions if k.startswith(f"{t['id']}_") and now-self._interactions[k]["startT"]>8000]:
            del self._interactions[k]

    # ── Caja heist ────────────────────────────────────────────────────────────
    def _check_caja_heist(self, t, lw, rw, lh, rh, le, re, now):
        for w,elbow,hip,side in [(lw,le,lh,"L"),(rw,re,rh,"R")]:
            for key,state in list(t["cajaExit"].items()):
                if not key.startswith(side+"_"): continue
                if now-state["t"]>2000: del t["cajaExit"][key]; continue
                if not _ok(w): continue
                if _ok(hip) and w["y"]>state["wristY"]+0.06 and abs(w["x"]-hip["x"])<0.15 and abs(w["y"]-hip["y"])<0.18:
                    self._fire(f"cj_pkt_{key}","CAJA → BOLSILLO","high",self.config["cooldown"]*1000)
                    del t["cajaExit"][key]; continue
                if _ok(elbow) and w["y"]<state["wristY"]-0.07 and w["y"]<elbow["y"]-0.04:
                    self._fire(f"cj_slv_{key}","CAJA → MANGA","high",self.config["cooldown"]*1000)
                    del t["cajaExit"][key]

    # ── Post-contact (B C D) ──────────────────────────────────────────────────
    def _check_post_contact(self, t, lw, rw, le, re, ls, rs, lh, rh, now):
        pc=t["postContact"]
        if not pc or pc["fired"]: return
        if now-pc["disappearT"]>self._profile.post_contact_ms: t["postContact"]=None; return
        w=lw if pc["side"]=="L" else rw; elbow=le if pc["side"]=="L" else re
        if not _ok(w): return
        hcc=self._profile.hip_conceal_conf
        if w["c"]<hcc: self._add_score(t,20,"WRIST OCULTA")
        if self._profile.behaviors.get("manga") and pc["elbowY0"] is not None and _ok(elbow):
            if w["y"]<pc["wristY0"]-0.07 and w["y"]<elbow["y"]-0.04:
                self._fire(f"slv_{t['id']}_{pc['cls']}",f"MANGA — {pc['label']} BAJO MANGA","high",self.config["cooldown"]*1000)
                self._add_score(t,self._profile.bonus("manga"),"BAJO MANGA")
                pc["fired"]=True; t["postContact"]=None; return
        if self._profile.behaviors.get("bagStuffing"):
            near_bag=next((o for o in self._obj_tracker.visible if o.get("cls",-1) in BAG_IDS and
                           _d(w["x"],w["y"],(o["bbox"]["nx1"]+o["bbox"]["nx2"])/2,(o["bbox"]["ny1"]+o["bbox"]["ny2"])/2)<0.14),None)
            if near_bag:
                self._fire(f"bag_{t['id']}_{pc['cls']}",f"BOLSO — {pc['label']} EN BOLSO","high",self.config["cooldown"]*1000)
                self._add_score(t,self._profile.bonus("bagStuffing"),"BAG STUFFING")
                pc["fired"]=True; t["postContact"]=None; return
        if all([_ok(ls),_ok(rs),_ok(lh),_ok(rh)]):
            bl=min(ls["x"],rs["x"],lh["x"],rh["x"]); br=max(ls["x"],rs["x"],lh["x"],rh["x"]); bw_=(br-bl)
            if (bl-bw_*0.15 < w["x"] < br+bw_*0.15 and
                    min(ls["y"],rs["y"]) < w["y"] < max(lh["y"],rh["y"])+0.12 and w["c"]<hcc):
                self._fire(f"trso_{t['id']}_{pc['cls']}",f"ROPA — {pc['label']} BAJO ROPA","high",self.config["cooldown"]*1000)
                self._add_score(t,self._profile.bonus("bajoropa"),"BAJO ROPA")
                pc["fired"]=True; t["postContact"]=None

    # ── Cadera ────────────────────────────────────────────────────────────────
    def _check_hip(self, t, lw, rw, lh, rh, now):
        pc=t["postContact"]
        if not pc or pc["fired"]: return
        if now-pc["disappearT"]>self._profile.post_contact_ms: return
        w=lw if pc["side"]=="L" else rw; hip=lh if pc["side"]=="L" else rh
        if not _ok(w) or not _ok(hip): return
        if (_d(w["x"],w["y"],hip["x"],hip["y"])<0.22 and
                hip["y"]-0.08<=w["y"]<=hip["y"]+0.20 and
                abs(w["y"]-pc.get("wristY0",w["y"]))>0.06):
            t["hipConcealment"]+=1
            self._add_score(t,5,f"WRIST CADERA {pc['side']}")
            if t["hipConcealment"]>=5:
                t["hipConcealment"]=0
                cl="MANO OCULTA" if w["c"]<self._profile.hip_conceal_conf else "MANO VISIBLE"
                self._fire(f"hip_{t['id']}_{pc['cls']}",
                           f"CADERA {'IZQ' if pc['side']=='L' else 'DER'} — {pc['label']} ({cl})","high",self.config["cooldown"]*1000)
                self._add_score(t,self._profile.bonus("cadera"),"CADERA")
                pc["fired"]=True; t["postContact"]=None; t["badges"].append("⚠ CADERA")
            elif t["hipConcealment"]>2: t["badges"].append("⚠ CADERA")
        else: t["hipConcealment"]=max(0,t["hipConcealment"]-1)

    # ── Merodeo ───────────────────────────────────────────────────────────────
    def _record_visit(self, t, zone, now):
        if zone.get("type")=="pago": return
        zid=zone["id"]; t["zoneVisits"].setdefault(zid,[])
        t["zoneVisits"][zid].append(now)
        t["zoneVisits"][zid]=[ts for ts in t["zoneVisits"][zid] if now-ts<90000]

    def _check_prowling(self, t, now):
        for z_id,tss in t["zoneVisits"].items():
            if len(tss)<3 or t["visitedPay"]: continue
            z=next((z for z in self._zones if z["id"]==z_id),None)
            self._fire(f"prl_{t['id']}_{z_id}",
                       f"MERODEO — {len(tss)} ACCESOS SIN COMPRA EN {z['name'].upper() if z else 'ZONA'}","medium",self.config["cooldown"]*1500)
            self._add_score(t,self._profile.bonus("merodeo"),"MERODEO")
            t["badges"].append("⚠ MERODEO")

    # ── Escaneo ───────────────────────────────────────────────────────────────
    def _check_scan(self, t, nose, now):
        if not _ok(nose): return
        t["noseXHist"].append({"x":nose["x"],"t":now})
        t["noseXHist"]=[p for p in t["noseXHist"] if now-p["t"]<1500]
        if len(t["noseXHist"])<6: return
        xs=[p["x"] for p in t["noseXHist"]]; mean=sum(xs)/len(xs)
        std=math.sqrt(sum((x-mean)**2 for x in xs)/len(xs))
        if std<0.06: return
        in_zone=any(t["inZoneWrist"].values())
        cx=(t["nx1"]+t["nx2"])/2; cy=(t["ny1"]+t["ny2"])/2
        near_obj=any(_d(cx,cy,(o["bbox"]["nx1"]+o["bbox"]["nx2"])/2,(o["bbox"]["ny1"]+o["bbox"]["ny2"])/2)<0.30
                     for o in self._obj_tracker.alert_visible)
        if not in_zone and not near_obj: return
        self._fire(f"scan_{t['id']}","ESCANEO — COMPORTAMIENTO PREVIO A HURTO","medium",self.config["cooldown"]*1000)
        self._add_score(t,self._profile.bonus("escaneo"),"ESCANEO")
        t["badges"].append("⚠ ESCANEO"); t["noseXHist"]=[]

    # ── Pantalla / Agachado / Trayectoria ─────────────────────────────────────
    def _check_body_screen(self, t, nose):
        no_head=not nose or nose["c"]<KP_THRESH; in_zone=any(t["inZoneWrist"].values())
        if no_head and in_zone:
            t["bodyScreen"]+=1
            if t["bodyScreen"]>=10:
                t["bodyScreen"]=0
                self._fire(f"bsc_{t['id']}","CUERPO COMO PANTALLA — DE ESPALDAS EN ZONA","high",self.config["cooldown"]*1000)
            if t["bodyScreen"]>5: t["badges"].append("⚠ PANTALLA"); self._add_score(t,self._profile.bonus("pantalla"),"PANTALLA")
        else: t["bodyScreen"]=max(0,t["bodyScreen"]-2)

    def _check_crouch(self, t, nose, ls, rs, lh, rh):
        pc=t["postContact"]
        if not pc or pc["fired"] or not _ok(nose) or not _ok(ls) or not _ok(rs): return
        sy=(ls["y"]+rs["y"])/2; hy=(lh["y"]+rh["y"])/2 if _ok(lh) and _ok(rh) else sy+0.3
        if nose["y"]>(sy+hy)/2+0.08:
            t["crouchHide"]+=1
            if t["crouchHide"]>=8:
                t["crouchHide"]=0
                self._fire(f"crch_{t['id']}_{pc['cls']}",f"AGACHADO — {pc['label']} ZONA BAJA","high",self.config["cooldown"]*1000)
                self._add_score(t,self._profile.bonus("agachado"),"AGACHADO")
                pc["fired"]=True; t["badges"].append("⚠ AGACHADO")
        else: t["crouchHide"]=max(0,t["crouchHide"]-2)

    def _check_trajectory(self, t, now):
        if t["directTrajFired"] or not t["firstZoneEntry"]: return
        ms=t["firstZoneEntry"]-t["firstSeen"]
        if 0<ms<MIN_BROWSE_MS:
            t["directTrajFired"]=True
            self._fire(f"traj_{t['id']}","ACCESO DIRECTO — SIN BROWSING","low",self.config["cooldown"]*1000)
            self._add_score(t,self._profile.bonus("trayectoria"),"TRAYECTORIA DIRECTA")
            t["badges"].append("⚠ DIRECTO")
        elif ms>=MIN_BROWSE_MS: t["directTrajFired"]=True

    # ── Score ─────────────────────────────────────────────────────────────────
    def _add_score(self, t, pts, reason):
        if t["isEmployee"]: return
        t["suspicionScore"]=min(100, t["suspicionScore"]+pts)
        if reason and reason not in t["scoreEvidence"]:
            t["scoreEvidence"].append(reason)
            if len(t["scoreEvidence"])>8: t["scoreEvidence"].pop(0)

    def _decay_score(self, t):
        if not t["postContact"] and not any(t["inZoneWrist"].values()):
            rate=6 if t["suspicionScore"]>50 else 3 if t["suspicionScore"]>25 else 2
            t["suspicionScore"]=max(0, t["suspicionScore"]-rate)
        if t["suspicionScore"]==0: t["scoreEvidence"]=[]

    def _check_score(self, t, now):
        th=self._profile.score_threshold
        if t["suspicionScore"]>=th:
            self._fire(f"score_{t['id']}",
                       f"ROBO CONFIRMADO — SCORE {round(t['suspicionScore'])}/100 | {' + '.join(t['scoreEvidence'][-3:])}",
                       "high", self.config["cooldown"]*1000,
                       score=round(t["suspicionScore"]), evidence=list(t["scoreEvidence"]))
            t["scoreEvidence"]=[]; t["suspicionScore"]=th*0.15
        if t["suspicionScore"]>=th*0.55: t["badges"].append(f"⚠ {round(t['suspicionScore'])}pts")

    # ── Fire ──────────────────────────────────────────────────────────────────
    def _fire(self, key, type_, severity, cool_ms, score=0, evidence=None):
        now=_ms()
        if now-self._last_alert.get(key,0)<cool_ms: return
        self._last_alert[key]=now
        self._pending_events.append({
            "key":key,"type":type_,"severity":severity,
            "score":score,"evidence":evidence or [],
            "timestamp":now,"camera_id":self.camera_id,
        })

    # ── Estado para el frontend ───────────────────────────────────────────────
    def get_state(self) -> dict:
        return {
            "tracks": [{
                "id":t["id"],"bbox":{"nx1":t["nx1"],"ny1":t["ny1"],"nx2":t["nx2"],"ny2":t["ny2"]},
                "kps":t["kps"],"score":round(t["suspicionScore"]),"badges":t["badges"],
                "isEmployee":t["isEmployee"],"inZone":any(t["inZoneWrist"].values()),
                "hasPostContact":bool(t["postContact"] and not t["postContact"]["fired"]),
            } for t in self._tracks if not t.get("missed")],
            "objects": [{
                "id":o["id"],"label":o["label"],"conf":round(o["conf"],2),
                "bbox":o["bbox"],"bySize":o.get("by_size",False),
            } for o in self._obj_tracker.visible],
            "profile":{"key":self._profile.key,"name":self._profile.name,"threshold":self._profile.score_threshold},
        }
