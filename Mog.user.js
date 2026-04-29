// ==UserScript==
// @name         Mog Scripts
// @namespace    https://github.com/mateusobozovski/MogScripts
// @version      0.5.0
// @description  Toolkit pessoal para Tribal Wars
// @author       Mog
// @match        https://*.tribalwars.com.br/game.php?*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  // só inicializa na tela do armazém — bot vive enquanto essa aba estiver aberta
  if (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data?.screen !== 'storage') {
    return;
  }

  const VERSION = '0.5.0';
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

  const GROUP_ALL = { id: 0, name: 'Todos' };

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

  const DEFAULT_STATE = {
    enabled: false,
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

  function migrateState(parsed) {
    const base = structuredClone(DEFAULT_STATE);
    base.enabled = parsed.enabled ?? false;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };

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
      const url = `/game.php?screen=overview_villages&mode=combined`;
      const res = await fetch(url, { credentials: 'include' });
      const html = await res.text();
      return parseVillagesFromOverview(html);
    },

    async fetchGroupVillages(groupId) {
      if (!groupId) return this.fetchAllVillages();
      const url = `/game.php?screen=overview_villages&mode=combined&group=${groupId}`;
      const res = await fetch(url, { credentials: 'include' });
      const html = await res.text();
      return parseVillagesFromOverview(html);
    },

    async fetchTrainData(villageId) {
      const url = `/game.php?village=${villageId}&screen=train`;
      const res = await fetch(url, { credentials: 'include' });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const units = {};
      UNITS.forEach(u => {
        let count = 0;
        const row = doc.querySelector(`tr#${u.id}_0_a, tr.row_a#${u.id}, tr[id^="${u.id}"]`);
        if (row) {
          const txt = row.querySelector('td:nth-child(3)')?.textContent || '';
          const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) count = parseInt(m[1], 10);
        }
        if (!count) {
          const link = doc.querySelector(`a.unit_link[data-unit="${u.id}"]`);
          if (link) count = parseInt(link.textContent.replace(/\D/g, '') || '0', 10);
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
  };

  function parseVillagesFromOverview(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = doc.querySelectorAll('table#combined_table a[href*="village="]');
    const seen = new Set();
    const villages = [];
    links.forEach(a => {
      const m = a.getAttribute('href').match(/village=(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      villages.push({ id, name: a.textContent.trim() });
    });
    return villages;
  }

  function parseTrainQueue(doc) {
    const queue = [];
    const seenRows = new Set();

    const rows = doc.querySelectorAll(
      'table.train_list tbody tr, table#trainqueue tbody tr, .unit-queue tr, table.vis tbody tr'
    );

    rows.forEach(row => {
      const hasTimer = row.querySelector('.lit-item, .progress, .timer, span.grey, td.lit-item');
      const img = row.querySelector('img[src*="unit_"]');
      if (!img) return;
      if (!hasTimer) return;
      if (seenRows.has(row)) return;
      seenRows.add(row);

      const m = img.getAttribute('src').match(/unit_(\w+?)\.(?:png|webp)/);
      const unitId = m?.[1];
      if (!unitId) return;

      let count = 0;
      for (const td of row.querySelectorAll('td')) {
        const cm = td.textContent.trim().match(/^(\d+)\b/);
        if (cm) { count = parseInt(cm[1], 10); break; }
      }
      queue.push({ unitId, count });
    });

    return queue;
  }

  // ---------- recruiter engine ----------
  function pushLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    state.recruiter.log.unshift(`[${ts}] ${msg}`);
    state.recruiter.log = state.recruiter.log.slice(0, 200);
    persist();
    if (typeof renderLog === 'function') renderLog();
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

      // Filas ativas no edifício = filas das unidades desse edifício
      const buildingUnits = UNITS.filter(u => u.building === building);
      const activeQueues = trainData.queue.filter(q =>
        buildingUnits.some(u => u.id === q.unitId)
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
    if (!state.enabled || !profile.enabled) return;

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

    let touched = 0;
    for (const v of villages) {
      if (!state.enabled || !profile.enabled) break;
      try {
        const td = await Game.fetchTrainData(v.id);
        const recruit = computeRecruitForVillage(profile, td);
        if (Object.keys(recruit).length === 0) continue;
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
      } catch (e) {
        pushLog(`[${profile.name}] ${v.name}: erro (${e.message})`);
      }
      await sleep(400 + Math.random() * 600);
    }
    pushLog(`[${profile.name}] ciclo finalizado. ${touched} aldeia(s) atualizada(s).`);
  }

  // ---------- scheduler ----------
  const profileTimers = new Map();

  function nextDelayMs(profile) {
    const min = Math.max(1, profile.intervalMin);
    const max = Math.max(min, profile.intervalMax);
    const minutes = min + Math.random() * (max - min);
    return Math.round(minutes * 60 * 1000);
  }

  function scheduleProfileNext(profile) {
    clearTimeout(profileTimers.get(profile.id));
    if (!state.enabled || !profile.enabled) {
      profile.nextRunAt = 0;
      return;
    }
    const delay = nextDelayMs(profile);
    profile.nextRunAt = Date.now() + delay;
    persist();
    const t = setTimeout(async () => {
      const fresh = state.recruiter.profiles.find(p => p.id === profile.id);
      if (!fresh) return;
      if (state.enabled && fresh.enabled) {
        await runProfileCycle(fresh);
        scheduleProfileNext(fresh);
      }
    }, delay);
    profileTimers.set(profile.id, t);
  }

  function startProfile(profile) {
    profile.enabled = true;
    persist();
    if (state.enabled) scheduleProfileNext(profile);
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

  function startGlobal() {
    state.enabled = true;
    persist();
    state.recruiter.profiles.forEach(p => {
      if (p.enabled) scheduleProfileNext(p);
    });
    pushLog('Bot iniciado.');
  }

  function stopGlobal() {
    state.enabled = false;
    state.recruiter.profiles.forEach(p => {
      p.nextRunAt = 0;
      clearTimeout(profileTimers.get(p.id));
    });
    profileTimers.clear();
    persist();
    pushLog('Bot pausado.');
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const COLOR_BG = '#121313';
  const COLOR_ACCENT = '#FF6044';

  GM_addStyle(`
    /* launcher lateral */
    .mog-launcher {
      position: fixed;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 38px;
      height: 56px;
      background: ${COLOR_BG};
      border: 1px solid #2a2b2b;
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
    .mog-launcher:hover { width: 46px; color: #fff; background: ${COLOR_ACCENT}; }
    .mog-launcher .mog-launcher-dot {
      position: absolute;
      bottom: 7px; right: 7px;
      width: 7px; height: 7px; border-radius: 50%;
      background: #4a4b4b;
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
      color: #e6e6e6;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      border: 1px solid #2a2b2b;
      border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
      z-index: 999999;
      display: grid;
      grid-template-columns: 220px 1fr;
      grid-template-rows: 56px 1fr;
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
      padding: 0 20px;
      border-bottom: 1px solid #1f1f1f;
      display: flex; align-items: center; gap: 14px;
    }
    .mog-logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: ${COLOR_ACCENT};
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: 800; font-size: 16px;
      flex-shrink: 0;
    }
    .mog-title-name { font-weight: 700; font-size: 14px; color: #fafafa; line-height: 1.1; }
    .mog-title-ver { font-size: 10px; color: #6b6b6b; letter-spacing: 0.5px; margin-top: 2px; }
    .mog-head-spacer { flex: 1; }

    .mog-toggle {
      padding: 8px 16px;
      border-radius: 999px;
      background: #1a1b1b;
      color: #888;
      border: 1px solid #2a2b2b;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      display: flex; align-items: center; gap: 7px;
      transition: all 0.15s;
    }
    .mog-toggle::before {
      content: ''; width: 7px; height: 7px; border-radius: 50%; background: #555;
    }
    .mog-toggle.mog-on { background: ${COLOR_ACCENT}; color: #fff; border-color: ${COLOR_ACCENT}; }
    .mog-toggle.mog-on::before { background: #fff; box-shadow: 0 0 6px rgba(255,255,255,0.8); }
    .mog-toggle:hover { filter: brightness(1.1); }

    .mog-close {
      background: none; border: none; color: #6b6b6b;
      font-size: 22px; cursor: pointer; line-height: 1;
      padding: 4px 8px; border-radius: 6px;
    }
    .mog-close:hover { background: #1a1b1b; color: #fafafa; }

    /* sidebar */
    .mog-side {
      grid-area: side;
      border-right: 1px solid #1f1f1f;
      padding: 16px 0;
      overflow-y: auto;
      background: #0f1010;
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
      color: #5a5b5b;
      display: flex; align-items: center; gap: 6px;
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }
    .mog-side-title:hover { color: #aaa; }
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
      color: #aaa;
      font-size: 12.5px;
      font-weight: 500;
      border-left: 2px solid transparent;
      transition: all 0.15s;
    }
    .mog-side-item:hover { background: #161717; color: #fafafa; }
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
    .mog-side-item.mog-side-disabled:hover { background: transparent; color: #aaa; }
    .mog-side-icon {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px;
    }
    .mog-side-badge {
      margin-left: auto;
      font-size: 9px;
      padding: 2px 6px;
      background: #2a2b2b;
      color: #888;
      border-radius: 999px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      font-weight: 700;
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
    .mog-content::-webkit-scrollbar-thumb { background: #2a2b2b; border-radius: 4px; }
    .mog-content::-webkit-scrollbar-thumb:hover { background: ${COLOR_ACCENT}; }

    .mog-section-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 16px;
    }
    .mog-section-head h2 {
      margin: 0; font-size: 16px; font-weight: 700; color: #fafafa;
      letter-spacing: 0.2px;
    }
    .mog-section-head p {
      margin: 4px 0 0; font-size: 11.5px; color: #888;
    }

    .mog-add-btn {
      background: ${COLOR_ACCENT}; color: #fff; border: none;
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
      color: #5a5b5b;
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
      background: #181919;
      border: 1px solid #232424;
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
      background: #2a2b2b; cursor: pointer; position: relative;
      transition: background 0.15s;
    }
    .mog-tg::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: #888;
      transition: all 0.15s;
    }
    .mog-prow.mog-prow-on .mog-tg { background: ${COLOR_ACCENT}; }
    .mog-prow.mog-prow-on .mog-tg::after { left: 18px; background: #fff; }

    .mog-pname {
      background: transparent; border: 1px solid transparent;
      color: #fafafa; font-size: 13px; font-weight: 600;
      padding: 7px 9px; border-radius: 6px;
      width: 100%; outline: none; box-sizing: border-box;
    }
    .mog-pname:hover { background: #1f2020; }
    .mog-pname:focus { background: #1f2020; border-color: ${COLOR_ACCENT}; }

    .mog-input, .mog-select {
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 6px; padding: 7px 6px; color: #e6e6e6;
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
      color: #fafafa;
      text-align: center;
      letter-spacing: -0.3px;
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";
    }
    .mog-target.mog-target-off {
      color: #555;
      font-weight: 400;
    }
    .mog-target:focus {
      background: #181919;
      color: #fafafa;
    }

    .mog-interval {
      display: flex; gap: 4px; align-items: center; justify-content: center;
      font-size: 11px; color: #888;
      min-width: 0;
    }
    .mog-interval input {
      flex: 1; min-width: 0; width: auto;
      padding: 6px 4px; max-width: 42px;
    }

    .mog-status-cell {
      font-size: 10.5px; color: #888;
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
      color: #888; cursor: pointer;
      padding: 6px 8px; border-radius: 6px; font-size: 14px;
      line-height: 1; transition: all 0.15s;
    }
    .mog-iconbtn:hover { background: #1f2020; color: #fafafa; }
    .mog-iconbtn.mog-iconbtn-danger:hover { background: #3a1614; color: ${COLOR_ACCENT}; }

    .mog-prow-expand {
      border-top: 1px solid #232424;
      padding: 14px 16px;
      display: none;
      background: #141515;
      border-radius: 0 0 10px 10px;
    }
    .mog-prow.mog-prow-expanded .mog-prow-expand { display: block; }
    .mog-prow.mog-prow-expanded .mog-prow-main { border-radius: 10px 10px 0 0; }

    .mog-bgroups { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .mog-bgroup {
      background: #1a1b1b; border: 1px solid #232424;
      border-radius: 8px; padding: 14px 16px;
      display: flex; flex-direction: column;
    }
    .mog-bgroup-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: ${COLOR_ACCENT}; letter-spacing: 0.5px; margin-bottom: 4px;
    }
    .mog-bgroup-units {
      font-size: 10.5px; color: #6b6b6b; margin-bottom: 12px;
      line-height: 1.4;
    }
    .mog-bgroup-fields {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      margin-top: auto;
    }
    .mog-bunit-cell { display: flex; flex-direction: column; gap: 4px; }
    .mog-bunit-cell label { font-size: 9.5px; color: #888; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .mog-bunit-cell input {
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 6px; padding: 7px 8px; color: #e6e6e6;
      font-family: inherit; font-size: 12px; outline: none;
      width: 100%; box-sizing: border-box; text-align: center;
    }
    .mog-bunit-cell input:focus { border-color: ${COLOR_ACCENT}; }

    .mog-prow-tools {
      display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end;
    }
    .mog-btn {
      background: ${COLOR_ACCENT}; color: #fff; border: none;
      padding: 8px 16px; border-radius: 7px;
      font-size: 11px; font-weight: 700; cursor: pointer;
      letter-spacing: 0.3px; text-transform: uppercase;
      transition: filter 0.15s;
    }
    .mog-btn:hover { filter: brightness(1.1); }
    .mog-btn.mog-btn-ghost { background: #1f2020; color: #ccc; }
    .mog-btn.mog-btn-ghost:hover { background: #2a2b2b; color: #fff; filter: none; }

    .mog-empty {
      text-align: center; color: #6b6b6b; padding: 36px 16px;
      font-size: 12px; font-style: italic;
      background: #181919;
      border: 1px dashed #2a2b2b;
      border-radius: 10px;
    }

    .mog-placeholder {
      text-align: center; padding: 80px 20px; color: #6b6b6b;
    }
    .mog-placeholder-icon { font-size: 36px; margin-bottom: 12px; }
    .mog-placeholder-title { color: #aaa; font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .mog-placeholder-text { font-size: 12px; }

    /* log dock */
    .mog-log {
      border-top: 1px solid #1f1f1f;
      background: #0e0f0f;
      display: flex; flex-direction: column;
      max-height: 180px;
      transition: max-height 0.2s ease;
    }
    .mog-log.mog-log-collapsed { max-height: 36px; }

    .mog-log-head {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 18px;
      border-bottom: 1px solid #1f1f1f;
      flex-shrink: 0;
    }
    .mog-log.mog-log-collapsed .mog-log-head { border-bottom: none; }
    .mog-log-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.6px; color: #888;
    }
    .mog-log-count {
      font-size: 10px; color: #5a5b5b; font-weight: 600;
    }
    .mog-log-spacer { flex: 1; }
    .mog-log-action {
      background: transparent; border: none;
      color: #888; cursor: pointer;
      padding: 4px 10px; font-size: 10.5px; font-weight: 600;
      border-radius: 5px; letter-spacing: 0.3px;
      text-transform: uppercase; transition: all 0.15s;
    }
    .mog-log-action:hover { color: #fafafa; background: #1a1b1b; }

    .mog-log-body {
      flex: 1; overflow-y: auto;
      padding: 8px 18px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px; color: #aaa; line-height: 1.6;
    }
    .mog-log-body::-webkit-scrollbar { width: 6px; }
    .mog-log-body::-webkit-scrollbar-thumb { background: #2a2b2b; border-radius: 3px; }
    .mog-log.mog-log-collapsed .mog-log-body { display: none; }
    .mog-log-body:empty::before {
      content: 'Sem atividade ainda.'; color: #555; font-style: italic;
    }
    .mog-log-body div { padding: 1px 0; }
  `);

  // ---- DOM build ----
  const launcher = document.createElement('div');
  launcher.className = 'mog-launcher' + (state.enabled ? ' mog-active' : '');
  launcher.innerHTML = `M<div class="mog-launcher-dot"></div>`;
  launcher.title = 'Mog Scripts';

  const overlay = document.createElement('div');
  overlay.className = 'mog-overlay';

  const panel = document.createElement('div');
  panel.className = 'mog-panel';
  panel.innerHTML = `
    <div class="mog-head">
      <div class="mog-logo">M</div>
      <div>
        <div class="mog-title-name">Mog Scripts</div>
        <div class="mog-title-ver">v${VERSION}</div>
      </div>
      <div class="mog-head-spacer"></div>
      <button class="mog-toggle" id="mog-toggle">Pausado</button>
      <button class="mog-close" id="mog-close">&times;</button>
    </div>

    <aside class="mog-side">
      <div class="mog-side-section" data-side-section="account">
        <div class="mog-side-title" data-side-toggle="account">
          <span class="mog-side-caret">▼</span>
          <span>Gerente de Conta</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item mog-side-disabled" data-section="builder">
            <span class="mog-side-icon">🏗</span>
            <span>Construtor</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
          <div class="mog-side-item mog-side-active" data-section="recruiter">
            <span class="mog-side-icon">⚔</span>
            <span>Recrutamento</span>
          </div>
          <div class="mog-side-item mog-side-disabled" data-section="research">
            <span class="mog-side-icon">⚗</span>
            <span>Pesquisa</span>
            <span class="mog-side-badge">Em breve</span>
          </div>
        </div>
      </div>

      <div class="mog-side-section" data-side-section="tools">
        <div class="mog-side-title" data-side-toggle="tools">
          <span class="mog-side-caret">▼</span>
          <span>Ferramentas</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item mog-side-disabled">
            <span class="mog-side-icon">⚙</span>
            <span>Configurações</span>
            <span class="mog-side-badge">Em breve</span>
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

  // ---- global toggle ----
  const toggleBtn = panel.querySelector('#mog-toggle');
  function syncToggle() {
    if (state.enabled) {
      toggleBtn.classList.add('mog-on');
      toggleBtn.textContent = 'Ativo';
      launcher.classList.add('mog-active');
    } else {
      toggleBtn.classList.remove('mog-on');
      toggleBtn.textContent = 'Pausado';
      launcher.classList.remove('mog-active');
    }
  }
  toggleBtn.addEventListener('click', () => {
    if (state.enabled) stopGlobal();
    else startGlobal();
    syncToggle();
    renderContent();
  });
  syncToggle();

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
    state.recruiter.log = [];
    persist();
    renderLog();
  });

  // ---- content router ----
  const content = panel.querySelector('#mog-content');

  function renderContent() {
    if (state.ui.activeSection === 'recruiter') {
      renderRecruiter();
    } else {
      renderPlaceholder(state.ui.activeSection);
    }
  }

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
          <div class="mog-status-cell ${p.enabled && state.enabled ? 'mog-status-active' : ''}" data-act="status-cell">
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
    if (!p.enabled) return 'Pausado';
    if (!state.enabled) return 'Aguardando';
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

  // ---- log render ----
  function renderLog() {
    const body = panel.querySelector('#mog-log-body');
    const count = panel.querySelector('#mog-log-count');
    if (!body) return;
    body.innerHTML = state.recruiter.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
    if (count) count.textContent = String(state.recruiter.log.length);
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
        cell.classList.toggle('mog-status-active', p.enabled && state.enabled);
      }
    });
  }, 1000);

  // initial
  renderContent();
  renderLog();
  if (state.enabled) {
    state.recruiter.profiles.forEach(p => {
      if (p.enabled) scheduleProfileNext(p);
    });
  }
})();
