# Mog Scripts — guia para o Claude

Userscript pessoal de automação para o jogo **Tribal Wars** (br142.tribalwars.com.br). Toolkit que o usuário roda via Tampermonkey/Violentmonkey no próprio navegador, sem backend.

---

## 1. Restrições essenciais (leia antes de codar)

- **Build pipeline (a partir de 0.7.x)**: o **fonte real** vive em `src/Mog.user.js`. `build.js` (Node) ofusca via `javascript-obfuscator` e gera `dist/Mog.user.js` — esse é o arquivo que o Tampermonkey baixa via `@downloadURL`. **Sempre editar `src/`** e rodar `node build.js`. Há ainda `Mog.user.js` na raiz como artefato legado, sincronizado manualmente pelo usuário. Quando precisar editar, prefira `src/` e replicar pra raiz se necessário (script de sync usa `node -e` preservando linhas 10-11 que diferem nas URLs).
- **Tudo num só arquivo de fonte**: `src/Mog.user.js` é vanilla JS no browser com `// @grant GM_*`. Não introduzir módulos ou dependências runtime — `package.json` só tem `javascript-obfuscator` como devDep.
- **Só inicializa em `screen=storage`**: o IIFE faz early-return se `unsafeWindow.game_data.screen !== 'storage'`. O usuário gerencia tudo na aba do armazém; ela faz fetches HTTP em background pras outras aldeias. Em qualquer outra tela o script nem carrega o launcher. **Exceção (a partir de 0.7.1)**: o **captcha guard lite** roda ANTES do early-return em qualquer screen do TW — detecção + banner + logout + canal cross-tab. Só o bot pesado (motores, UI) fica restrito a `screen=storage`.
- **Persistência**: `GM_setValue/GM_getValue` com chave `mog_state_v1` (mantida fixa mesmo após mudanças de schema — usar `migrateState` pra acomodar formatos antigos). Há também a chave global `mog_captcha_global_v1` (separada, sem migração) usada como fonte de verdade cross-tab pra estado de captcha — escrita pela primeira aba que detecta, lida pelas demais via polling/BroadcastChannel.
- **Servidor próprio (`twtime.vercel.app`)**: a partir de 0.8.x já era usado pra `/api/time` (sincronização de relógio). A partir de 0.9.0 também serve `/api/license/check` pra validar licenças por nick. Repo separado (`MateusObozovski/TwTime`) — clone como `c:\Projetos\TwTime`. Storage via Upstash Redis. Token admin em env var `MOG_ADMIN_TOKEN`. Fora isso, nada de telemetria/analytics — toda comunicação no jogo é pra `*.tribalwars.com.br`.
- **Não mudar `@name` do userscript**: hoje é `Millennium`. Tampermonkey/Violentmonkey usam o `@name` como chave do GM storage; mudar = perder todas as configs dos usuários instalados (vira "outro script"). Se precisar renomear, escrever migração via `GM_listValues`/`GM_setValue` antes do bump de versão.
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
- **Assistente de Saque (am_farm)**: feature premium nativa do TW que mantém uma lista de aldeias bárbaras conhecidas, com modelos de tropas (A e B) reusáveis e botões "Atacar A/B" por linha. O **Farmador** lê e edita essa estrutura — não duplica.
- **Modelo do Assistente (template_id)**: cada conta tem 2 modelos (A e B) com IDs próprios (ex: 2198/2230 numa conta, outros noutra). Convenção do bot: 1º template no DOM = "A", 2º = "B".
- **Saque cheio**: bárbara cujo último relatório carregou o limite de saque das tropas → no ciclo seguinte, dispara modelo B (mais tropas). Detectado via `<img src=".../max_loot/1.webp">` na linha do `#plunder_list`.
- **Com perdas**: bárbara cujo último ataque retornou com baixas → marca pra "quebra-muralha" (módulo futuro). Detectado via `dots/yellow.webp` ou `dots/red.webp`.

---

## 3. Arquitetura

`src/Mog.user.js` é organizado em seções verticalmente, top-to-bottom:

1. **Banner UserScript** — `@match`, `@grant`, `@version`
2. **Early-return** — só roda em `screen=storage`
3. **Constantes** — `UNITS`, `COMMAND_UNITS`, `BUILDINGS`, `GROUP_ALL`, `CATAPULT_TARGETS`, `DEFAULT_WORLD_CONFIG`, `DEFAULT_LATENCY`
4. **Factories** — `makeProfile`, `makeOperation`, `makeTarget`, `makeWave`, `makeAttackModel`, `makeSourceGroup`, `makeCommand`
5. **Storage / Migrations** — `loadState`, `migrateState`, `migrateProfile`, `migrateScheduler`, `migrateOperation`, `migrateSourceGroup`, `migrateFarmer`, `saveState`
6. **Game API** — `Game.{csrf, fetchGroups, fetchAllVillages, fetchGroupVillages, _fetchVillagesPaged, fetchTrainData, submitRecruit, prepareCommand, confirmCommand, submitCommand, _readPlaceCsrf, fetchWorldConfig, fetchAllUnits, fetchFarmTemplates, updateFarmTemplates, fetchFarmAssistantList, fetchOutgoingAttacks, fetchAllWorldVillages, dispatchFarm}`
7. **Parsers** — `parseVillagesFromOverview`, `parseTrainQueue`, `parseAllUnitsTable`, `parseWorldConfig`, `parseCoordsFromText`, `parseFarmTemplates`, `parseFarmAssistantList`, `parseOutgoingAttacks`
8. **Engine recrutamento** — `pushLog`, `computeRecruitForVillage`, `runProfileCycle`, `humanLikeDelay`
9. **Engine agendador** — `distance`, `slowestSpeed`, `travelTimeMs`, `ensureWorldConfig`, `solveOperation`, `resolveUnits`, `randomMs`, `kindMatchesType`
10. **Latência** — `measureLatency`, `refreshLatency`, `latencyCompensation`, `serverOffset`/`serverNow`/`serverToLocalTs`, `warmupConnection`
11. **Scheduler recrutamento** — timers per-profile (`scheduleProfileNext`, etc)
12. **Scheduler agendador** — `commandTimers`, `prepareTimers`, `preparedBundles`, `scheduleCommand`, `prepareForFire`, `executeCommand`, `cancelCommand`, `recoverScheduledCommands`, `getBundleSiblings`, `getAllScheduledCommands`, `maybeFinalizeOperation`, `activateOperation`
13. **Engine farmer** — `pushFarmerLog`, `runFarmerCycle`, `findNewBarbarians`, `scheduleFarmerNext`, `cancelFarmerSchedule`, `recoverFarmerSchedule`, `refreshFarmerHeader`, `updateFarmerProgress`, `distanceFields`
14. **Groups cache** — `getGroups`
15. **UI** — `GM_addStyle` → DOM (launcher/overlay/panel) → render funcs:
    - **Roteamento**: `renderContent` (recruiter | scheduler | dashboard | farmer | placeholder)
    - **Recruiter**: `renderRecruiter`, `renderProfileRow`, `renderAdvanced`, `bindProfileRow`
    - **Scheduler (wizard)**: `renderScheduler`, `getOrCreateDraftOperation`, `resetDraftOperation`, `renderOpWizard`, `renderWizardStep1..4`, `renderTargetRow`, `onTargetChange`, `renderLotInline`, `renderWaveRow`, `bindLotCard`, `populateLotGroupSelect`, `importLotFromGroup`, `addVillagesByCoords`, `syncVillagesFromTextarea`, `solveOperation`, `renderResultBlock`, `renderCmdRow`
    - **Dashboard**: `renderDashboard`, `renderDashTable`, `renderDashRow`, `coordsLink`, `formatCountdown`, `updateDashCountdowns`, `dashboardSignature`, `findCommandById`
    - **Farmer**: `renderFarmer`, `renderFarmerTemplatesBlock`, `renderFarmerTemplate`, `populateFarmerGroupSelect`, `loadFarmerTemplates`, `bindFarmer`, `bindFarmerTemplates`, `saveFarmerTemplates`

### State shape (atual — schema "v5", chave de storage ainda `mog_state_v1`)

```js
{
  enabled: false,                          // toggle global do recrutador
  ui: {
    activeSection: 'recruiter',            // 'recruiter' | 'scheduler' | 'dashboard' | 'farmer' | 'defenses' | 'builder' | 'settings' | 'research'
    expandedProfileId: null,
    panelOpen: false,
    logCollapsed: false,
    sideCollapsed: { account: bool, operations: bool, loot: bool, tools: bool },
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
  farmer: {
    enabled: false,                                  // toggle global do módulo
    groupId: 0,                                      // 0 = Todos
    timing: { minMs: 500, maxMs: 1000 },             // jitter entre envios
    cycleMin: 10,                                    // minutos entre ciclos automáticos
    maxPerBarbarian: 1,                              // ataques simultâneos por bárbara
    searchRadius: 10,                                // raio (campos) pra "Buscar bárbaras"
    maxFarmRadius: 15,                               // raio máx (campos) origem→bárbara no ciclo. 0 = sem limite
    needsWallBreak: [{ x, y, lastAttempt }],         // bárbaras detectadas com defesa
    log: [],                                         // máx 200
    ui: { collapsed: {} },
    nextRunAt: 0,                                    // timestamp do próximo ciclo
    busy: false,                                     // lock — limpo no boot
  },
  license: {                                          // a partir de 0.9.0 — preenchido pelo boot
    checkedAt: 0,                                     // ts da última checagem ok no servidor
    expiresAt: 0,                                     // ts (UTC ms) vindo do servidor
    nick: '',                                         // nick na última checagem (auditoria local)
    lastError: '',                                    // diagnóstico — descartado no boot
  },
}
```

`profile.running` (recrutador), `commandTimers/prepareTimers/preparedBundles` (agendador), `farmerTimerId/farmerTemplatesCache` (farmer), `Game._worldVillagesCache` (cache de `/map/village.txt`) são transitórios — não persistem.

**Modelos A/B do Assistente NUNCA persistem em `state.farmer`** — sempre lidos do jogo via `Game.fetchFarmTemplates()` e cacheados em memória local da função (`farmerTemplatesCache`). Quando usuário edita na UI e clica "Salvar", faz POST direto pra atualizar o assistente do jogo.

### Migrações de schema

