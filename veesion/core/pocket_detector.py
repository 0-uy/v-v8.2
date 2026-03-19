"""
core/pocket_detector.py

Detector de mano → bolsillo usando keypoints de pose
(usa muñecas y caderas para estimar la zona de bolsillo)
"""

class PocketDetector:

    def __init__(self):
        # distancia máxima (normalizada) entre muñeca y zona de bolsillo
        self.threshold = 0.08

    def _dist(self, a, b):
        dx = a[0] - b[0]
        dy = a[1] - b[1]
        return (dx*dx + dy*dy) ** 0.5

    def _pocket_point(self, hip):
        """
        Estima punto de bolsillo a partir de la cadera.
        """
        x, y = hip
        return (x, y + 0.03)

    def detect(self, tracks):

        events = []

        for track in tracks:

            slot_id = track.get("slot_id")
            keypoints = track.get("keypoints")

            if not keypoints:
                continue

            left_wrist = keypoints.get("left_wrist")
            right_wrist = keypoints.get("right_wrist")
            left_hip = keypoints.get("left_hip")
            right_hip = keypoints.get("right_hip")

            if left_wrist and left_hip:

                pocket = self._pocket_point(left_hip)

                if self._dist(left_wrist, pocket) < self.threshold:

                    events.append(
                        {
                            "type": "HAND_POCKET",
                            "slot_id": slot_id,
                            "hand": "left",
                        }
                    )

            if right_wrist and right_hip:

                pocket = self._pocket_point(right_hip)

                if self._dist(right_wrist, pocket) < self.threshold:

                    events.append(
                        {
                            "type": "HAND_POCKET",
                            "slot_id": slot_id,
                            "hand": "right",
                        }
                    )

        return events