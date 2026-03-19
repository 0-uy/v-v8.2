/**
 * store-profiles.js — SSIP v8.4 (COMPLETO)
 * ─────────────────────────────────────────────────────────────────────
 * Cambios v8.4:
 * [AJUSTE-1] Thresholds calibrados para reducir falsos positivos
 * [AJUSTE-2] Nuevos parámetros: minDepth, minDisappearanceFrames, minWristOcclusion
 * [AJUSTE-3] Scores rebalanceados: más peso a ocultamiento, menos a contactos casuales
 * [AJUSTE-4] Configuración de buffer por perfil
 */

// ─────────────────────────────────────────────────────────────────────
//  FAMILIAS DE OBJETOS
// ─────────────────────────────────────────────────────────────────────
export const OBJ_FAMILIES = {
  SMALL: {
    ids:     new Set([39, 41, 44, 45, 75, 76, 78, 201, 312, 389, 445, 602]),
    label:   'OBJETO PEQUEÑO',
    minConf: 0.38,
  },
  MEDIUM: {
    ids:     new Set([40, 42, 43, 46, 47, 49, 67, 73, 156, 198, 203, 488]),
    label:   'OBJETO',
    minConf: 0.36,
  },
  BAG: {
    ids:     new Set([24, 26, 28, 163, 164, 677]),
    label:   'BOLSO/MOCHILA',
    minConf: 0.50,
  },
  TECH: {
    ids:     new Set([63, 64, 65, 66, 118, 199, 210, 805]),
    label:   'DISPOSITIVO',
    minConf: 0.32,
  },
  JEWELRY: {
    ids:     new Set([74, 93, 111, 182, 185, 248]),
    label:   'JOYA/RELOJ',
    minConf: 0.45,
  },
  FOOD: {
    ids:     new Set([140, 224, 721, 876, 133, 512, 634]),
    label:   'ALIMENTO/BEBIDA',
    minConf: 0.38,
  },
  COSMETIC: {
    ids:     new Set([136, 276, 306, 478, 519, 623]),
    label:   'COSMÉTICO',
    minConf: 0.40,
  },
  PHARMA: {
    ids:     new Set([158, 197, 361, 402, 558]),
    label:   'MEDICAMENTO',
    minConf: 0.42,
  },
  CLOTHING: {
    ids:     new Set([207, 369, 488, 598, 736, 783, 812, 834]),
    label:   'PRENDA',
    minConf: 0.38,
  },
  TOOL: {
    ids:     new Set([308, 459, 473, 531, 612]),
    label:   'HERRAMIENTA',
    minConf: 0.40,
  },
};

/** Dado un cls, retorna la familia o null */
export function getFamily(cls) {
  for (const [key, fam] of Object.entries(OBJ_FAMILIES)) {
    if (fam.ids.has(cls)) return { key, ...fam };
  }
  return null;
}

export const BAG_IDS = new Set([...OBJ_FAMILIES.BAG.ids]);

export const ALERT_IDS = new Set([
  ...OBJ_FAMILIES.SMALL.ids,
  ...OBJ_FAMILIES.MEDIUM.ids,
  ...OBJ_FAMILIES.BAG.ids,
  ...OBJ_FAMILIES.TECH.ids,
  ...OBJ_FAMILIES.JEWELRY.ids,
  ...OBJ_FAMILIES.FOOD.ids,
  ...OBJ_FAMILIES.COSMETIC.ids,
  ...OBJ_FAMILIES.PHARMA.ids,
  ...OBJ_FAMILIES.CLOTHING.ids,
  ...OBJ_FAMILIES.TOOL.ids,
]);