| Versão | Mudança | Como migrar |
|--------|---------|-------------|
| v1 (0.1.x) | `recruiter` era objeto único | `migrateState` cria profile "Modelo principal" |
| v2 (0.2.0) | Introduz `recruiter.profiles[]` | `profiles.map(makeProfile)` |
| v3 (0.5.0) | `units[id]` perde `perQueue/maxQueues`; surge `buildings[name]` + `rrCursor` | `migrateProfile` agrupa valores por edifício |
| v4 (0.6.0) | Adiciona `state.scheduler` com operações, comandos, world config cache, latency, log próprio. State v3 sem scheduler vira default vazio | `migrateState` chama `migrateScheduler(parsed.scheduler)` que cria default se ausente |
| v5 (0.7.0) | Adiciona `state.farmer` (toggle, config, log, lista de wall-break, busy lock). `ui.activeSection` ganha `'farmer'` e `ui.sideCollapsed` ganha chave `'loot'` | `migrateState` chama `migrateFarmer(parsed.farmer)` que cria default se ausente. `migrateFarmer` zera `busy` no boot pra não travar após reload |
| 0.7.1 | **Não muda shape do `mog_state_v1`.** Adiciona chave **separada** `mog_captcha_global_v1` (fonte de verdade cross-tab pra captcha — `{trippedAt, reason, sourceTab}`). `state.captchaTrippedAt` continua existindo por compat | Sem migração no `migrateState`. Boot do bot promove flag local antiga pra global se necessário |
| v6 (0.8.0) | Adiciona `state.builder` (Construtor): `enabled`, `templates[]`, `profiles[]`, `log[]`, `ui`, `busy`, `premiumDetected`. `ui.activeSection` ganha `'builder'`. `BUILDING_KEYS` validado via snippet: 17 edifícios, índice 4 = `watchtower` (sem `church`/`church_f` no br142) | `migrateState` chama `migrateBuilder(parsed.builder)` que cria default se ausente. `migrateBuilder` zera `busy` e `running` de cada profile no boot |
| 0.8.0 (UI) | **Não muda shape do `mog_state_v1`.** Toggle "Ativo/Pausado" global do header **removido**; `state.enabled` fica no shape (compat) mas não é mais lido pela lógica. Cada módulo (Recrutador profiles, Farmador, Construtor) agora controla seu ciclo apenas pela própria flag `enabled`, com `state.captchaTrippedAt > 0` como pause global enquanto captcha ativo. Captcha trip não zera mais `enabled` por-módulo — preserva intenção do usuário pra `resumeFromCaptcha` saber quem religar. Header passa a mostrar 3 chips read-only (Captcha/RTT/relógio servidor). Paleta migrada pra `#222831`/`#393E46`/`#00ADB5`/`#EEEEEE` via CSS vars (`:root { --mog-* }`). Sidebar perde itens "Em breve" (Pesquisa/Configurações ressurgem quando implementados) | Sem migração — flag `state.enabled` herdada é ignorada |
| v7 (0.9.0) | Adiciona `state.license` (`{checkedAt, expiresAt, nick, lastError}`) — validado no boot via `twtime.vercel.app/api/license/check` (identidade pelo `game_data.player.name`, cross-mundo). Bloqueio total se inválido/sem rede: `renderLicenseBlock` substitui `renderContent`, recoveries (`scheduleProfileNext`/`recoverScheduledCommands`/`recoverFarmerSchedule`/`recoverBuilderSchedule`) ficam atrás de `runBootRecoveries()` que só roda em fluxo OK. Nova seção sidebar **Ferramentas → Configurações** ressuscitada (`state.ui.activeSection === 'settings'`) com botões export/import e re-validar licença. Header ganha 4º chip `mog-chip-license` colorido por proximidade (>7d verde, ≤7d amarelo, ≤2d vermelho). Captcha guard segue rodando antes de tudo | `migrateState` chama `migrateLicense(parsed.license)` que cria default zerado. `lastError` é descartado no boot (transitório) |

**Sempre que mudar o shape, adicionar uma linha aqui e código de migração.** Nunca quebrar usuários antigos.

---

## 4. Decisões já tomadas (não revisitar sem motivo)

### Geral
- **Paleta**: `#121313` (base) + `#FF6044` (accent). Constantes `COLOR_BG`, `COLOR_ACCENT`.
- **Layout**: painel horizontal sobreposto centralizado (`min(1180px, 100vw - 80px)`), grid 2x2. Launcher lateral esquerdo.
- **Sidebar**: 3 seções colapsáveis — "Gerente de Conta" (Construtor*/Recrutamento/Pesquisa*), "Operações" (Agendador/Painel), "Ferramentas" (Configurações*). Itens com asterisco têm badge "Em breve".
- **Spinners de input number escondidos** (cross-browser CSS).
- **Naming CSS**: prefixo `.mog-` em todas as classes pra não colidir com o CSS do jogo.

### Captcha guard (a partir de 0.7.1 — cross-tab)
- **Guard "lite" universal**: roda ANTES do early-return em todas as screens do TW. Define detecção (DOM + URL + fetch wrapper + XHR wrapper), banner, logout cascata, canal cross-tab. Hosts: `tripCaptcha`, `performLogout`, `setupCrossTabCaptcha`, `installFetchWrapper`, `installXhrWrapper`, `startCaptchaWatcher`.
- **Bot full** (em `screen=storage`) registra hooks em `extraTripHandlers[]` e `reactivateHandlers[]` — só faz a parte state-aware (parar motores, zerar timers, logar). Banner + logout + broadcast vivem no lite.
- **Canal cross-tab**:
  - **BroadcastChannel** `mog-captcha-v1` — mensagens `{type:'TRIP'|'REACTIVATE', reason?, ts, sourceTab}`. Latência <50ms. Anti-eco via `sourceTab === TAB_ID` skip.
  - **GM key global** `mog_captcha_global_v1` — fonte de verdade persistida `{trippedAt, reason, sourceTab}`. Sobrevive reload. Polling fallback de 3s caso BroadcastChannel falhe. **Reativar APAGA a chave** (não zera) via `GM_deleteValue`.
