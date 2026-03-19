from dataclasses import dataclass, field

SCORE_DEFAULTS = {
    "contacto": 15, "objetoTomado": 40, "arrebato": 55,
    "traspaso": 50, "bajoropa": 35, "cadera": 35, "manga": 35,
    "agachado": 30, "bagStuffing": 45, "pantalla": 25,
    "escaneo": 10, "merodeo": 20, "brazoscruzados": 15,
    "distractor": 30, "trayectoria": 8, "zonePostContact": 20,
}

BEHAVIORS_DEFAULT = {
    "merodeo": True, "escaneo": True, "pantalla": True,
    "cadera": True, "manga": True, "agachado": True,
    "bagStuffing": True, "traspaso": True, "distractor": True, "trayectoria": True,
}


@dataclass
class Profile:
    key:               str
    name:              str
    icon:              str
    dwell_time:        float = 4.0
    contact_min_ms:    int   = 400
    grab_max_ms:       int   = 700
    score_threshold:   int   = 72
    post_contact_ms:   int   = 4000
    zone_entry_frames: int   = 3
    hip_conceal_conf:  float = 0.55
    families:          list  = field(default_factory=lambda: ["SMALL","MEDIUM","BAG","TECH"])
    behaviors:         dict  = field(default_factory=lambda: dict(BEHAVIORS_DEFAULT))
    score_bonus:       dict  = field(default_factory=lambda: dict(SCORE_DEFAULTS))

    def bonus(self, key: str) -> int:
        return self.score_bonus.get(key, SCORE_DEFAULTS.get(key, 15))


_PROFILES = {
    "generico": Profile(key="generico", name="Genérico", icon="🏪"),
    "supermercado": Profile(
        key="supermercado", name="Supermercado / Almacén", icon="🛒",
        dwell_time=5, contact_min_ms=500, score_threshold=75, zone_entry_frames=4,
        behaviors={**BEHAVIORS_DEFAULT, "trayectoria": False},
        score_bonus={**SCORE_DEFAULTS, "contacto": 10, "objetoTomado": 35},
    ),
    "farmacia": Profile(
        key="farmacia", name="Farmacia", icon="💊",
        dwell_time=3, contact_min_ms=350, score_threshold=68,
        hip_conceal_conf=0.52, families=["SMALL","MEDIUM"],
    ),
    "kiosco": Profile(
        key="kiosco", name="Kiosco / Cafetería", icon="☕",
        dwell_time=2, contact_min_ms=300, score_threshold=65,
        post_contact_ms=3000, zone_entry_frames=2,
        behaviors={**BEHAVIORS_DEFAULT, "distractor": False},
        score_bonus={**SCORE_DEFAULTS, "contacto": 20},
    ),
    "joyeria": Profile(
        key="joyeria", name="Joyería", icon="💎",
        dwell_time=2, contact_min_ms=200, score_threshold=55,
        post_contact_ms=5000, zone_entry_frames=2, hip_conceal_conf=0.60,
        families=["JEWELRY","SMALL","MEDIUM"],
        behaviors={**BEHAVIORS_DEFAULT, "agachado": False, "bagStuffing": False},
        score_bonus={**SCORE_DEFAULTS, "contacto": 25, "objetoTomado": 55},
    ),
    "ropa": Profile(
        key="ropa", name="Tienda de Ropa", icon="👕",
        dwell_time=6, contact_min_ms=600, score_threshold=78,
        post_contact_ms=5000, zone_entry_frames=4, hip_conceal_conf=0.50,
        families=["BAG"],
        behaviors={**BEHAVIORS_DEFAULT, "trayectoria": False},
        score_bonus={**SCORE_DEFAULTS, "bagStuffing": 50, "manga": 40},
    ),
    "bazar": Profile(
        key="bazar", name="Bazar / Tienda variada", icon="🏬",
        dwell_time=4, contact_min_ms=400, score_threshold=70, hip_conceal_conf=0.53,
    ),
    "deposito": Profile(
        key="deposito", name="Depósito / Bodega", icon="📦",
        dwell_time=2, contact_min_ms=300, score_threshold=60, zone_entry_frames=2,
        behaviors={**BEHAVIORS_DEFAULT, "merodeo": False, "distractor": False, "trayectoria": False},
        score_bonus={**SCORE_DEFAULTS, "contacto": 20},
    ),
    "cocina": Profile(
        key="cocina", name="Cocina / Área preparación", icon="🍳",
        dwell_time=8, contact_min_ms=800, score_threshold=82,
        post_contact_ms=3000, zone_entry_frames=5, hip_conceal_conf=0.60,
        families=["SMALL","MEDIUM","TECH"],
        behaviors={**BEHAVIORS_DEFAULT,
                   "merodeo": False, "escaneo": False, "pantalla": False,
                   "agachado": False, "distractor": False, "trayectoria": False},
        score_bonus={**SCORE_DEFAULTS, "contacto": 5, "cadera": 45, "manga": 45, "bagStuffing": 55},
    ),
}

_ALIASES = {
    "minimercado": "supermercado", "almacen": "supermercado", "almacén": "supermercado",
    "cafeteria": "kiosco", "cafetería": "kiosco", "cafe": "kiosco", "café": "kiosco",
    "tienda": "bazar", "joyería": "joyeria", "vestimenta": "ropa",
    "depósito": "deposito", "bodega": "deposito", "kiosko": "kiosco",
}


def get_profile(store_type: str = "generico") -> Profile:
    key = _ALIASES.get(store_type.lower().strip(), store_type.lower().strip())
    return _PROFILES.get(key, _PROFILES["generico"])


def list_profiles() -> list[dict]:
    return [{"key": p.key, "name": p.name, "icon": p.icon} for p in _PROFILES.values()]
