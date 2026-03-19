"""
core/fusion_engine.py

Combina múltiples detectores de robo en un único
risk score más robusto.
"""

import logging

logger = logging.getLogger(__name__)


class FusionEngine:

    def __init__(self):

        # pesos base
        self.w_behavior = 0.50
        self.w_lstm = 0.20
        self.w_yolo = 0.20
        self.w_github = 0.10

        # threshold final
        self.alert_threshold = 0.45

    def compute_risk(
        self,
        behavior_score=0.0,
        lstm_score=0.0,
        yolo_score=0.0,
        github_score=0.0,
    ):
        """
        Calcula riesgo combinado.
        """

        behavior_score = float(behavior_score or 0.0)
        lstm_score = float(lstm_score or 0.0)
        yolo_score = float(yolo_score or 0.0)
        github_score = float(github_score or 0.0)

        risk = (
            self.w_behavior * behavior_score
            + self.w_lstm * lstm_score
            + self.w_yolo * yolo_score
            + self.w_github * github_score
        )

        # ─────────────────────────
        # bonuses por combinación
        # ─────────────────────────

        # comportamiento fuerte por sí solo
        if behavior_score >= 0.70:
            risk += 0.10

        # combinación comportamiento + yolo
        if behavior_score >= 0.30 and yolo_score >= 0.30:
            risk += 0.15

        # combinación comportamiento + lstm
        if behavior_score >= 0.30 and lstm_score >= 0.30:
            risk += 0.10

        # yolo fuerte solo
        if yolo_score >= 0.75:
            risk += 0.08

        # github fuerte solo
        if github_score >= 0.75:
            risk += 0.08

        # fusión múltiple
        active = sum([
            behavior_score >= 0.25,
            lstm_score >= 0.25,
            yolo_score >= 0.25,
            github_score >= 0.25,
        ])

        if active >= 2:
            risk += 0.05

        if active >= 3:
            risk += 0.10

        risk = min(1.0, risk)

        return round(risk, 3)

    def evaluate(
        self,
        track_id,
        behavior_score=0.0,
        lstm_score=0.0,
        yolo_score=0.0,
        github_score=0.0,
    ):
        """
        Devuelve alerta si el riesgo supera threshold.
        """

        risk = self.compute_risk(
            behavior_score,
            lstm_score,
            yolo_score,
            github_score,
        )

        if risk >= self.alert_threshold:

            logger.info(
                f"Fusion ALERT track={track_id} "
                f"risk={risk:.2f} "
                f"behavior={behavior_score:.2f} "
                f"lstm={lstm_score:.2f} "
                f"yolo={yolo_score:.2f} "
                f"github={github_score:.2f}"
            )

            return {
                "type": "ALERTA_FUSION",
                "trackId": track_id,
                "risk": risk,
                "behavior": round(float(behavior_score or 0.0), 3),
                "lstm": round(float(lstm_score or 0.0), 3),
                "yolo": round(float(yolo_score or 0.0), 3),
                "github": round(float(github_score or 0.0), 3),
            }

        return None
