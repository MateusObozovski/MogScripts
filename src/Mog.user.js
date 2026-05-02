// ==UserScript==
// @name         Millennium
// @version      0.8.0
// @description  Toolkit pessoal para Tribal Wars
// @match        https://*.tribalwars.com.br/game.php?*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/MateusObozovski/MogScripts/refs/heads/claude/tribal-wars-bot-XMdg5/dist/Mog.user.js
// @downloadURL  https://raw.githubusercontent.com/MateusObozovski/MogScripts/refs/heads/claude/tribal-wars-bot-XMdg5/dist/Mog.user.js
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  // ============================================================
  // CAPTCHA GUARD (LITE) — roda em TODA screen do TW.
  // ============================================================
  // O bot pesado só inicializa em screen=storage (early-return mais abaixo).
  // Mas a detecção de captcha precisa rodar em qualquer aba do jogo: senão a
  // aba A onde o captcha apareceu fica omissa e a aba B (storage) continua
  // disparando requests até receber resposta com marcador. Aqui montamos um
  // detector mínimo + canal cross-tab + logout robusto que valem pra todas.

  const GLOBAL_CAPTCHA_KEY = 'mog_captcha_global_v1';
  const CAPTCHA_CHANNEL_NAME = 'mog-captcha-v1';
  const TAB_ID = Math.random().toString(36).slice(2, 10);

  let captchaHandled = false;       // garante trip() único por aba
  let logoutInFlight = false;       // anti-loop de redirect
  let captchaGraceTimer = null;     // timer da carência pós-reativação
  let captchaGraceUntil = 0;        // ts quando a carência expira
  let graceCountdownInterval = null;
  const GRACE_DEFAULT_MS = 60000;
  const extraTripHandlers = [];     // bot full registra hooks de limpeza aqui
  const reactivateHandlers = [];    // bot full registra hooks de reativação aqui

  let captchaChannel = null;
  try { captchaChannel = new BroadcastChannel(CAPTCHA_CHANNEL_NAME); } catch {}

  // Marcadores típicos do hCaptcha/botprotection no TW
  const CAPTCHA_DOM_SELECTORS = [
    '[id*="botprotect"]',
    '[id*="bot_check"]',
    '[id*="botcheck"]',
    '[class*="botprotect"]',
    '[id*="hcaptcha"]:not([style*="display: none"])',
    'iframe[src*="hcaptcha.com"]',
  ];
  // Estritas pra evitar false-positive em comentários inocentes do TW
  const CAPTCHA_HTML_PATTERNS = [
    /bot_protection_active/i,
    /screen=bot_protection/i,
    /popup_box_bot_protection/i,
    /class\s*=\s*["'][^"']*botprotect/i,
    /id\s*=\s*["'][^"']*botcheck/i,
    /\bh-captcha\b/i,
    /hcaptcha\.com\/captcha/i,
  ];
  const CAPTCHA_URL_PATTERNS = [
    /screen=bot_protection/i,
    /botprotection/i,
  ];

  function isHcaptchaIframeVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    if (rect.width === 0 && rect.height === 0) return false;
    const style = unsafeWindow.getComputedStyle?.(el);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    return true;
  }

  function checkDomForCaptcha() {
    if (!document.body) return null;
    for (const sel of CAPTCHA_DOM_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.tagName === 'IFRAME' && !isHcaptchaIframeVisible(el)) continue;
      return `DOM: ${sel}`;
    }
    return null;
  }

  function checkUrlForCaptcha() {
    const url = unsafeWindow.location?.href || '';
    for (const re of CAPTCHA_URL_PATTERNS) {
      if (re.test(url)) return `URL: ${url}`;
    }
    return null;
  }

  function checkResponseForCaptcha(text, url) {
    if (!text) return null;
    const sample = text.slice(0, 5000);
    for (const re of CAPTCHA_HTML_PATTERNS) {
      if (re.test(sample)) return `RESP ${url}: ${re}`;
    }
    return null;
  }

  function escapeHtmlForBanner(s) {
    return String(s).replace(/[&<>"]/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;',
    }[c]));
  }

  function showCaptchaBanner(reason, onReactivate) {
    if (!document.body) {
      // body ainda não pronto — adia até DOMContentLoaded
      const retry = () => showCaptchaBanner(reason, onReactivate);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', retry, { once: true });
      } else {
        setTimeout(retry, 50);
      }
      return;
    }
    if (document.getElementById('mog-captcha-banner')) return;
    const div = document.createElement('div');
    div.id = 'mog-captcha-banner';
    div.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:rgba(120,15,15,0.96)',
      'color:#fff', 'font-family:system-ui,sans-serif',
      'display:flex', 'align-items:center', 'justify-content:center',
      'flex-direction:column', 'gap:18px', 'padding:40px',
      'text-align:center',
    ].join(';');
    div.innerHTML = `
      <div style="font-size:56px;line-height:1;">🚨</div>
      <div style="font-size:24px;font-weight:700;letter-spacing:0.5px;">CAPTCHA DETECTADO</div>
      <div style="font-size:14px;max-width:520px;line-height:1.5;color:#ffe6e6;">
        O Tribal Wars solicitou verificação humana. Pra evitar banimento, o bot foi
        desligado e o jogo será deslogado em instantes.<br><br>
        Quando voltar a jogar, faça login novamente e clique abaixo pra reativar o bot.
      </div>
      <button id="mog-captcha-reactivate" style="
        background:#fff;color:#7a1a1a;border:none;
        padding:12px 24px;border-radius:6px;
        font-size:13px;font-weight:700;cursor:pointer;
        letter-spacing:0.4px;text-transform:uppercase;
        transition:filter 0.15s;
      ">✓ Já estou logado, reativar bot</button>
      <div style="font-size:11px;color:#ffaaaa;font-family:monospace;opacity:0.7;">
        gatilho: ${escapeHtmlForBanner(reason)}
      </div>
    `;
    document.body.appendChild(div);
    const btn = div.querySelector('#mog-captcha-reactivate');
    if (btn && typeof onReactivate === 'function') {
      btn.addEventListener('click', () => {
        try { onReactivate(); } catch {}
        div.remove();
      });
    }
  }

  function readGlobalTrip() {
    try {
      const raw = (typeof GM_getValue === 'function') ? GM_getValue(GLOBAL_CAPTCHA_KEY, null) : null;
      if (!raw) return null;
      return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch { return null; }
  }
  function writeGlobalTrip(reason) {
    try {
      if (typeof GM_setValue !== 'function') return;
      GM_setValue(GLOBAL_CAPTCHA_KEY, JSON.stringify({
        trippedAt: Date.now(), reason: String(reason || ''), sourceTab: TAB_ID,
      }));
    } catch {}
  }
  function clearGlobalTrip() {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(GLOBAL_CAPTCHA_KEY);
      else if (typeof GM_setValue === 'function') GM_setValue(GLOBAL_CAPTCHA_KEY, '');
    } catch {}
  }

  // ----- carência pós-reativação -----
  // Quando o user clica "reativar" depois de logar de volta, ele precisa de
  // tempo pra resolver o captcha do TW (que está na tela). Durante a carência
  // o guard fica silencioso (captchaHandled=true) — não trippa nem desloga.
  function enterGracePeriod(durationMs) {
    const ms = durationMs || GRACE_DEFAULT_MS;
    captchaHandled = true;       // silencia detecção
    logoutInFlight = false;
    captchaGraceUntil = Date.now() + ms;
    if (captchaGraceTimer) clearTimeout(captchaGraceTimer);
    captchaGraceTimer = setTimeout(exitGracePeriod, ms);
    showGraceIndicator();
  }

  function extendGracePeriod(extraMs) {
    const add = extraMs || GRACE_DEFAULT_MS;
    captchaGraceUntil = (captchaGraceUntil || Date.now()) + add;
    if (captchaGraceTimer) clearTimeout(captchaGraceTimer);
    captchaGraceTimer = setTimeout(exitGracePeriod, Math.max(0, captchaGraceUntil - Date.now()));
    updateGraceIndicator();
  }

  function exitGracePeriod() {
    captchaHandled = false;
    if (captchaGraceTimer) { clearTimeout(captchaGraceTimer); captchaGraceTimer = null; }
    captchaGraceUntil = 0;
    if (graceCountdownInterval) { clearInterval(graceCountdownInterval); graceCountdownInterval = null; }
    const ind = document.getElementById('mog-captcha-grace');
    if (ind) ind.remove();
  }

  function showGraceIndicator() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showGraceIndicator, { once: true });
      return;
    }
    const old = document.getElementById('mog-captcha-grace');
    if (old) old.remove();
    const div = document.createElement('div');
    div.id = 'mog-captcha-grace';
    div.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483646',
      'background:rgba(120,15,15,0.92)', 'color:#fff',
      'padding:10px 14px', 'border-radius:6px',
      'font-family:system-ui,sans-serif', 'font-size:12px',
      'display:flex', 'align-items:center', 'gap:10px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
    ].join(';');
    div.innerHTML = `
      <span>⏳ Resolva o captcha — monitor pausado por <span id="mog-grace-count">60</span>s</span>
      <button id="mog-grace-extend" style="
        background:#fff;color:#7a1a1a;border:none;padding:4px 8px;
        border-radius:3px;font-size:11px;font-weight:700;cursor:pointer;
      ">+60s</button>
      <button id="mog-grace-done" style="
        background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.5);
        padding:4px 8px;border-radius:3px;font-size:11px;font-weight:700;cursor:pointer;
      ">Já resolvi</button>
    `;
    document.body.appendChild(div);
    div.querySelector('#mog-grace-extend')?.addEventListener('click', () => extendGracePeriod());
    div.querySelector('#mog-grace-done')?.addEventListener('click', () => exitGracePeriod());
    if (graceCountdownInterval) clearInterval(graceCountdownInterval);
    graceCountdownInterval = setInterval(updateGraceIndicator, 1000);
    updateGraceIndicator();
  }

  function updateGraceIndicator() {
    const span = document.getElementById('mog-grace-count');
    if (!span) return;
    const remaining = Math.max(0, Math.ceil((captchaGraceUntil - Date.now()) / 1000));
    span.textContent = String(remaining);
  }

  // Logout em cascata — primeiro tenta endpoint canônico, depois fallback legado.
  function performLogout() {
    if (logoutInFlight) return;
    logoutInFlight = true;
    const csrf = unsafeWindow.game_data?.csrf || '';
    const primary = csrf ? `/index.php?action=logout&h=${csrf}` : '/index.php?action=logout';

    // Best-effort: dispara request em paralelo (não bloqueia o redirect)
    if (csrf) {
      try {
        fetch(primary, { credentials: 'include', method: 'GET' }).catch(() => {});
      } catch {}
    }

    setTimeout(() => {
      try { unsafeWindow.location.href = primary; } catch {
        try { unsafeWindow.location.replace(primary); } catch {}
      }
    }, 800);

    // Fallback legado: se 2.5s depois ainda estamos em /game.php, força /logout.php
    setTimeout(() => {
      try {
        const path = unsafeWindow.location?.pathname || '';
        if (path.startsWith('/game.php')) {
          unsafeWindow.location.href = '/logout.php';
        }
      } catch {}
    }, 2500);
  }

  function tripCaptcha(reason, opts) {
    if (captchaHandled) return;
    captchaHandled = true;
    const persistGlobal = !opts || opts.persistGlobal !== false;
    const broadcast = !opts || opts.broadcast !== false;
    const doLogout = !opts || opts.doLogout !== false;

    if (persistGlobal) writeGlobalTrip(reason);
    if (broadcast && captchaChannel) {
      try { captchaChannel.postMessage({ type: 'TRIP', reason, ts: Date.now(), sourceTab: TAB_ID }); } catch {}
    }

    // hooks do bot full (limpeza de state, timers, log) — best-effort, não pode bloquear
    for (const fn of extraTripHandlers) {
      try { fn(reason); } catch {}
    }

    showCaptchaBanner(reason, () => {
      // reativação local: apaga GM global, broadcast pra outras abas, hooks
      // do bot full, e ENTRA EM CARÊNCIA. Durante a carência o monitor fica
      // silencioso pra dar tempo do user resolver o captcha do TW que está na tela.
      clearGlobalTrip();
      if (captchaChannel) {
        try { captchaChannel.postMessage({ type: 'REACTIVATE', ts: Date.now(), sourceTab: TAB_ID }); } catch {}
      }
      for (const fn of reactivateHandlers) { try { fn(); } catch {} }
      enterGracePeriod();
    });

    if (doLogout) {
      setTimeout(performLogout, 1500);
    }
  }

  function handleRemoteReactivate() {
    const banner = document.getElementById('mog-captcha-banner');
    if (banner) banner.remove();
    for (const fn of reactivateHandlers) { try { fn(); } catch {} }
    enterGracePeriod();
  }

  function setupCrossTabCaptcha() {
    if (captchaChannel) {
      captchaChannel.addEventListener('message', (ev) => {
        const data = ev?.data || {};
        if (data.sourceTab === TAB_ID) return;
        if (data.type === 'TRIP') {
          // outra aba detectou — entra em modo trippado, mas não rebroadcast nem repersist.
          // Logout opcional: se a outra aba já está fazendo, esta também faz pra garantir.
          tripCaptcha('OUTRA ABA: ' + (data.reason || ''), {
            persistGlobal: false, broadcast: false, doLogout: true,
          });
        } else if (data.type === 'REACTIVATE') {
          handleRemoteReactivate();
        }
      });
    }

    // Polling fallback: 3s. Detecta GM key escrita por aba que não tem BroadcastChannel.
    setInterval(() => {
      const g = readGlobalTrip();
      if (captchaHandled) {
        // se trippado mas global foi apagada → outra aba reativou
        if (!g) handleRemoteReactivate();
        return;
      }
      if (g && g.trippedAt) {
        tripCaptcha('GLOBAL: ' + (g.reason || ''), {
          persistGlobal: false, broadcast: false, doLogout: true,
        });
      }
    }, 3000);
  }

  function installFetchWrapper() {
    const orig = unsafeWindow.fetch?.bind(unsafeWindow);
    if (!orig) return;
    unsafeWindow.fetch = async function (...args) {
      const res = await orig(...args);
      if (captchaHandled) return res;
      try {
        const reqUrl = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
        const isAbsolute = /^https?:\/\//.test(reqUrl);
        const isSameOrigin = !isAbsolute || reqUrl.includes('tribalwars.com.br');
        if (reqUrl && isSameOrigin) {
          const clone = res.clone();
          const ct = clone.headers.get('content-type') || '';
          if (/text\/html|application\/json|text\/plain/i.test(ct)) {
            const text = await clone.text();
            const hit = checkResponseForCaptcha(text, reqUrl);
            if (hit) tripCaptcha(hit);
          }
        }
      } catch {}
      return res;
    };
  }

  function installXhrWrapper() {
    const XHR = unsafeWindow.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try { this._mogUrl = url; } catch {}
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        this.addEventListener('readystatechange', () => {
          if (this.readyState !== 4) return;
          if (captchaHandled) return;
          try {
            const url = String(this._mogUrl || '');
            if (!url) return;
            const isAbsolute = /^https?:\/\//.test(url);
            const isSameOrigin = !isAbsolute || url.includes('tribalwars.com.br');
            if (!isSameOrigin) return;
            const ct = this.getResponseHeader('content-type') || '';
            if (!/text\/html|application\/json|text\/plain/i.test(ct)) return;
            // só lê se tipo string (responseType vazio ou 'text')
            const rt = this.responseType;
            if (rt && rt !== 'text') return;
            const text = this.responseText || '';
            const hit = checkResponseForCaptcha(text, url);
            if (hit) tripCaptcha(hit);
          } catch {}
        });
      } catch {}
      return origSend.apply(this, args);
    };
  }

  function startCaptchaWatcher() {
    // 1. observer DOM (espera body se necessário)
    const startObserver = () => {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
        return;
      }
      const obs = new MutationObserver(() => {
        if (captchaHandled) return;
        const hit = checkDomForCaptcha();
        if (hit) tripCaptcha(hit);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    };
    startObserver();

    // 2. URL agora
    const urlHit = checkUrlForCaptcha();
    if (urlHit) { tripCaptcha(urlHit); return; }

    // 3. DOM agora (se body já pronto)
    const domHit = checkDomForCaptcha();
    if (domHit) { tripCaptcha(domHit); return; }

    // 4. wrappers
    installFetchWrapper();
    installXhrWrapper();

    // 5. URL polling (caso navegação interna do TW)
    setInterval(() => {
      if (captchaHandled) return;
      const u = checkUrlForCaptcha();
      if (u) tripCaptcha(u);
    }, 5000);
  }

  // boot do guard lite
  setupCrossTabCaptcha();
  startCaptchaWatcher();

  // se já existe flag global persistida (de aba anterior ou reload), entra em modo trippado
  // sem rebroadcast/relogout (já feito pela aba que originou). Só mostra banner.
  {
    const initial = readGlobalTrip();
    if (initial && initial.trippedAt) {
      captchaHandled = true;
      const reason = 'flag persistida' + (initial.reason ? ' — ' + initial.reason : '');
      showCaptchaBanner(reason, () => {
        clearGlobalTrip();
        if (captchaChannel) {
          try { captchaChannel.postMessage({ type: 'REACTIVATE', ts: Date.now(), sourceTab: TAB_ID }); } catch {}
        }
        for (const fn of reactivateHandlers) { try { fn(); } catch {} }
        enterGracePeriod();
      });
    }
  }

  // ============================================================
  // EARLY-RETURN: bot pesado só roda em screen=storage
  // ============================================================
  if (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data?.screen !== 'storage') {
    return;
  }

  const VERSION = '0.8.0';
  const STORAGE_KEY = 'mog_state_v1';

  const UNITS = [
    { id: 'spear',    name: 'Lanceiro',         building: 'Quartel'  },
    { id: 'sword',    name: 'Espadachim',       building: 'Quartel'  },
    { id: 'axe',      name: 'Bárbaro',          building: 'Quartel'  },
    { id: 'archer',   name: 'Arqueiro',         building: 'Quartel'  },
    { id: 'spy',      name: 'Explorador',       building: 'Estábulo' },
    { id: 'light',    name: 'Cavalaria Leve',   building: 'Estábulo' },
    { id: 'marcher',  name: 'Arq. à Cavalo',    building: 'Estábulo' },
    { id: 'heavy',    name: 'Cavalaria Pesada', building: 'Estábulo' },
    { id: 'ram',      name: 'Aríete',           building: 'Oficina'  },
    { id: 'catapult', name: 'Catapulta',        building: 'Oficina'  },
  ];

  const BUILDINGS = ['Quartel', 'Estábulo', 'Oficina'];

  // Lista usada pra comandos (envio de ataque/apoio). Inclui Paladino e Nobre,
  // que NÃO são recrutáveis via train.php mas existem como tropas enviáveis.
  const COMMAND_UNITS = [
    ...UNITS,
    { id: 'knight', name: 'Paladino', building: null },
    { id: 'snob',   name: 'Nobre',    building: null },
  ];

  const GROUP_ALL = { id: 0, name: 'Todos' };

  // Mapa indexado pelo decoder de templates de construção (formato `bgAA...`).
  // Cada índice = building key interna do TW (compatível com URL de upgrade).
  // Ordem precisa ser validada com template conhecido — ver Apêndice A do CLAUDE.md.
  // Validado via snippet de screen=main: indices 0–16 mapeiam para as 17 chaves reais
  // do br142. church/church_f não aparecem neste mundo — índices 4–5 são watchtower/snob.
  const BUILDING_KEYS = [
    'main',        // 0  Edifício Principal
    'barracks',    // 1  Quartel
    'stable',      // 2  Estábulo
    'garage',      // 3  Oficina
    'watchtower',  // 4  Torre de Vigia
    'snob',        // 5  Academia
    'smith',       // 6  Ferreiro
    'place',       // 7  Praça de Reunião
    'statue',      // 8  Estátua
    'market',      // 9  Mercado
    'wood',        // 10 Bosque
    'stone',       // 11 Poço de Argila
    'iron',        // 12 Mina de Ferro
    'farm',        // 13 Fazenda
    'storage',     // 14 Armazém
    'hide',        // 15 Esconderijo
    'wall',        // 16 Muralha
  ];

  const BUILDING_DISPLAY = {
    main:        { label: 'Edifício Principal',  icon: '🏛' },
    barracks:    { label: 'Quartel',             icon: '⚔' },
    stable:      { label: 'Estábulo',            icon: '🐎' },
    garage:      { label: 'Oficina',             icon: '⚙' },
    watchtower:  { label: 'Torre de Vigia',      icon: '👁' },
    snob:        { label: 'Academia',            icon: '🎓' },
    smith:       { label: 'Ferreiro',            icon: '🔨' },
    place:       { label: 'Praça de Reunião',    icon: '🏟' },
    statue:      { label: 'Estátua',             icon: '🗿' },
    market:      { label: 'Mercado',             icon: '🛒' },
    wood:        { label: 'Bosque',              icon: '🌲' },
    stone:       { label: 'Poço de Argila',      icon: '🧱' },
    iron:        { label: 'Mina de Ferro',       icon: '⛏' },
    farm:        { label: 'Fazenda',             icon: '🌾' },
    storage:     { label: 'Armazém',             icon: '📦' },
    hide:        { label: 'Esconderijo',         icon: '🕳' },
    wall:        { label: 'Muralha',             icon: '🛡' },
    // mundos com religião — podem aparecer em templates importados de outros mundos
    church:      { label: 'Igreja',              icon: '✝' },
    church_f:    { label: 'Primeira Igreja',     icon: '✝' },
  };

  function makeProfile(overrides = {}) {
    return {
      id: overrides.id || `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'Novo modelo',
      enabled: overrides.enabled ?? false,
      groupId: overrides.groupId ?? 0,
      intervalMin: overrides.intervalMin ?? 5,
      intervalMax: overrides.intervalMax ?? 12,
      units: overrides.units || Object.fromEntries(UNITS.map(u => [u.id, {
        enabled: false,
        target: 0,
      }])),
      buildings: overrides.buildings || Object.fromEntries(BUILDINGS.map(b => [b, {
        perQueue: 0,
        maxQueues: 0,
      }])),
      rrCursor: overrides.rrCursor || Object.fromEntries(BUILDINGS.map(b => [b, 0])),
      nextRunAt: 0,
    };
  }

  function makeBuildTemplate(overrides = {}) {
    return {
      id: overrides.id || `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'Modelo importado',
      raw: overrides.raw || '',
      createdAt: overrides.createdAt || Date.now(),
      steps: Array.isArray(overrides.steps) ? overrides.steps : [],
    };
  }

  function makeBuildProfile(overrides = {}) {
    return {
      id: overrides.id || `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'Novo modelo',
      enabled: overrides.enabled ?? false,
      groupId: overrides.groupId ?? 0,
      templateId: overrides.templateId || null,
      intervalMin: overrides.intervalMin ?? 5,
      intervalMax: overrides.intervalMax ?? 7,
      nextRunAt: overrides.nextRunAt || 0,
      running: null,
    };
  }

  function makeOperation(overrides = {}) {
    return {
      id: overrides.id || `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'Nova operação',
      status: overrides.status || 'draft',
      step: overrides.step ?? 1,
      createdAt: overrides.createdAt || Date.now(),
      activatedAt: overrides.activatedAt || 0,
      finishedAt: overrides.finishedAt || 0,
      // Padrão de chegada usado quando o usuário extrai coordenadas no passo 1.
      // datetime: Unix ms com segundos truncados (.000); ms: 0..999.
      defaultArrival: overrides.defaultArrival ?? { datetime: 0, ms: 0 },
      targets: overrides.targets || [],
      sourceGroups: overrides.sourceGroups || [],
      commands: overrides.commands || [],
      unreachable: overrides.unreachable || [],
    };
  }

  function makeTarget(overrides = {}) {
    return {
      id: overrides.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      coords: overrides.coords || '',
      x: overrides.x ?? 0,
      y: overrides.y ?? 0,
      arrivalAt: overrides.arrivalAt ?? 0,
      arrivalRandom: overrides.arrivalRandom ?? null,
      counts: {
        attack: overrides.counts?.attack ?? 1,
        support: overrides.counts?.support ?? 0,
        noble: overrides.counts?.noble ?? 0,
      },
      notes: overrides.notes || '',
    };
  }

  const CATAPULT_TARGETS = [
    'random', 'main', 'barracks', 'stable', 'garage', 'snob', 'smith',
    'place', 'statue', 'market', 'wood', 'stone', 'iron', 'farm',
    'storage', 'hide', 'wall', 'church',
  ];

  function makeWave(overrides = {}) {
    const baseUnits = Object.fromEntries(COMMAND_UNITS.map(u => [u.id, {
      enabled: false,
      mode: 'all',          // 'all' | 'percent' | 'count'
      value: 0,
    }]));
    return {
      id: overrides.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      units: overrides.units ? { ...baseUnits, ...overrides.units } : baseUnits,
    };
  }

  function makeAttackModel(overrides = {}) {
    // migração transparente: se overrides tem .units (formato antigo), envolve em waves[0]
    let waves = overrides.waves;
    if (!waves) {
      waves = overrides.units
        ? [makeWave({ units: overrides.units })]
        : [makeWave()];
    } else {
      waves = waves.map(w => makeWave(w));
    }
    return {
      type: overrides.type || 'attack',                 // attack | support
      catapultTarget: overrides.catapultTarget || 'farm',
      // firstMs* mantidos no schema por compat, mas não são mais editáveis na UI nem
      // adicionados ao executeAt. O ms da chegada agora vem de target.arrivalAt direto.
      firstMs: 0,
      firstMsRandom: false,
      firstMsMin: 0,
      firstMsMax: 0,
      waves,
    };
  }

  function makeSourceGroup(overrides = {}) {
    return {
      id: overrides.id || `sg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label: overrides.label || 'Lote',
      rawText: overrides.rawText || '',
      importGroupId: overrides.importGroupId ?? -1,    // -1 = "nenhum", 0 = Todos, >0 = grupo real
      villages: overrides.villages || [],
      model: overrides.model || makeAttackModel(),
      collapsed: overrides.collapsed ?? false,
    };
  }

  // Valores de fallback (mundo "padrão" sem multiplicadores).
  // No mundo real, get_unit_info retorna <speed> já ajustado pelos fatores do mundo,
  // então usamos o valor direto sem nenhum multiplicador adicional.
  const DEFAULT_WORLD_CONFIG = {
    fetchedAt: 0,
    unitSpeed: {
      spear: 18, sword: 22, axe: 18, archer: 18,
      spy: 9, light: 10, marcher: 10, heavy: 11,
      ram: 30, catapult: 30, knight: 10, snob: 35,
    },
    speedFactor: 1,
    unitSpeedFactor: 1,
  };

  const DEFAULT_LATENCY = {
    avgRtt: 0,         // ms (ida+volta)
    avgOneWay: 0,      // ms (uplink estimado: rtt - rttBack, derivado do header Date da resposta)
    avgOffset: 0,      // ms (clock diff: servidor − cliente)
    manualOverride: 0, // ms (se >0, usa esse valor, ignora medição auto)
    measuredAt: 0,     // timestamp da última medição
    samples: 0,        // quantas medições já foram feitas
  };

  const DEFAULT_STATE = {
    enabled: false,
    // Timestamp do último captcha detectado. Quando >0, bot fica em "modo trava":
    // tudo desligado, recovery não re-agenda nada, banner de aviso no painel.
    // Usuário precisa logar manualmente no TW e clicar Ativo no toggle global pra zerar.
    captchaTrippedAt: 0,
    ui: {
      activeSection: 'recruiter',
      expandedProfileId: null,
      panelOpen: false,
      logCollapsed: false,
      sideCollapsed: {},
    },
    recruiter: {
      profiles: [],
      log: [],
    },
    scheduler: {
      operations: [],
      worldConfig: structuredClone(DEFAULT_WORLD_CONFIG),
      latency: structuredClone(DEFAULT_LATENCY),
      log: [],
      ui: { activeOperationId: null, wizardStep: 1 },
    },
    farmer: {
      enabled: false,
      groupId: 0,
      timing: { minMs: 500, maxMs: 1000 },
      cycleMin: 10,
      maxPerBarbarian: 1,
      searchRadius: 10,
      // Raio máximo (campos) entre origem e bárbara no ciclo. Bárbaras fora do
      // alcance de qualquer origem são puladas. 0 = sem limite.
      maxFarmRadius: 15,
      // Janela mínima entre chegadas de farms na mesma bárbara (minutos).
      // Default 10min pra dar tempo da bárbara regenerar saque entre ataques.
      // Aplicado quando conseguimos parsear o horário de chegada dos comandos.
      arrivalWindowMin: 10,
      needsWallBreak: [],
      // threats: ameaças detectadas via relatório de espionagem.
      // Cada entry: { villageId, x, y, coords, wall, units: {spear, sword, ...}, away: {...}, scoutedAt, reportId }
      // Bárbaras com wall>=1 OU qualquer tropa não-zero (units OR away) são bloqueadas pro farm.
      // TTL: entradas com mais de THREAT_TTL_MS são consideradas vencidas (libera farm de novo).
      threats: [],
      log: [],
      ui: { collapsed: {} },
      nextRunAt: 0,
      busy: false,
    },
    builder: {
      enabled: false,
      templates: [],
      profiles: [],
      log: [],
      ui: { expandedProfileId: null, view: 'profiles' },
      busy: false,
      // Cache: detectado no primeiro fetchMainBuilding bem-sucedido. null = ainda não medido.
      premiumDetected: null,
    },
  };

  // ---------- storage ----------
  function loadState() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      return migrateState(parsed);
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function migrateProfile(p) {
    // Se já tem buildings, está no formato novo
    if (p.buildings) return makeProfile(p);

    // Formato antigo: perQueue/maxQueues por unidade. Pega o maior valor por edifício.
    const buildings = Object.fromEntries(BUILDINGS.map(b => [b, { perQueue: 0, maxQueues: 0 }]));
    if (p.units) {
      for (const u of UNITS) {
        const c = p.units[u.id];
        if (!c) continue;
        const b = buildings[u.building];
        if (c.perQueue > b.perQueue) b.perQueue = c.perQueue;
        if (c.maxQueues > b.maxQueues) b.maxQueues = c.maxQueues;
      }
    }
    const newUnits = Object.fromEntries(UNITS.map(u => {
      const old = p.units?.[u.id] || {};
      return [u.id, { enabled: !!old.enabled, target: old.target || 0 }];
    }));
    return makeProfile({
      ...p,
      units: newUnits,
      buildings,
    });
  }

  function migrateSourceGroup(sg) {
    return makeSourceGroup({
      ...sg,
      villages: Array.isArray(sg.villages) ? sg.villages : [],
      model: makeAttackModel(sg.model || {}),     // normaliza units/waves
    });
  }

  function migrateOperation(o) {
    return makeOperation({
      ...o,
      defaultArrival: o.defaultArrival && typeof o.defaultArrival === 'object'
        ? { datetime: o.defaultArrival.datetime || 0, ms: Math.max(0, Math.min(999, o.defaultArrival.ms || 0)) }
        : { datetime: 0, ms: 0 },
      targets: Array.isArray(o.targets) ? o.targets : [],
      sourceGroups: Array.isArray(o.sourceGroups) ? o.sourceGroups.map(migrateSourceGroup) : [],
      commands: Array.isArray(o.commands) ? o.commands : [],
      unreachable: Array.isArray(o.unreachable) ? o.unreachable : [],
    });
  }

  function migrateScheduler(parsed) {
    const base = structuredClone(DEFAULT_STATE.scheduler);
    if (!parsed) return base;
    if (Array.isArray(parsed.operations)) {
      base.operations = parsed.operations.map(migrateOperation);
    }
    if (parsed.worldConfig) {
      base.worldConfig = { ...base.worldConfig, ...parsed.worldConfig };
      // garante que unitSpeed tem todas as chaves esperadas
      base.worldConfig.unitSpeed = { ...DEFAULT_WORLD_CONFIG.unitSpeed, ...(parsed.worldConfig.unitSpeed || {}) };
    }
    if (parsed.latency) {
      base.latency = { ...base.latency, ...parsed.latency };
      // Remove campos de versões antigas que não existem mais no DEFAULT_LATENCY
      delete base.latency.skewHistory;
      delete base.latency.skewMedian;
      delete base.latency.adaptiveComp;
      delete base.latency.extraBuffer;
    }
    if (Array.isArray(parsed.log)) base.log = parsed.log;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    return base;
  }

  function migrateFarmer(parsed) {
    const base = structuredClone(DEFAULT_STATE.farmer);
    if (!parsed) return base;
    base.enabled = !!parsed.enabled;
    base.groupId = Number.isFinite(parsed.groupId) ? parsed.groupId : 0;
    if (parsed.timing) base.timing = { ...base.timing, ...parsed.timing };
    if (Number.isFinite(parsed.cycleMin)) base.cycleMin = parsed.cycleMin;
    if (Number.isFinite(parsed.maxPerBarbarian)) base.maxPerBarbarian = parsed.maxPerBarbarian;
    if (Number.isFinite(parsed.searchRadius)) base.searchRadius = parsed.searchRadius;
    if (Number.isFinite(parsed.maxFarmRadius)) base.maxFarmRadius = parsed.maxFarmRadius;
    if (Number.isFinite(parsed.arrivalWindowMin)) base.arrivalWindowMin = parsed.arrivalWindowMin;
    if (Array.isArray(parsed.needsWallBreak)) base.needsWallBreak = parsed.needsWallBreak;
    if (Array.isArray(parsed.threats)) base.threats = parsed.threats;
    if (Array.isArray(parsed.log)) base.log = parsed.log;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    if (Number.isFinite(parsed.nextRunAt)) base.nextRunAt = parsed.nextRunAt;
    // busy é transitório — limpa no boot pra não travar após reload no meio de um ciclo
    base.busy = false;
    return base;
  }

  function migrateBuilderTemplate(t) {
    return makeBuildTemplate({
      ...t,
      steps: Array.isArray(t.steps) ? t.steps.filter(s => typeof s === 'string') : [],
    });
  }

  function migrateBuilderProfile(p) {
    return makeBuildProfile({
      ...p,
      // running é transitório
      running: null,
    });
  }

  function migrateBuilder(parsed) {
    const base = structuredClone(DEFAULT_STATE.builder);
    if (!parsed) return base;
    base.enabled = !!parsed.enabled;
    if (Array.isArray(parsed.templates)) {
      base.templates = parsed.templates.map(migrateBuilderTemplate);
    }
    if (Array.isArray(parsed.profiles)) {
      base.profiles = parsed.profiles.map(migrateBuilderProfile);
    }
    if (Array.isArray(parsed.log)) base.log = parsed.log;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    if (typeof parsed.premiumDetected === 'boolean') base.premiumDetected = parsed.premiumDetected;
    // busy é transitório — limpa no boot
    base.busy = false;
    return base;
  }

  function migrateState(parsed) {
    const base = structuredClone(DEFAULT_STATE);
    base.enabled = parsed.enabled ?? false;
    if (Number.isFinite(parsed.captchaTrippedAt)) base.captchaTrippedAt = parsed.captchaTrippedAt;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    base.scheduler = migrateScheduler(parsed.scheduler);
    base.farmer = migrateFarmer(parsed.farmer);
    base.builder = migrateBuilder(parsed.builder);

    if (parsed.recruiter?.profiles) {
      base.recruiter.profiles = parsed.recruiter.profiles.map(p => migrateProfile(p));
      base.recruiter.log = Array.isArray(parsed.recruiter.log) ? parsed.recruiter.log : [];
      return base;
    }

    const old = parsed.recruiter;
    if (old && old.units) {
      base.recruiter.profiles = [migrateProfile({
        name: 'Modelo principal',
        enabled: parsed.enabled ?? false,
        groupId: old.groupId ?? 0,
        intervalMin: old.intervalMin ?? 5,
        intervalMax: old.intervalMax ?? 12,
        units: old.units,
      })];
      base.recruiter.log = Array.isArray(old.log) ? old.log : [];
    }
    return base;
  }

  function saveState(s) { GM_setValue(STORAGE_KEY, JSON.stringify(s)); }

  let state = loadState();
  const persist = () => saveState(state);

  // ---------- captcha guard (hooks do bot full) ----------
  // O detector + banner + logout vivem no guard lite no topo do IIFE.
  // Aqui registramos só a limpeza state-aware: parar motores, zerar timers,
  // logar nos buffers do bot, e zerar a flag local na reativação.
  extraTripHandlers.push((reason) => {
    // Captcha pausa motores SEM mexer nas flags `enabled` — preserva a intenção
    // do usuário pra que `resumeFromCaptcha` saiba quem religar.
    state.captchaTrippedAt = Date.now();
    if (state.farmer) {
      state.farmer.busy = false;
      state.farmer.nextRunAt = 0;
    }
    if (Array.isArray(state.recruiter?.profiles)) {
      state.recruiter.profiles.forEach(p => { p.nextRunAt = 0; });
    }
    if (state.builder) {
      state.builder.busy = false;
      if (Array.isArray(state.builder.profiles)) {
        state.builder.profiles.forEach(p => { p.nextRunAt = 0; p.running = null; });
      }
    }
    try { persist(); } catch {}

    // limpa timers (cada engine tem seu Map/var; usar typeof pra tolerar
    // hook rodando antes da inicialização dos motores)
    try {
      if (typeof profileTimers !== 'undefined' && profileTimers?.clear) {
        profileTimers.forEach(t => clearTimeout(t));
        profileTimers.clear();
      }
    } catch {}
    try { if (typeof farmerTimerId !== 'undefined') clearTimeout(farmerTimerId); } catch {}
    try {
      if (typeof commandTimers !== 'undefined' && commandTimers?.clear) {
        commandTimers.forEach(t => clearTimeout(t));
        commandTimers.clear();
      }
    } catch {}
    try {
      if (typeof prepareTimers !== 'undefined' && prepareTimers?.clear) {
        prepareTimers.forEach(t => clearTimeout(t));
        prepareTimers.clear();
      }
    } catch {}
    try {
      if (typeof remeasureTimers !== 'undefined' && remeasureTimers?.clear) {
        remeasureTimers.forEach(t => clearTimeout(t));
        remeasureTimers.clear();
      }
    } catch {}
    try {
      if (typeof builderTimers !== 'undefined' && builderTimers?.clear) {
        builderTimers.forEach(t => clearTimeout(t));
        builderTimers.clear();
      }
    } catch {}

    try {
      const ts = new Date().toLocaleTimeString('pt-BR');
      const entry = `[${ts}] 🚨 CAPTCHA DETECTADO (${reason}) — bot parado e logout disparado.`;
      if (state.recruiter) {
        state.recruiter.log = state.recruiter.log || [];
        state.recruiter.log.unshift(entry);
        state.recruiter.log = state.recruiter.log.slice(0, 200);
      }
      if (state.farmer) {
        state.farmer.log = state.farmer.log || [];
        state.farmer.log.unshift(entry);
        state.farmer.log = state.farmer.log.slice(0, 200);
      }
      if (state.scheduler) {
        state.scheduler.log = state.scheduler.log || [];
        state.scheduler.log.unshift(entry);
        state.scheduler.log = state.scheduler.log.slice(0, 500);
      }
      if (state.builder) {
        state.builder.log = state.builder.log || [];
        state.builder.log.unshift(entry);
        state.builder.log = state.builder.log.slice(0, 200);
      }
      persist();
    } catch {}
  });

  reactivateHandlers.push(() => {
    if (state.captchaTrippedAt) {
      state.captchaTrippedAt = 0;
      try { persist(); } catch {}
    }
    // Re-agenda timers de quem ainda está enabled. Funções podem ainda não
    // estar definidas se reactivate dispara cedo no boot — try/catch tolerante.
    try {
      if (Array.isArray(state.recruiter?.profiles)) {
        state.recruiter.profiles.forEach(p => {
          if (p.enabled && typeof scheduleProfileNext === 'function') scheduleProfileNext(p);
        });
      }
    } catch {}
    try {
      if (state.farmer?.enabled && typeof scheduleFarmerNext === 'function') {
        scheduleFarmerNext();
      }
    } catch {}
    try {
      if (state.builder?.enabled && Array.isArray(state.builder.profiles) && typeof scheduleBuilderProfileNext === 'function') {
        state.builder.profiles.forEach(p => {
          if (p.enabled) scheduleBuilderProfileNext(p);
        });
      }
    } catch {}
  });

  // Compat: se este storage tem flag local persistida (de versão antiga) mas o
  // guard lite não detectou flag global, "promove" pra global pra todas as
  // abas verem. Sem logout (já feito antes do reload).
  if (state.captchaTrippedAt > 0 && !readGlobalTrip()) {
    tripCaptcha('flag local migrada', { doLogout: false });
  }

  // ---------- game api ----------
  const Game = {
    csrf: () => unsafeWindow.game_data?.csrf || '',

    async fetchGroups() {
      const res = await fetch('/game.php?screen=groups&mode=overview&ajax=load_group_menu', {
        credentials: 'include',
        headers: { 'TribalWars-Ajax': '1' },
      });
      const data = await res.json().catch(() => null);
      const groups = data?.response?.result || data?.result || [];
      return groups.map(g => ({ id: Number(g.group_id), name: g.name })).filter(g => g.id);
    },

    async fetchAllVillages() {
      return this._fetchVillagesPaged('');
    },

    async fetchGroupVillages(groupId) {
      if (!groupId) return this.fetchAllVillages();
      return this._fetchVillagesPaged(`&group=${groupId}`);
    },

    async _fetchVillagesPaged(extraQs) {
      // overview_villages é paginado (TW mostra ~30 por página).
      // Itera enquanto a página atual retornar aldeias novas (até 50 páginas como guarda).
      const all = [];
      const seen = new Set();
      for (let page = 0; page < 50; page++) {
        // delay entre páginas (não antes da 1ª) — evita rajada regular detectável como bot.
        if (page > 0) await sleep(randomInRange(400, 900));
        const url = `/game.php?screen=overview_villages&mode=combined${extraQs}&page=${page}`;
        const res = await fetch(url, { credentials: 'include' });
        const html = await res.text();
        const list = parseVillagesFromOverview(html);
        let added = 0;
        for (const v of list) {
          if (seen.has(v.id)) continue;
          seen.add(v.id);
          all.push(v);
          added++;
        }
        if (added === 0) break;     // página vazia ou só duplicatas → fim
      }
      return all;
    },

    async fetchTrainData(villageId) {
      const url = `/game.php?village=${villageId}&screen=train`;
      const res = await fetch(url, { credentials: 'include' });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // Coluna "Na aldeia/total" do tr.row_a, formato "22/1215". Usa o "total" (segundo número)
      // = tropas da aldeia somando as que estão fora — é o que o usuário quer comparar com o alvo.
      const units = {};
      UNITS.forEach(u => {
        const link = doc.querySelector(`a.unit_link[data-unit="${u.id}"]`);
        const row = link?.closest('tr');
        let count = 0;
        if (row) {
          const txt = row.querySelector('td:nth-child(3)')?.textContent || '';
          const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) count = parseInt(m[2], 10);
        }
        units[u.id] = count;
      });

      const queue = parseTrainQueue(doc);
      return { units, queue };
    },

    async submitRecruit(villageId, recruitMap) {
      const url = `/game.php?village=${villageId}&screen=train&ajaxaction=train&mode=train`;
      const body = new URLSearchParams();
      body.append('h', this.csrf());
      Object.entries(recruitMap).forEach(([k, v]) => body.append(`units[${k}]`, String(v)));
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'TribalWars-Ajax': '1',
        },
        body: body.toString(),
      });
      return res.json().catch(() => ({ ok: false }));
    },

    // Lê /interface.php?func=get_unit_info (XML) e get_config (XML).
    // Retorna { unitSpeed: { spear: minPerField, ... }, speedFactor, unitSpeedFactor }
    async fetchWorldConfig() {
      const [unitsXml, worldXml] = await Promise.all([
        fetch('/interface.php?func=get_unit_info').then(r => r.text()),
        fetch('/interface.php?func=get_config').then(r => r.text()),
      ]);
      return parseWorldConfig(unitsXml, worldXml);
    },

    // CSRF dinâmico do passo 1 do envio de comando (screen=place).
    // O nome do input muda a cada sessão; precisamos ler 1x e guardar em cache.
    _placeCsrfCache: null,
    async _readPlaceCsrf(villageId) {
      if (this._placeCsrfCache) return this._placeCsrfCache;
      const url = `/game.php?village=${villageId}&screen=place`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // procura input hidden cujo name não é nenhum dos conhecidos
      const known = new Set(['template_id', 'source_village', 'spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob', 'x', 'y', 'target_type', 'input', 'h']);
      const hidden = [...doc.querySelectorAll('form input[type="hidden"]')];
      for (const i of hidden) {
        if (!i.name || known.has(i.name)) continue;
        this._placeCsrfCache = { name: i.name, value: i.value };
        return this._placeCsrfCache;
      }
      throw new Error('CSRF do screen=place não encontrado');
    },

    // ETAPA 1 do envio: pré-confirmação. Faz POST de try=confirm e retorna os
    // hidden fields (incluindo `ch`) que serão usados no POST final.
    // params: { fromVillageId, x, y, units, type } (apenas 1ª wave aqui)
    async prepareCommand({ fromVillageId, x, y, units, type }) {
      const csrf = await this._readPlaceCsrf(fromVillageId);
      const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

      const body1 = new URLSearchParams();
      body1.append(csrf.name, csrf.value);
      body1.append('template_id', '');
      body1.append('source_village', String(fromVillageId));
      for (const u of UNIT_KEYS) {
        body1.append(u, String(units[u] || 0));
      }
      body1.append('x', String(x));
      body1.append('y', String(y));
      body1.append('target_type', 'coord');
      body1.append('input', '');
      body1.append(type === 'support' ? 'support' : 'attack', type === 'support' ? 'Apoio' : 'Ataque');

      const url1 = `/game.php?village=${fromVillageId}&screen=place&try=confirm`;
      const r1 = await fetch(url1, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body1.toString(),
      });
      const html1 = await r1.text();

      const doc1 = new DOMParser().parseFromString(html1, 'text/html');
      const errBox = doc1.querySelector('.error_box, .error, .autohide-error');
      if (errBox) {
        const msg = errBox.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error('confirm rejeitado: ' + (msg || 'erro desconhecido'));
      }

      const form2 = [...doc1.forms].find(f => /action=command/.test(f.action || '')) || doc1.querySelector('form#command-data-form');
      if (!form2) throw new Error('form de confirmação não encontrado na resposta do passo 1');
      const hiddenFields = {};
      form2.querySelectorAll('input[type="hidden"]').forEach(i => {
        if (i.name) hiddenFields[i.name] = i.value;
      });
      if (!hiddenFields.h) hiddenFields.h = this.csrf();
      if (!hiddenFields.ch) {
        const fieldsList = Object.keys(hiddenFields).join(', ');
        throw new Error(`hash de comando (ch) ausente. campos: [${fieldsList}]`);
      }

      return { hiddenFields, preparedAt: Date.now() };
    },

    // ETAPA 2 do envio: dispara o ataque. Usa os hidden fields obtidos no
    // prepareCommand. Aceita waves extras (vão como train[2..N][unit]).
    async confirmCommand({ fromVillageId, hiddenFields, waves, type, catapultTarget }) {
      const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
      const body2 = new URLSearchParams();
      Object.entries(hiddenFields).forEach(([k, v]) => body2.append(k, v));
      body2.set('building', catapultTarget || hiddenFields.building || 'farm');
      if (type === 'support') body2.set('support', 'true');
      else body2.set('attack', 'true');
      for (let i = 1; i < (waves?.length || 0); i++) {
        const wu = waves[i].units || {};
        for (const u of UNIT_KEYS) {
          body2.append(`train[${i + 1}][${u}]`, String(wu[u] || 0));
        }
      }

      const url2 = `/game.php?village=${fromVillageId}&screen=place&action=command`;
      const r2 = await fetch(url2, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body2.toString(),
      });
      const html2 = await r2.text();

      const doc2 = new DOMParser().parseFromString(html2, 'text/html');
      const err2 = doc2.querySelector('.error_box, .error, .autohide-error');
      if (err2) {
        const msg = err2.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error('command rejeitado: ' + (msg || 'erro desconhecido'));
      }
      return { ok: true };
    },

    // Envio "all-in-one" (legado / usado quando não há tempo pra pré-confirmar).
    async submitCommand({ fromVillageId, x, y, units, waves, type, catapultTarget }) {
      const waveList = waves && waves.length ? waves : [{ units: units || {} }];
      const prepared = await this.prepareCommand({
        fromVillageId, x, y, units: waveList[0].units, type,
      });
      return this.confirmCommand({
        fromVillageId, hiddenFields: prepared.hiddenFields, waves: waveList, type, catapultTarget,
      });
    },

    // ---------- Assistente de Saque (am_farm) ----------

    // GET /game.php?screen=am_farm. Parsea o form de "Editar todos" pra
    // descobrir os IDs reais dos modelos A e B nesta conta + as tropas
    // configuradas, e captura o CSRF (`h`) usado pra editar/disparar.
    // Retorna { templates: [{ id, units, catapultTarget }, ...], csrf }
    // Convenção: o 1º template = A, o 2º = B. Se houver mais, ignora extras.
    async fetchFarmTemplates(villageId) {
      const vid = villageId || unsafeWindow.game_data?.village?.id;
      const url = `/game.php?village=${vid}&screen=am_farm`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      return parseFarmTemplates(html);
    },

    // POST /game.php?village=X&screen=am_farm&action=edit_all
    // O form do jogo edita TODOS os templates de uma vez. Pra atualizar
    // só A (ou só B), passamos os outros inalterados.
    // params: { villageId, templates: [{ id, units, catapultTarget }, ...], csrf }
    async updateFarmTemplates({ villageId, templates, csrf }) {
      const vid = villageId || unsafeWindow.game_data?.village?.id;
      const body = new URLSearchParams();
      // botão "Salvar" do form original — alguns endpoints validam a presença
      body.append('', 'Salvar');
      const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight'];
      for (const t of templates) {
        body.append(`template[${t.id}][id]`, String(t.id));
        body.append(`template[${t.id}][new]`, '0');
        for (const k of UNIT_KEYS) {
          body.append(`${k}[${t.id}]`, String(t.units?.[k] || 0));
        }
        body.append(`catapult_target[${t.id}]`, t.catapultTarget || 'main');
      }
      body.append('h', csrf);
      // o jogo embute `h` na URL do form (query param). Manda nos dois lugares.
      const url = `/game.php?village=${vid}&screen=am_farm&action=edit_all&h=${encodeURIComponent(csrf)}`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(`updateFarmTemplates falhou: HTTP ${res.status}`);
      return { ok: true };
    },

    // GET /game.php?screen=am_farm. Lê tabela #plunder_list de bárbaras conhecidas.
    // Retorna [{ villageId, reportId, x, y, coords, fullLoot, hadLosses, lastAttackText }, ...]
    async fetchFarmAssistantList(villageId) {
      const vid = villageId || unsafeWindow.game_data?.village?.id;
      const url = `/game.php?village=${vid}&screen=am_farm`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      return parseFarmAssistantList(html);
    },

    // GET /game.php?screen=report&mode=all&view=<reportId> — lê 1 relatório individual.
    // Retorna o HTML pra ser parseado por parseSpyReport.
    async fetchReport(reportId) {
      const url = `/game.php?screen=report&mode=all&view=${reportId}`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      return html;
    },

    // GET /game.php?screen=place&mode=command — lista TODOS os comandos saindo do jogador.
    // Retorna Set<"x|y"> dos destinos que têm ataque/farm em curso.
    // Apoio e retornos NÃO entram (data-command-type !== "attack").
    async fetchOutgoingAttacks() {
      const url = `/game.php?village=${unsafeWindow.game_data.village.id}&screen=place&mode=command`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      return parseOutgoingAttacks(html);
    },

    // GET /map/village.txt — endpoint público do TW que lista TODAS as aldeias do mundo.
    // Formato CSV: id,name(URL-encoded),x,y,owner_id,points,?
    // Owner = 0 → bárbara. Cache global em memória (mundo não muda durante a sessão).
    _worldVillagesCache: null,
    async fetchAllWorldVillages(force) {
      if (this._worldVillagesCache && !force) return this._worldVillagesCache;
      const res = await fetch('/map/village.txt', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar /map/village.txt`);
      const text = await res.text();
      if (!text || text.length < 100) throw new Error('endpoint /map/village.txt vazio ou indisponível');
      const villages = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        const p = line.split(',');
        if (p.length < 6) continue;
        const id = parseInt(p[0], 10);
        const x = parseInt(p[2], 10);
        const y = parseInt(p[3], 10);
        const owner = parseInt(p[4], 10);
        if (!id || isNaN(x) || isNaN(y)) continue;
        villages.push({ id, x, y, owner, name: decodeURIComponent(p[1] || '').replace(/\+/g, ' ') });
      }
      this._worldVillagesCache = villages;
      return villages;
    },

    // POST /game.php?village=<source>&screen=am_farm&mode=farm&ajaxaction=farm&json=1
    // Body: target=<targetVillageId>&template_id=<id>&source=<sourceVillageId>&h=<csrf>
    // params: { sourceVillageId, targetVillageId, templateId, csrf }
    async dispatchFarm({ sourceVillageId, targetVillageId, templateId, csrf }) {
      const body = new URLSearchParams();
      body.append('target', String(targetVillageId));
      body.append('template_id', String(templateId));
      body.append('source', String(sourceVillageId));
      body.append('h', csrf);
      const url = `/game.php?village=${sourceVillageId}&screen=am_farm&mode=farm&ajaxaction=farm&json=1`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'TribalWars-Ajax': '1',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body: body.toString(),
      });
      const data = await res.json().catch(() => null);
      // o jogo retorna { error: [...] } em falha (ex: tropas insuficientes)
      if (data?.error?.length) {
        throw new Error(data.error.join('; '));
      }
      return data || { ok: true };
    },

    // Lê screen=main de uma aldeia e parseia níveis, fila, custos, recursos.
    // Retorna { levels, queue, costs, resources, storage, queueMax, isPremium, csrf }
    async fetchMainBuilding(villageId) {
      const url = `/game.php?village=${villageId}&screen=main`;
      const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
      return parseMainBuilding(html, villageId);
    },

    // Dispara POST de upgrade de edifício.
    // buildingKey: key interna do TW (ex: 'main', 'barracks').
    // Retorna resposta JSON do jogo (ou lança em erro).
    async submitBuild(villageId, buildingKey, csrfH) {
      const url = `/game.php?village=${villageId}&screen=main&ajaxaction=upgrade_building&type=${buildingKey}`;
      const body = new URLSearchParams();
      body.append('id', buildingKey);
      body.append('force', '1');
      body.append('destroy', '0');
      body.append('source', String(villageId));
      body.append('h', csrfH);
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'TribalWars-Ajax': '1',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
      const data = await res.json().catch(() => null);
      if (data?.error?.length) throw new Error(data.error.join('; '));
      return data || { ok: true };
    },

    // Lê todas as tropas das aldeias (paginado), usando overview_villages?mode=units.
    // groupId: 0 = Todos, >0 = grupo específico.
    // Retorna Map<villageId, { spear, sword, axe, archer, spy, light, marcher, heavy, ram, catapult, knight, snob, militia }>
    async fetchAllUnits(groupId) {
      const map = new Map();
      // sempre passa group= (0 = "Todos") — sem o param o filtro pode usar outro grupo da sessão
      const gid = (groupId == null || groupId < 0) ? 0 : groupId;
      for (let page = 0; page < 50; page++) {
        const url = `/game.php?screen=overview_villages&mode=units&group=${gid}&page=${page}`;
        const res = await fetch(url, { credentials: 'include' });
        const html = await res.text();
        const list = parseAllUnitsTable(html);
        if (!list.length) break;
        let added = 0;
        for (const v of list) {
          if (map.has(v.villageId)) continue;
          map.set(v.villageId, v.units);
          added++;
        }
        if (added === 0) break;
      }
      return map;
    },
  };

  // ---------- parsers do am_farm ----------

  // Parsea o form#edit_all (action=edit_all) da tela do Assistente de Saque
  // pra descobrir IDs reais dos templates desta conta + tropas configuradas + csrf.
  // Cada conta tem seus próprios IDs (ex: 2198 e 2230 num mundo, outros noutro).
  // Convenção: 1º template no DOM = "A", 2º = "B".
  function parseFarmTemplates(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = [...doc.forms].find(f => /action=edit_all/.test(f.action || ''));
    if (!form) return { templates: [], csrf: '' };
    // CSRF (`h`) vem na URL do form.action como query param, não como input hidden.
    const csrf = (form.action.match(/[?&]h=([a-f0-9]+)/i) || [])[1] || '';
    // template[ID][id] aparece 1x por template — coleta IDs únicos preservando ordem
    const ids = [];
    form.querySelectorAll('input[name^="template["]').forEach(inp => {
      const m = inp.name.match(/^template\[(\d+)\]\[id\]$/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });
    const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight'];
    const templates = ids.map(id => {
      const units = {};
      for (const k of UNIT_KEYS) {
        const v = form.querySelector(`input[name="${k}[${id}]"]`)?.value;
        units[k] = parseInt(v || '0', 10) || 0;
      }
      const ct = form.querySelector(`select[name="catapult_target[${id}]"], input[name="catapult_target[${id}]"]`)?.value;
      return { id: parseInt(id, 10), units, catapultTarget: ct || 'main' };
    });
    return { templates, csrf };
  }

  // Parsea screen=place&mode=command. Cada <tr class="command-row"> tem um
  // <span class="command_hover_details" data-command-type="attack|support|...">
  // e um <span class="quickedit-label"> com texto "Ataque a Foo (X|Y) Kxx".
  // Filtramos só ataques (inclui farm — type="attack" cobre os dois).
  // Parsea um relatório de espionagem (screen=report&view=<id>).
  // IDs estáveis no DOM:
  //   #attack_info_def_units     → tropas presentes na bárbara
  //   #attack_spy_away           → tropas fora da aldeia (também conta como "tem tropa")
  //   #attack_spy_buildings_left/right → edifícios + nível (incluindo muralha)
  // Retorna { units: {spear, sword, ...}, away: {...}, wall, buildings: [{key, name, level}], totalUnits, isSpyReport }
  // Se o relatório não tiver as tabelas esperadas (ex: relatório de ataque puro sem espionagem),
  // retorna isSpyReport=false. Caller deve ignorar.
  function parseSpyReport(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = {
      isSpyReport: false,
      units: {},
      away: {},
      wall: 0,
      buildings: [],
      totalUnits: 0,
      totalAway: 0,
    };

    const defTable = doc.querySelector('#attack_info_def_units');
    const buildingsLeft = doc.querySelector('#attack_spy_buildings_left');
    const awayTable = doc.querySelector('#attack_spy_away');
    // só consideramos relatório de espionagem se conseguimos ler defesa OU edifícios
    if (!defTable && !buildingsLeft) return result;
    result.isSpyReport = true;

    // tropas defendendo: tabela tem 2 linhas (header com data-unit + valores)
    if (defTable) {
      const headerCells = [...defTable.querySelectorAll('thead tr td, tbody tr:first-child td')];
      const valueCells = [...defTable.querySelectorAll('tbody tr')].slice(1).flatMap(tr => [...tr.children]);
      // mapeia cada coluna pelo data-unit do <a> dentro
      headerCells.forEach((cell, i) => {
        const unit = cell.querySelector('[data-unit]')?.getAttribute('data-unit');
        if (!unit) return;
        const val = parseInt(valueCells[i]?.textContent?.trim() || '0', 10) || 0;
        result.units[unit] = val;
        result.totalUnits += val;
      });
    }

    // tropas fora da aldeia (mesma estrutura, dentro do #attack_spy_away)
    if (awayTable) {
      const innerTable = awayTable.querySelector('table.vis');
      if (innerTable) {
        const headerCells = [...innerTable.querySelectorAll('tr:first-child th')];
        const valueCells = [...innerTable.querySelectorAll('tr')].slice(1).flatMap(tr => [...tr.children]);
        headerCells.forEach((cell, i) => {
          const unit = cell.querySelector('[data-unit]')?.getAttribute('data-unit');
          if (!unit) return;
          const val = parseInt(valueCells[i]?.textContent?.trim() || '0', 10) || 0;
          result.away[unit] = val;
          result.totalAway += val;
        });
      }
    }

    // edifícios + nível: itera ambas as tabelas left/right
    const buildingTables = [
      doc.querySelector('#attack_spy_buildings_left'),
      doc.querySelector('#attack_spy_buildings_right'),
    ].filter(Boolean);
    for (const t of buildingTables) {
      t.querySelectorAll('tbody tr').forEach(tr => {
        const img = tr.querySelector('img[src*="/buildings/"]');
        if (!img) return;
        const m = img.getAttribute('src').match(/\/buildings\/(\w+)\.\w+/);
        if (!m) return;
        const key = m[1];
        const name = tr.querySelector('span.middle')?.textContent.trim() || key;
        const tds = tr.querySelectorAll('td');
        const level = parseInt(tds[tds.length - 1]?.textContent.trim() || '0', 10) || 0;
        result.buildings.push({ key, name, level });
        if (key === 'wall') result.wall = level;
      });
    }

    return result;
  }

  // Retorna Map<"x|y", { count, arrivals: [timestamp_ms, ...] }> de ataques saindo agora.
  // Por que armazenar arrivals: pra implementar janela temporal entre farms na mesma
  // bárbara (não mandar 2 que chegam quase juntos). Bárbaras somem do #plunder_list
  // enquanto há comando indo, então overview_villages?mode=command é a fonte canônica.
  // Estrutura da linha: td[0]=label com coords, td[1]="hoje às HH:MM:SS:mmm" (chegada),
  // td[2]=tempo restante. Tipo via [data-command-type="attack"] em <span class="command_hover_details">.
  function parseOutgoingAttacks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = new Map();
    doc.querySelectorAll('tr.command-row').forEach(tr => {
      const detail = tr.querySelector('[data-command-type]');
      if (!detail) return;
      if (detail.getAttribute('data-command-type') !== 'attack') return;
      const label = tr.querySelector('.quickedit-label')?.textContent || tr.textContent || '';
      const m = label.match(/\((\d{1,3})\|(\d{1,3})\)/);
      if (!m) return;
      const coord = `${m[1]}|${m[2]}`;
      const tds = tr.querySelectorAll('td');
      const arrivalText = tds[1]?.textContent.trim() || '';
      const arrivalAt = parseTwArrivalText(arrivalText);   // pode ser null se não conseguir
      const entry = out.get(coord) || { count: 0, arrivals: [] };
      entry.count += 1;
      if (arrivalAt) entry.arrivals.push(arrivalAt);
      out.set(coord, entry);
    });
    return out;
  }

  // Parsea texto de chegada do TW para timestamp local (ms).
  // Formatos observados (pt-BR br142):
  //   "hoje às HH:MM:SS:mmm"
  //   "amanhã às HH:MM:SS:mmm"
  //   "DD.MM. às HH:MM:SS:mmm"      (ano implícito = atual)
  //   "DD.MM.YYYY às HH:MM:SS:mmm"
  // Retorna null se não conseguir parsear.
  function parseTwArrivalText(s) {
    if (!s) return null;
    const timeMatch = s.match(/(\d{1,2}):(\d{2}):(\d{2})(?::(\d{1,3}))?/);
    if (!timeMatch) return null;
    const [, hh, mm, ss, ms] = timeMatch;
    const now = new Date();
    const d = new Date(now);
    if (/hoje/i.test(s)) {
      // mantém data atual
    } else if (/amanh[aã]/i.test(s)) {
      d.setDate(d.getDate() + 1);
    } else {
      // tenta DD.MM ou DD.MM.YYYY
      const dm = s.match(/(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/);
      if (!dm) return null;
      const day = parseInt(dm[1], 10);
      const month = parseInt(dm[2], 10) - 1;
      const yearTok = dm[3];
      const year = yearTok ? (yearTok.length === 2 ? 2000 + parseInt(yearTok, 10) : parseInt(yearTok, 10)) : now.getFullYear();
      d.setFullYear(year, month, day);
    }
    d.setHours(parseInt(hh, 10), parseInt(mm, 10), parseInt(ss, 10), ms ? parseInt(ms, 10) : 0);
    return d.getTime();
  }

  // Parsea #plunder_list (tabela de bárbaras conhecidas no Assistente de Saque).
  // Estrutura observada: <tr id="village_<ID>" class="report_<ID> row_a">
  //   td[0] = botão apagar
  //   td[1] = ícone status do último relatório (dots/green=vitória, yellow=parcial/perdas, red=derrota)
  //   td[2] = ícone max_loot (max_loot/1=cheio, max_loot/0=parcial)
  //   td[3] = link de coords "(X|Y) Kxx" com href view=<reportId>
  //   td[4] = "em DD.MM. às HH:MM:SS" (último ataque)
  //   demais tds: recursos / explorador / botões A/B etc — não usadas no MVP
  function parseFarmAssistantList(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table#plunder_list');
    if (!table) return [];
    const out = [];
    table.querySelectorAll('tr[id^="village_"]').forEach(tr => {
      const idMatch = tr.id.match(/^village_(\d+)$/);
      if (!idMatch) return;
      const villageId = parseInt(idMatch[1], 10);

      const coordMatch = tr.textContent.match(/\((\d{1,3})\|(\d{1,3})\)/);
      if (!coordMatch) return;
      const x = parseInt(coordMatch[1], 10);
      const y = parseInt(coordMatch[2], 10);

      const reportLink = tr.querySelector('a[href*="screen=report"]');
      const reportIdMatch = reportLink?.getAttribute('href').match(/view=(\d+)/);
      const reportId = reportIdMatch ? parseInt(reportIdMatch[1], 10) : null;

      // detecção de saque cheio: max_loot/1.webp (qualquer outra variação = false)
      const fullLoot = !!tr.querySelector('img[src*="max_loot/1"]');
      // detecção de perdas: dots/yellow.webp ou dots/red.webp no status
      const hadLosses = !!tr.querySelector('img[src*="dots/yellow"], img[src*="dots/red"]');

      // texto do último ataque ("em 27.04. às 08:16:28") — opcional, pra display
      let lastAttackText = '';
      const tds = tr.querySelectorAll('td');
      for (const td of tds) {
        const t = td.textContent.trim();
        if (/^em \d{1,2}\.\d{1,2}\.? às \d{1,2}:\d{2}/.test(t)) {
          lastAttackText = t;
          break;
        }
      }

      out.push({
        villageId,
        reportId,
        x, y,
        coords: `${x}|${y}`,
        fullLoot,
        hadLosses,
        lastAttackText,
      });
    });
    return out;
  }

  // Parsea screen=main de uma aldeia.
  // Retorna:
  //   levels   — Map<buildingKey, currentLevel>
  //   queue    — Array<buildingKey> (itens na fila, na ordem)
  //   costs    — Map<buildingKey, { wood, stone, iron, buildable }>
  //   resources — { wood, stone, iron }
  //   storage  — capacidade máxima do armazém (limita construção)
  //   pop      — { current, max }
  //   queueMax — slots max da fila (2 = gratuito, 5 = premium)
  //   isPremium — bool
  //   csrf     — string (h= do link de upgrade, ou game_data.csrf)
  function parseMainBuilding(html, _villageId) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Níveis atuais: cada linha da tabela tem id="main_buildrow_<key>"
    const levels = new Map();
    doc.querySelectorAll('tr[id^="main_buildrow_"]').forEach(tr => {
      const key = tr.id.replace('main_buildrow_', '');
      // O nível aparece em formato "Nível N" — captura o número
      const txt = tr.textContent || '';
      const m = txt.match(/N[íi]vel\s+(\d+)/i);
      levels.set(key, m ? parseInt(m[1], 10) : 0);
    });

    // Custos e se é construível: link de upgrade tem data-building e os TDs têm data-cost
    const costs = new Map();
    doc.querySelectorAll('a[data-building]').forEach(a => {
      const key = a.getAttribute('data-building');
      if (!key) return;
      const row = a.closest('tr');
      if (!row) return;
      const w = parseInt(row.querySelector('td.cost_wood')?.getAttribute('data-cost') || '0', 10);
      const s = parseInt(row.querySelector('td.cost_stone')?.getAttribute('data-cost') || '0', 10);
      const i = parseInt(row.querySelector('td.cost_iron')?.getAttribute('data-cost') || '0', 10);
      // Se o link existe e não está dentro de um elemento "disabled", é construível
      const buildable = !a.closest('.inactive') && !a.classList.contains('inactive');
      costs.set(key, { wood: w, stone: s, iron: i, buildable });
    });

    // Fila de construção: tbody#buildqueue, cada tr tem classe "buildorder_<key>"
    const queue = [];
    const tbody = doc.querySelector('tbody#buildqueue');
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(tr => {
        const cls = [...tr.classList].find(c => c.startsWith('buildorder_'));
        if (cls) queue.push(cls.replace('buildorder_', ''));
      });
    }

    // Recursos atuais
    const wood    = parseInt(doc.querySelector('#wood')?.textContent?.replace(/\./g, '') || '0', 10);
    const stone   = parseInt(doc.querySelector('#stone')?.textContent?.replace(/\./g, '') || '0', 10);
    const iron    = parseInt(doc.querySelector('#iron')?.textContent?.replace(/\./g, '') || '0', 10);
    const storage = parseInt(doc.querySelector('#storage')?.textContent?.replace(/\./g, '') || '0', 10);

    // Capacidade de pop
    const popCur = parseInt(doc.querySelector('#pop_current_label')?.textContent?.replace(/\./g, '') || '0', 10);
    const popMax = parseInt(doc.querySelector('#pop_max_label')?.textContent?.replace(/\./g, '') || '0', 10);

    // Detecção premium: conta slots de fila renderizados.
    // O jogo renderiza 1 linha vazia por slot livre + linhas de itens na fila.
    // Premium = 5 slots, free = 2.
    const queueSlots = tbody
      ? tbody.querySelectorAll('tr').length
      : queue.length;
    // Estimativa conservadora: se tiver mais de 2 slots totais (ocupados+vazios), é premium.
    // O TW renderiza todos os slots mesmo os vazios (como linha com classe vazia ou placeholder).
    // Fallback: se não conseguimos medir, assume free (2).
    let queueMax = 2;
    // Alternativa: ler data-attr do container da fila, se disponível.
    const queueContainer = doc.querySelector('#build_queue');
    if (queueContainer) {
      const maxAttr = queueContainer.getAttribute('data-max-queue');
      if (maxAttr) queueMax = parseInt(maxAttr, 10);
      else queueMax = queueSlots > 2 ? 5 : 2;
    } else {
      queueMax = queueSlots > 2 ? 5 : 2;
    }
    const isPremium = queueMax >= 5;

    // CSRF do link de upgrade (ou fallback pra game_data.csrf)
    const upgradeHref = doc.querySelector('a[href*="ajaxaction=upgrade_building"], a[href*="action=upgrade_building"]')?.getAttribute('href') || '';
    const csrfM = upgradeHref.match(/[?&]h=([a-f0-9]+)/i);
    const csrf = csrfM?.[1] || (typeof unsafeWindow !== 'undefined' ? unsafeWindow.game_data?.csrf : '') || '';

    return {
      levels,
      queue,
      costs,
      resources: { wood, stone, iron },
      storage,
      pop: { current: popCur, max: popMax },
      queueMax,
      isPremium,
      csrf,
    };
  }

  // Parser do XML do mundo (unit_info + config) → { unitSpeed, speedFactor, unitSpeedFactor }
  function parseWorldConfig(unitsXml, worldXml) {
    const result = {
      unitSpeed: {},
      speedFactor: 1,
      unitSpeedFactor: 1,
      fetchedAt: Date.now(),
    };
    try {
      const dUnits = new DOMParser().parseFromString(unitsXml, 'text/xml');
      // estrutura: <config><spear><speed>18</speed><pop>1</pop>...</spear><sword>...</sword>...</config>
      const root = dUnits.documentElement;
      if (root) {
        for (const node of root.children) {
          const speedNode = node.querySelector('speed');
          if (speedNode) {
            const v = parseFloat(speedNode.textContent);
            if (!isNaN(v)) result.unitSpeed[node.tagName] = v;
          }
        }
      }
    } catch {}
    try {
      const dWorld = new DOMParser().parseFromString(worldXml, 'text/xml');
      const sf = parseFloat(dWorld.querySelector('speed')?.textContent);
      const usf = parseFloat(dWorld.querySelector('unit_speed')?.textContent);
      if (!isNaN(sf)) result.speedFactor = sf;
      if (!isNaN(usf)) result.unitSpeedFactor = usf;
    } catch {}
    return result;
  }

  // Parser da tabela #units_table (overview_villages?mode=units).
  // Retorna [{ villageId, x, y, units: { spear, sword, ... } }]
  // Ordem das colunas (TW padrão):
  //   td[0]=nome (XXX|YYY) | td[1]=filtro | td[2..14]=13 unidades | td[15]=ações
  // Unidades em ordem: spear, sword, axe, archer, spy, light, marcher, heavy, ram, catapult, knight, snob, militia
  const UNITS_TABLE_ORDER = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob', 'militia'];
  function parseAllUnitsTable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table#units_table');
    if (!table) return [];
    const out = [];
    const rows = table.querySelectorAll('tbody tr, tr');
    rows.forEach(tr => {
      // pula header (não tem coord)
      if (!/\(\d{1,3}\|\d{1,3}\)/.test(tr.textContent)) return;
      // pega ID da aldeia via link na primeira td
      const link = tr.querySelector('a[href*="village="]');
      const idMatch = link?.getAttribute('href').match(/village=(\d+)/);
      if (!idMatch) return;
      const villageId = idMatch[1];
      // coord
      const coordMatch = tr.textContent.match(/\((\d{1,3})\|(\d{1,3})\)/);
      const x = coordMatch ? parseInt(coordMatch[1], 10) : null;
      const y = coordMatch ? parseInt(coordMatch[2], 10) : null;
      // todas as <td>
      const tds = tr.querySelectorAll('td');
      // td[2..14] = 13 unidades em UNITS_TABLE_ORDER
      const units = {};
      for (let i = 0; i < UNITS_TABLE_ORDER.length; i++) {
        const td = tds[2 + i];
        if (!td) continue;
        const n = parseInt(td.textContent.replace(/\D/g, ''), 10);
        units[UNITS_TABLE_ORDER[i]] = isNaN(n) ? 0 : n;
      }
      out.push({ villageId, x, y, units });
    });
    return out;
  }

  function parseVillagesFromOverview(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Cada aldeia listada aparece como <a href="...village=ID&screen=overview"> com texto
    // "Nome (XXX|YYY) Kxx". Filtramos exatamente esse padrão.
    const links = doc.querySelectorAll('a[href*="village="][href*="screen=overview"]');
    const seen = new Set();
    const villages = [];
    links.forEach(a => {
      const href = a.getAttribute('href') || '';
      // exclui links pra screen=overview_villages (menus de modo)
      if (/screen=overview_villages/.test(href)) return;
      const idMatch = href.match(/village=(\d+)/);
      if (!idMatch) return;
      const id = idMatch[1];
      if (seen.has(id)) return;
      const text = a.textContent.trim();
      const cm = text.match(/\((\d{1,3})\|(\d{1,3})\)/);
      if (!cm) return;          // só aceitamos linhas com coords no texto
      seen.add(id);
      // nome = texto antes do "("
      const name = text.split('(')[0].trim() || text;
      villages.push({
        id,
        name,
        x: parseInt(cm[1], 10),
        y: parseInt(cm[2], 10),
      });
    });
    return villages;
  }

  function parseCoordsFromText(text, opts = {}) {
    const re = /(\d{1,3})\|(\d{1,3})/g;
    const list = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const coords = `${m[1]}|${m[2]}`;
      if (!opts.keepDuplicates && seen.has(coords)) continue;
      seen.add(coords);
      list.push({ coords, x: parseInt(m[1], 10), y: parseInt(m[2], 10) });
    }
    return list;
  }

  // ---- cálculo de viagem ----
  function distance(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  // dado um map de unidades em uso (id → quantidade), retorna a velocidade da mais lenta
  // (= maior valor de min/campo). Retorna 0 se nada está em uso.
  function slowestSpeed(unitsMap) {
    const speeds = state.scheduler.worldConfig.unitSpeed;
    let max = 0;
    for (const [u, n] of Object.entries(unitsMap)) {
      if (n > 0 && (speeds[u] || 0) > max) max = speeds[u] || 0;
    }
    return max;
  }

  // tempo de viagem em ms.
  // O <speed> de cada unidade no get_unit_info já vem com os fatores de mundo
  // (speed e unit_speed) aplicados — basta multiplicar pela distância.
  function travelTimeMs(fromXY, toXY, slowestMpf) {
    const dist = distance(fromXY, toXY);
    const minutes = slowestMpf * dist;
    return Math.round(minutes * 60 * 1000);
  }

  // garante que worldConfig está fresco (ou faz fetch). 7 dias de cache.
  async function ensureWorldConfig(force = false) {
    const wc = state.scheduler.worldConfig;
    const stale = !wc.fetchedAt || (Date.now() - wc.fetchedAt) > 7 * 24 * 60 * 60 * 1000;
    if (!force && !stale && Object.keys(wc.unitSpeed).length) return wc;
    pushSchedulerLog('Atualizando configuração do mundo (velocidades, fatores)...');
    try {
      const fresh = await Game.fetchWorldConfig();
      if (Object.keys(fresh.unitSpeed).length) {
        state.scheduler.worldConfig = { ...wc, ...fresh };
        persist();
        pushSchedulerLog(`Mundo atualizado: speed=${fresh.speedFactor}, unit_speed=${fresh.unitSpeedFactor}, ${Object.keys(fresh.unitSpeed).length} unidades.`);
      } else {
        pushSchedulerLog('Falha ao parsear config do mundo, usando defaults.');
      }
    } catch (e) {
      pushSchedulerLog(`Erro ao buscar config do mundo: ${e.message}`);
    }
    return state.scheduler.worldConfig;
  }

  // mapeia tbody#trainqueue_<key> ao building name
  const QUEUE_TBODY_TO_BUILDING = {
    barracks: 'Quartel',
    stable: 'Estábulo',
    garage: 'Oficina',
    workshop: 'Oficina',
  };

  function parseTrainQueue(doc) {
    const queue = [];

    // Procura tbodys de fila por edifício
    Object.entries(QUEUE_TBODY_TO_BUILDING).forEach(([key, building]) => {
      const tbody = doc.querySelector(`tbody#trainqueue_${key}`);
      if (!tbody) return;
      const rows = tbody.querySelectorAll('tr.sortable_row, tr[id^="trainorder_"]');
      rows.forEach(row => {
        const unitId = detectUnitFromRow(row);
        const count = detectCountFromRow(row);
        queue.push({ unitId: unitId || '_unknown', count, building });
      });
    });

    return queue;
  }

  function detectUnitFromRow(row) {
    // tenta múltiplas pistas
    const sprite = row.querySelector('[class*="unit_"], [data-unit]');
    if (sprite) {
      const dataUnit = sprite.getAttribute('data-unit');
      if (dataUnit) return dataUnit;
      const cls = sprite.className || '';
      const m = cls.match(/unit_(\w+)/);
      if (m) return m[1];
    }
    const img = row.querySelector('img[src*="unit_"]');
    if (img) {
      const m = img.getAttribute('src').match(/unit_(\w+?)\.(?:png|webp|gif)/);
      if (m) return m[1];
    }
    return null;
  }

  function detectCountFromRow(row) {
    for (const td of row.querySelectorAll('td')) {
      const cm = td.textContent.trim().match(/^(\d+)\b/);
      if (cm) return parseInt(cm[1], 10);
    }
    return 0;
  }

  // ---------- builder template decoder ----------
  // Formato (best-effort, validado com `bgAA...` MAX ARMAZÉM):
  //   byte 0:           0x6e (magic)
  //   bytes 1-2:        0x00 0x00 (header)
  //   pares (2 bytes):  (0x01, building_id) — cada par = "+1 nível pro edifício"
  //                     repete até encontrar 0x00 0x00 (terminator)
  //   trailer:          0xf4 0x80 0x80 0x80 + nome em UTF-8
  //                     + 0xf4 0x80 0x80 0x80 + checksum byte (ignorado)
  function decodeBuildSequence(b64) {
    if (typeof b64 !== 'string') return null;
    const cleaned = b64.trim().replace(/\s+/g, '');
    if (!cleaned) return null;
    let bytes;
    try {
      const bin = atob(cleaned);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return null;
    }
    if (bytes.length < 5 || bytes[0] !== 0x6e || bytes[1] !== 0x00 || bytes[2] !== 0x00) {
      return null;
    }

    const steps = [];
    let i = 3;
    while (i + 1 < bytes.length) {
      const a = bytes[i];
      const b = bytes[i + 1];
      // Terminator do bloco de pares
      if (a === 0x00 && b === 0x00) { i += 2; break; }
      // Cada par válido começa com 0x01 (instrução "+1 nível")
      if (a !== 0x01) break;
      const key = BUILDING_KEYS[b];
      if (!key) {
        // Building id desconhecido — preserva como `unknown_<id>` pra debug
        steps.push(`unknown_${b}`);
      } else {
        steps.push(key);
      }
      i += 2;
    }

    let name = '';
    // Procura marcador 0xf4 0x80 0x80 0x80 que cerca o nome
    const nameStart = findNameMarker(bytes, i);
    if (nameStart !== -1) {
      const nameEnd = findNameMarker(bytes, nameStart + 4);
      const end = nameEnd === -1 ? bytes.length : nameEnd;
      try {
        name = new TextDecoder('utf-8').decode(bytes.slice(nameStart + 4, end));
      } catch {
        name = '';
      }
    }

    return { name: name.trim(), steps };
  }

  function findNameMarker(bytes, start) {
    for (let i = start; i + 3 < bytes.length; i++) {
      if (bytes[i] === 0xf4 && bytes[i + 1] === 0x80 && bytes[i + 2] === 0x80 && bytes[i + 3] === 0x80) {
        return i;
      }
    }
    return -1;
  }

  // Agrupa runs consecutivos do mesmo edifício pra display compacto
  function encodeBuildSequenceCompact(steps) {
    const runs = [];
    for (const s of steps) {
      const last = runs[runs.length - 1];
      if (last && last.building === s) last.count++;
      else runs.push({ building: s, count: 1 });
    }
    return runs;
  }

  // ---------- recruiter engine ----------
  function pushLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    state.recruiter.log.unshift(`[${ts}] ${msg}`);
    state.recruiter.log = state.recruiter.log.slice(0, 200);
    persist();
    if (typeof renderLog === 'function' && state.ui.activeSection === 'recruiter') renderLog();
  }

  function pushSchedulerLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    state.scheduler.log.unshift(`[${ts}] ${msg}`);
    state.scheduler.log = state.scheduler.log.slice(0, 500);
    persist();
    if (typeof renderLog === 'function' && (state.ui.activeSection === 'scheduler' || state.ui.activeSection === 'dashboard')) renderLog();
  }

  function pushFarmerLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    state.farmer.log.unshift(`[${ts}] ${msg}`);
    state.farmer.log = state.farmer.log.slice(0, 200);
    persist();
    if (typeof renderLog === 'function' && state.ui.activeSection === 'farmer') renderLog();
  }

  function computeRecruitForVillage(profile, trainData) {
    const queuedCount = {};
    trainData.queue.forEach(q => {
      queuedCount[q.unitId] = (queuedCount[q.unitId] || 0) + q.count;
    });

    const toRecruit = {};

    for (const building of BUILDINGS) {
      const bcfg = profile.buildings[building];
      if (!bcfg || bcfg.perQueue <= 0 || bcfg.maxQueues <= 0) continue;

      // Filas ativas no edifício: usa o `building` que veio do tbody#trainqueue_<key>;
      // fallback (caso o parser não tenha conseguido marcar): pelo unitId pertencer ao edifício
      const buildingUnits = UNITS.filter(u => u.building === building);
      const activeQueues = trainData.queue.filter(q =>
        q.building === building || buildingUnits.some(u => u.id === q.unitId)
      ).length;

      if (activeQueues >= bcfg.maxQueues) continue;

      // Unidades elegíveis: target>0, ainda não atingiu (existente + na fila < target)
      const eligible = buildingUnits.filter(u => {
        const c = profile.units[u.id];
        if (!c || !c.enabled || c.target <= 0) return false;
        const existing = trainData.units[u.id] || 0;
        const inQueue = queuedCount[u.id] || 0;
        return existing + inQueue < c.target;
      });
      if (!eligible.length) continue;

      // Round-robin: pega a próxima a partir do cursor
      let cursor = profile.rrCursor[building] || 0;
      // O cursor é índice em buildingUnits (não eligible), pra ser estável quando unidades saem da rotação
      const startCursor = cursor;
      let chosen = null;
      for (let i = 0; i < buildingUnits.length; i++) {
        const u = buildingUnits[(startCursor + i) % buildingUnits.length];
        if (eligible.includes(u)) {
          chosen = u;
          cursor = (buildingUnits.indexOf(u) + 1) % buildingUnits.length;
          break;
        }
      }
      if (!chosen) continue;

      const c = profile.units[chosen.id];
      const existing = trainData.units[chosen.id] || 0;
      const inQueue = queuedCount[chosen.id] || 0;
      const remaining = c.target - existing - inQueue;
      const amount = Math.min(bcfg.perQueue, remaining);
      if (amount > 0) {
        toRecruit[chosen.id] = (toRecruit[chosen.id] || 0) + amount;
        profile.rrCursor[building] = cursor;
      }
    }

    return toRecruit;
  }

  async function runProfileCycle(profile) {
    if (!profile.enabled || state.captchaTrippedAt > 0) return;

    pushLog(`[${profile.name}] ciclo iniciado.`);
    let villages;
    try {
      villages = await Game.fetchGroupVillages(profile.groupId);
    } catch (e) {
      pushLog(`[${profile.name}] erro ao buscar aldeias: ${e.message}`);
      return;
    }
    if (!villages.length) {
      pushLog(`[${profile.name}] grupo sem aldeias.`);
      return;
    }

    profile.running = { processed: 0, total: villages.length, touched: 0 };
    pushLog(`[${profile.name}] processando ${villages.length} aldeia(s)...`);

    let touched = 0;
    for (let i = 0; i < villages.length; i++) {
      const v = villages[i];
      if (!profile.enabled || state.captchaTrippedAt > 0) break;
      try {
        const td = await Game.fetchTrainData(v.id);
        const recruit = computeRecruitForVillage(profile, td);
        if (Object.keys(recruit).length > 0) {
          // gap humano entre "ler a fila do quartel" e "clicar recrutar".
          await sleep(randomInRange(400, 1500));
          const result = await Game.submitRecruit(v.id, recruit);
          const ok = result && (result.error == null);
          if (ok) {
            const summary = Object.entries(recruit)
              .map(([k, val]) => `${val} ${UNITS.find(u => u.id === k)?.name || k}`)
              .join(', ');
            pushLog(`[${profile.name}] ${v.name}: ${summary}`);
            touched++;
          } else {
            pushLog(`[${profile.name}] ${v.name}: falha (${result?.error || 'desconhecido'})`);
          }
        }
      } catch (e) {
        pushLog(`[${profile.name}] ${v.name}: erro (${e.message})`);
      }
      profile.running.processed = i + 1;
      profile.running.touched = touched;
      await sleep(humanLikeDelay());
    }

    profile.running = null;
    pushLog(`[${profile.name}] ciclo finalizado. ${touched}/${villages.length} aldeia(s) atualizada(s).`);
  }

  // delay realista entre aldeias:
  //   80% → 1–3s   (pulando rápido)
  //   17% → 8–15s  (pausa de "atenção")
  //    3% → 20–40s (distração rara)
  function humanLikeDelay() {
    const r = Math.random();
    let s;
    if (r < 0.80)      s = 1 + Math.random() * 2;
    else if (r < 0.97) s = 8 + Math.random() * 7;
    else               s = 20 + Math.random() * 20;
    return Math.round(s * 1000);
  }

  // ---------- scheduler ----------
  const profileTimers = new Map();
  // serializa ciclos concorrentes — se múltiplos profiles vencem ao mesmo tempo,
  // o segundo espera o primeiro terminar em vez de paralelizar requests.
  let recruiterCycleInFlight = null;

  function nextDelayMs(profile) {
    const min = Math.max(1, profile.intervalMin);
    const max = Math.max(min, profile.intervalMax);
    const minutes = min + Math.random() * (max - min);
    return Math.round(minutes * 60 * 1000);
  }

  function scheduleProfileNext(profile) {
    clearTimeout(profileTimers.get(profile.id));
    if (!profile.enabled || state.captchaTrippedAt > 0) {
      profile.nextRunAt = 0;
      return;
    }
    const delay = nextDelayMs(profile);
    profile.nextRunAt = Date.now() + delay;
    persist();
    const t = setTimeout(async () => {
      const fresh = state.recruiter.profiles.find(p => p.id === profile.id);
      if (!fresh) return;
      if (fresh.enabled && state.captchaTrippedAt === 0) {
        // while em vez de if: se outro profile pega o lock entre o nosso await
        // e a leitura seguinte, esperamos esse novo também antes de prosseguir.
        while (recruiterCycleInFlight) {
          try { await recruiterCycleInFlight; } catch (_) {}
        }
        if (fresh.enabled && state.captchaTrippedAt === 0) {
          recruiterCycleInFlight = (async () => {
            try { await runProfileCycle(fresh); }
            finally { recruiterCycleInFlight = null; }
          })();
          try { await recruiterCycleInFlight; } catch (_) {}
        }
        scheduleProfileNext(fresh);
      }
    }, delay);
    profileTimers.set(profile.id, t);
  }

  function startProfile(profile) {
    profile.enabled = true;
    persist();
    scheduleProfileNext(profile);
    pushLog(`[${profile.name}] ativado.`);
  }

  function stopProfile(profile) {
    profile.enabled = false;
    profile.nextRunAt = 0;
    clearTimeout(profileTimers.get(profile.id));
    profileTimers.delete(profile.id);
    persist();
    pushLog(`[${profile.name}] desativado.`);
  }

  // Reativa o bot após captcha: limpa flag local + global, dispara broadcast
  // cross-tab, remove banner e entra em carência. Os reactivateHandlers se
  // encarregam de religar timers dos módulos que continuam `enabled`.
  function resumeFromCaptcha() {
    const wasTripped = state.captchaTrippedAt > 0 || readGlobalTrip();
    if (!wasTripped) return;

    state.captchaTrippedAt = 0;
    clearGlobalTrip();
    if (captchaChannel) {
      try { captchaChannel.postMessage({ type: 'REACTIVATE', ts: Date.now(), sourceTab: TAB_ID }); } catch {}
    }
    const banner = document.getElementById('mog-captcha-banner');
    if (banner) banner.remove();
    persist();
    enterGracePeriod();
    pushLog('Captcha limpo — motores ativos retomam ciclos (carência de 60s).');

    for (const fn of reactivateHandlers) { try { fn(); } catch {} }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- medição de latência ----------
  // Mede RTT (ida+volta) e offset (servidor − cliente) usando o header `Date`
  // das respostas do TW. Resultado em ms.
  async function measureLatency() {
    const rttSamples = [];
    const offsetSamples = [];
    for (let i = 0; i < 5; i++) {
      try {
        const tStart = Date.now();
        const t0 = performance.now();
        const r = await fetch('/game.php?screen=overview', { method: 'HEAD', credentials: 'include' });
        const t1 = performance.now();
        const tEnd = Date.now();
        rttSamples.push(t1 - t0);
        const dateHeader = r.headers.get('Date');
        if (dateHeader) {
          const serverTs = new Date(dateHeader).getTime();
          const localMid = (tStart + tEnd) / 2;
          offsetSamples.push(serverTs - localMid);
        }
      } catch {}
      await sleep(120);
    }
    if (rttSamples.length < 3) return null;
    const median = arr => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const avgRtt = median(rttSamples);
    const avgOffset = offsetSamples.length >= 3 ? median(offsetSamples) : 0;
    // oneWay = RTT/2 (assume rede simétrica). A estimativa via header Date é instável
    // (1s de granularidade + viés de truncamento) e estava produzindo valores zerados.
    // Manter simples e estável é melhor que tentativa de precisão que falha.
    const avgOneWay = Math.max(1, Math.round(avgRtt / 2));
    return { avgRtt: Math.round(avgRtt), avgOffset: Math.round(avgOffset), avgOneWay };
  }

  async function refreshLatency() {
    try {
      const r = await measureLatency();
      if (!r) return;
      const lat = state.scheduler.latency;
      lat.avgRtt = r.avgRtt;
      lat.avgOffset = r.avgOffset;
      lat.avgOneWay = r.avgOneWay;
      lat.measuredAt = Date.now();
      lat.samples = (lat.samples || 0) + 1;
      persist();
    } catch {}
  }

  // Garante que latência foi medida pelo menos uma vez. Bloqueia se necessário.
  async function ensureLatencyMeasured() {
    if (state.scheduler.latency.samples > 0) return;
    pushSchedulerLog('Medindo latência inicial...');
    await refreshLatency();
  }

  // Calibração empírica do viés do Timing do TW: getCurrentServerTime() vem ~250ms
  // adiantado do server real (provável compensação errada do truncamento do Date header).
  // Validado com testes reais (sem isso, ataques chegam ~250ms cedo).
  // Ajuste fixo, não exposto — usuário não precisa mexer.
  const BIAS_CALIBRATION_MS = 250;

  // Offset (servidor − local) em ms. Prefere Timing nativo do TW (sub-ms, atualizado por
  // WebSocket) com a calibração empírica subtraída. Fallback pro avgOffset do header Date.
  function twServerOffset() {
    const T = unsafeWindow.Timing;
    if (T && typeof T.getCurrentServerTime === 'function') {
      return T.getCurrentServerTime() - Date.now() - BIAS_CALIBRATION_MS;
    }
    return state.scheduler.latency.avgOffset || 0;
  }

  // Converte timestamp do servidor em timestamp local. Usado pra agendar setTimeout/Worker.
  function serverToLocalTs(serverTs) {
    return serverTs - twServerOffset();
  }

  // Hora atual do servidor em ms (sub-ms de precisão via Timing nativo, calibrado).
  function serverNow() {
    const T = unsafeWindow.Timing;
    if (T && typeof T.getCurrentServerTime === 'function') {
      return T.getCurrentServerTime() - BIAS_CALIBRATION_MS;
    }
    return Date.now() + (state.scheduler.latency.avgOffset || 0);
  }

  // Tempo de antecipação (ms): disparamos `comp` ms antes do executeAt pra o POST chegar
  // ao servidor exatamente em executeAt. Usa RTT/2 (média de 5 pings, atualizada a cada 5s).
  function latencyCompensation() {
    const lat = state.scheduler.latency;
    if (lat.manualOverride > 0) return lat.manualOverride;
    return Math.max(1, lat.avgOneWay || Math.round((lat.avgRtt || 0) * 0.5));
  }

  // ticker de 5s: re-mede latência (não roda se há override manual)
  setInterval(() => {
    if (state.scheduler.latency.manualOverride > 0) return;
    refreshLatency();
  }, 5 * 1000);

  // pré-aquece TCP/TLS e o handler do servidor antes do envio real.
  // Quando passamos villageId, fazemos GET no screen=place da origem (mesmo handler do POST → cache quente).
  // Sem villageId, cai no overview (warmup genérico).
  function warmupConnection(villageId) {
    const url = villageId
      ? `/game.php?village=${villageId}&screen=place`
      : '/game.php?screen=overview';
    try { fetch(url, { credentials: 'include' }); } catch {}
  }

  // ---------- scheduler de comandos (Agendador) ----------
  const commandTimers = new Map();           // id → fire setTimeout
  const prepareTimers = new Map();           // id → prepare setTimeout
  const remeasureTimers = new Map();         // id → re-medição de latência setTimeout (T-30s)
  const preparedBundles = new Map();         // bundleLeadId → { hiddenFields, preparedAt }
  const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;   // 7 dias
  const PREPARE_LEAD_MS = 10 * 1000;         // pré-confirma 10s antes do executeAt
  const REMEASURE_LEAD_MS = 30 * 1000;       // re-mede latência 30s antes do executeAt

  // Acha todos os comandos do mesmo batch (mesma origem→alvo no mesmo "envio").
  // Critério: mesma sourceEntryId + mesmo targetCoords. O 1º (commandIndexInSource=0) é o lead.
  function getBundleSiblings(cmd) {
    for (const op of state.scheduler.operations) {
      const idx = op.commands.findIndex(c => c.id === cmd.id);
      if (idx === -1) continue;
      return op.commands.filter(c =>
        c.sourceEntryId === cmd.sourceEntryId &&
        c.targetCoords === cmd.targetCoords
      ).sort((a, b) => a.commandIndexInSource - b.commandIndexInSource);
    }
    return [cmd];
  }

  function scheduleCommand(cmd) {
    clearTimeout(commandTimers.get(cmd.id));
    clearTimeout(prepareTimers.get(cmd.id));
    clearTimeout(remeasureTimers.get(cmd.id));

    // Só agendamos o "lead" do batch (commandIndexInSource = 0). Os demais
    // ficam com status 'bundled' — vão junto no mesmo POST.
    if (cmd.commandIndexInSource > 0) {
      cmd.status = 'bundled';
      return;
    }

    // executeAt está em tempo do servidor. Converte pra tempo local pra usar setTimeout.
    // Antecipa o disparo pelo RTT/2 (rede).
    const compensation = latencyCompensation();
    const localExecuteAt = serverToLocalTs(cmd.executeAt);
    const fireDelay = localExecuteAt - Date.now() - compensation;

    if (fireDelay < -2000) {
      cmd.status = 'failed_overdue';
      cmd.lastError = `atrasado em ${Math.round(-fireDelay / 1000)}s`;
      getBundleSiblings(cmd).forEach(s => {
        if (s.id !== cmd.id) {
          s.status = 'failed_overdue';
          s.lastError = cmd.lastError;
        }
      });
      persist();
      pushSchedulerLog(`expirado: ${cmd.sourceCoords} → ${cmd.targetCoords} (${cmd.lastError})`);
      return;
    }
    if (fireDelay > MAX_TIMEOUT_MS) {
      cmd.status = 'pending';
      return;
    }

    cmd.status = 'scheduled';

    // PASSO 0 (re-medição de latência): 30s antes do fire, mede latência fresca em background.
    // Em prepareForFire (T-10s) só LEMOS o resultado, sem await — orçamento de 10s fica livre pro POST de confirm.
    const remeasureDelay = Math.max(0, fireDelay - REMEASURE_LEAD_MS);
    const remT = setTimeout(() => {
      if (state.scheduler.latency.manualOverride === 0) refreshLatency();
    }, remeasureDelay);
    remeasureTimers.set(cmd.id, remT);

    // PASSO 1 (pré-confirmação): roda 10s antes do fire (ou agora se já está dentro da janela)
    const prepareDelay = Math.max(0, fireDelay - PREPARE_LEAD_MS);
    const prepT = setTimeout(() => prepareForFire(cmd), prepareDelay);
    prepareTimers.set(cmd.id, prepT);

    // PASSO 2 (envio): no horário exato (compensado).
    // executeCommand verifica se prepareForFire concluiu; se não, falha.
    const fireT = setTimeout(() => executeCommand(cmd), Math.max(0, fireDelay));
    commandTimers.set(cmd.id, fireT);
  }

  async function prepareForFire(cmd) {
    prepareTimers.delete(cmd.id);
    // se já foi cancelado/abortado, não faz nada
    if (!['scheduled', 'pending'].includes(cmd.status)) return;

    // Re-cálculo do fireDelay com a latência mais recente (já refrescada pelo remeasureTimer em T-30s).
    // Sem await aqui — o orçamento de 10s vai inteiro pro POST de confirm.
    if (state.scheduler.latency.manualOverride === 0) {
      const compensation = latencyCompensation();
      const localExecuteAt = serverToLocalTs(cmd.executeAt);
      const newFireDelay = localExecuteAt - Date.now() - compensation;
      clearTimeout(commandTimers.get(cmd.id));
      const t = setTimeout(() => executeCommand(cmd), Math.max(0, newFireDelay));
      commandTimers.set(cmd.id, t);
    }

    cmd.status = 'confirming';
    persist();

    const bundle = getBundleSiblings(cmd);
    try {
      const prepared = await Game.prepareCommand({
        fromVillageId: cmd.sourceVillageId,
        x: parseInt(cmd.targetCoords.split('|')[0], 10),
        y: parseInt(cmd.targetCoords.split('|')[1], 10),
        units: bundle[0].units,        // 1ª wave
        type: cmd.type,
      });
      preparedBundles.set(cmd.id, prepared);
      // status volta pra 'scheduled' — vai disparar normal no fire timer
      cmd.status = 'scheduled';
      persist();
    } catch (e) {
      // pré-confirm falhou → cancela o fire e marca tudo como falha
      clearTimeout(commandTimers.get(cmd.id));
      commandTimers.delete(cmd.id);
      remeasureTimers.delete(cmd.id);
      bundle.forEach(s => {
        s.status = 'failed_request';
        s.lastError = `preparação falhou: ${e.message}`;
      });
      pushSchedulerLog(`FALHA pré-confirmação: ${cmd.sourceCoords} → ${cmd.targetCoords}: ${e.message}`);
      maybeFinalizeOperation(cmd);
      persist();
    }
  }

  async function executeCommand(cmd) {
    commandTimers.delete(cmd.id);
    remeasureTimers.delete(cmd.id);
    // se ainda está em 'confirming' (passo 1 não terminou), espera curto
    // até passar a 'scheduled' (sucesso) ou outro estado terminal
    let waitedMs = 0;
    while (cmd.status === 'confirming' && waitedMs < 5000) {
      await sleep(50); waitedMs += 50;
    }
    // se passo 1 falhou ou foi abortado, sai
    if (cmd.status !== 'scheduled') return;

    const prepared = preparedBundles.get(cmd.id);
    if (!prepared) {
      // não chegou a preparar (raro: timer 1 nem rodou). Faz fluxo all-in-one como fallback.
      return executeCommandFallback(cmd);
    }

    const bundle = getBundleSiblings(cmd);
    bundle.forEach(s => { s.status = 'sending'; });
    cmd.attempts++;
    persist();

    // pré-aquece conexão TCP ~150ms antes do envio (mantém socket quente, evita slow-start)
    const compensation = latencyCompensation();
    const target = serverToLocalTs(cmd.executeAt) - compensation;
    const warmupAt = target - 150;
    const driftBeforeWarmup = warmupAt - Date.now();
    if (driftBeforeWarmup > 0 && driftBeforeWarmup < 5000) {
      await sleep(driftBeforeWarmup);
      warmupConnection(cmd.sourceVillageId);   // GET no screen=place da origem (mesmo handler do POST)
    }

    // drift correction final em duas etapas: sleep grosso + busy-wait fino dos últimos 15ms.
    // setTimeout/sleep tem precisão ~4ms+ e atrasa sob carga; busy-wait com performance.now() é exato.
    const drift = target - Date.now();
    if (drift > 15 && drift < 1000) await sleep(drift - 15);
    const tHigh = performance.now() + Math.max(0, target - Date.now());
    while (performance.now() < tHigh) { /* spin curto até o instante exato */ }
    const finalDrift = target - Date.now(); // medido ANTES do POST (quanto atrasamos no busy-wait)

    try {
      const res = await Game.confirmCommand({
        fromVillageId: cmd.sourceVillageId,
        hiddenFields: prepared.hiddenFields,
        waves: bundle.map(s => ({ units: s.units })),
        type: cmd.type,
        catapultTarget: cmd.catapultTarget,
      });
      bundle.forEach(s => { s.status = 'sent'; s.serverResponse = res; });
      const skew = serverNow() - cmd.executeAt;
      const lat = state.scheduler.latency;
      const skewSign = skew >= 0 ? '+' : '';
      const totalAttacks = bundle.length;
      pushSchedulerLog(`enviado: ${cmd.sourceCoords} → ${cmd.targetCoords} (${cmd.type}, ${totalAttacks} ataque${totalAttacks > 1 ? 's' : ''}) · skew=${skewSign}${skew} rtt=${lat.avgRtt} oneWay=${lat.avgOneWay} comp=${compensation} drift=${finalDrift}`);
    } catch (e) {
      bundle.forEach(s => { s.status = 'failed_request'; s.lastError = e.message; });
      pushSchedulerLog(`FALHA: ${cmd.sourceCoords} → ${cmd.targetCoords}: ${e.message}`);
    }
    preparedBundles.delete(cmd.id);
    maybeFinalizeOperation(cmd);
    persist();
  }

  // fallback: faz prepare + confirm sem cache (caso o timer 1 não tenha rodado)
  async function executeCommandFallback(cmd) {
    const bundle = getBundleSiblings(cmd);
    bundle.forEach(s => { s.status = 'sending'; });
    cmd.attempts++;
    persist();

    try {
      const res = await Game.submitCommand({
        fromVillageId: cmd.sourceVillageId,
        x: parseInt(cmd.targetCoords.split('|')[0], 10),
        y: parseInt(cmd.targetCoords.split('|')[1], 10),
        waves: bundle.map(s => ({ units: s.units })),
        type: cmd.type,
        catapultTarget: cmd.catapultTarget,
      });
      bundle.forEach(s => { s.status = 'sent'; s.serverResponse = res; });
      const skew = serverNow() - cmd.executeAt;
      pushSchedulerLog(`enviado (fallback): ${cmd.sourceCoords} → ${cmd.targetCoords} · skew ${skew}ms`);
    } catch (e) {
      bundle.forEach(s => { s.status = 'failed_request'; s.lastError = e.message; });
      pushSchedulerLog(`FALHA: ${cmd.sourceCoords} → ${cmd.targetCoords}: ${e.message}`);
    }
    maybeFinalizeOperation(cmd);
    persist();
  }

  function maybeFinalizeOperation(cmd) {
    const op = state.scheduler.operations.find(o => o.commands.includes(cmd));
    if (!op || op.status !== 'executing') return;
    const TERMINAL = ['sent', 'failed_request', 'failed_overdue', 'aborted'];
    const allDone = op.commands.every(c => TERMINAL.includes(c.status));
    if (allDone) {
      op.status = 'done';
      op.finishedAt = Date.now();
      const sent = op.commands.filter(c => c.status === 'sent').length;
      const failed = op.commands.length - sent;
      pushSchedulerLog(`[${op.name}] concluída: ${sent} enviado(s)${failed ? `, ${failed} falha(s)` : ''}.`);
    }
  }

  function scheduleAllCommands(op) {
    op.commands.forEach(cmd => {
      if (cmd.status === 'pending' || cmd.status === 'scheduled') scheduleCommand(cmd);
    });
  }

  // chamado na inicialização. Re-agenda comandos pendentes; marca 'sending' interrompido como falha.
  function recoverScheduledCommands() {
    state.scheduler.operations.forEach(op => {
      if (op.status !== 'executing') return;
      op.commands.forEach(cmd => {
        if (cmd.status === 'sending') {
          // crashou no meio do envio → não sabemos se foi pra ida ou não
          cmd.status = 'failed_request';
          cmd.lastError = 'interrompido durante envio (verifique manualmente no jogo)';
          pushSchedulerLog(`recuperação: ${cmd.sourceCoords} → ${cmd.targetCoords} estava em envio quando aba fechou`);
        } else if (cmd.status === 'confirming') {
          // estava preparando — re-agenda do zero (vai reprepara a tempo)
          cmd.status = 'pending';
          scheduleCommand(cmd);
        } else if (['pending', 'scheduled', 'bundled'].includes(cmd.status)) {
          scheduleCommand(cmd);
        }
      });
      maybeFinalizeOperation(op.commands[0] || {});
    });
    persist();
  }

  // ticker de 1h pra pegar comandos com delay > MAX_TIMEOUT_MS quando entrarem na janela
  setInterval(() => {
    state.scheduler.operations.forEach(op => {
      if (op.status !== 'executing') return;
      op.commands.forEach(cmd => {
        if (cmd.status !== 'pending') return;
        if (commandTimers.has(cmd.id)) return;
        const delay = cmd.executeAt - Date.now();
        if (delay <= MAX_TIMEOUT_MS) scheduleCommand(cmd);
      });
    });
  }, 60 * 60 * 1000);

  // ---------- groups cache ----------
  let groupsCache = null;
  async function getGroups(force = false) {
    if (groupsCache && !force) return groupsCache;
    try {
      const fetched = await Game.fetchGroups();
      groupsCache = [GROUP_ALL, ...fetched];
    } catch (e) {
      pushLog('Erro ao listar grupos: ' + e.message);
      groupsCache = [GROUP_ALL];
    }
    return groupsCache;
  }

  // ---------- ui ----------
  const COLOR_BG = '#222831';
  const COLOR_ACCENT = '#00ADB5';

  GM_addStyle(`
    /* design tokens — paleta + spacing */
    :root {
      --mog-bg: #222831;
      --mog-bg-deep: #1b1f25;
      --mog-surface: #393E46;
      --mog-surface-2: #2c333a;
      --mog-surface-hover: #424952;
      --mog-border: #4a5159;
      --mog-border-soft: #2f353c;
      --mog-accent: #00ADB5;
      --mog-accent-hover: #00bfc8;
      --mog-accent-soft: rgba(0, 173, 181, 0.12);
      --mog-accent-strong: rgba(0, 173, 181, 0.28);
      --mog-text: #EEEEEE;
      --mog-text-dim: #a8b0b8;
      --mog-text-mute: #6b7178;
      --mog-success: #34d399;
      --mog-success-soft: rgba(52, 211, 153, 0.18);
      --mog-warn: #fbbf24;
      --mog-warn-soft: rgba(251, 191, 36, 0.18);
      --mog-error: #f87171;
      --mog-error-soft: rgba(248, 113, 113, 0.18);
      --mog-info: #7dd3fc;
      --mog-info-soft: rgba(125, 211, 252, 0.18);

      --mog-sp-1: 4px;
      --mog-sp-2: 8px;
      --mog-sp-3: 12px;
      --mog-sp-4: 16px;
      --mog-sp-5: 20px;
      --mog-sp-6: 24px;

      --mog-radius: 8px;
      --mog-radius-sm: 6px;
    }

    /* launcher lateral */
    .mog-launcher {
      position: fixed;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 38px;
      height: 56px;
      background: ${COLOR_BG};
      border: 1px solid var(--mog-border);
      border-left: none;
      border-radius: 0 12px 12px 0;
      cursor: pointer;
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${COLOR_ACCENT};
      font-weight: 800;
      font-size: 19px;
      letter-spacing: 0.5px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      box-shadow: 4px 0 16px rgba(0,0,0,0.4);
      transition: width 0.15s ease, color 0.15s ease, background 0.15s ease;
      user-select: none;
    }
    .mog-launcher:hover { width: 46px; color: var(--mog-bg); background: ${COLOR_ACCENT}; }
    .mog-launcher .mog-launcher-dot {
      position: absolute;
      bottom: 7px; right: 7px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--mog-text-mute);
    }
    .mog-launcher.mog-active .mog-launcher-dot {
      background: ${COLOR_ACCENT};
      box-shadow: 0 0 8px ${COLOR_ACCENT};
    }

    .mog-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 999990;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .mog-overlay.mog-show { opacity: 1; pointer-events: auto; }

    /* painel */
    .mog-panel {
      position: fixed;
      top: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(-12px);
      width: min(1180px, calc(100vw - 80px));
      height: calc(100vh - 64px);
      background: ${COLOR_BG};
      color: var(--mog-text);
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      border: 1px solid var(--mog-border);
      border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
      z-index: 999999;
      display: grid;
      grid-template-columns: 220px 1fr;
      grid-template-rows: 60px 1fr;
      grid-template-areas:
        "head head"
        "side main";
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      overflow: hidden;
    }
    .mog-panel.mog-open {
      opacity: 1; pointer-events: auto;
      transform: translateX(-50%) translateY(0);
    }

    /* header */
    .mog-head {
      grid-area: head;
      padding: 0 24px;
      border-bottom: 1px solid var(--mog-border-soft);
      display: flex; align-items: center; gap: 14px;
    }
    .mog-logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: ${COLOR_ACCENT};
      display: flex; align-items: center; justify-content: center;
      color: var(--mog-bg); font-weight: 800; font-size: 16px;
      flex-shrink: 0;
    }
    .mog-title-name { font-weight: 700; font-size: 14px; color: var(--mog-text); line-height: 1.1; }
    .mog-title-ver { font-size: 10px; color: var(--mog-text-mute); letter-spacing: 0.5px; margin-top: 2px; }
    .mog-head-spacer { flex: 1; }

    /* chips read-only no header (latência, relógio, captcha) */
    .mog-head-chips {
      display: flex; align-items: center; gap: 8px;
    }
    .mog-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 11px;
      border-radius: 999px;
      background: var(--mog-surface-2);
      color: var(--mog-text-dim);
      border: 1px solid var(--mog-border);
      font-size: 11px;
      font-weight: 600;
      font-family: 'Segoe UI', system-ui, sans-serif;
      letter-spacing: 0.3px;
      line-height: 1;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .mog-chip[hidden] { display: none; }
    .mog-chip-clock { font-variant-numeric: tabular-nums; }
    .mog-chip-rtt { font-variant-numeric: tabular-nums; }
    .mog-chip-rtt.mog-chip-ok { color: var(--mog-success); border-color: var(--mog-success-soft); }
    .mog-chip-rtt.mog-chip-warn { color: var(--mog-warn); border-color: var(--mog-warn-soft); }
    .mog-chip-rtt.mog-chip-error { color: var(--mog-error); border-color: var(--mog-error-soft); }
    .mog-chip-captcha {
      background: var(--mog-error-soft);
      color: var(--mog-error);
      border-color: var(--mog-error);
      cursor: pointer;
    }
    .mog-chip-captcha:hover { filter: brightness(1.1); }
    .mog-chip-captcha .mog-chip-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--mog-error);
      box-shadow: 0 0 8px var(--mog-error);
      animation: mog-chip-pulse 1.4s ease-in-out infinite;
    }
    @keyframes mog-chip-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .mog-toggle {
      padding: 8px 16px;
      border-radius: 999px;
      background: var(--mog-surface-2);
      color: var(--mog-text-mute);
      border: 1px solid var(--mog-border);
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      display: flex; align-items: center; gap: 7px;
      transition: all 0.15s;
    }
    .mog-toggle::before {
      content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--mog-text-mute);
    }
    .mog-toggle.mog-on { background: ${COLOR_ACCENT}; color: var(--mog-bg); border-color: ${COLOR_ACCENT}; }
    .mog-toggle.mog-on::before { background: #fff; box-shadow: 0 0 6px rgba(255,255,255,0.8); }
    .mog-toggle:hover { filter: brightness(1.1); }

    .mog-close {
      background: none; border: none; color: var(--mog-text-mute);
      font-size: 22px; cursor: pointer; line-height: 1;
      padding: 4px 8px; border-radius: 6px;
    }
    .mog-close:hover { background: var(--mog-surface-2); color: var(--mog-text); }

    /* sidebar */
    .mog-side {
      grid-area: side;
      border-right: 1px solid var(--mog-border-soft);
      padding: 16px 0;
      overflow-y: auto;
      background: var(--mog-bg-deep);
    }
    .mog-side-section {
      margin-bottom: 18px;
    }
    .mog-side-title {
      padding: 0 18px 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      color: var(--mog-text-mute);
      display: flex; align-items: center; gap: 6px;
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }
    .mog-side-title:hover { color: var(--mog-text-dim); }
    .mog-side-caret {
      display: inline-block;
      transition: transform 0.15s ease;
      font-size: 9px;
      width: 10px;
      text-align: center;
    }
    .mog-side-section.mog-side-collapsed .mog-side-caret {
      transform: rotate(-90deg);
    }
    .mog-side-items {
      overflow: hidden;
      max-height: 600px;
      transition: max-height 0.2s ease;
    }
    .mog-side-section.mog-side-collapsed .mog-side-items {
      max-height: 0;
    }
    .mog-side-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 18px;
      cursor: pointer;
      color: var(--mog-text-dim);
      font-size: 12.5px;
      font-weight: 500;
      border-left: 2px solid transparent;
      transition: all 0.15s;
    }
    .mog-side-item:hover { background: var(--mog-surface-2); color: var(--mog-text); }
    .mog-side-item.mog-side-active {
      color: ${COLOR_ACCENT};
      background: rgba(255,96,68,0.08);
      border-left-color: ${COLOR_ACCENT};
      font-weight: 600;
    }
    .mog-side-item.mog-side-disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .mog-side-item.mog-side-disabled:hover { background: transparent; color: var(--mog-text-dim); }
    .mog-side-icon {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px;
    }
    .mog-side-icon img { width: 16px; height: 16px; image-rendering: pixelated; }
    .mog-side-badge {
      margin-left: auto;
      font-size: 9px;
      padding: 2px 6px;
      background: var(--mog-border);
      color: var(--mog-text-mute);
      border-radius: 999px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      font-weight: 700;
    }
    .mog-side-status {
      margin-left: auto;
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--mog-border);
      flex: 0 0 auto;
      transition: background 0.2s, box-shadow 0.2s;
    }
    .mog-side-status.mog-side-status-on {
      background: var(--mog-success);
      box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
    }

    /* main */
    .mog-main {
      grid-area: main;
      display: grid;
      grid-template-rows: 1fr auto;
      overflow: hidden;
    }
    .mog-content {
      overflow-y: auto;
      overflow-x: hidden;
      padding: 20px 16px;
      min-width: 0;
    }
    .mog-content::-webkit-scrollbar { width: 8px; }
    .mog-content::-webkit-scrollbar-thumb { background: var(--mog-border); border-radius: 4px; }
    .mog-content::-webkit-scrollbar-thumb:hover { background: ${COLOR_ACCENT}; }

    .mog-section-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 16px;
    }
    .mog-section-head h2 {
      margin: 0; font-size: 16px; font-weight: 700; color: var(--mog-text);
      letter-spacing: 0.2px;
    }
    .mog-section-head p {
      margin: 4px 0 0; font-size: 11.5px; color: var(--mog-text-mute);
    }

    .mog-add-btn {
      background: ${COLOR_ACCENT}; color: var(--mog-bg); border: none;
      padding: 8px 14px; border-radius: 7px;
      font-size: 11px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: filter 0.15s;
    }
    .mog-add-btn:hover { filter: brightness(1.1); }

    /* grid head */
    .mog-grid-head {
      display: grid;
      grid-template-columns: 36px minmax(100px, 1fr) minmax(90px, 0.8fr) repeat(10, minmax(0, 1.1fr)) minmax(86px, 0.7fr) 88px 56px;
      gap: 4px;
      align-items: end;
      padding: 0 10px 10px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--mog-text-mute);
      min-width: 0;
      box-sizing: border-box;
    }
    .mog-grid-head > div { text-align: center; min-width: 0; }
    .mog-grid-head .mog-h-name { text-align: left; }
    .mog-grid-head .mog-h-unit img {
      width: 22px; height: 22px; image-rendering: pixelated; opacity: 0.7;
    }

    /* row */
    .mog-prow {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      margin-bottom: 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .mog-prow.mog-prow-on {
      border-color: ${COLOR_ACCENT};
      box-shadow: 0 0 0 1px rgba(255,96,68,0.2);
    }
    .mog-prow-main {
      display: grid;
      grid-template-columns: 36px minmax(100px, 1fr) minmax(90px, 0.8fr) repeat(10, minmax(0, 1.1fr)) minmax(86px, 0.7fr) 88px 56px;
      gap: 4px;
      align-items: center;
      padding: 14px 10px;
      min-width: 0;
      box-sizing: border-box;
    }

    .mog-tg {
      width: 34px; height: 18px; border-radius: 999px;
      background: var(--mog-border); cursor: pointer; position: relative;
      transition: background 0.15s;
    }
    .mog-tg::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: var(--mog-text-mute);
      transition: all 0.15s;
    }
    .mog-prow.mog-prow-on .mog-tg { background: ${COLOR_ACCENT}; }
    .mog-prow.mog-prow-on .mog-tg::after { left: 18px; background: #fff; }

    .mog-pname {
      background: transparent; border: 1px solid transparent;
      color: var(--mog-text); font-size: 13px; font-weight: 600;
      padding: 7px 9px; border-radius: 6px;
      width: 100%; outline: none; box-sizing: border-box;
    }
    .mog-pname:hover { background: var(--mog-surface-hover); }
    .mog-pname:focus { background: var(--mog-surface-hover); border-color: ${COLOR_ACCENT}; }

    .mog-input, .mog-select {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 6px; padding: 7px 6px; color: var(--mog-text);
      font-family: inherit; font-size: 12px; outline: none;
      width: 100%; min-width: 0; box-sizing: border-box; text-align: center;
    }
    .mog-select { text-align: left; padding: 7px 10px; }
    .mog-input:focus, .mog-select:focus { border-color: ${COLOR_ACCENT}; }
    .mog-input[type="number"] {
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .mog-input[type="number"]::-webkit-inner-spin-button,
    .mog-input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .mog-target {
      padding: 9px 1px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--mog-text);
      text-align: center;
      letter-spacing: -0.3px;
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";
    }
    .mog-target.mog-target-off {
      color: var(--mog-text-mute);
      font-weight: 400;
    }
    .mog-target:focus {
      background: var(--mog-surface-2);
      color: var(--mog-text);
    }

    .mog-interval {
      display: flex; gap: 4px; align-items: center; justify-content: center;
      font-size: 11px; color: var(--mog-text-mute);
      min-width: 0;
    }
    .mog-interval input {
      flex: 1; min-width: 0; width: auto;
      padding: 6px 4px; max-width: 42px;
    }

    .mog-status-cell {
      font-size: 10.5px; color: var(--mog-text-mute);
      text-align: center;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 4px;
    }
    .mog-status-cell.mog-status-active { color: ${COLOR_ACCENT}; font-weight: 600; }

    .mog-prow-actions {
      display: flex; gap: 2px; align-items: center; justify-content: flex-end;
      padding-left: 4px;
    }
    .mog-iconbtn {
      background: transparent; border: 1px solid transparent;
      color: var(--mog-text-mute); cursor: pointer;
      padding: 6px 8px; border-radius: 6px; font-size: 14px;
      line-height: 1; transition: all 0.15s;
    }
    .mog-iconbtn:hover { background: var(--mog-surface-hover); color: var(--mog-text); }
    .mog-iconbtn.mog-iconbtn-danger:hover { background: var(--mog-error-soft); color: ${COLOR_ACCENT}; }

    .mog-prow-expand {
      border-top: 1px solid var(--mog-border-soft);
      padding: 14px 16px;
      display: none;
      background: var(--mog-bg-deep);
      border-radius: 0 0 10px 10px;
    }
    .mog-prow.mog-prow-expanded .mog-prow-expand { display: block; }
    .mog-prow.mog-prow-expanded .mog-prow-main { border-radius: 10px 10px 0 0; }

    /* ======= BUILDER (Construtor) ======= */
    .mog-grid-head.mog-grid-builder,
    .mog-prow-main.mog-prow-builder {
      grid-template-columns: 36px minmax(120px, 1fr) minmax(110px, 0.9fr) minmax(160px, 1.4fr) minmax(110px, 0.7fr) minmax(86px, 0.7fr) 88px;
    }
    .mog-builder-adv { grid-template-columns: 1fr !important; }
    .mog-bgroup-wide { grid-column: span 1; }
    .mog-template-preview { margin-top: 4px; }
    .mog-seq-table {
      width: 100%; border-collapse: collapse;
      font-size: 12.5px; color: var(--mog-text-dim);
    }
    .mog-seq-table thead th {
      text-align: left; padding: 3px 8px;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: var(--mog-text-mute); border-bottom: 1px solid var(--mog-border);
    }
    .mog-seq-table tbody tr:nth-child(even) { background: var(--mog-surface-2); }
    .mog-seq-table tbody tr:hover { background: var(--mog-surface-hover); }
    .mog-seq-table td { padding: 3px 8px; }
    .mog-seq-num  { color: var(--mog-text-mute); font-size: 11px; white-space: nowrap; min-width: 36px; }
    .mog-seq-icon { font-size: 14px; width: 22px; }
    .mog-seq-count { color: ${COLOR_ACCENT}; font-weight: 600; text-align: right; }
    .mog-seq-more  { color: var(--mog-text-mute); font-size: 11px; padding: 4px 8px; }
    .mog-tpl-more { color: ${COLOR_ACCENT}; font-weight: 600; }
    .mog-import-block {
      background: var(--mog-surface-2); border: 1px solid var(--mog-border-soft);
      border-radius: 8px; padding: 14px; margin-bottom: 14px;
    }
    .mog-import-block textarea {
      width: 100%; box-sizing: border-box;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      color: var(--mog-text); border-radius: 6px; padding: 8px;
      font-family: monospace; font-size: 11.5px;
      resize: vertical; min-height: 50px;
    }
    .mog-import-msg { font-size: 12px; color: var(--mog-text-mute); align-self: center; }
    .mog-import-msg.mog-import-err { color: var(--mog-error); }
    .mog-templates-list { display: flex; flex-direction: column; gap: 8px; }
    .mog-tpl-row {
      background: var(--mog-surface-2); border: 1px solid var(--mog-border-soft);
      border-radius: 8px; padding: 10px 14px;
    }
    .mog-tpl-head {
      display: grid; grid-template-columns: minmax(150px, 1fr) auto 80px;
      gap: 10px; align-items: center;
    }
    .mog-tpl-meta { font-size: 11px; color: var(--mog-text-mute); text-align: right; }
    .mog-tpl-preview { margin-top: 8px; }
    .mog-btn-on {
      background: ${COLOR_ACCENT} !important;
      color: var(--mog-bg) !important;
      border-color: ${COLOR_ACCENT} !important;
    }
    .mog-label {
      display: block; font-size: 11px; font-weight: 700;
      text-transform: uppercase; color: var(--mog-text-mute); letter-spacing: 0.4px;
      margin-bottom: 6px;
    }

    .mog-bgroups { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .mog-bgroup {
      background: var(--mog-surface-2); border: 1px solid var(--mog-border-soft);
      border-radius: 8px; padding: 14px 16px;
      display: flex; flex-direction: column;
    }
    .mog-bgroup-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: ${COLOR_ACCENT}; letter-spacing: 0.5px; margin-bottom: 4px;
    }
    .mog-bgroup-units {
      font-size: 10.5px; color: var(--mog-text-mute); margin-bottom: 12px;
      line-height: 1.4;
    }
    .mog-bgroup-fields {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      margin-top: auto;
    }
    .mog-bunit-cell { display: flex; flex-direction: column; gap: 4px; }
    .mog-bunit-cell label { font-size: 9.5px; color: var(--mog-text-mute); text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .mog-bunit-cell input {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 6px; padding: 7px 8px; color: var(--mog-text);
      font-family: inherit; font-size: 12px; outline: none;
      width: 100%; box-sizing: border-box; text-align: center;
    }
    .mog-bunit-cell input:focus { border-color: ${COLOR_ACCENT}; }

    .mog-prow-tools {
      display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end;
    }
    .mog-btn {
      background: ${COLOR_ACCENT}; color: var(--mog-bg); border: none;
      padding: 9px 18px; border-radius: 7px;
      font-size: 13px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: filter 0.15s;
    }
    .mog-btn:hover { filter: brightness(1.1); }
    .mog-btn.mog-btn-ghost { background: var(--mog-surface-hover); color: var(--mog-text-dim); }
    .mog-btn.mog-btn-ghost:hover { background: var(--mog-border); color: #fff; filter: none; }

    .mog-empty {
      text-align: center; color: var(--mog-text-mute); padding: 36px 16px;
      font-size: 12px; font-style: italic;
      background: var(--mog-surface-2);
      border: 1px dashed var(--mog-border);
      border-radius: 10px;
    }

    .mog-placeholder {
      text-align: center; padding: 80px 20px; color: var(--mog-text-mute);
    }
    .mog-placeholder-icon { font-size: 36px; margin-bottom: 12px; }
    .mog-placeholder-title { color: var(--mog-text-dim); font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .mog-placeholder-text { font-size: 12px; }

    /* wizard (Agendador) */
    .mog-wiz-head {
      display: flex; align-items: center; gap: 12px;
      padding-bottom: 14px; margin-bottom: 16px;
      border-bottom: 1px solid var(--mog-border-soft);
    }
    .mog-wiz-back {
      background: transparent; border: 1px solid var(--mog-border);
      color: var(--mog-text-dim); padding: 6px 12px; border-radius: 6px;
      font-size: 11px; cursor: pointer; font-weight: 600;
    }
    .mog-wiz-back:hover { color: var(--mog-text); border-color: var(--mog-border); }
    .mog-wiz-title { font-size: 14px; font-weight: 700; color: var(--mog-text); flex: 1; }
    .mog-wiz-name {
      background: transparent; border: 1px solid transparent;
      color: var(--mog-text); font-size: 14px; font-weight: 700;
      padding: 4px 8px; border-radius: 5px;
      flex: 1; outline: none; min-width: 200px;
    }
    .mog-wiz-name:hover { background: var(--mog-surface-hover); }
    .mog-wiz-name:focus { background: var(--mog-surface-hover); border-color: ${COLOR_ACCENT}; }
    .mog-wiz-steps { display: flex; gap: 4px; align-items: center; }
    .mog-wiz-step {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--mog-text-mute); font-weight: 600;
      padding: 5px 10px; border-radius: 999px;
      background: var(--mog-surface-2); border: 1px solid var(--mog-border);
    }
    .mog-wiz-step.mog-wiz-step-active {
      color: var(--mog-bg); background: ${COLOR_ACCENT}; border-color: ${COLOR_ACCENT};
    }
    .mog-wiz-step.mog-wiz-step-done { color: var(--mog-text-dim); }
    .mog-wiz-step-num {
      width: 18px; height: 18px; border-radius: 50%;
      background: var(--mog-border); color: var(--mog-text-mute); font-size: 10px;
      display: inline-flex; align-items: center; justify-content: center;
      font-weight: 700;
    }
    .mog-wiz-step.mog-wiz-step-active .mog-wiz-step-num { background: #fff; color: ${COLOR_ACCENT}; }
    .mog-wiz-step-sep { color: var(--mog-border); font-size: 11px; }

    .mog-wiz-section {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .mog-wiz-section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: ${COLOR_ACCENT}; letter-spacing: 0.5px; margin-bottom: 10px;
      display: flex; align-items: center; justify-content: space-between;
    }

    .mog-wiz-textarea {
      width: 100%; box-sizing: border-box;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 6px; padding: 10px 12px; color: var(--mog-text);
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 12px; line-height: 1.5; outline: none;
      resize: vertical; min-height: 80px;
    }
    .mog-wiz-textarea:focus { border-color: ${COLOR_ACCENT}; }

    .mog-wiz-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
    .mog-wiz-hint { font-size: 11px; color: var(--mog-text-mute); flex: 1; }

    /* tabela de alvos */
    .mog-tg-head, .mog-tg-row {
      display: grid;
      grid-template-columns: 90px 1fr 70px 60px 60px 60px 36px;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
    }
    .mog-tg-row .mog-tg-arrival {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11.5px; color: var(--mog-text-dim);
      text-align: center;
    }
    /* layout da seção "Padrão de chegada" */
    .mog-wiz-default-arrival {
      display: flex; gap: 12px; align-items: stretch;
    }
    .mog-wiz-fld { display: flex; flex-direction: column; gap: 4px; }
    .mog-wiz-fld label {
      font-size: 10.5px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.4px; color: var(--mog-text-mute);
    }
    .mog-wiz-fld input[type="text"],
    .mog-wiz-fld input[type="datetime-local"],
    .mog-wiz-fld input[type="number"] {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 6px; padding: 8px 10px; color: var(--mog-text);
      font-family: 'JetBrains Mono', 'Consolas', monospace; font-size: 12px; outline: none;
      width: 100%; box-sizing: border-box;
    }
    .mog-wiz-fld input[type="text"]:focus,
    .mog-wiz-fld input[type="datetime-local"]:focus,
    .mog-wiz-fld input[type="number"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-wiz-fld input.mog-input-error,
    .mog-wiz-fld input.mog-input-error:focus { border-color: var(--mog-error); }
    .mog-wiz-fld input[type="number"] {
      -moz-appearance: textfield; text-align: center; font-weight: 600;
    }
    .mog-wiz-fld input[type="number"]::-webkit-inner-spin-button,
    .mog-wiz-fld input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .mog-tg-head {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--mog-text-mute);
      border-bottom: 1px solid var(--mog-border-soft);
    }
    .mog-tg-head > div { text-align: center; }
    .mog-tg-head > div:nth-child(1) { text-align: left; }
    .mog-tg-row {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      border-radius: 8px;
      margin-top: 6px;
    }
    .mog-tg-row.mog-tg-invalid { border-color: var(--mog-error); }
    .mog-tg-row .mog-tg-coords {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600; color: ${COLOR_ACCENT};
      font-size: 12.5px;
    }
    .mog-tg-row input[type="datetime-local"] {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 5px; padding: 6px 8px; color: var(--mog-text);
      font-family: inherit; font-size: 11.5px; outline: none;
      width: 100%; min-width: 0; box-sizing: border-box;
    }
    .mog-tg-row input[type="datetime-local"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-tg-row input[type="number"] {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 5px; padding: 7px 4px; color: var(--mog-text);
      font-size: 12px; font-weight: 600; outline: none;
      width: 100%; min-width: 0; box-sizing: border-box; text-align: center;
      -moz-appearance: textfield;
    }
    .mog-tg-row input[type="number"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-tg-row input[type="number"]::-webkit-inner-spin-button,
    .mog-tg-row input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .mog-tg-empty {
      text-align: center; color: var(--mog-text-mute); padding: 24px;
      font-size: 12px; font-style: italic;
    }

    .mog-wiz-foot {
      display: flex; gap: 10px; align-items: center;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--mog-border-soft);
    }
    .mog-wiz-foot-spacer { flex: 1; }

    /* lista de operações */
    .mog-op-card {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 10px;
      display: grid;
      grid-template-columns: 1fr 110px auto;
      gap: 14px;
      align-items: center;
    }
    .mog-op-card.mog-op-executing { border-color: ${COLOR_ACCENT}; }
    .mog-op-name { font-size: 13.5px; font-weight: 700; color: var(--mog-text); }
    .mog-op-meta { font-size: 11px; color: var(--mog-text-mute); margin-top: 3px; }
    .mog-op-status {
      font-size: 11px; font-weight: 600;
      text-align: center;
      padding: 5px 10px; border-radius: 999px;
      background: var(--mog-surface-hover); color: var(--mog-text-dim);
      text-transform: uppercase; letter-spacing: 0.4px;
    }
    .mog-op-status.mog-op-status-draft { background: var(--mog-border); color: var(--mog-text-mute); }
    .mog-op-status.mog-op-status-calculated { background: var(--mog-info-soft); color: var(--mog-info); }
    .mog-op-status.mog-op-status-executing { background: ${COLOR_ACCENT}; color: var(--mog-bg); }
    .mog-op-status.mog-op-status-done { background: var(--mog-success-soft); color: var(--mog-success); }
    .mog-op-status.mog-op-status-aborted { background: var(--mog-error-soft); color: var(--mog-error); }
    .mog-op-actions { display: flex; gap: 6px; }

    /* lotes (passo 2) */
    .mog-lot {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      margin-bottom: 12px;
    }
    /* quando dentro de mog-wiz-section, o lot card herda a moldura — sem dupla borda */
    .mog-wiz-section > .mog-lot.mog-lot-inline {
      background: transparent;
      border: none;
      margin: 0;
    }
    .mog-wiz-section > .mog-lot.mog-lot-inline > .mog-lot-body {
      padding: 0;
    }
    .mog-lot-head {
      display: grid;
      grid-template-columns: 24px 1fr 110px 90px 36px;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      cursor: pointer;
      border-bottom: 1px solid transparent;
    }
    .mog-lot.mog-lot-open .mog-lot-head { border-bottom-color: var(--mog-border-soft); }
    .mog-lot-caret {
      display: inline-block;
      transition: transform 0.15s ease;
      font-size: 10px;
      color: var(--mog-text-mute);
    }
    .mog-lot.mog-lot-open .mog-lot-caret { transform: rotate(90deg); }
    .mog-lot-name {
      background: transparent; border: 1px solid transparent;
      color: var(--mog-text); font-size: 13px; font-weight: 600;
      padding: 5px 8px; border-radius: 5px;
      width: 100%; outline: none; box-sizing: border-box;
    }
    .mog-lot-name:hover { background: var(--mog-surface-hover); }
    .mog-lot-name:focus { background: var(--mog-surface-hover); border-color: ${COLOR_ACCENT}; }
    .mog-lot-meta {
      font-size: 11px; color: var(--mog-text-mute); text-align: right;
    }
    .mog-lot-type {
      padding: 4px 10px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; text-align: center;
      background: var(--mog-surface-hover); color: var(--mog-text-dim);
    }
    .mog-lot-type.mog-lot-type-attack { background: var(--mog-error-soft); color: var(--mog-error); }
    .mog-lot-type.mog-lot-type-support { background: var(--mog-success-soft); color: var(--mog-success); }

    .mog-lot-body { padding: 14px; display: none; }
    .mog-lot.mog-lot-open .mog-lot-body { display: block; }

    .mog-lot-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .mog-lot-fld {
      display: flex; flex-direction: column; gap: 4px;
      margin-bottom: 10px;
    }
    .mog-lot-fld label {
      font-size: 10px; color: var(--mog-text-mute); text-transform: uppercase;
      letter-spacing: 0.4px; font-weight: 600;
    }
    .mog-lot-import-row {
      display: flex; gap: 8px; align-items: center;
    }
    .mog-lot-import-row select { flex: 1; }
    .mog-lot-import-row button { width: auto; padding: 7px 12px; font-size: 11px; }

    .mog-lot-villages {
      max-height: 100px; overflow-y: auto;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border-soft);
      border-radius: 6px; padding: 8px 10px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11px; color: var(--mog-text-dim); line-height: 1.6;
    }
    textarea.mog-lot-villages-edit {
      width: 100%; min-height: 60px;
      box-sizing: border-box;
      resize: vertical;
      outline: none; color: var(--mog-text);
      white-space: normal;
      word-spacing: 4px;
    }
    textarea.mog-lot-villages-edit:focus { border-color: ${COLOR_ACCENT}; }
    textarea.mog-lot-villages-edit::placeholder {
      color: var(--mog-text-mute); font-style: italic;
    }
    .mog-lot-villages::-webkit-scrollbar { width: 6px; }
    .mog-lot-villages::-webkit-scrollbar-thumb { background: var(--mog-border); border-radius: 3px; }

    /* waves (comandos por origem→alvo) */
    .mog-wave {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex;
      gap: 10px;
      align-items: stretch;
    }
    .mog-wave-num {
      flex: 0 0 auto;
      width: 28px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 6px;
      font-size: 11px; font-weight: 700; color: ${COLOR_ACCENT};
      letter-spacing: 0.4px;
    }
    .mog-wave-num-label {
      font-size: 9px; color: var(--mog-text-mute); text-transform: uppercase;
      letter-spacing: 0.4px; font-weight: 700;
    }
    .mog-wave-grid {
      flex: 1;
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 3px;
      min-width: 0;
    }
    .mog-wave-del {
      flex: 0 0 auto;
      align-self: center;
    }
    .mog-wave-add {
      background: transparent;
      border: 1px dashed var(--mog-border);
      color: ${COLOR_ACCENT};
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 11px; font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: all 0.15s; width: 100%;
    }
    .mog-wave-add:hover { background: rgba(255,96,68,0.08); border-color: ${COLOR_ACCENT}; }

    /* tabela de comandos (passo 3) */
    .mog-cmd-toolbar {
      display: flex; gap: 10px; align-items: center;
      margin-bottom: 14px;
    }
    .mog-cmd-toolbar .mog-wiz-hint { flex: 1; }
    .mog-cmd-summary {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 14px;
      display: flex; gap: 16px;
      font-size: 11.5px; color: var(--mog-text-dim);
    }
    .mog-cmd-summary strong { color: var(--mog-text); font-weight: 700; }
    .mog-cmd-summary-pill {
      padding: 3px 10px; border-radius: 999px;
      font-weight: 700; letter-spacing: 0.4px;
      text-transform: uppercase; font-size: 10px;
    }
    .mog-cmd-summary-ok { background: var(--mog-success-soft); color: var(--mog-success); }
    .mog-cmd-summary-warn { background: var(--mog-warn-soft); color: var(--mog-warn); }
    .mog-cmd-summary-err { background: var(--mog-error-soft); color: var(--mog-error); }

    .mog-cmd-table {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .mog-cmd-thead, .mog-cmd-row {
      display: grid;
      grid-template-columns: 90px 90px 1.6fr 60px 70px 150px 70px 150px 30px;
      gap: 6px; align-items: center;
      padding: 8px 10px;
      font-size: 11px;
    }
    .mog-cmd-thead {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--mog-text-mute);
      background: var(--mog-surface-2);
      border-bottom: 1px solid var(--mog-border-soft);
      padding-top: 10px; padding-bottom: 10px;
    }
    .mog-cmd-thead > div { text-align: center; }
    .mog-cmd-thead > div:nth-child(3) { text-align: left; }
    .mog-cmd-row {
      border-top: 1px solid var(--mog-border-soft);
      position: relative;
    }
    .mog-cmd-row:first-child { border-top: none; }
    .mog-cmd-row:hover { background: var(--mog-surface-2); }
    /* tarja vermelha esquerda: indica comando inválido (atrasado) */
    .mog-cmd-row-late {
      background: var(--mog-error-soft);
      box-shadow: inset 4px 0 0 0 var(--mog-error);
    }
    .mog-cmd-row-late:hover { background: var(--mog-error-soft); }
    .mog-cmd-row > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mog-cmd-row .mog-cmd-units { white-space: normal; line-height: 1.4; font-size: 10.5px; }
    .mog-cmd-row .mog-cmd-units img {
      width: 14px; height: 14px; image-rendering: pixelated;
      vertical-align: middle; margin: 0 1px 0 4px;
    }
    .mog-cmd-row .mog-cmd-coords {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600; color: ${COLOR_ACCENT};
      text-align: center;
    }
    .mog-cmd-row .mog-cmd-arr {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px; color: var(--mog-text-dim); text-align: center;
    }
    .mog-cmd-row input[type="number"] {
      width: 100%; box-sizing: border-box;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 5px; padding: 5px 4px; color: var(--mog-text);
      font-size: 11.5px; text-align: center; outline: none;
      font-variant-numeric: tabular-nums;
      -moz-appearance: textfield;
    }
    .mog-cmd-row input[type="number"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-cmd-row input[type="number"]::-webkit-inner-spin-button,
    .mog-cmd-row input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .mog-cmd-status {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; padding: 3px 6px; border-radius: 4px;
      text-align: center;
    }
    .mog-cmd-st-ok { background: var(--mog-success-soft); color: var(--mog-success); }
    .mog-cmd-st-late { background: var(--mog-warn-soft); color: var(--mog-warn); }
    .mog-cmd-st-err { background: var(--mog-error-soft); color: var(--mog-error); }

    .mog-unreach {
      background: var(--mog-error-soft); border: 1px solid var(--mog-error-soft);
      border-radius: 10px; padding: 12px 14px;
      margin-bottom: 14px;
    }
    .mog-unreach-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--mog-error); margin-bottom: 8px;
    }
    .mog-unreach ul { margin: 0; padding-left: 18px; font-size: 11px; color: var(--mog-text-dim); }
    .mog-unreach li { padding: 1px 0; }

    /* passo 4 — confirmar */
    .mog-confirm-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .mog-confirm-stat {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 14px 16px;
      text-align: center;
    }
    .mog-confirm-stat-num {
      font-size: 22px; font-weight: 800;
      color: ${COLOR_ACCENT};
      font-variant-numeric: tabular-nums;
    }
    .mog-confirm-stat-label {
      font-size: 10px; color: var(--mog-text-mute);
      text-transform: uppercase; letter-spacing: 0.5px;
      font-weight: 700; margin-top: 4px;
    }
    .mog-confirm-warn {
      background: var(--mog-warn-soft);
      border: 1px solid var(--mog-warn);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      display: flex; gap: 12px; align-items: flex-start;
      font-size: 12px; color: var(--mog-warn);
      line-height: 1.5;
    }
    .mog-confirm-warn-icon { font-size: 18px; flex-shrink: 0; line-height: 1; }
    .mog-confirm-warn strong { color: #fff; }
    .mog-confirm-window {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .mog-confirm-window-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: var(--mog-text-mute); letter-spacing: 0.5px; margin-bottom: 8px;
    }
    .mog-confirm-window-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 0; font-size: 12px; color: var(--mog-text-dim);
    }
    .mog-confirm-window-row strong {
      color: var(--mog-text); font-weight: 700;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
    }
    .mog-activate-btn {
      width: 100%;
      padding: 16px;
      background: ${COLOR_ACCENT};
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      cursor: pointer;
      transition: filter 0.15s;
    }
    .mog-activate-btn:hover { filter: brightness(1.12); }
    .mog-activate-btn:disabled {
      background: var(--mog-border); color: var(--mog-text-mute); cursor: not-allowed;
      filter: none;
    }

    /* painel de agendamentos (dashboard) */
    .mog-dash-toolbar {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      display: flex; gap: 14px; align-items: center;
    }
    .mog-dash-toolbar-section {
      display: flex; align-items: center; gap: 8px;
      font-size: 11.5px; color: var(--mog-text-dim);
    }
    .mog-dash-toolbar-section strong { color: var(--mog-text); font-weight: 600; }
    .mog-dash-toolbar-spacer { flex: 1; }
    .mog-dash-toolbar input[type="number"] {
      width: 80px;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 5px; padding: 6px 8px; color: var(--mog-text);
      font-size: 11.5px; text-align: center; outline: none;
    }
    .mog-dash-toolbar input[type="number"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-dash-toggle {
      width: 34px; height: 18px; border-radius: 999px;
      background: var(--mog-border); cursor: pointer; position: relative;
      transition: background 0.15s; flex-shrink: 0;
    }
    .mog-dash-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: var(--mog-text-mute);
      transition: all 0.15s;
    }
    .mog-dash-toggle.mog-dash-toggle-on { background: ${COLOR_ACCENT}; }
    .mog-dash-toggle.mog-dash-toggle-on::after { left: 18px; background: #fff; }

    .mog-dash-table {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .mog-dash-thead, .mog-dash-row {
      display: grid;
      grid-template-columns: 80px 70px 80px 80px 1fr 110px 110px 80px 30px;
      gap: 6px; align-items: center;
      padding: 8px 12px;
      font-size: 11px;
    }
    .mog-dash-thead {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--mog-text-mute);
      background: var(--mog-surface-2);
      border-bottom: 1px solid var(--mog-border-soft);
    }
    .mog-dash-thead > div { text-align: center; }
    .mog-dash-thead > div:nth-child(5) { text-align: left; }

    /* coords clicáveis */
    .mog-dash-coords-link {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600; color: ${COLOR_ACCENT};
      text-align: center; font-size: 11.5px;
      text-decoration: none;
      display: block;
      transition: filter 0.15s;
    }
    .mog-dash-coords-link:hover { filter: brightness(1.3); text-decoration: underline; }

    /* badge de tipo */
    .mog-dash-type {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; padding: 3px 6px; border-radius: 4px;
      text-align: center;
    }
    .mog-dash-type-attack { background: var(--mog-error-soft); color: var(--mog-error); }
    .mog-dash-type-support { background: var(--mog-success-soft); color: var(--mog-success); }
    .mog-dash-row { border-top: 1px solid var(--mog-border-soft); }
    .mog-dash-row:first-child { border-top: none; }
    .mog-dash-row:hover { background: var(--mog-surface-2); }
    .mog-dash-row > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mog-dash-row .mog-dash-units { white-space: normal; line-height: 1.4; font-size: 10.5px; }
    .mog-dash-row .mog-dash-units img {
      width: 14px; height: 14px; image-rendering: pixelated;
      vertical-align: middle; margin: 0 1px 0 4px;
    }
    .mog-dash-row .mog-dash-coords {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600; color: ${COLOR_ACCENT};
      text-align: center; font-size: 11.5px;
    }
    .mog-dash-row .mog-dash-when {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px; color: var(--mog-text-dim); text-align: center;
    }
    .mog-dash-row .mog-dash-countdown {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 700; text-align: center;
      color: var(--mog-success); font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .mog-dash-row .mog-dash-countdown.mog-dash-soon { color: ${COLOR_ACCENT}; }
    .mog-dash-row .mog-dash-countdown.mog-dash-overdue { color: var(--mog-text-mute); }
    .mog-dash-row.mog-dash-row-sent { opacity: 0.5; }
    .mog-dash-row.mog-dash-row-failed { background: rgba(255, 138, 122, 0.06); }

    .mog-dash-status {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; padding: 3px 6px; border-radius: 4px;
      text-align: center;
    }
    .mog-dash-st-scheduled { background: var(--mog-info-soft); color: var(--mog-info); }
    .mog-dash-st-confirming { background: var(--mog-warn-soft); color: var(--mog-warn); }
    .mog-dash-st-sending { background: ${COLOR_ACCENT}; color: var(--mog-bg); }
    .mog-dash-st-sent { background: var(--mog-success-soft); color: var(--mog-success); }
    .mog-dash-st-failed { background: var(--mog-error-soft); color: var(--mog-error); }
    .mog-dash-st-aborted { background: var(--mog-border); color: var(--mog-text-mute); }

    .mog-dash-empty {
      text-align: center; color: var(--mog-text-mute); padding: 40px 16px;
      font-size: 12px; font-style: italic;
      background: var(--mog-surface-2);
      border: 1px dashed var(--mog-border);
      border-radius: 10px;
    }

    .mog-dash-history-toggle {
      background: transparent; border: 1px solid var(--mog-border);
      color: var(--mog-text-dim); padding: 8px 14px; border-radius: 7px;
      font-size: 11px; cursor: pointer; font-weight: 600;
      letter-spacing: 0.3px; width: 100%; text-align: center;
      margin-bottom: 14px;
    }
    .mog-dash-history-toggle:hover { color: var(--mog-text); border-color: var(--mog-border); }

    .mog-lot-unit {
      min-width: 0;
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      border-radius: 6px;
      padding: 5px 3px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      transition: border-color 0.15s, opacity 0.15s;
    }
    .mog-lot-unit.mog-lot-unit-on { border-color: ${COLOR_ACCENT}; }
    .mog-lot-unit.mog-lot-unit-off { opacity: 0.55; }
    .mog-lot-unit-head {
      display: flex; align-items: center; gap: 3px;
      width: 100%; justify-content: center;
    }
    .mog-lot-unit-head input[type="checkbox"] {
      cursor: pointer;
      width: 12px; height: 12px; margin: 0;
    }
    .mog-lot-unit img { width: 18px; height: 18px; image-rendering: pixelated; }
    .mog-lot-unit-name {
      font-size: 9.5px; color: var(--mog-text-dim); font-weight: 600;
      text-align: center; line-height: 1.15;
      min-height: 22px;
      display: flex; align-items: center; justify-content: center;
      letter-spacing: -0.2px;
    }
    .mog-lot-unit-off .mog-lot-unit-name { color: var(--mog-text-mute); }
    .mog-lot-unit select, .mog-lot-unit input {
      width: 100%; box-sizing: border-box;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 4px; padding: 4px 2px; color: var(--mog-text);
      font-size: 10px; outline: none; min-width: 0;
      text-align: center;
    }
    .mog-lot-unit select { padding: 4px 0; }
    .mog-lot-unit select:focus, .mog-lot-unit input:focus { border-color: ${COLOR_ACCENT}; }
    .mog-lot-unit input[type="number"] {
      -moz-appearance: textfield;
      font-variant-numeric: tabular-nums;
    }
    .mog-lot-unit input[type="number"]::-webkit-inner-spin-button,
    .mog-lot-unit input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }

    .mog-lot-add {
      background: transparent;
      border: 1px dashed var(--mog-border);
      color: ${COLOR_ACCENT};
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 11px; font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: all 0.15s; width: 100%;
    }
    .mog-lot-add:hover { background: rgba(255,96,68,0.08); border-color: ${COLOR_ACCENT}; }

    /* log dock */
    .mog-log {
      border-top: 1px solid var(--mog-border-soft);
      background: var(--mog-bg-deep);
      display: flex; flex-direction: column;
      max-height: 180px;
      transition: max-height 0.2s ease;
    }
    .mog-log.mog-log-collapsed { max-height: 36px; }

    .mog-log-head {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 18px;
      border-bottom: 1px solid var(--mog-border-soft);
      flex-shrink: 0;
    }
    .mog-log.mog-log-collapsed .mog-log-head { border-bottom: none; }
    .mog-log-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.6px; color: var(--mog-text-mute);
    }
    .mog-log-count {
      font-size: 10px; color: var(--mog-text-mute); font-weight: 600;
    }
    .mog-log-spacer { flex: 1; }
    .mog-log-action {
      background: transparent; border: none;
      color: var(--mog-text-mute); cursor: pointer;
      padding: 4px 10px; font-size: 10.5px; font-weight: 600;
      border-radius: 5px; letter-spacing: 0.3px;
      text-transform: uppercase; transition: all 0.15s;
    }
    .mog-log-action:hover { color: var(--mog-text); background: var(--mog-surface-2); }

    .mog-log-body {
      flex: 1; overflow-y: auto;
      padding: 8px 18px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px; color: var(--mog-text-dim); line-height: 1.6;
    }
    .mog-log-body::-webkit-scrollbar { width: 6px; }
    .mog-log-body::-webkit-scrollbar-thumb { background: var(--mog-border); border-radius: 3px; }
    .mog-log.mog-log-collapsed .mog-log-body { display: none; }
    .mog-log-body:empty::before {
      content: 'Sem atividade ainda.'; color: var(--mog-text-mute); font-style: italic;
    }
    .mog-log-body div { padding: 1px 0; }

    /* ---------- farmer ---------- */
    .mog-farm-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px;
    }
    .mog-farm-head h2 {
      margin: 0; font-size: 14px; font-weight: 700; color: var(--mog-text);
      letter-spacing: 0.2px;
    }
    .mog-farm-toggle-wrap {
      display: flex; align-items: center; gap: 10px;
    }
    .mog-farm-next {
      font-size: 10.5px; color: var(--mog-text-mute); letter-spacing: 0.1px;
    }
    .mog-farm-next strong { color: var(--mog-text); font-weight: 700; }

    .mog-farm-block {
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .mog-farm-block-title {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      font-size: 10px; font-weight: 700; color: var(--mog-text-mute);
      text-transform: uppercase; letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .mog-farm-config {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px 16px;
    }
    .mog-farm-config-row {
      display: flex; align-items: center; gap: 8px;
      min-width: 0;
    }
    .mog-farm-config-row label {
      font-size: 11px; color: var(--mog-text-dim); font-weight: 500;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .mog-farm-config-row .mog-select {
      flex: 1; min-width: 0;
      padding: 5px 6px; font-size: 11px;
    }
    .mog-farm-config-row .mog-input {
      width: 60px; flex: 0 0 auto; text-align: center;
      padding: 5px 4px; font-size: 11px;
    }
    .mog-farm-suffix {
      font-size: 10.5px; color: var(--mog-text-mute); letter-spacing: 0.1px;
      flex: 0 0 auto;
    }
    .mog-farm-safemode {
      grid-column: 1 / -1;
      padding: 4px 0;
      border-top: 1px solid var(--mog-border-soft);
      margin-top: 2px;
    }
    .mog-farm-safemode .mog-toggle {
      padding: 4px 12px;
      font-size: 10.5px;
    }

    .mog-farm-tpl {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 6px;
    }
    .mog-farm-tpl-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 8px;
    }
    .mog-farm-tpl-letter {
      background: ${COLOR_ACCENT}; color: var(--mog-bg);
      padding: 2px 8px; border-radius: 4px;
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.4px; text-transform: uppercase;
    }
    .mog-farm-units {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: 4px;
    }
    .mog-farm-u {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .mog-farm-u img {
      width: 18px; height: 18px;
      image-rendering: pixelated;
      opacity: 0.85;
    }
    .mog-farm-u input {
      width: 100%; box-sizing: border-box;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 4px; padding: 3px 2px;
      color: var(--mog-text); font-size: 10.5px;
      outline: none; text-align: center;
      font-variant-numeric: tabular-nums;
      -moz-appearance: textfield;
    }
    .mog-farm-u input::-webkit-inner-spin-button,
    .mog-farm-u input::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .mog-farm-u input:focus { border-color: ${COLOR_ACCENT}; }

    .mog-farm-tpl-loading,
    .mog-farm-tpl-error {
      padding: 10px; text-align: center;
      font-size: 11px; color: var(--mog-text-mute); font-style: italic;
      background: var(--mog-bg-deep); border: 1px dashed var(--mog-border);
      border-radius: 6px;
    }
    .mog-farm-tpl-error { color: var(--mog-error); font-style: normal; }

    .mog-farm-btn-primary {
      background: ${COLOR_ACCENT}; color: var(--mog-bg); border: none;
      padding: 9px 16px; border-radius: 5px;
      font-size: 13px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: filter 0.15s;
      width: 100%;
    }
    .mog-farm-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .mog-farm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .mog-farm-btn-ghost {
      background: transparent;
      border: 1px solid var(--mog-border);
      color: var(--mog-text-dim);
      padding: 6px 12px; border-radius: 5px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      letter-spacing: 0.3px;
      transition: all 0.15s;
    }
    .mog-farm-btn-ghost:hover { color: var(--mog-text); border-color: ${COLOR_ACCENT}; }

    .mog-farm-btn-secondary {
      background: var(--mog-surface-hover); color: var(--mog-text);
      border: 1px solid var(--mog-border);
      padding: 8px 14px; border-radius: 5px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      letter-spacing: 0.3px;
      transition: all 0.15s;
      width: 100%;
    }
    .mog-farm-btn-secondary:hover:not(:disabled) {
      border-color: ${COLOR_ACCENT}; color: var(--mog-text);
    }
    .mog-farm-btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

    .mog-farm-actions {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    }

    .mog-farm-progress {
      margin-top: 8px;
      display: flex; align-items: center; gap: 10px;
    }
    .mog-farm-progress-bar {
      flex: 1; height: 6px;
      background: var(--mog-surface-hover);
      border: 1px solid var(--mog-border);
      border-radius: 3px;
      overflow: hidden;
    }
    .mog-farm-progress-fill {
      height: 100%; width: 0%;
      background: ${COLOR_ACCENT};
      transition: width 0.25s ease-out;
    }
    .mog-farm-progress-text {
      font-size: 10.5px; color: var(--mog-text-dim);
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      letter-spacing: 0.2px;
      flex: 0 0 auto;
      min-width: 60px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .mog-farm-wb {
      display: flex; flex-direction: column; gap: 4px;
    }
    .mog-farm-wb-row {
      font-size: 11px; color: var(--mog-text-dim);
      padding: 5px 10px;
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 5px;
    }
    .mog-farm-wb-meta {
      font-size: 10px; color: var(--mog-text-mute); margin-left: 6px;
    }

    .mog-farm-empty {
      padding: 24px;
      text-align: center;
      font-size: 12px; color: var(--mog-text-mute); font-style: italic;
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border-soft);
      border-radius: 8px;
      margin-bottom: 8px;
    }

    /* ---------- defenses ---------- */
    .mog-def-legend {
      display: flex; flex-wrap: wrap; gap: 14px;
      align-items: center;
      font-size: 11px; color: var(--mog-text-dim);
    }
    .mog-def-legend .mog-def-icon {
      display: inline-block; margin-right: 4px;
      filter: grayscale(0.2);
    }
    .mog-def-legend-meta {
      flex: 1 1 100%;
      font-size: 10.5px; color: var(--mog-text-mute); font-style: italic;
      margin-top: 4px;
    }

    .mog-def-block-expired { opacity: 0.6; }

    .mog-def-table {
      display: flex; flex-direction: column; gap: 2px;
    }
    .mog-def-row {
      display: grid;
      grid-template-columns: 80px 60px 56px 1fr 1fr 70px 36px;
      gap: 8px;
      align-items: center;
      padding: 6px 10px;
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border);
      border-radius: 5px;
      font-size: 11px;
    }
    .mog-def-head {
      background: transparent;
      border: none;
      padding: 4px 10px;
      font-size: 10px; color: var(--mog-text-mute);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 700;
    }
    .mog-def-coords a {
      color: ${COLOR_ACCENT};
      text-decoration: none;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .mog-def-coords a:hover { text-decoration: underline; }
    .mog-def-type {
      display: flex; gap: 4px; align-items: center;
      font-size: 13px;
    }
    .mog-def-wall {
      text-align: center;
      font-weight: 700; color: #fff;
      font-variant-numeric: tabular-nums;
    }
    .mog-def-empty {
      color: var(--mog-text-mute); font-style: italic; font-size: 10.5px;
    }
    .mog-def-units {
      display: flex; flex-wrap: wrap; gap: 4px 8px;
    }
    .mog-def-unit {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 10.5px; color: var(--mog-text-dim);
      font-variant-numeric: tabular-nums;
    }
    .mog-def-unit img {
      width: 14px; height: 14px;
      image-rendering: pixelated;
    }
    .mog-def-time {
      font-size: 10px; color: var(--mog-text-mute);
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .mog-def-rescout {
      padding: 3px 8px;
      font-size: 12px;
    }
  `);

  // ---- DOM build ----
  function anyModuleActive() {
    if (Array.isArray(state.recruiter?.profiles) && state.recruiter.profiles.some(p => p.enabled)) return true;
    if (state.farmer?.enabled) return true;
    if (state.builder?.enabled && Array.isArray(state.builder.profiles) && state.builder.profiles.some(p => p.enabled)) return true;
    return false;
  }
  const launcher = document.createElement('div');
  launcher.className = 'mog-launcher' + (anyModuleActive() ? ' mog-active' : '');
  launcher.innerHTML = `M<div class="mog-launcher-dot"></div>`;
  launcher.title = 'Millennium';

  const overlay = document.createElement('div');
  overlay.className = 'mog-overlay';

  const panel = document.createElement('div');
  panel.className = 'mog-panel';
  panel.innerHTML = `
    <div class="mog-head">
      <div class="mog-logo">M</div>
      <div>
        <div class="mog-title-name">Millennium</div>
        <div class="mog-title-ver">v${VERSION}</div>
      </div>
      <div class="mog-head-spacer"></div>
      <div class="mog-head-chips">
        <span class="mog-chip mog-chip-captcha" id="mog-chip-captcha" title="Captcha detectado — clique para reativar" hidden>
          <span class="mog-chip-dot"></span>Captcha
        </span>
        <span class="mog-chip mog-chip-rtt" id="mog-chip-rtt" title="Latência média ao servidor" hidden>RTT —</span>
        <span class="mog-chip mog-chip-clock" id="mog-chip-clock" title="Hora do servidor" hidden>--:--:--</span>
      </div>
      <button class="mog-close" id="mog-close">&times;</button>
    </div>

    <aside class="mog-side">
      <div class="mog-side-section" data-side-section="account">
        <div class="mog-side-title" data-side-toggle="account">
          <span class="mog-side-caret">▼</span>
          <span>Gerente de Conta</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="builder">
            <span class="mog-side-icon">🏗</span>
            <span>Construtor</span>
            <span class="mog-side-status" data-status-for="builder"></span>
          </div>
          <div class="mog-side-item mog-side-active" data-section="recruiter">
            <span class="mog-side-icon">⚔</span>
            <span>Recrutamento</span>
            <span class="mog-side-status" data-status-for="recruiter"></span>
          </div>
        </div>
      </div>

      <div class="mog-side-section" data-side-section="operations">
        <div class="mog-side-title" data-side-toggle="operations">
          <span class="mog-side-caret">▼</span>
          <span>Operações</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="scheduler">
            <span class="mog-side-icon">⏰</span>
            <span>Agendador</span>
            <span class="mog-side-status" data-status-for="scheduler"></span>
          </div>
          <div class="mog-side-item" data-section="dashboard">
            <span class="mog-side-icon">📊</span>
            <span>Painel</span>
            <span class="mog-side-status" data-status-for="dashboard"></span>
          </div>
        </div>
      </div>

      <div class="mog-side-section" data-side-section="loot">
        <div class="mog-side-title" data-side-toggle="loot">
          <span class="mog-side-caret">▼</span>
          <span>Saque</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="farmer">
            <span class="mog-side-icon"><img src="/graphic/unit/unit_light.png" alt="Farmador" onerror="this.style.display='none'"></span>
            <span>Farmador</span>
            <span class="mog-side-status" data-status-for="farmer"></span>
          </div>
          <div class="mog-side-item" data-section="defenses">
            <span class="mog-side-icon">🛡</span>
            <span>Defesas</span>
          </div>
        </div>
      </div>

    </aside>

    <div class="mog-main">
      <div class="mog-content" id="mog-content"></div>
      <div class="mog-log" id="mog-log">
        <div class="mog-log-head">
          <span class="mog-log-title">Histórico</span>
          <span class="mog-log-count" id="mog-log-count">0</span>
          <div class="mog-log-spacer"></div>
          <button class="mog-log-action" id="mog-log-clear">Limpar</button>
          <button class="mog-log-action" id="mog-log-collapse">Recolher</button>
        </div>
        <div class="mog-log-body" id="mog-log-body"></div>
      </div>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  // ---- panel open/close ----
  function openPanel() {
    state.ui.panelOpen = true;
    panel.classList.add('mog-open');
    overlay.classList.add('mog-show');
  }
  function closePanel() {
    state.ui.panelOpen = false;
    panel.classList.remove('mog-open');
    overlay.classList.remove('mog-show');
  }
  launcher.addEventListener('click', () => {
    if (panel.classList.contains('mog-open')) closePanel();
    else openPanel();
  });
  overlay.addEventListener('click', closePanel);
  panel.querySelector('#mog-close').addEventListener('click', closePanel);

  if (state.ui.panelOpen) openPanel();

  // ---- header chips (read-only: latência, hora servidor, captcha) ----
  const chipCaptcha = panel.querySelector('#mog-chip-captcha');
  const chipRtt = panel.querySelector('#mog-chip-rtt');
  const chipClock = panel.querySelector('#mog-chip-clock');

  chipCaptcha.addEventListener('click', () => {
    resumeFromCaptcha();
    updateHeadChips();
  });

  function updateHeadChips() {
    // Captcha — só visível em trip; clique reativa
    const tripped = state.captchaTrippedAt > 0;
    chipCaptcha.hidden = !tripped;

    // RTT — cor por threshold
    const rtt = state.scheduler?.latency?.avgRtt;
    if (Number.isFinite(rtt) && rtt > 0) {
      chipRtt.textContent = `RTT ${Math.round(rtt)}ms`;
      chipRtt.classList.remove('mog-chip-warn', 'mog-chip-error', 'mog-chip-ok');
      if (rtt < 100) chipRtt.classList.add('mog-chip-ok');
      else if (rtt < 300) chipRtt.classList.add('mog-chip-warn');
      else chipRtt.classList.add('mog-chip-error');
    } else {
      chipRtt.textContent = 'RTT —';
      chipRtt.classList.remove('mog-chip-warn', 'mog-chip-error', 'mog-chip-ok');
    }

    // Server clock — hh:mm:ss do servidor TW
    try {
      const t = serverNow();
      const d = new Date(t);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      chipClock.textContent = `${hh}:${mm}:${ss}`;
    } catch {
      chipClock.textContent = '--:--:--';
    }

    // Launcher dot reflete "tem algum módulo ativo"
    launcher.classList.toggle('mog-active', anyModuleActive());
  }
  updateHeadChips();
  setInterval(updateHeadChips, 1000);

  // ---- sidebar nav ----
  panel.querySelectorAll('.mog-side-item[data-section]').forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('mog-side-disabled')) return;
      const sec = item.dataset.section;
      state.ui.activeSection = sec;
      persist();
      panel.querySelectorAll('.mog-side-item').forEach(x => x.classList.remove('mog-side-active'));
      item.classList.add('mog-side-active');
      renderContent();
    });
  });
  // sync sidebar with restored state
  (() => {
    const active = panel.querySelector(`.mog-side-item[data-section="${state.ui.activeSection}"]`);
    if (active && !active.classList.contains('mog-side-disabled')) {
      panel.querySelectorAll('.mog-side-item').forEach(x => x.classList.remove('mog-side-active'));
      active.classList.add('mog-side-active');
    } else {
      state.ui.activeSection = 'recruiter';
    }
  })();

  // ---- sidebar collapse/expand ----
  panel.querySelectorAll('.mog-side-title[data-side-toggle]').forEach(title => {
    const key = title.dataset.sideToggle;
    const section = title.closest('.mog-side-section');
    if (state.ui.sideCollapsed?.[key]) section.classList.add('mog-side-collapsed');
    title.addEventListener('click', () => {
      section.classList.toggle('mog-side-collapsed');
      state.ui.sideCollapsed = state.ui.sideCollapsed || {};
      state.ui.sideCollapsed[key] = section.classList.contains('mog-side-collapsed');
      persist();
    });
  });

  // ---- log dock ----
  const logEl = panel.querySelector('#mog-log');
  if (state.ui.logCollapsed) logEl.classList.add('mog-log-collapsed');
  panel.querySelector('#mog-log-collapse').addEventListener('click', () => {
    state.ui.logCollapsed = !state.ui.logCollapsed;
    persist();
    logEl.classList.toggle('mog-log-collapsed', state.ui.logCollapsed);
    panel.querySelector('#mog-log-collapse').textContent = state.ui.logCollapsed ? 'Expandir' : 'Recolher';
  });
  panel.querySelector('#mog-log-collapse').textContent = state.ui.logCollapsed ? 'Expandir' : 'Recolher';

  panel.querySelector('#mog-log-clear').addEventListener('click', () => {
    if (state.ui.activeSection === 'scheduler' || state.ui.activeSection === 'dashboard') state.scheduler.log = [];
    else if (state.ui.activeSection === 'farmer' || state.ui.activeSection === 'defenses') state.farmer.log = [];
    else if (state.ui.activeSection === 'builder') state.builder.log = [];
    else state.recruiter.log = [];
    persist();
    renderLog();
  });

  // ---- content router ----
  const content = panel.querySelector('#mog-content');

  function renderContent() {
    if (state.ui.activeSection === 'recruiter') {
      renderRecruiter();
    } else if (state.ui.activeSection === 'scheduler') {
      renderScheduler();
    } else if (state.ui.activeSection === 'dashboard') {
      renderDashboard();
    } else if (state.ui.activeSection === 'farmer') {
      renderFarmer();
    } else if (state.ui.activeSection === 'defenses') {
      renderDefenses();
    } else if (state.ui.activeSection === 'builder') {
      renderBuilder();
    } else {
      renderPlaceholder(state.ui.activeSection);
    }
    renderLog();
    refreshSidebarStatus();
  }

  // Atualiza as bolinhas de status no sidebar. Cada item ativável pode estar
  // ON (verde) ou OFF (cinza). Critérios:
  //   - recruiter: bot global ligado E ao menos 1 profile com enabled=true
  //   - scheduler/dashboard: ao menos 1 comando agendado/confirmando ainda pra ser enviado
  //   - farmer: state.farmer.enabled
  function refreshSidebarStatus() {
    const recruiterOn = state.recruiter.profiles.some(p => p.enabled);
    const farmerOn = !!state.farmer.enabled;
    const builderOn = !!state.builder?.enabled && (state.builder.profiles || []).some(p => p.enabled);
    const hasScheduledCmd = state.scheduler.operations.some(op =>
      Array.isArray(op.commands) && op.commands.some(c =>
        c.status === 'scheduled' || c.status === 'confirming' || c.status === 'sending' || c.status === 'bundled' || c.status === 'pending'
      )
    );
    const map = {
      recruiter: recruiterOn,
      farmer: farmerOn,
      builder: builderOn,
      scheduler: hasScheduledCmd,
      dashboard: hasScheduledCmd,
    };
    panel?.querySelectorAll('.mog-side-status[data-status-for]').forEach(el => {
      const key = el.getAttribute('data-status-for');
      el.classList.toggle('mog-side-status-on', !!map[key]);
    });
  }

  setInterval(refreshSidebarStatus, 5000);

  function renderPlaceholder(section) {
    const labels = { builder: 'Construtor', research: 'Pesquisa' };
    content.innerHTML = `
      <div class="mog-placeholder">
        <div class="mog-placeholder-icon">🚧</div>
        <div class="mog-placeholder-title">${labels[section] || section}</div>
        <div class="mog-placeholder-text">Disponível em breve.</div>
      </div>
    `;
  }

  // ---- scheduler section ----
  function getActiveOperation() {
    const id = state.scheduler.ui.activeOperationId;
    if (!id) return null;
    return state.scheduler.operations.find(o => o.id === id) || null;
  }

  // garante que existe uma operação em rascunho pra editar.
  // se já existe, usa. senão, cria nova.
  function getOrCreateDraftOperation() {
    let draft = state.scheduler.operations.find(o => o.status === 'draft');
    if (!draft) {
      draft = makeOperation({ name: `Operação ${state.scheduler.operations.length + 1}` });
      state.scheduler.operations.push(draft);
      persist();
    }
    return draft;
  }

  // limpa o draft atual (apaga tudo configurado, cria novo zerado)
  function resetDraftOperation() {
    state.scheduler.operations = state.scheduler.operations.filter(o => o.status !== 'draft');
    state.scheduler.ui.wizardStep = 1;
    persist();
    renderScheduler();
  }

  function renderScheduler() {
    const op = getOrCreateDraftOperation();
    state.scheduler.ui.activeOperationId = op.id;
    if (!op.step) op.step = 1;
    state.scheduler.ui.wizardStep = op.step;
    renderOpWizard(op);
  }

  // ---- wizard ----
  function renderOpWizard(op) {
    const step = state.scheduler.ui.wizardStep || 1;
    const stepTitles = { 1: 'Alvos', 2: 'Origens', 3: 'Calcular & revisar', 4: 'Confirmar' };

    content.innerHTML = `
      <div class="mog-wiz-head">
        <div class="mog-wiz-title">Agendador</div>
        <div class="mog-wiz-steps">
          ${[1, 2, 3, 4].map(n => {
            const cls = n === step ? 'mog-wiz-step-active' : (n < step ? 'mog-wiz-step-done' : '');
            return `<div class="mog-wiz-step ${cls}" data-go-step="${n}">
              <span class="mog-wiz-step-num">${n}</span>
              <span>${stepTitles[n]}</span>
            </div>` + (n < 4 ? '<span class="mog-wiz-step-sep">›</span>' : '');
          }).join('')}
        </div>
        <button class="mog-wiz-back" id="mog-wiz-reset" title="Recomeçar agendamentos do zero">↻ Recomeçar</button>
      </div>
      <div id="mog-wiz-body"></div>
    `;

    content.querySelector('#mog-wiz-reset').addEventListener('click', () => {
      if (!confirm('Recomeçar do zero? Todos os alvos, origens e configurações deste rascunho serão apagados.')) return;
      resetDraftOperation();
    });
    content.querySelectorAll('[data-go-step]').forEach(el => {
      el.addEventListener('click', () => {
        const n = parseInt(el.dataset.goStep, 10);
        // por enquanto só permite voltar (ir pra step >= atual+1 sem dados causaria erros futuros)
        if (n <= state.scheduler.ui.wizardStep) {
          state.scheduler.ui.wizardStep = n;
          op.step = n;
          persist();
          renderOpWizard(op);
        }
      });
    });

    if (step === 1) renderWizardStep1(op);
    else if (step === 2) renderWizardStep2(op);
    else if (step === 3) renderWizardStep3(op);
    else if (step === 4) renderWizardStep4(op);
    else renderWizardPlaceholder(step);
  }

  function renderWizardPlaceholder(step) {
    const body = content.querySelector('#mog-wiz-body');
    body.innerHTML = `
      <div class="mog-placeholder">
        <div class="mog-placeholder-icon">🚧</div>
        <div class="mog-placeholder-title">Passo ${step} — em construção</div>
        <div class="mog-placeholder-text">Disponível na próxima entrega.</div>
      </div>
    `;
  }

  // ---- passo 1: alvos ----
  function renderWizardStep1(op) {
    if (!op.defaultArrival) op.defaultArrival = { datetime: 0, ms: 0 };
    const body = content.querySelector('#mog-wiz-body');
    const arrivalStr = fmtDateForInput(op.defaultArrival.datetime);
    body.innerHTML = `
      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>1. Padrão de chegada</span>
        </div>
        <div class="mog-wiz-default-arrival">
          <div class="mog-wiz-fld" style="flex:2;">
            <label>Data e hora</label>
            <input type="text" id="mog-wiz-default-dt"
              placeholder="DD/MM/YYYY HH:MM:SS"
              autocomplete="off"
              spellcheck="false"
              value="${escapeHtml(arrivalStr)}">
          </div>
          <div class="mog-wiz-fld" style="flex:1;">
            <label>MS padrão</label>
            <input type="number" min="0" max="999" id="mog-wiz-default-ms" value="${op.defaultArrival.ms || 0}">
          </div>
        </div>
        <div class="mog-wiz-hint" style="margin-top:8px;">
          Formato: <strong>DD/MM/YYYY HH:MM:SS</strong> (sempre, independente do sistema). Esse horário é aplicado a todos os alvos extraídos. Você pode editar o MS de cada alvo individualmente depois.
        </div>
      </div>

      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>2. Coordenadas dos alvos</span>
          <span style="color:var(--mog-text-mute);font-weight:400;text-transform:none;letter-spacing:0;">${op.targets.length} cadastrado(s)</span>
        </div>
        <textarea class="mog-wiz-textarea" id="mog-wiz-coords-input"
          placeholder="Cole qualquer texto. Coordenadas no formato 123|456 serão extraídas automaticamente.&#10;Exemplo: 100% de aproveitamento (401|464) K44"></textarea>
        <div class="mog-wiz-row">
          <label style="font-size:11px;color:var(--mog-text-dim);display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
            <input type="checkbox" id="mog-wiz-dedup" checked> Remover coordenadas duplicadas
          </label>
          <button class="mog-btn mog-btn-ghost" id="mog-wiz-extract" style="width:auto;">Extrair coordenadas</button>
        </div>
      </div>

      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>3. Alvos cadastrados</span>
          ${op.targets.length ? '<button class="mog-log-action" id="mog-wiz-clear-targets">Limpar tudo</button>' : ''}
        </div>
        ${op.targets.length === 0 ? `
          <div class="mog-tg-empty">Nenhum alvo cadastrado ainda.</div>
        ` : `
          <div class="mog-tg-head">
            <div>Coordenadas</div>
            <div>Chegada</div>
            <div>MS</div>
            <div>Ataques</div>
            <div>Apoios</div>
            <div>Nobres</div>
            <div></div>
          </div>
          <div id="mog-wiz-targets"></div>
        `}
      </div>

      <div class="mog-wiz-foot">
        <span class="mog-wiz-hint">${op.targets.length === 0 ? 'Adicione pelo menos um alvo para continuar.' : `${op.targets.length} alvo(s) prontos.`}</span>
        <div class="mog-wiz-foot-spacer"></div>
        <button class="mog-btn" id="mog-wiz-next" ${op.targets.length === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;width:auto;"' : 'style="width:auto;"'}>Próximo: Origens →</button>
      </div>
    `;

    const dtInp = body.querySelector('#mog-wiz-default-dt');
    dtInp.addEventListener('change', e => {
      const raw = e.target.value.trim();
      if (!raw) {
        op.defaultArrival.datetime = 0;
        e.target.classList.remove('mog-input-error');
      } else {
        const parsed = parseDateFromInput(raw);
        if (parsed) {
          op.defaultArrival.datetime = parsed;
          e.target.value = fmtDateForInput(parsed);   // re-formata canônico
          e.target.classList.remove('mog-input-error');
        } else {
          e.target.classList.add('mog-input-error');
          pushSchedulerLog('Formato inválido. Use DD/MM/YYYY HH:MM:SS (ex: 02/05/2026 19:19:00).');
          return;
        }
      }
      persist();
    });
    body.querySelector('#mog-wiz-default-ms').addEventListener('change', e => {
      const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      op.defaultArrival.ms = v;
      e.target.value = v;
      persist();
    });

    body.querySelector('#mog-wiz-extract').addEventListener('click', () => {
      const txt = body.querySelector('#mog-wiz-coords-input').value;
      const dedup = body.querySelector('#mog-wiz-dedup').checked;
      const found = parseCoordsFromText(txt, { keepDuplicates: !dedup });
      if (!found.length) {
        pushSchedulerLog('Nenhuma coordenada válida encontrada no texto colado.');
        return;
      }
      if (!op.defaultArrival.datetime) {
        pushSchedulerLog('Defina a data e hora de chegada padrão antes de extrair coordenadas.');
        return;
      }
      const baseArrivalAt = (Math.floor(op.defaultArrival.datetime / 1000) * 1000) + (op.defaultArrival.ms || 0);
      const existing = new Set(op.targets.map(t => t.coords));
      const added = [];
      let skippedDup = 0;
      for (const f of found) {
        if (dedup && existing.has(f.coords)) { skippedDup++; continue; }
        op.targets.push(makeTarget({ coords: f.coords, x: f.x, y: f.y, arrivalAt: baseArrivalAt }));
        existing.add(f.coords);
        added.push(f.coords);
      }
      pushSchedulerLog(`[${op.name}] ${added.length} alvo(s) adicionado(s)${skippedDup ? `, ${skippedDup} duplicado(s) ignorado(s)` : ''}.`);
      body.querySelector('#mog-wiz-coords-input').value = '';
      persist();
      renderWizardStep1(op);
    });

    const clearBtn = body.querySelector('#mog-wiz-clear-targets');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (!confirm('Remover todos os alvos cadastrados?')) return;
      op.targets = [];
      persist();
      renderWizardStep1(op);
    });

    const nextBtn = body.querySelector('#mog-wiz-next');
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener('click', () => {
        state.scheduler.ui.wizardStep = 2;
        op.step = 2;
        persist();
        renderOpWizard(op);
      });
    }

    const targetsWrap = body.querySelector('#mog-wiz-targets');
    if (targetsWrap) renderTargetRows(op, targetsWrap);
  }

  function renderTargetRows(op, wrap) {
    wrap.innerHTML = op.targets.map(t => renderTargetRow(t)).join('');
    wrap.querySelectorAll('[data-tact]').forEach(el => {
      el.addEventListener('change', e => onTargetChange(op, e));
      // botão delete dispara click
      if (el.dataset.tact === 'delete') {
        el.addEventListener('click', () => {
          op.targets = op.targets.filter(t => t.id !== el.dataset.tid);
          persist();
          renderWizardStep1(op);
        });
      }
    });
  }

  function renderTargetRow(t) {
    const arrival = t.arrivalAt ? fmtFullDate(Math.floor(t.arrivalAt / 1000) * 1000) : '—';
    const targetMs = t.arrivalAt ? (t.arrivalAt % 1000) : 0;
    return `
      <div class="mog-tg-row" data-tid="${t.id}">
        <div class="mog-tg-coords">${escapeHtml(t.coords)}</div>
        <div class="mog-tg-arrival">${arrival.replace(/\.\d{3}$/, '')}</div>
        <input type="number" min="0" max="999" data-tact="ms" data-tid="${t.id}" value="${targetMs}">
        <input type="number" min="0" data-tact="count-attack" data-tid="${t.id}" value="${t.counts.attack}">
        <input type="number" min="0" data-tact="count-support" data-tid="${t.id}" value="${t.counts.support}">
        <input type="number" min="0" data-tact="count-noble" data-tid="${t.id}" value="${t.counts.noble}">
        <button class="mog-iconbtn mog-iconbtn-danger" data-tact="delete" data-tid="${t.id}" title="Excluir alvo">×</button>
      </div>
    `;
  }

  function onTargetChange(op, e) {
    const t = op.targets.find(x => x.id === e.target.dataset.tid);
    if (!t) return;
    const act = e.target.dataset.tact;
    if (act === 'ms') {
      const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      const base = Math.floor((t.arrivalAt || 0) / 1000) * 1000;
      t.arrivalAt = base + v;
      e.target.value = v;
    } else if (act.startsWith('count-')) {
      const kind = act.replace('count-', '');
      t.counts[kind] = Math.max(0, parseInt(e.target.value, 10) || 0);
    }
    persist();
  }

  // "DD/MM/YYYY HH:MM:SS" — formato pra input texto (sem ms).
  function fmtDateForInput(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Parseia "DD/MM/YYYY HH:MM[:SS]" → Unix ms. Retorna 0 se inválido.
  function parseDateFromInput(str) {
    if (!str) return 0;
    const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return 0;
    const [, dd, mm, yyyy, hh, MM, ss] = m;
    const d = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10),
                       parseInt(hh, 10), parseInt(MM, 10), parseInt(ss || '0', 10), 0);
    if (isNaN(d.getTime())) return 0;
    return d.getTime();
  }

  // "DD/MM/YYYY HH:MM:SS.mmm" — formato canônico de exibição em todo lugar.
  function fmtFullDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  // ---- passo 2: origens + lotes ----
  // Garante exatamente 1 sourceGroup na operação (lote único)
  function ensureSingleSourceGroup(op) {
    if (op.sourceGroups.length === 0) {
      op.sourceGroups.push(makeSourceGroup({ label: 'Origens' }));
      persist();
    } else if (op.sourceGroups.length > 1) {
      // se por algum motivo tem múltiplos, consolida no primeiro
      op.sourceGroups = [op.sourceGroups[0]];
      persist();
    }
    return op.sourceGroups[0];
  }

  function renderWizardStep2(op) {
    const sg = ensureSingleSourceGroup(op);
    const totalSources = sg.villages.length;
    const body = content.querySelector('#mog-wiz-body');

    body.innerHTML = `
      <div class="mog-wiz-section" id="mog-wiz-lot-host"></div>

      <div class="mog-wiz-foot">
        <span class="mog-wiz-hint">
          ${totalSources === 0
            ? 'Adicione pelo menos uma origem para continuar.'
            : `${totalSources} origem(ns) prontas.`}
        </span>
        <div class="mog-wiz-foot-spacer"></div>
        <button class="mog-btn mog-btn-ghost" id="mog-wiz-prev" style="width:auto;">← Voltar: Alvos</button>
        <button class="mog-btn" id="mog-wiz-next2" ${totalSources === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;width:auto;"' : 'style="width:auto;"'}>Próximo: Calcular →</button>
      </div>
    `;

    body.querySelector('#mog-wiz-prev').addEventListener('click', () => {
      state.scheduler.ui.wizardStep = 1;
      op.step = 1;
      persist();
      renderOpWizard(op);
    });

    const nextBtn = body.querySelector('#mog-wiz-next2');
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener('click', () => {
        state.scheduler.ui.wizardStep = 3;
        op.step = 3;
        persist();
        renderOpWizard(op);
      });
    }

    const host = body.querySelector('#mog-wiz-lot-host');
    host.innerHTML = renderLotInline(sg);
    bindLotCard(op, sg);
    populateLotGroupSelect(sg);
  }

  // Renderiza o conteúdo de um lote inline (sem header/colapso/botão excluir).
  function renderLotInline(sg) {
    const m = sg.model;
    const villagesText = sg.villages.map(v => `${v.x}|${v.y}`).join(' ');
    return `
      <div class="mog-lot mog-lot-open mog-lot-inline" data-sgid="${sg.id}">
        <div class="mog-lot-body" style="display:block;padding:0;">
          <div class="mog-lot-cols">
            <div>
              <div class="mog-lot-fld">
                <label>Importar de um grupo</label>
                <div class="mog-lot-import-row">
                  <select class="mog-select" data-lact="group"></select>
                  <button class="mog-btn mog-btn-ghost" data-lact="import">Importar</button>
                </div>
              </div>
              <div class="mog-lot-fld">
                <label>Ou cole coordenadas das origens</label>
                <textarea class="mog-wiz-textarea" data-lact="textarea" placeholder="123|456 234|567 ..." style="min-height:60px;">${escapeHtml(sg.rawText)}</textarea>
                <div class="mog-wiz-row" style="margin-top:6px;">
                  <label style="font-size:10.5px;color:var(--mog-text-dim);display:flex;align-items:center;gap:5px;cursor:pointer;flex:1;">
                    <input type="checkbox" data-lact="dedup"> Remover duplicadas
                  </label>
                  <button class="mog-btn mog-btn-ghost" data-lact="extract" style="width:auto;">Extrair</button>
                </div>
              </div>
              <div class="mog-lot-fld">
                <label style="display:flex;align-items:center;justify-content:space-between;">
                  <span>Aldeias adicionadas (${sg.villages.length})</span>
                  ${sg.villages.length ? `<button class="mog-log-action" data-lact="villages-clear" style="padding:2px 8px;">Limpar</button>` : ''}
                </label>
                <textarea class="mog-lot-villages mog-lot-villages-edit" data-lact="villages-edit" placeholder="Edite à vontade. Cada coordenada listada N vezes = N comandos dessa aldeia.">${escapeHtml(villagesText)}</textarea>
              </div>
            </div>

            <div>
              <div class="mog-lot-fld">
                <label>Tipo de comando</label>
                <select class="mog-select" data-lact="type">
                  <option value="attack" ${m.type === 'attack' ? 'selected' : ''}>Ataque</option>
                  <option value="support" ${m.type === 'support' ? 'selected' : ''}>Apoio</option>
                </select>
              </div>
              <div class="mog-lot-fld">
                <label>Alvo da catapulta (se houver)</label>
                <select class="mog-select" data-lact="cata">
                  ${CATAPULT_TARGETS.map(c => `<option value="${c}" ${m.catapultTarget === c ? 'selected' : ''}>${labelForCata(c)}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>

          <div class="mog-lot-fld" style="margin-top:14px;">
            <label>Tropas que serão usadas — ${m.waves.length} comando(s) por origem→alvo</label>
            <div id="mog-lot-waves-${sg.id}">
              ${m.waves.map((w, idx) => renderWaveRow(sg, w, idx)).join('')}
            </div>
            <button class="mog-wave-add" data-lact="wave-add" style="margin-top:6px;">+ Adicionar comando</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderWaveRow(sg, w, idx) {
    const m = sg.model;
    return `
      <div class="mog-wave" data-wid="${w.id}">
        <div class="mog-wave-num">
          <span class="mog-wave-num-label">Cmd</span>
          <span>#${idx + 1}</span>
        </div>
        <div class="mog-wave-grid">
          ${COMMAND_UNITS.filter(u => u.id !== 'snob' || m.type === 'attack').map(u => {
            const c = w.units[u.id] || { enabled: false, mode: 'all', value: 0 };
            const cls = c.enabled ? 'mog-lot-unit-on' : 'mog-lot-unit-off';
            return `
              <div class="mog-lot-unit ${cls}" data-uid="${u.id}">
                <div class="mog-lot-unit-head">
                  <input type="checkbox" data-lact="w-u-enabled" data-wid="${w.id}" data-uid="${u.id}" ${c.enabled ? 'checked' : ''}>
                  <img src="/graphic/unit/unit_${u.id}.png" alt="${u.name}" onerror="this.style.display='none'">
                </div>
                <div class="mog-lot-unit-name">${u.name}</div>
                <select data-lact="w-u-mode" data-wid="${w.id}" data-uid="${u.id}" ${!c.enabled ? 'disabled' : ''}>
                  <option value="all" ${c.mode === 'all' ? 'selected' : ''}>Todas</option>
                  <option value="percent" ${c.mode === 'percent' ? 'selected' : ''}>%</option>
                  <option value="count" ${c.mode === 'count' ? 'selected' : ''}>Núm.</option>
                </select>
                <input type="number" min="0" data-lact="w-u-value" data-wid="${w.id}" data-uid="${u.id}" value="${c.value}" ${(!c.enabled || c.mode === 'all') ? 'disabled style="opacity:0.4;"' : ''}>
              </div>
            `;
          }).join('')}
        </div>
        <div class="mog-wave-del">
          ${m.waves.length > 1 ? `<button class="mog-iconbtn mog-iconbtn-danger" data-lact="wave-del" data-wid="${w.id}" title="Remover comando">×</button>` : ''}
        </div>
      </div>
    `;
  }

  function labelForCata(c) {
    const labels = {
      random: 'Aleatório', main: 'Edifício principal', barracks: 'Quartel',
      stable: 'Estábulo', garage: 'Oficina', snob: 'Academia', smith: 'Ferreiro',
      place: 'Praça de reunião', statue: 'Estátua', market: 'Mercado',
      wood: 'Bosque', stone: 'Poço de argila', iron: 'Mina de ferro', farm: 'Fazenda',
      storage: 'Armazém', hide: 'Esconderijo', wall: 'Muralha', church: 'Igreja',
    };
    return labels[c] || c;
  }

  function bindLotCard(op, sg) {
    const card = content.querySelector(`.mog-lot[data-sgid="${sg.id}"]`);
    if (!card) return;

    card.querySelector('[data-lact="textarea"]').addEventListener('input', e => {
      sg.rawText = e.target.value;
      persist();
    });

    card.querySelector('[data-lact="extract"]').addEventListener('click', () => {
      const dedup = card.querySelector('[data-lact="dedup"]').checked;
      const found = parseCoordsFromText(sg.rawText, { keepDuplicates: !dedup });
      if (!found.length) {
        pushSchedulerLog(`[${sg.label}] nenhuma coordenada encontrada no texto.`);
        return;
      }
      // Match contra aldeias do jogador (precisamos saber o villageId real)
      addVillagesByCoords(sg, found.map(f => f.coords));
    });

    card.querySelector('[data-lact="villages-clear"]')?.addEventListener('click', () => {
      if (!confirm(`Limpar todas as ${sg.villages.length} aldeia(s) do lote "${sg.label}"?`)) return;
      sg.villages = [];
      persist();
      renderWizardStep2(op);
    });

    card.querySelector('[data-lact="villages-edit"]')?.addEventListener('blur', e => {
      syncVillagesFromTextarea(sg, e.target.value);
    });

    card.querySelector('[data-lact="group"]').addEventListener('change', e => {
      const val = parseInt(e.target.value, 10);
      sg.importGroupId = Number.isNaN(val) ? -1 : val;
      persist();
    });

    card.querySelector('[data-lact="import"]').addEventListener('click', () => {
      importLotFromGroup(sg);
    });

    card.querySelector('[data-lact="type"]').addEventListener('change', e => {
      sg.model.type = e.target.value;
      persist();
      renderWizardStep2(op);
    });

    card.querySelector('[data-lact="cata"]').addEventListener('change', e => {
      sg.model.catapultTarget = e.target.value;
      persist();
    });

    // grade de unidades por wave
    card.querySelectorAll('[data-lact^="w-u-"]').forEach(el => {
      el.addEventListener('change', e => {
        const wid = e.target.dataset.wid;
        const uid = e.target.dataset.uid;
        const wave = sg.model.waves.find(w => w.id === wid);
        if (!wave) return;
        const u = wave.units[uid];
        const act = e.target.dataset.lact;
        if (act === 'w-u-enabled') u.enabled = e.target.checked;
        else if (act === 'w-u-mode') u.mode = e.target.value;
        else if (act === 'w-u-value') u.value = Math.max(0, parseInt(e.target.value, 10) || 0);
        persist();
        if (act === 'w-u-enabled' || act === 'w-u-mode') renderWizardStep2(op);
      });
    });

    // adicionar wave
    card.querySelector('[data-lact="wave-add"]').addEventListener('click', () => {
      sg.model.waves.push(makeWave());
      persist();
      renderWizardStep2(op);
    });

    // remover wave
    card.querySelectorAll('[data-lact="wave-del"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (sg.model.waves.length <= 1) return;
        const wid = btn.dataset.wid;
        sg.model.waves = sg.model.waves.filter(w => w.id !== wid);
        persist();
        renderWizardStep2(op);
      });
    });
  }

  async function populateLotGroupSelect(sg) {
    const sel = content.querySelector(`.mog-lot[data-sgid="${sg.id}"] [data-lact="group"]`);
    if (!sel) return;
    sel.innerHTML = `<option value="-1">Carregando...</option>`;
    const groups = await getGroups();
    // sg.importGroupId = -1 (default "nenhum"), 0 = Todos, >0 = grupos reais
    sel.innerHTML = `<option value="-1">— Escolha um grupo —</option>` + groups
      .map(g => `<option value="${g.id}" ${g.id === sg.importGroupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
      .join('');
  }

  async function importLotFromGroup(sg) {
    if (sg.importGroupId === -1 || sg.importGroupId == null) {
      pushSchedulerLog(`[${sg.label}] selecione um grupo antes de importar.`);
      return;
    }
    pushSchedulerLog(`[${sg.label}] importando aldeias do grupo...`);
    try {
      const villages = await Game.fetchGroupVillages(sg.importGroupId);
      const replaced = villages
        .filter(v => v.x != null && v.y != null)
        .map((v, i) => ({
          entryId: `sv_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          villageId: v.id,
          name: v.name,
          x: v.x,
          y: v.y,
        }));
      const previous = sg.villages.length;
      sg.villages = replaced;            // substitui (não acumula)
      pushSchedulerLog(`[${sg.label}] ${replaced.length} aldeia(s) importada(s)${previous ? ` (substituiu ${previous} anteriores)` : ''}.`);
      persist();
      const op = getActiveOperation();
      if (op) renderWizardStep2(op);
    } catch (e) {
      pushSchedulerLog(`[${sg.label}] erro ao importar: ${e.message}`);
    }
  }

  async function addVillagesByCoords(sg, coordList) {
    pushSchedulerLog(`[${sg.label}] resolvendo ${coordList.length} coordenada(s)...`);
    try {
      const all = await Game.fetchAllVillages();
      const byCoords = new Map();
      all.forEach(v => {
        if (v.x != null && v.y != null) byCoords.set(`${v.x}|${v.y}`, v);
      });
      const added = [];
      const missing = [];
      for (const c of coordList) {
        const v = byCoords.get(c);
        if (!v) { missing.push(c); continue; }
        added.push({
          entryId: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          villageId: v.id,
          name: v.name,
          x: v.x,
          y: v.y,
        });
      }
      sg.villages = [...sg.villages, ...added];
      sg.rawText = '';
      pushSchedulerLog(`[${sg.label}] ${added.length} adicionada(s)${missing.length ? `, ${missing.length} não encontrada(s) entre suas aldeias` : ''}.`);
      persist();
      const op = getActiveOperation();
      if (op) renderWizardStep2(op);
    } catch (e) {
      pushSchedulerLog(`[${sg.label}] erro: ${e.message}`);
    }
  }

  // sincroniza sg.villages com o conteúdo livre da textarea (linha por linha).
  // - mantém entries existentes correspondentes (preserva ordem digitada)
  // - resolve villageId pra coords novas via fetchAllVillages
  // - avisa se alguma coord não bater com aldeia do jogador
  async function syncVillagesFromTextarea(sg, raw) {
    // extrai e ordena pelo texto digitado, permitindo duplicatas (1 coord 3x = 3 entries)
    const re = /(\d{1,3})\|(\d{1,3})/g;
    const coordsTyped = [];
    let m;
    while ((m = re.exec(raw)) !== null) coordsTyped.push(`${m[1]}|${m[2]}`);

    if (!coordsTyped.length) {
      const had = sg.villages.length;
      if (!had) return;     // já estava vazio
      sg.villages = [];
      persist();
      const op = getActiveOperation();
      if (op) renderWizardStep2(op);
      pushSchedulerLog(`[${sg.label}] todas as ${had} aldeia(s) removidas via edição manual.`);
      return;
    }

    // separa coords já conhecidas (existentes em sg.villages) das novas
    const existingByCoord = new Map();
    sg.villages.forEach(v => {
      const k = `${v.x}|${v.y}`;
      if (!existingByCoord.has(k)) existingByCoord.set(k, []);
      existingByCoord.get(k).push(v);
    });

    const unknownCoords = coordsTyped.filter(c => !existingByCoord.has(c));
    let resolvedNew = new Map();   // coord → village
    if (unknownCoords.length) {
      try {
        const all = await Game.fetchAllVillages();
        all.forEach(v => {
          if (v.x != null && v.y != null) resolvedNew.set(`${v.x}|${v.y}`, v);
        });
      } catch (e) {
        pushSchedulerLog(`[${sg.label}] erro ao resolver coordenadas novas: ${e.message}`);
      }
    }

    const newList = [];
    const missing = [];
    const consumed = new Map();    // contador de uso por coord existente
    for (const c of coordsTyped) {
      const pool = existingByCoord.get(c);
      if (pool) {
        const idx = consumed.get(c) || 0;
        if (idx < pool.length) {
          newList.push(pool[idx]);
          consumed.set(c, idx + 1);
          continue;
        }
        // pool esgotado pra essa coord (digitou mais vezes que tinha) → cria duplicata
        const v = pool[0];
        newList.push({
          entryId: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          villageId: v.villageId,
          name: v.name,
          x: v.x,
          y: v.y,
        });
        continue;
      }
      const v = resolvedNew.get(c);
      if (!v) { missing.push(c); continue; }
      newList.push({
        entryId: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        villageId: v.id,
        name: v.name,
        x: v.x,
        y: v.y,
      });
    }

    const before = sg.villages.length;
    sg.villages = newList;
    persist();
    const op = getActiveOperation();
    if (op) renderWizardStep2(op);

    if (missing.length || newList.length !== before) {
      pushSchedulerLog(
        `[${sg.label}] lista atualizada: ${newList.length} aldeia(s)` +
        (missing.length ? ` · ${missing.length} ignorada(s) (não pertence ao jogador): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}` : '')
      );
    }
  }

  // ---- passo 3: calcular & revisar ----
  function makeCommand(overrides = {}) {
    return {
      id: overrides.id || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetId: overrides.targetId,
      sourceEntryId: overrides.sourceEntryId,
      sourceVillageId: overrides.sourceVillageId,
      sourceCoords: overrides.sourceCoords,
      targetCoords: overrides.targetCoords,
      slotIndex: overrides.slotIndex ?? 0,
      slotKind: overrides.slotKind || 'attack',
      commandIndexInSource: overrides.commandIndexInSource ?? 0,
      type: overrides.type || 'attack',
      catapultTarget: overrides.catapultTarget,
      units: overrides.units || {},
      slowestSpeedMpf: overrides.slowestSpeedMpf || 0,
      distance: overrides.distance || 0,
      travelMs: overrides.travelMs || 0,
      arrivalAt: overrides.arrivalAt || 0,
      ms: overrides.ms ?? 0,
      executeAt: overrides.executeAt || 0,
      status: overrides.status || 'pending',
      attempts: overrides.attempts ?? 0,
      lastError: overrides.lastError || '',
      serverResponse: overrides.serverResponse ?? null,
    };
  }

  // resolve quantidade de cada unidade conforme o modo configurado, dado as tropas reais.
  // retorna { units: {id: count}, hasAny: bool }
  function resolveUnits(wave, availableUnits) {
    const out = {};
    for (const u of COMMAND_UNITS) {
      const cfg = wave.units[u.id];
      if (!cfg || !cfg.enabled) continue;
      const have = availableUnits?.[u.id] || 0;
      let n = 0;
      if (cfg.mode === 'all') n = have;
      else if (cfg.mode === 'percent') n = Math.floor(have * (cfg.value / 100));
      else if (cfg.mode === 'count') {
        // 'count' é tudo-ou-nada: se não tem o suficiente, descarta essa unidade
        n = have >= cfg.value ? cfg.value : 0;
      }
      if (n > 0) out[u.id] = n;
    }
    return { units: out, hasAny: Object.keys(out).length > 0 };
  }


  // Algoritmo: pra cada slot do alvo (em ordem de cadastro), pega a origem
  // mais próxima do pool ainda não usada. Se nenhum candidato chega a tempo
  // ou tem tropas, registra em `unreachable`.
  async function solveOperation(op) {
    pushSchedulerLog(`[${op.name}] iniciando cálculo...`);
    await ensureWorldConfig();
    await ensureLatencyMeasured();
    const now = serverNow();

    // 1. expande slots por alvo (em ordem de cadastro)
    const slots = [];
    for (const t of op.targets) {
      const arrivalAt = t.arrivalRandom?.toAt && t.arrivalRandom?.fromAt
        ? Math.floor(t.arrivalRandom.fromAt + Math.random() * (t.arrivalRandom.toAt - t.arrivalRandom.fromAt))
        : t.arrivalAt;
      if (!arrivalAt) {
        op.unreachable.push({ targetId: t.id, slotKind: 'attack', slotIndex: -1, reason: 'sem horário de chegada definido' });
        continue;
      }
      ['attack', 'support', 'noble'].forEach(kind => {
        for (let i = 0; i < (t.counts?.[kind] || 0); i++) {
          slots.push({ targetId: t.id, target: t, arrivalAt, slotKind: kind });
        }
      });
    }

    // 2. monta pool de origens (1 entry = 1 slot atendível)
    const pool = [];
    for (const sg of op.sourceGroups) {
      for (const v of sg.villages) {
        pool.push({ entryId: v.entryId, sg, village: v, used: false });
      }
    }

    // 3. busca tropas reais (1 fetch por grupo distinto, ou "Todos" se há lotes manuais).
    // Sempre busca pra validar disponibilidade — modo 'count' também precisa pra checar `have >= value`.
    const unitsByVillage = new Map();
    if (op.sourceGroups.length) {
      pushSchedulerLog(`[${op.name}] buscando tropas atuais...`);
      try {
        const map = await Game.fetchAllUnits(0);
        map.forEach((units, vid) => unitsByVillage.set(vid, units));
      } catch (e) {
        pushSchedulerLog(`[${op.name}] erro ao buscar tropas: ${e.message}`);
      }
      pushSchedulerLog(`[${op.name}] tropas obtidas: ${unitsByVillage.size} aldeia(s).`);
    }

    // 4. limpa resultado anterior
    op.commands = [];
    op.unreachable = [];

    // 5. resolve cada slot
    let resolved = 0;
    for (const slot of slots) {
      // candidatos elegíveis: não usados, tipo bate com slot
      const candidates = pool
        .filter(e => !e.used)
        .filter(e => kindMatchesType(slot.slotKind, e.sg.model.type))
        .map(e => ({ entry: e, dist: distance(e.village, slot.target) }))
        .sort((a, b) => a.dist - b.dist);

      if (!candidates.length) {
        const totalPool = pool.filter(e => !e.used).length;
        op.unreachable.push({
          targetId: slot.targetId, slotKind: slot.slotKind,
          reason: `sem origem disponível (${totalPool} no pool, mas tipo ${slot.slotKind} não casa com lotes existentes)`,
        });
        continue;
      }

      // tenta cada candidato em ordem de proximidade
      let picked = null;
      let lastReason = '';
      for (const cand of candidates) {
        const m = cand.entry.sg.model;
        // ms da chegada vem direto de target.arrivalAt agora; ondas extras = +100ms cada.
        const baseMs = 0;
        const available = unitsByVillage.get(String(cand.entry.village.villageId)) || unitsByVillage.get(cand.entry.village.villageId) || null;
        // resolve cada wave; se a wave 1 não tem tropa nenhuma, descarta candidato
        const resolvedWaves = [];
        let waveOk = true;
        for (let k = 0; k < m.waves.length; k++) {
          const r = resolveUnits(m.waves[k], available);
          if (!r.hasAny) {
            lastReason = `aldeia ${cand.entry.village.x}|${cand.entry.village.y}: wave ${k + 1} sem tropas (available=${available ? Object.entries(available).filter(([_, n]) => n > 0).map(([u, n]) => `${u}:${n}`).join(',') || 'vazio' : 'NÃO BUSCADO'})`;
            waveOk = false; break;
          }
          const slowest = slowestSpeed(r.units);
          if (!slowest) {
            lastReason = `aldeia ${cand.entry.village.x}|${cand.entry.village.y}: speed da unidade mais lenta = 0 (worldConfig.unitSpeed vazio?)`;
            waveOk = false; break;
          }
          const travel = travelTimeMs(cand.entry.village, slot.target, slowest);
          const executeAt = slot.arrivalAt - travel + (baseMs + k * 100);
          if (executeAt - now < -2000) {
            lastReason = 'não há tempo suficiente';
            waveOk = false; break;
          }
          resolvedWaves.push({ units: r.units, slowest, travel, ms: baseMs + k * 100, executeAt });
        }
        if (waveOk) {
          picked = { cand, baseMs, resolvedWaves };
          break;
        }
      }

      if (!picked) {
        op.unreachable.push({
          targetId: slot.targetId, slotKind: slot.slotKind,
          reason: lastReason || 'nenhuma origem viável',
        });
        continue;
      }

      picked.cand.entry.used = true;
      const m = picked.cand.entry.sg.model;
      const v = picked.cand.entry.village;
      picked.resolvedWaves.forEach((rw, k) => {
        op.commands.push(makeCommand({
          targetId: slot.targetId,
          sourceEntryId: picked.cand.entry.entryId,
          sourceVillageId: v.villageId,
          sourceCoords: `${v.x}|${v.y}`,
          targetCoords: `${slot.target.x}|${slot.target.y}`,
          slotKind: slot.slotKind,
          commandIndexInSource: k,
          type: m.type,
          catapultTarget: m.catapultTarget,
          units: rw.units,
          slowestSpeedMpf: rw.slowest,
          distance: distance(v, slot.target),
          travelMs: rw.travel,
          arrivalAt: slot.arrivalAt,
          ms: rw.ms,
          executeAt: rw.executeAt,
        }));
      });
      resolved++;
    }

    op.status = 'calculated';
    persist();
    pushSchedulerLog(`[${op.name}] cálculo concluído: ${resolved}/${slots.length} slot(s) atendido(s) · ${op.commands.length} comando(s) · ${op.unreachable.length} sem possibilidade.`);
  }

  function kindMatchesType(slotKind, modelType) {
    // 'noble' aceita só ataque (com nobre); 'attack' aceita ataque; 'support' aceita apoio.
    if (slotKind === 'support') return modelType === 'support';
    return modelType === 'attack';
  }

  // ---- UI passo 3 ----
  function renderWizardStep3(op) {
    const body = content.querySelector('#mog-wiz-body');
    const hasResult = op.commands.length > 0 || op.unreachable.length > 0;

    body.innerHTML = `
      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>Cálculo & revisão</span>
          <button class="mog-btn mog-btn-ghost" id="mog-wiz-calc" style="width:auto;">${hasResult ? 'Recalcular' : 'Calcular'}</button>
        </div>
        ${hasResult ? '' : `
          <div class="mog-wiz-hint" style="margin-top:6px;">
            Clique em <strong style="color:${COLOR_ACCENT}">Calcular</strong> para parear cada alvo com a origem mais próxima e calcular o horário de saída exato de cada comando.
          </div>
        `}
        <div id="mog-wiz-result"></div>
      </div>

      <div class="mog-wiz-foot">
        <div class="mog-wiz-foot-spacer"></div>
        <button class="mog-btn mog-btn-ghost" id="mog-wiz-prev3" style="width:auto;">← Voltar: Origens</button>
        <button class="mog-btn" id="mog-wiz-next3" ${op.commands.length === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;width:auto;"' : 'style="width:auto;"'}>Próximo: Confirmar →</button>
      </div>
    `;

    body.querySelector('#mog-wiz-calc').addEventListener('click', async () => {
      const btn = body.querySelector('#mog-wiz-calc');
      btn.disabled = true;
      btn.textContent = 'Calculando...';
      try {
        await solveOperation(op);
      } catch (e) {
        pushSchedulerLog(`[${op.name}] erro no cálculo: ${e.message}`);
      }
      renderWizardStep3(op);
    });

    body.querySelector('#mog-wiz-prev3').addEventListener('click', () => {
      state.scheduler.ui.wizardStep = 2;
      op.step = 2;
      persist();
      renderOpWizard(op);
    });

    const nextBtn = body.querySelector('#mog-wiz-next3');
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener('click', () => {
        state.scheduler.ui.wizardStep = 4;
        op.step = 4;
        persist();
        renderOpWizard(op);
      });
    }

    if (hasResult) renderResultBlock(op);
  }

  function renderResultBlock(op) {
    const wrap = content.querySelector('#mog-wiz-result');
    if (!wrap) return;

    const sent = op.commands.length;
    const okCount = op.commands.filter(c => c.executeAt >= Date.now()).length;
    const lateCount = sent - okCount;

    let summaryHtml = `
      <div class="mog-cmd-summary">
        <div><strong>${sent}</strong> comando(s) gerado(s)</div>
        <div><span class="mog-cmd-summary-pill mog-cmd-summary-ok">${okCount} OK</span></div>
        ${lateCount ? `<div><span class="mog-cmd-summary-pill mog-cmd-summary-warn">${lateCount} atraso</span></div>` : ''}
        ${op.unreachable.length ? `<div><span class="mog-cmd-summary-pill mog-cmd-summary-err">${op.unreachable.length} sem possibilidade</span></div>` : ''}
      </div>
    `;

    let unreachHtml = '';
    if (op.unreachable.length) {
      unreachHtml = `
        <div class="mog-unreach">
          <div class="mog-unreach-title">Sem possibilidade (${op.unreachable.length})</div>
          <ul>
            ${op.unreachable.map(u => {
              const t = op.targets.find(x => x.id === u.targetId);
              const coords = t ? t.coords : '?';
              const kindLabel = { attack: 'Ataque', support: 'Apoio', noble: 'Nobre' }[u.slotKind] || u.slotKind;
              return `<li><strong>${escapeHtml(coords)}</strong> · ${kindLabel} · ${escapeHtml(u.reason)}</li>`;
            }).join('')}
          </ul>
          <div style="margin-top:6px;font-size:10.5px;color:var(--mog-text-dim);">
            Volte ao passo de <strong>Origens</strong> e ajuste tropas (ex: remova Aríetes pra ficar mais rápido) ou cadastre mais aldeias.
          </div>
        </div>
      `;
    }

    let tableHtml = '';
    if (op.commands.length) {
      const sorted = [...op.commands].sort((a, b) => a.executeAt - b.executeAt);
      tableHtml = `
        <div class="mog-cmd-table">
          <div class="mog-cmd-thead">
            <div>Origem</div>
            <div>→ Alvo</div>
            <div>Tropas</div>
            <div>Dist.</div>
            <div>Viagem</div>
            <div>Chegada</div>
            <div>MS</div>
            <div>Sair em</div>
            <div></div>
          </div>
          ${sorted.map(c => renderCmdRow(c)).join('')}
        </div>
      `;
    }

    wrap.innerHTML = summaryHtml + unreachHtml + tableHtml;

    // bind handlers
    wrap.querySelectorAll('[data-cmd-act]').forEach(el => {
      el.addEventListener('change', e => onCmdChange(op, e));
      if (el.dataset.cmdAct === 'delete') {
        el.addEventListener('click', () => {
          op.commands = op.commands.filter(c => c.id !== el.dataset.cid);
          persist();
          renderWizardStep3(op);
        });
      }
    });
  }

  function renderCmdRow(c) {
    const now = serverNow();
    const isLate = c.executeAt < now;
    const rowCls = isLate ? 'mog-cmd-row mog-cmd-row-late' : 'mog-cmd-row';

    const unitsHtml = Object.entries(c.units)
      .filter(([, n]) => n > 0)
      .map(([uid, n]) => `${n}<img src="/graphic/unit/unit_${uid}.png" alt="${uid}" title="${uid}" onerror="this.style.display='none'">`)
      .join(' ');

    const fmtDur = ms => {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(ss).padStart(2, '0')}s`;
    };

    return `
      <div class="${rowCls}" data-cid="${c.id}">
        <div class="mog-cmd-coords">${escapeHtml(c.sourceCoords)}</div>
        <div class="mog-cmd-coords">${escapeHtml(c.targetCoords)}</div>
        <div class="mog-cmd-units">${unitsHtml}</div>
        <div title="${c.distance.toFixed(2)} campos">${c.distance.toFixed(1)}</div>
        <div title="${fmtDur(c.travelMs)}">${fmtDur(c.travelMs)}</div>
        <div class="mog-cmd-arr">${fmtFullDate(c.arrivalAt)}</div>
        <div><input type="number" min="0" max="999" data-cmd-act="ms" data-cid="${c.id}" value="${c.arrivalAt % 1000}"></div>
        <div class="mog-cmd-arr">${fmtFullDate(c.executeAt)}</div>
        <div><button class="mog-iconbtn mog-iconbtn-danger" data-cmd-act="delete" data-cid="${c.id}" title="Remover comando">×</button></div>
      </div>
    `;
  }

  function onCmdChange(op, e) {
    const cid = e.target.dataset.cid;
    const c = op.commands.find(x => x.id === cid);
    if (!c) return;
    if (e.target.dataset.cmdAct === 'ms') {
      const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      // Atualiza o ms da chegada (últimos 3 dígitos de arrivalAt) e recalcula executeAt.
      // O offset de ondas (100ms por wave dentro do bundle) é mantido como antes.
      const baseArrival = Math.floor((c.arrivalAt || 0) / 1000) * 1000;
      c.arrivalAt = baseArrival + v;
      const waveOffset = (c.commandIndexInSource || 0) * 100;
      c.ms = waveOffset;
      c.executeAt = c.arrivalAt - c.travelMs + waveOffset;
      persist();
      renderResultBlock(op);
    }
  }

  // ---- passo 4: confirmar & ativar ----
  function renderWizardStep4(op) {
    const body = content.querySelector('#mog-wiz-body');
    const now = serverNow();
    const cmds = [...op.commands].sort((a, b) => a.executeAt - b.executeAt);
    const total = cmds.length;
    const overdue = cmds.filter(c => c.executeAt < now).length;
    const ready = total - overdue;
    const first = cmds.find(c => c.executeAt >= now);
    const last = cmds[cmds.length - 1];
    const isExecuting = op.status === 'executing';

    const targetSet = new Set(cmds.map(c => c.targetCoords));
    const sourceSet = new Set(cmds.map(c => c.sourceCoords));

    const fmtDate = fmtFullDate;
    const fmtUntil = ts => {
      if (!ts) return '—';
      const ms = ts - now;
      if (ms < 0) return 'agora';
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      if (h > 0) return `em ${h}h ${pad2(m)}m`;
      if (m > 0) return `em ${m}m ${pad2(ss)}s`;
      return `em ${ss}s`;
    };
    function pad2(n) { return String(n).padStart(2, '0'); }

    body.innerHTML = `
      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>Resumo da operação</span>
          ${isExecuting ? '<span style="color:var(--mog-success);font-weight:700;text-transform:none;letter-spacing:0;">● Operação em execução</span>' : ''}
        </div>

        <div class="mog-confirm-stats">
          <div class="mog-confirm-stat">
            <div class="mog-confirm-stat-num">${total}</div>
            <div class="mog-confirm-stat-label">Comandos</div>
          </div>
          <div class="mog-confirm-stat">
            <div class="mog-confirm-stat-num">${targetSet.size}</div>
            <div class="mog-confirm-stat-label">Alvos</div>
          </div>
          <div class="mog-confirm-stat">
            <div class="mog-confirm-stat-num">${sourceSet.size}</div>
            <div class="mog-confirm-stat-label">Aldeias origem</div>
          </div>
          <div class="mog-confirm-stat">
            <div class="mog-confirm-stat-num" style="${overdue ? 'color:var(--mog-error);' : ''}">${ready}</div>
            <div class="mog-confirm-stat-label">${overdue ? `Prontos (${overdue} expirados)` : 'Prontos para envio'}</div>
          </div>
        </div>

        <div class="mog-confirm-window">
          <div class="mog-confirm-window-title">Janela de execução</div>
          <div class="mog-confirm-window-row">
            <span>Primeiro envio</span>
            <strong>${first ? fmtDate(first.executeAt) : '—'} · ${first ? fmtUntil(first.executeAt) : '—'}</strong>
          </div>
          <div class="mog-confirm-window-row">
            <span>Último envio</span>
            <strong>${last ? fmtDate(last.executeAt) : '—'} · ${last ? fmtUntil(last.executeAt) : '—'}</strong>
          </div>
          ${overdue ? `
            <div class="mog-confirm-window-row">
              <span style="color:var(--mog-error);">Comandos expirados</span>
              <strong style="color:var(--mog-error);">${overdue}</strong>
            </div>
          ` : ''}
        </div>

        ${overdue ? `
          <div class="mog-confirm-warn">
            <span class="mog-confirm-warn-icon">⚠</span>
            <div>
              <strong>${overdue} comando(s) já passaram do horário</strong> e não serão enviados.
              Volte ao passo anterior pra remover ou ajustar antes de ativar.
            </div>
          </div>
        ` : ''}

        <button class="mog-activate-btn" id="mog-op-activate" ${ready === 0 ? 'disabled' : ''}>
          ${ready === 0 ? 'Nenhum comando válido para enviar' : `Registrar comandos (${ready})`}
        </button>
      </div>

      <div class="mog-wiz-foot">
        <div class="mog-wiz-foot-spacer"></div>
        <button class="mog-btn mog-btn-ghost" id="mog-wiz-prev4" style="width:auto;">← Voltar: Calcular</button>
      </div>
    `;

    body.querySelector('#mog-wiz-prev4').addEventListener('click', () => {
      state.scheduler.ui.wizardStep = 3;
      op.step = 3;
      persist();
      renderOpWizard(op);
    });

    const activateBtn = body.querySelector('#mog-op-activate');
    if (activateBtn) {
      activateBtn.addEventListener('click', () => {
        activateOperation(op);
        // limpa rascunho ativo e leva o usuário pro Painel
        state.scheduler.ui.activeOperationId = null;
        state.scheduler.ui.wizardStep = 1;
        state.ui.activeSection = 'dashboard';
        persist();
        // sincroniza highlight da sidebar
        panel.querySelectorAll('.mog-side-item').forEach(x => x.classList.remove('mog-side-active'));
        const target = panel.querySelector('.mog-side-item[data-section="dashboard"]');
        if (target) target.classList.add('mog-side-active');
        renderContent();
      });
    }
  }

  function activateOperation(op) {
    op.status = 'executing';
    op.activatedAt = Date.now();
    // marca todos os comandos prontos como 'pending' pra entrar no scheduler
    op.commands.forEach(cmd => {
      if (cmd.status !== 'pending' && cmd.status !== 'scheduled') return;
      cmd.status = 'pending';
    });
    persist();
    scheduleAllCommands(op);
    const ready = op.commands.filter(c => c.status === 'scheduled' || c.status === 'pending').length;
    pushSchedulerLog(`${ready} comando(s) registrado(s) e agendado(s).`);
  }

  // Cancela um único comando (e seu bundle, já que vão juntos no mesmo POST).
  function cancelCommand(cmd) {
    const bundle = getBundleSiblings(cmd);
    bundle.forEach(s => {
      if (['pending', 'scheduled', 'confirming', 'bundled'].includes(s.status)) {
        clearTimeout(commandTimers.get(s.id));
        clearTimeout(prepareTimers.get(s.id));
        clearTimeout(remeasureTimers.get(s.id));
        commandTimers.delete(s.id);
        prepareTimers.delete(s.id);
        remeasureTimers.delete(s.id);
        preparedBundles.delete(s.id);
        s.status = 'aborted';
      }
    });
    persist();
    pushSchedulerLog(`comando cancelado: ${cmd.sourceCoords} → ${cmd.targetCoords}`);
  }

  // Lista plana de TODOS os comandos de operações em execução, ordenados por executeAt.
  function getAllScheduledCommands() {
    const out = [];
    state.scheduler.operations.forEach(op => {
      if (op.status !== 'executing' && op.status !== 'done') return;
      out.push(...op.commands);
    });
    return out.sort((a, b) => a.executeAt - b.executeAt);
  }


  // ---- painel de agendamentos (dashboard) ----
  let dashboardTickerId = null;
  let dashboardShowHistory = false;

  function renderDashboard() {
    const lat = state.scheduler.latency;
    const autoPing = lat.manualOverride === 0;
    const allCmds = getAllScheduledCommands();
    const TERMINAL = ['sent', 'failed_request', 'failed_overdue', 'aborted'];
    const active = allCmds.filter(c => !TERMINAL.includes(c.status));
    const history = allCmds.filter(c => TERMINAL.includes(c.status));
    const sent = history.filter(c => c.status === 'sent').length;
    const failed = history.length - sent;

    content.innerHTML = `
      <div class="mog-section-head">
        <div>
          <h2>Painel de Agendamentos</h2>
          <p>${active.length} comando(s) agendado(s) · ${sent} enviado(s)${failed ? ` · ${failed} falha(s)` : ''}</p>
        </div>
      </div>

      <div class="mog-dash-toolbar">
        <div class="mog-dash-toolbar-section">
          <div class="mog-dash-toggle ${autoPing ? 'mog-dash-toggle-on' : ''}" id="mog-dash-ping-toggle" title="Ativar/desativar cálculo automático de ping"></div>
          <span>Ping automático ${autoPing ? '<strong>ligado</strong>' : '<strong>desligado</strong>'}</span>
        </div>
        ${autoPing ? `
          <div class="mog-dash-toolbar-section">
            <span>Ping calculado: <strong style="color:${COLOR_ACCENT};">${latencyCompensation()} ms</strong></span>
          </div>
        ` : `
          <div class="mog-dash-toolbar-section">
            <span>Antecipação manual:</span>
            <input type="number" min="0" max="2000" id="mog-dash-manual-input" value="${lat.manualOverride}">
            <span>ms</span>
          </div>
        `}
        <div class="mog-dash-toolbar-spacer"></div>
        <button class="mog-log-action" id="mog-dash-clear-history" ${history.length === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>Limpar histórico</button>
      </div>

      <div id="mog-dash-active"></div>

      ${history.length > 0 ? `
        <button class="mog-dash-history-toggle" id="mog-dash-history-btn">
          ${dashboardShowHistory ? '▲ Esconder histórico' : `▼ Mostrar histórico (${history.length})`}
        </button>
        ${dashboardShowHistory ? '<div id="mog-dash-history"></div>' : ''}
      ` : ''}
    `;

    // toggle ping automático
    content.querySelector('#mog-dash-ping-toggle').addEventListener('click', () => {
      if (lat.manualOverride > 0) {
        lat.manualOverride = 0;
      } else {
        lat.manualOverride = Math.max(1, Math.round(lat.avgRtt * 0.5));
      }
      persist();
      renderDashboard();
    });

    const inp = content.querySelector('#mog-dash-manual-input');
    if (inp) {
      inp.addEventListener('change', e => {
        const v = Math.max(1, Math.min(2000, parseInt(e.target.value, 10) || 1));
        lat.manualOverride = v;
        e.target.value = v;
        persist();
        renderDashboard();
      });
    }

    const histBtn = content.querySelector('#mog-dash-history-btn');
    if (histBtn) {
      histBtn.addEventListener('click', () => {
        dashboardShowHistory = !dashboardShowHistory;
        renderDashboard();
      });
    }

    const clearBtn = content.querySelector('#mog-dash-clear-history');
    if (clearBtn && history.length > 0) {
      clearBtn.addEventListener('click', () => {
        if (!confirm('Limpar todos os comandos do histórico (enviados/falhos)?')) return;
        // remove comandos terminais; remove operações que ficarem vazias
        state.scheduler.operations.forEach(op => {
          op.commands = op.commands.filter(c => !TERMINAL.includes(c.status));
        });
        state.scheduler.operations = state.scheduler.operations.filter(op => op.commands.length > 0 || op.status === 'draft');
        persist();
        renderDashboard();
      });
    }

    // tabela de ativos
    const activeWrap = content.querySelector('#mog-dash-active');
    if (active.length === 0) {
      activeWrap.innerHTML = `<div class="mog-dash-empty">Nenhum comando agendado. Vá em <strong style="color:${COLOR_ACCENT};">Agendador</strong> para criar um.</div>`;
    } else {
      activeWrap.innerHTML = renderDashTable(active, 'active');
    }

    // tabela de histórico
    if (dashboardShowHistory) {
      const histWrap = content.querySelector('#mog-dash-history');
      if (histWrap) histWrap.innerHTML = renderDashTable(history, 'history');
    }

    // bind handlers de cancelar
    content.querySelectorAll('[data-dash-act="cancel"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = findCommandById(btn.dataset.cid);
        if (!cmd) return;
        if (!confirm(`Cancelar comando ${cmd.sourceCoords} → ${cmd.targetCoords}?`)) return;
        cancelCommand(cmd);
        renderDashboard();
      });
    });

    // ticker de 1s pra atualizar countdowns + detectar mudanças de status
    if (dashboardTickerId) clearInterval(dashboardTickerId);
    let lastSignature = dashboardSignature();
    dashboardTickerId = setInterval(() => {
      if (state.ui.activeSection !== 'dashboard') {
        clearInterval(dashboardTickerId);
        dashboardTickerId = null;
        return;
      }
      const sig = dashboardSignature();
      if (sig !== lastSignature) {
        // mudança estrutural (status mudou) → rerender completo
        lastSignature = sig;
        renderDashboard();
      } else {
        // só countdown
        updateDashCountdowns();
      }
    }, 1000);
  }

  // assinatura do estado visível do painel — usado pra detectar mudança e re-render
  function dashboardSignature() {
    const parts = [];
    state.scheduler.operations.forEach(op => {
      op.commands.forEach(c => parts.push(c.id + ':' + c.status));
    });
    return parts.join('|');
  }

  function findCommandById(cid) {
    for (const op of state.scheduler.operations) {
      const c = op.commands.find(x => x.id === cid);
      if (c) return c;
    }
    return null;
  }

  function renderDashTable(cmds, kind) {
    const rows = cmds.map(c => renderDashRow(c, kind)).join('');
    return `
      <div class="mog-dash-table">
        <div class="mog-dash-thead">
          <div>Status</div>
          <div>Tipo</div>
          <div>Origem</div>
          <div>→ Alvo</div>
          <div>Tropas</div>
          <div>Saída</div>
          <div>Chegada</div>
          <div>Faltam</div>
          <div></div>
        </div>
        ${rows}
      </div>
    `;
  }

  function renderDashRow(c, kind) {
    const fmtDate = fmtFullDate;
    const unitsHtml = Object.entries(c.units || {})
      .filter(([, n]) => n > 0)
      .map(([uid, n]) => `${n}<img src="/graphic/unit/unit_${uid}.png" alt="${uid}" title="${uid}" onerror="this.style.display='none'">`)
      .join(' ');

    const statusLabels = {
      pending: 'Pendente', scheduled: 'Agendado', confirming: 'Confirmando',
      sending: 'Enviando', bundled: 'Junto',
      sent: 'Enviado', failed_request: 'Falha', failed_overdue: 'Expirado', aborted: 'Cancelado',
    };
    const statusClasses = {
      pending: 'mog-dash-st-scheduled', scheduled: 'mog-dash-st-scheduled', bundled: 'mog-dash-st-scheduled',
      confirming: 'mog-dash-st-confirming', sending: 'mog-dash-st-sending',
      sent: 'mog-dash-st-sent',
      failed_request: 'mog-dash-st-failed', failed_overdue: 'mog-dash-st-failed',
      aborted: 'mog-dash-st-aborted',
    };
    const stCls = statusClasses[c.status] || 'mog-dash-st-scheduled';
    const stLabel = statusLabels[c.status] || c.status;

    const rowCls = c.status === 'sent' ? 'mog-dash-row-sent'
      : (c.status === 'failed_request' || c.status === 'failed_overdue') ? 'mog-dash-row-failed' : '';

    const showCancel = kind === 'active' && ['pending', 'scheduled', 'bundled'].includes(c.status);

    const typeLabel = c.type === 'support' ? 'Apoio' : 'Ataque';
    const typeCls = c.type === 'support' ? 'mog-dash-type-support' : 'mog-dash-type-attack';

    return `
      <div class="mog-dash-row ${rowCls}" data-cid="${c.id}" data-execute-at="${c.executeAt}">
        <div><span class="mog-dash-status ${stCls}">${stLabel}</span></div>
        <div><span class="mog-dash-type ${typeCls}">${typeLabel}</span></div>
        <div>${coordsLink(c.sourceCoords, c.sourceVillageId)}</div>
        <div>${coordsLink(c.targetCoords)}</div>
        <div class="mog-dash-units">${unitsHtml}</div>
        <div class="mog-dash-when">${fmtDate(c.executeAt)}</div>
        <div class="mog-dash-when">${fmtDate(c.arrivalAt + (c.ms || 0))}</div>
        <div class="mog-dash-countdown" data-cd>${formatCountdown(c.executeAt)}</div>
        <div>${showCancel ? `<button class="mog-iconbtn mog-iconbtn-danger" data-dash-act="cancel" data-cid="${c.id}" title="Cancelar comando">×</button>` : ''}</div>
      </div>
    `;
  }

  // Gera link clicável pra coordenada. Se houver villageId, abre info_village;
  // senão, abre o mapa centrado nela.
  function coordsLink(coords, villageId) {
    if (!coords) return '<span class="mog-dash-coords">—</span>';
    const [x, y] = coords.split('|');
    const currentVillage = unsafeWindow.game_data?.village?.id || '';
    const url = villageId
      ? `/game.php?village=${currentVillage}&screen=info_village&id=${villageId}`
      : `/game.php?village=${currentVillage}&screen=info_village&id=&x=${x}&y=${y}`;
    return `<a class="mog-dash-coords-link" href="${url}#${x};${y}" target="_blank" rel="noopener">${escapeHtml(coords)}</a>`;
  }

  function formatCountdown(serverTs) {
    if (!serverTs) return '—';
    const ms = serverTs - serverNow();
    if (ms < 0) return '—';
    // arredonda pra cima pra "1s" não virar "0s" enquanto ainda há tempo
    const totalS = Math.ceil(ms / 1000);
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function updateDashCountdowns() {
    document.querySelectorAll('.mog-dash-row[data-execute-at]').forEach(row => {
      const ts = parseInt(row.dataset.executeAt, 10);
      if (!ts) return;
      const cell = row.querySelector('[data-cd]');
      if (!cell) return;
      const ms = ts - serverNow();
      cell.textContent = formatCountdown(ts);
      cell.classList.remove('mog-dash-soon', 'mog-dash-overdue');
      if (ms < 0) cell.classList.add('mog-dash-overdue');
      else if (ms < 30 * 1000) cell.classList.add('mog-dash-soon');
    });
  }

  // ---- farmer section ----

  // Unidades exibidas no farmer. Catapulta é fora porque farm de bárbara não usa.
  // Quando salvar no jogo, mantemos `catapult: 0` (campo existe no template do TW).
  const FARMER_UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'knight'];

  // Cache em memória dos templates do jogo. Não persiste — sempre relê do am_farm
  // ao abrir a tela. Quando o usuário edita, fica em farmerTemplatesCache até clicar Salvar.
  let farmerTemplatesCache = null;   // { templates: [{id, units, catapultTarget}, ...], csrf, loadedAt }
  // Flag transitória pra cancelar ciclo ou busca em andamento. Loops checam e fazem
  // break — não persiste pois é só pra interação imediata. Limpa no início de cada operação.
  let farmerAbortRequested = false;

  function renderFarmer() {
    const f = state.farmer;
    const nextLabel = f.enabled && f.nextRunAt > Date.now()
      ? `em ${Math.max(1, Math.round((f.nextRunAt - Date.now()) / 60000))} min`
      : '—';

    const wbList = (f.needsWallBreak || []);
    const wbBlock = wbList.length === 0 ? '' : `
      <div class="mog-farm-block">
        <div class="mog-farm-block-title">Aldeias com defesa (${wbList.length})</div>
        <div class="mog-farm-wb">${
          wbList.map(w => `<div class="mog-farm-wb-row">${w.x}|${w.y}<span class="mog-farm-wb-meta">${new Date(w.lastAttempt).toLocaleString('pt-BR')}</span></div>`).join('')
        }</div>
      </div>
    `;

    content.innerHTML = `
      <div class="mog-farm-head">
        <h2>Farmador</h2>
        <div class="mog-farm-toggle-wrap">
          <span class="mog-farm-next">Próx. ciclo: <strong>${nextLabel}</strong></span>
          <button class="mog-toggle ${f.enabled ? 'mog-on' : ''}" id="mog-farm-toggle">${f.enabled ? 'Ativo' : 'Pausado'}</button>
        </div>
      </div>

      <div class="mog-farm-block" id="mog-farm-templates">
        <div class="mog-farm-block-title">
          Modelos
          <button class="mog-farm-btn-ghost" id="mog-farm-tpl-reload">↻ Recarregar</button>
        </div>
        <div class="mog-farm-tpl-loading">Carregando...</div>
      </div>

      <div class="mog-farm-block">
        <div class="mog-farm-block-title">Configurações</div>
        <div class="mog-farm-config">
          <div class="mog-farm-config-row">
            <label>Grupo</label>
            <select class="mog-select" id="mog-farm-group"><option>...</option></select>
          </div>
          <div class="mog-farm-config-row">
            <label>Intervalo</label>
            <input class="mog-input" type="number" min="1" id="mog-farm-cycle" value="${f.cycleMin}">
            <span class="mog-farm-suffix">min</span>
          </div>
          <div class="mog-farm-config-row">
            <label>Entre envios</label>
            <input class="mog-input" type="number" min="0" id="mog-farm-min" value="${f.timing.minMs}">
            <span class="mog-farm-suffix">a</span>
            <input class="mog-input" type="number" min="0" id="mog-farm-max" value="${f.timing.maxMs}">
            <span class="mog-farm-suffix">ms</span>
          </div>
          <div class="mog-farm-config-row">
            <label>Máx por bárbara</label>
            <input class="mog-input" type="number" min="1" id="mog-farm-maxbarb" value="${f.maxPerBarbarian}">
          </div>
          <div class="mog-farm-config-row" title="Janela mínima entre chegadas de farms na mesma bárbara. Evita 2 farms chegando muito perto. 0 = desativado.">
            <label>Janela entre chegadas</label>
            <input class="mog-input" type="number" min="0" id="mog-farm-arrival-window" value="${f.arrivalWindowMin}">
            <span class="mog-farm-suffix">min</span>
          </div>
          <div class="mog-farm-config-row" title="Raio máximo (em campos) entre origem e bárbara no ciclo. Bárbaras fora do alcance de qualquer origem são puladas. 0 = sem limite.">
            <label>Raio máx farm</label>
            <input class="mog-input" type="number" min="0" max="50" id="mog-farm-max-radius" value="${f.maxFarmRadius}">
            <span class="mog-farm-suffix">campos</span>
          </div>
          <div class="mog-farm-config-row" title="Raio máximo (em campos) usado pelo botão 'Buscar bárbaras' pra descobrir bárbaras novas no mapa.">
            <label>Raio busca</label>
            <input class="mog-input" type="number" min="1" max="50" id="mog-farm-radius" value="${f.searchRadius}">
            <span class="mog-farm-suffix">campos</span>
          </div>
        </div>
      </div>

      <div class="mog-farm-block">
        <div class="mog-farm-actions">
          ${f.busy ? `
            <button class="mog-farm-btn-primary" id="mog-farm-stop">Parar</button>
          ` : `
            <button class="mog-farm-btn-primary" id="mog-farm-run-now">Executar ciclo</button>
            <button class="mog-farm-btn-secondary" id="mog-farm-search">Buscar bárbaras</button>
          `}
        </div>
        <div class="mog-farm-progress" id="mog-farm-progress" style="display: none;">
          <div class="mog-farm-progress-bar"><div class="mog-farm-progress-fill" id="mog-farm-progress-fill"></div></div>
          <div class="mog-farm-progress-text" id="mog-farm-progress-text">0 / 0</div>
        </div>
      </div>

      ${wbBlock}
    `;

    bindFarmer();
    populateFarmerGroupSelect();
    loadFarmerTemplates();
  }

  function renderFarmerTemplatesBlock() {
    const block = content.querySelector('#mog-farm-templates');
    if (!block) return;
    const cache = farmerTemplatesCache;
    if (!cache) {
      block.innerHTML = `
        <div class="mog-farm-block-title">
          Modelos do Assistente
          <button class="mog-farm-btn-ghost" id="mog-farm-tpl-reload">↻ Recarregar do jogo</button>
        </div>
        <div class="mog-farm-tpl-loading">Carregando modelos...</div>
      `;
      block.querySelector('#mog-farm-tpl-reload').addEventListener('click', () => loadFarmerTemplates(true));
      return;
    }

    if (cache.error) {
      block.innerHTML = `
        <div class="mog-farm-block-title">
          Modelos do Assistente
          <button class="mog-farm-btn-ghost" id="mog-farm-tpl-reload">↻ Tentar de novo</button>
        </div>
        <div class="mog-farm-tpl-error">${escapeHtml(cache.error)}</div>
      `;
      block.querySelector('#mog-farm-tpl-reload').addEventListener('click', () => loadFarmerTemplates(true));
      return;
    }

    const tplA = cache.templates[0];
    const tplB = cache.templates[1];
    block.innerHTML = `
      <div class="mog-farm-block-title">
        Modelos do Assistente
        <button class="mog-farm-btn-ghost" id="mog-farm-tpl-reload">↻ Recarregar do jogo</button>
      </div>
      ${tplA ? renderFarmerTemplate('A', tplA) : '<div class="mog-farm-tpl-error">Modelo A não encontrado no jogo.</div>'}
      ${tplB ? renderFarmerTemplate('B', tplB) : '<div class="mog-farm-tpl-error">Modelo B não encontrado no jogo.</div>'}
      <button class="mog-farm-btn-primary" id="mog-farm-save">Salvar modelos no jogo</button>
    `;
    bindFarmerTemplates();
  }

  function renderFarmerTemplate(letter, tpl) {
    const unitsHtml = FARMER_UNIT_KEYS.map(uid => {
      const name = (UNITS.find(u => u.id === uid) || COMMAND_UNITS.find(u => u.id === uid))?.name || uid;
      return `
        <div class="mog-farm-u" title="${name}">
          <img src="${unitImgSrc(uid)}" alt="${name}" onerror="this.style.display='none'">
          <input type="number" min="0" data-farm-unit="${uid}" value="${tpl.units[uid] || 0}">
        </div>
      `;
    }).join('');

    return `
      <div class="mog-farm-tpl" data-letter="${letter}" data-tpl-id="${tpl.id}">
        <div class="mog-farm-tpl-head">
          <span class="mog-farm-tpl-letter">Modelo ${letter}</span>
        </div>
        <div class="mog-farm-units">${unitsHtml}</div>
      </div>
    `;
  }

  async function populateFarmerGroupSelect() {
    const sel = content.querySelector('#mog-farm-group');
    if (!sel) return;
    const groups = await getGroups();
    sel.innerHTML = groups.map(g =>
      `<option value="${g.id}" ${g.id === state.farmer.groupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');
  }

  async function loadFarmerTemplates(force) {
    if (farmerTemplatesCache && !force && !farmerTemplatesCache.error) {
      renderFarmerTemplatesBlock();
      return;
    }
    farmerTemplatesCache = null;
    renderFarmerTemplatesBlock();
    try {
      const data = await Game.fetchFarmTemplates();
      if (!data.templates.length) {
        farmerTemplatesCache = { error: 'Nenhum modelo encontrado. Verifique se o Assistente de Saque está ativo nesta conta.', loadedAt: Date.now() };
      } else {
        farmerTemplatesCache = { ...data, loadedAt: Date.now() };
      }
    } catch (e) {
      farmerTemplatesCache = { error: 'Erro ao buscar modelos: ' + e.message, loadedAt: Date.now() };
    }
    renderFarmerTemplatesBlock();
  }

  function bindFarmer() {
    const root = content;
    root.querySelector('#mog-farm-toggle').addEventListener('click', () => {
      state.farmer.enabled = !state.farmer.enabled;
      persist();
      if (state.farmer.enabled) scheduleFarmerNext();
      else cancelFarmerSchedule();
      renderFarmer();
      pushFarmerLog(state.farmer.enabled ? 'Farmador ativado.' : 'Farmador pausado.');
    });
    root.querySelector('#mog-farm-group').addEventListener('change', e => {
      state.farmer.groupId = parseInt(e.target.value, 10) || 0;
      persist();
    });
    root.querySelector('#mog-farm-cycle').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      state.farmer.cycleMin = isNaN(v) || v < 1 ? 1 : v;
      persist();
    });
    root.querySelector('#mog-farm-min').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      state.farmer.timing.minMs = isNaN(v) || v < 0 ? 0 : v;
      persist();
    });
    root.querySelector('#mog-farm-max').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      state.farmer.timing.maxMs = isNaN(v) || v < 0 ? 0 : v;
      persist();
    });
    root.querySelector('#mog-farm-maxbarb').addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      state.farmer.maxPerBarbarian = isNaN(v) || v < 1 ? 1 : v;
      persist();
    });
    const awInp = root.querySelector('#mog-farm-arrival-window');
    if (awInp) {
      awInp.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        state.farmer.arrivalWindowMin = isNaN(v) || v < 0 ? 0 : v;
        persist();
      });
    }
    const runBtn = root.querySelector('#mog-farm-run-now');
    if (runBtn) {
      runBtn.addEventListener('click', () => {
        if (state.farmer.busy) return;
        runFarmerCycle({ manual: true });
      });
    }
    const stopBtn = root.querySelector('#mog-farm-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        if (!state.farmer.busy) return;
        farmerAbortRequested = true;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Parando...';
        pushFarmerLog('Cancelamento solicitado pelo usuário.');
      });
    }
    const radiusInp = root.querySelector('#mog-farm-radius');
    if (radiusInp) {
      radiusInp.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        state.farmer.searchRadius = isNaN(v) || v < 1 ? 1 : Math.min(50, v);
        persist();
      });
    }
    const maxRadiusInp = root.querySelector('#mog-farm-max-radius');
    if (maxRadiusInp) {
      maxRadiusInp.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        state.farmer.maxFarmRadius = isNaN(v) || v < 0 ? 0 : Math.min(50, v);
        persist();
      });
    }
    const searchBtn = root.querySelector('#mog-farm-search');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        if (state.farmer.busy) return;
        findNewBarbarians();
      });
    }
  }

  function bindFarmerTemplates() {
    const reload = content.querySelector('#mog-farm-tpl-reload');
    if (reload) reload.addEventListener('click', () => loadFarmerTemplates(true));

    // mantém cache em sync com inputs (sem persist — modelos não vivem no state)
    content.querySelectorAll('.mog-farm-tpl').forEach(card => {
      const tplId = parseInt(card.dataset.tplId, 10);
      const tpl = farmerTemplatesCache?.templates.find(t => t.id === tplId);
      if (!tpl) return;
      card.querySelectorAll('input[data-farm-unit]').forEach(inp => {
        inp.addEventListener('input', e => {
          const uid = e.target.dataset.farmUnit;
          const v = parseInt(e.target.value, 10);
          tpl.units[uid] = isNaN(v) || v < 0 ? 0 : v;
        });
      });
      const cataSel = card.querySelector('select[data-farm-cata]');
      if (cataSel) {
        cataSel.addEventListener('change', e => { tpl.catapultTarget = e.target.value; });
      }
    });

    const saveBtn = content.querySelector('#mog-farm-save');
    if (saveBtn) saveBtn.addEventListener('click', saveFarmerTemplates);
  }

  async function saveFarmerTemplates() {
    if (!farmerTemplatesCache?.templates?.length) return;
    const btn = content.querySelector('#mog-farm-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
    try {
      await Game.updateFarmTemplates({
        templates: farmerTemplatesCache.templates,
        csrf: farmerTemplatesCache.csrf,
      });
      pushFarmerLog('Modelos salvos no Assistente de Saque.');
      // recarrega pra confirmar que o jogo aceitou (e pra atualizar csrf se mudou)
      await loadFarmerTemplates(true);
    } catch (e) {
      pushFarmerLog('Falha ao salvar modelos: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Salvar modelos no jogo'; }
    }
  }

  // ---------- engine do farmer ----------

  let farmerTimerId = null;

  function randomInRange(min, max) {
    if (max < min) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function refreshFarmerHeader() {
    if (state.ui.activeSection !== 'farmer') return;
    const next = content.querySelector('.mog-farm-next');
    if (!next) return;
    const f = state.farmer;
    const label = f.enabled && f.nextRunAt > Date.now()
      ? `em ${Math.max(1, Math.round((f.nextRunAt - Date.now()) / 60000))} min`
      : (f.busy ? 'executando...' : '—');
    next.innerHTML = `Próx. ciclo: <strong>${label}</strong>`;
    const runBtn = content.querySelector('#mog-farm-run-now');
    if (runBtn) {
      runBtn.disabled = !!f.busy;
      runBtn.textContent = f.busy ? 'Executando ciclo...' : 'Executar ciclo agora';
    }
    const searchBtn = content.querySelector('#mog-farm-search');
    if (searchBtn) searchBtn.disabled = !!f.busy;
  }

  function updateFarmerProgress(current, total) {
    if (state.ui.activeSection !== 'farmer') return;
    const wrap = content.querySelector('#mog-farm-progress');
    if (!wrap) return;
    if (total <= 0) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    const pct = Math.min(100, Math.round((current / total) * 100));
    const fill = content.querySelector('#mog-farm-progress-fill');
    const text = content.querySelector('#mog-farm-progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${current} / ${total}`;
  }

  setInterval(refreshFarmerHeader, 5000);

  function scheduleFarmerNext() {
    clearTimeout(farmerTimerId);
    if (!state.farmer.enabled || state.captchaTrippedAt > 0) {
      state.farmer.nextRunAt = 0;
      persist();
      refreshFarmerHeader();
      return;
    }
    const delay = Math.max(1, state.farmer.cycleMin) * 60 * 1000;
    state.farmer.nextRunAt = Date.now() + delay;
    persist();
    refreshFarmerHeader();
    farmerTimerId = setTimeout(() => {
      runFarmerCycle({ manual: false });
    }, delay);
  }

  function cancelFarmerSchedule() {
    clearTimeout(farmerTimerId);
    farmerTimerId = null;
    state.farmer.nextRunAt = 0;
    persist();
    refreshFarmerHeader();
  }

  // ---------- threats (defesas detectadas via espionagem) ----------

  const THREAT_TTL_MS = 24 * 60 * 60 * 1000;     // 24h: depois libera farm de novo
  const THREAT_REFRESH_MS = 30 * 60 * 1000;      // 30min: cache longo reduz refetch quando o usuário aciona refresh manual em sequência

  function getThreat(villageId) {
    return state.farmer.threats.find(t => t.villageId === villageId);
  }

  function isThreatActive(t) {
    if (!t) return false;
    if (Date.now() - (t.scoutedAt || 0) > THREAT_TTL_MS) return false;
    return (t.wall >= 1) || (t.totalUnits > 0) || (t.totalAway > 0);
  }

  function upsertThreat(entry) {
    const i = state.farmer.threats.findIndex(t => t.villageId === entry.villageId);
    if (i >= 0) state.farmer.threats[i] = entry;
    else state.farmer.threats.push(entry);
  }

  // Lê relatórios de espionagem das bárbaras conhecidas e atualiza state.farmer.threats.
  // Cache curto: pula bárbaras com entry < 5min.
  // params: { force } — ignora cache, refaz tudo
  async function refreshThreats(barbarianList, { force = false } = {}) {
    const now = Date.now();
    let updated = 0;
    let skipped = 0;
    for (const b of barbarianList) {
      if (!b.reportId) continue;
      const existing = getThreat(b.villageId);
      if (!force && existing && (now - existing.scoutedAt) < THREAT_REFRESH_MS) {
        skipped++;
        continue;
      }
      try {
        const html = await Game.fetchReport(b.reportId);
        const parsed = parseSpyReport(html);
        if (!parsed.isSpyReport) {
          // último relatório não foi de espionagem (foi ataque sem explorador)
          // mantém entrada antiga se houver, senão pula
          continue;
        }
        upsertThreat({
          villageId: b.villageId,
          x: b.x, y: b.y,
          coords: b.coords,
          wall: parsed.wall,
          units: parsed.units,
          away: parsed.away,
          totalUnits: parsed.totalUnits,
          totalAway: parsed.totalAway,
          buildings: parsed.buildings,
          scoutedAt: now,
          reportId: b.reportId,
        });
        updated++;
      } catch (e) {
        // erro lendo um relatório não bloqueia o resto
      }
      // delay aleatório entre fetches pra evitar burst regular (sinal claro de bot → captcha)
      await sleep(randomInRange(400, 900));
    }
    if (updated > 0 || skipped > 0) {
      persist();
      pushFarmerLog(`Relatórios: ${updated} atualizado(s), ${skipped} já em cache.`);
    }
    return { updated, skipped };
  }

  // Itera bárbaras conhecidas, decide modelo (A normal, B saque cheio, A=spy se perdas)
  // e dispara via Game.dispatchFarm com timing realista. Lock global busy evita
  // ciclos sobrepostos.
  // params: { manual } — se true, dispara manualmente (bypass do enabled check exceto busy)
  async function runFarmerCycle({ manual = false } = {}) {
    const f = state.farmer;
    if (f.busy) {
      pushFarmerLog('Ciclo ignorado: já há um em execução.');
      return;
    }
    if (state.captchaTrippedAt > 0) {
      if (manual) pushFarmerLog('Ciclo bloqueado: captcha ativo. Reative pelo banner.');
      return;
    }
    if (!manual && !f.enabled) return;

    f.busy = true;
    farmerAbortRequested = false;
    persist();
    refreshFarmerHeader();
    renderFarmer();
    pushFarmerLog(manual ? 'Ciclo manual iniciado.' : 'Ciclo iniciado.');

    let dispatched = 0;
    let skipped = 0;
    let failed = 0;

    try {
      // 1. carrega templates do jogo (csrf + IDs A/B)
      let tplData;
      try {
        tplData = await Game.fetchFarmTemplates();
        if (!tplData.templates.length) throw new Error('nenhum modelo configurado');
      } catch (e) {
        pushFarmerLog('Falha ao ler modelos: ' + e.message);
        return;
      }
      const tplA = tplData.templates[0];
      const tplB = tplData.templates[1] || tplA;
      const csrf = tplData.csrf;

      // 2. lê grupo de origens
      let origins;
      try {
        origins = await Game.fetchGroupVillages(f.groupId);
      } catch (e) {
        pushFarmerLog('Falha ao listar aldeias do grupo: ' + e.message);
        return;
      }
      if (!origins.length) {
        pushFarmerLog('Grupo sem aldeias.');
        return;
      }

      // 3. lê tabela de bárbaras conhecidas + ataques saindo + tropas das origens
      let list;
      let outgoingAttacks = new Map();
      let unitsByVillage = new Map();
      try {
        const [knownList, outgoing, units] = await Promise.all([
          Game.fetchFarmAssistantList(origins[0].id),
          Game.fetchOutgoingAttacks().catch(e => {
            pushFarmerLog('Aviso: falha ao ler comandos saindo: ' + e.message);
            return new Map();
          }),
          Game.fetchAllUnits(f.groupId).catch(e => {
            pushFarmerLog('Aviso: falha ao ler tropas das origens: ' + e.message);
            return new Map();
          }),
        ]);
        list = knownList;
        outgoingAttacks = outgoing;
        unitsByVillage = units;
      } catch (e) {
        pushFarmerLog('Falha ao ler bárbaras do assistente: ' + e.message);
        return;
      }

      // 3.1. inclui na list bárbaras que SUMIRAM do AS mas têm ataque indo. O TW
      // remove do #plunder_list enquanto há comando em curso/retornando, então
      // o loop nunca as enxergaria. Resolvemos buscando dados no mapa global.
      const knownCoords = new Set(list.map(t => t.coords));
      const ghostCoords = [...outgoingAttacks.keys()].filter(c => !knownCoords.has(c));
      if (ghostCoords.length > 0) {
        try {
          const world = await Game.fetchAllWorldVillages();
          // Map<"x|y", {id, x, y}>
          const worldByCoord = new Map(world.map(v => [`${v.x}|${v.y}`, v]));
          let added = 0;
          for (const coord of ghostCoords) {
            const v = worldByCoord.get(coord);
            if (!v || v.owner !== 0) continue;     // só bárbara
            // entrada minimalista — sem reportId/fullLoot/hadLosses (não temos AS)
            list.push({
              villageId: v.id,
              x: v.x, y: v.y,
              coords: coord,
              fullLoot: false,
              hadLosses: false,
              reportId: null,
              lastAttackText: '(sob ataque)',
            });
            added++;
          }
          if (added > 0) pushFarmerLog(`+${added} bárbara(s) sob ataque adicionadas (sumiram do AS).`);
        } catch (e) {
          pushFarmerLog('Aviso: falha ao buscar bárbaras-fantasma no mapa: ' + e.message);
        }
      }

      if (!list.length) {
        pushFarmerLog('Nenhuma bárbara registrada no assistente.');
        return;
      }

      // 3a. snapshot mutável de tropa por origem. A cada farm enviado, subtraímos
      // do snapshot pra evitar mandar request que vai falhar com "tropas insuficientes".
      // Chave = villageId (string, igual ao retornado por fetchAllUnits).
      const originUnits = new Map();
      for (const o of origins) {
        const u = unitsByVillage.get(String(o.id)) || {};
        originUnits.set(o.id, { ...u });    // copia pra mutar livre
      }

      // helper: origem tem tropa suficiente pra disparar esse template?
      const hasTroopsFor = (originId, tpl) => {
        const u = originUnits.get(originId);
        if (!u) return false;
        for (const [unitId, qty] of Object.entries(tpl.units || {})) {
          if (qty > 0 && (u[unitId] || 0) < qty) return false;
        }
        return true;
      };
      // helper: subtrai o template das tropas (só chamar após dispatch bem-sucedido)
      const subtractTroopsFor = (originId, tpl) => {
        const u = originUnits.get(originId);
        if (!u) return;
        for (const [unitId, qty] of Object.entries(tpl.units || {})) {
          if (qty > 0) u[unitId] = Math.max(0, (u[unitId] || 0) - qty);
        }
      };

      // 3a2. garante worldConfig fresco (velocidades de unidade) pra calcular ETA
      // dos farms que vamos enviar e comparar com chegadas existentes.
      try {
        await ensureWorldConfig();
      } catch (e) {
        pushFarmerLog('Aviso: falha ao ler config do mundo: ' + e.message);
      }
      // helper: ETA estimada (timestamp ms) de um farm origin→target com determinado template
      const etaFor = (origin, target, tpl) => {
        const speedMpf = slowestSpeed(tpl.units || {});
        if (!speedMpf) return null;     // sem unidade no template ou config faltando
        const travel = travelTimeMs({ x: origin.x, y: origin.y }, { x: target.x, y: target.y }, speedMpf);
        return Date.now() + travel;
      };
      // helper: viola janela temporal? compara ETA do novo farm com chegadas existentes
      const arrivalWindowMs = Math.max(0, (f.arrivalWindowMin || 0)) * 60 * 1000;
      const violatesArrivalWindow = (target, eta) => {
        if (!eta || arrivalWindowMs === 0) return false;
        const existing = arrivalsAt(target.coords);
        for (const t of existing) {
          if (Math.abs(t - eta) < arrivalWindowMs) return true;
        }
        return false;
      };

      // helpers consolidados sobre outgoingAttacks. Estrutura: Map<coord, {count, arrivals: ms[]}>
      const attacksGoingTo = (coords) => outgoingAttacks.get(coords)?.count || 0;
      const arrivalsAt = (coords) => outgoingAttacks.get(coords)?.arrivals || [];
      // quantos farms ainda cabem nessa bárbara antes de atingir maxPerBarbarian
      const slotsAvailable = (target, sentThisCycle = 0) => {
        const going = attacksGoingTo(target.coords);
        return Math.max(0, f.maxPerBarbarian - going - sentThisCycle);
      };

      // 4. pré-calcula upper bound realista. Bárbara é elegível se:
      //   - não tem perdas
      //   - tem ao menos 1 slot livre (going + sent < maxPerBarbarian)
      //   - sem defesa detectada via espionagem manual antiga
      // Pra `planned`, simula pareamento sem mutar tropa real (clone das tropas)
      // pra refletir o que realmente vai ser enviado, não um teto otimista.
      // Janela temporal não é simulada (precisaria ETA por par origem×alvo).
      const eligible = list.filter(t => {
        if (t.hadLosses) return false;
        if (slotsAvailable(t) <= 0) return false;
        const th = getThreat(t.villageId);
        if (isThreatActive(th)) return false;
        return true;
      });

      const simUnits = new Map();
      for (const o of origins) {
        simUnits.set(o.id, { ...(unitsByVillage.get(String(o.id)) || {}) });
      }
      const simHasTroops = (originId, tpl) => {
        const u = simUnits.get(originId);
        if (!u) return false;
        for (const [unitId, qty] of Object.entries(tpl.units || {})) {
          if (qty > 0 && (u[unitId] || 0) < qty) return false;
        }
        return true;
      };
      const simSubtract = (originId, tpl) => {
        const u = simUnits.get(originId);
        for (const [unitId, qty] of Object.entries(tpl.units || {})) {
          if (qty > 0) u[unitId] = Math.max(0, (u[unitId] || 0) - qty);
        }
      };
      // mesma regra de raio + janela temporal do loop real, pra `planned`
      // bater com `dispatched`. Simula chegadas acumulando ETAs por bárbara.
      const simMaxRadius = f.maxFarmRadius || 0;
      const simInRange = (origin, target) => {
        if (simMaxRadius === 0) return true;
        return distance({ x: origin.x, y: origin.y }, { x: target.x, y: target.y }) <= simMaxRadius;
      };
      const simArrivals = new Map();
      for (const [coord, entry] of outgoingAttacks) {
        simArrivals.set(coord, [...(entry.arrivals || [])]);
      }
      const simViolatesWindow = (coords, eta) => {
        if (!eta || arrivalWindowMs === 0) return false;
        const list = simArrivals.get(coords) || [];
        for (const x of list) {
          if (Math.abs(x - eta) < arrivalWindowMs) return true;
        }
        return false;
      };
      const findSimOrigin = (target, tpl) => {
        for (const o of origins) {
          if (!simInRange(o, target)) continue;
          if (!simHasTroops(o.id, tpl)) continue;
          const eta = etaFor(o, target, tpl);
          if (simViolatesWindow(target.coords, eta)) continue;
          return { origin: o, eta };
        }
        return null;
      };
      let planned = 0;
      for (const t of eligible) {
        let slots = slotsAvailable(t);
        while (slots > 0) {
          let tpl = t.fullLoot ? tplB : tplA;
          let pick = findSimOrigin(t, tpl);
          if (!pick && tpl === tplB) {
            tpl = tplA;
            pick = findSimOrigin(t, tpl);
          }
          if (!pick) break;
          simSubtract(pick.origin.id, tpl);
          if (pick.eta) {
            const arr = simArrivals.get(t.coords) || [];
            arr.push(pick.eta);
            simArrivals.set(t.coords, arr);
          }
          planned++;
          slots--;
        }
      }
      pushFarmerLog(`${origins.length} origem(ns), ${list.length} bárbara(s), ${planned} envio(s) planejado(s).`);
      updateFarmerProgress(0, planned);

      // 5. contadores locais de quantos farms já mandamos pra cada bárbara neste ciclo
      const sentCount = new Map();   // villageId → count
      const wallBreakSet = new Set(state.farmer.needsWallBreak.map(w => `${w.x}|${w.y}`));
      let processed = 0;

      // helper: escolhe a origem mais próxima viável (com tropa pro template,
      // dentro do raio máximo e sem violar a janela temporal). Retorna null se
      // nenhuma serve. maxFarmRadius=0 significa sem limite.
      const maxRadius = f.maxFarmRadius || 0;
      const pickBestOrigin = (target, tpl) => {
        const candidates = origins
          .filter(o => hasTroopsFor(o.id, tpl))
          .map(o => ({ o, dist: distance({ x: o.x, y: o.y }, { x: target.x, y: target.y }) }))
          .filter(c => maxRadius === 0 || c.dist <= maxRadius)
          .filter(c => !violatesArrivalWindow(target, etaFor(c.o, target, tpl)))
          .sort((a, b) => a.dist - b.dist);
        return candidates[0]?.o || null;
      };

      // 6. para cada bárbara, encontra a melhor origem viável e dispara.
      // Loop invertido (bárbaras × origens): se origem mais próxima esgotar tropa,
      // tenta a próxima — bárbaras só são abandonadas quando NENHUMA origem serve.
      for (const target of list) {
        if (farmerAbortRequested) break;
        if (!manual && !state.farmer.enabled) break;

        // bárbaras com perdas vão pra wall-break, não dispara
        if (target.hadLosses) {
          if (!wallBreakSet.has(target.coords)) {
            state.farmer.needsWallBreak.push({ x: target.x, y: target.y, lastAttempt: Date.now() });
            wallBreakSet.add(target.coords);
            persist();
            pushFarmerLog(`Aldeia ${target.coords} marcada pra quebra-muralha.`);
          }
          skipped++;
          continue;
        }

        // pula se threat ativo (defesa detectada via espionagem manual)
        const th = getThreat(target.villageId);
        if (isThreatActive(th)) continue;

        // tenta preencher cada slot disponível dessa bárbara
        let slots = slotsAvailable(target, sentCount.get(target.villageId) || 0);
        while (slots > 0) {
          if (farmerAbortRequested) break;
          if (!manual && !state.farmer.enabled) break;

          let tplToUse = target.fullLoot ? tplB : tplA;
          let label = target.fullLoot ? 'B' : 'A';

          let origin = pickBestOrigin(target, tplToUse);
          // downgrade pragmático: B sem origem viável → tenta A
          if (!origin && tplToUse === tplB) {
            tplToUse = tplA;
            label = 'A↓';
            origin = pickBestOrigin(target, tplToUse);
          }
          // nenhuma origem viável → abandona essa bárbara
          if (!origin) break;

          try {
            await Game.dispatchFarm({
              sourceVillageId: origin.id,
              targetVillageId: target.villageId,
              templateId: tplToUse.id,
              csrf,
            });
            subtractTroopsFor(origin.id, tplToUse);
            const sentThisCycle = (sentCount.get(target.villageId) || 0) + 1;
            sentCount.set(target.villageId, sentThisCycle);
            const eta = etaFor(origin, target, tplToUse);
            if (eta) {
              const entry = outgoingAttacks.get(target.coords) || { count: 0, arrivals: [] };
              entry.count += 1;
              entry.arrivals.push(eta);
              outgoingAttacks.set(target.coords, entry);
            }
            dispatched++;
            processed++;
            updateFarmerProgress(processed, planned);
            pushFarmerLog(`[${processed}/${planned}] farm ${label}: ${origin.name} → ${target.coords}`);
            slots = slotsAvailable(target, sentThisCycle);
          } catch (e) {
            failed++;
            const msg = e.message || String(e);
            if (/insuficiente|tropas|unit|not enough/i.test(msg)) {
              // origem mentiu sobre ter tropa (race com algo que mexeu na aldeia):
              // zera local e tenta outra origem pro mesmo slot
              originUnits.set(origin.id, {});
              pushFarmerLog(`sem tropas em ${origin.name}, tentando outra origem.`);
              continue;
            }
            pushFarmerLog(`falha: ${origin.name} → ${target.coords}: ${msg}`);
            break;
          }

          // jitter realista entre envios
          await sleep(randomInRange(f.timing.minMs, f.timing.maxMs));
        }
      }

      const prefix = farmerAbortRequested ? 'Ciclo cancelado.' : 'Ciclo finalizado.';
      pushFarmerLog(`${prefix} ${dispatched} farm(s), ${skipped} pulada(s), ${failed} falha(s).`);
      // mantém a barra cheia por uns segundos pra usuário ver, depois esconde
      setTimeout(() => updateFarmerProgress(0, 0), 5000);
    } finally {
      state.farmer.busy = false;
      farmerAbortRequested = false;
      persist();
      refreshFarmerHeader();
      if (state.ui.activeSection === 'farmer') renderFarmer();
      // re-render se a lista de wall-break mudou (pode ter ido de 0 → N entries)
      if (state.ui.activeSection === 'farmer') {
        const wb = state.farmer.needsWallBreak;
        const wbDom = content.querySelector('.mog-farm-wb');
        if (wb.length > 0 && !wbDom) {
          // foi de vazio pra não-vazio: rerender pra exibir o bloco
          renderFarmer();
        } else if (wbDom) {
          wbDom.innerHTML = wb.map(w =>
            `<div class="mog-farm-wb-row">${w.x}|${w.y}<span class="mog-farm-wb-meta">${new Date(w.lastAttempt).toLocaleString('pt-BR')}</span></div>`
          ).join('');
        }
      }
      if (!manual) scheduleFarmerNext();
    }
  }

  function distanceFields(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Busca bárbaras novas dentro do raio configurado partindo de cada origem do grupo,
  // filtra as que já estão no assistente, e dispara 1 espião pra cada uma —
  // assim elas viram entradas conhecidas no Assistente de Saque pra futuros ciclos.
  // Truque: troca temporariamente o modelo A pra "1 espião", dispara, restaura A original.
  // Espiona uma lista pré-determinada de bárbaras. Usa a mesma mecânica de
  // troca temporária de template A pra spy=1 que `findNewBarbarians`.
  // params: targets = [{ villageId, x, y, coords, name? }, ...]
  // Retorna { dispatched, failed }. Restaura modelo A no finally.
  // Caller é responsável por gerenciar `state.farmer.busy`.
  async function scoutBarbarians(targets, { logPrefix = 'espia', onProgress } = {}) {
    if (targets.length === 0) return { dispatched: 0, failed: 0 };
    const f = state.farmer;
    let originalA = null, templatesSnapshot = null, csrf = null;
    let dispatched = 0, failed = 0;

    try {
      const tplData = await Game.fetchFarmTemplates();
      if (!tplData.templates.length) throw new Error('sem modelos');
      templatesSnapshot = tplData.templates;
      csrf = tplData.csrf;
      originalA = { ...templatesSnapshot[0], units: { ...templatesSnapshot[0].units } };

      const origins = await Game.fetchGroupVillages(f.groupId);
      const units = await Game.fetchAllUnits(f.groupId);
      const originsWithSpy = origins.filter(o => (units.get(String(o.id))?.spy || 0) > 0);
      if (originsWithSpy.length === 0) throw new Error('nenhuma aldeia tem espião');
      const totalSpies = originsWithSpy.reduce((acc, o) => acc + (units.get(String(o.id))?.spy || 0), 0);

      const spyTpl = {
        id: originalA.id,
        units: Object.fromEntries(FARMER_UNIT_KEYS.map(k => [k, k === 'spy' ? 1 : 0])),
        catapultTarget: originalA.catapultTarget,
      };
      spyTpl.units.catapult = 0;
      await Game.updateFarmTemplates({ templates: [spyTpl, templatesSnapshot[1]].filter(Boolean), csrf });
      pushFarmerLog('Modelo A → 1 espião (temporário).');
      const refreshed = await Game.fetchFarmTemplates();
      csrf = refreshed.csrf;

      const limit = Math.min(targets.length, totalSpies);
      if (limit < targets.length) {
        pushFarmerLog(`Limitando a ${limit} ${logPrefix}(s) — só ${totalSpies} espião(ões) disponível(eis).`);
      }

      let cursor = 0;
      const exhausted = new Set();
      for (let i = 0; i < limit; i++) {
        if (farmerAbortRequested) break;
        const t = targets[i];
        if (exhausted.size >= originsWithSpy.length) break;
        let sent = false;
        for (let attempt = 0; attempt < originsWithSpy.length; attempt++) {
          if (farmerAbortRequested) break;
          const origin = originsWithSpy[(cursor + attempt) % originsWithSpy.length];
          if (exhausted.has(origin.id)) continue;
          try {
            await Game.dispatchFarm({
              sourceVillageId: origin.id,
              targetVillageId: t.villageId,
              templateId: originalA.id,
              csrf,
            });
            dispatched++;
            cursor = (cursor + attempt + 1) % originsWithSpy.length;
            sent = true;
            pushFarmerLog(`[${dispatched}/${limit}] ${logPrefix}: ${origin.name} → ${t.coords}`);
            if (typeof onProgress === 'function') onProgress(dispatched, limit);
            break;
          } catch (e) {
            const msg = e.message || String(e);
            if (/insuficiente|tropas|unit|not enough/i.test(msg)) {
              exhausted.add(origin.id);
              continue;
            }
            failed++;
            pushFarmerLog(`falha ${logPrefix} ${t.coords}: ${msg}`);
            break;
          }
        }
        if (!sent && exhausted.size < originsWithSpy.length) failed++;
        await sleep(randomInRange(f.timing.minMs, f.timing.maxMs));
      }
    } finally {
      if (originalA && csrf && templatesSnapshot) {
        try {
          await Game.updateFarmTemplates({
            templates: [originalA, templatesSnapshot[1]].filter(Boolean),
            csrf,
          });
          pushFarmerLog('Modelo A restaurado.');
        } catch (e) {
          pushFarmerLog('AVISO: falha ao restaurar modelo A: ' + e.message);
        }
      }
    }
    return { dispatched, failed };
  }

  async function findNewBarbarians() {
    const f = state.farmer;
    if (f.busy) {
      pushFarmerLog('Busca ignorada: ciclo em execução.');
      return;
    }
    f.busy = true;
    farmerAbortRequested = false;
    persist();
    refreshFarmerHeader();
    renderFarmer();
    pushFarmerLog(`Buscando bárbaras em raio ${f.searchRadius}...`);

    try {
      const origins = await Game.fetchGroupVillages(f.groupId);
      if (!origins.length) throw new Error('grupo sem aldeias');

      // lê bárbaras conhecidas + ataques saindo
      const [known, outgoing] = await Promise.all([
        Game.fetchFarmAssistantList(origins[0].id),
        Game.fetchOutgoingAttacks().catch(e => { pushFarmerLog('Aviso: falha ao ler comandos saindo: ' + e.message); return new Set(); }),
      ]);
      const knownIds = new Set(known.map(b => b.villageId));

      // mapa do mundo (cacheado)
      let world;
      try {
        world = await Game.fetchAllWorldVillages();
      } catch (e) {
        throw new Error('falha ao carregar mapa: ' + e.message);
      }

      // candidatas: bárbaras NOVAS no raio, não conhecidas no AS, sem ataque indo.
      // outgoing é Map<coord, {count, arrivals}> — usar .has() em vez de comparar
      // o objeto com 0 (bug antigo: o filtro nunca disparava).
      const candidates = new Map();
      let skippedOutgoing = 0;
      for (const v of world) {
        if (v.owner !== 0) continue;
        if (knownIds.has(v.id)) continue;
        const coords = `${v.x}|${v.y}`;
        for (const origin of origins) {
          if (distanceFields(origin.x, origin.y, v.x, v.y) <= f.searchRadius) {
            if (outgoing.has(coords)) {
              skippedOutgoing++;
              break;
            }
            candidates.set(v.id, { villageId: v.id, x: v.x, y: v.y, coords, name: v.name });
            break;
          }
        }
      }

      const candList = [...candidates.values()];
      const totalNoRaio = candList.length + skippedOutgoing;
      if (skippedOutgoing > 0) {
        pushFarmerLog(`${totalNoRaio} candidata(s) no raio: ${candList.length} pra espionar, ${skippedOutgoing} c/ ataque a caminho.`);
      } else {
        pushFarmerLog(`${candList.length} bárbara(s) pra espionar.`);
      }
      if (candList.length === 0) return;

      updateFarmerProgress(0, candList.length);
      const result = await scoutBarbarians(candList, {
        logPrefix: 'espia',
        onProgress: (current, total) => updateFarmerProgress(current, total),
      });
      updateFarmerProgress(result.dispatched, candList.length);
      pushFarmerLog(`Busca concluída: ${result.dispatched}/${candList.length} espia(s) enviada(s).`);
      setTimeout(() => updateFarmerProgress(0, 0), 5000);

      // depois de espionar, atualiza threats das que acabaram de ser espionadas
      // — mas só se conseguimos disparar. Pequeno delay pra relatório voltar
      // não vale a pena aqui; usuário vai ver na próxima atualização.
    } catch (e) {
      pushFarmerLog('Falha na busca: ' + e.message);
    } finally {
      state.farmer.busy = false;
      const wasAborted = farmerAbortRequested;
      farmerAbortRequested = false;
      persist();
      refreshFarmerHeader();
      if (state.ui.activeSection === 'farmer') renderFarmer();
      if (wasAborted) pushFarmerLog('Busca cancelada pelo usuário.');
    }
  }

  // Recovery no boot: se enabled estava true antes do reload, re-agenda.
  function recoverFarmerSchedule() {
    if (!state.farmer.enabled) return;
    if (state.captchaTrippedAt > 0) return;
    // se nextRunAt era no passado (ou perto), agenda novo ciclo daqui a 1min
    // pra não disparar imediatamente após reload da página
    const now = Date.now();
    if (state.farmer.nextRunAt > now + 5000) {
      const delay = state.farmer.nextRunAt - now;
      farmerTimerId = setTimeout(() => runFarmerCycle({ manual: false }), delay);
    } else {
      const delay = 60 * 1000;
      state.farmer.nextRunAt = now + delay;
      persist();
      farmerTimerId = setTimeout(() => runFarmerCycle({ manual: false }), delay);
    }
  }

  // ---- defenses section ----

  function renderDefenses() {
    const threats = (state.farmer.threats || []).slice().sort((a, b) => {
      // ordena por (tem_muralha desc, total tropa desc, coords)
      const aSev = (a.wall || 0) * 1000 + (a.totalUnits || 0) + (a.totalAway || 0);
      const bSev = (b.wall || 0) * 1000 + (b.totalUnits || 0) + (b.totalAway || 0);
      return bSev - aSev || a.coords.localeCompare(b.coords);
    });

    const active = threats.filter(t => isThreatActive(t));
    const expired = threats.filter(t => !isThreatActive(t));

    content.innerHTML = `
      <div class="mog-farm-head">
        <h2>Defesas detectadas</h2>
        <div class="mog-farm-toggle-wrap">
          <button class="mog-farm-btn-ghost" id="mog-def-refresh" ${state.farmer.busy ? 'disabled' : ''}>
            ↻ Atualizar relatórios
          </button>
        </div>
      </div>

      <div class="mog-farm-block">
        <div class="mog-def-legend">
          <span><span class="mog-def-icon">🧱</span> Muralha</span>
          <span><span class="mog-def-icon">⚔</span> Tropas presentes</span>
          <span><span class="mog-def-icon">🏃</span> Tropas fora</span>
          <span class="mog-def-legend-meta">Bárbaras com muralha ≥ 1 ou qualquer tropa são bloqueadas pro farm. TTL de 24h — depois libera (espera novo relatório).</span>
        </div>
      </div>

      ${active.length === 0 ? `
        <div class="mog-farm-empty">Nenhuma bárbara com defesa detectada. Tudo limpo.</div>
      ` : `
        <div class="mog-farm-block mog-def-block">
          <div class="mog-farm-block-title">Ativas (${active.length})</div>
          ${renderDefensesTable(active)}
        </div>
      `}

      ${expired.length === 0 ? '' : `
        <div class="mog-farm-block mog-def-block mog-def-block-expired">
          <div class="mog-farm-block-title">Vencidas (${expired.length}) — liberadas pro farm</div>
          ${renderDefensesTable(expired)}
        </div>
      `}
    `;

    bindDefenses();
  }

  function renderDefensesTable(rows) {
    return `
      <div class="mog-def-table">
        <div class="mog-def-row mog-def-head">
          <div>Coords</div>
          <div>Tipo</div>
          <div>Muralha</div>
          <div>Tropas presentes</div>
          <div>Tropas fora</div>
          <div>Espionada</div>
          <div></div>
        </div>
        ${rows.map(t => renderDefenseRow(t)).join('')}
      </div>
    `;
  }

  function renderDefenseRow(t) {
    const hasWall = (t.wall || 0) >= 1;
    const hasUnits = (t.totalUnits || 0) > 0;
    const hasAway = (t.totalAway || 0) > 0;
    const typeIcons = [];
    if (hasWall) typeIcons.push('<span title="Muralha">🧱</span>');
    if (hasUnits) typeIcons.push('<span title="Tropas presentes">⚔</span>');
    if (hasAway) typeIcons.push('<span title="Tropas fora">🏃</span>');
    if (typeIcons.length === 0) typeIcons.push('<span title="Sem defesa" style="opacity:0.4">—</span>');

    const unitsHtml = renderUnitsCompact(t.units);
    const awayHtml = renderUnitsCompact(t.away);

    const scoutedAgo = t.scoutedAt
      ? formatAgo(Date.now() - t.scoutedAt)
      : '—';

    return `
      <div class="mog-def-row" data-vid="${t.villageId}">
        <div class="mog-def-coords">
          <a href="/game.php?village=${unsafeWindow.game_data.village.id}&screen=info_village&id=${t.villageId}" target="_blank">${t.coords}</a>
        </div>
        <div class="mog-def-type">${typeIcons.join(' ')}</div>
        <div class="mog-def-wall">${t.wall || 0}</div>
        <div>${unitsHtml}</div>
        <div>${awayHtml}</div>
        <div class="mog-def-time">${scoutedAgo}</div>
        <div>
          <button class="mog-farm-btn-ghost mog-def-rescout" data-vid="${t.villageId}" ${state.farmer.busy ? 'disabled' : ''}>↻</button>
        </div>
      </div>
    `;
  }

  function renderUnitsCompact(unitsMap) {
    if (!unitsMap) return '<span class="mog-def-empty">—</span>';
    const entries = FARMER_UNIT_KEYS
      .map(k => ({ k, v: unitsMap[k] || 0 }))
      .filter(e => e.v > 0);
    if (entries.length === 0) return '<span class="mog-def-empty">—</span>';
    return `<div class="mog-def-units">${
      entries.map(e => {
        const name = (UNITS.find(u => u.id === e.k) || COMMAND_UNITS.find(u => u.id === e.k))?.name || e.k;
        return `<span class="mog-def-unit" title="${name}: ${e.v}"><img src="${unitImgSrc(e.k)}" onerror="this.style.display='none'">${e.v}</span>`;
      }).join('')
    }</div>`;
  }

  function formatAgo(ms) {
    if (ms < 60 * 1000) return 'agora';
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }

  function bindDefenses() {
    const refresh = content.querySelector('#mog-def-refresh');
    if (refresh) refresh.addEventListener('click', refreshDefensesNow);
    content.querySelectorAll('.mog-def-rescout').forEach(btn => {
      btn.addEventListener('click', () => {
        const vid = parseInt(btn.dataset.vid, 10);
        rescoutVillage(vid);
      });
    });
  }

  async function refreshDefensesNow() {
    if (state.farmer.busy) return;
    state.farmer.busy = true;
    persist();
    refreshFarmerHeader();
    pushFarmerLog('Atualizando relatórios manualmente...');
    try {
      const origins = await Game.fetchGroupVillages(state.farmer.groupId);
      if (!origins.length) throw new Error('grupo sem aldeias');
      const list = await Game.fetchFarmAssistantList(origins[0].id);
      await refreshThreats(list, { force: true });
      pushFarmerLog('Relatórios atualizados.');
    } catch (e) {
      pushFarmerLog('Falha ao atualizar: ' + e.message);
    } finally {
      state.farmer.busy = false;
      persist();
      refreshFarmerHeader();
      if (state.ui.activeSection === 'defenses') renderDefenses();
    }
  }

  async function rescoutVillage(villageId) {
    if (state.farmer.busy) return;
    const t = getThreat(villageId);
    if (!t) return;
    state.farmer.busy = true;
    persist();
    refreshFarmerHeader();
    pushFarmerLog(`Reespionando ${t.coords}...`);
    try {
      await scoutBarbarians([{ villageId, x: t.x, y: t.y, coords: t.coords }], { logPrefix: 'rescout' });
    } catch (e) {
      pushFarmerLog(`falha rescout: ${e.message}`);
    } finally {
      state.farmer.busy = false;
      persist();
      refreshFarmerHeader();
    }
  }

  // ---- recruiter section ----
  function renderRecruiter() {
    const profiles = state.recruiter.profiles;

    const headHtml = `
      <div class="mog-section-head">
        <div>
          <h2>Recrutamento</h2>
          <p>${profiles.length} modelo(s) configurado(s) · ${profiles.filter(p => p.enabled).length} ativo(s)</p>
        </div>
        <button class="mog-add-btn" id="mog-add-profile">+ Novo modelo</button>
      </div>
    `;

    if (!profiles.length) {
      content.innerHTML = headHtml + `
        <div class="mog-empty">
          Nenhum modelo criado. Clique em <strong style="color:${COLOR_ACCENT}">+ Novo modelo</strong> para começar.
        </div>
      `;
      content.querySelector('#mog-add-profile').addEventListener('click', addProfile);
      return;
    }

    const gridHead = `
      <div class="mog-grid-head">
        <div></div>
        <div class="mog-h-name">Modelo</div>
        <div>Grupo</div>
        ${UNITS.map(u => `
          <div class="mog-h-unit" title="${u.name}">
            <img src="${unitImgSrc(u.id)}" alt="${u.name}" onerror="this.style.display='none'">
          </div>
        `).join('')}
        <div>Intervalo (min)</div>
        <div>Status</div>
        <div></div>
      </div>
    `;

    const rowsHtml = profiles.map(p => renderProfileRow(p)).join('');

    content.innerHTML = headHtml + gridHead + rowsHtml;

    content.querySelector('#mog-add-profile').addEventListener('click', addProfile);
    profiles.forEach(p => bindProfileRow(p));
    profiles.forEach(p => populateGroupSelect(p));
  }

  function addProfile() {
    const p = makeProfile({ name: `Modelo #${state.recruiter.profiles.length + 1}` });
    state.recruiter.profiles.push(p);
    state.ui.expandedProfileId = p.id;
    persist();
    renderContent();
  }

  function unitImgSrc(unitId) {
    return `/graphic/unit/unit_${unitId}.png`;
  }

  function renderProfileRow(p) {
    const expanded = state.ui.expandedProfileId === p.id;
    return `
      <div class="mog-prow ${p.enabled ? 'mog-prow-on' : ''} ${expanded ? 'mog-prow-expanded' : ''}" data-pid="${p.id}">
        <div class="mog-prow-main">
          <div class="mog-tg" data-act="toggle" title="${p.enabled ? 'Desativar' : 'Ativar'}"></div>
          <input class="mog-pname" data-act="rename" value="${escapeHtml(p.name)}">
          <select class="mog-select" data-act="group"></select>
          ${UNITS.map(u => {
            const c = p.units[u.id];
            const off = !c.enabled;
            return `
              <input class="mog-input mog-target ${off ? 'mog-target-off' : ''}"
                     type="number" min="0" data-uid="${u.id}" data-act="target"
                     value="${c.target}" title="${u.name} — alvo">
            `;
          }).join('')}
          <div class="mog-interval">
            <input class="mog-input" type="number" min="1" data-act="intmin" value="${p.intervalMin}">
            <span>–</span>
            <input class="mog-input" type="number" min="1" data-act="intmax" value="${p.intervalMax}">
          </div>
          <div class="mog-status-cell ${p.enabled ? 'mog-status-active' : ''}" data-act="status-cell">
            ${profileStatusLabel(p)}
          </div>
          <div class="mog-prow-actions">
            <button class="mog-iconbtn" data-act="expand" title="${expanded ? 'Recolher' : 'Configurar'}">⚙</button>
            <button class="mog-iconbtn mog-iconbtn-danger" data-act="delete" title="Excluir">×</button>
          </div>
        </div>
        <div class="mog-prow-expand">
          ${renderAdvanced(p)}
        </div>
      </div>
    `;
  }

  function renderAdvanced(p) {
    const groups = BUILDINGS.map(b => {
      const units = UNITS.filter(u => u.building === b);
      const bcfg = p.buildings[b];
      const unitNames = units.map(u => u.name).join(', ');
      return `
        <div class="mog-bgroup">
          <div class="mog-bgroup-title">${b}</div>
          <div class="mog-bgroup-units">${unitNames}</div>
          <div class="mog-bgroup-fields">
            <div class="mog-bunit-cell">
              <label>Recrutamento</label>
              <input type="number" min="0" data-bld="${b}" data-field="perQueue" value="${bcfg.perQueue}" title="Quantidade por execução">
            </div>
            <div class="mog-bunit-cell">
              <label>Filas máx.</label>
              <input type="number" min="0" data-bld="${b}" data-field="maxQueues" value="${bcfg.maxQueues}" title="Limite de filas simultâneas no edifício">
            </div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="mog-bgroups">${groups}</div>
      <div class="mog-prow-tools">
        <button class="mog-btn mog-btn-ghost" data-act="run-now">Executar agora</button>
      </div>
    `;
  }

  function profileStatusLabel(p) {
    if (p.running) {
      return `Executando ${p.running.processed}/${p.running.total}`;
    }
    if (!p.enabled) return 'Pausado';
    if (state.captchaTrippedAt > 0) return 'Captcha';
    if (p.nextRunAt) {
      const t = new Date(p.nextRunAt);
      return 'Próx. ' + t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return 'Ativo';
  }

  function bindProfileRow(p) {
    const row = content.querySelector(`.mog-prow[data-pid="${p.id}"]`);
    if (!row) return;

    row.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      if (p.enabled) stopProfile(p);
      else startProfile(p);
      renderContent();
    });

    row.querySelector('[data-act="rename"]').addEventListener('change', e => {
      p.name = e.target.value.trim() || 'Sem nome';
      persist();
    });

    row.querySelector('[data-act="group"]').addEventListener('change', e => {
      p.groupId = parseInt(e.target.value, 10) || 0;
      persist();
    });

    row.querySelectorAll('[data-act="target"]').forEach(inp => {
      inp.addEventListener('change', e => {
        const uid = e.target.dataset.uid;
        const val = Math.max(0, parseInt(e.target.value, 10) || 0);
        const c = p.units[uid];
        c.target = val;
        c.enabled = val > 0;
        persist();
        e.target.classList.toggle('mog-target-off', !c.enabled);
      });
    });

    row.querySelector('[data-act="intmin"]').addEventListener('change', e => {
      p.intervalMin = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });
    row.querySelector('[data-act="intmax"]').addEventListener('change', e => {
      p.intervalMax = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });

    row.querySelector('[data-act="expand"]').addEventListener('click', () => {
      state.ui.expandedProfileId = state.ui.expandedProfileId === p.id ? null : p.id;
      persist();
      renderContent();
    });

    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (!confirm(`Excluir o modelo "${p.name}"?`)) return;
      if (p.enabled) stopProfile(p);
      state.recruiter.profiles = state.recruiter.profiles.filter(x => x.id !== p.id);
      if (state.ui.expandedProfileId === p.id) state.ui.expandedProfileId = null;
      persist();
      renderContent();
    });

    row.querySelectorAll('.mog-bgroup input').forEach(inp => {
      inp.addEventListener('change', e => {
        const bld = e.target.dataset.bld;
        const field = e.target.dataset.field;
        const bcfg = p.buildings[bld];
        bcfg[field] = Math.max(0, parseInt(e.target.value, 10) || 0);
        persist();
      });
    });

    const runBtn = row.querySelector('[data-act="run-now"]');
    if (runBtn) runBtn.addEventListener('click', () => runProfileCycle(p));
  }

  async function populateGroupSelect(p) {
    const sel = content.querySelector(`.mog-prow[data-pid="${p.id}"] [data-act="group"]`);
    if (!sel) return;
    sel.innerHTML = `<option>Carregando...</option>`;
    const groups = await getGroups();
    sel.innerHTML = groups.map(g =>
      `<option value="${g.id}" ${g.id === p.groupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');
  }

  // ============================================================
  // BUILDER (Construtor) — UI + stubs do motor
  // ============================================================

  function pushBuilderLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    state.builder.log = state.builder.log || [];
    state.builder.log.unshift(`[${ts}] ${msg}`);
    state.builder.log = state.builder.log.slice(0, 200);
    if (state.ui.activeSection === 'builder') renderLog();
  }

  // Stubs de scheduler — cada profile tem seu timer. Implementação cheia
  // (ciclo + Game.fetchMainBuilding) chega na Fase 4.
  const builderTimers = new Map();

  function nextBuilderDelayMs(profile) {
    const min = Math.max(1, profile.intervalMin || 5);
    const max = Math.max(min, profile.intervalMax || 7);
    return (min + Math.random() * (max - min)) * 60 * 1000;
  }

  function scheduleBuilderProfileNext(profile) {
    const old = builderTimers.get(profile.id);
    if (old) clearTimeout(old);
    if (!state.builder.enabled || !profile.enabled || state.captchaTrippedAt > 0) {
      profile.nextRunAt = 0;
      builderTimers.delete(profile.id);
      return;
    }
    const delay = nextBuilderDelayMs(profile);
    profile.nextRunAt = Date.now() + delay;
    persist();
    const tid = setTimeout(() => {
      runBuilderProfileCycle(profile).finally(() => {
        if (state.builder.enabled && profile.enabled) scheduleBuilderProfileNext(profile);
      });
    }, delay);
    builderTimers.set(profile.id, tid);
  }

  function startBuilderProfile(p) {
    p.enabled = true;
    persist();
    pushBuilderLog(`▶ "${p.name}" ativado`);
    if (state.builder.enabled) scheduleBuilderProfileNext(p);
  }

  function stopBuilderProfile(p) {
    p.enabled = false;
    p.nextRunAt = 0;
    const tid = builderTimers.get(p.id);
    if (tid) clearTimeout(tid);
    builderTimers.delete(p.id);
    persist();
    pushBuilderLog(`⏸ "${p.name}" pausado`);
  }

  function startBuilder() {
    state.builder.enabled = true;
    persist();
    pushBuilderLog('🟢 Construtor ligado');
    state.builder.profiles.forEach(p => {
      if (p.enabled) scheduleBuilderProfileNext(p);
    });
  }

  function stopBuilder() {
    state.builder.enabled = false;
    builderTimers.forEach(t => clearTimeout(t));
    builderTimers.clear();
    state.builder.profiles.forEach(p => { p.nextRunAt = 0; p.running = null; });
    persist();
    pushBuilderLog('🔴 Construtor desligado');
  }

  function recoverBuilderSchedule() {
    if (!state.builder.enabled) return;
    if (state.captchaTrippedAt > 0) return;
    state.builder.profiles.forEach(p => {
      if (p.enabled) scheduleBuilderProfileNext(p);
    });
  }

  // Calcula qual é o próximo edifício a construir para uma aldeia.
  // Algoritmo de alvo cumulativo: percorre template.steps na ordem e, para cada
  // posição i, conta quantas vezes o edifício steps[i] já apareceu até ali (= nível
  // alvo acumulado). Se level_atual[b] + queued[b] < alvo_cumulativo, retorna steps[i].
  // Tolerante a builds manuais que já ultrapassaram o alvo.
  // Retorna string (buildingKey) ou null se template completo.
  function computeNextBuildStep(template, levels, queue) {
    if (!template?.steps?.length) return null;

    // queuedDelta: quantas construções de cada key estão pendentes na fila atual
    const queuedDelta = {};
    for (const key of queue) queuedDelta[key] = (queuedDelta[key] || 0) + 1;

    // alvo cumulativo até a posição i (exclusive) para cada key
    const cumulTarget = {};

    for (const key of template.steps) {
      cumulTarget[key] = (cumulTarget[key] || 0) + 1;
      const current = levels.get(key) || 0;
      const queued  = queuedDelta[key] || 0;
      if (current + queued < cumulTarget[key]) return key;
    }
    return null; // template completo
  }

  // Ciclo real do Construtor. Percorre as aldeias do grupo e, para cada uma,
  // lê screen=main, decide o próximo passo e dispara o upgrade se possível.
  async function runBuilderProfileCycle(profile, opts = {}) {
    const manual = opts.manual === true;

    if (state.builder.busy && !manual) {
      pushBuilderLog(`⚠ "${profile.name}" — ciclo anterior ainda em execução, pulando.`);
      return;
    }
    if (state.captchaTrippedAt > 0) {
      if (manual) pushBuilderLog(`⚠ "${profile.name}" — captcha ativo. Reative pelo banner.`);
      return;
    }

    const template = state.builder.templates.find(t => t.id === profile.templateId);
    if (!template) {
      pushBuilderLog(`⚠ "${profile.name}" — nenhum modelo vinculado.`);
      return;
    }

    state.builder.busy = true;
    profile.running = Date.now();
    persist();

    let villages;
    try {
      villages = await Game.fetchGroupVillages(profile.groupId);
    } catch (e) {
      pushBuilderLog(`✗ "${profile.name}" — erro ao buscar aldeias: ${e.message}`);
      state.builder.busy = false;
      profile.running = null;
      persist();
      return;
    }

    if (!villages.length) {
      pushBuilderLog(`⚠ "${profile.name}" — grupo sem aldeias.`);
      state.builder.busy = false;
      profile.running = null;
      persist();
      return;
    }

    let built = 0;
    let skipped = 0;

    try {
      for (let vi = 0; vi < villages.length; vi++) {
        if (!state.builder.enabled && !manual) break;

        const v = villages[vi];
        if (vi > 0) await sleep(humanLikeDelay());

        let mainData;
        try {
          mainData = await Game.fetchMainBuilding(v.id);
        } catch (e) {
          pushBuilderLog(`✗ ${v.name} — erro ao ler edifícios: ${e.message}`);
          skipped++;
          continue;
        }

        const { levels, queue, costs, resources, storage, queueMax, isPremium, csrf } = mainData;

        // Atualiza detecção premium (primeira aldeia válida define o cache)
        if (state.builder.premiumDetected === null) {
          state.builder.premiumDetected = isPremium;
        }

        if (queue.length >= queueMax) {
          skipped++;
          continue;
        }

        const key = computeNextBuildStep(template, levels, queue);

        if (!key) {
          pushBuilderLog(`✓ ${v.name} — template completo.`);
          skipped++;
          continue;
        }

        const cost = costs.get(key);

        // Edifício não aparece na página (premium-only ou não disponível)
        if (!cost) {
          pushBuilderLog(`⚠ ${v.name} — "${key}" não disponível nesta aldeia (pulando step).`);
          skipped++;
          continue;
        }

        if (!cost.buildable) {
          pushBuilderLog(`⚠ ${v.name} — "${key}" não construível agora (nível máx ou bloqueado).`);
          skipped++;
          continue;
        }

        // Verifica recursos
        if (resources.wood < cost.wood || resources.stone < cost.stone || resources.iron < cost.iron) {
          const need = `M:${cost.wood} A:${cost.stone} F:${cost.iron}`;
          const have = `M:${resources.wood} A:${resources.stone} F:${resources.iron}`;
          pushBuilderLog(`⚠ ${v.name} — recursos insuficientes para ${key}. Precisa: ${need}. Tem: ${have}`);
          skipped++;
          continue;
        }

        // Verifica se o armazém cabe (storage < custo = construção impossível até aumentar armazém)
        if (storage < cost.wood || storage < cost.stone || storage < cost.iron) {
          pushBuilderLog(`⚠ ${v.name} — armazém muito pequeno para ${key} (cap:${storage}).`);
          skipped++;
          continue;
        }

        // Dispara o upgrade
        try {
          await Game.submitBuild(v.id, key, csrf);
          const disp = BUILDING_DISPLAY[key]?.label || key;
          pushBuilderLog(`🔨 ${v.name} — construindo ${disp} (nível ${(levels.get(key) || 0) + 1 + queue.filter(q => q === key).length})`);
          built++;
        } catch (e) {
          pushBuilderLog(`✗ ${v.name} — falha ao construir ${key}: ${e.message}`);
          skipped++;
        }
      }
    } finally {
      state.builder.busy = false;
      profile.running = null;
      persist();
    }

    if (built || skipped) {
      pushBuilderLog(`📊 "${profile.name}" — ${built} construção(ões) enfileirada(s), ${skipped} aldeia(s) pulada(s).`);
    }
  }

  // ---- render: lista de profiles ----
  function renderBuilder() {
    if (state.builder.ui.view === 'templates') return renderBuilderTemplates();

    const profiles = state.builder.profiles;
    const moduleOn = !!state.builder.enabled;
    const activeCount = profiles.filter(p => p.enabled).length;

    const headHtml = `
      <div class="mog-section-head">
        <div>
          <h2>🏗 Construtor</h2>
          <p>${profiles.length} modelo(s) · ${activeCount} ativo(s)</p>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="mog-btn mog-btn-ghost" id="mog-builder-templates">📚 Modelos</button>
          <button class="mog-add-btn" id="mog-builder-add">+ Novo modelo</button>
          <button class="mog-btn ${moduleOn ? 'mog-btn-on' : ''}" id="mog-builder-toggle"
                  title="${moduleOn ? 'Desligar Construtor' : 'Ligar Construtor'}">
            ${moduleOn ? '● ON' : '○ OFF'}
          </button>
        </div>
      </div>
    `;

    if (!profiles.length) {
      content.innerHTML = headHtml + `
        <div class="mog-empty">
          Nenhum modelo criado. Importe primeiro uma <strong style="color:${COLOR_ACCENT}">📚 Sequência de construção</strong>,
          depois clique em <strong style="color:${COLOR_ACCENT}">+ Novo modelo</strong>.
        </div>
      `;
      bindBuilderTopButtons();
      return;
    }

    if (!state.builder.templates.length) {
      content.innerHTML = headHtml + `
        <div class="mog-empty">
          Nenhuma sequência importada ainda. Acesse <strong style="color:${COLOR_ACCENT}">📚 Modelos</strong> para importar.
        </div>
      `;
      bindBuilderTopButtons();
      return;
    }

    const gridHead = `
      <div class="mog-grid-head mog-grid-builder">
        <div></div>
        <div class="mog-h-name">Modelo</div>
        <div>Grupo</div>
        <div>Sequência</div>
        <div>Intervalo (min)</div>
        <div>Status</div>
        <div></div>
      </div>
    `;

    const rowsHtml = profiles.map(p => renderBuilderProfileRow(p)).join('');
    content.innerHTML = headHtml + gridHead + rowsHtml;
    bindBuilderTopButtons();
    profiles.forEach(p => bindBuilderProfileRow(p));
    profiles.forEach(p => populateBuilderGroupSelect(p));
  }

  function bindBuilderTopButtons() {
    content.querySelector('#mog-builder-add')?.addEventListener('click', addBuilderProfile);
    content.querySelector('#mog-builder-templates')?.addEventListener('click', () => {
      state.builder.ui.view = 'templates';
      persist();
      renderContent();
    });
    content.querySelector('#mog-builder-toggle')?.addEventListener('click', () => {
      if (state.builder.enabled) stopBuilder();
      else startBuilder();
      renderContent();
    });
  }

  function addBuilderProfile() {
    const tplId = state.builder.templates[0]?.id || null;
    const p = makeBuildProfile({
      name: `Modelo #${state.builder.profiles.length + 1}`,
      templateId: tplId,
    });
    state.builder.profiles.push(p);
    state.builder.ui.expandedProfileId = p.id;
    persist();
    renderContent();
  }

  function builderProfileStatusLabel(p) {
    if (p.running) return `Executando ${p.running.processed}/${p.running.total}`;
    if (!p.enabled) return 'Pausado';
    if (!state.builder.enabled) return 'Aguardando';
    if (p.nextRunAt) {
      const t = new Date(p.nextRunAt);
      return 'Próx. ' + t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return 'Ativo';
  }

  function renderBuilderProfileRow(p) {
    const expanded = state.builder.ui.expandedProfileId === p.id;
    const tpl = state.builder.templates.find(t => t.id === p.templateId);
    const tplLabel = tpl ? `${escapeHtml(tpl.name)} (${tpl.steps.length})` : '— sem modelo —';
    return `
      <div class="mog-prow ${p.enabled ? 'mog-prow-on' : ''} ${expanded ? 'mog-prow-expanded' : ''}" data-pid="${p.id}">
        <div class="mog-prow-main mog-prow-builder">
          <div class="mog-tg" data-act="toggle" title="${p.enabled ? 'Desativar' : 'Ativar'}"></div>
          <input class="mog-pname" data-act="rename" value="${escapeHtml(p.name)}">
          <select class="mog-select" data-act="group"></select>
          <select class="mog-select" data-act="template" title="${escapeHtml(tplLabel)}">
            ${state.builder.templates.map(t =>
              `<option value="${t.id}" ${t.id === p.templateId ? 'selected' : ''}>${escapeHtml(t.name)} (${t.steps.length})</option>`
            ).join('')}
          </select>
          <div class="mog-interval">
            <input class="mog-input" type="number" min="1" data-act="intmin" value="${p.intervalMin}">
            <span>–</span>
            <input class="mog-input" type="number" min="1" data-act="intmax" value="${p.intervalMax}">
          </div>
          <div class="mog-status-cell ${p.enabled && state.builder.enabled ? 'mog-status-active' : ''}" data-act="status-cell">
            ${builderProfileStatusLabel(p)}
          </div>
          <div class="mog-prow-actions">
            <button class="mog-iconbtn" data-act="expand" title="${expanded ? 'Recolher' : 'Configurar'}">⚙</button>
            <button class="mog-iconbtn mog-iconbtn-danger" data-act="delete" title="Excluir">×</button>
          </div>
        </div>
        <div class="mog-prow-expand">
          ${renderBuilderAdvanced(p)}
        </div>
      </div>
    `;
  }

  function renderBuilderAdvanced(p) {
    const tpl = state.builder.templates.find(t => t.id === p.templateId);
    const preview = tpl
      ? renderTemplateSequencePreview(tpl, 20)
      : '<em style="opacity:.6">Selecione um modelo acima.</em>';
    return `
      <div class="mog-bgroups mog-builder-adv">
        <div class="mog-bgroup mog-bgroup-wide">
          <div class="mog-bgroup-title">Próximos passos do modelo${tpl ? ` — ${tpl.steps.length} níveis no total` : ''}</div>
          <div class="mog-template-preview">${preview}</div>
        </div>
      </div>
      <div class="mog-prow-tools">
        <button class="mog-btn mog-btn-ghost" data-act="run-now">Executar agora</button>
      </div>
    `;
  }

  // Renderiza a sequência de construção como tabela numerada.
  // limit: máx de linhas mostradas (null = todas). Agrupa runs consecutivos numa única linha.
  function renderTemplateSequencePreview(tpl, limit) {
    if (!tpl?.steps?.length) return '<em style="opacity:.6">Sem passos.</em>';
    const runs = encodeBuildSequenceCompact(tpl.steps);
    const shown = (limit != null) ? runs.slice(0, limit) : runs;

    // Calcula o número de passo inicial de cada run para a coluna "#"
    let stepCursor = 1;
    const rows = shown.map(r => {
      const meta = BUILDING_DISPLAY[r.building] || { label: r.building, icon: '❓' };
      const from = stepCursor;
      stepCursor += r.count;
      const range = r.count === 1 ? String(from) : `${from}–${stepCursor - 1}`;
      return `<tr>
        <td class="mog-seq-num">${range}</td>
        <td class="mog-seq-icon">${meta.icon}</td>
        <td class="mog-seq-label">${escapeHtml(meta.label)}</td>
        <td class="mog-seq-count">×${r.count}</td>
      </tr>`;
    });

    const more = (limit != null && runs.length > limit)
      ? `<tr><td colspan="4" class="mog-seq-more">… +${runs.length - limit} linha(s)</td></tr>`
      : '';

    return `<table class="mog-seq-table"><thead>
      <tr><th>#</th><th></th><th>Edifício</th><th>Qtd</th></tr>
    </thead><tbody>${rows.join('')}${more}</tbody></table>`;
  }

  function bindBuilderProfileRow(p) {
    const row = content.querySelector(`.mog-prow[data-pid="${p.id}"]`);
    if (!row) return;

    row.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      if (p.enabled) stopBuilderProfile(p);
      else startBuilderProfile(p);
      renderContent();
    });

    row.querySelector('[data-act="rename"]').addEventListener('change', e => {
      p.name = e.target.value.trim() || 'Sem nome';
      persist();
    });

    row.querySelector('[data-act="group"]').addEventListener('change', e => {
      p.groupId = parseInt(e.target.value, 10) || 0;
      persist();
    });

    row.querySelector('[data-act="template"]').addEventListener('change', e => {
      p.templateId = e.target.value || null;
      persist();
      renderContent();
    });

    row.querySelector('[data-act="intmin"]').addEventListener('change', e => {
      p.intervalMin = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });
    row.querySelector('[data-act="intmax"]').addEventListener('change', e => {
      p.intervalMax = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });

    row.querySelector('[data-act="expand"]').addEventListener('click', () => {
      state.builder.ui.expandedProfileId = state.builder.ui.expandedProfileId === p.id ? null : p.id;
      persist();
      renderContent();
    });

    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      if (!confirm(`Excluir o modelo "${p.name}"?`)) return;
      if (p.enabled) stopBuilderProfile(p);
      state.builder.profiles = state.builder.profiles.filter(x => x.id !== p.id);
      if (state.builder.ui.expandedProfileId === p.id) state.builder.ui.expandedProfileId = null;
      persist();
      renderContent();
    });

    const runBtn = row.querySelector('[data-act="run-now"]');
    if (runBtn) runBtn.addEventListener('click', () => runBuilderProfileCycle(p, { manual: true }));
  }

  async function populateBuilderGroupSelect(p) {
    const sel = content.querySelector(`.mog-prow[data-pid="${p.id}"] [data-act="group"]`);
    if (!sel) return;
    sel.innerHTML = `<option>Carregando...</option>`;
    const groups = await getGroups();
    sel.innerHTML = groups.map(g =>
      `<option value="${g.id}" ${g.id === p.groupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');
  }

  // ---- render: gerenciamento de templates ----
  function renderBuilderTemplates() {
    const templates = state.builder.templates;
    const headHtml = `
      <div class="mog-section-head">
        <div>
          <button class="mog-btn mog-btn-ghost" id="mog-builder-back">← Voltar</button>
          <h2 style="display:inline-block; margin-left:12px;">📚 Modelos de construção</h2>
          <p>${templates.length} modelo(s) salvos</p>
        </div>
      </div>
    `;

    const importBlock = `
      <div class="mog-import-block">
        <label class="mog-label">Importar nova sequência</label>
        <textarea id="mog-builder-import" rows="3"
                  placeholder="Cole aqui a sequência (ex: bgAAAQAB...)"></textarea>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <button class="mog-btn" id="mog-builder-import-btn">Importar</button>
          <span id="mog-builder-import-msg" class="mog-import-msg"></span>
        </div>
      </div>
    `;

    const listHtml = templates.length
      ? templates.map(t => renderBuilderTemplateRow(t)).join('')
      : `<div class="mog-empty">Nenhum modelo salvo. Cole uma sequência acima e clique em Importar.</div>`;

    content.innerHTML = headHtml + importBlock + `<div class="mog-templates-list">${listHtml}</div>`;
    bindBuilderTemplates();
  }

  function renderBuilderTemplateRow(tpl) {
    const expanded = state.builder.ui.expandedTemplateId === tpl.id;
    const created = new Date(tpl.createdAt).toLocaleDateString('pt-BR');
    const preview = renderTemplateSequencePreview(tpl, expanded ? null : 8);
    return `
      <div class="mog-tpl-row ${expanded ? 'mog-tpl-expanded' : ''}" data-tid="${tpl.id}">
        <div class="mog-tpl-head">
          <input class="mog-pname" data-act="tpl-rename" value="${escapeHtml(tpl.name)}">
          <span class="mog-tpl-meta">${tpl.steps.length} níveis · importado em ${created}</span>
          <div class="mog-prow-actions">
            <button class="mog-iconbtn" data-act="tpl-toggle" title="${expanded ? 'Recolher' : 'Ver sequência'}">${expanded ? '▴' : '▾'}</button>
            <button class="mog-iconbtn mog-iconbtn-danger" data-act="tpl-delete" title="Excluir">×</button>
          </div>
        </div>
        <div class="mog-tpl-preview">${preview}</div>
      </div>
    `;
  }

  function bindBuilderTemplates() {
    content.querySelector('#mog-builder-back')?.addEventListener('click', () => {
      state.builder.ui.view = 'profiles';
      persist();
      renderContent();
    });

    const importBtn = content.querySelector('#mog-builder-import-btn');
    const ta = content.querySelector('#mog-builder-import');
    const msg = content.querySelector('#mog-builder-import-msg');
    importBtn?.addEventListener('click', () => {
      const raw = ta.value.trim();
      if (!raw) { msg.textContent = 'Cole uma sequência primeiro.'; msg.className = 'mog-import-msg mog-import-err'; return; }
      const decoded = decodeBuildSequence(raw);
      if (!decoded || !decoded.steps.length) {
        msg.textContent = 'Formato inválido — verifique se copiou a string completa.';
        msg.className = 'mog-import-msg mog-import-err';
        return;
      }
      const name = ensureUniqueTemplateName(decoded.name || 'Sem nome');
      const tpl = makeBuildTemplate({ name, raw, steps: decoded.steps });
      state.builder.templates.push(tpl);
      state.builder.ui.expandedTemplateId = tpl.id;
      persist();
      pushBuilderLog(`📚 Modelo importado: "${tpl.name}" (${tpl.steps.length} níveis)`);
      renderContent();
    });

    content.querySelectorAll('.mog-tpl-row').forEach(row => {
      const tid = row.getAttribute('data-tid');
      const tpl = state.builder.templates.find(t => t.id === tid);
      if (!tpl) return;

      row.querySelector('[data-act="tpl-rename"]').addEventListener('change', e => {
        tpl.name = e.target.value.trim() || 'Sem nome';
        persist();
      });

      row.querySelector('[data-act="tpl-toggle"]').addEventListener('click', () => {
        state.builder.ui.expandedTemplateId = state.builder.ui.expandedTemplateId === tid ? null : tid;
        persist();
        renderContent();
      });

      row.querySelector('[data-act="tpl-delete"]').addEventListener('click', () => {
        const linkedProfiles = state.builder.profiles.filter(p => p.templateId === tid);
        const warn = linkedProfiles.length
          ? `\n\nAtenção: ${linkedProfiles.length} modelo(s) usam essa sequência e ficarão sem template.`
          : '';
        if (!confirm(`Excluir "${tpl.name}"?${warn}`)) return;
        state.builder.templates = state.builder.templates.filter(t => t.id !== tid);
        linkedProfiles.forEach(p => { p.templateId = null; });
        if (state.builder.ui.expandedTemplateId === tid) state.builder.ui.expandedTemplateId = null;
        persist();
        renderContent();
      });
    });
  }

  function ensureUniqueTemplateName(base) {
    const existing = new Set(state.builder.templates.map(t => t.name));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
  }

  // ---- log render ----
  function getActiveLog() {
    if (state.ui.activeSection === 'scheduler' || state.ui.activeSection === 'dashboard') return state.scheduler.log;
    if (state.ui.activeSection === 'farmer' || state.ui.activeSection === 'defenses') return state.farmer.log;
    if (state.ui.activeSection === 'builder') return state.builder.log;
    return state.recruiter.log;
  }

  function renderLog() {
    const body = panel.querySelector('#mog-log-body');
    const count = panel.querySelector('#mog-log-count');
    if (!body) return;
    const log = getActiveLog();
    body.innerHTML = log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
    if (count) count.textContent = String(log.length);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // refresh status cells (sem rerender total)
  setInterval(() => {
    if (state.ui.activeSection !== 'recruiter') return;
    state.recruiter.profiles.forEach(p => {
      const cell = content.querySelector(`.mog-prow[data-pid="${p.id}"] [data-act="status-cell"]`);
      if (cell) {
        cell.textContent = profileStatusLabel(p);
        cell.classList.toggle('mog-status-active', p.enabled);
      }
    });
  }, 1000);

  // initial
  renderContent();
  renderLog();
  if (state.captchaTrippedAt === 0) {
    state.recruiter.profiles.forEach(p => {
      if (p.enabled) scheduleProfileNext(p);
    });
  }
  // medição inicial de latência ANTES de recover (pra que executeAt seja convertido corretamente)
  (async () => {
    if (state.scheduler.latency.manualOverride === 0) await refreshLatency();
    recoverScheduledCommands();
  })();

  // farmer: re-agenda timer se enabled antes do reload
  recoverFarmerSchedule();

  // builder: re-agenda profiles habilitados se módulo estava ligado
  recoverBuilderSchedule();
})();