- **Detecção** (`tripCaptcha` é idempotente, dedupe via `captchaHandled`):
  - **DOM**: `MutationObserver` em `body` + selectors com cobertura ampla — variações com/sem underscore (`botprotect`, `bot_protect`, `bot_protection`, `popup_box_bot_protection`), `hcaptcha`/`h-captcha`, iframes `hcaptcha.com`/`recaptcha`.
  - **URL**: poll a cada 3s + check inicial — cobre `screen=bot_protection`, `screen=bot_protect`, `bot_protection`, `bot_protect`, `botprotection`.
  - **Título**: poll a cada 3s + check inicial — cobre `verificação de bot`, `bot.?protect` (caso TW mude `document.title` antes do DOM atualizar).
  - **Fetch**: wrapper em `unsafeWindow.fetch` — só inspeciona content-type HTML/JSON/text de mesma origem, primeiros 5000 chars.
  - **XHR**: wrapper em `XMLHttpRequest.prototype.open/send` — escuta `readystatechange === 4`, mesmas regras.
  - **Regex** estritas (não `bot[\s_-]*protection` genérico): `bot_protection_active`, `screen=bot_protection`, `popup_box_bot_protection`, `class="..botprotect..`, `\bh-captcha\b`, `hcaptcha\.com\/captcha`.
- **Logout em cascata** (`performLogout`, `logoutInFlight` anti-loop):
  1. `GET /index.php?action=logout&h=<csrf>` em paralelo (best-effort).
  2. `+800ms` → `location.href = /index.php?action=logout&h=<csrf>` (ou `/index.php` sem csrf).
  3. `+2500ms` → se ainda em `/game.php`, fallback `location.href = /logout.php`.
- **Reativação + carência**: botão no banner apaga GM global, broadcast REACTIVATE, dispara `reactivateHandlers[]`, e chama `enterGracePeriod()` (default 60s). Durante a carência `captchaHandled` fica `true` — o monitor não dispara trip nem logout. Indicador discreto top-right com countdown + botões "+60s" e "Já resolvi". **Motivo**: após login, o TW pode estar em `screen=bot_protection` com hCaptcha ativo no DOM; sem carência, o guard re-detectaria e deslogaria antes do user resolver. `handleRemoteReactivate` (broadcast de outra aba) também entra em carência por consistência. **Motores NÃO religam automaticamente** — usuário tem que toggle global.
- **Compat com flag local antiga**: `state.captchaTrippedAt` no `mog_state_v1` é mantido (sem migração). Se boot do bot full encontra `captchaTrippedAt > 0` mas global está vazia, "promove" pra global via `tripCaptcha('flag local migrada', { doLogout: false })`.
- **`startGlobal()`** (botão ON do bot) também limpa GM global + broadcast REACTIVATE — garante que ligar o bot resseta o estado em todas as abas.

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

### Farmador
- **Pré-requisito do usuário**: conta com Assistente de Saque ativo (premium TW). Sem isso, `screen=am_farm` não funciona.
- **Foco em bárbaras**: módulo só farma `owner === 0` (bárbaras + aldeias-bônus do mapa). Farm de jogadores inativos é feature futura.
- **Modelos vivem no jogo**: o bot **lê e edita** os modelos A e B do Assistente nativo, não duplica. Cache em memória (`farmerTemplatesCache`); persistência fica no servidor TW.
- **IDs dinâmicos de template**: cada conta tem IDs próprios (ex: 2198 e 2230 num mundo). Convenção: 1º template no DOM = "A", 2º = "B". `parseFarmTemplates` extrai IDs reais.
- **CSRF do am_farm vem na URL do form**, não como `<input name="h">`. `parseFarmTemplates` extrai do `form.action` via regex `[?&]h=([a-f0-9]+)`. Mesma `h` serve pra `updateFarmTemplates` (no body) e `dispatchFarm` (no body). É CSRF de sessão, não rotaciona por request.
- **Endpoint de dispatch**: `POST /game.php?village=<source>&screen=am_farm&mode=farm&ajaxaction=farm&json=1` com headers `TribalWars-Ajax: 1` e `X-Requested-With: XMLHttpRequest`. Body: `target=<targetId>&template_id=<id>&source=<sourceId>&h=<csrf>`. Resposta JSON; erro retorna `{ error: [...] }`.
- **Detecção de "saque cheio"**: `<img src=".../max_loot/1.webp">` na linha do `#plunder_list`. Qualquer outra variação (`max_loot/0`) = saque parcial.
- **Detecção de "com perdas"**: `<img src=".../dots/yellow.webp">` ou `dots/red.webp` (vitória parcial / derrota). `dots/green` = vitória total sem perdas.
- **Decisão A/B/spy no ciclo**:
  - Default → modelo A
  - `target.fullLoot === true` → modelo B
  - `target.hadLosses === true` → registra em `needsWallBreak[]`, **não dispara** (envio de spy puro requer troca temporária de template — fica como melhoria futura)
