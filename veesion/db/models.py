import datetime
from sqlalchemy import String, Integer, Float, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


class Camera(Base):
    __tablename__ = "cameras"
    id:         Mapped[int]  = mapped_column(Integer, primary_key=True, index=True)
    name:       Mapped[str]  = mapped_column(String(64), default="Cámara")
    store_type: Mapped[str]  = mapped_column(String(32), default="generico")
    active:     Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow)
    events: Mapped[list["Event"]] = relationship(back_populates="camera", cascade="all, delete-orphan")


class Event(Base):
    __tablename__ = "events"
    id:           Mapped[int]   = mapped_column(Integer, primary_key=True, index=True)
    camera_id:    Mapped[int]   = mapped_column(Integer, ForeignKey("cameras.id"), index=True)
    event_type:   Mapped[str]   = mapped_column(String(128))
    severity:     Mapped[str]   = mapped_column(String(16))
    score:        Mapped[float] = mapped_column(Float, default=0.0)
    evidence:     Mapped[str]   = mapped_column(Text, default="")
    snapshot_b64: Mapped[str]   = mapped_column(Text, default="")
    timestamp:    Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow, index=True)
    camera: Mapped["Camera"] = relationship(back_populates="events")


class TrainingJob(Base):
    __tablename__ = "training_jobs"
    id:          Mapped[int]   = mapped_column(Integer, primary_key=True, index=True)
    status:      Mapped[str]   = mapped_column(String(32), default="pending")
    dataset:     Mapped[str]   = mapped_column(String(64), default="public")
    epochs:      Mapped[int]   = mapped_column(Integer, default=20)
    map50:       Mapped[float] = mapped_column(Float, default=0.0)
    log:         Mapped[str]   = mapped_column(Text, default="")
    created_at:  Mapped[datetime.datetime] = mapped_column(DateTime, default=datetime.datetime.utcnow)
    finished_at: Mapped[datetime.datetime | None] = mapped_column(DateTime, nullable=True)
