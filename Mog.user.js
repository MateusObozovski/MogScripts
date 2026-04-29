// ==UserScript==
// @name         Mog Scripts
// @namespace    https://github.com/mateusobozovski/MogScripts
// @version      0.2.0
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

  const VERSION = '0.2.0';
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
        perQueue: 0,
        maxQueues: 0,
      }])),
      nextRunAt: 0,
    };
  }

  const DEFAULT_STATE = {
    enabled: false,
    ui: { activeTab: 'recruiter', editingProfileId: null },
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

  function migrateState(parsed) {
    const base = structuredClone(DEFAULT_STATE);
    base.enabled = parsed.enabled ?? false;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };

    if (parsed.recruiter?.profiles) {
      base.recruiter.profiles = parsed.recruiter.profiles.map(p => makeProfile(p));
      base.recruiter.log = Array.isArray(parsed.recruiter.log) ? parsed.recruiter.log : [];
      return base;
    }

    // Migração v1 (config única) → profiles[]
    const old = parsed.recruiter;
    if (old && old.units) {
      base.recruiter.profiles = [makeProfile({
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

  // Parser robusto: ignora o form de recrutamento e lê só o bloco "Ordens de
  // construção". Cada linha com img unit_<id>.png é uma fila ativa daquela unidade.
  function parseTrainQueue(doc) {
    const queue = [];
    const seenRows = new Set();

    const rows = doc.querySelectorAll(
      'table.train_list tbody tr, table#trainqueue tbody tr, .unit-queue tr, table.vis tbody tr'
    );

    rows.forEach(row => {
      // O form de recrutamento também tem imgs unit_*; filtra por linhas que
      // tenham timer/progress (característica da fila, não do form).
      const hasTimer = row.querySelector('.lit-item, .progress, .timer, span.grey, td.lit-item');
      const img = row.querySelector('img[src*="unit_"]');
      if (!img) return;
      if (!hasTimer) return;
      if (seenRows.has(row)) return;
      seenRows.add(row);

      const m = img.getAttribute('src').match(/unit_(\w+?)\.(?:png|webp)/);
      const unitId = m?.[1];
      if (!unitId) return;

      // Quantidade: primeira célula com texto numérico.
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
    state.recruiter.log = state.recruiter.log.slice(0, 80);
    persist();
    if (typeof renderLog === 'function') renderLog();
  }

  function computeRecruitForVillage(profile, trainData) {
    const queueByUnit = {};
    trainData.queue.forEach(q => {
      queueByUnit[q.unitId] = (queueByUnit[q.unitId] || 0) + 1;
    });

    const queuedCount = {};
    trainData.queue.forEach(q => {
      queuedCount[q.unitId] = (queuedCount[q.unitId] || 0) + q.count;
    });

    const toRecruit = {};
    for (const u of UNITS) {
      const c = profile.units[u.id];
      if (!c?.enabled) continue;
      if (c.perQueue <= 0 || c.maxQueues <= 0 || c.target <= 0) continue;

      const existing = trainData.units[u.id] || 0;
      const inQueue = queuedCount[u.id] || 0;
      const activeQueues = queueByUnit[u.id] || 0;

      if (existing + inQueue >= c.target) continue;
      if (activeQueues >= c.maxQueues) continue;

      const remaining = c.target - existing - inQueue;
      const amount = Math.min(c.perQueue, remaining);
      if (amount > 0) toRecruit[u.id] = amount;
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

  // ---------- scheduler (per-profile) ----------
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
    if (typeof renderStatus === 'function') renderStatus();
    const t = setTimeout(async () => {
      // Pode ter sido desligado durante a espera
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
    if (typeof renderStatus === 'function') renderStatus();
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
    if (typeof renderStatus === 'function') renderStatus();
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
  GM_addStyle(`
    .mog-fab {
      position: fixed;
      right: 24px;
      bottom: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      box-shadow: 0 10px 28px rgba(99,102,241,0.45);
      cursor: pointer;
      z-index: 999998;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 800;
      font-size: 22px;
      letter-spacing: 0.5px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      transition: transform 0.15s ease, box-shadow 0.2s ease;
      user-select: none;
    }
    .mog-fab:hover { transform: scale(1.08); box-shadow: 0 14px 36px rgba(139,92,246,0.55); }
    .mog-fab .mog-dot {
      position: absolute; top: 6px; right: 6px;
      width: 10px; height: 10px; border-radius: 50%;
      background: #94a3b8; border: 2px solid #1e1b4b;
    }
    .mog-fab.mog-active .mog-dot { background: #4ade80; box-shadow: 0 0 8px #4ade80; }

    .mog-panel {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 420px;
      background: linear-gradient(180deg, #0f172a 0%, #0b1220 100%);
      color: #e2e8f0;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      box-shadow: -20px 0 60px rgba(0,0,0,0.5);
      transform: translateX(100%);
      transition: transform 0.25s ease;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      border-left: 1px solid #1e293b;
    }
    .mog-panel.mog-open { transform: translateX(0); }

    .mog-head {
      padding: 16px 18px;
      background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
      border-bottom: 1px solid #1e293b;
      display: flex; align-items: center; gap: 12px;
    }
    .mog-logo {
      width: 36px; height: 36px; border-radius: 10px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: 800; font-size: 18px;
      box-shadow: 0 4px 14px rgba(99,102,241,0.4);
    }
    .mog-title { flex: 1; }
    .mog-title-name { font-weight: 700; font-size: 15px; color: #f1f5f9; }
    .mog-title-ver { font-size: 10px; color: #64748b; letter-spacing: 0.5px; }

    .mog-toggle {
      padding: 6px 12px;
      border-radius: 999px;
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      display: flex; align-items: center; gap: 6px;
      transition: all 0.15s;
    }
    .mog-toggle::before {
      content: ''; width: 8px; height: 8px; border-radius: 50%;
      background: #64748b;
    }
    .mog-toggle.mog-on {
      background: linear-gradient(135deg, #16a34a, #15803d);
      color: #f0fdf4; border-color: #166534;
    }
    .mog-toggle.mog-on::before { background: #bbf7d0; box-shadow: 0 0 6px #4ade80; }
    .mog-toggle:hover { filter: brightness(1.1); }

    .mog-close {
      background: none; border: none; color: #64748b;
      font-size: 22px; cursor: pointer; line-height: 1;
      padding: 4px 6px; border-radius: 6px;
    }
    .mog-close:hover { background: rgba(255,255,255,0.05); color: #e2e8f0; }

    .mog-tabs {
      display: flex; gap: 2px; padding: 0 12px;
      background: #0a1120; border-bottom: 1px solid #1e293b;
    }
    .mog-tab {
      padding: 10px 14px; cursor: pointer;
      color: #64748b; font-size: 12px; font-weight: 600;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .mog-tab:hover { color: #cbd5e1; }
    .mog-tab.mog-active {
      color: #a5b4fc; border-bottom-color: #6366f1;
    }

    .mog-body { flex: 1; overflow-y: auto; padding: 16px; }
    .mog-body::-webkit-scrollbar { width: 8px; }
    .mog-body::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }

    .mog-section {
      background: #111c30; border: 1px solid #1e293b;
      border-radius: 10px; padding: 14px; margin-bottom: 12px;
    }
    .mog-section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: #94a3b8; letter-spacing: 0.6px; margin-bottom: 10px;
      display: flex; align-items: center; justify-content: space-between;
    }

    .mog-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .mog-row:last-child { margin-bottom: 0; }
    .mog-label { color: #94a3b8; font-size: 12px; flex: 1; }

    .mog-input, .mog-select {
      background: #0a1120; border: 1px solid #1e293b;
      border-radius: 6px; padding: 6px 8px; color: #e2e8f0;
      font-family: inherit; font-size: 12px; outline: none;
      width: 70px; text-align: center;
    }
    .mog-select { width: auto; min-width: 120px; flex: 1; text-align: left; padding: 6px 8px; }
    .mog-input.mog-input-text { width: 100%; text-align: left; flex: 1; }
    .mog-input:focus, .mog-select:focus { border-color: #6366f1; }
    .mog-input[type="number"]::-webkit-inner-spin-button { opacity: 0.4; }

    .mog-unit-grid {
      display: grid;
      grid-template-columns: 28px 1fr 56px 50px 50px;
      gap: 6px; align-items: center;
      padding: 6px 0; border-bottom: 1px solid #1e293b;
      font-size: 11px;
    }
    .mog-unit-grid:last-child { border-bottom: none; }
    .mog-unit-grid.mog-unit-head {
      color: #64748b; font-size: 10px; text-transform: uppercase;
      font-weight: 700; letter-spacing: 0.4px; padding-bottom: 8px;
    }
    .mog-unit-grid.mog-unit-head > div { text-align: center; }
    .mog-unit-grid.mog-unit-head > div:nth-child(2) { text-align: left; }
    .mog-unit-grid input[type="checkbox"] { margin: 0; cursor: pointer; }
    .mog-unit-grid input[type="number"] { width: 100%; padding: 4px; box-sizing: border-box; }
    .mog-unit-name { color: #cbd5e1; font-size: 12px; }
    .mog-unit-building { color: #475569; font-size: 10px; display: block; }

    .mog-btn {
      background: linear-gradient(135deg, #6366f1, #7c3aed);
      color: #fff; border: none; border-radius: 8px;
      padding: 10px 14px; font-size: 12px; font-weight: 700;
      cursor: pointer; transition: filter 0.15s; width: 100%;
      letter-spacing: 0.3px;
    }
    .mog-btn:hover { filter: brightness(1.12); }
    .mog-btn.mog-btn-ghost { background: #1e293b; color: #cbd5e1; }
    .mog-btn.mog-btn-danger { background: linear-gradient(135deg, #dc2626, #991b1b); }
    .mog-btn.mog-btn-sm { padding: 6px 10px; font-size: 11px; width: auto; }

    .mog-status {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
      margin-bottom: 10px;
    }
    .mog-stat {
      background: #0a1120; border: 1px solid #1e293b;
      border-radius: 8px; padding: 8px 10px;
    }
    .mog-stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .mog-stat-value { font-size: 13px; color: #e2e8f0; font-weight: 600; margin-top: 2px; }

    .mog-log {
      background: #050a14; border: 1px solid #1e293b;
      border-radius: 8px; padding: 8px;
      max-height: 180px; overflow-y: auto;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 10.5px; color: #94a3b8; line-height: 1.5;
    }
    .mog-log:empty::before {
      content: 'Sem atividade ainda.'; color: #475569; font-style: italic;
    }
    .mog-log div { padding: 1px 0; }

    .mog-profile-card {
      background: #0a1120; border: 1px solid #1e293b;
      border-radius: 10px; padding: 12px; margin-bottom: 10px;
      display: flex; align-items: center; gap: 10px;
    }
    .mog-profile-card.mog-profile-on { border-color: #16a34a; box-shadow: 0 0 0 1px rgba(22,163,74,0.25); }
    .mog-profile-info { flex: 1; min-width: 0; }
    .mog-profile-name { font-weight: 700; color: #f1f5f9; font-size: 13px; }
    .mog-profile-meta { font-size: 10.5px; color: #64748b; margin-top: 3px; }
    .mog-profile-actions { display: flex; gap: 4px; flex-shrink: 0; }

    .mog-iconbtn {
      background: #1e293b; color: #cbd5e1; border: 1px solid #334155;
      border-radius: 6px; padding: 5px 8px; font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    .mog-iconbtn:hover { background: #334155; color: #fff; }
    .mog-iconbtn.mog-iconbtn-on {
      background: linear-gradient(135deg, #16a34a, #15803d);
      color: #f0fdf4; border-color: #166534;
    }
    .mog-iconbtn.mog-iconbtn-danger:hover { background: #7f1d1d; color: #fecaca; border-color: #991b1b; }

    .mog-empty {
      text-align: center; color: #64748b; padding: 20px 10px;
      font-size: 12px; font-style: italic;
    }

    .mog-back {
      background: none; border: none; color: #94a3b8;
      cursor: pointer; font-size: 12px; padding: 4px 0;
      margin-bottom: 8px; display: flex; align-items: center; gap: 4px;
    }
    .mog-back:hover { color: #e2e8f0; }
  `);

  // ---- DOM elements ----
  const fab = document.createElement('div');
  fab.className = 'mog-fab' + (state.enabled ? ' mog-active' : '');
  fab.innerHTML = `M<div class="mog-dot"></div>`;
  fab.title = 'Mog Scripts';

  const panel = document.createElement('div');
  panel.className = 'mog-panel';
  panel.innerHTML = `
    <div class="mog-head">
      <div class="mog-logo">M</div>
      <div class="mog-title">
        <div class="mog-title-name">Mog Scripts</div>
        <div class="mog-title-ver">v${VERSION}</div>
      </div>
      <button class="mog-toggle" id="mog-toggle">Pausado</button>
      <button class="mog-close" id="mog-close">&times;</button>
    </div>
    <div class="mog-tabs">
      <div class="mog-tab mog-active" data-tab="recruiter">Recrutamento</div>
    </div>
    <div class="mog-body" id="mog-body"></div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  fab.addEventListener('click', () => panel.classList.toggle('mog-open'));
  panel.querySelector('#mog-close').addEventListener('click', () => panel.classList.remove('mog-open'));

  const toggleBtn = panel.querySelector('#mog-toggle');
  function syncToggle() {
    if (state.enabled) {
      toggleBtn.classList.add('mog-on');
      toggleBtn.textContent = 'Ativo';
      fab.classList.add('mog-active');
    } else {
      toggleBtn.classList.remove('mog-on');
      toggleBtn.textContent = 'Pausado';
      fab.classList.remove('mog-active');
    }
  }
  toggleBtn.addEventListener('click', () => {
    if (state.enabled) stopGlobal();
    else startGlobal();
    syncToggle();
    render();
  });
  syncToggle();

  const body = panel.querySelector('#mog-body');

  // ---- router ----
  function render() {
    if (state.ui.editingProfileId) {
      const p = state.recruiter.profiles.find(x => x.id === state.ui.editingProfileId);
      if (!p) {
        state.ui.editingProfileId = null;
        return render();
      }
      renderEditor(p);
    } else {
      renderProfilesList();
    }
  }

  // ---- profiles list ----
  function renderProfilesList() {
    body.innerHTML = `
      <div class="mog-section">
        <div class="mog-section-title">
          <span>Modelos</span>
          <button class="mog-btn mog-btn-sm" id="mog-add-profile">+ Novo modelo</button>
        </div>
        <div id="mog-profiles-wrap"></div>
      </div>

      <div class="mog-section">
        <div class="mog-section-title">Status</div>
        <div class="mog-status">
          <div class="mog-stat">
            <div class="mog-stat-label">Estado</div>
            <div class="mog-stat-value" id="mog-stat-state">—</div>
          </div>
          <div class="mog-stat">
            <div class="mog-stat-label">Modelos ativos</div>
            <div class="mog-stat-value" id="mog-stat-active">—</div>
          </div>
        </div>
        <div class="mog-log" id="mog-log"></div>
      </div>
    `;

    renderProfilesCards();
    renderStatus();
    renderLog();

    body.querySelector('#mog-add-profile').addEventListener('click', () => {
      const p = makeProfile({ name: `Modelo ${state.recruiter.profiles.length + 1}` });
      state.recruiter.profiles.push(p);
      state.ui.editingProfileId = p.id;
      persist();
      render();
    });
  }

  function renderProfilesCards() {
    const wrap = body.querySelector('#mog-profiles-wrap');
    if (!wrap) return;

    if (!state.recruiter.profiles.length) {
      wrap.innerHTML = `<div class="mog-empty">Nenhum modelo criado ainda. Clique em "+ Novo modelo".</div>`;
      return;
    }

    wrap.innerHTML = state.recruiter.profiles.map(p => {
      const enabledUnits = Object.values(p.units).filter(u => u.enabled).length;
      return `
        <div class="mog-profile-card ${p.enabled ? 'mog-profile-on' : ''}">
          <div class="mog-profile-info">
            <div class="mog-profile-name">${escapeHtml(p.name)}</div>
            <div class="mog-profile-meta">
              ${enabledUnits} unid. · ${p.intervalMin}–${p.intervalMax} min
              ${p.enabled && p.nextRunAt ? ' · próx. ' + new Date(p.nextRunAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}
            </div>
          </div>
          <div class="mog-profile-actions">
            <button class="mog-iconbtn ${p.enabled ? 'mog-iconbtn-on' : ''}" data-action="toggle" data-pid="${p.id}">
              ${p.enabled ? 'ON' : 'OFF'}
            </button>
            <button class="mog-iconbtn" data-action="edit" data-pid="${p.id}">Editar</button>
            <button class="mog-iconbtn mog-iconbtn-danger" data-action="delete" data-pid="${p.id}">×</button>
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.pid;
        const action = btn.dataset.action;
        const p = state.recruiter.profiles.find(x => x.id === pid);
        if (!p) return;

        if (action === 'toggle') {
          if (p.enabled) stopProfile(p);
          else startProfile(p);
          renderProfilesCards();
          renderStatus();
        } else if (action === 'edit') {
          state.ui.editingProfileId = p.id;
          persist();
          render();
        } else if (action === 'delete') {
          if (!confirm(`Excluir o modelo "${p.name}"?`)) return;
          if (p.enabled) stopProfile(p);
          state.recruiter.profiles = state.recruiter.profiles.filter(x => x.id !== pid);
          persist();
          renderProfilesCards();
          renderStatus();
        }
      });
    });
  }

  // ---- profile editor ----
  async function renderEditor(profile) {
    body.innerHTML = `
      <button class="mog-back" id="mog-back">← Voltar para modelos</button>

      <div class="mog-section">
        <div class="mog-section-title">Identificação</div>
        <div class="mog-row">
          <span class="mog-label" style="flex:0;min-width:50px;">Nome</span>
          <input type="text" class="mog-input mog-input-text" id="mog-prof-name" value="${escapeHtml(profile.name)}">
        </div>
        <div class="mog-row">
          <span class="mog-label" style="flex:0;min-width:50px;">Grupo</span>
          <select class="mog-select" id="mog-prof-group"></select>
          <button class="mog-iconbtn" id="mog-refresh-groups" title="Atualizar grupos">↻</button>
        </div>
      </div>

      <div class="mog-section">
        <div class="mog-section-title">Tropas</div>
        <div class="mog-unit-grid mog-unit-head">
          <div></div><div>Unidade</div><div>Total</div><div>/Fila</div><div>Filas</div>
        </div>
        <div id="mog-units"></div>
      </div>

      <div class="mog-section">
        <div class="mog-section-title">Intervalo entre execuções</div>
        <div class="mog-row">
          <span class="mog-label">De</span>
          <input type="number" class="mog-input" id="mog-int-min" min="1" value="${profile.intervalMin}">
          <span class="mog-label" style="flex:0;">a</span>
          <input type="number" class="mog-input" id="mog-int-max" min="1" value="${profile.intervalMax}">
          <span class="mog-label" style="flex:0;">min</span>
        </div>
      </div>

      <div class="mog-section">
        <div class="mog-row">
          <button class="mog-btn mog-btn-ghost" id="mog-run-now">Executar agora</button>
        </div>
      </div>
    `;

    renderEditorUnits(profile);
    await renderEditorGroups(profile);

    body.querySelector('#mog-back').addEventListener('click', () => {
      state.ui.editingProfileId = null;
      persist();
      render();
    });

    body.querySelector('#mog-prof-name').addEventListener('change', e => {
      profile.name = e.target.value.trim() || 'Sem nome';
      persist();
    });

    body.querySelector('#mog-prof-group').addEventListener('change', e => {
      profile.groupId = parseInt(e.target.value, 10) || 0;
      persist();
    });

    body.querySelector('#mog-refresh-groups').addEventListener('click', async () => {
      await renderEditorGroups(profile, true);
    });

    body.querySelector('#mog-int-min').addEventListener('change', e => {
      profile.intervalMin = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });
    body.querySelector('#mog-int-max').addEventListener('change', e => {
      profile.intervalMax = Math.max(1, parseInt(e.target.value, 10) || 1);
      persist();
    });

    body.querySelector('#mog-run-now').addEventListener('click', () => runProfileCycle(profile));
  }

  function renderEditorUnits(profile) {
    const wrap = body.querySelector('#mog-units');
    if (!wrap) return;
    wrap.innerHTML = UNITS.map(u => {
      const c = profile.units[u.id];
      return `
        <div class="mog-unit-grid">
          <input type="checkbox" data-uid="${u.id}" data-field="enabled" ${c.enabled ? 'checked' : ''}>
          <div>
            <span class="mog-unit-name">${u.name}</span>
            <span class="mog-unit-building">${u.building}</span>
          </div>
          <input type="number" min="0" data-uid="${u.id}" data-field="target" value="${c.target}">
          <input type="number" min="0" data-uid="${u.id}" data-field="perQueue" value="${c.perQueue}">
          <input type="number" min="0" data-uid="${u.id}" data-field="maxQueues" value="${c.maxQueues}">
        </div>
      `;
    }).join('');
    wrap.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', e => {
        const uid = e.target.dataset.uid;
        const field = e.target.dataset.field;
        const cfg = profile.units[uid];
        if (field === 'enabled') cfg.enabled = e.target.checked;
        else cfg[field] = Math.max(0, parseInt(e.target.value, 10) || 0);
        persist();
      });
    });
  }

  async function renderEditorGroups(profile, force = false) {
    const sel = body.querySelector('#mog-prof-group');
    if (!sel) return;
    sel.innerHTML = `<option>Carregando...</option>`;
    const groups = await getGroups(force);
    sel.innerHTML = groups.map(g =>
      `<option value="${g.id}" ${g.id === profile.groupId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
    ).join('');
  }

  // ---- status & log ----
  function renderStatus() {
    const stateEl = body.querySelector('#mog-stat-state');
    const activeEl = body.querySelector('#mog-stat-active');
    if (stateEl) {
      stateEl.textContent = state.enabled ? 'Ativo' : 'Pausado';
      stateEl.style.color = state.enabled ? '#4ade80' : '#94a3b8';
    }
    if (activeEl) {
      const n = state.recruiter.profiles.filter(p => p.enabled).length;
      activeEl.textContent = `${n} / ${state.recruiter.profiles.length}`;
    }
  }

  function renderLog() {
    const el = body.querySelector('#mog-log');
    if (!el) return;
    el.innerHTML = state.recruiter.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // refresh card "próx." e status a cada segundo
  setInterval(() => {
    if (state.ui.editingProfileId) return;
    renderProfilesCards();
    renderStatus();
  }, 1000);

  // initial render + auto-resume
  render();
  if (state.enabled) {
    state.recruiter.profiles.forEach(p => {
      if (p.enabled) scheduleProfileNext(p);
    });
  }
})();
