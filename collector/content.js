(() => {
  console.info('[Crash History Collector] content iniciado v1.0.16');
  const seen = new Set();
  let recoveringHistory = false;
  let stopped = false;
  let scanTimer;
  let scanScheduled;
  let lastScheduledScanAt = 0;
  let historyTimer;
  let recoveryTimer;
  let startupTimer;
  let observer;
  let lastMetricsKey = '';
  let pendingLiveMetrics = null;
  let lastLiveRoundId = null;
  let latestCapturedRoundId = null;
  let lastAccountStatusKey = '';
  let lastAccountStatusSentAt = 0;
  const receiverEndpoint = 'http://127.0.0.1:8765/rounds';
  // Mantém uma referência da instância que injetou este script. Após atualizar
  // a extensão, `chrome.runtime` pode mudar entre uma verificação e o envio.
  // Usar a referência capturada elimina esse acesso tardio ao contexto antigo.
  let runtime;
  try { runtime = chrome.runtime; } catch { runtime = undefined; }
  // IDs de rodada do Crash são numéricos curtos; limitar o tamanho evita que
  // IDs longos de perfis/jogos em outras áreas da página entrem como rodadas.
  const idRe = /^\d{7,8}$/;
  const multRe = /^(\d+(?:[.,]\d+)?)\s*[×x]$/i;

  // Ao clicar em "Atualizar" na extensão, scripts já injetados na página
  // perdem o contexto do Chrome. Eles precisam encerrar sem lançar exceção.
  function extensionAlive() {
    try { return Boolean(runtime && runtime.id); }
    catch { return false; }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    clearInterval(scanTimer);
    clearTimeout(scanScheduled);
    clearInterval(historyTimer);
    clearInterval(recoveryTimer);
    clearTimeout(startupTimer);
  }

  function sendRows(rows) {
    if (!rows.length || stopped) return;
    const payload = JSON.stringify({ source: 'bc-game-crash-extension', rows });
    // Envio direto primeiro: o painel não pode depender da resposta do
    // service worker, que pode estar reiniciando após uma atualização da
    // extensão. O receptor deduplica os IDs, então o worker continua seguro
    // como segunda via de fila persistente.
    fetch(receiverEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: payload
    }).then(response => {
      if (response.ok || !extensionAlive()) return;
      try { runtime.sendMessage({ type: 'rounds', rows }).catch(() => {}); } catch { }
    }).catch(() => {
      if (!extensionAlive()) return;
      try { runtime.sendMessage({ type: 'rounds', rows }).catch(() => {}); } catch { }
    });
  }

  // O placar público do Crash mostra, durante a rodada, "ativos / total
  // Jogadores" e o total em R$. Esses números mudam enquanto a rodada está
  // aberta, por isso são enviados como observações ao vivo, sem inventar uma
  // associação com um ID de rodada já encerrada.
  function sendLiveMetrics(lines) {
    const playerIndex = lines.findIndex(line => /\b\d[\d.]*\s*\/\s*\d[\d.]*\s+Jogadores\b/i.test(line));
    if (playerIndex < 0) return;
    const playerMatch = lines[playerIndex].match(/\b(\d[\d.]*)\s*\/\s*(\d[\d.]*)\s+Jogadores\b/i);
    if (!playerMatch) return;
    const amountLine = lines.slice(playerIndex + 1, playerIndex + 4)
      .find(line => /R\$\s*[\d.]+(?:,\d{2})?/.test(line));
    const amountMatch = amountLine?.match(/R\$\s*([\d.]+(?:,\d{2})?)/);
    if (!amountMatch) return;
    const activePlayers = Number(playerMatch[1].replace(/\./g, ''));
    const totalPlayers = Number(playerMatch[2].replace(/\./g, ''));
    const totalAmountBrl = Number(amountMatch[1].replace(/\./g, '').replace(',', '.'));
    if (![activePlayers, totalPlayers, totalAmountBrl].every(Number.isFinite)) return;
    const metrics = {
      captured_at: new Date().toISOString(),
      active_players: activePlayers,
      total_players: totalPlayers,
      total_amount_brl: totalAmountBrl,
      total_amount_display: `R$ ${amountMatch[1]}`
    };
    const key = `${activePlayers}|${totalPlayers}|${metrics.total_amount_display}`;
    if (key === lastMetricsKey || stopped) return;
    lastMetricsKey = key;
    pendingLiveMetrics = metrics;
    fetch(receiverEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ source: 'bc-game-crash-extension', rows: [], live_metrics: metrics })
    }).catch(() => {});
    if (extensionAlive()) {
      try { runtime.sendMessage({ type: 'live-metrics', metrics }).catch(() => {}); }
      catch { }
    }
  }

  function isVisible(element) {
    const rect = element?.getBoundingClientRect?.();
    const style = element ? getComputedStyle(element) : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style && style.visibility !== 'hidden' && style.display !== 'none');
  }

  function parseLocalizedNumber(raw) {
    let value = String(raw || '').replace(/\s/g, '');
    const comma = value.lastIndexOf(','), dot = value.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? ',' : '.';
      value = value.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
    } else if (comma >= 0) value = value.replace(/\./g, '').replace(',', '.');
    else if (dot >= 0 && /^\d{1,3}(?:\.\d{3})+$/.test(value)) value = value.replace(/\./g, '');
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // O saldo pode estar dividido entre elementos ou dentro de um frame do
  // jogo. Aceitar pequenos contêineres visíveis torna a leitura resiliente
  // sem confundir valores da lista pública, que fica bem abaixo do cabeçalho.
  function readWalletStatus() {
    const balancePattern = /^([\d.,]+)\s*(USDT|BCD|BRL)$/i;
    const candidates = [...document.querySelectorAll('body *')]
      .filter(element => isVisible(element))
      .map(element => ({ element, text: element.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(), rect: element.getBoundingClientRect() }))
      .filter(item => item.text.length <= 40 && item.rect.top >= 0 && item.rect.top < 320 && balancePattern.test(item.text));
    const selected = candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    const wallet = selected?.text.match(balancePattern);
    const button = [...document.querySelectorAll('button')]
      .find(element => isVisible(element) && /^(sacar|retirar)$/i.test(element.textContent.trim()));
    const betActive = Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    // O valor da aposta é lido somente dentro do contêiner do botão Sacar/
    // Retirar. Assim não confundimos o campo "aposta inicial" do script com
    // a mão realmente enviada à BC. Se a BC não expuser esse campo no DOM,
    // o valor permanece nulo.
    let betAmount = null;
    if (button) {
      let scope = button;
      for (let depth = 0; depth < 6 && scope && betAmount === null; depth++, scope = scope.parentElement) {
        const candidates = [...scope.querySelectorAll('input,[role="spinbutton"],[contenteditable="true"]')]
          .filter(element => isVisible(element))
          .filter(element => !/inicial|initial|payout|multiplicador|multiplier/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('placeholder') || ''}`));
        const candidate = candidates.find(element => /aposta|bet|valor|amount|stake/i.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('placeholder') || ''}`)) || candidates[0];
        if (candidate) {
          const parsed = parseLocalizedNumber(candidate.value ?? candidate.textContent);
          if (Number.isFinite(parsed) && parsed > 0) betAmount = parsed;
        }
      }
    }
    let liveMultiplier = null;
    if (betActive) {
      const multiplierPattern = /^(\d+(?:[.,]\d+)?)\s*[×x]$/i;
      const multiplier = [...document.querySelectorAll('body *')]
        .filter(element => element.children.length === 0 && isVisible(element))
        .map(element => ({ element, text: element.textContent.trim(), rect: element.getBoundingClientRect() }))
        .filter(item => multiplierPattern.test(item.text) && !item.element.closest('.crash-banner,[class*="history" i],[class*="record" i]'))
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
      if (multiplier) liveMultiplier = Number(multiplier.text.replace(',', '.').replace(/[×x]/i, '').trim());
    }
    return {
      captured_at: new Date().toISOString(),
      balance: wallet ? parseLocalizedNumber(wallet[1]) : null,
      currency: wallet ? wallet[2].toUpperCase() : null,
      bet_active: betActive,
      round_id: latestCapturedRoundId,
      bet_amount: betAmount,
      live_multiplier: Number.isFinite(liveMultiplier) ? liveMultiplier : null,
      status: `${betActive ? 'aposta ativa' : 'sem aposta'}${latestCapturedRoundId ? ` · rodada ${latestCapturedRoundId}` : ''}${Number.isFinite(betAmount) ? ` · valor ${betAmount}` : ''}`
    };
  }

  function sendAccountStatus() {
    const accountStatus = readWalletStatus();
    const key = [accountStatus.balance, accountStatus.currency, accountStatus.bet_active, accountStatus.round_id, accountStatus.bet_amount, accountStatus.live_multiplier, accountStatus.status].join('|');
    const now = Date.now();
    if ((key === lastAccountStatusKey && now - lastAccountStatusSentAt < 3000) || stopped) return;
    lastAccountStatusKey = key;
    lastAccountStatusSentAt = now;
    const payload = { source: 'bc-game-crash-extension', rows: [], account_status: accountStatus };
    fetch(receiverEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload)
    }).catch(() => {});
    if (extensionAlive()) {
      try { runtime.sendMessage({ type: 'account-status', accountStatus }).catch(() => {}); }
      catch { }
    }
  }

  function add(rows, id, value) {
    const multiplier = Number(String(value).replace(',', '.'));
    if (!idRe.test(id) || !Number.isFinite(multiplier) || multiplier <= 0 || seen.has(id)) return;
    seen.add(id);
    rows.push({ id, multiplier, captured_at: new Date().toISOString() });
  }

  function scan() {
    if (stopped) return;
    const text = document.body ? document.body.innerText : "";
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    sendLiveMetrics(lines);
    const rows = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!idRe.test(lines[i])) continue;
      const match = lines[i + 1].match(multRe);
      if (!match) continue;
      add(rows, lines[i], match[1]);
    }
    // A tabela "Histórico" traz: ID da rodada, resultado e hash. Este formato
    // continua disponível mesmo quando o banner ao vivo exibe só multiplicadores.
    const historyRe = /\b(\d{6,})\s+(\d+(?:[.,]\d+)?)\s+(?=[a-f0-9]{32,}\b)/gi;
    for (const match of text.matchAll(historyRe)) add(rows, match[1], match[2]);
    // A aba Histórico > Análise exibe o ID e o multiplicador sem o hash,
    // podendo colocá-los na mesma linha ou em linhas separadas. Capturar os
    // dois formatos garante que a recuperação histórica realmente envie as
    // páginas percorridas ao receptor local.
    const analysisRe = /\b(\d{7,8})\s+(\d+(?:[.,]\d+)?)\s*[×x]/gi;
    for (const match of text.matchAll(analysisRe)) add(rows, match[1], match[2]);
    // Vincula o último snapshot de volume à próxima rodada nova observada.
    // Durante a recuperação histórica não fazemos associação: ali as linhas
    // são antigas e o volume ao vivo poderia cair na rodada errada.
    if (!recoveringHistory && rows.length) {
      const latest = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0);
      if (latest) latestCapturedRoundId = latest;
      if (latest && lastLiveRoundId === null) {
        lastLiveRoundId = latest;
      } else if (latest && latest > lastLiveRoundId) {
        const metricAge = pendingLiveMetrics?.captured_at ? Date.now() - new Date(pendingLiveMetrics.captured_at).getTime() : Infinity;
        const target = rows.find(row => Number(row.id) === latest);
        if (target && pendingLiveMetrics && metricAge >= -5000 && metricAge <= 120000) {
          target.active_players = pendingLiveMetrics.active_players;
          target.total_players = pendingLiveMetrics.total_players;
          target.total_amount_brl = pendingLiveMetrics.total_amount_brl;
          target.total_amount_display = pendingLiveMetrics.total_amount_display;
          target.volume_captured_at = pendingLiveMetrics.captured_at;
          pendingLiveMetrics = null;
        }
        lastLiveRoundId = latest;
      }
    }
    sendRows(rows);
    // Depois de atualizar a última rodada, o próximo status já identifica
    // exatamente a rodada que o painel deve validar.
    sendAccountStatus();
  }

  // Recupera pela aba pública Histórico > Análise. Ela expõe uma janela de
  // 2.000 rodadas em páginas numeradas (ex.: "01 of 134"), sem depender de
  // "Mostrar Mais", que pertence à lista de jogadores e não ao histórico.
  function restoreLiveHistory() {
    const button = [...document.querySelectorAll('button')]
      .find(el => el.getAttribute('role') !== 'tab' && el.textContent.trim() === 'Histórico');
    button?.click();
  }
  function recoverHistory() {
    if (stopped) return;
    if (recoveringHistory) return;
    recoveringHistory = true;
    const historyTab = [...document.querySelectorAll('button,[role="tab"]')]
      .find(el => el.textContent.trim() === 'Histórico');
    historyTab?.click();
    let attempts = 0;
    recoveryTimer = setInterval(() => {
      scan();
      const pageLabel = [...document.querySelectorAll('body *')]
        .find(el => /^\d{1,3}\s+of\s+\d{1,3}$/.test(el.textContent.trim()));
      if (!pageLabel) {
        const analysisTab = [...document.querySelectorAll('button')]
          .find(el => el.textContent.trim() === 'Análise');
        if (analysisTab && attempts++ < 15) {
          analysisTab.click();
          return;
        }
        clearInterval(recoveryTimer);
        recoveryTimer = undefined;
        recoveringHistory = false;
        restoreLiveHistory();
        return;
      }
      const [, current, total] = pageLabel.textContent.trim().match(/^(\d+)\s+of\s+(\d+)$/) || [];
      // A paginação atual coloca o indicador e a seta em contêineres irmãos.
      // Procuramos até três níveis acima e usamos o último botão do conjunto:
      // na página 1 ele é o único botão; nas seguintes é a seta para avançar.
      // A versão anterior consultava somente o pai imediato do rótulo e nunca
      // encontrava a seta, portanto ficava presa em "01 of 134".
      let paginationRoot = pageLabel;
      let paginationButtons = [];
      for (let depth = 0; depth < 3 && paginationRoot; depth += 1) {
        paginationRoot = paginationRoot.parentElement;
        paginationButtons = [...(paginationRoot?.querySelectorAll('button') || [])]
          .filter(button => isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
        if (paginationButtons.length) break;
      }
      const next = paginationButtons.at(-1);
      if (!current || !total || Number(current) >= Number(total) || attempts++ >= 150 || !next) {
        clearInterval(recoveryTimer);
        recoveryTimer = undefined;
        recoveringHistory = false;
        restoreLiveHistory();
        return;
      }
      next.click();
    }, 750);
  }

  // A auditoria local só solicita esta carga quando encontra uma lacuna nos
  // últimos 2.000 IDs. O listener não opera apostas; apenas abre a seção
  // pública de Histórico > Análise e percorre as páginas da janela de 2.000.
  try {
    runtime?.onMessage?.addListener(message => {
      if (message?.type === 'recover-history') recoverHistory();
    });
  } catch { stop(); }

  function scheduleScan() {
    if (stopped || scanScheduled) return;
    const minimumGap = recoveringHistory ? 500 : 2000;
    const delay = Math.max(0, minimumGap - (Date.now() - lastScheduledScanAt));
    scanScheduled = setTimeout(() => {
      scanScheduled = undefined;
      lastScheduledScanAt = Date.now();
      scan();
    }, delay);
  }
  scan();
  lastScheduledScanAt = Date.now();
  // A recuperação histórica é acionada somente pelo background quando a
  // auditoria encontrar uma lacuna. Rodar isso automaticamente em toda aba
  // nova deixava a captura presa no histórico e parava o fluxo ao vivo.
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scanTimer = setInterval(scheduleScan, 2500);
  // A aba dedicada aberta pelo watchdog precisa ficar em Histórico para
  // expor IDs e payouts continuamente, não na lista padrão de jogadores.
  if (new URLSearchParams(location.search).get('collector_recovery') === '1') {
    let attempts = 0;
    const selectHistoryTimer = setInterval(() => {
      if (recoveringHistory) return;
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find(el => el.textContent.trim() === 'Histórico');
      if (tab) {
        if (tab.getAttribute('aria-selected') !== 'true') tab.click();
        clearInterval(selectHistoryTimer);
        // A aba de recuperação precisa iniciar também o percurso de
        // Histórico > Análise. Antes, ela apenas selecionava Histórico e
        // ficava parada na primeira página, deixando lacunas no coletor.
        setTimeout(() => recoverHistory(), 1800);
      } else if (++attempts >= 30) clearInterval(selectHistoryTimer);
    }, 1000);
  }
})();
