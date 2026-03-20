/**
 * startup-loader.js — Veexion
 * ─────────────────────────────────────────────────────────────────────────
 * Overlay de arranque premium para monitor.html y multicam.html.
 *
 * Uso:
 *   import { StartupLoader } from './startup-loader.js';
 *
 *   const loader = new StartupLoader({ title: '...', subtitle: '...' });
 *   loader.loading('backend');          // marca paso como "en curso"
 *   loader.done('backend');             // marca paso como "listo"
 *   loader.fail('backend', 'msg opt');  // marca paso como "error"
 *   loader.setSubtitle('nuevo texto');  // cambia subtítulo en vuelo
 *   loader.close();                     // cierra con fade (600 ms delay)
 */

export class StartupLoader {
  /**
   * @param {Object} opts
   * @param {string}   opts.title     Título principal del overlay
   * @param {string}   opts.subtitle  Subtítulo descriptivo
   * @param {Array}    opts.steps     [{key, label}, ...]  — orden de los pasos
   * @param {Array}    opts.extras    [{icon, label, note}, ...] — modelos extra
   */
  constructor(opts = {}) {
    this._startTime = Date.now();
    this._destroyed = false;
    this._timerInterval = null;
    this._overlay = null;
    this._timerEl = null;
    this._subtitleEl = null;
    this._spinnerEl = null;

    this._opts = {
      title: opts.title || 'Iniciando motor de análisis',
      subtitle: opts.subtitle || 'Preparando detección base y conectando al backend',

      steps: opts.steps || [
        { key: 'backend',   label: 'Conectando con backend'   },
        { key: 'websocket', label: 'WebSocket de análisis'    },
        { key: 'models',    label: 'Cargando detección base'  },
        { key: 'ready',     label: 'Sistema listo'            },
      ],

      extras: opts.extras || [
        { icon: '🧠', label: 'GitHub model',      note: 'consume más recursos' },
        { icon: '🎯', label: 'Shoplifting YOLO',  note: 'apoyo visual extra'  },
      ],
    };

    this._inject();
    this._startTimer();
  }

  // ─── API pública ─────────────────────────────────────────────────────────

  /** Cambia el subtítulo del loader en tiempo real */
  setSubtitle(text) {
    if (this._subtitleEl) this._subtitleEl.textContent = text;
  }

  /** Marca un paso como "en curso" (spinner girando) */
  loading(key) {
    if (this._destroyed) return;
    const step = this._overlay?.querySelector(`[data-sl-step="${key}"]`);
    if (!step) return;
    step.className = '__sl_step __sl_loading';
    step.querySelector('.__sl_ico').innerHTML = '<div class="__sl_spin"></div>';
    step.querySelector('.__sl_lbl').style.color = '';
  }

  /** Marca un paso como completado */
  done(key) {
    if (this._destroyed) return;
    const step = this._overlay?.querySelector(`[data-sl-step="${key}"]`);
    if (!step) return;
    step.className = '__sl_step __sl_done';
    step.querySelector('.__sl_ico').innerHTML = '<span class="__sl_check">✓</span>';
    const t = step.querySelector('.__sl_time');
    if (t) t.textContent = `${this._elapsed()}s`;
  }

  /** Marca un paso como error (pero no bloquea el cierre) */
  fail(key, labelOverride = null) {
    if (this._destroyed) return;
    const step = this._overlay?.querySelector(`[data-sl-step="${key}"]`);
    if (!step) return;
    step.className = '__sl_step __sl_error';
    step.querySelector('.__sl_ico').innerHTML = '<span class="__sl_x">✕</span>';
    if (labelOverride) {
      const l = step.querySelector('.__sl_lbl');
      if (l) l.textContent = labelOverride;
    }
    const t = step.querySelector('.__sl_time');
    if (t) t.textContent = `${this._elapsed()}s`;
  }

