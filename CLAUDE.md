# Mog Scripts — guia para o Claude

Userscript pessoal de automação para o jogo **Tribal Wars** (br142.tribalwars.com.br). Toolkit que o usuário roda via Tampermonkey/Violentmonkey no próprio navegador, sem backend.

---

## 1. Restrições essenciais (leia antes de codar)

- **Single-file**: todo o código vive em `Mog.user.js`. Não criar build step, módulos, `package.json` ou qualquer dependência externa. Tudo é vanilla JS rodando dentro do browser com `// @grant GM_*`.
- **Só inicializa em `screen=storage`**: o IIFE faz early-return se `unsafeWindow.game_data.screen !== 'storage'`. O usuário gerencia tudo na aba do armazém; ela faz fetches HTTP em background pras outras aldeias. Em qualquer outra tela o script nem carrega o launcher.
- **Persistência**: `GM_setValue/GM_getValue` com chave `mog_state_v1` (mantida fixa mesmo após mudanças de schema — usar `migrateState` pra acomodar formatos antigos).
- **Privado, sem servidor**: nada de telemetria, analytics, fetch para domínios externos. Toda comunicação é pra `*.tribalwars.com.br` (mesma origem).
- **Idioma da UI**: pt-BR. Strings visíveis ao usuário sempre em português.
- **Versão atual**: ver `@version` no banner do userscript e a constante `VERSION`. Bump em mudança visível ao usuário; manter os dois sincronizados.

---

## 2. Domínio do jogo (Tribal Wars)

Termos usados no código e nas conversas com o usuário:

- **Aldeia (village)**: unidade básica do jogador. Tem ID numérico (`village_id`). Cada conta tem várias.
- **Grupo de aldeias (group)**: agrupamento criado pelo jogador (ex: "Ofensivas", "Defensivas"). Tem ID. Grupo `0` no nosso código é a entrada sintética **"Todos"** (todas as aldeias do jogador, sem filtro). No jogo, grupos reais começam em IDs > 0.
- **Tropas/Unidades**:
  - `UNITS` (10): unidades **recrutáveis** via train.php — Lanceiro, Espadachim, Bárbaro, Arqueiro, Explorador, Cavalaria Leve, Arq. à Cavalo, Cavalaria Pesada, Aríete, Catapulta.
  - `COMMAND_UNITS` (12): unidades **enviáveis** via screen=place — `UNITS` + Paladino + Nobre. Usado pelo Agendador.
- **Edifícios de tropa**: Quartel (lança/espada/bárbaro/arqueiro), Estábulo (explorador/leve/marcher/pesada), Oficina (aríete/catapulta).
- **Fila (queue)**: cada edifício pode ter múltiplas filas ativas em paralelo. A "fila ativa" é uma ordem de recrutamento em andamento. Limite configurado pelo usuário via "Filas máx." por edifício.
- **Recrutamento (per queue)**: quantas unidades cada nova fila adiciona ao recrutar (ex: "Recrutamento = 5" → cada vez que abre uma vaga de fila, recruta 5).
- **Modelo (profile)**: configuração do recrutador, com grupo + alvos por unidade + intervalos + filas/recrutamento por edifício.
- **Operação (Agendador)**: conjunto de alvos + origens + comandos calculados, em rascunho ou já agendado pra envio.
- **Wave**: cada wave dentro de uma operação representa **1 comando** que sai por par origem→alvo. Ex: 2 waves = "ataque #1" + "ataque adicional #2" no mesmo POST do jogo.
- **Bundle**: comandos com mesmo `sourceEntryId + targetCoords` formam um bundle — saem juntos num único POST com `train[N][unit]` pros adicionais.

---

## 3. Arquitetura

`Mog.user.js` é organizado em seções verticalmente, top-to-bottom:

1. **Banner UserScript** — `@match`, `@grant`, `@version`
2. **Early-return** — só roda em `screen=storage`
3. **Constantes** — `UNITS`, `COMMAND_UNITS`, `BUILDINGS`, `GROUP_ALL`, `CATAPULT_TARGETS`, `DEFAULT_WORLD_CONFIG`, `DEFAULT_LATENCY`
4. **Factories** — `makeProfile`, `makeOperation`, `makeTarget`, `makeWave`, `makeAttackModel`, `makeSourceGroup`, `makeCommand`
5. **Storage / Migrations** — `loadState`, `migrateState`, `migrateProfile`, `migrateScheduler`, `migrateOperation`, `migrateSourceGroup`, `saveState`
6. **Game API** — `Game.{csrf, fetchGroups, fetchAllVillages, fetchGroupVillages, _fetchVillagesPaged, fetchTrainData, submitRecruit, prepareCommand, confirmCommand, submitCommand, _readPlaceCsrf, fetchWorldConfig, fetchAllUnits}`
7. **Parsers** — `parseVillagesFromOverview`, `parseTrainQueue`, `parseAllUnitsTable`, `parseWorldConfig`, `parseCoordsFromText`
8. **Engine recrutamento** — `pushLog`, `computeRecruitForVillage`, `runProfileCycle`, `humanLikeDelay`
9. **Engine agendador** — `distance`, `slowestSpeed`, `travelTimeMs`, `ensureWorldConfig`, `solveOperation`, `resolveUnits`, `randomMs`, `kindMatchesType`
10. **Latência** — `measureLatency`, `refreshLatency`, `latencyCompensation`, `serverOffset`/`serverNow`/`serverToLocalTs`, `warmupConnection`
11. **Scheduler recrutamento** — timers per-profile (`scheduleProfileNext`, etc)
12. **Scheduler agendador** — `commandTimers`, `prepareTimers`, `preparedBundles`, `scheduleCommand`, `prepareForFire`, `executeCommand`, `cancelCommand`, `recoverScheduledCommands`, `getBundleSiblings`, `getAllScheduledCommands`, `maybeFinalizeOperation`, `activateOperation`
13. **Groups cache** — `getGroups`
14. **UI** — `GM_addStyle` → DOM (launcher/overlay/panel) → render funcs:
    - **Roteamento**: `renderContent` (recruiter | scheduler | dashboard | placeholder)
    - **Recruiter**: `renderRecruiter`, `renderProfileRow`, `renderAdvanced`, `bindProfileRow`
    - **Scheduler (wizard)**: `renderScheduler`, `getOrCreateDraftOperation`, `resetDraftOperation`, `renderOpWizard`, `renderWizardStep1..4`, `renderTargetRow`, `onTargetChange`, `renderLotInline`, `renderWaveRow`, `bindLotCard`, `populateLotGroupSelect`, `importLotFromGroup`, `addVillagesByCoords`, `syncVillagesFromTextarea`, `solveOperation`, `renderResultBlock`, `renderCmdRow`
    - **Dashboard**: `renderDashboard`, `renderDashTable`, `renderDashRow`, `coordsLink`, `formatCountdown`, `updateDashCountdowns`, `dashboardSignature`, `findCommandById`

### State shape (atual — schema "v4", chave de storage ainda `mog_state_v1`)

```js
{
  enabled: false,                          // toggle global do recrutador
  ui: {
    activeSection: 'recruiter',            // 'recruiter' | 'scheduler' | 'dashboard' | 'builder' | 'research'
    expandedProfileId: null,
    panelOpen: false,
    logCollapsed: false,
    sideCollapsed: { account: bool, operations: bool, tools: bool },
  },
  recruiter: {
    profiles: [{
      id, name, enabled, groupId, intervalMin, intervalMax,
      units: { spear: { enabled, target }, ... },
      buildings: { Quartel: { perQueue, maxQueues }, ... },
      rrCursor: { Quartel: 0, ... },
      nextRunAt,
    }],
    log: [],   // máx 200
  },
  scheduler: {
    operations: [{
      id, name, status: 'draft'|'executing'|'done'|'aborted',
      step, createdAt, activatedAt, finishedAt,
      targets: [{ id, coords, x, y, arrivalAt, arrivalRandom, counts:{attack,support,noble}, notes }],
      sourceGroups: [{                  // sempre EXATAMENTE 1 (lote único)
        id, label, rawText, importGroupId,
        villages: [{ entryId, villageId, name, x, y }],
        model: {
          type: 'attack'|'support',
          catapultTarget: 'farm'|...,
          firstMs, firstMsRandom, firstMsMin, firstMsMax,
          waves: [{ id, units: { spear: { enabled, mode: 'all'|'percent'|'count', value }, ... } }],
        },
      }],
      commands: [{                       // gerado pelo solver
        id, targetId, sourceEntryId, sourceVillageId, sourceCoords, targetCoords,
        slotKind, commandIndexInSource, type, catapultTarget,
        units, slowestSpeedMpf, distance, travelMs, arrivalAt, ms, executeAt,
        status: 'pending'|'scheduled'|'confirming'|'sending'|'bundled'|'sent'|'failed_request'|'failed_overdue'|'aborted',
        attempts, lastError, serverResponse,
      }],
      unreachable: [{ targetId, slotKind, reason }],
    }],
    worldConfig: { fetchedAt, unitSpeed, speedFactor, unitSpeedFactor },
    latency: { avgRtt, avgOffset, manualOverride, measuredAt, samples, extraBuffer },
    log: [],   // máx 500
    ui: { activeOperationId, wizardStep },
  },
}
```

