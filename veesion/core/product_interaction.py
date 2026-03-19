"""
core/product_interaction.py

Detector de interacción mano → zona de productos
"""

import math


class ProductInteractionDetector:

    def __init__(self):

        self.product_zones = []

    def set_zones(self, zones):

        """
        zones:
        [
            {"nx1":0.1,"ny1":0.2,"nx2":0.4,"ny2":0.6}
        ]
        """

        self.product_zones = zones

    def point_inside(self, x, y, box):

        return (
            x >= box["nx1"]
            and x <= box["nx2"]
            and y >= box["ny1"]
            and y <= box["ny2"]
        )

    def detect(self, tracks):

        events = []

        for track in tracks:

            slot_id = track.get("slot_id")

            keypoints = track.get("keypoints")

            if not keypoints:
                continue

            left_hand = keypoints.get("left_wrist")
            right_hand = keypoints.get("right_wrist")

            for zone in self.product_zones:

                if left_hand:

                    if self.point_inside(
                        left_hand[0],
                        left_hand[1],
                        zone
                    ):

                        events.append(
                            {
                                "type": "HAND_PRODUCT",
                                "slot_id": slot_id,
                                "hand": "left",
                            }
                        )

                if right_hand:

                    if self.point_inside(
                        right_hand[0],
                        right_hand[1],
                        zone
                    ):

                        events.append(
                            {
                                "type": "HAND_PRODUCT",
                                "slot_id": slot_id,
                                "hand": "right",
                            }
                        )

        return events