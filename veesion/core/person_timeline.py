"""
core/person_timeline.py

Mantiene historia temporal de acciones por persona.
Permite detectar patrones de comportamiento sospechoso.
"""

import time


class PersonTimeline:

    def __init__(self, max_events=20):

        self.max_events = max_events
        self.persons = {}

    def update(self, slot_id, actions):

        now = time.time()

        if slot_id not in self.persons:

            self.persons[slot_id] = {
                "events": [],
                "last_seen": now
            }

        person = self.persons[slot_id]

        person["last_seen"] = now

        for act in actions:

            person["events"].append(
                {
                    "time": now,
                    "action": act
                }
            )

        # limitar historial
        person["events"] = person["events"][-self.max_events:]

    def get_actions(self, slot_id):

        if slot_id not in self.persons:
            return []

        return [e["action"] for e in self.persons[slot_id]["events"]]

    def detect_pattern(self, slot_id):

        """
        Detecta patrones de robo comunes.
        """

        actions = self.get_actions(slot_id)

        if not actions:
            return None

        # ejemplo simple
        if "pick_item" in actions and "hand_pocket" in actions:
            return "conceal_item"

        if "pick_item" in actions and "bend_down" in actions:
            return "suspicious_pick"

        if "hand_pocket" in actions and "leave_area" in actions:
            return "exit_with_item"

        return None