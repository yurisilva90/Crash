(function () {
  'use strict';
  const finance = globalThis.CrashMapFinance;
  const frequency = globalThis.CrashSignalFrequency;
  if (!finance) throw new Error('O módulo financeiro do mapa não foi carregado');
  if (!frequency) throw new Error('O módulo de frequência do farol não foi carregado');
  const keys = ['green', 'yellow', 'blue', 'red', 'unknown'];
  const int = value => Number(value).toLocaleString('pt-BR');
  const pct = (value, total) => total ? `${(100 * value / total).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
  const units = value => `(${value < -1e-8 ? '-' : '+'}${Math.abs(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  const tone = value => value > 1e-8 ? 'score-positive' : value < -1e-8 ? 'score-negative' : 'score-neutral';
  let cache = null;
  let historyCache = null;
  let panelCache = null;
  let trendCache = null;
  let suppressLegacyMap = false;

  function trendRecords(payout, gap) {
    const sources = [historicalRows, mapRows, rows];
    const key = [...sources.map(source => `${source?.length || 0}:${source?.[0]?.round_id || ''}:${source?.at(-1)?.round_id || ''}`), payout, gap].join('|');
    if (trendCache?.key === key && trendCache.snapshot === snapshot) return trendCache.value;
    const combined = new Map();
    for (const source of sources) {
      for (const row of source || []) combined.set(Number(row.round_id), row);
    }
    const source = [...combined.values()].filter(row => Number.isFinite(Number(row.round_id)));
    const value = frequency.trendAtAnchors(source, payout, gap, 500, 5000).byRoundId;
    trendCache = { key, snapshot, value };
    return value;
  }

  function trendStamp(event, records) {
    if (activeStrategy === '2x') return '';
    const trend = records[event.anchorRoundId];
    if (!trend?.level) return '';
    const direction = trend.level > 0 ? 'up' : 'down';
    const steps = Math.abs(trend.level);
    const threshold = steps === 2 ? 20 : 10;
    const label = `Frequência ${direction === 'up' ? 'acima' : 'abaixo'} da média histórica em pelo menos ${threshold}% nas 500 rodadas antes do ciclo${trend.estimated ? ' (estimada por gaps)' : ''}`;
    return `<span class="frequency-stamp ${direction}" aria-label="${label}" title="${label}">${'<i></i>'.repeat(steps)}</span>`;
  }

  function windowSize() {
    return window.mapPanelWindow === Infinity ? Infinity : Math.max(1, Number(window.mapPanelWindow) || 50);
  }
  function sourceRows() {
    const size = windowSize();
    const source = size === Infinity
      ? (historicalRows.length
        ? [...new Map([...historicalRows, ...mapRows, ...rows]
          .filter(row => Number(row.round_id) >= 9000000 && Number(row.round_id) <= 9999999)
          .map(row => [String(row.round_id), row])).values()]
        : mapRows.length ? mapRows : rows)
      : size >= 500 && mapRows.length ? mapRows : rows;
    return filteredRows(source);
  }
  function projection() {
    const source = sourceRows();
    const cfg = config();
    const gap = simulationGapLimit();
    const key = [source.length, source[0]?.round_id, source.at(-1)?.round_id,
      cfg.payout, cfg.cycleRounds, cfg.recoveries, cfg.levels,
      cfg.cycleMode, cfg.levelMode, cfg.recoveryDivider, gap, windowSize()].join('|');
    if (cache?.key === key && cache.snapshot === snapshot) return cache.value;
    const signals = frequency.calculate(source, cfg.payout, gap);
    const all = finance.project(source, cfg, gap, signals.byRoundId);
    const size = windowSize();
    const selected = size === Infinity ? all.events : all.events.slice(-size);
    const summary = finance.summarise(selected, cfg);
    const value = { selected, summary, cfg, gap, all, signals, source };
    cache = { key, value, snapshot };
    return value;
  }

  function panelProjection() {
    const source = filteredRows(rows);
    const cfg = config();
    const gap = simulationGapLimit();
    const key = [source.length, source[0]?.round_id, source.at(-1)?.round_id,
      cfg.payout, cfg.cycleRounds, cfg.recoveries, cfg.levels,
      cfg.cycleMode, cfg.levelMode, cfg.recoveryDivider, gap].join('|');
    if (panelCache?.key === key && panelCache.snapshot === snapshot) return panelCache.value;
    const signals = frequency.calculate(source, cfg.payout, gap);
    const value = { all: finance.project(source, cfg, gap, signals.byRoundId), source, cfg, gap };
    panelCache = { key, snapshot, value };
    return value;
  }
  function drawBalls(selected, trends) {
    const target = document.querySelector('#balls');
    if (!target) return;
    hideRoundTooltip();
    const visible = selected.slice(-1000).reverse();
    target.classList.remove('compact-2x');
    target.innerHTML = visible.map(event => {
      const row = event.row || {};
      const amount = row.total_amount_display || (row.total_amount_brl != null
        ? `R$ ${Number(row.total_amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
      const signal = event.signal === 'green' ? 'green-win' : event.signal;
      const classes = showBallSignals ? ` signal-${signal} signal-enabled` : '';
      const content = ballDisplay === 'payout' && !event.pending ? `${event.payoutLabel}x` : event.label;
      return `<span class="ball ${event.color}${classes}" data-round-id="${event.roundId}" data-round-time="${event.capturedAt || ''}" data-round-amount="${amount ? encodeURIComponent(String(amount)) : ''}" title="Rodada ${event.roundId}">${content}${trendStamp(event, trends)}</span>`;
    }).join('') || '<span class="map-filter-empty">Nenhum ciclo concluído neste recorte.</span>';
  }
  function drawScore(summary, cfg) {
    const target = document.querySelector('#signalScore');
    if (!target) return;
    const total = summary.wins + summary.losses;
    const cell = (key, field, showProfit = false) => {
      const bucket = summary.buckets[key];
      const number = field === 'wins' ? bucket.wins : bucket.losses;
      const bucketTotal = bucket.wins + bucket.losses;
      return `<td><strong class="${showProfit ? tone(bucket.profit) : ''}">${int(number)}</strong><small>${pct(number, bucketTotal)}</small>${showProfit ? `<small class="score-profit ${tone(bucket.profit)}">${summary.estimated ? '≈' : ''}${units(bucket.profit)}</small>` : ''}</td>`;
    };
    const overall = (field, showProfit = false) => {
      const number = summary[field];
      return `<td><strong class="${showProfit ? tone(summary.profit) : ''}">${int(number)}</strong><small>${pct(number, total)}</small>${showProfit ? `<small class="score-profit ${tone(summary.profit)}">${summary.estimated ? '≈' : ''}${units(summary.profit)}</small>` : ''}</td>`;
    };
    const cycleRows = Array.from({ length: cfg.recoveries }, (_, cycle) => {
      const begin = cycle * cfg.cycleRounds + 1;
      const end = (cycle + 1) * cfg.cycleRounds;
      const count = keys.reduce((sum, key) => sum + (summary.buckets[key].cycleWins[cycle] || 0), 0);
      return `<tr><th>${begin}–${end}</th>${keys.map(key => `<td>${int(summary.buckets[key].cycleWins[cycle] || 0)}</td>`).join('')}<td>${int(count)}</td></tr>`;
    }).join('');
    const labels = { green: '250 e 1.000', yellow: 'Só 250', blue: 'Só 1.000', red: 'Nenhum', unknown: 'Sem dados' };
    const headings = keys.map(key => `<th class="signal-${key}" aria-label="${labels[key]}" title="${labels[key]}">${key === 'unknown' ? '?' : '●'}</th>`).join('');
    target.innerHTML = `<table><thead><tr><th>Sinal</th>${headings}<th>Total</th></tr></thead><tbody><tr class="score-win-row"><th>Win</th>${keys.map(key => cell(key, 'wins', true)).join('')}${overall('wins', true)}</tr>${cycleRows}<tr><th>Loss após ${cfg.cycleRounds * cfg.recoveries}</th>${keys.map(key => cell(key, 'losses')).join('')}${overall('losses')}</tr></tbody></table>`;
  }
  function drawCycleTable(summary, cfg) {
    const target = document.querySelector('#cycleTable');
    if (!target) return;
    const head = Array.from({ length: cfg.recoveries }, (_, cycle) => `<th>C${cycle}</th>`).join('');
    const body = summary.cells.map((row, level) => `<tr><th>N${level}</th>${row.map(cell => `<td><span class="score-number">${int(cell.wins)}W · ${int(cell.losses)}L</span><small>${pct(cell.wins, cell.wins + cell.losses)} win</small></td>`).join('')}</tr>`).join('');
    target.innerHTML = `<table><thead><tr><th>Nível</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  function drawMetrics(summary) {
    const target = document.querySelector('#mapMetrics');
    if (!target) return;
    const card = (label, value, className) => `<article class="card"><div class="label">${label}</div><div class="value ${className}">${value}</div></article>`;
    target.innerHTML = card('Resultado', `${summary.estimated ? '≈' : ''}${simulationUnits(summary.profit)}`, summary.profit >= 0 ? 'mult' : 'risk') +
      card('DD máximo', `${summary.estimated ? '≈' : ''}${simulationUnits(-summary.maxDD)}`, 'risk') +
      card('Loss médio', summary.cycleLosses ? summary.averageLoss.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—', 'risk') +
      card('Loss máximo', summary.cycleLosses ? int(summary.maxLoss) : '—', 'risk');
  }
  function drawHeat(summary) {
    const target = document.querySelector('#heatRows');
    if (!target) return;
    const maximum = Math.max(1, ...summary.heat);
    target.innerHTML = summary.heat.map((value, index) => {
      const intensity = value / maximum;
      const width = value ? Math.max(1, intensity * 87) : 0;
      return `<div class="heat-row" role="listitem" aria-label="Rodada ${index + 1}: ${value} ganhos"><span class="heat-position">${index + 1}</span><div class="heat-bar-area"><div class="heat-track" style="width:${width}%"><div class="heat-fill" style="background:${heatColor(intensity)}"></div></div><span class="heat-value">${int(value)}</span></div></div>`;
    }).join('');
  }
  function draw() {
    if (!snapshot) return;
    try {
      const { selected, summary, cfg, gap, all } = projection();
      const panel = panelProjection();
      const trends = activeStrategy === '2x' ? {} : trendRecords(cfg.payout, gap);
      drawBalls(selected, trends);
      drawRecent(panel.all.events, trends);
      drawPanelCards(panel.all, panel.source, panel.cfg);
      drawScore(summary, cfg);
      drawCycleTable(summary, cfg);
      drawMetrics(summary);
      drawHeat(summary);
      const active = windowSize() === Infinity ? 'all' : String(windowSize());
      document.querySelectorAll('#mapView [data-count]').forEach(button => button.classList.toggle('active', button.dataset.count === active));
      const note = document.querySelector('#mapPageNote');
      if (note) note.textContent = `${selected.length} sequências · ${summary.wins} wins · ${summary.losses} losses · ${summary.estimated} resultado(s) estimado(s) por gaps de até ${gap} rodadas · ${all.availableRounds} rodadas disponíveis`;
      try { drawHistory(cfg, gap); }
      catch (error) { console.error('Falha nos indicadores históricos do painel', error); }
    } catch (error) {
      console.error('Falha no cálculo financeiro do mapa', error);
      for (const selector of ['#signalScore', '#cycleTable', '#mapMetrics', '#heatRows']) {
        const target = document.querySelector(selector);
        if (target) target.textContent = 'Cálculo indisponível. Verifique os dados desta janela.';
      }
    }
  }

  function drawRecent(events, trends) {
    if (activeStrategy === '2x') return;
    const target = document.querySelector('#recentBalls');
    if (!target) return;
    target.innerHTML = events.slice(-10).reverse().map(event => {
      const row = event.row || {};
      const amount = row.total_amount_display || (row.total_amount_brl != null
        ? `R$ ${Number(row.total_amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
      const signal = event.signal === 'green' ? 'green-win' : event.signal;
      const classes = showBallSignals ? ` signal-${signal} signal-enabled` : '';
      const content = ballDisplay === 'payout' && !event.pending ? `${event.payoutLabel}x` : event.label;
      return `<span class="ball ${event.color}${classes}" data-round-id="${event.roundId}" data-round-time="${event.capturedAt || ''}" data-round-amount="${amount ? encodeURIComponent(String(amount)) : ''}" title="Rodada ${event.roundId}">${content}${trendStamp(event, trends)}</span>`;
    }).join('');
  }

  function drawPanelCards(all, source, cfg) {
    if (activeStrategy === '2x') return;
    const latest = source.at(-1);
    const multiplier = document.querySelector('#lastMultiplier');
    if (multiplier && latest) {
      multiplier.classList.toggle('mult', Number(latest.multiplier) >= cfg.payout);
      multiplier.classList.toggle('risk', Number(latest.multiplier) < cfg.payout);
    }
    const run = all.currentRun;
    const noTarget = document.querySelector('#lastSignal');
    if (noTarget) {
      const tone = run == null ? 'pending' : run <= cfg.cycleRounds ? 'green' :
        run <= cfg.cycleRounds * cfg.recoveries ? 'yellow' : 'red';
      noTarget.className = `signal ${tone}`;
      noTarget.textContent = run == null ? '—' : int(run);
    }
    const riskNote = document.querySelector('#riskNote');
    if (riskNote) riskNote.textContent = `${cfg.payout}x · ${cfg.cycleRounds}R`;
    const riskStats = document.querySelector('#riskStats');
    if (riskStats) riskStats.textContent = '';
    const outcomes = all.events.flatMap(event => event.completed || []);
    let streak = 0;
    for (let index = outcomes.length - 1; index >= 0 && outcomes[index].win; index--) streak++;
    const winStreak = document.querySelector('#winStreak');
    if (winStreak) winStreak.textContent = int(streak);
    const winNote = document.querySelector('#winStreakNote');
    if (winNote) winNote.textContent = `N0–N${cfg.levels} · C0–C${cfg.recoveries - 1} · ${cfg.cycleRounds}R`;
    const recovery = document.querySelector('#currentRisk');
    const state = all.pending;
    if (recovery) recovery.textContent = state && (state.level > 0 || state.cycle > 0)
      ? `N${state.level}C${state.cycle}` : '—';
    const recoveryNote = document.querySelector('#recoveryNote');
    if (recoveryNote) recoveryNote.textContent = state?.waitingLevel
      ? `Aguardando alvo para N${state.level}` : state
        ? `N${state.level} · C${state.cycle} · ${cfg.cycleRounds}R` : 'Sem recuperação ativa';
    const recoveryStats = document.querySelector('#recoveryStats');
    if (recoveryStats) recoveryStats.textContent = '';
  }

  function drawHistory(cfg, gap) {
    const base = filteredRows(historicalRows.length ? historicalRows : rows);
    const activeWindow = historyTab === 'wins' ? winsWindow : recoveryWindow;
    const sample = activeWindow === Infinity ? base : base.slice(-activeWindow);
    const key = [historyTab, activeWindow, sample.length, sample[0]?.round_id,
      sample.at(-1)?.round_id, cfg.payout, cfg.cycleRounds, cfg.recoveries,
      cfg.levels, cfg.cycleMode, cfg.levelMode, cfg.recoveryDivider, gap].join('|');
    let summary = historyCache?.key === key && historyCache.snapshot === snapshot
      ? historyCache.summary : null;
    if (!summary) {
      const signal = frequency.calculate(sample, cfg.payout, gap);
      summary = finance.summarise(finance.project(sample, cfg, gap, signal.byRoundId).events, cfg);
      historyCache = { key, summary, snapshot };
    }
    const label = activeWindow === Infinity ? 'Total' : int(activeWindow);
    if (historyTab === 'wins') {
      const streaks = new Map();
      let streak = 0;
      const record = () => { if (streak) streaks.set(streak, (streaks.get(streak) || 0) + 1); streak = 0; };
      for (const outcome of summary.outcomes) {
        if (outcome.win) streak++;
        else record();
      }
      record();
      const summaryNode = document.querySelector('#winsSummary');
      if (summaryNode) summaryNode.textContent = `${label} rodadas · ${summary.wins} wins · ${summary.losses} losses · ${simulationUnits(summary.profit)}`;
      const list = document.querySelector('#winsList');
      if (list) list.innerHTML = [...streaks.entries()].sort((a, b) => a[0] - b[0])
        .map(([length, count]) => `<div class="recovery-row"><span>${length} wins</span><strong>${int(count)}</strong></div>`).join('') || '<div class="note">Sem sequências concluídas neste recorte.</div>';
    } else {
      const summaryNode = document.querySelector('#recoverySummary');
      if (summaryNode) summaryNode.textContent = `${label} rodadas · ${cfg.payout}x · ${cfg.cycleRounds}R · N0–N${cfg.levels} · C0–C${cfg.recoveries - 1} · ${simulationUnits(summary.profit)}`;
      const list = document.querySelector('#recoveryList');
      if (list) list.innerHTML = summary.cells.flatMap((row, level) => row.map((cell, cycle) =>
        `<div class="recovery-row"><span>N${level} · C${cycle}</span><strong>${int(cell.wins)}W · ${int(cell.losses)}L</strong></div>`)).join('');
    }
  }

  renderMapBalls = function () { if (!suppressLegacyMap) draw(); };
  renderHeatMap = function () { if (!suppressLegacyMap) draw(); };
  renderSimulationMetrics = function () {
    const target = document.querySelector('#simulationMetrics');
    if (!target) return;
    document.querySelectorAll('[data-simulation-window]').forEach(button =>
      button.classList.toggle('active', button.dataset.simulationWindow === 'historical'
        ? simulationWindow === Infinity : Number(button.dataset.simulationWindow) === simulationWindow));
    if (!hasSimulated) {
      target.innerHTML = '<article class="card"><div class="note">Toque em “Calcular histórico” para gerar os indicadores.</div></article>';
      return;
    }
    try {
      const base = historicalRows.length ? historicalRows : rows;
      const sample = simulationWindow === Infinity ? base : base.slice(-simulationWindow);
      const cfg = config();
      const gap = simulationGapLimit();
      const signals = frequency.calculate(sample, cfg.payout, gap);
      const summary = finance.summarise(finance.project(sample, cfg, gap, signals.byRoundId).events, cfg);
      const card = (label, value, className, note = '') => `<article class="card"><div class="label">${label}</div><div class="value ${className}">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</article>`;
      target.innerHTML = card('Losses de ciclo', int(summary.cycleLosses), 'risk', `${int(summary.wins)} wins · ${int(summary.losses)} perdas finais`) +
        card('Loss médio', summary.cycleLosses ? summary.averageLoss.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—', 'risk') +
        card('Loss máximo', summary.cycleLosses ? int(summary.maxLoss) : '—', 'risk') +
        card('Resultado simulado', `${summary.estimated ? '≈' : ''}${simulationUnits(summary.profit)}`, summary.profit >= 0 ? 'mult' : 'risk') +
        card('DD máximo', `${summary.estimated ? '≈' : ''}${simulationUnits(-summary.maxDD)}`, 'risk');
    } catch (error) {
      console.error('Falha na simulação financeira', error);
      target.textContent = 'Cálculo indisponível. Verifique os dados desta janela.';
    }
  };
  const previousRender = render;
  render = function () {
    suppressLegacyMap = true;
    try { previousRender(); } finally { suppressLegacyMap = false; }
    draw();
  };
  const style = document.createElement('style');
  style.textContent = `#signalScore table{min-width:590px}#signalScore .signal-blue{color:var(--blue)}#signalScore .signal-unknown{color:var(--muted)}
    .ball.signal-blue{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--blue)!important}
    .ball.signal-unknown{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--muted)!important}
    .speed-ring.frequency-blue{background:radial-gradient(circle at center,#0d1a2b 61%,transparent 62%),conic-gradient(var(--blue) var(--meter),#273b53 0)}
    .speed-ring.frequency-yellow{background:radial-gradient(circle at center,#0d1a2b 61%,transparent 62%),conic-gradient(var(--yellow) var(--meter),#273b53 0)}
    .speed-ring.frequency-red{background:radial-gradient(circle at center,#0d1a2b 61%,transparent 62%),conic-gradient(var(--red) var(--meter),#273b53 0)}
    .speed-ring.frequency-unknown{background:radial-gradient(circle at center,#0d1a2b 61%,transparent 62%),conic-gradient(var(--muted) var(--meter),#273b53 0)}
    html[data-theme="light"] .speed-ring.frequency-blue{background:radial-gradient(circle at center,#fff 61%,transparent 62%),conic-gradient(var(--blue) var(--meter),#d8e2ed 0)}
    html[data-theme="light"] .speed-ring.frequency-yellow{background:radial-gradient(circle at center,#fff 61%,transparent 62%),conic-gradient(var(--yellow) var(--meter),#d8e2ed 0)}
    html[data-theme="light"] .speed-ring.frequency-red{background:radial-gradient(circle at center,#fff 61%,transparent 62%),conic-gradient(var(--red) var(--meter),#d8e2ed 0)}
    html[data-theme="light"] .speed-ring.frequency-unknown{background:radial-gradient(circle at center,#fff 61%,transparent 62%),conic-gradient(var(--muted) var(--meter),#d8e2ed 0)}
    #confirmShort.frequency-active{border-color:var(--yellow);color:var(--yellow)}
    #confirmLong.frequency-active{border-color:var(--blue);color:var(--blue)}
    #balls .ball,#recentBalls .ball{overflow:visible}
    .ball .frequency-stamp{position:absolute;z-index:3;top:-4px;right:-4px;display:flex;flex-direction:column;align-items:center;justify-content:center;width:11px;padding:2px 1px;border-radius:6px;border:1px solid rgba(148,235,187,.55);background:rgba(9,45,48,.94);pointer-events:none}
    .ball .frequency-stamp i{display:block;width:6px;height:4px;background:#80edaa;clip-path:polygon(0 66%,50% 0,100% 66%,100% 100%,50% 34%,0 100%)}
    .ball .frequency-stamp i+i{margin-top:-1px}
    .ball .frequency-stamp.down{border-color:rgba(255,148,166,.55);background:rgba(53,24,35,.94)}
    .ball .frequency-stamp.down i{background:#fb8299;clip-path:polygon(0 0,50% 66%,100% 0,100% 34%,50% 100%,0 34%)}`;
  document.head.append(style);

  function installFarol() {
    entrySpeedometer = function (a) {
      const gap = simulationGapLimit();
      return frequency.calculate(a.ordered, a.c.payout, gap).last;
    };
    renderSpeedometer = function (state) {
      const short = document.querySelector('#confirmShort');
      const long = document.querySelector('#confirmLong');
      if (!short || !long) return;
      const shortPass = state.ready && state.shortHits >= state.shortMin;
      const longPass = state.ready && state.longHits >= state.longMin;
      for (const [node, pass, hits, minimum, size] of [
        [short, shortPass, state.shortHits, state.shortMin, 250],
        [long, longPass, state.longHits, state.longMin, 1000]
      ]) {
        node.className = `confirmation${pass ? ' frequency-active' : ''}`;
        node.querySelector('strong').textContent = `${hits}/${minimum} · ${size.toLocaleString('pt-BR')}`;
      }
      const tone = state.tone;
      const score = Number(shortPass) + Number(longPass);
      const label = { green: '250 e 1.000', yellow: 'Só 250', blue: 'Só 1.000',
        red: 'Nenhum', unknown: 'Dados insuficientes' }[tone];
      const ring = document.querySelector('#speedRing');
      ring.style.setProperty('--meter', `${score * 50}%`);
      ring.className = `speed-ring frequency-${tone}`;
      document.querySelector('#speedScore').textContent = state.ready ? `${score}/2` : '—';
      document.querySelector('#speedLabel').textContent = label;
      document.querySelector('#speedState').textContent = `${label} · ${config().payout}x`;
      document.querySelector('#speedNote').textContent = state.estimated
        ? 'Frequência estimada: há gaps dentro das janelas.' : '';
    };
  }
  installFarol();
  // A seleção de 20 é dinâmica: vinte sequências, independentemente do R configurado.
  window.addEventListener('load', () => {
    installFarol();
    cache = null;
    render();
    if (typeof renderExposureCalculator === 'function') renderExposureCalculator();
  });
})();
