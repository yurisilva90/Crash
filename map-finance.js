(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrashMapFinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cycleCost(payout, rounds) {
    const factor = payout / (payout - 1);
    return Math.expm1(rounds * Math.log(factor)) / (factor - 1);
  }

  function normaliseConfig(input) {
    return {
      payout: Math.max(1.01, Number(input.payout) || 30),
      rounds: Math.max(1, Math.floor(Number(input.cycleRounds) || 21)),
      maxCycle: Math.max(0, Math.floor(Number(input.recoveries || 1) - 1)),
      maxLevel: Math.max(0, Math.floor(Number(input.levels) || 0)),
      recoveryDivider: Math.max(1, Number(input.recoveryDivider) || 1),
      cycleMode: input.cycleMode === 'profit' ? 'profit' : 'recover',
      levelMode: input.levelMode === 'profit' ? 'profit' : 'recover'
    };
  }

  function normaliseSignal(value) {
    const raw = String(value?.tone || value || '').toLowerCase();
    return ['green', 'yellow', 'blue', 'red'].find(tone => raw.startsWith(tone)) || 'unknown';
  }

  function exposure(input) {
    const cfg = normaliseConfig(input);
    const net = cfg.payout - 1;
    const factor = cycleCost(cfg.payout, cfg.rounds);
    const rows = [];
    let debt = 0;
    for (let level = 0; level <= cfg.maxLevel; level++) {
      for (let cycle = 0; cycle <= cfg.maxCycle; cycle++) {
        const first = level === 0 && cycle === 0;
        const mode = cycle === 0 ? cfg.levelMode :
          level > 0 && cfg.levelMode === 'profit' ? 'profit' : cfg.cycleMode;
        const target = mode === 'profit' ? net : 0;
        const base = first ? 1 : (debt / cfg.recoveryDivider + target) / net;
        const cost = base * factor;
        debt += cost;
        rows.push({ level, cycle, base, cost, cumulative: debt, target: first ? net : target });
      }
    }
    return { config: cfg, rows, total: debt };
  }

  function project(source, input, gapLimit = 20, signalByRoundId = {}) {
    const cfg = normaliseConfig(input);
    const factor = cfg.payout / (cfg.payout - 1);
    const ordered = [...new Map((source || [])
      .filter(row => Number.isFinite(Number(row?.round_id)) && Number.isFinite(Number(row?.multiplier)))
      .map(row => [Number(row.round_id), row])).values()]
      .sort((a, b) => Number(a.round_id) - Number(b.round_id));
    const events = [];
    let campaign = null;
    let anchor = null;
    let lastRow = null;
    let missingSinceAnchor = 0;
    const maxGap = Math.max(0, Math.floor(Number(gapLimit) || 0));

    function newCampaign(signal) {
      return { level: 0, cycle: 0, position: 0, base: 1, profit: 0,
        deltas: [], cycles: [], signal: normaliseSignal(signal),
        estimated: Boolean(signal?.estimated), waitingLevel: false };
    }
    function nextBase(current, mode) {
      const target = mode === 'profit' ? cfg.payout - 1 : 0;
      return Math.max(0, -current.profit / cfg.recoveryDivider + target) / (cfg.payout - 1);
    }
    function close(current, win, position, endId) {
      return { win, position, endId, signal: current.signal,
        profit: current.profit, deltas: current.deltas,
        cycles: current.cycles, estimated: current.estimated };
    }
    function colorForCompleted(completed) {
      const outcome = completed.at(-1);
      if (!outcome) return 'pending';
      if (!outcome.win) return 'red';
      const cycle = outcome.cycles.at(-1)?.cycle || 0;
      // A cor representa somente onde o win aconteceu dentro da sequência C0/C1/C2.
      // O nível não altera a cor: N1C0 continua verde, N1C1 amarelo e assim por diante.
      return cycle === 0 ? 'green' : cycle === 1 ? 'yellow' : 'orange';
    }
    function bet(targetHit, roundId, finished) {
      if (!campaign || campaign.waitingLevel) return;
      const stake = campaign.base * factor ** campaign.position;
      campaign.deltas.push(-stake);
      campaign.profit -= stake;
      campaign.position++;
      if (targetHit) {
        const credit = stake * cfg.payout;
        campaign.deltas.push(credit);
        campaign.profit += credit;
        campaign.cycles.push({ level: campaign.level, cycle: campaign.cycle, win: true, position: campaign.position });
        finished.push(close(campaign, true, campaign.position, roundId));
        campaign = newCampaign(signalByRoundId[roundId]);
      } else if (campaign.position === cfg.rounds) {
        campaign.cycles.push({ level: campaign.level, cycle: campaign.cycle, win: false, position: cfg.rounds });
        if (campaign.cycle < cfg.maxCycle) {
          campaign.cycle++;
          campaign.position = 0;
          campaign.base = nextBase(campaign,
            campaign.level > 0 && cfg.levelMode === 'profit' ? 'profit' : cfg.cycleMode);
        } else if (campaign.level < cfg.maxLevel) {
          campaign.level++;
          campaign.cycle = 0;
          campaign.position = 0;
          campaign.waitingLevel = true;
        } else {
          finished.push(close(campaign, false, 0, roundId));
          campaign = null;
        }
      }
    }
    function settleTarget(row, distance, completed, missing) {
      const roundId = Number(row.round_id);
      if (campaign && missing) campaign.estimated = true;
      if (campaign?.waitingLevel) {
        campaign.waitingLevel = false;
        campaign.base = nextBase(campaign, cfg.levelMode);
      } else if (campaign) {
        bet(true, roundId, completed);
      } else {
        campaign = newCampaign(signalByRoundId[roundId]);
      }
      events.push({ roundId, capturedAt: row.captured_at, row, label: distance,
        payoutLabel: Number(row.multiplier).toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
        color: colorForCompleted(completed),
        signal: completed.at(-1)?.signal || campaign?.signal || 'unknown',
        completed, missing, pending: false });
    }
    function finishSegment() {
      if (!anchor || !lastRow || Number(lastRow.round_id) === Number(anchor.round_id)) return;
      const completed = [];
      const endId = Number(lastRow.round_id);
      if (campaign && missingSinceAnchor) campaign.estimated = true;
      for (let id = Number(anchor.round_id) + 1; id <= endId; id++) bet(false, id, completed);
      events.push({ roundId: endId, capturedAt: lastRow.captured_at, row: lastRow,
        label: endId - Number(anchor.round_id), payoutLabel: '',
        color: colorForCompleted(completed),
        signal: completed.at(-1)?.signal || campaign?.signal || 'unknown',
        completed, missing: missingSinceAnchor, pending: true });
    }

    for (const row of ordered) {
      const id = Number(row.round_id);
      if (lastRow && id - Number(lastRow.round_id) - 1 > maxGap) {
        finishSegment();
        anchor = null;
        campaign = null;
        missingSinceAnchor = 0;
      }
      if (anchor && lastRow) missingSinceAnchor += Math.max(0, id - Number(lastRow.round_id) - 1);
      lastRow = row;
      if (Number(row.multiplier) < cfg.payout) {
        continue;
      }
      if (!anchor) {
        anchor = row;
        campaign = newCampaign(signalByRoundId[id]);
        missingSinceAnchor = 0;
        continue;
      }
      const completed = [];
      const distance = id - Number(anchor.round_id);
      if (campaign && missingSinceAnchor) campaign.estimated = true;
      for (let step = 1; step < distance; step++) bet(false, Number(anchor.round_id) + step, completed);
      settleTarget(row, distance, completed, missingSinceAnchor);
      anchor = row;
      missingSinceAnchor = 0;
    }
    finishSegment();
    return { events, config: cfg, availableRounds: ordered.length,
      currentRun: anchor && lastRow ? Number(lastRow.round_id) - Number(anchor.round_id) : null,
      pending: campaign ? { level: campaign.level, cycle: campaign.cycle,
        position: campaign.position, waitingLevel: campaign.waitingLevel } : null };
  }

  function summarise(events, input) {
    const cfg = normaliseConfig(input);
    const buckets = Object.fromEntries(['green', 'yellow', 'blue', 'red', 'unknown'].map(key =>
      [key, { wins: 0, losses: 0, profit: 0, cycleWins: Array(cfg.maxCycle + 1).fill(0) }]));
    const cells = Array.from({ length: cfg.maxLevel + 1 }, () =>
      Array.from({ length: cfg.maxCycle + 1 }, () => ({ wins: 0, losses: 0 })));
    const heat = Array(cfg.rounds).fill(0);
    const outcomes = events.flatMap(event => event.completed || []);
    let profit = 0, equity = 0, peak = 0, maxDD = 0, estimated = 0;
    let lossRun = 0;
    let cycleLosses = 0;
    const lossRuns = [];
    for (const outcome of outcomes) {
      const bucket = buckets[normaliseSignal(outcome.signal)];
      bucket[outcome.win ? 'wins' : 'losses']++;
      bucket.profit += outcome.profit;
      profit += outcome.profit;
      if (outcome.estimated) estimated++;
      for (const cycle of outcome.cycles) {
        const cell = cells[cycle.level]?.[cycle.cycle];
        if (cell) cell[cycle.win ? 'wins' : 'losses']++;
        if (cycle.win && bucket.cycleWins[cycle.cycle] !== undefined) bucket.cycleWins[cycle.cycle]++;
        if (cycle.win) {
          if (lossRun) lossRuns.push(lossRun);
          lossRun = 0;
        } else {
          cycleLosses++;
          lossRun++;
        }
      }
      if (outcome.win) {
        if (outcome.position >= 1 && outcome.position <= cfg.rounds) heat[outcome.position - 1]++;
      }
      for (const delta of outcome.deltas) {
        equity += delta;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, peak - equity);
      }
    }
    if (lossRun) lossRuns.push(lossRun);
    const wins = outcomes.filter(item => item.win).length;
    const losses = outcomes.length - wins;
    const bucketProfit = Object.values(buckets).reduce((sum, item) => sum + item.profit, 0);
    const heatWins = heat.reduce((sum, item) => sum + item, 0);
    if (Math.abs(bucketProfit - profit) > 1e-6 || Math.abs(equity - profit) > 1e-6 || heatWins !== wins)
      throw new Error('Inconsistência interna no resultado do mapa');
    return { buckets, cells, heat, wins, losses, cycleLosses, profit, maxDD, estimated,
      averageLoss: lossRuns.length ? cycleLosses / lossRuns.length : 0,
      maxLoss: lossRuns.length ? Math.max(...lossRuns) : 0,
      outcomes };
  }

  return { cycleCost, exposure, project, summarise };
});