- **`maxPerBarbarian`**: contador local por ciclo (`Map<villageId, count>`), **não soma global persistida**. Cada execução começa do zero.
- **Spy via troca temporária de template** (Buscar bárbaras): salva snapshot do A original, substitui por `{spy:1, resto:0}`, dispara N espiões, restaura A no `finally`. Se a aba fechar no meio, modelo A pode ficar bagunçado — usuário restaura manualmente. Aceitável pro MVP.
- **Filtro "ataque a caminho"**: antes de cada ciclo/busca, lê `Game.fetchOutgoingAttacks()` (parsea `screen=place&mode=command`, filtra `data-command-type="attack"`). Bárbaras com coord destino no Set são puladas — evita duplicar farms já enviados manualmente.
- **Validação de espiões antes da busca**: lê `Game.fetchAllUnits(groupId)` e filtra origens com `spy > 0`. Se zero, aborta com erro claro. Limita envios a `min(candidatas, totalSpies)`.
- **Round-robin com fallback**: na busca, pra cada candidata tenta até `originsWithSpy.length` origens diferentes. Se uma origem retorna "tropas insuficientes", marca em `exhausted` e tenta a próxima. Quando todas esgotam, encerra cedo.
- **Endpoint do mapa global**: `GET /map/village.txt` retorna CSV `id,name(URL-encoded),x,y,owner_id,points,?` com TODAS as aldeias do mundo. Owner = 0 → bárbara/bônus. ~3.5MB, cacheado em `Game._worldVillagesCache` (mundo não muda durante a sessão).
- **`/map.php?v=2&x=X&y=Y` retorna `[]` no br142** — não usar pra sectors. `/map/village.txt` é o caminho.
- **Catapulta na UI**: removida da grade editável (farm de bárbara não usa). Ao salvar, `tpl.units.catapult` é preservado do que estava no jogo (passa direto pelo `updateFarmTemplates`).
- **Lock `busy` global**: `state.farmer.busy = true` durante `runFarmerCycle` ou `findNewBarbarians`. Bloqueia ciclo automático paralelo, botão "Executar agora", botão "Buscar". Persistido pra recovery; **zerado no boot** pelo `migrateFarmer` pra não travar após reload no meio.
- **Recovery de timer**: `recoverFarmerSchedule()` no boot — se enabled antes do reload, agenda novo ciclo daqui a 1min (não imediato, pra evitar burst após restart).

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

## 5d. Algoritmo do Farmador

### Ciclo principal (`runFarmerCycle`)

1. **Busy lock**: aborta se `state.farmer.busy` já é `true`. Marca `busy = true`.
2. **Lê templates** via `Game.fetchFarmTemplates()` → `tplA`, `tplB`, `csrf`.
3. **Lê origens** do grupo configurado.
4. **Em paralelo**: `fetchFarmAssistantList(origins[0].id)` (bárbaras conhecidas) + `fetchOutgoingAttacks()` (Set de coords com ataque indo) + `fetchAllUnits(groupId)` (tropas das origens).
5. **Não pré-fetch de relatórios no ciclo automático**. `refreshThreats` só roda via botão manual ou na tela de detalhes — economiza N GETs sequenciais por ciclo (principal causa de captcha). O cache existente em `state.farmer.threats` ainda bloqueia bárbaras com defesa conhecida via `isThreatActive`. Cache TTL 30min, delay 400-900ms entre fetches no botão manual.
6. **Pré-calcula plano realista**: `eligible = bárbaras sem perdas, com slot livre, sem defesa detectada`. `planned` é calculado por **simulação de pareamento** (clone das tropas, pra cada bárbara elegível verifica se há origem com tropa pra A ou B; conta quantos farms cabem). Janela temporal não é simulada (precisaria ETA por par origem×alvo).
7. **Pra cada bárbara × slot disponível** (loop invertido):
   - `hadLosses` → registra em wall-break + skip
   - `isThreatActive` → pula (defesa detectada)
   - Decide template: `fullLoot` → B; senão A
   - `pickBestOrigin(target, tpl)`: filtra origens com tropa, dentro do `maxFarmRadius` e com ETA fora da janela temporal; ordena por distância e retorna a mais próxima
   - Se B sem origem viável → tenta A (downgrade `A↓`)
   - Nenhuma origem viável → abandona essa bárbara (não esgota outras)
   - `Game.dispatchFarm()` com timing realista (`randomInRange(min, max)` ms)
   - "Tropas insuficientes" durante dispatch → zera origem local, tenta outra origem pro mesmo slot
8. **Finally**: `busy = false`, agenda próximo ciclo se não-manual.

### Buscar bárbaras (`findNewBarbarians`)

1. **Busy lock** (mesmo do ciclo).
2. **Snapshot do modelo A** original.
3. **Valida espiões disponíveis**: `fetchAllUnits(groupId)` → filtra origens com `spy > 0`. Aborta se zero.
4. **Lista candidatas**: bárbaras (`owner === 0`) do mapa global (`fetchAllWorldVillages` cacheado), filtradas por:
   - Distância ≤ `searchRadius` de qualquer origem
   - Não já registradas no Assistente
   - Não com ataque a caminho (via `fetchOutgoingAttacks`)
