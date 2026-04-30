# Plano — Módulo Farmador (v0.7.0)

## Context

Módulo de **Farm Automatizado** integrado ao Assistente de Saque (premium) nativo do Tribal Wars. Foco em aldeias bárbaras: descobrir, espionar pra registrar no assistente, disparar modelos A/B com timing realista, e detectar quando precisa de "quebra de muralha".

**Pré-requisito do usuário**: precisa ter conta premium com Assistente de Saque ativo. Bot **lê e edita** os modelos A/B do próprio assistente do jogo (não duplica).

**Limitação atual**: só bárbaras. Farm de jogadores inativos fica pra próxima entrega (vai usar `screen=place` com modelos próprios).

**Por que agora**: depois de Recrutador e Agendador maduros, Farmador é a 3ª função mais valiosa pra um jogador competitivo. Reusa muita infra (groups cache, parser de aldeias, scheduler com timers, painel de log).

---

## Decisões de produto (todas validadas com usuário)

- **Sidebar**: nova seção **"Farmador"** (não dentro de "Operações"). Item único.
- **Config global única** (não múltiplos perfis): 1 grupo de aldeias + 1 modelo A + 1 modelo B + 1 par de timing/intervalo/max ataques.
- **Buscar Bárbaras**: usuário define raio em campos (ex: 10). Bot encontra bárbaras nesse raio **partindo de cada origem do grupo**, filtra as que ainda não estão registradas no assistente, troca modelo A temporariamente pra "1 espião", manda 1 espia em cada, restaura modelo A original.
- **Disparo de ataques**: sempre **modelo A**. Se relatório anterior "saque cheio" → dispara **B**. Se "com perdas" → dispara **espião** e marca aldeia como "precisa quebra-muralha" (entrega separada vai cuidar da execução).
- **Max ataques por bárbara**: integer global. Soma todas as origens. Ex: max=2 → no máximo 2 farms simultâneos pra mesma bárbara, independente de quantas origens.
- **Timing entre envios**: range em ms (ex: 500–1000), aleatório dentro do range pra cada envio.
- **Intervalo de verificação**: minutos (ex: 10min). A cada X min, bot relê assistente, decide quem precisa farm, dispara.
- **Detecção de "saque cheio"**: ler ícone do assistente (não relatórios individuais).
- **Sem histórico persistente**: só log "farm iniciado", "espião enviado pra X|Y", "aldeia X|Y marcada pra quebra-muralha".
- **Quebra de muralha**: módulo separado, **fazer DEPOIS**. Por ora, marcar a aldeia e logar.
- **Vive enquanto aba do armazém está aberta** (igual resto do bot).

---

## State shape — `state.farmer`

```js
state.farmer = {
  enabled: false,                     // toggle global do módulo
  groupId: 0,                         // 0 = Todos
  modelA: null,                       // { spear, sword, ..., catapult, knight } — NÃO persiste, sempre lido do jogo
  modelB: null,                       // idem
  timing: { minMs: 500, maxMs: 1000 }, // jitter entre envios
  cycleMin: 10,                       // minutos entre verificações
  maxPerBarbarian: 1,                 // ataques simultâneos por bárbara
  searchRadius: 10,                   // campos pra "Buscar Bárbaras"
  needsWallBreak: [],                 // [{ x, y, lastAttempt }] — aldeias detectadas com defesa, marcadas pra módulo futuro
  log: [],                            // máx 200 entradas
  ui: { collapsed: {} },
  nextRunAt: 0,                       // próxima verificação (timestamp)
};
```

Modelos A/B **vivem no jogo** (Assistente de Saque), só lidos via fetch. Quando usuário edita na UI do bot, faz POST direto pra atualizar o assistente. Cache em memória (não persiste).

---

## Game API — novos métodos

### Ler/escrever modelos do assistente
- `Game.fetchFarmTemplates()` — GET no `/game.php?screen=am_farm` ou `screen=am_farm&mode=manage`. Retorna `{ a: {spear, sword, ...}, b: {spear, sword, ...}, templateIds: { a, b } }`. **Mapear via snippet** (ver Apêndice).
- `Game.updateFarmTemplate(letter, units)` — POST com `template_id` + tropas. **Mapear via snippet**.

### Ler bárbaras conhecidas no assistente
- `Game.fetchFarmAssistantList()` — GET `/game.php?screen=am_farm`. Parsea a tabela de bárbaras: cada linha tem `village_id`, coords, ícone "saque cheio" (sim/não), última visita, contagem de ataques indo. **Mapear via snippet**.

