"""
main.py — Veesion Backend v1.0
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from db.database import init_db
from core.inference import engine as inference_engine, MODELS_DIR
from api.websocket import handle_camera_ws
from api.events import router as events_router
from api.training import router as training_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

_model_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model_load")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Veesion Backend arrancando...")
    await init_db()
    logger.info("✅ Base de datos inicializada")
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(_model_executor, inference_engine.load_models)
        logger.info("✅ Modelos YOLO26n listos")
    except Exception as e:
        logger.error(f"❌ No se pudieron cargar los modelos: {e}")
        logger.warning(f"   Verificá que los archivos .pt estén en: {MODELS_DIR}")
    yield
    logger.info("🛑 Veesion Backend cerrando...")


app = FastAPI(
    title="Veesion API",
    description="Backend de detección de comportamientos sospechosos",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(events_router)
app.include_router(training_router)


@app.websocket("/ws/camera/{camera_id}")
async def camera_websocket(websocket: WebSocket, camera_id: int):
    await handle_camera_ws(websocket, camera_id)


@app.get("/proxy/mjpeg")
async def proxy_mjpeg(url: str):
    """
    Proxy para cámaras MJPEG externas.
    Evita el bloqueo CORS del navegador al servir el stream desde el mismo origen.
    Uso: /proxy/mjpeg?url=http://ip:puerto/video.mjpg
    """
    import httpx
    from fastapi.responses import StreamingResponse

    async def _stream():
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                async with client.stream("GET", url) as r:
                    async for chunk in r.aiter_bytes(chunk_size=4096):
                        yield chunk
        except Exception as e:
            logger.error(f"Proxy MJPEG error ({url}): {e}")

    # Detectar content-type real de la cámara
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            head = await client.head(url)
            ct = head.headers.get("content-type", "multipart/x-mixed-replace;boundary=--myboundary")
    except Exception:
        ct = "multipart/x-mixed-replace;boundary=--myboundary"

    return StreamingResponse(
        _stream(),
        media_type=ct,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
async def root():
    return {
        "service": "Veesion Backend",
        "version": "1.0.0",
        "status":  "ok",
        "models":  "ready" if inference_engine.ready else "loading",
    }

@app.get("/api/status")
async def status():
    return {
        "models_ready": inference_engine.ready,
        "models_dir":   str(MODELS_DIR),
        "pose_model":   str(MODELS_DIR / "yolo26n-pose.pt"),
        "obj_model":    str(MODELS_DIR / "yolo26n.pt"),
    }