5. **Limita envios** a `min(candidatas, totalSpies)`.
6. **Troca modelo A** pra `{spy:1, resto:0}` via `updateFarmTemplates([spyA, B], csrf)`. Recarrega CSRF (jogo pode rotacionar).
7. **Round-robin com fallback** entre origens-com-espião:
   - Pra cada candidata, tenta até N origens diferentes a partir do cursor
   - Origem "sem tropas" vai pra `exhausted`; `exhausted >= origins` → encerra cedo
8. **Finally**: restaura modelo A (sempre, mesmo em erro). `busy = false`.

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

Organização da sidebar quando tudo estiver pronto:

```
Gerente de Conta   → Construtor · Recrutamento · Pesquisa
Coleta & Saque     → Farmador · Quebra de Muralhas · Coletor
Comandos           → Painel · Agendar Comandos · Snipar · Snip Cancel · Auto Desvio
Painel de Defesa   (tela única)
Utilidades         → Balanceador · Treinar Paladinos
Configurações      (tela única)
```

**Princípio do grupo Comandos**: cada sub-tela é um **facilitador de UI** que monta um comando e injeta no mesmo pipeline do Agendador (`solveOperation` + `Game.submitCommand`). O **Painel** é a única tela que mostra **todos** os comandos vivos, independente de onde nasceram (Agendar / Snipar / Snip Cancel / Auto Desvio / Quebra de Muralhas / Apoio em massa). Comandos com `cancelAt` definido aparecem como 1 linha só, com timeline interna (enviado HH:MM → cancelar HH:MM → volta HH:MM).

Cada item abaixo tem **estado atual** (não existe / parcial / com bug) e **nuance técnica** que precisa ser respeitada na implementação.

### Gerente de Conta

#### Construtor
- **Bugs no import de modelo do jogo** — hoje quebra ao importar; usuário tem que recriar manualmente. Investigar o parser/decoder do template base64.
- **Criação manual de modelos** — UI pra montar um template do zero (hoje só importa).

#### Recrutamento
- **Bugs latentes** — validar se ainda dá pra estourar fila acima do `maxQueues` em race com o jogo (ex.: usuário recruta manualmente entre o `fetchTrainData` e o `submitRecruit`). Investigar antes de adicionar features novas no módulo.

#### Pesquisa
- Hoje placeholder ("Em breve"). Implementar análogo ao Construtor: profiles com **ordem de pesquisa desejada** (lança → arqueiro → leve → ...), aplicado por grupo de aldeias. Endpoint `screen=smith&mode=research`.

### Coleta & Saque

#### Farmador (já existe)
- **Spy puro com troca temporária de A** — quando bárbara volta com perdas, hoje só registra em `needsWallBreak`. Ideal trocar A pra `{spy:1, resto:0}` igual o "Buscar bárbaras" e mandar 1 espião pra confirmar muralha/defesa antes de marcar pro Quebra de Muralhas.
- **Farm de jogadores inativos** — Assistente nativo só lista bárbaras. Pra inativos, vai precisar usar `screen=place` direto. Detecção via `/map/village.txt` (jogadores com `points` baixo + sem mudança recente).

#### Quebra de Muralhas
- Hoje o Farmador só **detecta** (`hadLosses` → `state.farmer.needsWallBreak`). Falta o disparo: tela própria que lista bárbaras dessa fila e manda aríete + catapulta (alvo `wall`) configuráveis. **Não dá pra usar `am_farm`** — o Assistente não suporta catapulta direcionada a edifício; usar `Game.submitCommand` direto. Comandos gerados aqui aparecem no Painel de Comandos.

#### Coletor
- **Coleta em massa automática** — endpoint `screen=scavenge` (não tem nada hoje). Configuração por aldeia/grupo: quais 4 níveis usar, quais tropas alocar por nível, intervalo, **limite até o dia atual** (parar quando a próxima coleta cair em D+1). Precisa parser do JSON de status de cada nível e do POST de start.

### Comandos

#### Painel (renomear "Painel" do Agendador atual)
- Hoje só lista comandos do Agendador. Vira **fonte única de verdade** pra qualquer comando vivo (Agendar / Snipar / Snip Cancel / Auto Desvio / Quebra de Muralhas / Apoio em massa).
- **Cancelamento como etapa do comando original** — comandos com `cancelAt` aparecem em 1 linha só, com timeline interna: `enviado HH:MM:SS.mmm → cancelar HH:MM:SS.mmm → volta prevista HH:MM`. Pipeline: `send → wait → POST cancel → mark cancelled`. Estado novo no `command`: `cancelAt`, `cancelStatus` (`pending`/`sent`/`failed`), `returnAt` (estimado).
- **Filtros** por origem (qual tela criou), tipo, status. Coluna "origem" mostra ícone do facilitador.