### Disparar farm pelo assistente
- `Game.dispatchFarm({ fromVillageId, targetVillageId, template: 'a'|'b' })` — POST que o assistente faz quando clica no botão A/B da linha. Provavelmente `screen=am_farm&mode=farm&template_id=X&source=Y&target=Z`. **Mapear via snippet** clicando no botão e vendo Network.

### Espiar pelo assistente (truque)
- Usar `dispatchFarm` mas com modelo A previamente trocado pra "1 espião":
  1. Salva modelo A atual em memória
  2. `updateFarmTemplate('a', { spy: 1 })`
  3. Pra cada bárbara nova: `dispatchFarm({ template: 'a', target: X })`
  4. Restaura A original via `updateFarmTemplate`

### Parser de mapa (bárbaras em raio)
- `Game.fetchMapTile(blockX, blockY)` — GET `/map.php?v=2&x=X&y=Y`. Tribal Wars tem endpoint que retorna sectors do mapa em JSON. Cada aldeia tem `village_id`, `name`, `points`, `owner_id` (0 = bárbara).
  - Alternativa: `/game.php?screen=map&x=X&y=Y` (HTML, mais pesado).
  - **Mapear via snippet**.
- `findBarbariansAround(originX, originY, radius)` — itera sectors, retorna bárbaras com `dist <= radius`.

---

## Algoritmo de ciclo (`runFarmerCycle`)

```js
async function runFarmerCycle() {
  if (!state.farmer.enabled) return;
  pushFarmerLog('ciclo iniciado');

  // 1. lê assistente: lista de bárbaras conhecidas com status
  const list = await Game.fetchFarmAssistantList();
  // list = [{ villageId, coords, x, y, fullLoot, sentAttacks, lastReportLoss }]

  // 2. lê grupo de origens
  const origins = await Game.fetchGroupVillages(state.farmer.groupId);

  // 3. pra cada origem do grupo (em ordem):
  for (const origin of origins) {
    if (!state.farmer.enabled) break;

    // 4. pra cada bárbara conhecida:
    for (const target of list) {
      if (!state.farmer.enabled) break;
      if (target.sentAttacks >= state.farmer.maxPerBarbarian) continue;

      // 4a. decide modelo A vs B vs spy
      let template = 'a';
      if (target.lastReportLoss) {
        // perdas → spia + marca pra quebra-muralha
        template = 'a';
        await updateFarmTemplateForSpy();   // troca A pra "1 espião"
        await Game.dispatchFarm({ fromVillageId: origin.id, targetVillageId: target.villageId, template });
        await restoreFarmTemplateA();
        markForWallBreak(target);
        continue;
      }
      if (target.fullLoot) template = 'b';

      // 4b. dispara
      try {
        await Game.dispatchFarm({ fromVillageId: origin.id, targetVillageId: target.villageId, template });
        target.sentAttacks++;     // local; servidor atualiza no próximo fetch
        pushFarmerLog(`farm ${template.toUpperCase()}: ${origin.name} → ${target.coords}`);
      } catch (e) {
        pushFarmerLog(`falha: ${origin.name} → ${target.coords}: ${e.message}`);
      }

      // 4c. timing realista
      await sleep(randomInRange(state.farmer.timing.minMs, state.farmer.timing.maxMs));
    }
  }

  pushFarmerLog('ciclo finalizado');
  scheduleFarmerNext();
}

function scheduleFarmerNext() {
  if (!state.farmer.enabled) return;
  const delay = state.farmer.cycleMin * 60 * 1000;
  state.farmer.nextRunAt = Date.now() + delay;
  setTimeout(runFarmerCycle, delay);
}
```

---

## Algoritmo: Buscar Bárbaras (`findNewBarbarians`)