// ─────────────────────────────────────────────────────────────────────
//  SCORE BONUS DEFAULTS — base para todos los perfiles
// ─────────────────────────────────────────────────────────────────────
export const SCORE_BONUS_DEFAULTS = {
  contacto:          13,
  objetoTomado:      38,
  arrebato:          52,
  traspaso:          48,
  bajoropa:          33,
  cadera:            33,
  manga:             33,
  agachado:          28,
  bagStuffing:       43,
  pantalla:          23,
  escaneo:            9,
  merodeo:           18,
  brazoscruzados:    13,
  distractor:        28,
  trayectoria:        7,
  pinchGrip:         18,
  wristOculta:       18,
  coordinacion:      20,
  formacionV:        15,
  secuencia:         10,
  permanencia:       15,
  escapeZona:        25,
  objetoOculto:      30,
};

// ─────────────────────────────────────────────────────────────────────
//  CONFIGURACIÓN DE BUFFER POR COMPORTAMIENTO
// ─────────────────────────────────────────────────────────────────────
export const BEHAVIOR_CONFIG = {
  pocket: {
    bufferSize: 30,
    minWindow: 8,
    maxWindow: 20,
    weights: {
      verticalDist: 0.30,
      horizontalDist: 0.25,
      occlusion: 0.20,
      velocity: 0.15,
      temporal: 0.10
    },
    patterns: {
      theft: { minConfidence: 0.7, description: 'Bajada rápida, pausa, subida' },
      natural: { maxConfidence: 0.3, description: 'Movimiento suave y continuo' }
    }
  },
  handObj: {
    bufferSize: 20,
    minWindow: 5,
    maxWindow: 12,
    weights: {
      contactDuration: 0.35,
      disappearance: 0.40,
      handVelocity: 0.25
    }
  },
  scanning: {
    bufferSize: 45,
    minWindow: 15,
    maxWindow: 30,
    headMovementThreshold: 0.06,
    minTimeMs: 1500
  }
};

