(function () {
  'use strict';
  const finance = globalThis.CrashMapFinance;
  if (!finance) throw new Error('O módulo financeiro do mapa não foi carregado');
  const keys = ['green', 'yellow', 'red'];
  const int = value => Number(value).toLocaleString('pt-BR');
  const pct = (value, total) => total ? `${(100 * value / total).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
  const units = value => `(${value < -1e-8 ? '-' : '+'}${Math.abs(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  const tone = value => value > 1e-8 ? 'score-positive' : value < -1e-8 ? 'score-negative' : 'score-neutral';
  let cache = null;
  let suppressLegacyMap = false;

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
      cfg.cycleMode, cfg.levelMode, gap, windowSize()].join('|');
    if (cache?.key === key) return cache.value;
    const signals = {};
    for (const event of analyze(source).events) {
      if (event.color !== 'pending') signals[event.roundId] = mapEventSignal(event);
    }
    const all = finance.project(source, cfg, gap, signals);
    const size = windowSize();
    const selected = size === Infinity ? all.events : all.events.slice(-size);
    const summary = finance.summarise(selected, cfg);
    const value = { selected, summary, cfg, gap, all };
    cache = { key, value };
    return value;
  }
  function drawBalls(selected) {
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
      return `<span class="ball ${event.color}${classes}" data-round-id="${event.roundId}" data-round-time="${event.capturedAt || ''}" data-round-amount="${amount ? encodeURIComponent(String(amount)) : ''}" title="Rodada ${event.roundId}">${content}</span>`;
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
    target.innerHTML = `<table><thead><tr><th>Sinal</th><th class="signal-green" aria-label="Sinal verde">●</th><th class="signal-yellow" aria-label="Sinal amarelo">●</th><th class="signal-red" aria-label="Sinal vermelho">●</th><th>Total</th></tr></thead><tbody><tr class="score-win-row"><th>Win</th>${keys.map(key => cell(key, 'wins', true)).join('')}${overall('wins', true)}</tr>${cycleRows}<tr><th>Loss após ${cfg.cycleRounds * cfg.recoveries}</th>${keys.map(key => cell(key, 'losses')).join('')}${overall('losses')}</tr></tbody></table>`;
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
      drawBalls(selected);
      drawScore(summary, cfg);
      drawCycleTable(summary, cfg);
      drawMetrics(summary);
      drawHeat(summary);
      const active = windowSize() === Infinity ? 'all' : String(windowSize());
      document.querySelectorAll('#mapView [data-count]').forEach(button => button.classList.toggle('active', button.dataset.count === active));
      const note = document.querySelector('#mapPageNote');
      if (note) note.textContent = `${selected.length} sequências · ${summary.wins} wins · ${summary.losses} losses · ${summary.estimated} resultado(s) estimado(s) por gaps de até ${gap} rodadas · ${all.availableRounds} rodadas disponíveis`;
    } catch (error) {
      console.error('Falha no cálculo financeiro do mapa', error);
      for (const selector of ['#signalScore', '#cycleTable', '#mapMetrics', '#heatRows']) {
        const target = document.querySelector(selector);
        if (target) target.textContent = 'Cálculo indisponível. Verifique os dados desta janela.';
      }
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
      const summary = finance.summarise(finance.project(sample, cfg, simulationGapLimit()).events, cfg);
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
  // A seleção de 20 é dinâmica: vinte sequências, independentemente do R configurado.
  window.addEventListener('load', () => { cache = null; draw(); });
})();