```js
async function findNewBarbarians() {
  pushFarmerLog('buscando bárbaras...');
  const radius = state.farmer.searchRadius;
  const origins = await Game.fetchGroupVillages(state.farmer.groupId);
  const known = await Game.fetchFarmAssistantList();
  const knownIds = new Set(known.map(b => b.villageId));

  // 1. coleta candidatos partindo de cada origem
  const candidates = new Map(); // villageId → { x, y }
  for (const origin of origins) {
    const found = await Game.findBarbariansAround(origin.x, origin.y, radius);
    for (const v of found) {
      if (knownIds.has(v.villageId)) continue;
      candidates.set(v.villageId, v);
    }
  }
  pushFarmerLog(`encontrei ${candidates.size} bárbara(s) nova(s)`);

  if (candidates.size === 0) return;

  // 2. salva modelo A atual e troca pra "1 espião"
  const templates = await Game.fetchFarmTemplates();
  const originalA = templates.a;
  await Game.updateFarmTemplate('a', { spy: 1 });
  pushFarmerLog('modelo A trocado pra 1 espião');

  // 3. envia 1 espia pra cada candidato (a partir de qualquer origem do grupo)
  let dispatched = 0;
  const originList = origins.slice();
  for (const [villageId, v] of candidates) {
    const origin = originList[dispatched % originList.length];   // round-robin entre origens
    try {
      await Game.dispatchFarm({ fromVillageId: origin.id, targetVillageId: villageId, template: 'a' });
      dispatched++;
      pushFarmerLog(`espia: ${origin.name} → ${v.x}|${v.y}`);
    } catch (e) {
      pushFarmerLog(`falha espia: ${origin.name} → ${v.x}|${v.y}: ${e.message}`);
    }
    await sleep(randomInRange(state.farmer.timing.minMs, state.farmer.timing.maxMs));
  }

  // 4. restaura modelo A
  await Game.updateFarmTemplate('a', originalA);
  pushFarmerLog(`modelo A restaurado. ${dispatched} espia(s) enviada(s).`);
}
```

---

## UI — tela "Farmador"

**Sidebar**: adicionar item `data-section="farmer"` em nova seção colapsável "Saque" (ou seção própria).

**Roteamento**: `renderContent()` → `renderFarmer()` quando `activeSection === 'farmer'`.

### Layout da tela:

```
┌─ Farmador ──────────────────────────────────────────┐
│ [TOGGLE: ATIVO/PAUSADO]    Próx. ciclo: em 7min      │
├──────────────────────────────────────────────────────┤
│ CONFIGURAÇÕES                                        │
│ Grupo de aldeias: [Todos ▼]                          │
│ Intervalo entre verificações: [10] min               │
│ Tempo entre envios:           [500] a [1000] ms      │
│ Ataques máx. por bárbara:     [1]                    │
├──────────────────────────────────────────────────────┤
│ MODELO A                          [SALVAR NO JOGO]   │
│ [grade horizontal de unidades — só count]            │
│                                                       │
│ MODELO B                          [SALVAR NO JOGO]   │
│ [grade horizontal de unidades — só count]            │
├──────────────────────────────────────────────────────┤
│ BUSCAR NOVAS BÁRBARAS                                │
│ Raio de busca: [10] campos     [BUSCAR]              │
├──────────────────────────────────────────────────────┤
│ ALDEIAS COM PERDAS (precisam quebra-muralha)         │
│ • 401|464  detectada às 14:30                        │
│ • 405|468  detectada às 15:12                        │
└──────────────────────────────────────────────────────┘
```

CSS reuso: `.mog-prow`, `.mog-input`, `.mog-select`, `.mog-tg`, `.mog-btn`, `.mog-section-head`, `.mog-lot-units-grid` (pras grades de unidades).

### Funções de render:
- `renderFarmer()` — root, monta a tela
- `renderFarmerToggle()` — toggle ATIVO/PAUSADO + countdown próximo ciclo
- `renderFarmerConfig()` — bloco de config (grupo, intervalo, timing, max)
- `renderFarmerTemplates()` — modelos A e B com grades de unidades + botão "Salvar no jogo"
- `renderFarmerSearch()` — bloco "Buscar Bárbaras" com input de raio + botão
- `renderFarmerWallBreak()` — lista de aldeias marcadas (só readonly por enquanto)

---

## Migração

```js
// VERSION = '0.7.0'

// DEFAULT_STATE adiciona:
farmer: {
  enabled: false,
  groupId: 0,
  timing: { minMs: 500, maxMs: 1000 },
  cycleMin: 10,
  maxPerBarbarian: 1,
  searchRadius: 10,
  needsWallBreak: [],
  log: [],
  ui: { collapsed: {} },
  nextRunAt: 0,
},

// migrateState: se !parsed.farmer, cria default. Tabela CLAUDE.md ganha v5 (0.7.0):
// "Adiciona state.farmer (toggle, config, log, lista de wall-break). Modelos A/B vivem no jogo."
```

---

## Pontos de risco / checklist