// ─────────────────────────────────────────────────────────────────────
//  PERFILES COMPLETOS CON THRESHOLDS AJUSTADOS
// ─────────────────────────────────────────────────────────────────────
const PROFILES = {
  generico: {
    name: 'Genérico',
    icon: '🏪',
    
    dwellTime: 4,
    contactMinMs: 400,
    grabMaxMs: 700,
    scoreThreshold: 68,
    postContactMs: 5000,
    zoneEntryFrames: 3,
    hipConcealConf: 0.55,
    
    families: ['SMALL', 'MEDIUM', 'BAG', 'TECH', 'FOOD'],
    
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.75,
        minFramesWithContext: 8,
        minFramesWithoutContext: 15,
        maxHorizontalDist: 0.14,
        minVerticalBelow: 0.03,
        minDepth: 0.18
      },
      handObj: {
        minConfidence: 0.68,
        minContactMs: 500,
        maxGrabMs: 600,
        minDisappearanceFrames: 8
      },
      concealment: {
        minWristOcclusion: 0.45,
        minHandMovement: 0.08,
        underClothesThreshold: 0.65
      },
      scanning: {
        headMovementThreshold: 0.08,
        minTimeMs: 2000,
        minHeadTurns: 3
      },
      crouch: {
        minDepth: 0.12,
        minFrames: 10,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 10,
      objetoTomado: 35,
      bagStuffing: 40,
      pinchGrip: 15,
      bajoropa: 45,
      manga: 40,
      cadera: 35,
      agachado: 30,
    },
    
    buffer: {
      enabled: true,
      maxSize: 35,
      minConfidence: 0.60
    }
  },

  farmacia: {
    name: 'Farmacia',
    icon: '💊',
    dwellTime: 3,
    contactMinMs: 350,
    grabMaxMs: 550,
    scoreThreshold: 65,
    postContactMs: 5500,
    zoneEntryFrames: 3,
    hipConcealConf: 0.52,
    families: ['SMALL', 'MEDIUM', 'PHARMA', 'COSMETIC'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.70,
        minFramesWithContext: 6,
        minFramesWithoutContext: 12,
        maxHorizontalDist: 0.13,
        minVerticalBelow: 0.02,
        minDepth: 0.15
      },
      handObj: {
        minConfidence: 0.60,
        minContactMs: 300,
        maxGrabMs: 500,
        minDisappearanceFrames: 6
      },
      concealment: {
        minWristOcclusion: 0.40,
        minHandMovement: 0.06,
        underClothesThreshold: 0.60
      },
      scanning: {
        headMovementThreshold: 0.06,
        minTimeMs: 1500,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.10,
        minFrames: 8,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 14,
      objetoTomado: 40,
      pinchGrip: 20,
      manga: 38,
      cadera: 38,
      bajoropa: 42,
      agachado: 32,
    },
    
    buffer: {
      enabled: true,
      maxSize: 30,
      minConfidence: 0.55
    }
  },

  supermercado: {
    name: 'Supermercado',
    icon: '🛒',
    dwellTime: 5,
    contactMinMs: 450,
    grabMaxMs: 650,
    scoreThreshold: 70,
    postContactMs: 5500,
    zoneEntryFrames: 4,
    hipConcealConf: 0.55,
    families: ['SMALL', 'MEDIUM', 'BAG', 'FOOD', 'COSMETIC'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: false,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.72,
        minFramesWithContext: 7,
        minFramesWithoutContext: 14,
        maxHorizontalDist: 0.15,
        minVerticalBelow: 0.02,
        minDepth: 0.16
      },
      handObj: {
        minConfidence: 0.62,
        minContactMs: 400,
        maxGrabMs: 600,
        minDisappearanceFrames: 7
      },
      concealment: {
        minWristOcclusion: 0.45,
        minHandMovement: 0.07,
        underClothesThreshold: 0.62
      },
      scanning: {
        headMovementThreshold: 0.07,
        minTimeMs: 1800,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.11,
        minFrames: 9,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 8,
      objetoTomado: 30,
      bagStuffing: 40,
      pinchGrip: 18,
      coordinacion: 22,
      bajoropa: 40,
      manga: 35,
    },
    
    buffer: {
      enabled: true,
      maxSize: 35,
      minConfidence: 0.58
    }
  },

  electronica: {
    name: 'Electrónica',
    icon: '📱',
    dwellTime: 3,
    contactMinMs: 300,
    grabMaxMs: 500,
    scoreThreshold: 60,
    postContactMs: 6000,
    zoneEntryFrames: 3,
    hipConcealConf: 0.55,
    families: ['TECH', 'SMALL', 'MEDIUM'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: false,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.73,
        minFramesWithContext: 6,
        minFramesWithoutContext: 12,
        maxHorizontalDist: 0.14,
        minVerticalBelow: 0.02,
        minDepth: 0.15
      },
      handObj: {
        minConfidence: 0.55,
        minContactMs: 250,
        maxGrabMs: 450,
        minDisappearanceFrames: 5
      },
      concealment: {
        minWristOcclusion: 0.42,
        minHandMovement: 0.06,
        underClothesThreshold: 0.58
      },
      scanning: {
        headMovementThreshold: 0.06,
        minTimeMs: 1200,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.10,
        minFrames: 7,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 18,
      objetoTomado: 50,
      pinchGrip: 28,
      traspaso: 50,
      distractor: 32,
      coordinacion: 28,
    },
    
    buffer: {
      enabled: true,
      maxSize: 25,
      minConfidence: 0.60
    }
  },

  joyeria: {
    name: 'Joyería',
    icon: '💎',
    dwellTime: 2,
    contactMinMs: 200,
    grabMaxMs: 400,
    scoreThreshold: 55,
    postContactMs: 6500,
    zoneEntryFrames: 2,
    hipConcealConf: 0.58,
    families: ['JEWELRY', 'SMALL', 'MEDIUM'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: false,
      bagStuffing: false,
      traspaso: true,
      distractor: true,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.78,
        minFramesWithContext: 5,
        minFramesWithoutContext: 10,
        maxHorizontalDist: 0.12,
        minVerticalBelow: 0.03,
        minDepth: 0.12
      },
      handObj: {
        minConfidence: 0.50,
        minContactMs: 180,
        maxGrabMs: 350,
        minDisappearanceFrames: 4
      },
      concealment: {
        minWristOcclusion: 0.38,
        minHandMovement: 0.05,
        underClothesThreshold: 0.55
      },
      scanning: {
        headMovementThreshold: 0.05,
        minTimeMs: 1000,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.08,
        minFrames: 6,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 25,
      objetoTomado: 55,
      escaneo: 20,
      pinchGrip: 32,
      traspaso: 52,
      distractor: 32,
      coordinacion: 28,
    },
    
    buffer: {
      enabled: true,
      maxSize: 20,
      minConfidence: 0.65
    }
  },

  ropa: {
    name: 'Tienda de Ropa',
    icon: '👕',
    dwellTime: 6,
    contactMinMs: 550,
    grabMaxMs: 750,
    scoreThreshold: 72,
    postContactMs: 6500,
    zoneEntryFrames: 4,
    hipConcealConf: 0.52,
    families: ['BAG', 'CLOTHING', 'SMALL'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: false,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.70,
        minFramesWithContext: 8,
        minFramesWithoutContext: 15,
        maxHorizontalDist: 0.16,
        minVerticalBelow: 0.02,
        minDepth: 0.17
      },
      handObj: {
        minConfidence: 0.65,
        minContactMs: 500,
        maxGrabMs: 700,
        minDisappearanceFrames: 8
      },
      concealment: {
        minWristOcclusion: 0.48,
        minHandMovement: 0.08,
        underClothesThreshold: 0.65
      },
      scanning: {
        headMovementThreshold: 0.08,
        minTimeMs: 2000,
        minHeadTurns: 3
      },
      crouch: {
        minDepth: 0.12,
        minFrames: 10,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      bagStuffing: 48,
      manga: 40,
      cadera: 38,
      pinchGrip: 12,
      coordinacion: 25,
      bajoropa: 42,
    },
    
    buffer: {
      enabled: true,
      maxSize: 40,
      minConfidence: 0.52
    }
  },

  kiosco: {
    name: 'Kiosco / Cafetería',
    icon: '☕',
    dwellTime: 2,
    contactMinMs: 300,
    grabMaxMs: 500,
    scoreThreshold: 62,
    postContactMs: 4000,
    zoneEntryFrames: 2,
    hipConcealConf: 0.54,
    families: ['SMALL', 'MEDIUM', 'BAG', 'FOOD'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: false,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: false,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.71,
        minFramesWithContext: 6,
        minFramesWithoutContext: 12,
        maxHorizontalDist: 0.15,
        minVerticalBelow: 0.02,
        minDepth: 0.15
      },
      handObj: {
        minConfidence: 0.60,
        minContactMs: 280,
        maxGrabMs: 480,
        minDisappearanceFrames: 6
      },
      concealment: {
        minWristOcclusion: 0.44,
        minHandMovement: 0.07,
        underClothesThreshold: 0.60
      },
      scanning: {
        headMovementThreshold: 0.07,
        minTimeMs: 1500,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.11,
        minFrames: 8,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 18,
      pinchGrip: 20,
      trayectoria: 10,
    },
    
    buffer: {
      enabled: true,
      maxSize: 28,
      minConfidence: 0.56
    }
  },

  deposito: {
    name: 'Depósito / Bodega',
    icon: '📦',
    dwellTime: 2,
    contactMinMs: 300,
    grabMaxMs: 600,
    scoreThreshold: 58,
    postContactMs: 5500,
    zoneEntryFrames: 2,
    hipConcealConf: 0.50,
    families: ['SMALL', 'MEDIUM', 'BAG', 'TECH', 'TOOL'],
    behaviors: {
      merodeo: false,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: false,
      trayectoria: false,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.70,
        minFramesWithContext: 6,
        minFramesWithoutContext: 12,
        maxHorizontalDist: 0.15,
        minVerticalBelow: 0.02,
        minDepth: 0.15
      },
      handObj: {
        minConfidence: 0.58,
        minContactMs: 280,
        maxGrabMs: 550,
        minDisappearanceFrames: 6
      },
      concealment: {
        minWristOcclusion: 0.42,
        minHandMovement: 0.07,
        underClothesThreshold: 0.58
      },
      scanning: {
        headMovementThreshold: 0.07,
        minTimeMs: 1500,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.11,
        minFrames: 8,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 20,
      pinchGrip: 22,
      bagStuffing: 45,
      traspaso: 48,
    },
    
    buffer: {
      enabled: true,
      maxSize: 30,
      minConfidence: 0.55
    }
  },

  cocina: {
    name: 'Cocina / Preparación',
    icon: '🍳',
    dwellTime: 8,
    contactMinMs: 800,
    grabMaxMs: 1000,
    scoreThreshold: 78,
    postContactMs: 4500,
    zoneEntryFrames: 5,
    hipConcealConf: 0.58,
    families: ['SMALL', 'MEDIUM', 'TECH', 'FOOD'],
    behaviors: {
      merodeo: false,
      escaneo: false,
      pantalla: false,
      cadera: true,
      manga: true,
      agachado: false,
      bagStuffing: true,
      traspaso: true,
      distractor: false,
      trayectoria: false,
      pinchGrip: false,
      coordinacion: false,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.80,
        minFramesWithContext: 10,
        minFramesWithoutContext: 18,
        maxHorizontalDist: 0.18,
        minVerticalBelow: 0.03,
        minDepth: 0.20
      },
      handObj: {
        minConfidence: 0.72,
        minContactMs: 700,
        maxGrabMs: 900,
        minDisappearanceFrames: 10
      },
      concealment: {
        minWristOcclusion: 0.50,
        minHandMovement: 0.10,
        underClothesThreshold: 0.70
      },
      scanning: {
        headMovementThreshold: 0.10,
        minTimeMs: 3000,
        minHeadTurns: 4
      },
      crouch: {
        minDepth: 0.15,
        minFrames: 12,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 4,
      cadera: 45,
      manga: 45,
      bagStuffing: 52,
      traspaso: 45,
    },
    
    buffer: {
      enabled: true,
      maxSize: 40,
      minConfidence: 0.65
    }
  },

  estacion: {
    name: 'Estación / Minimarket 24h',
    icon: '⛽',
    dwellTime: 2,
    contactMinMs: 300,
    grabMaxMs: 550,
    scoreThreshold: 60,
    postContactMs: 4500,
    zoneEntryFrames: 2,
    hipConcealConf: 0.52,
    families: ['SMALL', 'MEDIUM', 'BAG', 'FOOD', 'TECH'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: true,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.72,
        minFramesWithContext: 6,
        minFramesWithoutContext: 12,
        maxHorizontalDist: 0.14,
        minVerticalBelow: 0.02,
        minDepth: 0.14
      },
      handObj: {
        minConfidence: 0.58,
        minContactMs: 280,
        maxGrabMs: 500,
        minDisappearanceFrames: 6
      },
      concealment: {
        minWristOcclusion: 0.43,
        minHandMovement: 0.06,
        underClothesThreshold: 0.58
      },
      scanning: {
        headMovementThreshold: 0.06,
        minTimeMs: 1400,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.10,
        minFrames: 7,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      contacto: 15,
      trayectoria: 11,
      pinchGrip: 21,
      merodeo: 22,
    },
    
    buffer: {
      enabled: true,
      maxSize: 28,
      minConfidence: 0.56
    }
  },

  libreria: {
    name: 'Librería / Papelería',
    icon: '📚',
    dwellTime: 5,
    contactMinMs: 550,
    grabMaxMs: 750,
    scoreThreshold: 70,
    postContactMs: 5500,
    zoneEntryFrames: 3,
    hipConcealConf: 0.54,
    families: ['MEDIUM', 'SMALL', 'BAG'],
    behaviors: {
      merodeo: true,
      escaneo: true,
      pantalla: true,
      cadera: true,
      manga: true,
      agachado: true,
      bagStuffing: true,
      traspaso: true,
      distractor: true,
      trayectoria: false,
      pinchGrip: true,
      coordinacion: true,
    },
    
    thresholds: {
      pocket: {
        minConfidence: 0.74,
        minFramesWithContext: 8,
        minFramesWithoutContext: 14,
        maxHorizontalDist: 0.15,
        minVerticalBelow: 0.02,
        minDepth: 0.16
      },
      handObj: {
        minConfidence: 0.64,
        minContactMs: 500,
        maxGrabMs: 700,
        minDisappearanceFrames: 8
      },
      concealment: {
        minWristOcclusion: 0.46,
        minHandMovement: 0.07,
        underClothesThreshold: 0.62
      },
      scanning: {
        headMovementThreshold: 0.07,
        minTimeMs: 1800,
        minHeadTurns: 2
      },
      crouch: {
        minDepth: 0.11,
        minFrames: 9,
        requirePostContact: true
      }
    },
    
    scoreBonus: {
      bagStuffing: 45,
      pinchGrip: 10,
    },
    
    buffer: {
      enabled: true,
      maxSize: 35,
      minConfidence: 0.58
    }
  }
};