#### Agendar Comandos (renomear "Agendador")
- Mesmo wizard que existe hoje. Só renomeia.
- **Apoios — velocidade real do bloco** — hoje `slowestSpeed()` usa só `BASE_SPEEDS` das unidades enviadas. Pra apoios com paladino, **todas** as tropas viajam na velocidade do paladim (10 mpf base) — geralmente é o paladim que vira a "tropa mais lenta", não a heavy/ram. Além disso:
  - **Itens de aflição do paladim** (ex.: bota de Hércules / similares) reduzem o tempo de viagem do apoio. Precisa parsear o item equipado em `screen=statue` por aldeia origem.
  - **Habilidade de tribo "Apoio rápido"** (se ativa no br142) também aplica multiplicador. Verificar via `game_data.player.ally` + endpoint da tribo.
  - **Implementação**: estender `slowestSpeedMpf` pra receber contexto `{type:'support', sourceVillageId}` e aplicar os bônus em cima. Não tocar em ataque (não tem esses bônus).
- **Etiquetador automático** — re-etiquetar comandos saintes a cada ~5min com a unidade mais lenta real (o jogo só mostra o ícone genérico). Endpoint: `screen=info_command&id=...&action=label` (validar). Pra apoios, considerar bônus de paladim/itens/habilidade (ver item acima). **Toggle global vive em Configurações.**
- **Apoio em massa** — facilitador de UI dentro de Agendar. Form "X cavalaria pesada de cada aldeia do grupo Y pra alvo Z", com validação de tropa disponível e disparo no pipeline normal.

#### Snipar (Snipe defensivo)
- Chegar com **meu apoio** entre os comandos inimigos. Dois modos:
  - **Aldeia minha sob ataque** — lê `screen=overview_villages&mode=incomings` pra timeline dos comandos chegando.
  - **Aldeia aliada** — usuário passa coord alvo + horário desejado de chegada; o bot calcula origem/MS.
- Reusa pipeline de Agendar (`type:'support'`) + a lógica nova de velocidade real do bloco (paladim/itens/tribo). Existem scripts públicos de referência (`lulz`/similares) — servem de baseline, mas a velocidade real do apoio precisa ser nossa.
- Comando aparece no Painel como linha normal de apoio.

#### Snip Cancel
- Disparar nobre + cancelar no instante exato pra que as tropas voltem **entre** os nobres do inimigo. UI calcula o `delta` (diferença de MS entre os nobres alvo).
- **Cancelamento = etapa do comando original**: comando criado já com `cancelAt = executeAt + delta`. Pipeline lida com isso na timeline interna; não cria comando-irmão. Painel mostra a linha única com a timeline.

#### Auto Desvio (reativo)
- Quando há ataque inimigo chegando (lê de `screen=overview_villages&mode=incomings`), calcula janela segura, manda tropa pra um destino dummy e cancela pra voltar **depois** do ataque inimigo passar (pra não perder tropa).
- Mesma mecânica de cancelamento do Snip Cancel (`cancelAt` no comando), mas aqui o objetivo é a **volta**, não a chegada. **Escopo só reativo** — sem rotina de "dar uma volta sempre que tiver tropa parada".

### Painel de Defesa (tela única)
Hoje `state.farmer.threats` + UI `renderDefenses()` é apenas leitura passiva (relatórios capturados pelo farm). Tela nova precisa:
- **Detecção de ataques recebidos** via `screen=overview_villages&mode=incomings` (paginado, novo método em `Game`). Estado novo: `state.defense.incomings[]`.
- **Atacantes** — quem está atacando, quantos comandos no total, ETA do primeiro/último, tribo.
- **Aldeias vulneráveis** — minhas aldeias com defesa baixa pro tamanho do ataque recebido (cruza `fetchAllUnits` com tamanho do ataque inimigo).
- **Aldeias que precisam de apoio** — sugestão automática integrada com Apoio em massa (botão "enviar apoio" abre o facilitador pré-preenchido).
- **Filtros, observações por linha, marcação manual** — usuário pode anotar "fake", "real", "ignorar" e isso persiste.
- **Notificação push** quando novo ataque é detectado (ver Configurações → Notificações).
- **Sem sub-módulos** — uma tela só, com seções colapsáveis.

### Utilidades

#### Balanceador
- **Puxar recursos** — opção de "puxar recursos do grupo X pra aldeia Y". Endpoint `screen=market&mode=call_resources` ou envio direto. Útil pra acumular pra construção/recrutamento numa capital.
- **Balanceamento automático** — distribuir pra que aldeias menores cresçam junto com as maiores. Existem scripts de referência (`farmgod`-style); melhorar levando em conta produção atual + estoque + nível do mercado.
- **Cunhagem (snob coins)** — cunhar moedas com estoque mínimo. Endpoint `screen=snob&mode=mint`.

#### Treinar Paladinos
- **Treinamento em massa** — endpoint `screen=statue` por aldeia. Profile global: "treinar paladim em todas as aldeias com estátua e sem paladim".

### Configurações (tela única)
Tela única com seções colapsáveis. **Sem sub-módulos.** Hoje tem só export/import de configs e re-validar licença. Adicionar:
- **Licença** — re-validar (já existe), status, expiração, **cache offline com TTL** (hoje bloqueio é total se Vercel cair; considerar cache de last-validated-at de 24h, tradeoff: revogação demora mais a propagar).
- **Importar / Exportar configurações** (já existe).
- **Notificações** — toggle por canal:
  - **Discord**: webhook URL → POST direto do userscript (trivial).
  - **Telegram**: precisa bot + `chat_id`. Pra esconder o token do bot, relay via `twtime.vercel.app` com novo endpoint `POST /api/notify` (`{nick, channel, message}`).
  - **Eventos**: novo ataque recebido, captcha disparado, farm bloqueado por captcha, operação concluída, snipe armado/disparado.
  - **WhatsApp fora do escopo** (custo e fragilidade — Twilio/WABA).