1. **Endpoint do `am_farm` muda entre versões/mundos** — confirmar via snippet ANTES de codar `Game.dispatchFarm`.
2. **CSRF do assistente** pode ser diferente do `game_data.csrf` global. Snippet vai revelar.
3. **Race condition ao trocar modelo A** durante "Buscar Bárbaras": se um ciclo de farm normal disparar no meio, vai usar modelo A errado. **Mitigar**: lock global `state.farmer.busy = true` durante operações críticas; ciclo pula se busy.
4. **Parser de mapa**: `/map.php?v=2` retorna sectors, mas formato pode variar. Snippet vai mostrar.
5. **Detecção de bárbara**: `owner_id === 0` ou nome `"Aldeia de bárbaros"`? Confirmar.
6. **Detecção de "saque cheio" / "com perdas"**: ícones específicos no assistente (`<img title="..." class="...">`). Snippet vai revelar as classes.
7. **Aldeia bárbara sumindo do mapa** (jogador conquista durante ciclo): tratar 404 do `dispatchFarm` como skip silencioso.
8. **`maxPerBarbarian` — soma global ou por origem?** Decidido: **soma global** (independente de origem).
9. **Aldeia origem sem tropas**: `dispatchFarm` retorna erro "tropas insuficientes" — tratar como skip silencioso e continuar próxima.
10. **Persistência durante ciclo**: ciclo é demorado (pode levar minutos). Salvar `state.farmer.busy` pra recovery se aba fechar.

---

## Implementação incremental — 7 entregas testáveis

| # | Entrega | Toca | Compl. | Depende |
|---|---------|------|--------|---------|
| 1 | **Esqueleto + state + sidebar** | `DEFAULT_STATE.farmer`, `migrateFarmer`, sidebar nova seção "Saque" com item "Farmador", `renderContent` rota, `renderFarmer` placeholder, VERSION 0.7.0 | S | — |
| 2 | **Mapear telas via snippets** | Pedir usuário rodar 4 snippets: (a) GET `screen=am_farm` parsea tabela de bárbaras + ícones, (b) inspeção do form de salvar template A/B, (c) Network tab clicando "Atacar A" pra ver POST do dispatch, (d) GET `/map.php?v=2&x=X&y=Y` formato. **Bloqueante**. | M | — |
| 3 | **Game API farm + parsers** | Implementa `fetchFarmAssistantList`, `fetchFarmTemplates`, `updateFarmTemplate`, `dispatchFarm` baseado nos snippets. Parsers de tabela/ícones. | L | 1, 2 |
| 4 | **UI de configuração + edição de modelos** | `renderFarmerConfig`, `renderFarmerTemplates` (grade de unidades pra A e B), botão "Salvar no jogo" que faz `updateFarmTemplate`. Sem ciclo automatizado ainda. | M | 3 |
| 5 | **Ciclo de farm (modelo A/B + perdas)** | `runFarmerCycle`, `scheduleFarmerNext`, lógica A/B/spy + perdas. Botão "Executar agora" pra teste manual. | L | 4 |
| 6 | **Parser de mapa + Buscar Bárbaras** | `Game.fetchMapTile`, `findBarbariansAround`. `findNewBarbarians` com troca temporária de modelo A. UI de busca. | M | 3 |
| 7 | **Polimento + CLAUDE.md** | Lista de wall-break (readonly), busy lock, recovery, log limpo, atualização CLAUDE.md (tabela migrações + decisões + apêndice de snippets do am_farm) | S | 5, 6 |

**Bloqueante antes do passo 3**: rodar os snippets do passo 2 e colar respostas. Sem isso `Game.dispatchFarm` fica chutado e falha.

---

## Verificação end-to-end

- Após #1: aba "Saque > Farmador" abre, mostra "Em construção".
- Após #3: console mostra `await Game.fetchFarmAssistantList()` retornando array de bárbaras.
- Após #4: editar modelo A na UI, clicar "Salvar no jogo", abrir o assistente do jogo manualmente — modelo A bate.
- Após #5: ativar farmer, esperar 1 ciclo, ver logs "farm A: aldeia X → Y|Z". Verificar no jogo (Comandos) que os ataques saíram.
- Após #6: clicar "Buscar bárbaras" com raio 10. Ver no log "encontrei N bárbaras", "espia: X → Y", "modelo A restaurado". Conferir no assistente do jogo se as bárbaras novas apareceram registradas.
- Após #7: ativar farmer com max=2, ciclo 5min. Deixar rodando 30min. Conferir que cada bárbara não recebe mais que 2 farms por vez. Conferir que aldeia que voltar com perdas vira spia + entra na lista de wall-break.

---

## Apêndice — snippets pra usuário rodar (entrega #2)