`profile.running` (recrutador), `commandTimers/prepareTimers/preparedBundles` (agendador) são transitórios — não persistem.

### Migrações de schema

| Versão | Mudança | Como migrar |
|--------|---------|-------------|
| v1 (0.1.x) | `recruiter` era objeto único | `migrateState` cria profile "Modelo principal" |
| v2 (0.2.0) | Introduz `recruiter.profiles[]` | `profiles.map(makeProfile)` |
| v3 (0.5.0) | `units[id]` perde `perQueue/maxQueues`; surge `buildings[name]` + `rrCursor` | `migrateProfile` agrupa valores por edifício |
| v4 (0.6.0) | Adiciona `state.scheduler` com operações, comandos, world config cache, latency, log próprio. State v3 sem scheduler vira default vazio | `migrateState` chama `migrateScheduler(parsed.scheduler)` que cria default se ausente |

**Sempre que mudar o shape, adicionar uma linha aqui e código de migração.** Nunca quebrar usuários antigos.

---

## 4. Decisões já tomadas (não revisitar sem motivo)

### Geral
- **Paleta**: `#121313` (base) + `#FF6044` (accent). Constantes `COLOR_BG`, `COLOR_ACCENT`.
- **Layout**: painel horizontal sobreposto centralizado (`min(1180px, 100vw - 80px)`), grid 2x2. Launcher lateral esquerdo.
- **Sidebar**: 3 seções colapsáveis — "Gerente de Conta" (Construtor*/Recrutamento/Pesquisa*), "Operações" (Agendador/Painel), "Ferramentas" (Configurações*). Itens com asterisco têm badge "Em breve".
- **Spinners de input number escondidos** (cross-browser CSS).
- **Naming CSS**: prefixo `.mog-` em todas as classes pra não colidir com o CSS do jogo.

### Recrutador
- **Modelos independentes**: cada profile tem scheduler próprio, toggle ON/OFF, cursor de round-robin.
- **Round-robin por edifício, 1 vaga por ciclo**: ver seção 5.
- **Jitter realista entre aldeias**: `humanLikeDelay()` com 80% 1–3s, 17% 8–15s, 3% 20–40s.
- **Parser de fila**: `tbody#trainqueue_<barracks|stable|garage>` → cada `tr.sortable_row` é uma fila ativa. Não usar `.lit-item` ou `table.train_list` — quebrado nesta versão.
- **Auto-enable por edição**: editar o "alvo" (`>0`) já marca a unidade como `enabled`.

### Agendador
- **Sem lista de operações**: o usuário entra em "Agendador" e cai direto no wizard step 1. `getOrCreateDraftOperation()` retoma rascunho ou cria novo.
- **Lote único**: cada operação tem **exatamente 1** sourceGroup (`ensureSingleSourceGroup`). UI inline, sem cards de lote.
- **Pareamento**: "mais próxima primeiro" — pra cada slot do alvo, ordena origens por distância e usa a mais próxima ainda não usada. Uma aldeia origem cadastrada N vezes atende N slots.
- **Auto-envio**: bot dispara POSTs no horário calculado. Sem envio manual.
- **Pré-confirmação 10s antes**: o passo 1 (`try=confirm`) roda 10s antes do horário, e o passo 2 (`action=command`) no horário exato — minimiza tempo de envio crítico.
- **Bundles num único POST**: se o profile tem 2 waves, é **1 POST só** com `train[2][unit]` pros adicionais (não 2 POSTs separados). Servidor adiciona +100ms por padrão entre waves.
- **Tempos em "horário do servidor"**: `arrivalAt`, `executeAt` são interpretados como tempo do servidor TW (não do PC do usuário). Conversão pra tempo local só no `setTimeout`. Display assume mesmo fuso horário cliente↔servidor (TW BR e PC do usuário ambos em -03:00).
- **Compensação de latência**: medida a cada 5s. Aplicada como `rtt + extraBuffer (default 300ms)` ou override manual. Painel tem toggle "Ping automático" pra alternar entre auto e manual.
- **Warm-up TCP** 150ms antes do envio real (mantém socket quente, evita slow-start).
- **Velocidade das unidades**: `<speed>` retornado por `/interface.php?func=get_unit_info` **já vem ajustado** pelos fatores `speed`/`unit_speed` do mundo. NÃO multiplicar/dividir por nada. Fórmula: `duration_ms = mpf × distance × 60 × 1000`.
- **CSRF do `screen=place`**: o nome do input hidden muda a cada sessão. `Game._readPlaceCsrf` faz GET inicial, lê o input hidden cujo nome não bate com nenhum dos conhecidos, e cacheia. O campo `h` (CSRF normal) é injetado por JS após o load — usar `Game.csrf()` (= `unsafeWindow.game_data.csrf`) como fallback.
- **Coords clicáveis no Painel**: `<a href="info_village?id=X#x;y" target="_blank">`. Usa `villageId` quando disponível (origens), senão fallback.

