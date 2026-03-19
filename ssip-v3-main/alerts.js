/**
 * alerts.js — SSIP v8.3 (CON WEBSOCKET)
 * 
 * Cambios v8.3:
 * [SYNC-1] Integración con store-profiles
 * [SYNC-2] Cooldowns inteligentes
 * [SYNC-3] Cola de alertas
 * [SYNC-4] Estadísticas por tipo
 * [SYNC-5] Soporte WebSocket para backend
 */

const SEVERITY_CONFIG = {
  low: {
    label:    'AVISO',
    color:    '#00c8ff',
    cssClass: 'severity-low',
    duration: 2000,
    icon:     'ℹ️',
    sound:    null,
  },
  medium: {
    label:    'ALERTA',
    color:    '#ffaa00',
    cssClass: 'severity-med',
    duration: 3000,
    icon:     '⚠️',
    sound:    'alert-medium.mp3',
  },
  high: {
    label:    '⚠ PELIGRO',
    color:    '#ff3a3a',
    cssClass: 'severity-high',
    duration: 4000,
    icon:     '🚨',
    sound:    'alert-high.mp3',
  },
};

// Cooldowns por tipo de alerta (ms)
const TYPE_COOLDOWNS = {
  'pkt_L': 18000, 'pkt_R': 18000, 'pocket': 18000,
  'ze_': 1500, 'dw_': 8000, 'esc_': 10000,
  'oz_': 3000, 'hof_': 10000, 'grab_': 10000, 'og_': 10000,
  'contacto': 3000, 'objetoTomado': 10000, 'arrebato': 10000, 'traspaso': 10000,
  'slv_': 10000, 'bag_': 10000, 'trso_': 10000, 'hip_': 10000,
  'manga': 10000, 'bajoropa': 10000, 'cadera': 10000, 'bagStuffing': 10000,
  'cross_': 8000, 'scan_': 8000, 'bsc_': 8000, 'crch_': 10000,
  'traj_': 4000, 'prl_': 12000,
  'brazoscruzados': 8000, 'escaneo': 8000, 'pantalla': 8000,
  'agachado': 10000, 'trayectoria': 4000, 'merodeo': 12000,
  'dist_': 10000, 'wall_': 10000, 'grp_scan_': 15000, 'vform_': 20000,
  'distractor': 10000, 'coordinacion': 15000, 'formacionV': 20000,
  'score_': 10000, 'seq_': 15000, 'secuencia': 15000,
  'emp_dw_': 30000, 'exit_': 5000,
  'mpgrip_': 10000, 'pinchGrip': 10000,
  'sil_': 10000,
  'cj_pkt_': 10000, 'cj_slv_': 10000,
};