  /**
   * Cierra el overlay con animación.
   * @param {number} delay ms antes de empezar el fade (default 600)
   */
  close(delay = 600) {
    if (this._destroyed) return;
    clearInterval(this._timerInterval);

    // Spinner principal → color verde (indicación de éxito)
    if (this._spinnerEl) this._spinnerEl.classList.add('__sl_spinner_done');

    setTimeout(() => {
      if (!this._overlay) return;
      this._overlay.style.opacity = '0';
      this._overlay.style.pointerEvents = 'none';
      setTimeout(() => {
        this._overlay?.remove();
        document.getElementById('__sl_css')?.remove();
        this._destroyed = true;
      }, 420);
    }, delay);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  _elapsed() {
    return ((Date.now() - this._startTime) / 1000).toFixed(1);
  }

  _startTimer() {
    this._timerInterval = setInterval(() => {
      if (this._timerEl) this._timerEl.textContent = `${this._elapsed()}s`;
    }, 100);
  }

  _inject() {
    // ── CSS ──────────────────────────────────────────────────────────────
    if (!document.getElementById('__sl_css')) {
      const s = document.createElement('style');
      s.id = '__sl_css';
      s.textContent = `
        #__sl_overlay {
          position: fixed; inset: 0; z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          background: rgba(4, 7, 12, 0.94);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          opacity: 0;
          transition: opacity .38s ease;
          font-family: 'Barlow', sans-serif;
        }
        #__sl_overlay.__sl_vis { opacity: 1; }

        .__sl_card {
          width: min(480px, calc(100vw - 28px));
          background: linear-gradient(160deg, #0b1420 0%, #080f18 100%);
          border: 1px solid rgba(0,200,255,.22);
          border-radius: 20px;
          padding: 26px 26px 20px;
          box-shadow:
            0 0 0 1px rgba(0,200,255,.06),
            0 0 60px rgba(0,200,255,.07),
            0 30px 80px rgba(0,0,0,.75);
          animation: __sl_up .38s cubic-bezier(.22,.68,0,1.2);
        }

        @keyframes __sl_up {
          from { transform: translateY(18px) scale(.98); opacity: 0; }
          to   { transform: translateY(0)    scale(1);   opacity: 1; }
        }

        /* ── Head ── */
        .__sl_head {
          display: flex; align-items: flex-start; gap: 16px;
          margin-bottom: 24px;
        }

        .__sl_spinner {
          width: 38px; height: 38px; flex-shrink: 0; margin-top: 2px;
          border: 2px solid rgba(0,200,255,.15);
          border-top-color: #00c8ff;
          border-radius: 50%;
          animation: __sl_spin .85s linear infinite;
          transition: border-color .5s;
        }
        .__sl_spinner.__sl_spinner_done {
          border-color: rgba(0,230,118,.3);
          border-top-color: #00e676;
        }
        @keyframes __sl_spin { to { transform: rotate(360deg); } }

        .__sl_titles { flex: 1; }
        .__sl_title {
          font-size: 15px; font-weight: 700;
          color: #eaf6ff; letter-spacing: .3px; margin-bottom: 5px;
          line-height: 1.3;
        }
        .__sl_subtitle {
          font-size: 11.5px; color: #3e5a6e; line-height: 1.55;
          transition: color .25s;
        }

        /* ── Steps ── */
        .__sl_steps {
          display: flex; flex-direction: column; gap: 7px;
          margin-bottom: 16px;
        }

        .__sl_step {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 12px; border-radius: 9px;
          border: 1px solid rgba(255,255,255,.04);
          background: rgba(255,255,255,.018);
          transition: background .25s, border-color .25s;
        }
        .__sl_step.__sl_loading {
          border-color: rgba(0,200,255,.22);
          background: rgba(0,200,255,.05);
        }
        .__sl_step.__sl_done {
          border-color: rgba(0,230,118,.2);
          background: rgba(0,230,118,.04);
        }
        .__sl_step.__sl_error {
          border-color: rgba(255,80,80,.22);
          background: rgba(255,80,80,.04);
        }

        .__sl_ico {
          width: 20px; height: 20px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }

        .__sl_spin {
          width: 14px; height: 14px;
          border: 1.5px solid rgba(0,200,255,.25);
          border-top-color: #00c8ff;
          border-radius: 50%;
          animation: __sl_spin .65s linear infinite;
        }

        .__sl_circle { color: #1a3040; font-size: 14px; }
        .__sl_check  { color: #00e676; font-size: 14px; font-weight: 700; }
        .__sl_x      { color: #ff5a5a; font-size: 13px; font-weight: 700; }

        .__sl_lbl {
          flex: 1; font-size: 12px; color: #2e4558;
          letter-spacing: .3px;
          transition: color .25s;
        }
        .__sl_step.__sl_loading .__sl_lbl { color: #00c8ff; }
        .__sl_step.__sl_done    .__sl_lbl { color: #b0ccd8; }
        .__sl_step.__sl_error   .__sl_lbl { color: #ff6a6a; }

        .__sl_time {
          font-family: 'Share Tech Mono', monospace;
          font-size: 10px; color: #1a2a38; white-space: nowrap;
          transition: color .25s;
        }
        .__sl_step.__sl_done  .__sl_time { color: #00b856; }
        .__sl_step.__sl_error .__sl_time { color: #cc4444; }

        /* ── Divider ── */
        .__sl_div {
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(0,200,255,.08), rgba(0,200,255,.08), transparent);
          margin: 14px 0;
        }

        /* ── Extras (modelos opcionales) ── */
        .__sl_extras {
          display: flex; flex-direction: column; gap: 7px;
          margin-bottom: 18px;
        }
        .__sl_extra {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 12px; border-radius: 7px;
          border: 1px solid rgba(255,170,0,.1);
          background: rgba(255,170,0,.02);
        }
        .__sl_extra_icon { font-size: 13px; flex-shrink: 0; }
        .__sl_extra_lbl  { font-size: 11px; color: #3a5060; flex: 1; letter-spacing: .2px; }
        .__sl_extra_badge {
          padding: 2px 8px; border-radius: 4px;
          font-family: 'Share Tech Mono', monospace;
          font-size: 9px; letter-spacing: 1.5px;
          background: rgba(255,170,0,.06);
          border: 1px solid rgba(255,170,0,.2);
          color: #a07020; flex-shrink: 0;
        }
        .__sl_extra_note { font-size: 10px; color: #1e2e3a; }

        /* ── Footer ── */
        .__sl_footer {
          display: flex; align-items: center;
          justify-content: space-between; gap: 12px;
        }
        .__sl_timer {
          font-family: 'Share Tech Mono', monospace;
          font-size: 12px; color: #1e3040; letter-spacing: 1px;
          flex-shrink: 0;
        }
        .__sl_footnote {
          font-size: 10px; color: #182430; line-height: 1.45;
          text-align: right;
        }

        /* ── Accent line ── */
        .__sl_card::before {
          content: '';
          display: block; height: 2px; margin: -26px -26px 24px;
          border-radius: 20px 20px 0 0;
          background: linear-gradient(90deg,
            transparent 0%,
            rgba(0,200,255,.5) 35%,
            rgba(255,170,0,.35) 65%,
            transparent 100%
          );
        }
      `;
      document.head.appendChild(s);
    }

    // ── HTML ──────────────────────────────────────────────────────────────
    const el = document.createElement('div');
    el.id = '__sl_overlay';

    const stepsHtml = this._opts.steps.map(s => `
      <div class="__sl_step" data-sl-step="${s.key}">
        <div class="__sl_ico"><span class="__sl_circle">○</span></div>
        <span class="__sl_lbl">${s.label}</span>
        <span class="__sl_time"></span>
      </div>
    `).join('');

    const extrasHtml = this._opts.extras.map(e => `
      <div class="__sl_extra">
        <span class="__sl_extra_icon">${e.icon}</span>
        <span class="__sl_extra_lbl">${e.label}</span>
        <span class="__sl_extra_badge">MANUAL · OFF</span>
        <span class="__sl_extra_note">${e.note || ''}</span>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="__sl_card">
        <div class="__sl_head">
          <div class="__sl_spinner" id="__sl_spinner"></div>
          <div class="__sl_titles">
            <div class="__sl_title">${this._opts.title}</div>
            <div class="__sl_subtitle" id="__sl_subtitle">${this._opts.subtitle}</div>
          </div>
        </div>

        <div class="__sl_steps">${stepsHtml}</div>

        <div class="__sl_div"></div>

        <div class="__sl_extras">${extrasHtml}</div>

        <div class="__sl_footer">
          <span class="__sl_timer" id="__sl_timer">0.0s</span>
          <span class="__sl_footnote">
            Los modelos avanzados se activan<br>
            desde el panel lateral cuando los necesités
          </span>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._overlay    = el;
    this._timerEl    = el.querySelector('#__sl_timer');
    this._subtitleEl = el.querySelector('#__sl_subtitle');
    this._spinnerEl  = el.querySelector('#__sl_spinner');

    // Fade in en el próximo frame
    requestAnimationFrame(() => el.classList.add('__sl_vis'));
  }
}