// ─────────────────────────────────────────────────────────────────────
//  ALIASES — variantes de nombres aceptadas
// ─────────────────────────────────────────────────────────────────────
const ALIASES = {
  minimercado: 'supermercado',
  'mini mercado': 'supermercado',
  almacen: 'supermercado',
  almacén: 'supermercado',
  minimarket: 'supermercado',
  autoservicio: 'supermercado',
  cafeteria: 'kiosco',
  cafetería: 'kiosco',
  cafe: 'kiosco',
  café: 'kiosco',
  kiosko: 'kiosco',
  tienda: 'generico',
  farmacia: 'farmacia',
  joyeria: 'joyeria',
  joyería: 'joyeria',
  ropa: 'ropa',
  electronica: 'electronica',
  electrónica: 'electronica',
  tecnologia: 'electronica',
  tecnología: 'electronica',
  deposito: 'deposito',
  depósito: 'deposito',
  bodega: 'deposito',
  almacenamiento: 'deposito',
  estacion: 'estacion',
  estación: 'estacion',
  nafta: 'estacion',
  '24h': 'estacion',
  libreria: 'libreria',
  librería: 'libreria',
  papeleria: 'libreria',
  papelería: 'libreria',
  cocina: 'cocina',
};

/**
 * Retorna el perfil para un tipo de local.
 * Merge con genérico como fallback para campos faltantes.
 */
