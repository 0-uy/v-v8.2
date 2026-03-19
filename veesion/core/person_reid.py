"""
core/person_reid.py

Re-identificación visual de personas usando embeddings.
Permite mantener identidad aunque cambie track_id.
"""

import cv2
import numpy as np


class PersonReID:

    def __init__(self):

        self.embeddings = {}

    def extract_embedding(self, frame, bbox):

        h, w = frame.shape[:2]

        x1 = int(bbox["nx1"] * w)
        y1 = int(bbox["ny1"] * h)
        x2 = int(bbox["nx2"] * w)
        y2 = int(bbox["ny2"] * h)

        crop = frame[y1:y2, x1:x2]

        if crop.size == 0:
            return None

        crop = cv2.resize(crop, (64, 128))

        hist = cv2.calcHist(
            [crop],
            [0, 1, 2],
            None,
            [8, 8, 8],
            [0, 256, 0, 256, 0, 256],
        )

        cv2.normalize(hist, hist)

        return hist.flatten()

    def cosine_distance(self, a, b):

        if a is None or b is None:
            return 1.0

        return 1 - np.dot(a, b) / (
            np.linalg.norm(a) * np.linalg.norm(b) + 1e-6
        )

    def match(self, frame, slot_id, bbox):

        emb = self.extract_embedding(frame, bbox)

        if emb is None:
            return None

        best_slot = None
        best_dist = 0.4

        for sid, ref_emb in self.embeddings.items():

            dist = self.cosine_distance(emb, ref_emb)

            if dist < best_dist:

                best_dist = dist
                best_slot = sid

        if best_slot is None:

            self.embeddings[slot_id] = emb
            return slot_id

        return best_slot