export class AlertManager {
  /**
   * @param {HTMLCanvasElement} snapshotCanvas - Canvas para snapshots
   * @param {Object} config - Configuración
   * @param {string|null} videoId - ID del video
   * @param {Object} profile - Perfil de tienda
   * @param {WebSocket} websocket - Conexión WebSocket (opcional)
   */
  constructor(snapshotCanvas, config = {}, videoId = null, profile = null, websocket = null) {
    this.snapshotCanvas = snapshotCanvas;
    this._videoId       = videoId;
    this.profile        = profile;
    this.websocket      = websocket;  // ✅ NUEVO: Guardar WebSocket
    
    // Configuración
    this.config = {
      maxAlerts: config.maxAlerts || 200,
      enableSounds: config.enableSounds || false,
      enableSnapshots: config.enableSnapshots !== false,
      enableStats: config.enableStats !== false,
      cameraId: config.cameraId || 1,  // ✅ NUEVO: ID de cámara para backend
      ...config
    };

    this.events = [];
    this.stats = {
      byType: new Map(),
      bySeverity: { low: 0, medium: 0, high: 0 },
      byHour: new Array(24).fill(0),
      lastReset: new Date().toISOString()
    };
    
    this.alertQueue = [];
    this.processingQueue = false;
    this.cooldowns = new Map();
    
    // Elementos DOM
    this._alertOverlay  = document.getElementById('alertOverlay')  || null;
    this._alertText     = document.getElementById('alertText')      || null;
    this._eventsList    = document.getElementById('eventsList')     || null;
    this._statusBadge   = document.getElementById('systemStatus')   || null;
    this._metricTotal   = document.getElementById('metricTotal')    || null;
    this._metricToday   = document.getElementById('metricToday')    || null;
    this._metricActive  = document.getElementById('metricActive')   || null;
    this._metricHigh    = document.getElementById('metricHigh')     || null;

    this._modalBackdrop = document.getElementById('modalBackdrop')  || null;
    this._modalTitle    = document.getElementById('modalTitle')      || null;
    this._modalSnapshot = document.getElementById('modalSnapshot')  || null;
    this._modalMeta     = document.getElementById('modalMeta')      || null;
    this._modalStats    = document.getElementById('modalStats')     || null;

    // Botón de cierre
    const modalCloseBtn = document.getElementById('modalClose');
    if (modalCloseBtn && this._modalBackdrop) {
      modalCloseBtn.addEventListener('click', () => {
        this._modalBackdrop.classList.add('hidden');
      });
    }

    // Botón de exportar stats
    const exportStatsBtn = document.getElementById('exportStatsBtn');
    if (exportStatsBtn) {
      exportStatsBtn.addEventListener('click', () => this.exportStats());
    }

    this._alertTimer   = null;
    this._activeAlerts = 0;
    this._today        = new Date().toDateString();
    
    // ✅ NUEVO: Configurar WebSocket
    this._setupWebSocket();
    
    console.log('%c🔔 AlertManager v8.3 con WebSocket', 'color:#ffaa00');
    if (this.profile) {
      console.log(`%c🔔 Perfil: ${this.profile.icon} ${this.profile.name}`, 'color:#ffaa00');
    }
  }

