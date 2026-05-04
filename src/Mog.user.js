// ==UserScript==
// @name         Millennium
// @version      0.9.1
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

  // Marcadores típicos do hCaptcha/botprotection no TW. Cobertura ampla pra
  // pegar variações com/sem underscore (`botprotect`, `bot_protect`, `bot_protection`).
  const CAPTCHA_DOM_SELECTORS = [
    '[id*="botprotect"]',
    '[id*="bot_protect"]',
    '[id*="bot_protection"]',
    '[id*="bot_check"]',
    '[id*="botcheck"]',
    '[class*="botprotect"]',
    '[class*="bot_protect"]',
    '[class*="bot_protection"]',
    '[class*="popup_box_bot_protection"]',
    '[id*="hcaptcha"]:not([style*="display: none"])',
    '[class*="hcaptcha"]:not([style*="display: none"])',
    '[class*="h-captcha"]:not([style*="display: none"])',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="recaptcha"]',
  ];
  // Estritas pra evitar false-positive em comentários inocentes do TW
  const CAPTCHA_HTML_PATTERNS = [
    /bot_protection_active/i,
    /screen=bot_protection/i,
    /popup_box_bot_protection/i,
    /class\s*=\s*["'][^"']*bot[_-]?protect/i,
    /id\s*=\s*["'][^"']*botcheck/i,
    /id\s*=\s*["'][^"']*bot[_-]?protect/i,
    /\bh-captcha\b/i,
    /hcaptcha\.com\/captcha/i,
  ];
  const CAPTCHA_URL_PATTERNS = [
    /screen=bot_protection/i,
    /screen=bot_protect/i,
    /botprotection/i,
    /bot_protection/i,
    /bot_protect/i,
  ];
  // Título da janela como camada extra: TW costuma mudar document.title
  // quando bot_protection é ativo. Cobre casos onde nem URL nem DOM pega cedo.
  const CAPTCHA_TITLE_PATTERNS = [
    /verifica[cç][aã]o de bot/i,
    /bot.?protect/i,
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

  function checkTitleForCaptcha() {
    const title = (document.title || '').trim();
    if (!title) return null;
    for (const re of CAPTCHA_TITLE_PATTERNS) {
      if (re.test(title)) return `TITLE: ${title}`;
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
        const hit = checkDomForCaptcha() || checkTitleForCaptcha();
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

    // 4. título agora
    const titleHit = checkTitleForCaptcha();
    if (titleHit) { tripCaptcha(titleHit); return; }

    // 5. wrappers
    installFetchWrapper();
    installXhrWrapper();

    // 6. URL + título polling (caso navegação interna do TW que não muda DOM)
    setInterval(() => {
      if (captchaHandled) return;
      const hit = checkUrlForCaptcha() || checkTitleForCaptcha();
      if (hit) tripCaptcha(hit);
    }, 3000);
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

  const VERSION = '0.9.1';
  const STORAGE_KEY = 'mog_state_v1';

  // logos embarcadas como data-URL (base64) — fonte: public/Millennium_sem_fundo.png e public/millenium_full_sem_fundo.png
  const LOGO_ICON_DATAURL = "data:image/png;base64,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U64+7oSTr+b6qmNPPJXLKSuOO/5U7n/SVUcff8qKY48/5arjTz7zqhNPPfOqC9/y1qtOO+usT1GD7z785F/ueK12lg9+8INVz/cfiMeSo5VaLQzTK8OCobgYJvrpEgbKBLcVTMO884oPX7jttVqXf/jqd/sv+8iHvn/Rpe/8i5NPO3vFcaecuuK4k05acejRR1913MmnXHXueRdcffIZZ1590umnfur4k0+9+gS254knnXrVSSeftuKk085ccTL7IretOOGU0696aTmV7XnaVSecesYKtvmKY07gfqectuKMs85dccaZ56046piTrjrsiGOvOvfcN1/1l3/991f/+trffOr59Wv/4r4nH/y7G+566Eu33PfYF5986KnP3fXI/Z/+8te+cfW73v/Bq99zxYeuftf7Pnj1JZe/96q3vfPdV7/jXe+/+p3vfvdVF196+VVvu/jSq844500rTj3jjE+eeuY5nzz59NM/eSrPkTPOPmfF2ecyz3POWXHuRRd98oK3vPmTF7z5rZ+8+O1v/+Sb33rJivMuvpjnHpeLLpbtK8477+IVb7rwIp6nF60474I3r7jworetOO/8i1ZccP6br7ro4ktWvO3tl1719kvecdVFb337Ve949/tWfORjH7/6M3/7Nz9gX8i+VttWl0sr8HpVQEPp67XldLlfswoopYLPf+1rgz/95S8fu+7GW+687sY7brvh5ttvv4bvf/6bG+762bW33Puza2944Ce/uP7BX1x/84Py/ufX3Xj/r7j9mhtvvee6W+6+85pbbrnz5tvvu+u6O+6+86Y777/j5rvuvV3W1995zx033nH/ndffducdstzIfW+67c67b7z1jnt+ff1t913DdH7x65sfvPaGWx648dY7H/rhT37xzIoVn9l68snnjXd2dhZZtv/RteN3/vLly+sXXnhhfsVnP9v/s2uuWX/bXQ8/fft9Dz1y230PPXjL3Q89cDPX8l6WW+5/6IE7H3j4/tvuevC+W+95+J6b73rwrtvuefiO62+959Yb73rw5hvveuDma26755bf3P7A7b++477bfnHL3Xf+7Ja77/3ZDXc/8NMb7nj4p7fc8/C/X3/7I7J89xfXP/Lja25+9l9+fM2gUpd5r9nGZcHed+VVT0/ns0/GYgn09fVzi4Ln+UjEU+F1s/K4rGg0uupd73nvb5YuvfA1dQkC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";
  const LOGO_WORDMARK_DATAURL = "data:image/png;base64,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s2c8PvPVaSNnzqF4Z00fOXPenMHpMIuusfNpU4bMnPn8iFkvPDdk1txJQ2bPnTR09uyJg2aPGTtozrgJg+dMmDyS+sfDc6aOHjJ32phRc8YQqznPTpw9on//x58Y9NAJ1P65RiAIfDt0BHiDO3SseUptIKA0NBifL/xEvPi8cy7s0qHdLff87dZbr+x23s0XnPX7m26+5oo/Xt+j+609up178429L7/x4vNP/0P3C8648apLz//Dqb876g9nnHTsH9jxiUd3uPH8M0+68YpLzv3DFZecd2Ovyy+44cru57Pnbrz0orNv7N3jkhsvOveUG+iZ6y446+RrL73gjGt6XHLutVdcfO61l154xjXdLzzz2p6XXnBtr8svupbiu+ZKunfZhWdec+mFZ/a+9KKzrrm829m9b+h1ae/eV1x09SXnntqr12UX0HZ6r6svv6gXxdWzxyXnXXXxub+n3ek9up9/6lV07aruF5zWg8JVl154as/LLjqd3jn/6quvuKjXFd3P7kVl6HnFxWf17H1lt149LzuvV7dzT+150TknX3XR2b+/6vyzTuhx7hm/63HeGSf0uPDs3/e4+PxTr7zk/DOupOevpDxdSc9dcd4ZJ15x7mnHXXnBmSddefH5p1152UVnUdqnUjitxyXnn0rpnnHVJeef1vPi807reeHZJ/c8/6yTrrrswtOvOvWEzj0vOvf3va6+8kIKF/Tqcek5va7reXHPSy84vef1Pbv3vKzbGb26nXfK1ez+Tddd3uuKbmf2uuKSs6/ufdVFV/e88vyre19+wdU3Xt299y3XXt77xl7de1/X85Jrrulx4TVXX3nBNdf17HbttVdddC2dX3tdj4uuu65Ht+uuu+qi667vdcl11199yfW9e1x8Q+8rL6a6uPAP1/a8+A/XXtXt5muuuuSWa3tcfPN1PbvffP3VF99ybc/ut1zT46Jbru916c03X3/lzTf0vuKPva684E9XX3HBrZdffPYfr7vq4tuu7XXxnwj+rb0uP+9P1/S4+E+9e1x469VXnn9rzyvOv6nnZefeRNdv6tH9nBuvuvzcG6645JwbrrzkrBuuuPjs6y/rfvr1V/e48LorLj79uisuO/P63j0vuqHHZRfccvufbvzz6y/PfvLRO6/4cxua7UF59A9Xnnr31Gnjplx/7RV/u+HaK27q3etiau7nX0tluq53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8WsvPOaJay446pk7rjjj2cu/f/Lzvzz7lBevvOD05372vbOfu+Ls416+8pwTXrn0nBNevviMo175/qmHv3rxmUe/esU5x7/2o7NPeO2Ks4//6xXnnPD69049+o2fnHncGz86/+g3fn7x8W9cfu7hr373/GP+cuNFxz577XlHPv3r7xzx+E9P2f+xGy46+rGrzj74sV+euf+fb7jw6KeuPu/wJ26//OSnbr34WCpHP3Hj+Uf/8c5LTnySytP3XnHqU3dcctwTdO3xCy8++onzLj3uSTp+6oLLTnj6gstPevriS0945rLvn/jMFZcc//QPLz7qLz+/8rTnLv7ecc/edPFRL33vkuNe+uHlJ710+UVHvTj9hye9+IvvH//Sry4+9pVfXHz0S5eedtxzPz3vlBd/eNaxr15x1vF//e53DnvlZ6cd/cJPLz/++Z+fddxLPzrliFd+9aNTXv7hlae9+N1Lj3vpyitPfeHG7x3z1PXfO+bpu356+l/u+NGpz936gxOfufWKk56948pTn7/jxzRnl5/07K/OPujJq84+9MEfn7LPXd89ctfpFx69+0UHTHIdPKkMpV8qmNt/w+c+yQiFm2zFhAqMO3Ba8PDTDpl42fdO3uuGK8854Pc/PmP/B395zsF/+PnZhzx85Sn7PXTNBUf/8drzjnjqjstOeubWS0585o7LTnn25u+d8Nx15x/5JM3bn3928v5//MXpBz927TlHPvmb849+gsng9ecf9+TVZxz2x1+eftAfrznr8D9NP+3Ax2+84Ninrjrt4Kdvuei458664NgXL6byA6rn/O8c+fQll5z8zLkkDxeeffhzZ599+LO3fPfE5y7+3gkv/OLSU5//wVmnPv+r753w/GVnHv/8ZWed8MoPzj7h1cvOOvHV7595/MsXn3LUC+cdf+iLv7jk5Nd+etpxr1556nEvX3LuYS9+79wjXjj3tANe+M45h7940gn7PH/yyd9+4ZxzDnvpO+ce8SrJ8yvXXXTsKyRbL19Fc3vDJce8evPlJ7x64QWHvXDhdw5+9tILDnn2kmMOfO67Rx34/A8vOerFX1558mtX/eTUV39y6bEv/+yy41/98fePfe3KU4997UcnH/v6BRce/epNl57w2g2XHP/6b79/6uu3XXnGX6//3kmv/OZ7J734m0tO+ssvzzn82esvOfHV6y857tWbLjvp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";

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

  const DEFAULT_LATENCY = {};   // shape vazio mantido pra compat com migrações antigas

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
    // Licença vem do servidor (twtime.vercel.app/api/license/check). Boot bloqueia
    // o painel se invalida ou se não conseguir validar. Não persiste nick em lowercase
    // — o que importa é o resultado da última checagem; nick original fica só pra log.
    license: {
      checkedAt: 0,
      expiresAt: 0,
      nick: '',
      lastError: '',
    },
  };

  // ---------- storage ----------
  // Garante que todos os motores começam pausados a cada boot. Recrutador
  // (global + per-profile), Farmador e Construtor (global + per-profile) ficam
  // em OFF; usuário precisa religar manualmente. Operações do Agendador NÃO
  // são mexidas — comandos agendados têm horário específico e desligar
  // poderia perder ataques cronometrados.
  function disableAllOnBoot(s) {
    s.enabled = false;
    if (s.farmer) s.farmer.enabled = false;
    if (s.builder) {
      s.builder.enabled = false;
      if (Array.isArray(s.builder.profiles)) {
        for (const p of s.builder.profiles) p.enabled = false;
      }
    }
    if (s.recruiter && Array.isArray(s.recruiter.profiles)) {
      for (const p of s.recruiter.profiles) p.enabled = false;
    }
  }

  function loadState() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      const fresh = raw ? migrateState(JSON.parse(raw)) : structuredClone(DEFAULT_STATE);
      disableAllOnBoot(fresh);
      return fresh;
    } catch {
      const fresh = structuredClone(DEFAULT_STATE);
      disableAllOnBoot(fresh);
      return fresh;
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
      // Scrub de campos de versões anteriores que não existem mais no DEFAULT_LATENCY
      for (const k of [
        'skewHistory', 'skewMedian', 'adaptiveComp', 'extraBuffer',
        'avgRtt', 'avgOneWay', 'avgOffset', 'confirmOneways', 'avgOneWayUp',
        'skew', 'skewMeasuredAt', 'biasCalibration', 'measuredAt', 'samples',
        'manualOverride', 'confirmRtts', 'avgConfirmRtt',
      ]) delete base.latency[k];
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

  function migrateLicense(parsed) {
    const base = structuredClone(DEFAULT_STATE.license);
    if (!parsed) return base;
    if (Number.isFinite(parsed.checkedAt)) base.checkedAt = parsed.checkedAt;
    if (Number.isFinite(parsed.expiresAt)) base.expiresAt = parsed.expiresAt;
    if (typeof parsed.nick === 'string') base.nick = parsed.nick;
    // lastError é diagnóstico transitório — descartado no boot
    base.lastError = '';
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
    base.license = migrateLicense(parsed.license);

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
      const t0 = Date.now();
      const r1 = await fetch(url1, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body1.toString(),
      });
      const html1 = await r1.text();
      const rtt = Date.now() - t0;

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

      return { hiddenFields, preparedAt: Date.now(), rtt };
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
      const dateHeader = r2.headers.get('Date');
      const html2 = await r2.text();

      const doc2 = new DOMParser().parseFromString(html2, 'text/html');
      const err2 = doc2.querySelector('.error_box, .error, .autohide-error');
      if (err2) {
        const msg = err2.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error('command rejeitado: ' + (msg || 'erro desconhecido'));
      }
      return { ok: true, dateHeader };
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

  // Confia no Timing.getCurrentServerTime() do TW — já calibrado por sessão via
  // WebSocket. O `diff` entre server time e local clock pode ser grande (segundos),
  // mas isso é ajuste real cliente↔servidor, não bias a corrigir.
  function serverToLocalTs(serverTs) {
    const T = unsafeWindow.Timing;
    if (T && typeof T.getCurrentServerTime === 'function') {
      const offset = T.getCurrentServerTime() - Date.now();
      return serverTs - offset;
    }
    return serverTs;
  }

  function serverNow() {
    const T = unsafeWindow.Timing;
    if (T && typeof T.getCurrentServerTime === 'function') {
      return T.getCurrentServerTime();
    }
    return Date.now();
  }

  // ---------- scheduler de comandos (Agendador) ----------
  const commandTimers = new Map();           // id → fire setTimeout
  const prepareTimers = new Map();           // id → prepare setTimeout
  const preparedBundles = new Map();         // bundleLeadId → { hiddenFields, preparedAt, rtt }
  let lastConfirmRtt = 0;                    // RTT do último POST de comando (transitório, só pro chip)
  const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;   // 7 dias
  const PREPARE_LEAD_MS = 10 * 1000;         // pré-confirma 10s antes do executeAt

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

    // Só agendamos o "lead" do batch (commandIndexInSource = 0). Os demais
    // ficam com status 'bundled' — vão junto no mesmo POST.
    if (cmd.commandIndexInSource > 0) {
      cmd.status = 'bundled';
      return;
    }

    // executeAt está em server time. O Timing nativo do TW já reporta server time
    // adiantado em ~uplink ms, então spinar até srvNow >= executeAt já entrega o
    // POST no servidor no horário certo. Não precisa de compensação adicional.
    const localExecuteAt = serverToLocalTs(cmd.executeAt);
    const fireDelay = localExecuteAt - Date.now();

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

      // Sincronização de relógio: 10 GETs no endpoint /api/time (Vercel) pra
      // estabelecer offset cliente↔UTC com precisão de ms. Vercel responde
      // {"timestamp": <utc_ms>}. Estima offset por amostra como
      //   offset_i = serverTime + rtt/2 - localAfter
      // Mediana podada (descarta min+max). Assume TW também em UTC NTP, então
      // executeAt (em "tempo TW") ≈ tempo UTC.
      const TIME_URL = 'https://twtime.vercel.app/api/time';
      const offsetSamples = [];
      const rttSamples = [];
      for (let i = 0; i < 10; i++) {
        try {
          const t0 = Date.now();
          const r = await fetch(TIME_URL, {
            method: 'GET', credentials: 'omit', cache: 'no-store',
          });
          const t1 = Date.now();
          const json = await r.json();
          if (json && typeof json.timestamp === 'number') {
            const rtt = t1 - t0;
            const offset = json.timestamp + Math.round(rtt / 2) - t1;
            offsetSamples.push(offset);
            rttSamples.push(rtt);
          }
        } catch (_) { /* skip falha individual */ }
        if (i < 9) await sleep(100);
      }
      let clockOffset = 0;
      let rttMedian = 0;
      if (offsetSamples.length >= 3) {
        const sortedOff = [...offsetSamples].sort((a, b) => a - b);
        const trimmedOff = sortedOff.slice(1, -1);
        clockOffset = trimmedOff[Math.floor(trimmedOff.length / 2)];
        const sortedRtt = [...rttSamples].sort((a, b) => a - b);
        const trimmedRtt = sortedRtt.slice(1, -1);
        rttMedian = trimmedRtt[Math.floor(trimmedRtt.length / 2)];
      }
      prepared.clockOffset = clockOffset;
      prepared.rttMedian = rttMedian;
      preparedBundles.set(cmd.id, prepared);
      pushSchedulerLog(`prepare ok: ${cmd.sourceCoords} → ${cmd.targetCoords} · rtts=[${rttSamples.join(',')}] rttMed=${rttMedian} clockOffset=${clockOffset}`);
      // status volta pra 'scheduled' — vai disparar normal no fire timer
      cmd.status = 'scheduled';
      persist();
    } catch (e) {
      // pré-confirm falhou → cancela o fire e marca tudo como falha
      clearTimeout(commandTimers.get(cmd.id));
      commandTimers.delete(cmd.id);
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
    // se ainda está em 'confirming' (passo 1 não terminou), espera curto
    // até passar a 'scheduled' (sucesso) ou outro estado terminal
    let waitedMs = 0;
    while (cmd.status === 'confirming' && waitedMs < 5000) {
      await sleep(50); waitedMs += 50;
    }
    if (cmd.status !== 'scheduled') {
      pushSchedulerLog(`executeCommand abortado: ${cmd.sourceCoords} → ${cmd.targetCoords} (status=${cmd.status}, esperou ${waitedMs}ms)`);
      return;
    }

    const prepared = preparedBundles.get(cmd.id);
    if (!prepared) {
      // não chegou a preparar (raro: timer 1 nem rodou). Faz fluxo all-in-one como fallback.
      return executeCommandFallback(cmd);
    }

    const bundle = getBundleSiblings(cmd);
    bundle.forEach(s => { s.status = 'sending'; });
    cmd.attempts++;
    persist();

    // Relógio "real" UTC = Date.now() + clockOffset (sincronizado com Vercel
    // /api/time no prepareForFire). Compensação one-way: usa prepRtt (RTT do
    // try=confirm, único caminho TW disponível pra medir). Servidor TW
    // registra chegada do POST quando o pacote chega — sem compensar, atrasa.
    const clockOffset = prepared.clockOffset || 0;
    const realNow = () => Date.now() + clockOffset;
    const prepRtt = prepared.rtt || 0;
    const compensation = prepRtt > 0 ? Math.round(prepRtt / 2) : 0;
    const fireAtReal = cmd.executeAt - compensation;

    // sleep até 200ms antes do alvo, depois busy-wait. setTimeout pode overshoot
    // ~50-150ms, mas a janela de 200ms de spin absorve sem afetar a precisão final.
    const longSleep = fireAtReal - realNow() - 200;
    if (longSleep > 0 && longSleep < 5000) await sleep(longSleep);
    // safety: limita spin a 1s
    const spinDeadline = Date.now() + 1000;
    while (realNow() < fireAtReal && Date.now() < spinDeadline) { /* spin */ }
    const finalDrift = fireAtReal - realNow(); // medido ANTES do POST (deve ser ~0 ou levemente negativo)

    const t0_post = Date.now();
    try {
      const res = await Game.confirmCommand({
        fromVillageId: cmd.sourceVillageId,
        hiddenFields: prepared.hiddenFields,
        waves: bundle.map(s => ({ units: s.units })),
        type: cmd.type,
        catapultTarget: cmd.catapultTarget,
      });
      const rtt_confirm = Date.now() - t0_post;
      lastConfirmRtt = rtt_confirm;
      bundle.forEach(s => { s.status = 'sent'; s.serverResponse = res; });

      // skewReal = relógio real UTC (Vercel-calibrado) - executeAt
      // skewTW = relógio do Timing nativo TW - executeAt (pra comparar)
      const skewReal = realNow() - cmd.executeAt;
      const skewTW = serverNow() - cmd.executeAt;
      const totalAttacks = bundle.length;
      const sign = (n) => (n >= 0 ? '+' : '');
      pushSchedulerLog(`enviado: ${cmd.sourceCoords} → ${cmd.targetCoords} (${cmd.type}, ${totalAttacks} ataque${totalAttacks > 1 ? 's' : ''}) · skewReal=${sign(skewReal)}${Math.round(skewReal)} skewTW=${sign(skewTW)}${Math.round(skewTW)} clockOffset=${clockOffset} prepRtt=${prepRtt} comp=${compensation} confirmRtt=${rtt_confirm} drift=${Math.round(finalDrift)}`);
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
  const COLOR_BG = '#1c1a17';
  const COLOR_ACCENT = '#c8a068';

  GM_addStyle(`
    /* design tokens — paleta + spacing */
    :root {
      --mog-bg: #1c1a17;
      --mog-bg-deep: #14110e;
      --mog-surface: #2b2620;
      --mog-surface-2: #221d18;
      --mog-surface-hover: #34302a;
      --mog-border: #4a3f33;
      --mog-border-soft: #2f2820;
      --mog-accent: #c8a068;
      --mog-accent-hover: #d9b67c;
      --mog-accent-soft: rgba(200, 160, 104, 0.14);
      --mog-accent-strong: rgba(200, 160, 104, 0.32);
      --mog-text: #EEEEEE;
      --mog-text-dim: #b0a89c;
      --mog-text-mute: #7a7269;
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
      width: 56px;
      height: 60px;
      background: ${COLOR_BG};
      border: 1px solid var(--mog-border);
      border-left: none;
      border-radius: 0 14px 14px 0;
      cursor: pointer;
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 4px 0 16px rgba(0,0,0,0.4);
      transition: width 0.15s ease, background 0.15s ease;
      user-select: none;
    }
    .mog-launcher img {
      width: 52px;
      height: 52px;
      object-fit: contain;
      filter: drop-shadow(0 0 4px rgba(0,0,0,0.5));
      transition: transform 0.15s ease;
      pointer-events: none;
    }
    .mog-launcher:hover { width: 66px; background: ${COLOR_ACCENT}; }
    .mog-launcher:hover img { transform: scale(1.1); }
    .mog-launcher .mog-launcher-dot {
      position: absolute;
      bottom: 9px; right: 9px;
      width: 9px; height: 9px; border-radius: 50%;
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
      grid-template-rows: 64px 1fr;
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
    .mog-logo-wordmark {
      height: 62px;
      width: auto;
      object-fit: contain;
      flex-shrink: 0;
      filter: drop-shadow(0 0 6px rgba(0,0,0,0.4));
      user-select: none;
    }
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
    .mog-chip-license { font-variant-numeric: tabular-nums; }
    .mog-chip-license.mog-chip-ok { color: var(--mog-success); border-color: var(--mog-success-soft); }
    .mog-chip-license.mog-chip-warn { color: var(--mog-warn); border-color: var(--mog-warn-soft); }
    .mog-chip-license.mog-chip-error { color: var(--mog-error); border-color: var(--mog-error-soft); }

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
    .mog-side-item.mog-side-root {
      padding: 11px 18px;
      margin: 6px 0 12px;
      border-top: 1px solid var(--mog-border);
      border-bottom: 1px solid var(--mog-border);
      font-weight: 600;
    }
    .mog-side-item.mog-side-root .mog-side-icon { font-size: 15px; }
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
    /* Input com máscara fixa (DD/MM/YYYY HH:MM:SS): mono + tabular pra alinhar dígitos */
    .mog-mask-input {
      font-family: 'JetBrains Mono', 'Consolas', monospace !important;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.5px;
      padding-right: 36px !important;   /* espaço pro botão de calendário */
    }
    /* Wrapper do input mascarado + botão de calendário */
    .mog-dt-wrap { position: relative; }
    .mog-dt-cal-btn {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      padding: 4px;
      display: flex; align-items: center; justify-content: center;
      color: var(--mog-text-mute);
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .mog-dt-cal-btn:hover {
      color: ${COLOR_ACCENT};
      background: var(--mog-surface-hover);
      border-color: var(--mog-border-soft);
    }
    .mog-dt-cal-btn:active { transform: translateY(-50%) scale(0.95); }

    /* Popup customizado (pt-BR + 24h) — substitui native picker do browser */
    .mog-dt-popup {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 1000;
      width: 280px;
      background: var(--mog-surface-2);
      border: 1px solid var(--mog-border);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .mog-dt-popup[hidden] { display: none; }
    .mog-dt-pop-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .mog-dt-pop-title {
      font-weight: 700; color: var(--mog-text); font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .mog-dt-pop-nav {
      background: transparent; border: 1px solid var(--mog-border-soft);
      border-radius: 4px; color: var(--mog-text); cursor: pointer;
      width: 26px; height: 26px; font-size: 16px; line-height: 1;
      padding: 0; display: flex; align-items: center; justify-content: center;
    }
    .mog-dt-pop-nav:hover { background: var(--mog-surface-hover); border-color: ${COLOR_ACCENT}; color: ${COLOR_ACCENT}; }
    .mog-dt-pop-grid {
      display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
      margin-bottom: 10px;
    }
    .mog-dt-pop-dh {
      font-size: 10px; font-weight: 600; color: var(--mog-text-mute);
      text-align: center; padding: 4px 0; text-transform: uppercase;
    }
    .mog-dt-pop-day {
      background: transparent; border: 1px solid transparent;
      color: var(--mog-text); font-size: 11.5px; font-weight: 500;
      padding: 6px 0; cursor: pointer; border-radius: 4px;
      font-family: inherit;
    }
    .mog-dt-pop-day:hover { background: var(--mog-surface-hover); border-color: var(--mog-border-soft); }
    .mog-dt-pop-day-off { color: var(--mog-text-mute); opacity: 0.5; }
    .mog-dt-pop-day-today { border-color: var(--mog-border); font-weight: 700; }
    .mog-dt-pop-day-sel {
      background: ${COLOR_ACCENT}; color: #fff; font-weight: 700;
      border-color: ${COLOR_ACCENT};
    }
    .mog-dt-pop-day-sel:hover { background: ${COLOR_ACCENT}; }
    .mog-dt-pop-time {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 8px 0; border-top: 1px solid var(--mog-border-soft);
    }
    .mog-dt-pop-time input {
      background: var(--mog-bg-deep); border: 1px solid var(--mog-border);
      border-radius: 4px; color: var(--mog-text);
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 14px; font-weight: 600; padding: 4px 6px;
      width: 44px; text-align: center; outline: none;
      -moz-appearance: textfield;
    }
    .mog-dt-pop-time input:focus { border-color: ${COLOR_ACCENT}; }
    .mog-dt-pop-time input::-webkit-inner-spin-button,
    .mog-dt-pop-time input::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .mog-dt-pop-time span { color: var(--mog-text-mute); font-weight: 700; }
    .mog-dt-pop-foot {
      display: flex; gap: 6px; padding-top: 8px;
      border-top: 1px solid var(--mog-border-soft);
    }
    .mog-dt-pop-btn {
      flex: 1; background: var(--mog-bg-deep); border: 1px solid var(--mog-border-soft);
      border-radius: 4px; color: var(--mog-text); cursor: pointer;
      padding: 6px 0; font-size: 11px; font-weight: 600;
      font-family: inherit; text-transform: uppercase; letter-spacing: 0.4px;
    }
    .mog-dt-pop-btn:hover { background: var(--mog-surface-hover); border-color: ${COLOR_ACCENT}; }
    .mog-dt-pop-btn-ok {
      background: ${COLOR_ACCENT}; color: #fff; border-color: ${COLOR_ACCENT};
    }
    .mog-dt-pop-btn-ok:hover { filter: brightness(1.1); background: ${COLOR_ACCENT}; }
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
      grid-template-columns: 80px 70px 80px 80px 1fr 80px 130px 80px 30px;
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

    /* botão lápis na coluna Chegada (editar) */
    .mog-dash-when-wrap {
      display: flex; align-items: center; justify-content: center; gap: 4px;
      min-width: 0;
    }
    .mog-dash-when-wrap .mog-dash-when {
      min-width: 0; overflow: hidden; text-overflow: ellipsis;
    }
    .mog-dash-edit-btn {
      background: transparent; border: none; cursor: pointer;
      color: var(--mog-text-mute); padding: 0; font-size: 12px; line-height: 1;
      transition: color 0.15s;
      flex-shrink: 0;
    }
    .mog-dash-edit-btn:hover { color: ${COLOR_ACCENT}; }

    /* linha inline de edição da chegada */
    .mog-dash-edit-row {
      grid-column: 1 / -1;
      padding: 10px 12px;
      background: var(--mog-surface-2);
      border-top: 1px solid var(--mog-border-soft);
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      font-size: 11px; color: var(--mog-text-dim);
    }
    .mog-dash-edit-row label {
      color: var(--mog-text-mute); font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.3px; font-weight: 700;
    }
    .mog-dash-edit-input {
      background: var(--mog-bg-deep);
      border: 1px solid var(--mog-border-soft);
      color: var(--mog-text);
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 12px;
      padding: 5px 8px;
      border-radius: 5px;
      width: 200px;
      letter-spacing: 0.5px;
      font-variant-numeric: tabular-nums;
    }
    .mog-dash-edit-input:focus {
      outline: none;
      border-color: ${COLOR_ACCENT};
    }
    .mog-dash-edit-preview {
      color: var(--mog-text-dim); font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px;
    }
    .mog-dash-edit-preview .mog-dash-edit-out {
      color: var(--mog-text); font-weight: 600;
    }
    .mog-dash-edit-error {
      color: var(--mog-error); font-size: 10.5px; font-weight: 600;
    }
    .mog-dash-edit-actions {
      display: flex; gap: 6px; margin-left: auto;
    }
    .mog-dash-edit-actions button {
      padding: 5px 12px; border-radius: 5px; cursor: pointer;
      font-size: 11px; font-weight: 600; border: 1px solid transparent;
    }
    .mog-dash-edit-save {
      background: ${COLOR_ACCENT}; color: var(--mog-bg);
    }
    .mog-dash-edit-save:disabled {
      background: var(--mog-border); color: var(--mog-text-mute); cursor: not-allowed;
    }
    .mog-dash-edit-cancel {
      background: transparent; color: var(--mog-text-dim); border-color: var(--mog-border);
    }
    .mog-dash-edit-cancel:hover { color: var(--mog-text); }

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
  launcher.innerHTML = `<img src="${LOGO_ICON_DATAURL}" alt="Millennium"><div class="mog-launcher-dot"></div>`;
  launcher.title = 'Millennium';

  const overlay = document.createElement('div');
  overlay.className = 'mog-overlay';

  const panel = document.createElement('div');
  panel.className = 'mog-panel';
  panel.innerHTML = `
    <div class="mog-head">
      <img class="mog-logo-wordmark" src="${LOGO_WORDMARK_DATAURL}" alt="Millennium">
      <div class="mog-head-spacer"></div>
      <div class="mog-head-chips">
        <span class="mog-chip mog-chip-captcha" id="mog-chip-captcha" title="Captcha detectado — clique para reativar" hidden>
          <span class="mog-chip-dot"></span>Captcha
        </span>
        <span class="mog-chip mog-chip-rtt" id="mog-chip-rtt" title="Latência média ao servidor" hidden>RTT —</span>
        <span class="mog-chip mog-chip-clock" id="mog-chip-clock" title="Hora do servidor" hidden>--:--:--</span>
        <span class="mog-chip mog-chip-license" id="mog-chip-license" title="Licença" hidden>Licença —</span>
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
          <div class="mog-side-item mog-side-disabled" data-section="research">
            <span class="mog-side-icon">🔬</span>
            <span>Pesquisa</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
        </div>
      </div>

      <div class="mog-side-section" data-side-section="loot">
        <div class="mog-side-title" data-side-toggle="loot">
          <span class="mog-side-caret">▼</span>
          <span>Coleta &amp; Saque</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="farmer">
            <span class="mog-side-icon"><img src="/graphic/unit/unit_light.png" alt="Farmador" onerror="this.style.display='none'"></span>
            <span>Farmador</span>
            <span class="mog-side-status" data-status-for="farmer"></span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="wallbreak">
            <span class="mog-side-icon">🧱</span>
            <span>Quebra de Muralhas</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="scavenger">
            <span class="mog-side-icon">🌿</span>
            <span>Coletor</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
        </div>
      </div>

      <div class="mog-side-section" data-side-section="commands">
        <div class="mog-side-title" data-side-toggle="commands">
          <span class="mog-side-caret">▼</span>
          <span>Comandos</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="dashboard">
            <span class="mog-side-icon">📊</span>
            <span>Painel</span>
            <span class="mog-side-status" data-status-for="dashboard"></span>
          </div>
          <div class="mog-side-item" data-section="scheduler">
            <span class="mog-side-icon">⏰</span>
            <span>Agendar Comandos</span>
            <span class="mog-side-status" data-status-for="scheduler"></span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="snipe">
            <span class="mog-side-icon">🎯</span>
            <span>Snipar</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="snipecancel">
            <span class="mog-side-icon">↩</span>
            <span>Snip Cancel</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="autododge">
            <span class="mog-side-icon">🛟</span>
            <span>Auto Desvio</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
        </div>
      </div>

      <div class="mog-side-item mog-side-root mog-side-disabled" data-section="defenses">
        <span class="mog-side-icon">🏰</span>
        <span>Painel de Defesa</span>
        <span class="mog-side-badge">Em breve</span>
      </div>

      <div class="mog-side-section" data-side-section="utilities">
        <div class="mog-side-title" data-side-toggle="utilities">
          <span class="mog-side-caret">▼</span>
          <span>Utilidades</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item mog-side-disabled" data-section="balancer">
            <span class="mog-side-icon">⚖</span>
            <span>Balanceador</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="paladin">
            <span class="mog-side-icon">👑</span>
            <span>Treinar Paladinos</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
        </div>
      </div>

      <div class="mog-side-item mog-side-root" data-section="settings">
        <span class="mog-side-icon">⚙</span>
        <span>Configurações</span>
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

  // ---- header chips (read-only: latência, hora servidor, captcha, licença) ----
  const chipCaptcha = panel.querySelector('#mog-chip-captcha');
  const chipRtt = panel.querySelector('#mog-chip-rtt');
  const chipClock = panel.querySelector('#mog-chip-clock');
  const chipLicense = panel.querySelector('#mog-chip-license');

  chipCaptcha.addEventListener('click', () => {
    resumeFromCaptcha();
    updateHeadChips();
  });

  function updateHeadChips() {
    // Captcha — só visível em trip; clique reativa
    const tripped = state.captchaTrippedAt > 0;
    chipCaptcha.hidden = !tripped;

    // RTT — último POST real de comando (transitório, sem persistência)
    const rtt = lastConfirmRtt;
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

    // Licença — dias restantes baseado no expiresAt (validado no boot)
    const lic = state.license;
    if (lic && lic.expiresAt > 0) {
      const remainingMs = lic.expiresAt - Date.now();
      const days = remainingMs / (24 * 3600 * 1000);
      chipLicense.hidden = false;
      chipLicense.classList.remove('mog-chip-ok', 'mog-chip-warn', 'mog-chip-error');
      if (days <= 0) {
        chipLicense.textContent = 'Licença expirada';
        chipLicense.classList.add('mog-chip-error');
      } else if (days < 1) {
        chipLicense.textContent = `Licença: ${Math.max(1, Math.round(days * 24))}h`;
        chipLicense.classList.add('mog-chip-error');
      } else {
        const d = Math.floor(days);
        chipLicense.textContent = `Licença: ${d}d`;
        if (d <= 2) chipLicense.classList.add('mog-chip-error');
        else if (d <= 7) chipLicense.classList.add('mog-chip-warn');
        else chipLicense.classList.add('mog-chip-ok');
      }
    } else {
      chipLicense.hidden = true;
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

  // ============================================================
  // LICENÇA — validação no boot via twtime.vercel.app
  // ============================================================
  // Identifica usuário pelo nick (game_data.player.name). Servidor normaliza
  // pra lowercase. Bloqueio total: se inválida ou sem rede, painel não abre
  // e recovery de timers (scheduler/farmer/builder) é pulado. Captcha guard
  // segue rodando (vive antes do early-return).
  const LICENSE_API_URL = 'https://twtime.vercel.app/api/license/check';
  const LICENSE_TIMEOUT_MS = 5000;

  async function checkLicense() {
    const player = unsafeWindow.game_data?.player || {};
    const nick = String(player.name || '').trim();
    const world = String(unsafeWindow.game_data?.world || '');

    if (!nick) {
      return { ok: false, reason: 'no_nick', message: 'Não foi possível ler o nick do jogador.' };
    }

    const url = `${LICENSE_API_URL}?nick=${encodeURIComponent(nick)}&world=${encodeURIComponent(world)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LICENSE_TIMEOUT_MS);
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) {
        return { ok: false, reason: 'http_error', message: `Servidor respondeu HTTP ${r.status}.`, nick };
      }
      const json = await r.json();
      if (json && json.valid === true && Number.isFinite(json.expiresAt) && json.expiresAt > Date.now()) {
        // sucesso — atualiza state.license
        state.license.checkedAt = Date.now();
        state.license.expiresAt = json.expiresAt;
        state.license.nick = nick;
        state.license.lastError = '';
        persist();
        return { ok: true, expiresAt: json.expiresAt, nick };
      }
      // valid=false ou payload inesperado
      const reason = json?.reason || 'invalid';
      const message = reason === 'expired'
        ? `Licença expirada em ${new Date(json.expiresAt || 0).toLocaleString('pt-BR')}.`
        : 'Nick não autorizado.';
      // limpa estado local pra não enganar usuário com chip "verde"
      state.license.expiresAt = 0;
      state.license.nick = nick;
      state.license.lastError = reason;
      persist();
      return { ok: false, reason, message, nick };
    } catch (e) {
      clearTimeout(timer);
      state.license.lastError = e.name === 'AbortError' ? 'timeout' : (e.message || 'network_error');
      persist();
      return { ok: false, reason: 'network', message: 'Sem conexão com o servidor de licença.', nick };
    }
  }

  function renderLicenseBlock(result) {
    const nick = result?.nick || unsafeWindow.game_data?.player?.name || '(desconhecido)';
    const world = unsafeWindow.game_data?.world || '';
    const isNetwork = result?.reason === 'network' || result?.reason === 'http_error' || result?.reason === 'no_nick';
    const title = isNetwork ? 'Sem conexão com o servidor de licença' : (result?.reason === 'expired' ? 'Licença expirada' : 'Acesso não autorizado');
    const detail = result?.message || '';
    content.innerHTML = `
      <div style="padding:32px; max-width:560px; margin:40px auto; text-align:center;">
        <div style="font-size:48px; line-height:1;">🔒</div>
        <h2 style="color:var(--mog-error); margin:14px 0 6px;">${escapeHtml(title)}</h2>
        <div style="color:var(--mog-text-mute); margin-bottom:22px;">${escapeHtml(detail)}</div>
        <div style="background:var(--mog-surface-2); border:1px solid var(--mog-border); border-radius:8px; padding:16px; margin-bottom:20px; text-align:left;">
          <div style="font-size:11px; color:var(--mog-text-mute); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Seu nick</div>
          <div style="font-size:18px; font-weight:700; color:var(--mog-text); user-select:all;">${escapeHtml(nick)}</div>
          ${world ? `<div style="font-size:11px; color:var(--mog-text-mute); margin-top:6px;">mundo: ${escapeHtml(world)}</div>` : ''}
        </div>
        <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
          <button class="mog-btn" id="mog-license-retry">Tentar novamente</button>
          <button class="mog-btn mog-btn-ghost" id="mog-license-export">Exportar configurações</button>
        </div>
        <div style="margin-top:18px; font-size:11px; color:var(--mog-text-mute);">
          Millennium v${VERSION}
        </div>
      </div>
    `;
    panel.querySelector('#mog-license-retry')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#mog-license-retry');
      btn.disabled = true;
      btn.textContent = 'Validando…';
      const r = await checkLicense();
      if (r.ok) {
        // re-boot fluxo normal sem reload — render normal e religa recoveries
        unlockSidebar();
        renderContent();
        runBootRecoveries();
        updateHeadChips();
      } else {
        renderLicenseBlock(r);
      }
    });
    panel.querySelector('#mog-license-export')?.addEventListener('click', exportConfig);
  }

  // Trava da sidebar enquanto a licença não está validada. O handler de click
  // dos itens já respeita .mog-side-disabled (linha ~4803), então só toggleamos
  // a classe — não precisa remover/re-adicionar listeners.
  function lockSidebar() {
    panel.querySelectorAll('.mog-side-item[data-section]').forEach(it => it.classList.add('mog-side-disabled'));
  }
  function unlockSidebar() {
    panel.querySelectorAll('.mog-side-item[data-section]').forEach(it => it.classList.remove('mog-side-disabled'));
  }

  // Recoveries dos motores (timers que sobrevivem reload). Só roda em fluxo
  // normal — bloqueio de licença pula isso pra nada disparar.
  function runBootRecoveries() {
    if (state.captchaTrippedAt === 0) {
      state.recruiter.profiles.forEach(p => {
        if (p.enabled) scheduleProfileNext(p);
      });
    }
    recoverScheduledCommands();
    recoverFarmerSchedule();
    recoverBuilderSchedule();
  }

  // ============================================================
  // Export/Import de configurações — rede de segurança contra reset do navegador.
  // ============================================================
  // GM_setValue já sobrevive a updates do .user.js (Tampermonkey usa @name como
  // chave). Mas se o usuário trocar de PC/navegador ou limpar storage, ele perde
  // tudo. Export gera um JSON com todo o state EXCETO license (pra ninguém
  // compartilhar configs e levar a licença de outro). Import valida shape e
  // reescreve o state via saveState + reload.
  function exportConfig() {
    const snapshot = { ...state, license: undefined };
    delete snapshot.license;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const player = unsafeWindow.game_data?.player?.name || 'mog';
    const safe = String(player).replace(/[^A-Za-z0-9_-]/g, '_');
    const dt = new Date();
    const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `mog-config-${safe}-${ymd}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(String(reader.result || ''));
        } catch {
          alert('Arquivo inválido — não é JSON válido.');
          return;
        }
        // valida shape mínimo: tem que ter pelo menos um dos módulos conhecidos
        const hasShape = parsed && typeof parsed === 'object' && (
          parsed.recruiter || parsed.scheduler || parsed.farmer || parsed.builder
        );
        if (!hasShape) {
          alert('Arquivo não parece ser um backup de configurações do Millennium.');
          return;
        }
        if (!confirm('Isso vai SUBSTITUIR todas as configurações atuais e recarregar a aba. Continuar?')) {
          return;
        }
        // preserva licença atual (não vem no backup intencionalmente)
        const merged = { ...parsed, license: state.license };
        const migrated = migrateState(merged);
        // license sobrevive porque migrateLicense respeita o que veio
        migrated.license = state.license;
        saveState(migrated);
        location.reload();
      };
      reader.readAsText(file);
    });
    input.click();
  }

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
    } else if (state.ui.activeSection === 'settings') {
      renderSettings();
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
    const labels = {
      research: 'Pesquisa',
      wallbreak: 'Quebra de Muralhas',
      scavenger: 'Coletor',
      snipe: 'Snipar',
      snipecancel: 'Snip Cancel',
      autododge: 'Auto Desvio',
      balancer: 'Balanceador',
      paladin: 'Treinar Paladinos',
    };
    content.innerHTML = `
      <div class="mog-placeholder">
        <div class="mog-placeholder-icon">🚧</div>
        <div class="mog-placeholder-title">${labels[section] || section}</div>
        <div class="mog-placeholder-text">Disponível em breve.</div>
      </div>
    `;
  }

  // ---- settings section ----
  function renderSettings() {
    const lic = state.license || {};
    const expISO = lic.expiresAt > 0 ? new Date(lic.expiresAt).toLocaleString('pt-BR') : '—';
    const checkedISO = lic.checkedAt > 0 ? new Date(lic.checkedAt).toLocaleString('pt-BR') : '—';
    const remaining = lic.expiresAt > 0 ? Math.max(0, lic.expiresAt - Date.now()) : 0;
    const days = Math.floor(remaining / (24 * 3600 * 1000));

    content.innerHTML = `
      <div style="padding: 18px 24px; max-width: 720px;">
        <h3 style="margin: 0 0 14px; color: var(--mog-text);">Configurações</h3>

        <div style="background:var(--mog-surface-2); border:1px solid var(--mog-border); border-radius:8px; padding:16px; margin-bottom:14px;">
          <div style="font-size:11px; color:var(--mog-text-mute); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Licença</div>
          <table style="width:100%; font-size:13px; color:var(--mog-text);">
            <tr><td style="padding:3px 0; color:var(--mog-text-mute); width:140px;">Nick</td><td>${escapeHtml(lic.nick || unsafeWindow.game_data?.player?.name || '—')}</td></tr>
            <tr><td style="padding:3px 0; color:var(--mog-text-mute);">Expira em</td><td>${escapeHtml(expISO)} ${days > 0 ? `<span style="color:var(--mog-text-mute);">(${days} dia${days === 1 ? '' : 's'})</span>` : ''}</td></tr>
            <tr><td style="padding:3px 0; color:var(--mog-text-mute);">Última checagem</td><td>${escapeHtml(checkedISO)}</td></tr>
          </table>
          <div style="margin-top:10px;">
            <button class="mog-btn mog-btn-ghost" id="mog-settings-recheck">Revalidar agora</button>
          </div>
        </div>

        <div style="background:var(--mog-surface-2); border:1px solid var(--mog-border); border-radius:8px; padding:16px; margin-bottom:14px;">
          <div style="font-size:11px; color:var(--mog-text-mute); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Backup de configurações</div>
          <div style="font-size:12px; color:var(--mog-text-mute); margin-bottom:12px;">
            Suas configurações já são preservadas entre atualizações da extensão pelo Tampermonkey. Use o backup manual caso troque de PC, navegador ou queira restaurar um snapshot.
            <br><strong style="color:var(--mog-text);">A licença não é incluída no backup</strong> — ela é validada pelo nick a cada login.
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="mog-btn" id="mog-settings-export">Exportar configurações</button>
            <button class="mog-btn mog-btn-ghost" id="mog-settings-import">Importar configurações</button>
          </div>
        </div>

        <div style="font-size:11px; color:var(--mog-text-mute); margin-top:16px;">
          Millennium v${VERSION}
        </div>
      </div>
    `;

    panel.querySelector('#mog-settings-export')?.addEventListener('click', exportConfig);
    panel.querySelector('#mog-settings-import')?.addEventListener('click', importConfig);
    panel.querySelector('#mog-settings-recheck')?.addEventListener('click', async () => {
      const btn = panel.querySelector('#mog-settings-recheck');
      btn.disabled = true;
      btn.textContent = 'Validando…';
      const r = await checkLicense();
      if (!r.ok) {
        // licença caiu durante uso — trava sidebar pra não burlar
        lockSidebar();
        renderLicenseBlock(r);
        updateHeadChips();
      } else {
        renderSettings();
        updateHeadChips();
      }
    });
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
    // Default = data/hora atual do servidor (sempre que ainda não foi definido).
    // Usuário pode ajustar livremente depois; o valor escolhido persiste.
    if (!op.defaultArrival.datetime) {
      const now = new Date(serverNow());
      // zera os ms (campo separado) — pega só até segundos
      now.setMilliseconds(0);
      op.defaultArrival.datetime = now.getTime();
      persist();
    }
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
            <div class="mog-dt-wrap">
              <input type="text" id="mog-wiz-default-dt" class="mog-mask-input"
                autocomplete="off"
                spellcheck="false"
                inputmode="numeric"
                value="${escapeHtml(arrivalStr)}">
              <button type="button" id="mog-wiz-default-dt-btn" class="mog-dt-cal-btn" title="Abrir calendário" tabindex="-1">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </button>
              <div id="mog-wiz-default-dt-popup" class="mog-dt-popup" hidden></div>
            </div>
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
    // Garante que sempre exibe a máscara completa "__/__/____ __:__:__".
    if (!dtInp.value) dtInp.value = DT_MASK_TEMPLATE;

    // Posiciona cursor no próximo slot vazio (ou após o último dígito se completo).
    const moveCursorToNextEmptySlot = () => {
      const digits = readDtMaskDigits(dtInp.value);
      const idx = digits.length;
      const pos = idx < DT_DIGIT_SLOTS.length ? DT_DIGIT_SLOTS[idx] : DT_DIGIT_SLOTS[DT_DIGIT_SLOTS.length - 1] + 1;
      dtInp.setSelectionRange(pos, pos);
    };

    // Aplica novos dígitos à máscara, atualiza state e reposiciona cursor.
    const applyDigits = digits => {
      const clean = digits.replace(/\D/g, '').slice(0, 14);
      dtInp.value = buildDtMask(clean);
      const idx = clean.length;
      const pos = idx < DT_DIGIT_SLOTS.length ? DT_DIGIT_SLOTS[idx] : DT_DIGIT_SLOTS[DT_DIGIT_SLOTS.length - 1] + 1;
      dtInp.setSelectionRange(pos, pos);
      // commita state se completo, senão zera
      if (clean.length === 14) {
        const parsed = parseDateFromInput(dtInp.value);
        if (parsed) {
          op.defaultArrival.datetime = parsed;
          dtInp.classList.remove('mog-input-error');
        } else {
          dtInp.classList.add('mog-input-error');
        }
      } else {
        op.defaultArrival.datetime = 0;
        dtInp.classList.remove('mog-input-error');
      }
      persist();
    };

    dtInp.addEventListener('beforeinput', e => {
      const t = e.inputType;
      const current = readDtMaskDigits(dtInp.value);
      if (t === 'insertText') {
        e.preventDefault();
        if (!/^\d+$/.test(e.data || '')) return;
        applyDigits(current + e.data);
      } else if (t === 'insertFromPaste') {
        e.preventDefault();
        const pasted = (e.data || '').replace(/\D/g, '');
        if (pasted) applyDigits(current + pasted);
      } else if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
        e.preventDefault();
        applyDigits(current.slice(0, -1));
      } else if (t === 'deleteWordBackward' || t === 'deleteWordForward') {
        e.preventDefault();
        applyDigits('');
      } else if (t && t.startsWith('insert')) {
        // bloqueia outros tipos de inserção (drag-drop, autocomplete, etc.)
        e.preventDefault();
      }
    });

    dtInp.addEventListener('focus', () => {
      if (!dtInp.value || dtInp.value.length < DT_MASK_TEMPLATE.length) {
        dtInp.value = buildDtMask(readDtMaskDigits(dtInp.value || ''));
      }
      setTimeout(moveCursorToNextEmptySlot, 0);
    });
    dtInp.addEventListener('click', () => moveCursorToNextEmptySlot());

    // Bloqueia interações que podem corromper a máscara.
    dtInp.addEventListener('keydown', e => {
      // permite navegação e atalhos de seleção/cópia
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const allowed = ['Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete'];
      if (allowed.includes(e.key)) return;
      // tudo que não é dígito é bloqueado
      if (e.key.length === 1 && !/^\d$/.test(e.key)) e.preventDefault();
    });

    // Seletor customizado em pt-BR (24h, sem AM/PM). Native picker do Chrome ignora
    // lang= e usa idioma do browser — por isso construímos próprio.
    const calBtn = body.querySelector('#mog-wiz-default-dt-btn');
    const popup = body.querySelector('#mog-wiz-default-dt-popup');
    const MES_NOMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const DIA_NOMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    // estado do popup: mês visível + data selecionada (Date object ou null)
    const pickerState = {
      view: null,        // Date apontando pro 1º dia do mês exibido
      sel: null,         // Date completa selecionada (com hora)
    };

    const renderPicker = () => {
      const view = pickerState.view;
      const sel = pickerState.sel;
      const today = new Date();
      const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

      // primeiro dia do mês + dia da semana inicial
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const startDow = first.getDay();   // 0=Dom
      const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const cells = [];
      // dias do mês anterior pra preencher antes do dia 1
      const prevMonthDays = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        cells.push({ d: prevMonthDays - i, off: true, date: new Date(view.getFullYear(), view.getMonth() - 1, prevMonthDays - i) });
      }
      for (let i = 1; i <= daysInMonth; i++) {
        cells.push({ d: i, off: false, date: new Date(view.getFullYear(), view.getMonth(), i) });
      }
      // completa pra 6 semanas (42 células)
      let nextDay = 1;
      while (cells.length < 42) {
        cells.push({ d: nextDay, off: true, date: new Date(view.getFullYear(), view.getMonth() + 1, nextDay) });
        nextDay++;
      }

      const hh = sel ? String(sel.getHours()).padStart(2, '0') : '00';
      const mm = sel ? String(sel.getMinutes()).padStart(2, '0') : '00';
      const ss = sel ? String(sel.getSeconds()).padStart(2, '0') : '00';

      popup.innerHTML = `
        <div class="mog-dt-pop-head">
          <button type="button" class="mog-dt-pop-nav" data-cal-act="prev" title="Mês anterior">‹</button>
          <span class="mog-dt-pop-title">${MES_NOMES[view.getMonth()]} ${view.getFullYear()}</span>
          <button type="button" class="mog-dt-pop-nav" data-cal-act="next" title="Próximo mês">›</button>
        </div>
        <div class="mog-dt-pop-grid">
          ${DIA_NOMES.map(n => `<div class="mog-dt-pop-dh">${n}</div>`).join('')}
          ${cells.map(c => {
            const isToday = sameDay(c.date, today);
            const isSel = sameDay(c.date, sel);
            const cls = ['mog-dt-pop-day'];
            if (c.off) cls.push('mog-dt-pop-day-off');
            if (isToday) cls.push('mog-dt-pop-day-today');
            if (isSel) cls.push('mog-dt-pop-day-sel');
            return `<button type="button" class="${cls.join(' ')}" data-cal-act="day" data-y="${c.date.getFullYear()}" data-m="${c.date.getMonth()}" data-d="${c.date.getDate()}">${c.d}</button>`;
          }).join('')}
        </div>
        <div class="mog-dt-pop-time">
          <input type="number" min="0" max="23" data-cal-act="hh" value="${hh}" title="Horas (0-23)">
          <span>:</span>
          <input type="number" min="0" max="59" data-cal-act="mm" value="${mm}" title="Minutos">
          <span>:</span>
          <input type="number" min="0" max="59" data-cal-act="ss" value="${ss}" title="Segundos">
        </div>
        <div class="mog-dt-pop-foot">
          <button type="button" class="mog-dt-pop-btn" data-cal-act="today">Hoje</button>
          <button type="button" class="mog-dt-pop-btn" data-cal-act="clear">Limpar</button>
          <button type="button" class="mog-dt-pop-btn mog-dt-pop-btn-ok" data-cal-act="ok">OK</button>
        </div>
      `;

      // bind handlers
      popup.querySelectorAll('[data-cal-act]').forEach(el => {
        const act = el.dataset.calAct;
        if (act === 'prev' || act === 'next') {
          el.addEventListener('click', () => {
            pickerState.view = new Date(view.getFullYear(), view.getMonth() + (act === 'next' ? 1 : -1), 1);
            renderPicker();
          });
        } else if (act === 'day') {
          el.addEventListener('click', () => {
            const y = parseInt(el.dataset.y, 10);
            const m = parseInt(el.dataset.m, 10);
            const d = parseInt(el.dataset.d, 10);
            const cur = pickerState.sel;
            const h = cur ? cur.getHours() : 0;
            const min = cur ? cur.getMinutes() : 0;
            const sec = cur ? cur.getSeconds() : 0;
            pickerState.sel = new Date(y, m, d, h, min, sec, 0);
            pickerState.view = new Date(y, m, 1);
            renderPicker();
          });
        } else if (act === 'hh' || act === 'mm' || act === 'ss') {
          el.addEventListener('change', () => {
            const cur = pickerState.sel || new Date(view.getFullYear(), view.getMonth(), 1, 0, 0, 0);
            const v = parseInt(el.value, 10);
            if (isNaN(v)) return;
            if (act === 'hh') cur.setHours(Math.max(0, Math.min(23, v)));
            else if (act === 'mm') cur.setMinutes(Math.max(0, Math.min(59, v)));
            else cur.setSeconds(Math.max(0, Math.min(59, v)));
            pickerState.sel = cur;
            renderPicker();
          });
        } else if (act === 'today') {
          el.addEventListener('click', () => {
            const now = new Date();
            pickerState.sel = now;
            pickerState.view = new Date(now.getFullYear(), now.getMonth(), 1);
            renderPicker();
          });
        } else if (act === 'clear') {
          el.addEventListener('click', () => {
            pickerState.sel = null;
            renderPicker();
          });
        } else if (act === 'ok') {
          el.addEventListener('click', () => {
            if (pickerState.sel) {
              const ms = pickerState.sel.getTime();
              op.defaultArrival.datetime = ms;
              dtInp.value = fmtDateForInput(ms);
              dtInp.classList.remove('mog-input-error');
            } else {
              op.defaultArrival.datetime = 0;
              dtInp.value = DT_MASK_TEMPLATE;
            }
            persist();
            popup.hidden = true;
          });
        }
      });
    };

    const closePicker = () => { popup.hidden = true; };
    const openPicker = () => {
      const cur = op.defaultArrival.datetime ? new Date(op.defaultArrival.datetime) : new Date();
      pickerState.sel = op.defaultArrival.datetime ? new Date(op.defaultArrival.datetime) : null;
      pickerState.view = new Date(cur.getFullYear(), cur.getMonth(), 1);
      popup.hidden = false;
      renderPicker();
    };

    calBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (popup.hidden) openPicker(); else closePicker();
    });

    // fecha clicando fora
    document.addEventListener('click', e => {
      if (popup.hidden) return;
      if (!popup.contains(e.target) && e.target !== calBtn && !calBtn.contains(e.target)) {
        closePicker();
      }
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

  // ----- Máscara de input de data/hora -----
  // Template fixo: "DD/MM/AAAA HH:MM:SS" (19 chars). Posições dos dígitos abaixo;
  // separadores ficam visíveis e não são editáveis.
  const DT_MASK_TEMPLATE = '__/__/____ __:__:__';
  const DT_DIGIT_SLOTS = [0, 1, 3, 4, 6, 7, 8, 9, 11, 12, 14, 15, 17, 18];

  // Constrói o texto da máscara dada uma string de até 14 dígitos.
  function buildDtMask(digits) {
    const arr = DT_MASK_TEMPLATE.split('');
    const d = String(digits).replace(/\D/g, '').slice(0, 14);
    for (let i = 0; i < d.length; i++) arr[DT_DIGIT_SLOTS[i]] = d[i];
    return arr.join('');
  }

  // Lê só os dígitos preenchidos na máscara (para na primeira posição vazia).
  function readDtMaskDigits(value) {
    let out = '';
    for (const pos of DT_DIGIT_SLOTS) {
      if (pos >= value.length) break;
      const c = value[pos];
      if (c >= '0' && c <= '9') out += c;
      else break;
    }
    return out;
  }

  // "DD/MM/AAAA HH:MM:SS" — texto pra carregar no input com máscara.
  function fmtDateForInput(ms) {
    if (!ms) return DT_MASK_TEMPLATE;
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    const digits = pad(d.getDate()) + pad(d.getMonth() + 1) + d.getFullYear()
                 + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return buildDtMask(digits);
  }

  // Parseia o texto da máscara → Unix ms. Precisa dos 14 dígitos completos.
  function parseDateFromInput(str) {
    if (!str) return 0;
    const digits = String(str).replace(/\D/g, '');
    if (digits.length !== 14) return 0;
    const dd = parseInt(digits.slice(0, 2), 10);
    const mm = parseInt(digits.slice(2, 4), 10);
    const yyyy = parseInt(digits.slice(4, 8), 10);
    const hh = parseInt(digits.slice(8, 10), 10);
    const MM = parseInt(digits.slice(10, 12), 10);
    const ss = parseInt(digits.slice(12, 14), 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || MM > 59 || ss > 59) return 0;
    const d = new Date(yyyy, mm - 1, dd, hh, MM, ss, 0);
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

  // Reagenda o bundle pra nova chegada (server time). Saída de cada wave
  // vira newArrivalAt - travelMs + ms_offset. Mantém spread de 100ms entre waves.
  // Pré-condições já checadas pelo chamador via isCommandReschedulable.
  function rescheduleCommand(cmd, newArrivalAtServerTs) {
    const bundle = getBundleSiblings(cmd);
    const lead = bundle[0];
    // recalcula executeAt de cada wave preservando o offset original `ms`
    bundle.forEach(s => {
      s.arrivalAt = newArrivalAtServerTs;
      s.executeAt = newArrivalAtServerTs - (s.travelMs || 0) + (s.ms || 0);
      // limpa estado transitório
      clearTimeout(commandTimers.get(s.id));
      clearTimeout(prepareTimers.get(s.id));
      commandTimers.delete(s.id);
      prepareTimers.delete(s.id);
      preparedBundles.delete(s.id);
      if (['scheduled', 'confirming', 'failed_overdue'].includes(s.status)) {
        s.status = 'pending';
        s.lastError = '';
      }
    });
    persist();
    scheduleCommand(lead);
    pushSchedulerLog(`reagendado: ${lead.sourceCoords} → ${lead.targetCoords} · nova chegada ${fmtFullDate(newArrivalAtServerTs)}`);
  }

  // Cancela um único comando (e seu bundle, já que vão juntos no mesmo POST).
  function cancelCommand(cmd) {
    const bundle = getBundleSiblings(cmd);
    bundle.forEach(s => {
      if (['pending', 'scheduled', 'confirming', 'bundled'].includes(s.status)) {
        clearTimeout(commandTimers.get(s.id));
        clearTimeout(prepareTimers.get(s.id));
        commandTimers.delete(s.id);
        prepareTimers.delete(s.id);
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
  let dashboardEditingId = null;     // cmd.id sendo editado inline (chegada)
  let dashboardEditingDraft = '';    // valor atual do input mascarado

  // Máscara estendida com milissegundos: "DD/MM/AAAA HH:MM:SS.mmm" (23 chars).
  const DT_MS_MASK_TEMPLATE = '__/__/____ __:__:__.___';
  const DT_MS_DIGIT_SLOTS = [0, 1, 3, 4, 6, 7, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];

  function buildDtMsMask(digits) {
    const arr = DT_MS_MASK_TEMPLATE.split('');
    const d = String(digits).replace(/\D/g, '').slice(0, 17);
    for (let i = 0; i < d.length; i++) arr[DT_MS_DIGIT_SLOTS[i]] = d[i];
    return arr.join('');
  }

  function readDtMsMaskDigits(value) {
    let out = '';
    for (const pos of DT_MS_DIGIT_SLOTS) {
      if (pos >= value.length) break;
      const c = value[pos];
      if (c >= '0' && c <= '9') out += c;
      else break;
    }
    return out;
  }

  function fmtDateMsForInput(ms) {
    if (!ms) return DT_MS_MASK_TEMPLATE;
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    const digits = pad(d.getDate()) + pad(d.getMonth() + 1) + d.getFullYear()
                 + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
                 + String(d.getMilliseconds()).padStart(3, '0');
    return buildDtMsMask(digits);
  }

  // Parseia "DD/MM/AAAA HH:MM:SS.mmm" → Unix ms local. Precisa dos 17 dígitos completos.
  function parseDateMsFromInput(str) {
    if (!str) return 0;
    const digits = String(str).replace(/\D/g, '');
    if (digits.length !== 17) return 0;
    const dd = parseInt(digits.slice(0, 2), 10);
    const mm = parseInt(digits.slice(2, 4), 10);
    const yyyy = parseInt(digits.slice(4, 8), 10);
    const hh = parseInt(digits.slice(8, 10), 10);
    const MM = parseInt(digits.slice(10, 12), 10);
    const ss = parseInt(digits.slice(12, 14), 10);
    const mmm = parseInt(digits.slice(14, 17), 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || MM > 59 || ss > 59) return 0;
    const d = new Date(yyyy, mm - 1, dd, hh, MM, ss, mmm);
    if (isNaN(d.getTime())) return 0;
    // valida round-trip (rejeita 31/02 por ex)
    if (d.getDate() !== dd || d.getMonth() !== mm - 1 || d.getFullYear() !== yyyy) return 0;
    return d.getTime();
  }

  // "HH:MM:SS" curto, sem ms — usado nas colunas Saída/Chegada do dashboard.
  function fmtTimeShort(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Decide se o comando aceita reagendamento manual.
  // Bloqueia uma vez `prepareForFire` tenha rodado (preparedBundles tem entrada).
  function isCommandReschedulable(cmd) {
    if (!cmd) return false;
    if (!['pending', 'scheduled', 'bundled'].includes(cmd.status)) return false;
    const bundle = getBundleSiblings(cmd);
    const lead = bundle[0] || cmd;
    if (preparedBundles.has(lead.id)) return false;
    return true;
  }
  let dashboardShowHistory = false;

  function renderDashboard() {
    const allCmds = getAllScheduledCommands();
    const TERMINAL = ['sent', 'failed_request', 'failed_overdue', 'aborted'];
    const active = allCmds.filter(c => !TERMINAL.includes(c.status));
    // descarta edição se o cmd não for mais editável (status mudou pra confirming/sending/etc)
    if (dashboardEditingId) {
      const editing = findCommandById(dashboardEditingId);
      if (!editing || !isCommandReschedulable(editing)) {
        dashboardEditingId = null;
        dashboardEditingDraft = '';
      }
    }
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

    // bind do lápis: abre/fecha o editor inline
    content.querySelectorAll('[data-dash-act="edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = findCommandById(btn.dataset.cid);
        if (!cmd || !isCommandReschedulable(cmd)) return;
        if (dashboardEditingId === cmd.id) {
          dashboardEditingId = null;
          dashboardEditingDraft = '';
        } else {
          dashboardEditingId = cmd.id;
          dashboardEditingDraft = fmtDateMsForInput(cmd.arrivalAt + (cmd.ms || 0));
        }
        renderDashboard();
      });
    });

    // bind do editor inline (input mascarado + salvar/cancelar)
    bindDashEditRow();

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
    const rows = cmds.map(c => {
      let html = renderDashRow(c, kind);
      if (kind === 'active' && dashboardEditingId === c.id && isCommandReschedulable(c)) {
        html += renderDashEditRow(c);
      }
      return html;
    }).join('');
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

  // Atualiza a previsão (saída + faltam) na linha de edição com base no input atual.
  function refreshDashEditPreview(cmd) {
    const preview = content.querySelector(`[data-edit-preview="${cmd.id}"]`);
    const saveBtn = content.querySelector(`[data-edit-act="save"][data-cid="${cmd.id}"]`);
    if (!preview || !saveBtn) return;
    const newArrival = parseDateMsFromInput(dashboardEditingDraft);
    if (!newArrival) {
      preview.innerHTML = `<span class="mog-dash-edit-error">Data inválida</span>`;
      saveBtn.disabled = true;
      return;
    }
    // newArrival é tempo local. Convertendo pra "server ts": como o display já é local
    // (fmtFullDate usa Date local) e o user digita local, usamos direto como server ts
    // — convenção do projeto (cliente/servidor mesmo fuso). Saída derivada do bundle:
    const bundle = getBundleSiblings(cmd);
    const lead = bundle[0];
    const newLeadArrival = newArrival - (cmd.ms || 0);   // desconta offset do wave atual
    const newLeadExecuteAt = newLeadArrival - (lead.travelMs || 0);
    const minExecuteAt = serverNow() + 2000;
    if (newLeadExecuteAt < minExecuteAt) {
      preview.innerHTML = `<span class="mog-dash-edit-error">Saída ficaria no passado</span>`;
      saveBtn.disabled = true;
      return;
    }
    const deltaMs = newLeadExecuteAt - serverNow();
    const totalS = Math.max(0, Math.round(deltaMs / 1000));
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    const cd = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
             : m > 0 ? `${m}m ${String(s).padStart(2, '0')}s`
             : `${s}s`;
    preview.innerHTML = `Saída: <span class="mog-dash-edit-out">${fmtFullDate(newLeadExecuteAt)}</span> · Faltam: <span class="mog-dash-edit-out">${cd}</span>`;
    saveBtn.disabled = false;
  }

  // Bind do input mascarado e dos botões de salvar/cancelar.
  function bindDashEditRow() {
    if (!dashboardEditingId) return;
    const cmd = findCommandById(dashboardEditingId);
    if (!cmd) return;
    const inp = content.querySelector(`[data-edit-input="${cmd.id}"]`);
    if (inp) {
      inp.addEventListener('input', () => {
        // Mantém máscara: lê só dígitos do que o user digitou e reaplica template.
        const digits = inp.value.replace(/\D/g, '').slice(0, 17);
        const masked = buildDtMsMask(digits);
        if (inp.value !== masked) inp.value = masked;
        dashboardEditingDraft = masked;
        refreshDashEditPreview(cmd);
      });
      inp.addEventListener('focus', () => {
        // Posiciona caret no primeiro slot vazio
        const digits = readDtMsMaskDigits(inp.value);
        const pos = digits.length < DT_MS_DIGIT_SLOTS.length ? DT_MS_DIGIT_SLOTS[digits.length] : DT_MS_MASK_TEMPLATE.length;
        setTimeout(() => inp.setSelectionRange(pos, pos), 0);
      });
      // primeiro render do preview
      refreshDashEditPreview(cmd);
    }
    const saveBtn = content.querySelector(`[data-edit-act="save"][data-cid="${cmd.id}"]`);
    const cancelBtn = content.querySelector(`[data-edit-act="cancel"][data-cid="${cmd.id}"]`);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        dashboardEditingId = null;
        dashboardEditingDraft = '';
        renderDashboard();
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const newArrival = parseDateMsFromInput(dashboardEditingDraft);
        if (!newArrival) return;
        const cur = findCommandById(dashboardEditingId);
        if (!cur || !isCommandReschedulable(cur)) return;
        // Server ts da chegada do *lead* (desconta offset da wave editada)
        const leadArrival = newArrival - (cur.ms || 0);
        const lead = getBundleSiblings(cur)[0];
        const minExecuteAt = serverNow() + 2000;
        if (leadArrival - (lead.travelMs || 0) < minExecuteAt) return;
        rescheduleCommand(lead, leadArrival);
        dashboardEditingId = null;
        dashboardEditingDraft = '';
        renderDashboard();
      });
    }
  }

  // Linha de edição inline da chegada (gridrow span all).
  function renderDashEditRow(c) {
    const initial = dashboardEditingDraft || fmtDateMsForInput(c.arrivalAt);
    return `
      <div class="mog-dash-edit-row" data-edit-cid="${c.id}">
        <label>Nova chegada:</label>
        <input class="mog-dash-edit-input" data-edit-input="${c.id}" type="text" value="${initial}" inputmode="numeric" maxlength="${DT_MS_MASK_TEMPLATE.length}" placeholder="${DT_MS_MASK_TEMPLATE}">
        <span class="mog-dash-edit-preview" data-edit-preview="${c.id}"></span>
        <div class="mog-dash-edit-actions">
          <button class="mog-dash-edit-cancel" data-edit-act="cancel" data-cid="${c.id}">Cancelar</button>
          <button class="mog-dash-edit-save" data-edit-act="save" data-cid="${c.id}">Salvar</button>
        </div>
      </div>
    `;
  }

  function renderDashRow(c, kind) {
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
    const canEdit = kind === 'active' && isCommandReschedulable(c);

    const typeLabel = c.type === 'support' ? 'Apoio' : 'Ataque';
    const typeCls = c.type === 'support' ? 'mog-dash-type-support' : 'mog-dash-type-attack';

    const arrivalTs = c.arrivalAt + (c.ms || 0);
    const editBtn = canEdit
      ? `<button class="mog-dash-edit-btn" data-dash-act="edit" data-cid="${c.id}" title="Editar chegada">✎</button>`
      : '';

    return `
      <div class="mog-dash-row ${rowCls}" data-cid="${c.id}" data-execute-at="${c.executeAt}">
        <div><span class="mog-dash-status ${stCls}">${stLabel}</span></div>
        <div><span class="mog-dash-type ${typeCls}">${typeLabel}</span></div>
        <div>${coordsLink(c.sourceCoords, c.sourceVillageId)}</div>
        <div>${coordsLink(c.targetCoords)}</div>
        <div class="mog-dash-units">${unitsHtml}</div>
        <div class="mog-dash-when" title="${fmtFullDate(c.executeAt)}">${fmtTimeShort(c.executeAt)}</div>
        <div class="mog-dash-when-wrap">
          <span class="mog-dash-when" title="${fmtFullDate(arrivalTs)}">${fmtTimeShort(arrivalTs)}.${String(new Date(arrivalTs).getMilliseconds()).padStart(3, '0')}</span>
          ${editBtn}
        </div>
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
  renderLog();
  // Boot async: valida licença ANTES de renderizar painel ou re-agendar timers.
  // Resultado inválido (expirado, nick desconhecido, sem rede) → tela de bloqueio
  // e nenhum motor é religado. Captcha guard segue rodando (vive antes do early-return).
  //
  // Importante: a sidebar é amarrada lá em cima e fica clicável desde já. Enquanto
  // o await não terminar (ou se invalidar), travamos TODOS os itens com
  // mog-side-disabled — o handler de click já respeita essa classe (linha ~4803).
  // Conteúdo fica como "Validando licença..." pra usuário não ver UI piscando.
  lockSidebar();
  content.innerHTML = `
    <div style="padding:48px 24px; text-align:center; color:var(--mog-text-mute);">
      <div style="font-size:32px; margin-bottom:10px;">⏳</div>
      <div style="font-size:14px;">Validando licença…</div>
    </div>
  `;

  (async () => {
    const result = await checkLicense();
    if (!result.ok) {
      // sidebar continua travada — usuário só pode usar "Tentar novamente" ou export
      renderLicenseBlock(result);
      updateHeadChips();
      return;
    }
    unlockSidebar();
    renderContent();
    runBootRecoveries();
    updateHeadChips();
  })();
})();