export function getProfile(type = 'generico') {
  const normalized = (type || '').toLowerCase().trim();
  const key = ALIASES[normalized] || normalized;
  const base = PROFILES[key] || PROFILES.generico;
  const generic = PROFILES.generico;

  // Merge profundo con defaults
  return {
    ...generic,
    ...base,
    behaviors: { ...generic.behaviors, ...(base.behaviors || {}) },
    thresholds: {
      ...generic.thresholds,
      ...(base.thresholds || {}),
      pocket: { ...generic.thresholds?.pocket, ...(base.thresholds?.pocket || {}) },
      handObj: { ...generic.thresholds?.handObj, ...(base.thresholds?.handObj || {}) },
      concealment: { ...generic.thresholds?.concealment, ...(base.thresholds?.concealment || {}) },
      scanning: { ...generic.thresholds?.scanning, ...(base.thresholds?.scanning || {}) },
      crouch: { ...generic.thresholds?.crouch, ...(base.thresholds?.crouch || {}) }
    },
    scoreBonus: { ...SCORE_BONUS_DEFAULTS, ...(base.scoreBonus || {}) },
    buffer: { ...generic.buffer, ...(base.buffer || {}) }
  };
}

export function listProfiles() {
  return Object.entries(PROFILES).map(([key, p]) => ({
    key,
    name: p.name,
    icon: p.icon,
  }));
}

console.log('%c✅ store-profiles.js v8.4 — Perfiles ajustados', 'color:#00e676;font-weight:bold');