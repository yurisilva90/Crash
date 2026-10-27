(function () {
  'use strict';
  const finance = globalThis.CrashMapFinance;
  const frequency = globalThis.CrashSignalFrequency;
  if (!finance) throw new Error('O módulo financeiro do mapa não foi carregado');
  if (!frequency) throw new Error('O módulo de frequência do farol não foi carregado');
  const int = value => Number(value).toLocaleString('pt-BR');
  const pct = (value, total) => total ? `${(100 * value / total).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
  const units = value => `(${value < -1e-8 ? '-' : '+'}${Math.abs(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  const tone = value => value > 1e-8 ? 'score-positive' : value < -1e-8 ? 'score-negative' : 'score-neutral';
  let cache = null;
  let historyCache = null;
  let panelCache = null;
  let trendCache = null;
  let zoneCache = null;
  let suppressLegacyMap = false;
  const mapColumnState = {
    dimension: localStorage.getItem('crash-map-column-dimension-v1') || 'frequency',
    selected: [],
    rows: [],
    expanded: localStorage.getItem('crash-map-columns-v1') === 'expanded',
    layout: localStorage.getItem('crash-map-column-layout-v1') || 'highlight'
  };
  const mapPeriodOptions = [
    ['20', '20'], ['50', '50'], ['100', '100'], ['500', '500'],
    ['1000', '1.000'], ['5000', '5.000'], ['all', 'Total']
  ];

  function trendBucket(event, records) {
    const level = Number(records?.[event.anchorRoundId]?.level) || 0;
    if (!level) return 'flat';
    const direction = level > 0 ? 'up' : 'down';
    return `${direction}${Math.min(2, Math.abs(level))}`;
  }

  function payoutBucket(event) {
    return ['green', 'yellow', 'blue', 'red'].includes(event.signal) ? event.signal : 'red';
  }

  // É a mesma classificação do ponto discreto: alto, neutro ou baixo.
  function signalBucket(event) {
    if (event.signal === 'green') return 'high';
    if (event.signal === 'yellow' || event.signal === 'blue' || event.signal === 'orange') return 'neutral';
    return 'low';
  }

  function rowBucket(event) {
    if (event.color === 'red') return 'losses';
    if (event.partialWin) return 'partial';
    const cycle = event.completed?.at(-1)?.cycles?.at(-1)?.cycle;
    if (Number.isInteger(cycle)) return `cycle-${cycle}`;
    if (event.color === 'green') return 'cycle-0';
    if (event.color === 'yellow') return 'cycle-1';
    if (event.color === 'orange') return 'cycle-2';
    return null;
  }

  function bucketFor(event, records) {
    if (mapColumnState.dimension === 'frequency') return trendBucket(event, records);
    if (mapColumnState.dimension === 'payout') return payoutBucket(event);
    return signalBucket(event);
  }

  function selectedEvents(events, trends) {
    const selectedBuckets = mapColumnState.selected;
    const selectedRows = mapColumnState.rows;
    return events.filter(event =>
      (!selectedBuckets.length || selectedBuckets.includes(bucketFor(event, trends))) &&
      (!selectedRows.length || selectedRows.some(selectedRow => rowBucket(event) === selectedRow ||
        // A linha Win é intencionalmente só a bolinha verde clara: N0/C0.
        (selectedRow === 'wins' && event.color === 'green'))));
  }

  function trendRecords(payout, gap) {
    const sources = [historicalRows, mapRows, rows];
    const key = [...sources.map(source => `${source?.length || 0}:${source?.[0]?.round_id || ''}:${source?.at(-1)?.round_id || ''}`), payout, gap].join('|');
    if (trendCache?.key === key && trendCache.snapshot === snapshot) return trendCache.value;
    const combined = new Map();
    for (const source of sources) {
      for (const row of source || []) combined.set(Number(row.round_id), row);
    }
    const source = [...combined.values()].filter(row => {
      const id = Number(row.round_id);
      return id >= 9000000 && id <= 9999999;
    });
    const value = frequency.trendAtAnchors(source, payout, gap, 500, 500).byRoundId;
    trendCache = { key, snapshot, value };
    return value;
  }

  // Contagem móvel de 2.000 rodadas no ponto que antecede cada ciclo.
  // As faixas são proporcionais ao payout para preservar a mesma leitura em 20x e 30x.
  function zoneRecords(payout) {
    const target = Math.max(1.01, Number(payout) || 20);
    const sources = [historicalRows, mapRows, rows];
    const key = [...sources.map(source => `${source?.length || 0}:${source?.[0]?.round_id || ''}:${source?.at(-1)?.round_id || ''}`), target].join('|');
    if (zoneCache?.key === key && zoneCache.snapshot === snapshot) return zoneCache.value;
    const ordered = [...new Map(sources.flat().filter(row => Number.isFinite(Number(row?.round_id)))
      .map(row => [Number(row.round_id), row])).values()]
      .filter(row => Number(row.round_id) >= 9000000 && Number(row.round_id) <= 9999999)
      .sort((a, b) => Number(a.round_id) - Number(b.round_id));
    const scale = 20 / target;
    const limits = [80 * scale, 90 * scale, 100 * scale];
    const byRoundId = {};
    const window = [];
    let hits = 0;
    for (const row of ordered) {
      const hit = Number(row.multiplier) >= target;
      window.push(hit);
      if (hit) hits++;
      if (window.length > 2000 && window.shift()) hits--;
      if (window.length < 2000) continue;
      byRoundId[Number(row.round_id)] = hits < limits[0] ? 'under' : hits < limits[1] ? 'mid' :
        hits < limits[2] ? 'upper' : 'over';
    }
    const value = byRoundId;
    zoneCache = { key, snapshot, value };
    return value;
  }

  function signalDotTone(signal) {
    if (signal === 'green') return 'high';
    if (signal === 'yellow' || signal === 'blue' || signal === 'orange') return 'neutral';
    return signal === 'red' ? 'low' : '';
  }

  function trendStamp(event, records) {
    if (activeStrategy === '2x' || ballIndicatorMode === 'zone') return '';
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
      cfg.cycleMode, cfg.levelMode, cfg.levelRecoveries, cfg.recoveryDivider, gap, windowSize()].join('|');
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
      cfg.cycleMode, cfg.levelMode, cfg.levelRecoveries, cfg.recoveryDivider, gap].join('|');
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
    const matching = event => selectedEvents([event], trends).length === 1;
    const filtering = Boolean(mapColumnState.selected.length || mapColumnState.rows.length);
    const visible = (mapColumnState.layout === 'grouped' && filtering
      ? selected.filter(matching) : selected).slice(-1000).reverse();
    const zones = ballIndicatorMode === 'zone' ? zoneRecords(config().payout) : null;
    target.classList.remove('compact-2x');
    target.innerHTML = visible.map(event => {
      const row = event.row || {};
      const amount = row.total_amount_display || (row.total_amount_brl != null
        ? `R$ ${Number(row.total_amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
      const signal = event.signal === 'green' ? 'green-win' : (event.signal === 'unknown' ? 'red' : event.signal);
      const signalOutline = showBallSignals && ballIndicatorMode !== 'zone' ? ` signal-${signal} signal-enabled` : '';
      const zone = zones?.[event.anchorRoundId];
      const zoneClass = zone ? ` zone-${zone}` : '';
      const content = ballDisplay === 'payout' && !event.pending ? `${event.payoutLabel}x` : event.label;
      const muted = filtering && mapColumnState.layout === 'highlight' && !matching(event) ? ' map-filter-muted' : '';
      const state = event.partialWin ? ` · win parcial; falta ${event.remainingDebt.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} u.` : '';
      const dotTone = signalDotTone(event.signal);
      const dot = showBallSignals && dotTone ? `<i class="map-signal-dot ${dotTone}" aria-hidden="true"></i>` : '';
      return `<span class="ball ${event.color}${signalOutline}${zoneClass}${muted}" data-round-id="${event.roundId}" data-round-time="${event.capturedAt || ''}" data-round-amount="${amount ? encodeURIComponent(String(amount)) : ''}" title="Rodada ${event.roundId}${state}">${content}${trendStamp(event, trends)}${dot}</span>`;
    }).join('') || '<span class="map-filter-empty">Nenhum ciclo concluído neste recorte.</span>';
  }
  function drawScore(selected, cfg, trends, filteredSummary) {
    const target = document.querySelector('#signalScore');
    if (!target) return;
    const frequencyColumns = [
      ['up1', 'Frequência +10%', 'up', 1], ['up2', 'Frequência +20% ou mais', 'up', 2],
      ['flat', 'Frequência dentro da média', 'flat', 0],
      ['down1', 'Frequência −10%', 'down', 1], ['down2', 'Frequência −20% ou menos', 'down', 2]
    ];
    const payoutColumns = [
      ['green', '250 e 1.000 ativos', 'green'], ['yellow', 'Somente 250 ativo', 'yellow'],
      ['blue', 'Somente 1.000 ativo', 'blue'], ['red', 'Nenhum payout ativo', 'red']
    ];
    const signalColumns = [
      ['high', 'Sinal alto', 'high'], ['neutral', 'Sinal neutro', 'neutral'], ['low', 'Sinal baixo', 'low']
    ];
    const columns = mapColumnState.dimension === 'frequency' ? frequencyColumns
      : mapColumnState.dimension === 'payout' ? payoutColumns : signalColumns;
    const shownColumns = mapColumnState.expanded ? columns : [];
    const groups = Object.fromEntries(columns.map(([key]) => [key, []]));
    for (const event of selected) groups[bucketFor(event, trends)]?.push(event);
    const summaries = Object.fromEntries(columns.map(([key]) => [key, finance.summarise(groups[key], cfg)]));
    // O Total mostra somente as colunas/linhas acesas. As outras colunas
    // continuam na tabela para comparação, mas não entram no recorte final.
    const summary = filteredSummary || finance.summarise(selectedEvents(selected, trends), cfg);
    const total = summary.directWins + summary.losses;
    const marker = ([key, label, direction, steps]) => {
      const isFrequency = mapColumnState.dimension === 'frequency';
      const stamp = isFrequency && direction !== 'flat'
        ? `<span class="frequency-stamp ${direction}">${'<i></i>'.repeat(steps)}</span>` : '';
      const flat = isFrequency && key === 'flat' ? ' flat-marker' : '';
      return `<span class="map-column-marker ${isFrequency ? 'frequency-marker' : `signal-${key}`}${flat}" aria-hidden="true">${stamp}</span>`;
    };
    const columnClass = key => !mapColumnState.selected.length ? '' : (mapColumnState.selected.includes(key) ? ' map-active' : ' map-dim');
    const rowClass = key => !mapColumnState.rows.length ? '' : (mapColumnState.rows.includes(key) ? ' map-active' : ' map-dim');
    const cell = (key, field, showProfit = false) => {
      const bucket = summaries[key];
      const number = field === 'directWins' ? bucket.directWins : bucket.losses;
      const bucketTotal = bucket.directWins + bucket.losses;
      return `<td data-map-column="${key}" class="${columnClass(key)}"><strong class="${showProfit ? tone(bucket.profit) : ''}">${int(number)}</strong><small>${pct(number, bucketTotal)}</small>${showProfit ? `<small class="score-profit ${tone(bucket.profit)}">${bucket.estimated ? '≈' : ''}${units(bucket.profit)}</small>` : ''}</td>`;
    };
    const overall = (field, showProfit = false) => {
      const number = field === 'directWins' ? summary.directWins : summary[field];
      return `<td><strong class="${showProfit ? tone(summary.profit) : ''}">${int(number)}</strong><small>${pct(number, total)}</small>${showProfit ? `<small class="score-profit ${tone(summary.profit)}">${summary.estimated ? '≈' : ''}${units(summary.profit)}</small>` : ''}</td>`;
    };
    // A seleção das colunas serve para o placar Win/Loss e para o Total.
    // A grade de ciclos, porém, é referência de profundidade: ela nunca deve
    // desaparecer, nem escurecer, quando o usuário está comparando colunas.
    const cycleSummary = finance.summarise(selected.filter(event =>
      !mapColumnState.selected.length || mapColumnState.selected.includes(bucketFor(event, trends))
    ), cfg);
    const cycleCell = (item, level, cycle, extraClass = '') => {
      const result = item.cells[level]?.[cycle] || { directWins: 0, recoveryWins: 0, losses: 0 };
      const total = result.directWins + result.recoveryWins + result.losses;
      return `<span class="map-cycle-value ${extraClass}"><strong>${int(result.directWins)}W · ${int(result.recoveryWins)}R · ${int(result.losses)}L</strong><small>${pct(result.directWins, total)} diretos</small></span>`;
    };
    const cycleRows = cycleSummary.cells.map((_, level) => Array.from({ length: cfg.recoveries }, (_, cycle) => {
      const levelLabel = cycle === 0 ? `<span>N${level}</span>` : '<span aria-hidden="true"></span>';
      return `<tr class="map-cycle-row"><th class="map-level-cycle-head">${levelLabel}<b>C${cycle}</b></th><td colspan="${shownColumns.length + 1}"><div class="map-cycle-values" style="--cycle-columns:${columns.length + 1}">${columns.map(([key]) => cycleCell(summaries[key], level, cycle)).join('')}${cycleCell(cycleSummary, level, cycle, 'map-cycle-total')}</div></td></tr>`;
    }).join('')).join('');
    const layoutTitle = mapColumnState.layout === 'grouped' ? 'Agrupar somente as bolinhas selecionadas' : 'Manter a sequência e apenas realçar as bolinhas selecionadas';
    const activePeriod = windowSize() === Infinity ? 'all' : String(windowSize());
    const periodOptions = mapPeriodOptions.map(([value, label]) => `<option value="${value}" ${value === activePeriod ? 'selected' : ''}>${label}</option>`).join('');
    const detailTitle = mapColumnState.expanded ? 'Recolher colunas detalhadas' : 'Mostrar colunas detalhadas';
    const detailControls = `<button type="button" class="map-selection-layout ${mapColumnState.layout}" aria-label="${layoutTitle}" title="${layoutTitle}"><span></span><span></span><span></span></button><div class="map-score-tabs" role="tablist" aria-label="Parâmetro das colunas"><button type="button" data-map-dimension="frequency" role="tab" aria-selected="${mapColumnState.dimension === 'frequency'}" title="Frequência">Freq</button><button type="button" data-map-dimension="payout" role="tab" aria-selected="${mapColumnState.dimension === 'payout'}" title="Payout">Pay</button><button type="button" data-map-dimension="signal" role="tab" aria-selected="${mapColumnState.dimension === 'signal'}" title="Sinal alto, neutro ou baixo">Sig</button></div>`;
    const columnCount = shownColumns.length + 2;
    target.innerHTML = `<div class="map-score-controls"><label class="map-period-control"><span>Período:</span><select class="map-period-select" aria-label="Período do mapa" title="Período do mapa">${periodOptions}</select></label><div class="map-score-actions"><button type="button" class="map-columns-toggle ${mapColumnState.expanded ? 'expanded' : ''}" aria-label="${detailTitle}" title="${detailTitle}"><span></span><span></span><span></span></button>${detailControls}</div></div><table><thead><tr><th class="map-row-head" data-map-row="" title="Limpar filtro">Sinal</th>${shownColumns.map(([key, label, direction, steps]) => `<th class="map-column-head${columnClass(key)}" data-map-column="${key}" aria-pressed="${mapColumnState.selected.includes(key)}" aria-label="${label}" title="${label}">${marker([key, label, direction, steps])}</th>`).join('')}<th><button type="button" class="map-total-filter ${!mapColumnState.selected.length && !mapColumnState.rows.length ? 'selected' : ''}" data-map-column="" aria-label="Mostrar todos" title="Mostrar todos">Total</button></th></tr></thead><tbody><tr class="score-win-row${rowClass('wins')}"><th class="map-row-head" data-map-row="wins" aria-pressed="${mapColumnState.rows.includes('wins')}" title="Filtrar somente wins diretos">Win direto</th>${shownColumns.map(([key]) => cell(key, 'directWins', true)).join('')}${overall('directWins', true)}</tr><tr class="map-loss-row${rowClass('losses')}"><th class="map-row-head" data-map-row="losses" aria-pressed="${mapColumnState.rows.includes('losses')}" title="Filtrar losses">Loss</th>${shownColumns.map(([key]) => cell(key, 'losses')).join('')}${overall('losses')}</tr><tr class="map-cycle-section"><th colspan="${columnCount}">Ciclos · W direto · R recuperação · L loss</th></tr>${cycleRows}</tbody></table>`;
    target.querySelectorAll('[data-map-column]').forEach(button => button.addEventListener('click', () => {
      const key = button.dataset.mapColumn || null;
      mapColumnState.selected = key === null ? [] : (mapColumnState.selected.includes(key) ? mapColumnState.selected.filter(item => item !== key) : [...mapColumnState.selected, key]);
      if (key === null) mapColumnState.rows = [];
      draw();
    }));
    target.querySelectorAll('[data-map-row]').forEach(node => node.addEventListener('click', () => {
      const key = node.dataset.mapRow || null;
      mapColumnState.rows = key === null ? [] : (mapColumnState.rows.includes(key) ? mapColumnState.rows.filter(item => item !== key) : [...mapColumnState.rows, key]);
      if (key === null) mapColumnState.selected = [];
      draw();
    }));
    target.querySelectorAll('[data-map-dimension]').forEach(button => button.addEventListener('click', () => {
      mapColumnState.dimension = button.dataset.mapDimension;
      mapColumnState.selected = [];
      localStorage.setItem('crash-map-column-dimension-v1', mapColumnState.dimension);
      draw();
    }));
    target.querySelector('.map-columns-toggle')?.addEventListener('click', () => {
      mapColumnState.expanded = !mapColumnState.expanded;
      if (!mapColumnState.expanded) mapColumnState.selected = [];
      localStorage.setItem('crash-map-columns-v1', mapColumnState.expanded ? 'expanded' : 'collapsed');
      draw();
    });
    target.querySelector('.map-selection-layout')?.addEventListener('click', () => {
      mapColumnState.layout = mapColumnState.layout === 'grouped' ? 'highlight' : 'grouped';
      localStorage.setItem('crash-map-column-layout-v1', mapColumnState.layout);
      draw();
    });
    target.querySelector('.map-period-select')?.addEventListener('change', event => {
      const value = event.target.value;
      window.mapPanelWindow = value === 'all' ? Infinity : Number(value);
      count = window.mapPanelWindow;
      if (count >= 500 && typeof refreshMapHistory === 'function') refreshMapHistory();
      draw();
    });
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
      const { selected, cfg, gap, all } = projection();
      const panel = panelProjection();
      const trends = activeStrategy === '2x' ? {} : trendRecords(cfg.payout, gap);
      const filtered = selectedEvents(selected, trends);
      const summary = finance.summarise(filtered, cfg);
      drawBalls(selected, trends);
      drawRecent(panel.all.events, trends);
      drawPanelCards(panel.all, panel.source, panel.cfg);
      drawScore(selected, cfg, trends, summary);
      drawCycleTable(summary, cfg);
      drawMetrics(summary);
      drawHeat(summary);
      const active = windowSize() === Infinity ? 'all' : String(windowSize());
      document.querySelectorAll('#mapView [data-count]').forEach(button => button.classList.toggle('active', button.dataset.count === active));
      const note = document.querySelector('#mapPageNote');
      if (note) note.textContent = `${filtered.length} sequências · ${summary.wins} wins · ${summary.losses} losses · ${summary.estimated} resultado(s) estimado(s) por gaps de até ${gap} rodadas · ${all.availableRounds} rodadas disponíveis`;
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
    const zones = ballIndicatorMode === 'zone' ? zoneRecords(config().payout) : null;
    target.innerHTML = events.slice(-10).reverse().map(event => {
      const row = event.row || {};
      const amount = row.total_amount_display || (row.total_amount_brl != null
        ? `R$ ${Number(row.total_amount_brl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
      const signal = event.signal === 'green' ? 'green-win' : (event.signal === 'unknown' ? 'red' : event.signal);
      const signalOutline = showBallSignals && ballIndicatorMode !== 'zone' ? ` signal-${signal} signal-enabled` : '';
      const zone = zones?.[event.anchorRoundId];
      const zoneClass = zone ? ` zone-${zone}` : '';
      const content = ballDisplay === 'payout' && !event.pending ? `${event.payoutLabel}x` : event.label;
      const state = event.partialWin ? ` · win parcial; falta ${event.remainingDebt.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} u.` : '';
      return `<span class="ball ${event.color}${signalOutline}${zoneClass}" data-round-id="${event.roundId}" data-round-time="${event.capturedAt || ''}" data-round-amount="${amount ? encodeURIComponent(String(amount)) : ''}" title="Rodada ${event.roundId}${state}">${content}${trendStamp(event, trends)}</span>`;
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
    for (let index = outcomes.length - 1; index >= 0; index--) {
      const outcome = outcomes[index];
      if (!outcome.win) break;
      if (finance.isDirectWinner(outcome)) streak++;
    }
    const winStreak = document.querySelector('#winStreak');
    if (winStreak) winStreak.textContent = int(streak);
    const winNote = document.querySelector('#winStreakNote');
    if (winNote) winNote.textContent = `somente N0/C0 · ${cfg.cycleRounds}R`;
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
      cfg.levels, cfg.cycleMode, cfg.levelMode, cfg.levelRecoveries, cfg.recoveryDivider, gap].join('|');
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
        if (finance.isDirectWinner(outcome)) streak++;
        else if (!outcome.win) record();
      }
      record();
      const summaryNode = document.querySelector('#winsSummary');
      if (summaryNode) summaryNode.textContent = `${label} rodadas · ${summary.directWins} wins diretos · ${summary.recoveryWins} recuperações · ${summary.losses} losses · ${simulationUnits(summary.profit)}`;
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
      target.innerHTML = card('Losses de ciclo', int(summary.cycleLosses), 'risk', `${int(summary.directWins)} wins diretos · ${int(summary.recoveryWins)} recuperações · ${int(summary.losses)} perdas finais`) +
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
  style.textContent = `:root{--jade:#239b7a}#mapView .map-tabs .toggle[aria-label="Recorte do mapa"],#cycleTable{display:none!important}#signalScore{scrollbar-width:none;-ms-overflow-style:none}#signalScore::-webkit-scrollbar{display:none}#signalScore table{min-width:540px}#signalScore .signal-blue{color:var(--blue)}
    .ball.jade{background:var(--jade);color:#edfff8}.recent-balls .ball.jade{border-color:#74d5b9}
    .ball.signal-blue{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--blue)!important}
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
    #mapView #balls{margin:5px -14px 8px;width:calc(100% + 28px);padding:12px 14px 9px;background:#050b14;border:0;border-radius:0;gap:8px;overflow:visible}
    #balls .ball,#recentBalls .ball{overflow:visible}
    #balls>.ball{position:relative;z-index:1}
    #balls .ball.zone-under,#recentBalls .ball.zone-under{box-shadow:0 0 0 2px var(--bg),0 0 0 4px #e78c99!important}#balls .ball.zone-mid,#recentBalls .ball.zone-mid{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--yellow)!important}#balls .ball.zone-upper,#recentBalls .ball.zone-upper{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--orange)!important}#balls .ball.zone-over,#recentBalls .ball.zone-over{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--green)!important}
    #balls .map-signal-dot,#recentBalls .map-signal-dot{position:absolute;z-index:4;right:-2px;bottom:-2px;width:8px;height:8px;border:1px solid var(--bg);border-radius:50%;pointer-events:none}#balls .map-signal-dot.low,#recentBalls .map-signal-dot.low{background:var(--red)}#balls .map-signal-dot.neutral,#recentBalls .map-signal-dot.neutral{background:var(--yellow)}#balls .map-signal-dot.high,#recentBalls .map-signal-dot.high{background:var(--green)}
    .ball .frequency-stamp{position:absolute;z-index:3;top:-4px;right:-4px;display:flex;flex-direction:column;align-items:center;justify-content:center;width:11px;padding:2px 1px;border-radius:6px;border:1px solid rgba(148,235,187,.55);background:rgba(9,45,48,.94);pointer-events:none}
    .ball .frequency-stamp i{display:block;width:6px;height:4px;background:#80edaa;clip-path:polygon(0 66%,50% 0,100% 66%,100% 100%,50% 34%,0 100%)}
    .ball .frequency-stamp i+i{margin-top:-1px}
    .ball .frequency-stamp.down{border-color:rgba(255,148,166,.55);background:rgba(53,24,35,.94)}
    .ball .frequency-stamp.down i{background:#fb8299;clip-path:polygon(0 0,50% 66%,100% 0,100% 34%,50% 100%,0 34%)}
    #signalScore{position:relative;margin-top:2px!important;padding-top:0;border-top:0}
    #signalScore .map-score-controls{position:sticky;z-index:4;top:0;left:0;display:flex;align-items:center;justify-content:space-between;gap:5px;width:100%;min-width:0;padding:0 0 2px;background:var(--panel)}
    #signalScore .map-score-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}
    #signalScore .map-columns-toggle{width:28px;height:28px;display:grid;grid-template-columns:repeat(3,1fr);align-items:center;gap:2px;padding:5px;border:1px solid var(--line);border-radius:7px;background:var(--panel);cursor:pointer}
    #signalScore .map-columns-toggle span{height:100%;border-radius:2px;background:var(--muted)}#signalScore .map-columns-toggle.expanded{border-color:var(--green)}#signalScore .map-columns-toggle.expanded span{background:var(--green)}
    #signalScore .map-period-control{display:flex;align-items:center;gap:4px;color:var(--muted);font:700 .72rem/1 inherit;white-space:nowrap}
    #signalScore .map-period-select{min-width:57px;height:28px;padding:0 20px 0 7px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);font:700 .76rem/1 inherit;cursor:pointer}
    #signalScore .map-score-tabs{display:flex;padding:2px;border:1px solid var(--line);border-radius:7px;background:var(--panel)}
    #signalScore .map-score-tabs button{border:0;border-radius:5px;background:transparent;color:var(--muted);padding:5px 7px;font:700 .72rem/1 inherit;cursor:pointer}
    #signalScore .map-score-tabs button[aria-selected="true"]{background:rgba(57,220,160,.16);color:var(--text)}
    #signalScore .map-selection-layout{width:25px;height:25px;display:flex;align-items:center;justify-content:center;gap:2px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);cursor:pointer}
    #signalScore .map-selection-layout span{width:4px;height:4px;border-radius:50%;background:var(--muted);transition:transform .16s ease,opacity .16s ease}
    #signalScore .map-selection-layout.highlight span:nth-child(2){transform:translateY(-3px);background:var(--green)}
    #signalScore .map-selection-layout.grouped{gap:0}
    #signalScore .map-selection-layout.grouped span{transform:none;background:var(--green)}
    #signalScore .map-column-head,#signalScore .map-row-head{padding:2px!important;cursor:pointer}#signalScore .map-column-marker{position:relative;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:2px solid currentColor;border-radius:50%;background:transparent;color:var(--muted);pointer-events:none}
    #signalScore .map-column-marker.signal-green,#signalScore .map-column-marker.signal-high{color:var(--green)}#signalScore .map-column-marker.signal-yellow,#signalScore .map-column-marker.signal-neutral{color:var(--yellow)}#signalScore .map-column-marker.signal-blue{color:var(--blue)}#signalScore .map-column-marker.signal-red,#signalScore .map-column-marker.signal-low{color:var(--red)}
    #signalScore .map-total-filter.selected{color:var(--green)}
    #signalScore .frequency-marker{color:var(--muted)}#signalScore .frequency-marker.flat-marker{color:transparent;border-color:transparent}
    #signalScore .frequency-marker .frequency-stamp{position:static;display:flex;flex-direction:column;align-items:center;justify-content:center;width:auto;height:auto;padding:0;border:0;border-radius:0;background:transparent;pointer-events:none}
    #signalScore .frequency-marker .frequency-stamp i{display:block;width:8px;height:5px;background:var(--green);clip-path:polygon(0 66%,50% 0,100% 66%,100% 100%,50% 34%,0 100%)}
    #signalScore .frequency-marker .frequency-stamp i+i{margin-top:-2px}
    #signalScore .frequency-marker .frequency-stamp.down i{background:var(--red);clip-path:polygon(0 0,50% 66%,100% 0,100% 34%,50% 100%,0 34%)}
    #signalScore .map-dim{opacity:.22;filter:saturate(.3)}#signalScore .map-active{opacity:1;filter:none}#signalScore tr.map-dim>th,#signalScore tr.map-dim>td{opacity:.22;filter:saturate(.3)}#signalScore .map-total-filter{border:0;background:transparent;color:var(--text);font:700 .72rem/1 inherit;cursor:pointer}
    #signalScore .map-cycle-section th{padding:5px 2px 3px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:.65rem;letter-spacing:.08em;text-align:left;text-transform:uppercase}#signalScore .map-cycle-row>th{color:var(--text);cursor:default}#signalScore .map-level-cycle-head{width:48px;padding:3px 2px!important;white-space:nowrap;text-align:left}#signalScore .map-level-cycle-head span{display:inline-block;width:20px;color:var(--yellow);font-size:.66rem;letter-spacing:.04em}#signalScore .map-level-cycle-head b{margin-left:1px;color:var(--text);font:700 .72rem/1 inherit}#signalScore .map-cycle-row>td{padding:2px 0!important}#signalScore .map-cycle-values{display:grid;grid-template-columns:repeat(var(--cycle-columns),minmax(0,1fr));gap:2px;min-width:0}#signalScore .map-cycle-value{display:grid;min-width:0;padding:1px 0;text-align:center;color:var(--text)}#signalScore .map-cycle-value strong{font-size:.69rem;white-space:nowrap}#signalScore .map-cycle-value small{font-size:.6rem;color:var(--muted)}#signalScore .map-cycle-value.map-cycle-total{border-left:1px solid var(--line);font-weight:700}#signalScore .map-loss-row th{color:var(--red)}
    #balls .ball.map-filter-muted{opacity:.1;filter:grayscale(1) brightness(.48)}#signalScore .map-filter-muted{opacity:.22;filter:grayscale(.7) saturate(.35)}#signalScore .map-filter-gap{display:block;min-width:0;min-height:0;aspect-ratio:1;pointer-events:none}#signalScore table th,#signalScore table td{padding:2px 2px}#signalScore td[data-map-column]{cursor:pointer}
    @media(max-width:720px){#signalScore .map-score-controls{top:0}#signalScore .map-score-tabs button{padding:5px 6px;font-size:.7rem}#signalScore .map-period-control{font-size:.7rem}#signalScore .map-period-select{min-width:55px;font-size:.74rem}}
    `;
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
      const tone = state.tone === 'unknown' ? 'red' : state.tone;
      const score = Number(shortPass) + Number(longPass);
      const label = { green: '250 e 1.000', yellow: 'Só 250', blue: 'Só 1.000', red: 'Nenhum' }[tone];
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
  // A atualização geral do painel ainda redesenha a grade de bolinhas legada.
  // Reaplicamos o mapa consistente em seguida para que a seleção da tabela não seja perdida.
  const legacyRender = render;
  render = function (...args) {
    const result = legacyRender.apply(this, args);
    if (!suppressLegacyMap) draw();
    return result;
  };
  // A seleção de 20 é dinâmica: vinte sequências, independentemente do R configurado.
  window.addEventListener('load', () => {
    installFarol();
    cache = null;
    render();
    if (typeof renderExposureCalculator === 'function') renderExposureCalculator();
  });
})();
