/**
 * app.js — SSIP v4.3 — monitor.html
 * Maneja: selector de cámara, zonas, detección IA, navegación entre páginas.
 * AHORA CON:
 * - WebSocket integrado
 * - perfiles sincronizados
 * - alertas visuales completas
 * - banner superior temporal de alertas importantes (sin tocar HTML)
 */

import { CameraSource, DeviceSelector, savePref } from './camera-manager.js';
import { listProfiles, getProfile } from './store-profiles.js';
import { onAuth, guardarEvento } from './firebase-config.js';

export async function initApp({ ZoneManager, DetectionEngine, AlertManager }) {
  // DOM refs
  const video          = document.getElementById('videoElement');
  const canvas         = document.getElementById('overlayCanvas');
  const noSignal       = document.getElementById('noSignal');
  const canvasWrapper  = document.getElementById('canvasWrapper');
  const btnDrawZone    = document.getElementById('btnDrawZone');
  const btnClearZone   = document.getElementById('btnClearZone');
  const btnDetection   = document.getElementById('btnDetection');
  const btnStop        = document.getElementById('btnStop');
  const btnPause       = document.getElementById('btnPause');
  const btnCamToggle   = document.getElementById('btnCamToggle');
  const fpsDisplay     = document.getElementById('fpsDisplay');
  const zoneHint       = document.getElementById('zoneHint');
  const stateVideo     = document.getElementById('stateVideo');
  const stateDetect    = document.getElementById('stateDetection');
  const stateZone      = document.getElementById('stateZone');
  const stateModel     = document.getElementById('stateModel');
  const stateWebsocket = document.getElementById('stateWebsocket') || document.createElement('div');
  const sliderMovement = document.getElementById('sliderMovement');
  const sliderDwell    = document.getElementById('sliderDwell');
  const sliderCooldown = document.getElementById('sliderCooldown');
  const valMovement    = document.getElementById('valMovement');
  const valDwell       = document.getElementById('valDwell');
  const valCooldown    = document.getElementById('valCooldown');

  // Estado
  let videoReady      = false;
  let detectionActive = false;
  let drawingZone     = false;
  let animFrameId     = null;
  let camPaused       = false;
  let srcType         = 'webcam';
  let _ssTimer        = null;
  let websocket       = null;
  let currentCameraId = 1;
  let _topAlertTimer  = null;
  let _ipStreamUrl    = null;   // URL activa de cámara IP
  let _ipStreamProto  = 'mjpeg'; // protocolo activo

  // Motores
  const zoneManager = new ZoneManager(canvas);
  const initialProfile = getProfile('generico');

  // ── Banner superior dinámico ─────────────────────────────────────────────
  const topAlertBanner = _ensureTopAlertBanner();
  const topAlertBannerText = topAlertBanner.querySelector('#topAlertBannerText');

  // ── WebSocket ────────────────────────────────────────────────────────────
try {
  const WS_BASE = (
    window.VEESION_BACKEND_URL ||
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'ws://localhost:8000'
      : 'wss://veesion-backend.fly.dev')
  ).replace(/^http/, 'ws');

  websocket = new WebSocket(`${WS_BASE}/ws/camera/${currentCameraId}`);

  websocket.onopen = () => {
    console.log('%c🔌 WebSocket conectado', 'color:#00ff94');
    if (stateWebsocket) {
      stateWebsocket.textContent = 'Conectado';
      stateWebsocket.className = 'state-val ok';
    }
  };

    websocket.onclose = () => {
      console.log('%c🔌 WebSocket desconectado', 'color:#ffaa00');
      if (stateWebsocket) {
        stateWebsocket.textContent = 'Desconectado';
        stateWebsocket.className = 'state-val err';
      }
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (stateWebsocket) {
        stateWebsocket.textContent = 'Error';
        stateWebsocket.className = 'state-val err';
      }
    };
  } catch (e) {
    console.warn('No se pudo conectar WebSocket:', e);
  }

  // ── AlertManager ─────────────────────────────────────────────────────────
  const alertManager = new AlertManager(
    canvas,
    {
      enableSounds: true,
      maxAlerts: 200,
      enableSnapshots: true,
      enableStats: true,
      cameraId: currentCameraId
    },
    'videoElement',
    initialProfile,
    websocket
  );

  // Conectar Firebase: guardar snapshots en Firestore con auto-borrado 48hs
  onAuth(user => {
    if (user) {
      alertManager._guardarEvento = guardarEvento;
      alertManager._empresaId     = user.uid;
    }
  });

  // ── DetectionEngine ──────────────────────────────────────────────────────
  const detection = new DetectionEngine(canvas, zoneManager, alertManager, {
    movementThreshold: 50,
    dwellTime: 3,
    cooldown: 6,
    storeType: 'generico',
  });

  // ── Toggle GitHub ────────────────────────────────────────────────────────
  const btnGithub = document.getElementById('btnGithubToggle');
  if (btnGithub) {
    btnGithub.dataset.active = 'false';
    btnGithub.style.background = 'transparent';
    btnGithub.style.borderColor = 'var(--border)';
    btnGithub.style.color = 'var(--sub)';
    const span = btnGithub.querySelector('span');
    if (span) span.textContent = 'OFF';

    btnGithub.addEventListener('click', () => {
      const isActive = btnGithub.dataset.active === 'true';
      const newState = !isActive;

      btnGithub.dataset.active = String(newState);
      btnGithub.style.background = newState ? 'rgba(0,230,118,0.15)' : 'transparent';
      btnGithub.style.borderColor = newState ? '#00e676' : 'var(--border)';
      btnGithub.style.color = newState ? '#00e676' : 'var(--sub)';
      if (span) span.textContent = newState ? 'ON' : 'OFF';

      detection.setGithubEnabled(newState);
      _toast(`Detector GitHub ${newState ? 'activado' : 'desactivado'}`, newState ? 'ok' : 'info', 1800);
    });
  }

  // ── Callback de detección → banner + status ──────────────────────────────
  detection.onDetection = (msg, sev) => {
    if (sev !== 'info') _flashStatus(sev);

    if (_shouldShowTopAlert(msg, sev)) {
      _showTopAlert(msg, sev);
    }

    console.log(`%c🔔 ${msg}`, sev === 'high' ? 'color:#ff3d3d' : 'color:#ffaa00');
  };

  // ── CameraSource ─────────────────────────────────────────────────────────
  const camSrc = new CameraSource(video, canvas, canvasWrapper, {
    onReady(label) {
      noSignal?.classList.add('hidden');
      videoReady = true;
      camPaused = false;

      if (camSrc.type === 'webrtc' || camSrc.type === 'mjpeg' || camSrc.type === 'hls') {
        srcType = 'webrtc';
      }

      if (stateVideo) {
        stateVideo.textContent = label;
        stateVideo.className   = 'state-val ok';
      }

      alertManager.setOnline?.();
      _syncPauseBtn(false);
      _syncCamBtn(true);
      _updateControls();
      _setSysStatus('Señal de video activa', 'ok', 2500);
    },

    onError(msg) {
      if (videoReady) {
        _toast(msg, 'warn', 6000);
        _setSysStatus('Aviso de video', 'warn', 4000);
        return;
      }

      noSignal?.classList.remove('hidden');
      const p   = noSignal?.querySelector('p');
      const sub = noSignal?.querySelector('.no-signal-sub');

      if (p)   p.textContent   = msg;
      if (sub) sub.textContent = 'Verifica la fuente de video';

      if (stateVideo) {
        stateVideo.textContent = 'Sin señal';
        stateVideo.className   = 'state-val err';
      }

      _toast(msg, 'err', 6000);
      _setSysStatus('Error de conexión', 'err', 6000);
    },

    onStopped() {
      if (detectionActive) _stopDetection();

      // Detener stream IP en el backend si estaba activo
      if (_ipStreamUrl) {
        detection.stopIPStream();
        _ipStreamUrl = null;
      }

      videoReady = false;
      camPaused = false;
      noSignal?.classList.remove('hidden');

      if (stateVideo) {
        stateVideo.textContent = '—';
        stateVideo.className   = 'state-val';
      }

      alertManager.setOffline?.();
      _syncPauseBtn(false);
      _syncCamBtn(false);
      _updateControls();
      _setSysStatus('Cámara detenida', 'warn', 2000);
    },
  });

  window.camSrc = camSrc;

  // ── Botón parar ──────────────────────────────────────────────────────────
  btnStop?.addEventListener('click', () => {
    if (!camSrc.isReady) return;
    if (detectionActive) _stopDetection();
    camSrc.stop();
    _toast('Cámara detenida', 'info', 2000);
  });

  // ── Botón pausar/reanudar ────────────────────────────────────────────────
  btnPause?.addEventListener('click', () => {
    if (!videoReady) return;
    camPaused = !camPaused;
    camPaused ? video.pause() : video.play().catch(() => {});
    _syncPauseBtn(camPaused);
    _syncCamBtn(!camPaused);
  });

  // ── Reloj ────────────────────────────────────────────────────────────────
  setInterval(() => {
    const el = document.getElementById('headerTime');
    if (el) el.textContent = new Date().toLocaleTimeString('es-UY', { hour12: false });
  }, 1000);

  // ── Resize canvas ────────────────────────────────────────────────────────
  new ResizeObserver(() => {
    const r = canvasWrapper.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      canvas.width = r.width;
      canvas.height = r.height;
    }
  }).observe(canvasWrapper);

  // ── Tabs de fuente ───────────────────────────────────────────────────────
  document.querySelectorAll('.source-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      const newSrc  = tab.dataset.source;
      const prevSrc = srcType;
      srcType = newSrc;

      if (newSrc !== prevSrc) {
        if (detectionActive) _stopDetection();
        detection._lastDets = [];
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        zoneManager.drawZone(false);

        if (camPaused) {
          camPaused = false;
          _syncPauseBtn(false);
          _syncCamBtn(true);
        }

        _setSysStatus('Cambiando fuente…', 'loading');
      }

      if (newSrc === 'webcam') {
        if (prevSrc !== 'webcam') {
          camSrc.stop();
          await _launchWebcam();
        }
      } else if (newSrc === 'webrtc' || newSrc === 'ip') {
        if (prevSrc === 'webcam') camSrc.stop();
      } else if (newSrc === 'file') {
        if (prevSrc === 'webcam') camSrc.stop();
      }
    });
  });

  // ── Webcam ───────────────────────────────────────────────────────────────
  async function _launchWebcam() {
    let selEl = document.getElementById('camSelector');

    if (!selEl) {
      const wrap = document.createElement('div');
      wrap.id = 'camSelectorWrap';
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;';
      wrap.innerHTML = `
        <label style="font-size:10px;letter-spacing:1.5px;color:#5a7a90;text-transform:uppercase;white-space:nowrap;">Camara</label>
        <select id="camSelector" style="flex:1;padding:5px 10px;background:#0c1118;border:1px solid #1a2535;border-radius:5px;color:#c8dde8;font-size:12px;font-family:'Share Tech Mono',monospace;cursor:pointer;outline:none;"></select>
      `;
      const bar = document.querySelector('.source-bar') || document.querySelector('.video-controls');
      bar?.appendChild(wrap);
      selEl = document.getElementById('camSelector');
    }

    const ds = new DeviceSelector(selEl, async (deviceId) => {
      if (deviceId === '__disconnected__') {
        camSrc.stop();
        _toast('La cámara seleccionada se desconectó. Elegí otra.', 'warn', 5000);
        return;
      }
      if (srcType === 'webcam') await camSrc.startWebcam(deviceId, 'monitor');
    });

    const preferred = await ds.populate('monitor');
    if (preferred) await camSrc.startWebcam(preferred, 'monitor');
  }

  // ── IP camera ────────────────────────────────────────────────────────────
  (function buildIPPanel() {
    const cfg = document.getElementById('ipConfig');
    if (!cfg) return;

    const BRAND_PATHS = {
      hikvision: { mjpeg: '/Streaming/Channels/101/httppreview', hls: '/Streaming/Channels/101/httpFlv' },
      dahua:     { mjpeg: '/cgi-bin/mjpg/video.cgi?channel=0&subtype=1' },
      axis:      { mjpeg: '/axis-cgi/mjpg/video.cgi' },
      tplink:    { webrtc: '/api/webrtc?src=main' },
      generic:   { mjpeg: '/video.cgi', hls: '/stream/index.m3u8' },
    };

    const hasNewPanel = !!document.getElementById('ipConnectBtn');

    if (!hasNewPanel) {
      const PH = {
        auto:   'http://192.168.1.x:8083/api/webrtc?src=cam',
        webrtc: 'http://192.168.1.x:8083/api/webrtc?src=cam1',
        whep:   'http://192.168.1.x:8889/cam1/whep',
        mjpeg:  'http://usuario:clave@192.168.1.x/video.cgi',
        hls:    'http://192.168.1.x/stream/cam.m3u8',
      };

      const HELP = {
        auto:   'La URL se analiza automáticamente para detectar el protocolo.',
        webrtc: 'Compatible con go2rtc y mediamtx. Puerto típico: 8083.',
        whep:   'Protocolo moderno. Compatible con mediamtx y cámaras recientes.',
        mjpeg:  'Para cámaras IP baratas, Hikvision, Dahua, Axis. Incluir usuario:clave@ si hace falta.',
        hls:    'Stream .m3u8. Nativo en Safari; Chrome/Firefox usan hls.js automáticamente.',
      };

      cfg.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;padding:6px 0;">
          <div style="display:flex;gap:6px;align-items:center;">
            <label style="font-size:10px;letter-spacing:1.5px;color:#5a7a90;text-transform:uppercase;white-space:nowrap;">Protocolo</label>
            <select id="ipProtocol" style="padding:5px 8px;background:#0c1118;border:1px solid #1a2535;border-radius:5px;color:#c8dde8;font-size:11px;font-family:'Share Tech Mono',monospace;cursor:pointer;outline:none;">
              <option value="auto">Auto-detectar</option>
              <option value="webrtc">WebRTC (go2rtc/mediamtx)</option>
              <option value="whep">WHEP</option>
              <option value="mjpeg">MJPEG directo</option>
              <option value="hls">HLS (.m3u8)</option>
            </select>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="ipUrl" type="text" placeholder="${PH.auto}"
              style="flex:1;padding:6px 10px;background:#0c1118;border:1px solid #1a2535;border-radius:5px;color:#c8dde8;font-size:11px;font-family:'Share Tech Mono',monospace;outline:none;transition:border-color .2s;"
              onfocus="this.style.borderColor='#00d4ff'" onblur="this.style.borderColor='#1a2535'"/>
            <button id="ipConnectBtn"
              style="padding:6px 14px;background:rgba(0,212,255,.08);border:1px solid #00d4ff;border-radius:5px;color:#00d4ff;font-size:11px;font-weight:700;cursor:pointer;font-family:'Barlow',sans-serif;white-space:nowrap;transition:background .15s;">
              Conectar →
            </button>
          </div>
          <div id="ipHelp" style="font-size:10px;color:#3a5468;line-height:1.5;"></div>
        </div>
      `;

      const proto = document.getElementById('ipProtocol');
      const urlIn = document.getElementById('ipUrl');
      const help  = document.getElementById('ipHelp');

      proto?.addEventListener('change', () => {
        urlIn.placeholder = PH[proto.value];
        help.textContent = HELP[proto.value];
      });
    }

    function _doConnect() {
      const ipAddr = document.getElementById('ipAddress')?.value.trim() || '';
      const ipUser = document.getElementById('ipUser')?.value.trim() || '';
      const ipPass = document.getElementById('ipPass')?.value.trim() || '';
      const brand  = document.getElementById('ipBrand')?.value || 'all';
      const proto  = document.getElementById('ipProtocol')?.value || 'auto';
      let url      = document.getElementById('ipUrl')?.value.trim() || '';

      if (ipAddr && !url) {
        const creds = (ipUser || ipPass)
          ? `${encodeURIComponent(ipUser)}:${encodeURIComponent(ipPass)}@`
          : '';

        const paths = BRAND_PATHS[brand] || BRAND_PATHS.generic;

        if (proto === 'mjpeg' && paths.mjpeg) {
          url = `http://${creds}${ipAddr}${paths.mjpeg}`;
        } else if (proto === 'hls' && paths.hls) {
          url = `http://${creds}${ipAddr}${paths.hls}`;
        } else if (proto === 'webrtc' && paths.webrtc) {
          url = `http://${ipAddr}${paths.webrtc}`;
        } else {
          url = `http://${creds}${ipAddr}/video`;
        }

        const urlField = document.getElementById('ipUrl');
        if (urlField) urlField.value = url;
      }

      if (!url) {
        _toast('Ingresa la IP o URL de la cámara', 'warn');
        return;
      }

      const statusEl = document.getElementById('ipConnectionStatus');
      if (statusEl) {
        statusEl.textContent = '⏳ Conectando…';
        statusEl.style.color = '#00d4ff';
      }

      _setSysStatus('Conectando cámara IP…', 'loading');
      // Guardar URL y protocolo para enviarlo al backend al iniciar análisis
      _ipStreamUrl   = url;
      _ipStreamProto = proto || 'mjpeg';
      camSrc.startIP(url, proto);
    }

    document.getElementById('ipConnectBtn')?.addEventListener('click', _doConnect);

    document.getElementById('ipDiscoverBtn')?.addEventListener('click', () => {
      const ipAddr = document.getElementById('ipAddress')?.value.trim();
      if (!ipAddr) {
        _toast('Ingresa la IP de la cámara primero', 'warn');
        return;
      }

      const ipUser = document.getElementById('ipUser')?.value.trim() || '';
      const ipPass = document.getElementById('ipPass')?.value.trim() || '';
      const creds  = (ipUser || ipPass)
        ? `${encodeURIComponent(ipUser)}:${encodeURIComponent(ipPass)}@`
        : '';

      const statusEl = document.getElementById('ipConnectionStatus');
      if (statusEl) {
        statusEl.textContent = '🔍 Buscando…';
        statusEl.style.color = '#ffaa00';
      }

      _toast(`Probando conexión con ${ipAddr}…`, 'info', 3000);
      _setSysStatus(`Descubriendo ${ipAddr}…`, 'loading');
      camSrc.startIP(`http://${creds}${ipAddr}/video`, 'auto');
    });

    document.getElementById('connectProxyBtn')?.addEventListener('click', () => {
      const url = document.getElementById('ipUrl')?.value.trim();
      if (!url) {
        _toast('Ingresa la URL de la cámara primero', 'warn');
        return;
      }

      _toast('Modo proxy activo', 'info', 3000);
      _setSysStatus('Conectando vía proxy…', 'loading');
      camSrc.startIP(url, 'mjpeg');
    });

    const autoFill = () => {
      const ipAddr = document.getElementById('ipAddress')?.value.trim();
      if (!ipAddr) return;

      const brand  = document.getElementById('ipBrand')?.value || 'all';
      const proto  = document.getElementById('ipProtocol')?.value || 'auto';
      const ipUser = document.getElementById('ipUser')?.value.trim() || '';
      const ipPass = document.getElementById('ipPass')?.value.trim() || '';
      const creds  = (ipUser || ipPass)
        ? `${encodeURIComponent(ipUser)}:${encodeURIComponent(ipPass)}@`
        : '';

      const paths = BRAND_PATHS[brand] || BRAND_PATHS.generic;
      let url = '';

      if (proto === 'mjpeg' && paths.mjpeg) {
        url = `http://${creds}${ipAddr}${paths.mjpeg}`;
      } else if (proto === 'hls' && paths.hls) {
        url = `http://${creds}${ipAddr}${paths.hls}`;
      } else if (proto === 'webrtc' && paths.webrtc) {
        url = `http://${ipAddr}${paths.webrtc}`;
      }

      const urlField = document.getElementById('ipUrl');
      if (urlField && url) urlField.value = url;
    };

    document.getElementById('ipBrand')?.addEventListener('change', autoFill);
    document.getElementById('ipProtocol')?.addEventListener('change', autoFill);
    document.getElementById('ipAddress')?.addEventListener('blur', autoFill);

    ['ipAddress', 'ipUser', 'ipPass', 'ipUrl'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') _doConnect();
      });
    });
  })();

  // ── Archivo ──────────────────────────────────────────────────────────────
  document.getElementById('btnFileSelect')?.addEventListener('click', () => {
    document.getElementById('fileInput')?.click();
  });

  document.getElementById('fileInput')?.addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    camSrc.startFile(f);
    _buildVideoBar(f.name);
    e.target.value = '';
  });

  function _buildVideoBar(name) {
    document.getElementById('videoBar')?.remove();

    const bar = document.createElement('div');
    bar.id = 'videoBar';
    bar.style.cssText = 'position:absolute;bottom:0;left:0;right:0;z-index:15;background:linear-gradient(transparent,rgba(6,9,13,.95));padding:8px 12px 10px;display:flex;align-items:center;gap:10px;font-family:"Barlow",sans-serif;';
    bar.innerHTML = `
      <button id="vbPlay" style="${_vbBtn()}">▶</button>
      <div style="flex:1;display:flex;align-items:center;gap:8px;">
        <input id="vbSeek" type="range" min="0" max="100" value="0" style="flex:1;height:3px;accent-color:#00d4ff;cursor:pointer;"/>
        <span id="vbTime" style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#3a5468;white-space:nowrap;">0:00</span>
      </div>
      <button id="vbStop" style="${_vbBtn('#ff3d3d')}" title="Cerrar">✕</button>
      <span style="font-size:10px;color:#3a5468;max-width:110px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="${name}">${name}</span>
    `;

    canvasWrapper.appendChild(bar);

    document.getElementById('vbPlay').onclick = () => {
      if (video.paused) {
        video.play();
        document.getElementById('vbPlay').textContent = '⏸';
      } else {
        video.pause();
        document.getElementById('vbPlay').textContent = '▶';
      }
    };

    document.getElementById('vbStop').onclick = () => {
      camSrc.stop();
      bar.remove();
    };

    const seek = document.getElementById('vbSeek');
    seek.addEventListener('input', () => {
      video.currentTime = (seek.value / 100) * (video.duration || 0);
    });

    video.addEventListener('timeupdate', () => {
      if (!video.duration) return;
      seek.value = (video.currentTime / video.duration) * 100;
      const m = Math.floor(video.currentTime / 60);
      const s = Math.floor(video.currentTime % 60);
      const t = document.getElementById('vbTime');
      if (t) t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    });
  }

  function _vbBtn(c = '#3a5468') {
    return `background:rgba(0,0,0,.5);border:1px solid ${c};border-radius:5px;color:${c};width:28px;height:28px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;`;
  }

  // ── Botón EN VIVO / PAUSADO ──────────────────────────────────────────────
  btnCamToggle?.addEventListener('click', () => {
    if (!videoReady) return;
    camPaused = !camPaused;
    camPaused ? video.pause() : video.play().catch(() => {});
    _syncCamBtn(!camPaused);
  });

  function _syncCamBtn(on) {
    if (!btnCamToggle) return;
    const icon  = btnCamToggle.querySelector('#camToggleIcon');
    const label = btnCamToggle.querySelector('#camToggleLabel');

    btnCamToggle.style.background  = on ? 'rgba(0,255,148,.1)' : 'rgba(255,61,61,.1)';
    btnCamToggle.style.borderColor = on ? '#00ff94' : '#ff3d3d';
    btnCamToggle.style.color       = on ? '#00ff94' : '#ff3d3d';

    if (icon)  icon.textContent  = on ? '●' : '◼';
    if (label) label.textContent = on ? 'EN VIVO' : 'PAUSADO';
  }

  // ── Zonas ────────────────────────────────────────────────────────────────
  _buildZoneModal();

  zoneManager.onZoneChange(zones => {
    const n = zones.length;
    if (stateZone) {
      stateZone.textContent = n > 0 ? `${n} zona(s) ✓` : 'No definida';
      stateZone.className   = `state-val ${n > 0 ? 'ok' : ''}`;
    }

    zoneHint?.classList.add('hidden');
    drawingZone = false;
    btnDrawZone?.classList.remove('active');
    _renderZoneList(zones);

    const btnEZ = document.getElementById('btnEditZone');
    if (btnEZ) btnEZ.disabled = zones.length === 0;
    if (btnClearZone) btnClearZone.disabled = zones.length === 0;
  });

  btnDrawZone?.addEventListener('click', async () => {
    if (drawingZone) {
      zoneManager.disableDraw();
      drawingZone = false;
      zoneHint?.classList.add('hidden');
      btnDrawZone.classList.remove('active');
      return;
    }

    if (zoneManager.zones.length >= 6) {
      _toast('Máximo 6 zonas. Elimina una primero.', 'warn');
      return;
    }

    const nombre = await _openZoneModal();
    if (!nombre) return;

    drawingZone = true;
    zoneManager.enableDraw(nombre);
    zoneHint?.classList.remove('hidden');
    btnDrawZone?.classList.add('active');
    _toast(`Dibuja "${nombre}" haciendo clic en el video. Doble clic para cerrar.`, 'info', 5000);
  });

  document.getElementById('btnEditZone')?.addEventListener('click', function() {
    if (!zoneManager.zones.length) return;
    const editing = this.classList.contains('active');

    if (!editing) {
      zoneManager.enableEdit();
      this.classList.add('active');
      const s = this.querySelector('span');
      if (s) s.textContent = 'Terminar Edicion';
    } else {
      zoneManager.disableEdit();
      this.classList.remove('active');
      const s = this.querySelector('span');
      if (s) s.textContent = 'Editar Zona';
      _toast('Edición guardada', 'ok', 2000);
    }
  });

  btnClearZone?.addEventListener('click', () => {
    if (!zoneManager.zones.length) return;
    _confirm('¿Eliminar todas las zonas?', () => {
      zoneManager.clearAllZones();
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      _updateControls();
    });
  });

  window._rmZone = id => zoneManager.removeZone(id);

  function _renderZoneList(zones) {
    const c = document.getElementById('zoneList');
    const e = document.getElementById('zoneEmpty');
    const n = document.getElementById('zoneCount');
    if (!c) return;

    if (n) n.textContent = `${zones.length} / 6`;
    if (e) e.style.display = zones.length ? 'none' : 'block';

    if (!zones.length) {
      c.innerHTML = '';
      return;
    }

    const COLS = ['#00d4ff', '#00ff94', '#ffb800', '#bf5af2', '#ff6b35', '#00e5ff'];

    c.innerHTML = zones.map(z => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 9px;background:#111820;border:1px solid #1e2d3d;border-left:3px solid ${COLS[z.colorIdx % 6]};border-radius:5px;">
        <div style="width:7px;height:7px;border-radius:50%;background:${COLS[z.colorIdx % 6]};flex-shrink:0;"></div>
        <span style="flex:1;font-size:11px;color:#c8dde8;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:'Share Tech Mono',monospace;">${z.name}</span>
        <button onclick="window._rmZone('${z.id}')" style="background:none;border:none;color:#2e4558;cursor:pointer;font-size:13px;padding:0 3px;" onmouseenter="this.style.color='#ff3d3d'" onmouseleave="this.style.color='#2e4558'">✕</button>
      </div>
    `).join('');
  }

  // ── Detección IA ─────────────────────────────────────────────────────────
  if (stateModel) {
    stateModel.textContent = 'Cargando...';
    stateModel.className = 'state-val warn';
  }

  _setSysStatus('Cargando modelo IA…', 'loading');

  try {
    await detection.init();
    alertManager._detectionEngine = detection;
    if (stateModel) {
      stateModel.textContent = 'Listo ✓';
      stateModel.className = 'state-val ok';
    }
    _setSysStatus('Modelo IA listo ✓', 'ok', 3000);
  } catch (e) {
    if (stateModel) {
      stateModel.textContent = 'Error';
      stateModel.className = 'state-val err';
    }
    _setSysStatus('Error al cargar modelo IA', 'err', 6000);
    console.error('Error cargando modelo IA:', e);
  }

  btnDetection?.addEventListener('click', () => {
    if (videoReady) _toggleDetection();
  });

  function _toggleDetection() {
    if (!videoReady) return;

    detectionActive = !detectionActive;

    if (detectionActive) {
      detection.start();
      _startLoop(); // siempre: dibuja overlays en canvas

      // Si la cámara activa es MJPEG → backend lee el stream directamente
      if (camSrc.type === 'mjpeg') {
        const url = _ipStreamUrl || document.getElementById('ipUrl')?.value?.trim();
        if (url) {
          console.log('%c📡 Enviando IP stream al backend:', 'color:#00d4ff', url);
          detection.startIPStream(url, 'mjpeg');
        } else {
          console.warn('⚠ No se encontró URL de cámara IP para enviar al backend');
        }
      }

      btnDetection?.classList.add('active');
      const s = btnDetection?.querySelector('span');
      if (s) s.textContent = 'Detener Analisis';

      if (stateDetect) {
        stateDetect.textContent = 'Activo ✓';
        stateDetect.className = 'state-val ok';
      }

      _setSysStatus('Análisis IA en curso', 'ok', 3000);
    } else {
      _stopDetection();
    }
  }

  function _stopDetection() {
    detection.stop();

    // Detener stream IP en el backend si estaba activo
    if (_ipStreamUrl) detection.stopIPStream();

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    detectionActive = false;
    detection._lastDets = [];
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    zoneManager.drawZone(false);

    const _ct = document.getElementById('countTotal');
    const _cz = document.getElementById('countInZone');
    const _cb = document.getElementById('countByZone');

    if (_ct) _ct.textContent = '0';
    if (_cz) {
      _cz.textContent = '0';
      _cz.style.color = '#5a7a90';
    }
    if (_cb) _cb.innerHTML = '<span style="color:#3a5468;">Sin actividad en zonas</span>';

    btnDetection?.classList.remove('active');
    const s = btnDetection?.querySelector('span');
    if (s) s.textContent = 'Iniciar Analisis';

    if (stateDetect) {
      stateDetect.textContent = 'Detenido';
      stateDetect.className = 'state-val';
    }

    _setSysStatus('Análisis detenido', 'warn', 2000);
  }

  let lastFT = 0;
  function _startLoop() {
    async function loop(ts) {
      if (!detectionActive) return;

      if (ts - lastFT >= 66) {
        lastFT = ts;

        // Soporte para todas las fuentes: webcam, WebRTC, HLS, archivo → <video>
        // MJPEG → <img> (camera-manager oculta el video y usa un img)
        // Para MJPEG usamos videoReady (seteado por onReady callback) porque
        // naturalWidth puede quedar en 0 en Firefox con streams multipart.
        const srcEl = camSrc.type === 'mjpeg' ? camSrc.mjpegElement : video;
        const ready = camSrc.type === 'mjpeg'
          ? (videoReady && srcEl !== null)
          : (srcEl?.readyState >= 2 && srcEl?.videoWidth > 0 && !srcEl?.paused);
        if (ready) detection.processFrame(srcEl);

        if (fpsDisplay) fpsDisplay.textContent = `${detection.currentFPS} FPS`;
        _updateZoneCount();
      }

      animFrameId = requestAnimationFrame(loop);
    }

    animFrameId = requestAnimationFrame(loop);
  }

  function _updateZoneCount() {
    const countTotalEl  = document.getElementById('countTotal');
    const countInZoneEl = document.getElementById('countInZone');
    const countByZoneEl = document.getElementById('countByZone');
    if (!countTotalEl) return;

    const { total, inZone, byZone } = detection.getZoneCounts();

    countTotalEl.textContent = total;
    countInZoneEl.textContent = inZone;
    countInZoneEl.style.color = inZone > 0 ? '#ff3d3d' : '#5a7a90';

    if (countByZoneEl) {
      if (Object.keys(byZone).length === 0) {
        countByZoneEl.innerHTML = '<span style="color:#3a5468;">Sin actividad en zonas</span>';
      } else {
        countByZoneEl.innerHTML = Object.entries(byZone).map(([name, n]) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(255,61,61,0.08);border:1px solid rgba(255,61,61,0.2);border-radius:5px;">
            <span style="color:#c8dde8;">${name}</span>
            <span style="color:#ff3d3d;font-weight:bold;">${n} persona${n > 1 ? 's' : ''}</span>
          </div>
        `).join('');
      }
    }
  }

  // ── Sliders ──────────────────────────────────────────────────────────────
  [
    [sliderMovement, valMovement, 50, 'movementThreshold'],
    [sliderDwell,    valDwell,    3,  'dwellTime'],
    [sliderCooldown, valCooldown, 6,  'cooldown']
  ].forEach(([sld, val, def, key]) => {
    if (!sld) return;
    sld.value = def;
    if (val) val.textContent = def;
    sld.addEventListener('input', () => {
      const v = +sld.value;
      if (val) val.textContent = v;
      detection.updateConfig({ [key]: v });
    });
  });

  document.getElementById('btnExport')?.addEventListener('click', () => alertManager.exportCSV?.());
  document.getElementById('btnLogout')?.addEventListener('click', async () => {
    const { logout } = await import('./firebase-config.js');
    logout();
  });

  // ── Selector tipo de local ───────────────────────────────────────────────
  const storeSelect = document.getElementById('storeTypeSelect');
  if (storeSelect) {
    storeSelect.innerHTML = '';

    for (const p of listProfiles()) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = `${p.icon} ${p.name}`;
      storeSelect.appendChild(opt);
    }

    storeSelect.value = 'generico';
    storeSelect.style.cssText = [
      'padding:5px 10px',
      'background:#0c1118',
      'border:1px solid #1a2535',
      'border-radius:5px',
      'color:#c8dde8',
      'font-size:11px',
      "font-family:'Share Tech Mono',monospace",
      'cursor:pointer',
      'outline:none',
      'height:32px',
    ].join(';');

    storeSelect.addEventListener('change', () => {
      const type    = storeSelect.value;
      const label   = storeSelect.options[storeSelect.selectedIndex].text;
      const profile = detection.setStoreType(type);

      alertManager.setProfile(profile);

      if (sliderDwell && profile?.dwellTime) {
        sliderDwell.value = profile.dwellTime;
        if (valDwell) valDwell.textContent = profile.dwellTime;
        detection.updateConfig({ dwellTime: profile.dwellTime });
      }

      if (stateModel) {
        stateModel.textContent = `Listo ✓ · ${label}`;
        stateModel.className = 'state-val ok';
      }

      savePref?.('storeType', type);
      _toast(`Perfil: ${label}`, 'ok', 2000);
    });
  }

  // ── Clic derecho → marcar empleado ───────────────────────────────────────
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!detectionActive) return;

    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) * (canvas.width / rect.width)) / canvas.width;
    const ny = ((e.clientY - rect.top) * (canvas.height / rect.height)) / canvas.height;

    const hit = detection.getTracks().find(t =>
      nx >= t.bbox.nx1 && nx <= t.bbox.nx2 &&
      ny >= t.bbox.ny1 && ny <= t.bbox.ny2
    );

    if (!hit) {
      _toast('Clic derecho sobre una persona para marcarla', 'info', 1800);
      return;
    }

    if (hit.isEmployee) {
      detection.markCustomer(hit.id);
      _toast(`Track #${hit.id} → CLIENTE (monitoreo activo)`, 'warn', 2500);
    } else {
      detection.markEmployee(hit.id);
      _toast(`Track #${hit.id} → EMPLEADO 👷 (alertas desactivadas)`, 'ok', 2500);
    }
  });

  // ── Init final UI ────────────────────────────────────────────────────────
  _updateControls();
  _syncPauseBtn(false);
  _syncCamBtn(false);
  _renderZoneList(zoneManager.zones || []);
  _setSysStatus('Sistema listo', 'ok', 1800);

  // Intentar webcam inicial
  try {
    await _launchWebcam();
  } catch (e) {
    console.warn('No se pudo iniciar webcam automáticamente:', e);
  }

  // ── Helpers UI ───────────────────────────────────────────────────────────
  function _updateControls() {
    if (btnDrawZone)  btnDrawZone.disabled  = !videoReady;
    if (btnDetection) btnDetection.disabled = !videoReady;
    if (btnCamToggle) btnCamToggle.disabled = !camSrc.isReady;
    if (btnStop)      btnStop.disabled      = !camSrc.isReady;
    if (btnPause)     btnPause.disabled     = !videoReady;

    const hasZones = zoneManager.zones.length > 0;
    const btnEZ = document.getElementById('btnEditZone');
    if (btnEZ) btnEZ.disabled = !hasZones;
    if (btnClearZone) btnClearZone.disabled = !hasZones;

    if (!videoReady && btnPause) _syncPauseBtn(false);
  }

  function _syncPauseBtn(paused) {
    if (!btnPause) return;
    const span = btnPause.querySelector('span');

    if (paused) {
      btnPause.classList.add('active');
      btnPause.style.borderColor = 'var(--warn, #ffaa00)';
      btnPause.style.color       = 'var(--warn, #ffaa00)';
      if (span) span.textContent = 'Reanudar';
    } else {
      btnPause.classList.remove('active');
      btnPause.style.borderColor = '';
      btnPause.style.color       = '';
      if (span) span.textContent = 'Pausar';
    }
  }

  function _flashStatus(sev) {
    const b = document.getElementById('sensStatus');
    if (!b) return;

    b.textContent = sev === 'high' ? '⚠ ALERTA' : '⚠ AVISO';
    b.style.color = sev === 'high' ? 'var(--danger,#ff3d3d)' : 'var(--warn,#ffaa00)';

    clearTimeout(b._t);
    b._t = setTimeout(() => {
      if (detectionActive) {
        b.textContent = 'ACTIVO';
        b.style.color = 'var(--ok,#00e676)';
      }
    }, 3000);
  }

  function _toast(msg, type = 'info', ms = 3500) {
    const cols = { info: '#00c8ff', warn: '#ffaa00', ok: '#00e676', err: '#ff3d3d' };
    const n = document.createElement('div');

    n.style.cssText = `
      position:fixed;
      top:70px;
      right:20px;
      z-index:9999;
      background:#0d1520;
      border:1px solid ${cols[type] || cols.info};
      border-radius:10px;
      padding:13px 18px;
      max-width:340px;
      font-family:'Barlow',sans-serif;
      font-size:13px;
      color:#c8dde8;
      box-shadow:0 8px 32px rgba(0,0,0,.6);
      line-height:1.5;
      animation:_tIn .22s ease;
    `;

    n.innerHTML = `<style>@keyframes _tIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:translateX(0)}}</style>${msg}`;
    document.body.appendChild(n);

    setTimeout(() => {
      n.style.opacity = '0';
      n.style.transition = 'opacity .4s';
    }, ms);

    setTimeout(() => n.remove(), ms + 450);
  }

  function _setSysStatus(msg, kind = 'ok', ms = 0) {
    const box = document.getElementById('sysStatus');
    const txt = document.getElementById('sysStatusMsg');
    if (!box || !txt) return;

    box.classList.remove('hidden');
    box.className = `sys-status ${kind}`;
    txt.textContent = msg;

    clearTimeout(_ssTimer);
    if (ms > 0) {
      _ssTimer = setTimeout(() => box.classList.add('hidden'), ms);
    }
  }

  function _confirm(msg, onOk) {
    const ok = window.confirm(msg);
    if (ok && typeof onOk === 'function') onOk();
  }

  function _buildZoneModal() {
    if (document.getElementById('zoneModalBack')) return;

    const back = document.createElement('div');
    back.id = 'zoneModalBack';
    back.style.cssText = `
      position:fixed;inset:0;z-index:10030;background:rgba(0,0,0,.55);
      display:none;align-items:center;justify-content:center;padding:18px;
      backdrop-filter:blur(4px);
    `;

    back.innerHTML = `
      <div style="width:min(92vw,420px);background:#0d1520;border:1px solid #223346;border-radius:14px;padding:18px 18px 16px;box-shadow:0 14px 44px rgba(0,0,0,.45);">
        <div style="font:700 16px 'Barlow',sans-serif;color:#eaf6ff;margin-bottom:6px;">Nueva zona</div>
        <div style="font:400 12px 'Barlow',sans-serif;color:#6d869a;line-height:1.5;margin-bottom:12px;">Poné un nombre para identificar la zona vigilada.</div>
        <input id="zmInput" type="text" maxlength="36" placeholder="Ej: Góndola perfumes"
          style="width:100%;padding:10px 12px;background:#0a1118;border:1px solid #1a2535;border-radius:8px;color:#d7e8f4;font:600 13px 'Barlow',sans-serif;outline:none;box-sizing:border-box;"/>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <button class="zm-sug" data-val="Entrada" style="${_zmSugBtn()}">Entrada</button>
          <button class="zm-sug" data-val="Caja" style="${_zmSugBtn()}">Caja</button>
          <button class="zm-sug" data-val="Góndola" style="${_zmSugBtn()}">Góndola</button>
          <button class="zm-sug" data-val="Mostrador" style="${_zmSugBtn()}">Mostrador</button>
          <button class="zm-sug" data-val="Farmacia" style="${_zmSugBtn()}">Farmacia</button>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button id="zmCancel" style="${_zmActionBtn('#2e4558', 'transparent')}">Cancelar</button>
          <button id="zmOk" style="${_zmActionBtn('#00d4ff', 'rgba(0,212,255,.08)')}">Crear</button>
        </div>
      </div>
    `;

    document.body.appendChild(back);
  }

  function _zmSugBtn() {
    return 'padding:6px 10px;background:#111820;border:1px solid #1e2d3d;border-radius:999px;color:#c8dde8;font:600 11px "Barlow",sans-serif;cursor:pointer;';
  }

  function _zmActionBtn(border, bg) {
    return `padding:8px 12px;background:${bg};border:1px solid ${border};border-radius:8px;color:${border};font:700 12px 'Barlow',sans-serif;cursor:pointer;`;
  }

  function _openZoneModal() {
    return new Promise(resolve => {
      const back   = document.getElementById('zoneModalBack');
      const input  = document.getElementById('zmInput');
      const ok     = document.getElementById('zmOk');
      const cancel = document.getElementById('zmCancel');

      if (!back || !input || !ok || !cancel) {
        resolve(null);
        return;
      }

      input.value = '';
      back.style.display = 'flex';
      setTimeout(() => input.focus(), 70);

      document.querySelectorAll('.zm-sug').forEach(b => {
        b.onclick = () => { input.value = b.dataset.val || ''; };
      });

      const finish = (val) => {
        back.style.display = 'none';
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        back.removeEventListener('click', onBack);
        resolve(val);
      };

      const onOk = () => finish(input.value.trim() || null);
      const onCancel = () => finish(null);
      const onKey = (e) => {
        if (e.key === 'Enter') finish(input.value.trim() || null);
        if (e.key === 'Escape') finish(null);
      };
      const onBack = (e) => {
        if (e.target === back) finish(null);
      };

      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      back.addEventListener('click', onBack);
    });
  }

  function _ensureTopAlertBanner() {
    let el = document.getElementById('topAlertBanner');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'topAlertBanner';
    el.style.cssText = `
      position:fixed;
      top:70px;
      left:50%;
      transform:translateX(-50%) translateY(-8px);
      z-index:10020;
      min-width:280px;
      max-width:min(92vw,680px);
      padding:12px 16px;
      border-radius:12px;
      border:1px solid rgba(255,61,61,.28);
      background:rgba(8,12,18,.92);
      color:#eaf6ff;
      font-family:'Barlow',sans-serif;
      font-size:14px;
      font-weight:700;
      letter-spacing:.2px;
      box-shadow:0 10px 34px rgba(0,0,0,.42);
      opacity:0;
      pointer-events:none;
      transition:opacity .22s ease, transform .22s ease, border-color .22s ease;
      backdrop-filter:blur(8px);
    `;
    el.innerHTML = `<span id="topAlertBannerText">🚨 Alerta</span>`;
    document.body.appendChild(el);
    return el;
  }

  function _bannerColor(sev = 'high') {
    if (sev === 'low') return '#00c8ff';
    if (sev === 'medium') return '#ffaa00';
    if (sev === 'high') return '#ff3d3d';
    return '#ff1744';
  }

  function _prettyAlertText(msg) {
    const map = {
      ALERTA_YOLO:          '🚨 HURTO VISUAL DETECTADO',
      ALERTA_LSTM:          '🧠 PATRÓN DE HURTO DETECTADO',
      ALERTA_GITHUB:        '🎯 HURTO DETECTADO POR MODELO',
      ROBO_CONFIRMADO:      '🚨 ROBO CONFIRMADO',
      BAJO_ROPA:            '👕 OBJETO BAJO ROPA',
      BAJO_MANGA:           '🧥 OBJETO BAJO MANGA',
      BOLSILLO:             '🤚 MANO EN BOLSILLO',
      ESCANEO:              '👀 ESCANEO SOSPECHOSO',
      PERMANENCIA:          '⏱ PERMANENCIA SOSPECHOSA',
      PANTALLA_HUMANA:      '👥 POSIBLE CÓMPLICE',
      COMPLICE_DISTRACTOR:  '👥 POSIBLE DISTRACTOR',
      BRAZOS_CRUZADOS:      '🙅 BRAZOS CRUZADOS / OCULTANDO',
      AGACHADO:             '⬇ AGACHADO SOSPECHOSO',
      PANTALLA:             '🚧 PANTALLA CORPORAL',
      ZONA_ENTRADA:         '📍 ENTRADA A ZONA VIGILADA',
    };

    return map[msg] || `⚠ ${String(msg).replaceAll('_', ' ')}`;
  }

  function _showTopAlert(msg, sev = 'high') {
    if (!topAlertBanner || !topAlertBannerText) return;

    const color = _bannerColor(sev);
    topAlertBannerText.textContent = _prettyAlertText(msg);
    topAlertBanner.style.borderColor = color;
    topAlertBanner.style.opacity = '1';
    topAlertBanner.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(_topAlertTimer);
    _topAlertTimer = setTimeout(() => {
      topAlertBanner.style.opacity = '0';
      topAlertBanner.style.transform = 'translateX(-50%) translateY(-8px)';
    }, sev === 'high' ? 3200 : 2400);
  }

  function _shouldShowTopAlert(msg, sev = 'high') {
    if (sev === 'high') return true;
    return [
      'ALERTA_YOLO',
      'ALERTA_LSTM',
      'ALERTA_GITHUB',
      'ROBO_CONFIRMADO',
      'BAJO_ROPA',
      'BAJO_MANGA'
    ].includes(msg);
  }
}