---

## 5. Algoritmo de recrutamento (`computeRecruitForVillage`)

Pra cada edifício do profile:
1. Conta `activeQueues` (filas ativas naquele edifício).
2. Se `activeQueues >= maxQueues` → pula.
3. Lista unidades **elegíveis**: `enabled && target > 0 && existing + inQueue < target`.
4. Pega a próxima elegível começando do `rrCursor[building]`. Pula unidades que atingiram alvo.
5. Recruta `min(perQueue, target - existing - inQueue)` da unidade escolhida (= **1 vaga por ciclo**).
6. Avança `rrCursor[building]`.

**Por que 1 vaga por ciclo**: cada execução abre 1 nova fila; o intervalo entre execuções controla o ritmo. Mais humano que encher tudo de uma vez.

---

## 5b. Algoritmo do Agendador (`solveOperation`)

1. **Flatten slots**: pra cada alvo, gera `counts.attack + .support + .noble` slots em ordem de cadastro. Resolve `arrivalAt` (sorteia se range).
2. **Flatten pool**: `sourceGroups[0].villages` × N entries. Cada entry atende 1 slot.
3. **Fetch tropas atuais** via `Game.fetchAllUnits(0)` (1 GET coletivo na tela `mode=units&group=0`).
4. **Pra cada slot** (ordem de cadastro):
   - Filtra pool: `!used && tipoCompatível(slot.kind, model.type)`.
   - Ordena candidatos por distância.
   - Pra cada candidato: `resolveUnits(wave, available)` (modos `all`/`percent`/`count`); modo `count` rejeita unidade se `have < value`. Se wave 1 zera, descarta candidato.
   - Calcula `slowestSpeed`, `travelTimeMs`, `executeAt = arrivalAt - travel + ms`. Se `executeAt < now - 2s`, descarta.
   - Aceita o primeiro viável → marca `used` → emite **N comandos** (1 por wave), MS = base + k×100.
5. Slots sem candidato vão pra `unreachable`.

**Modo `count` é tudo-ou-nada**: se aldeia tem 800 mas usuário pediu 1000, descarta a unidade (não envia 800 parcial).

---

## 5c. Pipeline de envio do Agendador (timeline)

Pra cada lead command (commandIndexInSource = 0):

1. **T-10s** (`prepareForFire`): re-mede latência, faz POST `screen=place&try=confirm` (etapa 1), guarda `{ch, h, hiddenFields}` em `preparedBundles[cmd.id]`. Status: `scheduled` → `confirming` → de volta a `scheduled`.
2. **T-150ms** (no `executeCommand`): `warmupConnection()` — HEAD curto pra manter socket TCP quente.
3. **T-rtt** (drift correction final): aguarda exatamente o instante alvo no relógio local.
4. **T**: dispara POST `screen=place&action=command` com hashes do passo 1 + `train[N][unit]` pros bundles. Status: `sending` → `sent`/`failed_request`.

**Bundle siblings**: comandos com `commandIndexInSource > 0` ficam em status `bundled`, não têm timer próprio. Quando o lead envia, todos do bundle viram `sent` juntos no mesmo POST.

**Recovery na inicialização** (`recoverScheduledCommands`):
- Status `sending` interrompido → `failed_request` ("interrompido durante envio").
- Status `pending`/`scheduled`/`confirming`/`bundled` → re-agenda via `scheduleCommand` (que filtra leads vs bundled).

---

## 6. Convenções de código