  /* ══════════════════════════════════════════════════════
     Configurar WebSocket
  ══════════════════════════════════════════════════════ */
  _setupWebSocket() {
    if (!this.websocket) return;
    
    this.websocket.onopen = () => {
      console.log('%c🔌 WebSocket conectado', 'color:#00ff94');
    };
    
    this.websocket.onclose = () => {
      console.log('%c🔌 WebSocket desconectado', 'color:#ffaa00');
    };
    
    this.websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    // ✅ NUEVO: Recibir alertas del backend
    this.websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'alert' || data.type === 'lstm_alert') {
          // Convertir alerta del backend a formato local
          this._handleBackendAlert(data);
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };
  }

  /* ══════════════════════════════════════════════════════
     Manejar alerta del backend
  ══════════════════════════════════════════════════════ */
  _handleBackendAlert(data) {
    const event = {
      id: `backend-${Date.now()}`,
      type: data.alert_type || 'LSTM_ALERT',
      baseType: 'lstm_alert',
      severity: data.severity || 'high',
      label: '🚨 ALERTA LSTM',
      icon: '🧠',
      timestamp: new Date().toISOString(),
      timeStr: new Date().toLocaleTimeString('es-UY', { hour12: false }),
      dateStr: new Date().toLocaleDateString('es-UY'),
      snapshot: null,
      metadata: {
        ...data,
        confidence: data.confidence || 0.9,
        fromBackend: true
      },
      acknowledged: false
    };
    
    // Procesar como alerta local
    this.alertQueue.push(event);
    this._processQueue();
  }

  /* ══════════════════════════════════════════════════════
     Enviar alerta al backend
  ══════════════════════════════════════════════════════ */
  _sendToBackend(event) {
    // Deshabilitado — eventos guardados solo en Firebase
  }

  /* ══════════════════════════════════════════════════════
     Actualizar perfil
  ══════════════════════════════════════════════════════ */setProfile(profile) {
  // Solo loguear si realmente cambió
  if (this.profile?.key !== profile?.key) {
    this.profile = profile;
    console.log(`%c🔔 Perfil actualizado: ${profile?.icon || '🏪'} ${profile?.name || 'Genérico'}`, 'color:#ffaa00');
  } else {
    this.profile = profile; 
  }
}

  /* ══════════════════════════════════════════════════════
     Disparar alerta
  ══════════════════════════════════════════════════════ */
  async trigger(eventType, severity = 'medium', metadata = {}) {
    // Obtener cooldown
    const cooldown = this._getCooldown(eventType, severity);
    if (!this._checkCooldown(eventType, cooldown)) return null;

    // Crear evento — async porque el snapshot puede ser una Promise (MJPEG)
    const event = await this._createEvent(eventType, severity, metadata);

    // 1. Guardar en Firebase Firestore con snapshot (auto-borrado 48hs)
    if (this._guardarEvento && this._empresaId) {
      this._guardarEvento(this._empresaId, {
        tipo:      event.type,
        severidad: event.severity,
        snapshot:  event.snapshot || '',
        camaraIdx: (this.config.cameraId || 1) - 1,
      }).catch(() => {});
    }

    // 2. SQLite local eliminado — Firebase es la única fuente de verdad

    // Añadir a cola local y procesar
    this.alertQueue.push(event);
    this._processQueue();

    return event;
  }

  /* ══════════════════════════════════════════════════════
     Procesar cola de alertas
  ══════════════════════════════════════════════════════ */
  async _processQueue() {
    if (this.processingQueue || this.alertQueue.length === 0) return;
    
    this.processingQueue = true;
    
    while (this.alertQueue.length > 0) {
      const event = this.alertQueue.shift();
      
      // Guardar evento
      this.events.unshift(event);
      if (this.events.length > this.config.maxAlerts) {
        this.events = this.events.slice(0, this.config.maxAlerts);
      }
      
      // Actualizar estadísticas
      this._updateStats(event);
      
      // Mostrar alerta visual
      this._showVisualAlert(event);
      
      // Renderizar en lista
      this._renderEvent(event);
      
      // Actualizar métricas
      this._updateMetrics();
      
      // Cambiar estado
      this._setSystemStatus('alert');
      
      // Sonido
      if (this.config.enableSounds) {
        this._playSound(event.severity);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.processingQueue = false;
  }

  /* ══════════════════════════════════════════════════════
     Crear evento con metadata
  ══════════════════════════════════════════════════════ */
  async _createEvent(eventType, severity, metadata = {}) {
    const cfg = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.medium;
    const now = new Date();
    const ts = now.toLocaleTimeString('es-UY', { hour12: false });
    const date = now.toLocaleDateString('es-UY');
    const baseType = this._getBaseType(eventType);

    // Snapshot: síncrono (video) o Promise (MJPEG)
    let snapshot = null;
    if (this.config.enableSnapshots) {
      const result = this._captureSnapshot(metadata);
      snapshot = (result instanceof Promise) ? await result.catch(() => null) : result;
    }

    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      type: eventType,
      baseType,
      severity,
      label: cfg.label,
      icon: cfg.icon,
      timestamp: now.toISOString(),
      timeStr: ts,
      dateStr: date,
      snapshot,
      metadata: {
        ...metadata,
        profile: this.profile?.name,
        storeType: this.profile?.key,
        cameraId: this.config.cameraId,
      },
      acknowledged: false,
    };
  }

  /* ══════════════════════════════════════════════════════
     Obtener cooldown
  ══════════════════════════════════════════════════════ */
  _getCooldown(eventType, severity) {
    for (const [key, cd] of Object.entries(TYPE_COOLDOWNS)) {
      if (eventType.startsWith(key) || key === eventType) {
        return cd;
      }
    }
    return SEVERITY_CONFIG[severity]?.duration || 3000;
  }

  /* ══════════════════════════════════════════════════════
     Verificar cooldown
  ══════════════════════════════════════════════════════ */
  _checkCooldown(eventType, cooldownMs) {
    const now = Date.now();
    const lastTrigger = this.cooldowns.get(eventType) || 0;
    
    if (now - lastTrigger < cooldownMs) {
      return false;
    }
    
    this.cooldowns.set(eventType, now);
    return true;
  }

  /* ══════════════════════════════════════════════════════
     Obtener tipo base
  ══════════════════════════════════════════════════════ */
  _getBaseType(eventType) {
    if (eventType.includes('pkt') || eventType.includes('pocket')) return 'pocket';
    if (eventType.includes('dw_')) return 'dwell';
    if (eventType.includes('ze_')) return 'zone_entry';
    if (eventType.includes('grab')) return 'grab';
    if (eventType.includes('hof')) return 'handoff';
    if (eventType.includes('scan')) return 'scan';
    if (eventType.includes('cross')) return 'crossed_arms';
    if (eventType.includes('hip')) return 'hip_concealment';
    if (eventType.includes('manga') || eventType.includes('slv')) return 'sleeve';
    if (eventType.includes('bag')) return 'bag_stuffing';
    if (eventType.includes('score')) return 'high_score';
    if (eventType.includes('seq')) return 'sequence';
    if (eventType.includes('lstm')) return 'lstm_alert';
    
    return 'other';
  }

  /* ══════════════════════════════════════════════════════
     Actualizar estadísticas
  ══════════════════════════════════════════════════════ */
  _updateStats(event) {
    if (!this.config.enableStats) return;
    
    const typeCount = this.stats.byType.get(event.baseType) || 0;
    this.stats.byType.set(event.baseType, typeCount + 1);
    
    this.stats.bySeverity[event.severity] = (this.stats.bySeverity[event.severity] || 0) + 1;
    
    const hour = new Date(event.timestamp).getHours();
    this.stats.byHour[hour] = (this.stats.byHour[hour] || 0) + 1;
  }

  /* ══════════════════════════════════════════════════════
     Obtener estadísticas
  ══════════════════════════════════════════════════════ */
  getStats() {
    return {
      total: this.events.length,
      byType: Object.fromEntries(this.stats.byType),
      bySeverity: { ...this.stats.bySeverity },
      byHour: [...this.stats.byHour],
      topTypes: [...this.stats.byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      lastReset: this.stats.lastReset,
    };
  }

  /* ══════════════════════════════════════════════════════
     Exportar estadísticas
  ══════════════════════════════════════════════════════ */
  exportStats() {
    const stats = this.getStats();
    
    const report = {
      generated: new Date().toISOString(),
      profile: this.profile?.name || 'Genérico',
      storeType: this.profile?.key || 'generico',
      cameraId: this.config.cameraId,
      totalAlerts: stats.total,
      bySeverity: stats.bySeverity,
      topBehaviors: stats.topTypes,
      hourlyDistribution: stats.byHour,
      recentEvents: this.events.slice(0, 10).map(e => ({
        time: e.timeStr,
        type: e.type,
        severity: e.severity,
      })),
    };
    
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ssip_stats_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    return report;
  }

  /* ══════════════════════════════════════════════════════
     Mostrar alerta visual
  ══════════════════════════════════════════════════════ */
  _showVisualAlert(event) {
    if (!this._alertOverlay || !this._alertText) return;
    
    const cfg = SEVERITY_CONFIG[event.severity];
    
    this._alertText.innerHTML = `
      <span style="margin-right:8px;">${cfg.icon}</span>
      ${cfg.label}: ${this._formatEventType(event.type)}
    `;
    
    const colors = {
      low: 'rgba(0,100,160,0.9)',
      medium: 'rgba(200,130,0,0.9)',
      high: 'rgba(255,58,58,0.9)'
    };
    this._alertText.style.background = colors[event.severity];
    
    this._alertOverlay.classList.remove('hidden');
    this._activeAlerts++;
    
    if (this._alertTimer) clearTimeout(this._alertTimer);
    this._alertTimer = setTimeout(() => {
      this._alertOverlay?.classList.add('hidden');
      this._activeAlerts = Math.max(0, this._activeAlerts - 1);
      this._updateMetrics();
      if (this._activeAlerts === 0) this._setSystemStatus('online');
    }, cfg.duration);
  }

  /* ══════════════════════════════════════════════════════
     Formatear tipo de evento
  ══════════════════════════════════════════════════════ */
  _formatEventType(type) {
    return type
      .replace(/_\d+$/, '')
      .replace(/[LR]_/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  /* ══════════════════════════════════════════════════════
     Renderizar item
  ══════════════════════════════════════════════════════ */
  _renderEvent(event) {
    if (!this._eventsList) return;
    
    const cfg = SEVERITY_CONFIG[event.severity];
    
    const emptyEl = this._eventsList.querySelector('.events-empty');
    if (emptyEl) emptyEl.remove();
    
    const item = document.createElement('div');
    item.className = `event-item ${cfg.cssClass}`;
    item.dataset.eventId = event.id;
    item.dataset.severity = event.severity;
    
    const typeIcon = this._getTypeIcon(event.baseType);
    const backendBadge = event.metadata?.fromBackend ? '🧠 ' : '';
    
    item.innerHTML = `
      <img class="event-thumb" src="${event.snapshot || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'40\' height=\'30\'%3E%3Crect width=\'40\' height=\'30\' fill=\'%23333\'/%3E%3Ctext x=\'5\' y=\'20\' fill=\'%23fff\' font-size=\'12\'%3EN/A%3C/text%3E%3C/svg%3E'}" alt="snap"/>
      <div class="event-info">
        <div class="event-type">
          <span class="event-icon">${typeIcon}</span>
          ${backendBadge}${this._escapeHtml(this._formatEventType(event.type))}
        </div>
        <div class="event-time">${event.dateStr} ${event.timeStr}</div>
        ${event.metadata?.trackId ? `<div class="event-track">Track #${event.metadata.trackId}</div>` : ''}
        ${event.metadata?.confidence ? `<div class="event-conf">Conf: ${Math.round(event.metadata.confidence * 100)}%</div>` : ''}
      </div>
      <div class="event-badge ${event.severity}">${cfg.label}</div>
    `;
    
    item.addEventListener('click', () => this._openModal(event));
    
    this._eventsList.insertBefore(item, this._eventsList.firstChild);
    
    const items = this._eventsList.querySelectorAll('.event-item');
    if (items.length > 50) {
      items[items.length - 1].remove();
    }
  }

  /* ══════════════════════════════════════════════════════
     Obtener ícono por tipo
  ══════════════════════════════════════════════════════ */
  _getTypeIcon(baseType) {
    const icons = {
      pocket: '👖',
      dwell: '⏱️',
      zone_entry: '🚪',
      grab: '🤏',
      handoff: '🤝',
      scan: '👀',
      crossed_arms: '🙅',
      hip_concealment: '🦵',
      sleeve: '👕',
      bag_stuffing: '👜',
      high_score: '🎯',
      sequence: '📊',
      lstm_alert: '🧠',
    };
    return icons[baseType] || '⚠️';
  }

  /* ══════════════════════════════════════════════════════
     Modal de detalle
  ══════════════════════════════════════════════════════ */
  _openModal(event) {
    if (!this._modalBackdrop) return;
    
    if (this._modalTitle) {
      this._modalTitle.innerHTML = `${event.icon || '⚠️'} ${this._formatEventType(event.type)}`;
    }
    
    if (this._modalSnapshot) {
      this._modalSnapshot.src = event.snapshot || '';
    }
    
    if (this._modalMeta) {
      const metadata = event.metadata || {};
      const profileInfo = metadata.profile ? `${metadata.profile} (${metadata.storeType})` : 'No especificado';
      const sourceInfo = metadata.fromBackend ? '🧠 Backend LSTM' : '📹 Frontend';
      
      this._modalMeta.innerHTML = `
        <div class="meta-grid">
          <div><strong>ID:</strong> ${event.id}</div>
          <div><strong>Fecha:</strong> ${event.dateStr} ${event.timeStr}</div>
          <div><strong>Severidad:</strong> <span class="severity-${event.severity}">${event.severity.toUpperCase()}</span></div>
          <div><strong>Tipo base:</strong> ${event.baseType}</div>
          <div><strong>Origen:</strong> ${sourceInfo}</div>
          <div><strong>Tienda:</strong> ${profileInfo}</div>
          ${metadata.trackId ? `<div><strong>Track ID:</strong> ${metadata.trackId}</div>` : ''}
          ${metadata.score ? `<div><strong>Score:</strong> ${metadata.score}</div>` : ''}
          ${metadata.zone ? `<div><strong>Zona:</strong> ${metadata.zone}</div>` : ''}
          ${metadata.obj ? `<div><strong>Objeto:</strong> ${metadata.obj}</div>` : ''}
          ${metadata.side ? `<div><strong>Mano:</strong> ${metadata.side === 'L' ? 'Izquierda' : 'Derecha'}</div>` : ''}
        </div>
      `;
    }
    
    if (this._modalStats && event.metadata) {
      const stats = [];
      if (event.metadata.confidence) {
        stats.push(`Confianza: ${Math.round(event.metadata.confidence * 100)}%`);
      }
      if (event.metadata.duration) {
        stats.push(`Duración: ${event.metadata.duration}ms`);
      }
      if (event.metadata.intentScore) {
        stats.push(`Intención: ${Math.round(event.metadata.intentScore * 100)}%`);
      }
      if (event.metadata.lstm_score) {
        stats.push(`LSTM: ${(event.metadata.lstm_score * 100).toFixed(1)}%`);
      }
      
      if (stats.length > 0) {
        this._modalStats.innerHTML = `<strong>Estadísticas:</strong> ${stats.join(' · ')}`;
        this._modalStats.classList.remove('hidden');
      } else {
        this._modalStats.classList.add('hidden');
      }
    }
    
    this._modalBackdrop.classList.remove('hidden');
  }

  /* ══════════════════════════════════════════════════════
     Capturar snapshot
  ══════════════════════════════════════════════════════ */
  _captureSnapshot(metadata = {}) {
    if (!this.config.enableSnapshots) return null;

    const ow = this.snapshotCanvas.width  || 640;
    const oh = this.snapshotCanvas.height || 480;

    const _finish = (ctx, tmp) => {
      try { ctx.drawImage(this.snapshotCanvas, 0, 0, ow, oh); } catch(e) {}
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, oh - 20, ow, 20);
      ctx.fillStyle = '#00d4ff';
      ctx.font = '11px monospace';
      ctx.fillText(new Date().toLocaleTimeString('es-UY', { hour12: false }), 6, oh - 6);
      return tmp.toDataURL('image/jpeg', 0.85);
    };

    const _makeCanvas = () => {
      const tmp = document.createElement('canvas');
      tmp.width = ow; tmp.height = oh;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#0d1520';
      ctx.fillRect(0, 0, ow, oh);
      return { tmp, ctx };
    };

    try {
      const isMjpeg = window.camSrc?.type === 'mjpeg';

      if (!isMjpeg) {
        // Webcam / WebRTC / HLS / archivo → <video> directo
        const { tmp, ctx } = _makeCanvas();
        const video = document.getElementById(this._videoId || 'videoElement');
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          ctx.drawImage(video, 0, 0, ow, oh);
        }
        return _finish(ctx, tmp);
      } else {
        // MJPEG → thumbnail del backend (Promise)
        const dataUrl = this._detectionEngine?._lastThumb;
        if (!dataUrl) {
          const { tmp, ctx } = _makeCanvas();
          return _finish(ctx, tmp);
        }
        return new Promise((resolve) => {
          const { tmp, ctx } = _makeCanvas();
          const img = new Image();
          img.onload  = () => { ctx.drawImage(img, 0, 0, ow, oh); resolve(_finish(ctx, tmp)); };
          img.onerror = () => resolve(_finish(ctx, tmp));
          img.src = dataUrl;
        });
      }
    } catch(e) {
      console.warn('Snapshot error:', e);
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════
     Reproducir sonido
  ══════════════════════════════════════════════════════ */
  _playSound(severity) {
    if (!this.config.enableSounds) return;
    
    const soundFile = SEVERITY_CONFIG[severity]?.sound;
    if (!soundFile) return;
    
    try {
      const audio = new Audio(`/sounds/${soundFile}`);
      audio.volume = 0.5;
      audio.play().catch(e => console.debug('Error reproduciendo sonido:', e));
    } catch(e) {}
  }

  /* ══════════════════════════════════════════════════════
     Métricas
  ══════════════════════════════════════════════════════ */
  _updateMetrics() {
    if (this._metricTotal) {
      this._metricTotal.textContent = this.events.length;
    }
    
    if (this._metricToday) {
      const todayStr = new Date().toDateString();
      const todayCount = this.events.filter(e => 
        new Date(e.timestamp).toDateString() === todayStr
      ).length;
      this._metricToday.textContent = todayCount;
    }
    
    if (this._metricActive) {
      this._metricActive.textContent = this._activeAlerts;
    }
    
    if (this._metricHigh) {
      const highCount = this.events.filter(e => e.severity === 'high').length;
      this._metricHigh.textContent = highCount;
    }
  }

  /* ══════════════════════════════════════════════════════
     Estado del sistema
  ══════════════════════════════════════════════════════ */
  _setSystemStatus(state) {
    if (!this._statusBadge) return;
    
    this._statusBadge.className = `status-badge ${state}`;
    
    const label = this._statusBadge.querySelector('.status-label');
    if (label) {
      const labels = {
        offline: 'OFFLINE',
        online: 'EN LÍNEA',
        alert: 'ALERTA',
        starting: 'INICIANDO',
        processing: 'PROCESANDO'
      };
      label.textContent = labels[state] || state.toUpperCase();
    }
  }

  setOnline()  { this._setSystemStatus('online'); }
  setOffline() { this._setSystemStatus('offline'); }
  setProcessing() { this._setSystemStatus('processing'); }

  /* ══════════════════════════════════════════════════════
     Exportar CSV
  ══════════════════════════════════════════════════════ */
  exportCSV() {
    if (!this.events.length) {
      alert('No hay eventos para exportar.');
      return;
    }
    
    const headers = ['ID', 'Fecha', 'Hora', 'Tipo', 'Tipo Base', 'Severidad', 'Origen', 'Track ID', 'Zona', 'Objeto', 'Confianza', 'Metadata'];
    const rows = this.events.map(e => [
      e.id,
      e.dateStr,
      e.timeStr,
      `"${e.type.replace(/"/g, '""')}"`,
      e.baseType,
      e.severity,
      e.metadata?.fromBackend ? 'Backend' : 'Frontend',
      e.metadata?.trackId || '',
      e.metadata?.zone || '',
      e.metadata?.obj || '',
      e.metadata?.confidence ? Math.round(e.metadata.confidence * 100) + '%' : '',
      `"${JSON.stringify(e.metadata).replace(/"/g, '""')}"`
    ]);
    
    const csv = [
      '# SSIP — Sistema de Supervisión Inteligente Preventiva',
      `# Exportado: ${new Date().toLocaleString('es-UY')}`,
      `# Perfil: ${this.profile?.name || 'Genérico'}`,
      `# Cámara: ${this.config.cameraId}`,
      `# Total eventos: ${this.events.length}`,
      '',
      headers.join(','),
      ...rows.map(r => r.join(','))
    ].join('\n');
    
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `ssip_eventos_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ══════════════════════════════════════════════════════
     Limpiar historial
  ══════════════════════════════════════════════════════ */
  clearHistory() {
    this.events = [];
    this.stats = {
      byType: new Map(),
      bySeverity: { low: 0, medium: 0, high: 0 },
      byHour: new Array(24).fill(0),
      lastReset: new Date().toISOString()
    };
    
    if (this._eventsList) {
      this._eventsList.innerHTML = '<div class="events-empty">Sin eventos registrados</div>';
    }
    
    this._updateMetrics();
    console.log('%c🗑️ Historial de alertas limpiado', 'color:#888');
  }

  /* ══════════════════════════════════════════════════════
     Obtener alertas por severidad
  ══════════════════════════════════════════════════════ */
  getAlertsBySeverity(severity) {
    return this.events.filter(e => e.severity === severity);
  }

  /* ══════════════════════════════════════════════════════
     Obtener alertas por tipo
  ══════════════════════════════════════════════════════ */
  getAlertsByType(baseType) {
    return this.events.filter(e => e.baseType === baseType);
  }

  /* ══════════════════════════════════════════════════════
     Marcar alerta como acknowledge
  ══════════════════════════════════════════════════════ */
  acknowledgeAlert(eventId) {
    const event = this.events.find(e => e.id === eventId);
    if (event) {
      event.acknowledged = true;
      
      const item = this._eventsList?.querySelector(`[data-event-id="${eventId}"]`);
      if (item) {
        item.classList.add('acknowledged');
      }
    }
  }

  /* ══════════════════════════════════════════════════════
     Escape HTML
  ══════════════════════════════════════════════════════ */
  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}