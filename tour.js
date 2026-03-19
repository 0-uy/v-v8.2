/**
 * tour.js — SSIP v8.1 — Tour interactivo del monitor
 * ─────────────────────────────────────────────────────────────────────
 * Cambios v8.1:
 *   · 12 pasos (era 8): agregados perfil de local, personas en zona,
 *     Pausar/Detener, badges de modelos IA activos, clic derecho empleado
 *   · Paso de segmentación de silueta (SEG-SIL) y MediaPipe (MP-HAND)
 *   · Paso de Firebase / sync en la nube
 *   · Responsive: mobile bottom-sheet, desktop smart-position
 *   · Re-render en resize, scroll-aware, arrow auto-hide
 *   · TOUR_KEY actualizado — reabre automáticamente para usuarios v7
 */

(function () {

  var KEY = 'ssip_tour_v8_1';

  /* ── PASOS ──────────────────────────────────────────────────────────
   * sel:   CSS selector del elemento a resaltar
   * pos:   'auto' | 'right' | 'left' | 'bottom' | 'top'
   * title: título del tooltip
   * body:  HTML del contenido
   * ─────────────────────────────────────────────────────────────────── */
  var STEPS = [

    /* 01 — Fuente de video */
    {
      sel:   '.source-tabs',
      pos:   'bottom',
      title: '📷 Paso 1 — Fuente de video',
      body:  '<b>Webcam:</b> detecta automáticamente la cámara USB.<br>' +
             '<b>IP / WebRTC:</b> conecta una cámara IP del local con go2rtc.<br>' +
             '<b>Archivo:</b> analizá un video grabado offline.'
    },

    /* 02 — Perfil de local */
    {
      sel:   '#storeTypeSelect',
      pos:   'auto',
      title: '🏪 Paso 2 — Perfil del local',
      body:  'Elegí el tipo de comercio para <b>calibrar la sensibilidad</b> automáticamente.<br>' +
             'Joyería = umbral 50 pts (muy sensible).<br>' +
             'Supermercado = umbral 70 pts (más tolerante).<br>' +
             'El perfil también ajusta qué objetos se priorizan.'
    },

    /* 03 — Definir zona */
    {
      sel:   '#btnDrawZone',
      pos:   'auto',
      title: '📐 Paso 3 — Definir zona crítica',
      body:  'Hacé clic aquí, ingresá el nombre de la zona, y luego ' +
             '<b>clic a clic</b> sobre el video para trazar el perímetro.<br>' +
             '<b>Doble clic</b> o <b>Enter</b> para cerrar la zona.<br>' +
             'Podés tener hasta <b>6 zonas</b> con colores distintos.'
    },

    /* 04 — Editar zona */
    {
      sel:   '#btnEditZone',
      pos:   'auto',
      title: '✏️ Paso 4 — Editar zona',
      body:  'Activá este modo para <b>arrastrar los vértices</b> de cualquier ' +
             'zona y ajustar su posición.<br>' +
             'Útil cuando la cámara se mueve o cambia de ángulo.<br>' +
             'Hacé clic de nuevo en el botón para terminar la edición.'
    },

    /* 05 — Análisis IA */
    {
      sel:   '#btnDetection',
      pos:   'auto',
      title: '🎯 Paso 5 — Iniciar análisis IA',
      body:  'Activa la detección en tiempo real con <b>29 reglas</b> de comportamiento:<br>' +
             '· Manos dentro de la zona crítica<br>' +
             '· Permanencia prolongada y escaneo del entorno<br>' +
             '· Manos en bolsillos, bajo manga, bajo ropa<br>' +
             '· Coordinación entre cómplices<br>' +
             '· <b>Alta Vigilancia ×3</b> si detecta escaneo previo'
    },

    /* 06 — Modelos activos (badges en canvas) */
    {
      sel:   '#overlayCanvas',
      pos:   'right',
      title: '🤖 Paso 6 — Modelos de IA activos',
      body:  'En la esquina del video aparecen los modelos cargados:<br>' +
             '<b>⬡ YOLOE 1200+</b> — detecta objetos con vocabulario extendido.<br>' +
             '<b>🖐 MP-HAND</b> — MediaPipe con 21 landmarks por mano (pinch grip).<br>' +
             '<b>⬟ SEG-SIL</b> — segmentación de silueta: detecta objetos ' +
             'ocultos bajo la ropa aunque sean demasiado pequeños para los keypoints.<br>' +
             'Si alguno falta, el sistema sigue funcionando sin él.'
    },

    /* 07 — Pausar / Detener */
    {
      sel:   '#btnPause',
      pos:   'auto',
      title: '⏸ Paso 7 — Pausar y Detener',
      body:  '<b>Pausar:</b> congela el análisis sin perder el estado ' +
             '(tracks, score, historial).<br>' +
             '<b>Detener:</b> termina la sesión completamente y resetea todo.<br>' +
             'Útil para evitar falsas alarmas mientras ajustás la escena o ' +
             'recolocás la cámara.'
    },

    /* 08 — EN VIVO toggle */
    {
      sel:   '#btnCamToggle',
      pos:   'auto',
      title: '🟢 Paso 8 — Control de transmisión',
      body:  'Pausa o reanuda la cámara sin salir de la página.<br>' +
             'Cuando está en <b>PAUSADO</b> el análisis IA también se detiene ' +
             'pero los eventos anteriores se conservan en el historial.'
    },

    /* 09 — Sensibilidad */
    {
      sel:   '#sliderMovement',
      pos:   'auto',
      title: '⚙️ Paso 9 — Ajustar sensibilidad',
      body:  '<b>Umbral movimiento:</b> qué tan brusco debe ser el gesto para ' +
             'registrarse.<br>' +
             '<b>Tiempo en zona:</b> segundos mínimos antes de alertar por ' +
             'permanencia prolongada.<br>' +
             '<b>Cooldown:</b> pausa entre alertas del mismo tipo (evita spam).'
    },

    /* 10 — Personas en zona */
    {
      sel:   '#zoneCountCard',
      pos:   'auto',
      title: '👥 Paso 10 — Personas en zona',
      body:  'Contador en tiempo real de cuántas personas detecta la cámara ' +
             'y cuántas están dentro de alguna zona crítica.<br>' +
             'Si el número <b>En zona</b> sube de repente, prestá atención al video.'
    },

    /* 11 — Zonas activas */
    {
      sel:   '#zonesCard',
      pos:   'auto',
      title: '🗺️ Paso 11 — Zonas activas',
      body:  'Acá ves todas las zonas con su color.<br>' +
             'Podés eliminar una individual con el botón <b>✕</b>.<br>' +
             'El clic derecho sobre una persona en el video la marca como ' +
             '<b>empleado</b> — queda excluida de alertas permanentemente en esa sesión.'
    },

    /* 12 — Historial de eventos */
    {
      sel:   '.events-card',
      pos:   'auto',
      title: '📋 Paso 12 — Historial de eventos',
      body:  'Cada alerta se guarda acá con <b>foto instantánea</b>, tipo y hora exacta.<br>' +
             'Se sincronizan automáticamente en tu panel principal (Firebase).<br>' +
             'Se borran solos después de 48 horas.<br>' +
             'Exportá toda la sesión con el botón <b>CSV</b>.'
    },

  ];

  /* ── CSS ─────────────────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('_tcss')) return;
    var s = document.createElement('style');
    s.id  = '_tcss';
    s.textContent =
      /* Highlight ring */
      '.thl{' +
        'position:fixed;z-index:9800;border-radius:8px;pointer-events:none;' +
        'box-shadow:0 0 0 9999px rgba(0,0,0,0.80);' +
        'outline:2px solid rgba(0,200,255,0.7);outline-offset:3px;' +
        'transition:top .3s ease,left .3s ease,width .3s ease,height .3s ease;' +
      '}' +

      /* Bubble */
      '.tbx{' +
        'position:fixed;z-index:9801;background:#0a1118;' +
        'border:1.5px solid rgba(0,200,255,0.55);border-radius:13px;' +
        'padding:16px 16px 13px;' +
        'width:min(290px,calc(100vw - 20px));' +
        'max-height:calc(100vh - 40px);overflow-y:auto;' +
        'box-shadow:0 0 30px rgba(0,200,255,0.12),0 20px 50px rgba(0,0,0,0.9);' +
        'font-family:"Barlow","Exo 2",sans-serif;box-sizing:border-box;' +
        'animation:_tIn .22s cubic-bezier(.4,0,.2,1);' +
      '}' +

      /* Arrow */
      '.tbx::before{' +
        'content:"";position:absolute;width:10px;height:10px;' +
        'background:#0a1118;border:1.5px solid rgba(0,200,255,0.55);' +
        'transform:rotate(45deg);' +
      '}' +
      '.tbx.arr-right::before {left:-6px;  top:20px; border-right:none; border-top:none;}' +
      '.tbx.arr-left::before  {right:-6px; top:20px; border-left:none;  border-bottom:none;}' +
      '.tbx.arr-bottom::before{top:-6px;   left:20px;border-bottom:none;border-right:none;}' +
      '.tbx.arr-top::before   {bottom:-6px;left:20px;border-top:none;   border-left:none;}' +
      '.tbx.arr-none::before  {display:none;}' +

      /* Text */
      '.tbx h4{margin:0 0 7px;font-size:13px;color:#00c8ff;letter-spacing:.5px;font-weight:700;line-height:1.3;}' +
      '.tbx p {margin:0;font-size:12px;color:#6a8a9a;line-height:1.8;}' +
      '.tbx p b{color:#b8d8e8;}' +

      /* Step badge */
      '.tbx-badge{' +
        'display:inline-block;font-family:"Share Tech Mono",monospace;' +
        'font-size:9px;color:#2e4558;letter-spacing:.8px;' +
        'background:rgba(0,200,255,0.05);border:1px solid #1a2535;' +
        'border-radius:3px;padding:1px 6px;margin-bottom:7px;' +
      '}' +

      /* Footer */
      '.tbx-foot{' +
        'display:flex;justify-content:space-between;align-items:center;' +
        'margin-top:12px;padding-top:10px;border-top:1px solid #142030;gap:8px;' +
      '}' +
      '.tbx-meta{display:flex;align-items:center;gap:7px;flex-shrink:0;}' +
      '.tbx-dots{display:flex;gap:3px;flex-wrap:wrap;max-width:80px;}' +
      '.td{width:5px;height:5px;border-radius:50%;background:#142030;flex-shrink:0;}' +
      '.td.on {background:#00c8ff;box-shadow:0 0 5px #00c8ff;}' +
      '.td.ok {background:rgba(0,200,255,.35);}' +
      '.tbx-prog{font-size:10px;color:#2e4558;font-family:"Share Tech Mono",monospace;white-space:nowrap;}' +

      /* Buttons */
      '.tbx-acts{display:flex;gap:6px;flex-shrink:0;}' +
      '.tbx-btn{' +
        'padding:5px 11px;border-radius:5px;font-size:11px;font-weight:700;' +
        'cursor:pointer;font-family:inherit;transition:all .18s;white-space:nowrap;' +
        'touch-action:manipulation;min-height:32px;border:none;' +
      '}' +
      '.t-sk{background:transparent;border:1px solid #1a2535!important;color:#3a5468;}' +
      '.t-sk:hover,.t-sk:active{border-color:#ff3a3a!important;color:#ff3a3a;}' +
      '.t-nx{background:rgba(0,200,255,.1);border:1px solid #00c8ff!important;color:#00c8ff;}' +
      '.t-nx:hover,.t-nx:active{background:rgba(0,200,255,.2);}' +
      '.t-dn{background:rgba(0,230,118,.1);border:1px solid #00e676!important;color:#00e676;}' +
      '.t-dn:hover,.t-dn:active{background:rgba(0,230,118,.2);}' +
      '.t-bk{background:rgba(255,255,255,.04);border:1px solid #1a2535!important;color:#4a6a7a;}' +
      '.t-bk:hover{background:rgba(255,255,255,.08);}' +

      /* Progress bar */
      '.tbx-pbar{' +
        'height:2px;background:#0e1820;border-radius:1px;margin-top:10px;overflow:hidden;' +
      '}' +
      '.tbx-pfill{' +
        'height:100%;background:linear-gradient(90deg,#00c8ff,#00e676);' +
        'border-radius:1px;transition:width .35s ease;' +
      '}' +

      /* Relaunch button */
      '.t-qbtn{' +
        'position:fixed;bottom:20px;left:20px;z-index:9700;' +
        'width:34px;height:34px;border-radius:50%;' +
        'background:rgba(0,200,255,.08);border:1px solid rgba(0,200,255,.3);' +
        'color:#00c8ff;font-size:15px;font-weight:700;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;' +
        'opacity:.5;transition:all .2s;touch-action:manipulation;' +
      '}' +
      '.t-qbtn:hover,.t-qbtn:active{opacity:1;background:rgba(0,200,255,.18);}' +

      /* Entry animation */
      '@keyframes _tIn{' +
        'from{opacity:0;transform:scale(.93) translateY(-5px);}' +
        'to  {opacity:1;transform:scale(1)   translateY(0);}' +
      '}' +

      /* Mobile: full-width bottom-sheet */
      '@media(max-width:600px){' +
        '.thl{display:none!important;}' +
        '.t-pulse{outline:2.5px solid #00c8ff!important;outline-offset:4px!important;' +
          'border-radius:5px;animation:_tPulse 1s ease-in-out infinite!important;' +
          'position:relative;z-index:500;}' +
        '@keyframes _tPulse{0%,100%{outline-color:rgba(0,200,255,.9);}' +
          '50%{outline-color:rgba(0,200,255,.3);}}' +
        '.tbx{' +
          'width:calc(100vw - 16px)!important;' +
          'left:8px!important;' +
          'border-radius:12px!important;' +
          'max-height:55vh;padding:16px 16px 20px;' +
        '}' +
        '.tbx h4{font-size:14px;}' +
        '.tbx p{font-size:13px;}' +
        '.tbx-btn{padding:8px 14px;font-size:12px;min-height:38px;}' +
      '}';

    document.head.appendChild(s);
  }

  /* ── State ───────────────────────────────────────────────────────── */
  var curIdx = 0, hl = null, bx = null, resizeTimer = null;

  function clearPulse() {
    if (window._tPulseEl) {
      window._tPulseEl.classList.remove('t-pulse');
      window._tPulseEl = null;
    }
  }

  /* ── Mobile scroll helper ────────────────────────────────────────── */
  function scrollToElMob(el, cb) {
    var rect   = el.getBoundingClientRect();
    var target = rect.top + window.pageYOffset
                 - window.innerHeight / 2 + rect.height / 2;
    target = Math.max(0, target);
    var bOv = document.body.style.overflow;
    var hOv = document.documentElement.style.overflow;
    document.body.style.overflow            = 'auto';
    document.documentElement.style.overflow = 'auto';
    window.scrollTo({ top: target, behavior: 'smooth' });
    setTimeout(function () {
      document.body.style.overflow            = bOv;
      document.documentElement.style.overflow = hOv;
      cb();
    }, 420);
  }

  /* ── Mobile position ─────────────────────────────────────────────── */
  function calcPosMob(el) {
    var r   = el.getBoundingClientRect();
    var vh  = window.innerHeight;
    var BH  = 260, GAP = 10;
    var top, arrow;
    if ((vh - r.bottom - GAP) >= BH || (vh - r.bottom) >= r.top) {
      top = r.bottom + GAP; arrow = 'bottom';
    } else {
      top = r.top - BH - GAP; arrow = 'top';
    }
    top = Math.max(8, Math.min(top, vh - BH - 8));
    return { top: top, left: 8, arrow: arrow };
  }

  /* ── Desktop position — picks side with most space ───────────────── */
  function calcPos(r, preferred) {
    var BW = 300, BH = 260, GAP = 14, SAFE = 8;
    var vw = window.innerWidth, vh = window.innerHeight;
    var spR = vw - r.right  - GAP;
    var spL = r.left        - GAP;
    var spB = vh - r.bottom - GAP;
    var spT = r.top         - GAP;

    var side = preferred;
    if (side === 'auto') {
      if      (spR >= BW) side = 'right';
      else if (spL >= BW) side = 'left';
      else if (spB >= BH) side = 'bottom';
      else if (spT >= BH) side = 'top';
      else                 side = 'bottom';
    } else {
      if (side === 'right'  && spR < BW && spL >= BW) side = 'left';
      if (side === 'left'   && spL < BW && spR >= BW) side = 'right';
      if (side === 'bottom' && spB < BH && spT >= BH) side = 'top';
      if (side === 'top'    && spT < BH && spB >= BH) side = 'bottom';
    }

    var top, left;
    if      (side === 'right')  { top = r.top + r.height / 2 - 100; left = r.right + GAP; }
    else if (side === 'left')   { top = r.top + r.height / 2 - 100; left = r.left - BW - GAP; }
    else if (side === 'bottom') { top = r.bottom + GAP;              left = r.left; }
    else                         { top = r.top - BH - GAP;           left = r.left; }

    var rawTop = top, rawLeft = left;
    top  = Math.max(SAFE, Math.min(top,  vh - BH - SAFE));
    left = Math.max(SAFE, Math.min(left, vw - BW - SAFE));

    var arrow = side;
    if (Math.abs(top  - rawTop)  > 50) arrow = 'none';
    if (Math.abs(left - rawLeft) > 50) arrow = 'none';

    return { top: top, left: left, arrow: arrow };
  }

  /* ── Render one step ─────────────────────────────────────────────── */
  function render(idx, el) {
    if (hl) { hl.remove(); hl = null; }
    if (bx) { bx.remove(); bx = null; }
    clearPulse();

    var st      = STEPS[idx];
    var r       = el.getBoundingClientRect();
    var pad     = 7;
    var last    = (idx === STEPS.length - 1);
    var isMob   = window.innerWidth <= 600;
    var pctFill = Math.round((idx + 1) / STEPS.length * 100);

    /* Highlight */
    if (isMob) {
      el.classList.add('t-pulse');
      window._tPulseEl = el;
    } else {
      hl = document.createElement('div');
      hl.className = 'thl';
      hl.style.cssText =
        'top:'    + (r.top    - pad) + 'px;' +
        'left:'   + (r.left   - pad) + 'px;' +
        'width:'  + (r.width  + pad * 2) + 'px;' +
        'height:' + (r.height + pad * 2) + 'px;';
      document.body.appendChild(hl);
    }

    /* Dots */
    var dots = STEPS.map(function (_, j) {
      return '<div class="td' +
        (j < idx  ? ' ok' : '') +
        (j === idx ? ' on' : '') +
        '"></div>';
    }).join('');

    /* Bubble */
    bx = document.createElement('div');
    var pos = isMob ? calcPosMob(el) : calcPos(r, st.pos);
    bx.className  = 'tbx arr-' + pos.arrow;
    bx.style.top  = pos.top  + 'px';
    bx.style.left = pos.left + 'px';

    bx.innerHTML =
      '<div class="tbx-badge">PASO ' + (idx + 1) + ' / ' + STEPS.length + '</div>' +
      '<h4>' + st.title + '</h4>' +
      '<p>'  + st.body  + '</p>' +
      '<div class="tbx-pbar"><div class="tbx-pfill" style="width:' + pctFill + '%"></div></div>' +
      '<div class="tbx-foot">' +
        '<div class="tbx-meta">' +
          '<div class="tbx-dots">' + dots + '</div>' +
          '<span class="tbx-prog">' + (idx + 1) + '/' + STEPS.length + '</span>' +
        '</div>' +
        '<div class="tbx-acts">' +
          /* Botón Anterior — solo si no es el primero */
          (idx > 0 ? '<button class="tbx-btn t-bk" id="_tPrev">← Ant.</button>' : '') +
          /* Botón Saltar — solo si no es el último */
          (!last ? '<button class="tbx-btn t-sk" id="_tSkip">Saltar</button>' : '') +
          /* Siguiente / Listo */
          '<button class="tbx-btn ' + (last ? 't-dn' : 't-nx') + '" id="_tNext">' +
            (last ? 'Listo ✓' : 'Siguiente →') +
          '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(bx);

    /* Event listeners */
    document.getElementById('_tNext').addEventListener('click', function () { show(idx + 1); });
    var prevBtn = document.getElementById('_tPrev');
    if (prevBtn) prevBtn.addEventListener('click', function () { show(idx - 1); });
    var skipBtn = document.getElementById('_tSkip');
    if (skipBtn) skipBtn.addEventListener('click', done);
  }

  /* ── Show: scroll if needed, then render ─────────────────────────── */
  function show(n) {
    curIdx = n;
    if (n >= STEPS.length) { done(); return; }
    if (n < 0) { n = 0; curIdx = 0; }

    var st = STEPS[n];
    var el = document.querySelector(st.sel);
    if (!el) { show(n + 1); return; }   // elemento no existe → saltar

    var r      = el.getBoundingClientRect();
    var inView = r.top >= 0 && r.bottom <= window.innerHeight &&
                 r.left >= 0 && r.right  <= window.innerWidth;
    var isMob  = window.innerWidth <= 600;

    if (isMob) {
      scrollToElMob(el, function () { render(n, el); });
    } else if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { render(n, el); }, 440);
    } else {
      render(n, el);
    }
  }

  /* ── Done ────────────────────────────────────────────────────────── */
  function done() {
    if (hl) { hl.remove(); hl = null; }
    if (bx) { bx.remove(); bx = null; }
    clearPulse();
    localStorage.setItem(KEY, '1');
    addQ();
  }

  /* ── Botón ? para relanzar ───────────────────────────────────────── */
  function addQ() {
    if (document.querySelector('.t-qbtn')) return;
    var q = document.createElement('button');
    q.className   = 't-qbtn';
    q.title       = 'Ver tutorial de nuevo';
    q.textContent = '?';
    q.addEventListener('click', function () {
      q.remove();
      localStorage.removeItem(KEY);
      window._startTour();
    });
    document.body.appendChild(q);
  }

  /* ── Resize: re-render step actual ──────────────────────────────── */
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!hl && !bx) return;
      var st = STEPS[curIdx];
      var el = st && document.querySelector(st.sel);
      if (el) render(curIdx, el);
    }, 160);
  });

  /* ── API pública ─────────────────────────────────────────────────── */
  window._startTour = function () {
    injectCSS();

    // Limpiar versión anterior del tour (v7, v8 sin sufijo)
    ['ssip_tour_v3', 'ssip_tour_v8'].forEach(function (k) {
      localStorage.removeItem(k);
    });

    if (localStorage.getItem(KEY)) { addQ(); return; }
    curIdx = 0;

    // Esperar primer interacción del usuario (o 10s timeout)
    var started = false;
    function onFirst() {
      if (started) return;
      started = true;
      document.removeEventListener('click',      onFirst);
      document.removeEventListener('keydown',    onFirst);
      document.removeEventListener('touchstart', onFirst);
      setTimeout(function () { show(0); }, 260);
    }
    document.addEventListener('click',      onFirst);
    document.addEventListener('keydown',    onFirst);
    document.addEventListener('touchstart', onFirst, { passive: true });
    // Auto-inicio si el usuario no interactúa
    setTimeout(function () { if (!started) { started = true; show(0); } }, 10000);
  };

})();