- **Comentários**: só onde o "porquê" não é óbvio. Não comentar "o quê".
- **Sem error handling defensivo gratuito**: confiar em `game_data.csrf`, em `groups[]` ter elementos. Validar só nas fronteiras.
- **Sem refactor oportunista**: bug fix conserta o bug. Se quiser refatorar, alinhar antes.
- **Não adicionar libs**: vanilla DOM + fetch.
- **Pt-BR**: tudo que vai pra UI em português.
- **Commits direto na branch** (`claude/tribal-wars-bot-*`). Não abrir PR. Mensagem em pt-BR, foca no porquê.

---

## 7. Pedir antes de fazer

- **Antes de mexer em parser de HTML do jogo** → pedir snippet no console e colar output (ver Apêndice A).
- **Antes de adicionar feature visível** → propor 1–2 abordagens com tradeoffs.
- **Antes de mudar shape do state** → confirmar migração + atualizar tabela seção 3.
- **Antes de mudar regra de recrutamento ou pareamento do solver** → exemplo concreto e validação.
- **Antes de adicionar mitigação anti-detecção** → trade-off com usuário.
- **Antes de mexer em compensação de latência** → ler seção 4 (Agendador). O usuário já validou que `arrivalAt`/`executeAt` são "tempo do servidor", e que `<speed>` do XML já vem ajustado.
- **Antes de commit** → confirmar com o usuário, salvo se ele já disse.

---

## 8. Em aberto / Roadmap

- **Construtor**: módulo de fila de construção automática.
- **Pesquisa**: módulo de pesquisa de unidades.
- **Coleta em massa**: scavenge automatizado.
- **Farm**: assistente de farm em bárbaras/inativas.
- **Cunhagem**: cunhar moedas com estoque mínimo.
- **Balanceador de Recursos**: redistribuir via mercado.
- **Configurações**: tema, posição do launcher, etc.

---

## Apêndice A — Inspecionar HTML do jogo

Quando um parser quebrar, pedir o usuário rodar no console da aba do armazém (envolver em IIFE async + alert se logs do console não funcionarem):

### Ver fila de tropas
```js
const villageId = unsafeWindow.game_data.village.id;
fetch(`/game.php?village=${villageId}&screen=train`, { credentials: 'include' })
  .then(r => r.text()).then(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('table, [id*="trainqueue"]').forEach((el, i) => console.log(`[${i}]`, el.tagName, el.id, '→', el.querySelectorAll('tr').length));
  });
```

### Ver tabela de aldeias do grupo (overview combined)
```js
fetch('/game.php?screen=overview_villages&mode=combined&group=0&page=0', { credentials: 'include' })
  .then(r => r.text()).then(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Em algumas versões `table#combined_table` não existe — links com coord no texto:
    const rows = [...doc.querySelectorAll('a[href*="village="][href*="screen=overview"]')]
      .filter(a => /\(\d{1,3}\|\d{1,3}\)/.test(a.textContent));
    console.log('aldeias:', rows.length);
    if (rows[0]) console.log('exemplo:', rows[0].outerHTML.slice(0, 200));
  });
```

### Ver tabela de tropas (overview units)
```js
(async () => {
  const html = await (await fetch('/game.php?screen=overview_villages&mode=units&group=0&page=0', { credentials: 'include' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const t = doc.querySelector('table#units_table');
  alert('table existe: ' + !!t + '\nrows: ' + t?.querySelectorAll('tr').length);
})();
```

### Inspecionar form de envio de comando
- **Etapa 1** (rodar em `screen=place` após preencher tropas e clicar "Atacar"):
```js
const form = document.forms[0];
console.table([...form.querySelectorAll('input, button')].map(i => ({ name: i.name, type: i.type, value: i.value?.slice(0, 60) })));
```
- **Etapa 2** (após clicar Atacar e cair na tela de confirmação — adicionar "ataque adicional" pra ver `train[2]`):
```js
const form = document.forms[0];
console.log('action:', form.action);
console.table([...form.querySelectorAll('input, button')].map(i => ({ name: i.name, type: i.type, value: i.value?.slice(0, 80) })));
```

### Ver world config (XML)
```js
fetch('/interface.php?func=get_unit_info').then(r => r.text()).then(xml => {
  const d = new DOMParser().parseFromString(xml, 'text/xml');
  for (const node of d.documentElement.children) {
    const speed = node.querySelector('speed')?.textContent;
    if (speed) console.log(node.tagName, '→ speed=', speed);
  }
});
```