### Snippet 1 — Tabela de bárbaras do assistente
```js
(async () => {
  const html = await (await fetch('/game.php?village=' + game_data.village.id + '&screen=am_farm', { credentials: 'include' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // procura tabela com bárbaras
  const tables = [...doc.querySelectorAll('table')].filter(t => /\(\d{1,3}\|\d{1,3}\)/.test(t.textContent) && t.querySelectorAll('tr').length > 2);
  const out = [];
  out.push('total tabelas com coords: ' + tables.length);
  if (tables[0]) {
    out.push('tabela id="' + tables[0].id + '" classes="' + tables[0].className + '"');
    out.push('exemplo de linha (1ª bárbara):');
    const rows = [...tables[0].querySelectorAll('tr')].filter(tr => /\(\d{1,3}\|\d{1,3}\)/.test(tr.textContent));
    if (rows[0]) out.push(rows[0].outerHTML.slice(0, 1500));
  }
  alert(out.join('\n'));
})();
```

### Snippet 2 — Form de modelo A/B
```js
// abrir am_farm e clicar em "Editar modelos" ou similar; depois rodar:
const forms = [...document.forms].filter(f => /am_farm/.test(f.action || ''));
console.log('forms:', forms.length);
forms.forEach((f, i) => console.log(i, f.action, [...f.querySelectorAll('input,select')].map(x => `${x.name}=${x.value}`)));
```

### Snippet 3 — POST de disparar farm (Network tab)
- Abrir DevTools → Network → filtrar XHR
- Clicar no botão **A** (atacar) de qualquer linha de bárbara no assistente
- Achar a request que dispara — provavelmente `am_farm&mode=farm&...`
- Copiar URL completa, headers e form-data e colar pro Claude.

### Snippet 4 — Mapa em raio (sectors)
```js
fetch('/map.php?v=2&x=' + game_data.village.x + '&y=' + game_data.village.y, { credentials: 'include' })
  .then(r => r.text())
  .then(t => {
    console.log('length:', t.length);
    console.log('first 500:', t.slice(0, 500));
    try { const j = JSON.parse(t); console.log('JSON keys:', Object.keys(j)); } catch { console.log('não é JSON puro'); }
  });
```
Se snippet 4 não retornar JSON utilizável, alternativa: parsear `screen=map` HTML ou usar `/interface.php?func=get_villages` (se existir nesse mundo).

### Snippet 5 — Detecção de "saque cheio" e "com perdas"
- Numa linha de bárbara que **voltou com saque cheio**, inspecionar o ícone do camelo (`<img>` ou span com class). Anotar a class/title.
- Numa linha que **voltou com perdas**, inspecionar o ícone vermelho. Anotar a class/title.
- Sem isso, parser do `fetchFarmAssistantList` não consegue distinguir.

---

## Arquivos críticos

- **c:\Projetos\MogScripts\Mog.user.js** — toda a implementação. Crescimento esperado: ~4200 → ~5500 linhas.
- **c:\Projetos\MogScripts\CLAUDE.md** — atualizar seção 3 (tabela migrações v5), seção 4 (decisões do farmer), seção 8 (remover Farm do roadmap), apêndice (snippets do am_farm).

---

## Notas pro próximo Claude

- **Reuso**: `getGroups()`, `Game.fetchGroupVillages()`, `pushSchedulerLog`-like (criar `pushFarmerLog`), CSS classes `.mog-prow`/`.mog-lot-units-grid`/etc, `humanLikeDelay`, `randomInRange`.
- **Padrão de scheduler**: o farmer é um **único timer global** (não per-profile como recruiter, nem per-comando como agendador). Mais simples — só `scheduleFarmerNext` + `setTimeout` armazenado em `farmerTimerId`.
- **Lock de busy**: enquanto `runFarmerCycle` ou `findNewBarbarians` rodam, `state.farmer.busy = true`. Outros ticks pulam. Persistir o lock pra recovery limpar se a aba fechou no meio.
- **Modelos A/B nunca persistem no state** — sempre lidos do jogo. Cache em memória local da função.
- **Status no jogo é a fonte da verdade**: `target.sentAttacks` vem do assistente, não do nosso state. Reler a cada ciclo.
- **Quebra de muralha** vai precisar de outro módulo. Por ora, marcar `state.farmer.needsWallBreak.push({x, y, lastAttempt: Date.now()})`.
- **Snippets do passo 2 são bloqueantes**: o usuário roda no console e cola o output. Sem isso, `dispatchFarm` chuta URL/body e falha. **Não codar #3 sem ter feito #2.**
