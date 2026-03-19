"""
api/training.py — Veesion Backend
Endpoints para fine-tuning del modelo con datasets públicos.
"""
import asyncio
import logging
import os
import datetime
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from db.database import get_db
from db.models import TrainingJob

logger    = logging.getLogger(__name__)
router    = APIRouter(prefix="/api/training", tags=["training"])
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="train")

PUBLIC_DATASETS = {
    "ucf_crime": {
        "name":    "UCF Crime Dataset (subset hurto/robo)",
        "classes": ["Shoplifting", "Robbery", "Stealing"],
        "frames":  2000,
    },
    "coco_subset": {
        "name":    "COCO 2017 — objetos de tienda",
        "classes": ["backpack", "handbag", "bottle", "cup", "laptop"],
        "frames":  5000,
    },
}


class TrainRequest(BaseModel):
    dataset:    str = "coco_subset"
    epochs:     int = 20
    model_size: str = "n"


def _run_training(job_id: int, dataset_key: str, epochs: int, model_size: str):
    import sqlite3, time, pathlib

    db_path = os.getenv("DATABASE_URL", "sqlite:///./veesion.db").replace("sqlite:///","")
    conn    = sqlite3.connect(db_path)

    def update(status, log="", map50=0.0, done=False):
        now = datetime.datetime.utcnow().isoformat()
        if done:
            conn.execute("UPDATE training_jobs SET status=?,log=?,map50=?,finished_at=? WHERE id=?",
                         (status, log, map50, now, job_id))
        else:
            conn.execute("UPDATE training_jobs SET status=?,log=? WHERE id=?", (status, log, job_id))
        conn.commit()

    log_lines = []
    def log(msg):
        log_lines.append(msg)
        update("running", "\n".join(log_lines[-20:]))

    try:
        update("running", "Iniciando...")
        log(f"📦 Dataset: {PUBLIC_DATASETS.get(dataset_key,{}).get('name', dataset_key)}")
        log(f"📐 Modelo base: yolo26{model_size}-pose.pt  |  Épocas: {epochs}")

        models_dir = pathlib.Path(os.getenv("MODELS_DIR","./models"))
        pose_pt    = models_dir / f"yolo26{model_size}-pose.pt"

        if not pose_pt.exists():
            log(f"❌ Modelo no encontrado: {pose_pt}")
            update("error", "\n".join(log_lines), done=True); return

        log("✅ Modelo base encontrado")
        log("🚀 Simulando entrenamiento (reemplazar con YOLO real cuando haya GPU)...")

        for epoch in range(1, min(epochs+1, 6)):
            time.sleep(1)
            log(f"  Epoch {epoch}/{epochs} — loss: {0.95-epoch*0.08:.3f} — mAP50: {0.30+epoch*0.05:.3f}")

        map50_val = 0.55
        log(f"✅ Completado — mAP50: {map50_val:.3f}")
        update("done", "\n".join(log_lines), map50=map50_val, done=True)

    except Exception as e:
        log(f"❌ Error: {e}")
        update("error", "\n".join(log_lines), done=True)
    finally:
        conn.close()


@router.get("/datasets")
async def get_datasets():
    return [{"key": k, **v} for k, v in PUBLIC_DATASETS.items()]

@router.get("/jobs")
async def get_jobs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrainingJob).order_by(TrainingJob.created_at.desc()).limit(10))
    return [{
        "id":j.id,"status":j.status,"dataset":j.dataset,"epochs":j.epochs,
        "map50":j.map50,"log":j.log[-500:] if j.log else "",
        "created_at":j.created_at.isoformat(),
        "finished_at":j.finished_at.isoformat() if j.finished_at else None,
    } for j in result.scalars().all()]

@router.get("/jobs/{job_id}")
async def get_job(job_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TrainingJob).where(TrainingJob.id == job_id))
    j = result.scalar_one_or_none()
    if not j: raise HTTPException(404, "Job no encontrado")
    return {"id":j.id,"status":j.status,"dataset":j.dataset,"epochs":j.epochs,
            "map50":j.map50,"log":j.log,
            "created_at":j.created_at.isoformat(),
            "finished_at":j.finished_at.isoformat() if j.finished_at else None}

@router.post("/start")
async def start_training(body: TrainRequest, db: AsyncSession = Depends(get_db)):
    if body.dataset not in PUBLIC_DATASETS:
        raise HTTPException(400, f"Dataset '{body.dataset}' no disponible")
    result = await db.execute(select(TrainingJob).where(TrainingJob.status == "running"))
    if result.scalar_one_or_none():
        raise HTTPException(409, "Ya hay un entrenamiento en curso")
    job = TrainingJob(dataset=body.dataset, epochs=body.epochs, status="pending")
    db.add(job); await db.commit(); await db.refresh(job)
    asyncio.get_event_loop().run_in_executor(
        _executor, _run_training, job.id, body.dataset, body.epochs, body.model_size)
    return {"job_id": job.id, "status": "started"}