- **Etiquetador automático** — toggle global do re-label de comandos (a feature em si vive em Agendar Comandos).
- **Captcha — validar logout automático** — hoje a cascata (`GET /index.php?action=logout` → `location.href` → fallback `/logout.php`) já roda. Pendente: testar em conta real os 3 caminhos, especialmente o fallback `logout.php`. Adicionar telemetria local (qual caminho funcionou) pra tunar o timing. Configuração: tempo de carência ajustável.
- **Personalização da UI** — tema, posição do launcher, etc. (futuro).

### Servidor (twtime.vercel.app)
Não aparece na sidebar — é infraestrutura. Roadmap:
- **Endpoint `/api/notify`** — relay de notificações (ver Configurações → Notificações).
- **Admin UI** — hoje é HTML simples em `/admin` com login por token em sessionStorage. Funcional pra dezenas de usuários; se virar centenas, paginar `/api/license/list` + busca.

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

---

## Apêndice B — Snippets do Assistente de Saque (am_farm)

Quando um parser do Farmador quebrar:

### Tabela de bárbaras conhecidas (`#plunder_list`)
Cuidado: o jogo tem várias tabelas com coords (`main_layout` é layout externo). Filtre por **`id !== 'main_layout'`** e que **não contenham outras tabelas**:
```js
(async () => {
  const html = await (await fetch('/game.php?village=' + game_data.village.id + '&screen=am_farm', { credentials: 'include' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = [...doc.querySelectorAll('table')]
    .map(t => ({ t, rows: [...t.querySelectorAll('tr')].filter(tr => /\(\d{1,3}\|\d{1,3}\)/.test(tr.textContent)).length }))
    .filter(x => x.rows >= 3 && x.t.id !== 'main_layout' && !x.t.querySelector('table'))
    .sort((a, b) => b.rows - a.rows);
  console.log('candidatas:', tables.length, 'tabela real:', tables[0]?.t.id);
})();
```
Esperado: `id="plunder_list"`. Linhas no formato `<tr id="village_<ID>" class="report_<ID> row_a">`.

### Form de modelos A/B (`action=edit_all`)
```js
const forms = [...document.forms].filter(f => /am_farm/.test(f.action || ''));
forms.forEach((f, i) => console.log(i, f.action.slice(-100), [...f.querySelectorAll('input,select')].slice(0, 30).map(x => `${x.name}=${x.value}`)));
```
- O 1º form é o `action=edit_all`. **CSRF (`h`) vem na URL** (`...&h=<hash>`), NÃO como `<input>`. Extrair via regex.
- Inputs no formato `template[<ID>][id]`, `template[<ID>][new]`, `<unit>[<ID>]`, `catapult_target[<ID>]`. Cada conta tem IDs próprios pros 2 modelos.

### POST de disparar farm (Network tab)
- Abre `screen=am_farm` no jogo
- DevTools → Network → filtra XHR
- Limpa lista, clica botão "A" de uma bárbara
- Request: `POST /game.php?village=<source>&screen=am_farm&mode=farm&ajaxaction=farm&json=1`
- Headers: `tribalwars-ajax: 1`, `x-requested-with: XMLHttpRequest`, `accept: application/json`
- Body: `target=<targetVillageId>&template_id=<id>&source=<sourceVillageId>&h=<csrf>`

### Mapa global (`/map/village.txt`)
```js
(async () => {
  const t = await (await fetch('/map/village.txt', { credentials: 'include' })).text();
  const lines = t.split('\n').filter(Boolean);
  let barb = 0;
  for (const l of lines) { if (l.split(',')[4] === '0') barb++; }
  alert(`${lines.length} aldeias, ${barb} bárbaras (col[4]=0)`);
})();
```
- Formato CSV: `id,name(URL-encoded),x,y,owner_id,points,?` — **owner está na coluna 4** (índice 4), não 6.
- Owner = 0 → bárbara ou aldeia-bônus (ambas farmáveis).

### Ícones de status no `#plunder_list`
Inspecionar `<img>` em linhas reais:
- **Saque cheio**: `src=".../max_loot/1.webp"` title="Saque máximo"
- **Saque parcial**: `src=".../max_loot/0.webp"` title="Saque parcial: ..."
- **Vitória total**: `src=".../dots/green.webp"` title="Vitória total"
- **Vitória com perdas**: `src=".../dots/yellow.webp"`
- **Derrota**: `src=".../dots/red.webp"`

### Comandos saindo (ataques a caminho)
```js
(async () => {
  const html = await (await fetch('/game.php?screen=place&mode=command', { credentials: 'include' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('tr.command-row');
  console.log('comandos:', rows.length);
  if (rows[0]) console.log('1ª linha:', rows[0].outerHTML.slice(0, 1500));
})();
```
- Tabela: `<table class="vis">` (sem id), linhas `<tr class="command-row">`
- Cada linha tem `<span class="command_hover_details" data-command-type="attack|support|return">`
- Texto do destino em `<span class="quickedit-label">Ataque a Foo (X|Y) Kxx</span>`
- Filtro do Farmador: só `data-command-type="attack"` (cobre ataque normal + farm)
