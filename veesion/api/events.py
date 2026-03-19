"""
api/events.py — Veesion Backend
Endpoints REST: eventos, cámaras, estadísticas, perfiles.
"""
import json
import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func

from db.database import get_db
from db.models import Event, Camera
from core.profiles import list_profiles, get_profile

router = APIRouter(prefix="/api", tags=["api"])


# ── Schemas ───────────────────────────────────────────────────────────────────
class EventIn(BaseModel):
    camera_id:    int
    event_type:   str
    severity:     str   = "medium"
    score:        float = 0.0
    evidence:     list[str] = []
    snapshot_b64: str   = ""

class CameraIn(BaseModel):
    name:       str = "Cámara"
    store_type: str = "generico"

class CameraOut(BaseModel):
    id:         int
    name:       str
    store_type: str
    active:     bool
    class Config:
        from_attributes = True


# ── Cámaras ───────────────────────────────────────────────────────────────────
@router.get("/cameras", response_model=list[CameraOut])
async def get_cameras(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.active == True))
    return result.scalars().all()

@router.post("/cameras", response_model=CameraOut)
async def create_camera(body: CameraIn, db: AsyncSession = Depends(get_db)):
    cam = Camera(name=body.name, store_type=body.store_type)
    db.add(cam); await db.commit(); await db.refresh(cam)
    return cam

@router.delete("/cameras/{camera_id}")
async def delete_camera(camera_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam: raise HTTPException(404, "Cámara no encontrada")
    cam.active = False; await db.commit()
    return {"ok": True}


# ── Eventos ───────────────────────────────────────────────────────────────────
@router.get("/events")
async def get_events(
    camera_id: int | None = Query(None),
    severity:  str | None = Query(None),
    limit:     int = Query(60, le=200),
    offset:    int = Query(0),
    db: AsyncSession = Depends(get_db),
):
    q = select(Event).order_by(desc(Event.timestamp))
    if camera_id is not None: q = q.where(Event.camera_id == camera_id)
    if severity:               q = q.where(Event.severity == severity)
    q = q.limit(limit).offset(offset)
    events = (await db.execute(q)).scalars().all()
    return [{
        "id":          e.id,
        "camera_id":   e.camera_id,
        "event_type":  e.event_type,
        "severity":    e.severity,
        "score":       e.score,
        "evidence":    json.loads(e.evidence) if e.evidence else [],
        "snapshot_b64":e.snapshot_b64,
        "timestamp":   e.timestamp.isoformat(),
    } for e in events]

@router.post("/events")
async def create_event(body: EventIn, db: AsyncSession = Depends(get_db)):
    ev = Event(
        camera_id=body.camera_id, event_type=body.event_type,
        severity=body.severity, score=body.score,
        evidence=json.dumps(body.evidence), snapshot_b64=body.snapshot_b64,
    )
    db.add(ev); await db.commit(); await db.refresh(ev)
    return {"id": ev.id, "ok": True}

@router.delete("/events/{event_id}")
async def delete_event(event_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Event).where(Event.id == event_id))
    ev = result.scalar_one_or_none()
    if not ev: raise HTTPException(404, "Evento no encontrado")
    await db.delete(ev); await db.commit()
    return {"ok": True}

@router.delete("/events")
async def clear_events(camera_id: int | None = Query(None), db: AsyncSession = Depends(get_db)):
    q = select(Event)
    if camera_id: q = q.where(Event.camera_id == camera_id)
    for ev in (await db.execute(q)).scalars().all():
        await db.delete(ev)
    await db.commit()
    return {"ok": True}


# ── Stats ─────────────────────────────────────────────────────────────────────
@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    today   = datetime.datetime.utcnow().date()
    total   = await db.scalar(select(func.count(Event.id)))
    today_n = await db.scalar(select(func.count(Event.id)).where(func.date(Event.timestamp) == today))
    high_n  = await db.scalar(select(func.count(Event.id)).where(Event.severity == "high"))
    return {"total": total, "today": today_n, "high": high_n}


# ── Perfiles ──────────────────────────────────────────────────────────────────
@router.get("/profiles")
async def get_profiles():
    return list_profiles()

@router.get("/profiles/{key}")
async def get_profile_detail(key: str):
    p = get_profile(key)
    return {
        "key": p.key, "name": p.name, "icon": p.icon,
        "dwell_time": p.dwell_time, "score_threshold": p.score_threshold,
        "behaviors": p.behaviors, "families": p.families,
    }
