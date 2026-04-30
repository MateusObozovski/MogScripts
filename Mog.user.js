// ==UserScript==
// @name         Mog Scripts
// @namespace    https://github.com/mateusobozovski/MogScripts
// @version      0.6.1
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

  const VERSION = '0.6.1';
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

  function makeOperation(overrides = {}) {
    return {
      id: overrides.id || `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: overrides.name || 'Nova operação',
      status: overrides.status || 'draft',
      step: overrides.step ?? 1,
      createdAt: overrides.createdAt || Date.now(),
      activatedAt: overrides.activatedAt || 0,
      finishedAt: overrides.finishedAt || 0,
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
      firstMs: overrides.firstMs ?? 200,
      firstMsRandom: overrides.firstMsRandom ?? false,
      firstMsMin: overrides.firstMsMin ?? 0,
      firstMsMax: overrides.firstMsMax ?? 999,
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
    avgRtt: 0,            // ms (ida+volta)
    avgOffset: 0,         // ms (clock diff: servidor − cliente)
    manualOverride: 0,    // ms (se >0, usa esse valor, ignora medição auto)
    measuredAt: 0,        // timestamp da última medição
    samples: 0,           // quantas medições já foram feitas
    extraBuffer: 300,     // ms adicionais à compensação (tempo do servidor processar o POST). Ajustável.
  };

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
    scheduler: {
      operations: [],
      worldConfig: structuredClone(DEFAULT_WORLD_CONFIG),
      latency: structuredClone(DEFAULT_LATENCY),
      log: [],
      ui: { activeOperationId: null, wizardStep: 1 },
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
    }
    if (Array.isArray(parsed.log)) base.log = parsed.log;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    return base;
  }

  function migrateState(parsed) {
    const base = structuredClone(DEFAULT_STATE);
    base.enabled = parsed.enabled ?? false;
    if (parsed.ui) base.ui = { ...base.ui, ...parsed.ui };
    base.scheduler = migrateScheduler(parsed.scheduler);

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

    profile.running = { processed: 0, total: villages.length, touched: 0 };
    pushLog(`[${profile.name}] processando ${villages.length} aldeia(s)...`);

    let touched = 0;
    for (let i = 0; i < villages.length; i++) {
      const v = villages[i];
      if (!state.enabled || !profile.enabled) break;
      try {
        const td = await Game.fetchTrainData(v.id);
        const recruit = computeRecruitForVillage(profile, td);
        if (Object.keys(recruit).length > 0) {
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
        const rtt = t1 - t0;
        rttSamples.push(rtt);
        const dateHeader = r.headers.get('Date');
        if (dateHeader) {
          const serverTs = new Date(dateHeader).getTime();
          // assume que o servidor escreveu Date no meio do RTT
          const localMid = (tStart + tEnd) / 2;
          offsetSamples.push(serverTs - localMid);
        }
      } catch {}
      await sleep(120);
    }
    if (rttSamples.length < 3) return null;
    rttSamples.sort((a, b) => a - b);
    const rttMid = rttSamples.slice(1, -1);
    const avgRtt = rttMid.reduce((s, x) => s + x, 0) / rttMid.length;
    let avgOffset = 0;
    if (offsetSamples.length >= 3) {
      offsetSamples.sort((a, b) => a - b);
      const offMid = offsetSamples.slice(1, -1);
      avgOffset = offMid.reduce((s, x) => s + x, 0) / offMid.length;
    }
    return { avgRtt: Math.round(avgRtt), avgOffset: Math.round(avgOffset) };
  }

  async function refreshLatency() {
    try {
      const r = await measureLatency();
      if (!r) return;
      const lat = state.scheduler.latency;
      lat.avgRtt = r.avgRtt;
      lat.avgOffset = r.avgOffset;
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

  // Converte timestamp do servidor em timestamp local (subtraindo o offset).
  // Usado pra agendar setTimeout, que opera no relógio local do PC.
  function serverToLocalTs(serverTs) {
    return serverTs - (state.scheduler.latency.avgOffset || 0);
  }

  // Hora atual do servidor em ms.
  function serverNow() {
    return Date.now() + (state.scheduler.latency.avgOffset || 0);
  }

  // tempo de antecipação: enviamos esse tanto antes do horário-alvo.
  // Combina RTT cheio (rede + servidor) com um buffer extra ajustável (default 300ms).
  function latencyCompensation() {
    const lat = state.scheduler.latency;
    if (lat.manualOverride > 0) return lat.manualOverride;
    return Math.max(0, Math.round(lat.avgRtt + (lat.extraBuffer ?? 300)));
  }

  // ticker de 5s: re-mede latência (não roda se há override manual)
  setInterval(() => {
    if (state.scheduler.latency.manualOverride > 0) return;
    refreshLatency();
  }, 5 * 1000);

  // pré-aquece a conexão TCP fazendo um HEAD curto antes do envio real
  function warmupConnection() {
    try { fetch('/game.php?screen=overview', { method: 'HEAD', credentials: 'include' }); } catch {}
  }

  // ---------- scheduler de comandos (Agendador) ----------
  const commandTimers = new Map();           // id → fire setTimeout
  const prepareTimers = new Map();           // id → prepare setTimeout
  const preparedBundles = new Map();         // bundleLeadId → { hiddenFields, preparedAt }
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

    // re-mede latência ANTES do prepare. O prepare pega o RTT real do
    // momento e ajusta a compensação aplicada lá no setTimeout do fire.
    if (state.scheduler.latency.manualOverride === 0) {
      await refreshLatency();
      // re-agenda o fire com a compensação atualizada
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
      warmupConnection();   // não aguarda — só mantém o socket quente
    }

    // drift correction final
    const drift = target - Date.now();
    if (drift > 0 && drift < 1000) await sleep(drift);

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
      const totalAttacks = bundle.length;
      pushSchedulerLog(`enviado: ${cmd.sourceCoords} → ${cmd.targetCoords} (${cmd.type}, ${totalAttacks} ataque${totalAttacks > 1 ? 's' : ''}) · skew ${skew}ms · rtt=${lat.avgRtt} comp=${compensation}`);
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

    /* wizard (Agendador) */
    .mog-wiz-head {
      display: flex; align-items: center; gap: 12px;
      padding-bottom: 14px; margin-bottom: 16px;
      border-bottom: 1px solid #1f1f1f;
    }
    .mog-wiz-back {
      background: transparent; border: 1px solid #2a2b2b;
      color: #aaa; padding: 6px 12px; border-radius: 6px;
      font-size: 11px; cursor: pointer; font-weight: 600;
    }
    .mog-wiz-back:hover { color: #fafafa; border-color: #3a3b3b; }
    .mog-wiz-title { font-size: 14px; font-weight: 700; color: #fafafa; flex: 1; }
    .mog-wiz-name {
      background: transparent; border: 1px solid transparent;
      color: #fafafa; font-size: 14px; font-weight: 700;
      padding: 4px 8px; border-radius: 5px;
      flex: 1; outline: none; min-width: 200px;
    }
    .mog-wiz-name:hover { background: #1f2020; }
    .mog-wiz-name:focus { background: #1f2020; border-color: ${COLOR_ACCENT}; }
    .mog-wiz-steps { display: flex; gap: 4px; align-items: center; }
    .mog-wiz-step {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #6b6b6b; font-weight: 600;
      padding: 5px 10px; border-radius: 999px;
      background: #1a1b1b; border: 1px solid #2a2b2b;
    }
    .mog-wiz-step.mog-wiz-step-active {
      color: #fff; background: ${COLOR_ACCENT}; border-color: ${COLOR_ACCENT};
    }
    .mog-wiz-step.mog-wiz-step-done { color: #a0a0a0; }
    .mog-wiz-step-num {
      width: 18px; height: 18px; border-radius: 50%;
      background: #2a2b2b; color: #888; font-size: 10px;
      display: inline-flex; align-items: center; justify-content: center;
      font-weight: 700;
    }
    .mog-wiz-step.mog-wiz-step-active .mog-wiz-step-num { background: #fff; color: ${COLOR_ACCENT}; }
    .mog-wiz-step-sep { color: #3a3b3b; font-size: 11px; }

    .mog-wiz-section {
      background: #181919;
      border: 1px solid #232424;
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
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 6px; padding: 10px 12px; color: #e6e6e6;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 12px; line-height: 1.5; outline: none;
      resize: vertical; min-height: 80px;
    }
    .mog-wiz-textarea:focus { border-color: ${COLOR_ACCENT}; }

    .mog-wiz-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
    .mog-wiz-hint { font-size: 11px; color: #6b6b6b; flex: 1; }

    /* tabela de alvos */
    .mog-tg-head, .mog-tg-row {
      display: grid;
      grid-template-columns: 90px 1fr 60px 1fr 50px 50px 50px 36px;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
    }
    .mog-tg-head {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #6b6b6b;
      border-bottom: 1px solid #232424;
    }
    .mog-tg-head > div { text-align: center; }
    .mog-tg-head > div:nth-child(1) { text-align: left; }
    .mog-tg-row {
      background: #141515;
      border: 1px solid #232424;
      border-radius: 8px;
      margin-top: 6px;
    }
    .mog-tg-row.mog-tg-invalid { border-color: #5b2a26; }
    .mog-tg-row .mog-tg-coords {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600; color: ${COLOR_ACCENT};
      font-size: 12.5px;
    }
    .mog-tg-row input[type="datetime-local"] {
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 5px; padding: 6px 8px; color: #e6e6e6;
      font-family: inherit; font-size: 11.5px; outline: none;
      width: 100%; min-width: 0; box-sizing: border-box;
    }
    .mog-tg-row input[type="datetime-local"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-tg-row input[type="number"] {
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 5px; padding: 7px 4px; color: #fafafa;
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
      text-align: center; color: #555; padding: 24px;
      font-size: 12px; font-style: italic;
    }

    .mog-wiz-foot {
      display: flex; gap: 10px; align-items: center;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid #1f1f1f;
    }
    .mog-wiz-foot-spacer { flex: 1; }

    /* lista de operações */
    .mog-op-card {
      background: #181919;
      border: 1px solid #232424;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 10px;
      display: grid;
      grid-template-columns: 1fr 110px auto;
      gap: 14px;
      align-items: center;
    }
    .mog-op-card.mog-op-executing { border-color: ${COLOR_ACCENT}; }
    .mog-op-name { font-size: 13.5px; font-weight: 700; color: #fafafa; }
    .mog-op-meta { font-size: 11px; color: #888; margin-top: 3px; }
    .mog-op-status {
      font-size: 11px; font-weight: 600;
      text-align: center;
      padding: 5px 10px; border-radius: 999px;
      background: #1f2020; color: #aaa;
      text-transform: uppercase; letter-spacing: 0.4px;
    }
    .mog-op-status.mog-op-status-draft { background: #2a2b2b; color: #999; }
    .mog-op-status.mog-op-status-calculated { background: #1d2a3a; color: #6cb3ff; }
    .mog-op-status.mog-op-status-executing { background: ${COLOR_ACCENT}; color: #fff; }
    .mog-op-status.mog-op-status-done { background: #1d3a23; color: #4ade80; }
    .mog-op-status.mog-op-status-aborted { background: #3a1614; color: #ff8a7a; }
    .mog-op-actions { display: flex; gap: 6px; }

    /* lotes (passo 2) */
    .mog-lot {
      background: #181919;
      border: 1px solid #232424;
      border-radius: 10px;
      margin-bottom: 12px;
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
    .mog-lot.mog-lot-open .mog-lot-head { border-bottom-color: #232424; }
    .mog-lot-caret {
      display: inline-block;
      transition: transform 0.15s ease;
      font-size: 10px;
      color: #6b6b6b;
    }
    .mog-lot.mog-lot-open .mog-lot-caret { transform: rotate(90deg); }
    .mog-lot-name {
      background: transparent; border: 1px solid transparent;
      color: #fafafa; font-size: 13px; font-weight: 600;
      padding: 5px 8px; border-radius: 5px;
      width: 100%; outline: none; box-sizing: border-box;
    }
    .mog-lot-name:hover { background: #1f2020; }
    .mog-lot-name:focus { background: #1f2020; border-color: ${COLOR_ACCENT}; }
    .mog-lot-meta {
      font-size: 11px; color: #6b6b6b; text-align: right;
    }
    .mog-lot-type {
      padding: 4px 10px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; text-align: center;
      background: #1f2020; color: #aaa;
    }
    .mog-lot-type.mog-lot-type-attack { background: #3a1614; color: #ff8a7a; }
    .mog-lot-type.mog-lot-type-support { background: #1d3a23; color: #4ade80; }

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
      font-size: 10px; color: #888; text-transform: uppercase;
      letter-spacing: 0.4px; font-weight: 600;
    }
    .mog-lot-import-row {
      display: flex; gap: 8px; align-items: center;
    }
    .mog-lot-import-row select { flex: 1; }
    .mog-lot-import-row button { width: auto; padding: 7px 12px; font-size: 11px; }

    .mog-lot-villages {
      max-height: 100px; overflow-y: auto;
      background: #0e0f0f; border: 1px solid #232424;
      border-radius: 6px; padding: 8px 10px;
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 11px; color: #aaa; line-height: 1.6;
    }
    textarea.mog-lot-villages-edit {
      width: 100%; min-height: 60px;
      box-sizing: border-box;
      resize: vertical;
      outline: none; color: #fafafa;
      white-space: normal;
      word-spacing: 4px;
    }
    textarea.mog-lot-villages-edit:focus { border-color: ${COLOR_ACCENT}; }
    textarea.mog-lot-villages-edit::placeholder {
      color: #555; font-style: italic;
    }
    .mog-lot-villages::-webkit-scrollbar { width: 6px; }
    .mog-lot-villages::-webkit-scrollbar-thumb { background: #2a2b2b; border-radius: 3px; }

    /* waves (comandos por origem→alvo) */
    .mog-wave {
      background: #141515;
      border: 1px solid #232424;
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
      font-size: 9px; color: #6b6b6b; text-transform: uppercase;
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
      border: 1px dashed #3a3b3b;
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
      background: #181919;
      border: 1px solid #232424;
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 14px;
      display: flex; gap: 16px;
      font-size: 11.5px; color: #aaa;
    }
    .mog-cmd-summary strong { color: #fafafa; font-weight: 700; }
    .mog-cmd-summary-pill {
      padding: 3px 10px; border-radius: 999px;
      font-weight: 700; letter-spacing: 0.4px;
      text-transform: uppercase; font-size: 10px;
    }
    .mog-cmd-summary-ok { background: #1d3a23; color: #4ade80; }
    .mog-cmd-summary-warn { background: #3a3014; color: #fbbf24; }
    .mog-cmd-summary-err { background: #3a1614; color: #ff8a7a; }

    .mog-cmd-table {
      background: #141515;
      border: 1px solid #232424;
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .mog-cmd-thead, .mog-cmd-row {
      display: grid;
      grid-template-columns: 24px 90px 90px 1.6fr 60px 70px 110px 70px 110px 30px;
      gap: 6px; align-items: center;
      padding: 8px 10px;
      font-size: 11px;
    }
    .mog-cmd-thead {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #6b6b6b;
      background: #181919;
      border-bottom: 1px solid #232424;
      padding-top: 10px; padding-bottom: 10px;
    }
    .mog-cmd-thead > div { text-align: center; }
    .mog-cmd-thead > div:nth-child(4) { text-align: left; }
    .mog-cmd-row {
      border-top: 1px solid #1f1f1f;
    }
    .mog-cmd-row:first-child { border-top: none; }
    .mog-cmd-row:hover { background: #181919; }
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
      font-size: 10.5px; color: #ccc; text-align: center;
    }
    .mog-cmd-row input[type="number"] {
      width: 100%; box-sizing: border-box;
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 5px; padding: 5px 4px; color: #fafafa;
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
    .mog-cmd-st-ok { background: #1d3a23; color: #4ade80; }
    .mog-cmd-st-late { background: #3a3014; color: #fbbf24; }
    .mog-cmd-st-err { background: #3a1614; color: #ff8a7a; }

    .mog-unreach {
      background: #1d1112; border: 1px solid #3a1614;
      border-radius: 10px; padding: 12px 14px;
      margin-bottom: 14px;
    }
    .mog-unreach-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: #ff8a7a; margin-bottom: 8px;
    }
    .mog-unreach ul { margin: 0; padding-left: 18px; font-size: 11px; color: #ccc; }
    .mog-unreach li { padding: 1px 0; }

    /* passo 4 — confirmar */
    .mog-confirm-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .mog-confirm-stat {
      background: #181919;
      border: 1px solid #232424;
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
      font-size: 10px; color: #6b6b6b;
      text-transform: uppercase; letter-spacing: 0.5px;
      font-weight: 700; margin-top: 4px;
    }
    .mog-confirm-warn {
      background: #3a3014;
      border: 1px solid #fbbf24;
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      display: flex; gap: 12px; align-items: flex-start;
      font-size: 12px; color: #fbbf24;
      line-height: 1.5;
    }
    .mog-confirm-warn-icon { font-size: 18px; flex-shrink: 0; line-height: 1; }
    .mog-confirm-warn strong { color: #fff; }
    .mog-confirm-window {
      background: #181919;
      border: 1px solid #232424;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .mog-confirm-window-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: #888; letter-spacing: 0.5px; margin-bottom: 8px;
    }
    .mog-confirm-window-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 0; font-size: 12px; color: #ccc;
    }
    .mog-confirm-window-row strong {
      color: #fafafa; font-weight: 700;
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
      background: #2a2b2b; color: #6b6b6b; cursor: not-allowed;
      filter: none;
    }

    /* painel de agendamentos (dashboard) */
    .mog-dash-toolbar {
      background: #181919;
      border: 1px solid #232424;
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 14px;
      display: flex; gap: 14px; align-items: center;
    }
    .mog-dash-toolbar-section {
      display: flex; align-items: center; gap: 8px;
      font-size: 11.5px; color: #aaa;
    }
    .mog-dash-toolbar-section strong { color: #fafafa; font-weight: 600; }
    .mog-dash-toolbar-spacer { flex: 1; }
    .mog-dash-toolbar input[type="number"] {
      width: 80px;
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 5px; padding: 6px 8px; color: #fafafa;
      font-size: 11.5px; text-align: center; outline: none;
    }
    .mog-dash-toolbar input[type="number"]:focus { border-color: ${COLOR_ACCENT}; }
    .mog-dash-toggle {
      width: 34px; height: 18px; border-radius: 999px;
      background: #2a2b2b; cursor: pointer; position: relative;
      transition: background 0.15s; flex-shrink: 0;
    }
    .mog-dash-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%; background: #888;
      transition: all 0.15s;
    }
    .mog-dash-toggle.mog-dash-toggle-on { background: ${COLOR_ACCENT}; }
    .mog-dash-toggle.mog-dash-toggle-on::after { left: 18px; background: #fff; }

    .mog-dash-table {
      background: #141515;
      border: 1px solid #232424;
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
      letter-spacing: 0.5px; color: #6b6b6b;
      background: #181919;
      border-bottom: 1px solid #232424;
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
    .mog-dash-type-attack { background: #3a1614; color: #ff8a7a; }
    .mog-dash-type-support { background: #1d3a23; color: #4ade80; }
    .mog-dash-row { border-top: 1px solid #1f1f1f; }
    .mog-dash-row:first-child { border-top: none; }
    .mog-dash-row:hover { background: #181919; }
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
      font-size: 10.5px; color: #ccc; text-align: center;
    }
    .mog-dash-row .mog-dash-countdown {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 700; text-align: center;
      color: #4ade80; font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .mog-dash-row .mog-dash-countdown.mog-dash-soon { color: ${COLOR_ACCENT}; }
    .mog-dash-row .mog-dash-countdown.mog-dash-overdue { color: #888; }
    .mog-dash-row.mog-dash-row-sent { opacity: 0.5; }
    .mog-dash-row.mog-dash-row-failed { background: rgba(255, 138, 122, 0.06); }

    .mog-dash-status {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; padding: 3px 6px; border-radius: 4px;
      text-align: center;
    }
    .mog-dash-st-scheduled { background: #1d2a3a; color: #6cb3ff; }
    .mog-dash-st-confirming { background: #3a3014; color: #fbbf24; }
    .mog-dash-st-sending { background: ${COLOR_ACCENT}; color: #fff; }
    .mog-dash-st-sent { background: #1d3a23; color: #4ade80; }
    .mog-dash-st-failed { background: #3a1614; color: #ff8a7a; }
    .mog-dash-st-aborted { background: #2a2b2b; color: #888; }

    .mog-dash-empty {
      text-align: center; color: #6b6b6b; padding: 40px 16px;
      font-size: 12px; font-style: italic;
      background: #181919;
      border: 1px dashed #2a2b2b;
      border-radius: 10px;
    }

    .mog-dash-history-toggle {
      background: transparent; border: 1px solid #2a2b2b;
      color: #aaa; padding: 8px 14px; border-radius: 7px;
      font-size: 11px; cursor: pointer; font-weight: 600;
      letter-spacing: 0.3px; width: 100%; text-align: center;
      margin-bottom: 14px;
    }
    .mog-dash-history-toggle:hover { color: #fafafa; border-color: #3a3b3b; }

    .mog-lot-unit {
      min-width: 0;
      background: #141515;
      border: 1px solid #232424;
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
      font-size: 9.5px; color: #ccc; font-weight: 600;
      text-align: center; line-height: 1.15;
      min-height: 22px;
      display: flex; align-items: center; justify-content: center;
      letter-spacing: -0.2px;
    }
    .mog-lot-unit-off .mog-lot-unit-name { color: #666; }
    .mog-lot-unit select, .mog-lot-unit input {
      width: 100%; box-sizing: border-box;
      background: #0e0f0f; border: 1px solid #2a2b2b;
      border-radius: 4px; padding: 4px 2px; color: #e6e6e6;
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
      border: 1px dashed #3a3b3b;
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

      <div class="mog-side-section" data-side-section="operations">
        <div class="mog-side-title" data-side-toggle="operations">
          <span class="mog-side-caret">▼</span>
          <span>Operações</span>
        </div>
        <div class="mog-side-items">
          <div class="mog-side-item" data-section="scheduler">
            <span class="mog-side-icon">⏰</span>
            <span>Agendador</span>
          </div>
          <div class="mog-side-item" data-section="dashboard">
            <span class="mog-side-icon">📊</span>
            <span>Painel</span>
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
    if (state.ui.activeSection === 'scheduler' || state.ui.activeSection === 'dashboard') state.scheduler.log = [];
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
    } else {
      renderPlaceholder(state.ui.activeSection);
    }
    renderLog();
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
    const body = content.querySelector('#mog-wiz-body');
    body.innerHTML = `
      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>1. Coordenadas dos alvos</span>
          <span style="color:#6b6b6b;font-weight:400;text-transform:none;letter-spacing:0;">${op.targets.length} cadastrado(s)</span>
        </div>
        <textarea class="mog-wiz-textarea" id="mog-wiz-coords-input"
          placeholder="Cole qualquer texto. Coordenadas no formato 123|456 serão extraídas automaticamente.&#10;Exemplo: 100% de aproveitamento (401|464) K44"></textarea>
        <div class="mog-wiz-row">
          <label style="font-size:11px;color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;">
            <input type="checkbox" id="mog-wiz-dedup" checked> Remover coordenadas duplicadas
          </label>
          <button class="mog-btn mog-btn-ghost" id="mog-wiz-extract" style="width:auto;">Extrair coordenadas</button>
        </div>
      </div>

      <div class="mog-wiz-section">
        <div class="mog-wiz-section-title">
          <span>2. Configuração por alvo</span>
          ${op.targets.length ? '<button class="mog-log-action" id="mog-wiz-clear-targets">Limpar tudo</button>' : ''}
        </div>
        ${op.targets.length === 0 ? `
          <div class="mog-tg-empty">Nenhum alvo cadastrado ainda.</div>
        ` : `
          <div class="mog-tg-head">
            <div>Coordenadas</div>
            <div>Chegada</div>
            <div>Random?</div>
            <div>Até (se random)</div>
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

    body.querySelector('#mog-wiz-extract').addEventListener('click', () => {
      const txt = body.querySelector('#mog-wiz-coords-input').value;
      const dedup = body.querySelector('#mog-wiz-dedup').checked;
      const found = parseCoordsFromText(txt, { keepDuplicates: !dedup });
      if (!found.length) {
        pushSchedulerLog('Nenhuma coordenada válida encontrada no texto colado.');
        return;
      }
      const existing = new Set(op.targets.map(t => t.coords));
      const added = [];
      let skippedDup = 0;
      for (const f of found) {
        if (dedup && existing.has(f.coords)) { skippedDup++; continue; }
        op.targets.push(makeTarget({ coords: f.coords, x: f.x, y: f.y }));
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
    // arrivalAt está em tempo de servidor — exibimos direto (datetime-local interpreta como local,
    // mas tratamos a "hora do servidor" como se fosse a do PC pra UI; só o setTimeout converte).
    const arrival = t.arrivalAt ? toDatetimeLocalString(t.arrivalAt) : '';
    const arrivalTo = t.arrivalRandom?.toAt ? toDatetimeLocalString(t.arrivalRandom.toAt) : '';
    const isRandom = !!t.arrivalRandom;
    return `
      <div class="mog-tg-row" data-tid="${t.id}">
        <div class="mog-tg-coords">${escapeHtml(t.coords)}</div>
        <input type="datetime-local" data-tact="arrival" data-tid="${t.id}" value="${arrival}" ${isRandom ? 'disabled style="opacity:0.4;"' : ''}>
        <div style="text-align:center;">
          <input type="checkbox" data-tact="random" data-tid="${t.id}" ${isRandom ? 'checked' : ''} style="cursor:pointer;">
        </div>
        <input type="datetime-local" data-tact="arrival-to" data-tid="${t.id}" value="${arrivalTo}" ${isRandom ? '' : 'disabled style="opacity:0.4;"'}>
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
    if (act === 'arrival') {
      // O usuário digita pensando no RELÓGIO DO SERVIDOR (que ele vê na tela do TW).
      // Tratamos o timestamp do datetime-local DIRETAMENTE como tempo de servidor,
      // sem conversão. A conversão pra tempo local do PC só acontece em setTimeout.
      t.arrivalAt = e.target.value ? new Date(e.target.value).getTime() : 0;
    } else if (act === 'arrival-to') {
      const toMs = e.target.value ? new Date(e.target.value).getTime() : 0;
      t.arrivalRandom = t.arrivalRandom || { fromAt: t.arrivalAt || 0, toAt: 0 };
      t.arrivalRandom.toAt = toMs;
    } else if (act === 'random') {
      if (e.target.checked) {
        t.arrivalRandom = { fromAt: t.arrivalAt || 0, toAt: 0 };
      } else {
        t.arrivalRandom = null;
      }
    } else if (act.startsWith('count-')) {
      const kind = act.replace('count-', '');
      t.counts[kind] = Math.max(0, parseInt(e.target.value, 10) || 0);
    }
    persist();
    // só re-renderiza se mudou estrutura visual (toggle random)
    if (act === 'random') renderWizardStep1(op);
  }

  function toDatetimeLocalString(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      <div id="mog-wiz-lot-host"></div>

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
                  <label style="font-size:10.5px;color:#aaa;display:flex;align-items:center;gap:5px;cursor:pointer;flex:1;">
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
                <label style="display:flex;align-items:center;justify-content:space-between;">
                  <span>MS de chegada (1º comando)</span>
                  <label style="font-size:10px;color:#aaa;display:flex;align-items:center;gap:5px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:500;">
                    <input type="checkbox" data-lact="ms-random" ${m.firstMsRandom ? 'checked' : ''}> Aleatório
                  </label>
                </label>
                ${m.firstMsRandom ? `
                  <div class="mog-wiz-row" style="margin:0;gap:6px;">
                    <input type="number" class="mog-input" min="0" max="999" data-lact="ms-min" value="${m.firstMsMin}" placeholder="000" title="MS mínimo">
                    <span style="color:#6b6b6b;font-size:11px;flex:0;">a</span>
                    <input type="number" class="mog-input" min="0" max="999" data-lact="ms-max" value="${m.firstMsMax}" placeholder="999" title="MS máximo">
                  </div>
                ` : `
                  <input type="number" class="mog-input" min="0" max="999" data-lact="ms" value="${m.firstMs}" style="text-align:center;">
                `}
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

    card.querySelector('[data-lact="ms"]')?.addEventListener('change', e => {
      sg.model.firstMs = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      e.target.value = sg.model.firstMs;
      persist();
    });

    card.querySelector('[data-lact="ms-min"]')?.addEventListener('change', e => {
      const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      sg.model.firstMsMin = Math.min(v, sg.model.firstMsMax);   // garante min <= max
      e.target.value = sg.model.firstMsMin;
      persist();
    });

    card.querySelector('[data-lact="ms-max"]')?.addEventListener('change', e => {
      const v = Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0));
      sg.model.firstMsMax = Math.max(v, sg.model.firstMsMin);   // garante max >= min
      e.target.value = sg.model.firstMsMax;
      persist();
    });

    card.querySelector('[data-lact="ms-random"]').addEventListener('change', e => {
      sg.model.firstMsRandom = e.target.checked;
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

  function randomMs(model) {
    if (!model.firstMsRandom) return model.firstMs;
    const min = Math.max(0, Math.min(999, model.firstMsMin));
    const max = Math.max(min, Math.min(999, model.firstMsMax));
    return Math.floor(min + Math.random() * (max - min + 1));
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
        const baseMs = randomMs(m);
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
            lastReason = `aldeia ${cand.entry.village.x}|${cand.entry.village.y}: viagem ${Math.round(travel / 60000)}min, sairia ${Math.round((now - executeAt) / 1000)}s no passado`;
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
          <div style="margin-top:6px;font-size:10.5px;color:#ccc;">
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
            <div></div>
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
    const stCls = isLate ? 'mog-cmd-st-late' : 'mog-cmd-st-ok';
    const stLabel = isLate ? 'atraso' : 'ok';

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
    const fmtDate = serverTs => {
      if (!serverTs) return '—';
      // ts está em tempo do servidor; renderizamos como new Date direto pra exibir
      // exatamente o relógio do servidor (assume mesmo fuso horário cliente/servidor)
      const d = new Date(serverTs);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };

    return `
      <div class="mog-cmd-row" data-cid="${c.id}">
        <div><span class="mog-cmd-status ${stCls}">${stLabel}</span></div>
        <div class="mog-cmd-coords">${escapeHtml(c.sourceCoords)}</div>
        <div class="mog-cmd-coords">${escapeHtml(c.targetCoords)}</div>
        <div class="mog-cmd-units">${unitsHtml}</div>
        <div title="${c.distance.toFixed(2)} campos">${c.distance.toFixed(1)}</div>
        <div title="${fmtDur(c.travelMs)}">${fmtDur(c.travelMs)}</div>
        <div class="mog-cmd-arr">${fmtDate(c.arrivalAt)}</div>
        <div><input type="number" min="0" max="999" data-cmd-act="ms" data-cid="${c.id}" value="${c.ms}"></div>
        <div class="mog-cmd-arr">${fmtDate(c.executeAt)}</div>
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
      // recalcula executeAt mantendo o offset entre comandos da mesma origem (soma do índice)
      const offsetWithinSource = c.commandIndexInSource * 100;
      c.ms = v;
      c.executeAt = c.arrivalAt - c.travelMs + v + offsetWithinSource;
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

    const fmtDate = ts => {
      if (!ts) return '—';
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };
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
          ${isExecuting ? '<span style="color:#4ade80;font-weight:700;text-transform:none;letter-spacing:0;">● Operação em execução</span>' : ''}
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
            <div class="mog-confirm-stat-num" style="${overdue ? 'color:#ff8a7a;' : ''}">${ready}</div>
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
              <span style="color:#ff8a7a;">Comandos expirados</span>
              <strong style="color:#ff8a7a;">${overdue}</strong>
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

        <div class="mog-confirm-warn" style="background:#1d2a3a;border-color:#3a82f7;color:#aacaff;">
          <span class="mog-confirm-warn-icon">ℹ</span>
          <div>
            <strong>Mantenha esta aba aberta</strong> e idealmente visível em primeiro plano.
            Navegadores podem suspender timers em abas em segundo plano, prejudicando a precisão dos milissegundos.
          </div>
        </div>

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
        lat.manualOverride = Math.max(1, lat.avgRtt + (lat.extraBuffer ?? 300));
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
    const fmtDate = serverTs => {
      if (!serverTs) return '—';
      const d = new Date(serverTs);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };
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
    if (p.running) {
      return `Executando ${p.running.processed}/${p.running.total}`;
    }
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
  function getActiveLog() {
    if (state.ui.activeSection === 'scheduler' || state.ui.activeSection === 'dashboard') return state.scheduler.log;
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
  // medição inicial de latência ANTES de recover (pra que executeAt seja convertido corretamente)
  (async () => {
    if (state.scheduler.latency.manualOverride === 0) await refreshLatency();
    recoverScheduledCommands();
  })();
})();
