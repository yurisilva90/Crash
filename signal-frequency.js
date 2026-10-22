(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrashSignalFrequency = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHORT = 250;
  const LONG = 1000;

  function orderedRows(source) {
    return [...new Map((source || [])
      .filter(row => Number.isFinite(Number(row?.round_id)) && Number.isFinite(Number(row?.multiplier)))
      .map(row => [Number(row.round_id), row])).values()]
      .sort((a, b) => Number(a.round_id) - Number(b.round_id));
  }

  function thresholds(payout) {
    const target = Math.max(1.01, Number(payout) || 30);
    return { short: Math.ceil(SHORT * .99 / target), long: Math.ceil(LONG * .99 / target) };
  }

  function classify(shortHits, longHits, payout, ready) {
    const minimum = thresholds(payout);
    if (!ready) return 'unknown';
    const shortPass = shortHits >= minimum.short;
    const longPass = longHits >= minimum.long;
    return shortPass && longPass ? 'green' : shortPass ? 'yellow' : longPass ? 'blue' : 'red';
  }

  function calculate(source, payout, gapLimit = 20) {
    const ordered = orderedRows(source);
    const target = Math.max(1.01, Number(payout) || 30);
    const limit = Math.max(0, Math.floor(Number(gapLimit) || 0));
    const minimum = thresholds(target);
    const hitIds = [];
    const missingIds = [];
    const byRoundId = {};
    let segmentStart = 0;
    let previous = null;
    let shortCursor = 0, longCursor = 0, missingCursor = 0;
    let last = { tone: 'unknown', shortHits: 0, longHits: 0,
      shortMin: minimum.short, longMin: minimum.long, ready: false, estimated: false };

    for (const row of ordered) {
      const id = Number(row.round_id);
      if (previous === null || id - previous - 1 > limit) {
        hitIds.length = 0;
        missingIds.length = 0;
        shortCursor = longCursor = missingCursor = 0;
        segmentStart = id;
      } else {
        for (let missing = previous + 1; missing < id; missing++) missingIds.push(missing);
      }
      if (Number(row.multiplier) >= target) hitIds.push(id);
      while (shortCursor < hitIds.length && hitIds[shortCursor] <= id - SHORT) shortCursor++;
      while (longCursor < hitIds.length && hitIds[longCursor] <= id - LONG) longCursor++;
      while (missingCursor < missingIds.length && missingIds[missingCursor] <= id - LONG) missingCursor++;
      const shortHits = hitIds.length - shortCursor;
      const longHits = hitIds.length - longCursor;
      const ready = id - segmentStart + 1 >= LONG;
      last = { tone: classify(shortHits, longHits, target, ready), shortHits, longHits,
        shortMin: minimum.short, longMin: minimum.long, ready,
        estimated: missingIds.length > missingCursor };
      byRoundId[id] = last;
      previous = id;
    }
    return { byRoundId, last, availableRounds: ordered.length };
  }

  function latestWindows(source, payout, gapLimit = 20, sizes = [100, 250, 1000, 2000, 5000]) {
    const ordered = orderedRows(source);
    const target = Math.max(1.01, Number(payout) || 30);
    const limit = Math.max(0, Math.floor(Number(gapLimit) || 0));
    let segmentStart = 0;
    for (let index = 1; index < ordered.length; index++) {
      if (Number(ordered[index].round_id) - Number(ordered[index - 1].round_id) - 1 > limit)
        segmentStart = index;
    }
    const segment = ordered.slice(segmentStart);
    const lastId = Number(segment.at(-1)?.round_id);
    return sizes.map(size => {
      const windowSize = Math.max(1, Math.floor(Number(size) || 1));
      const firstId = lastId - windowSize + 1;
      const sample = segment.filter(row => Number(row.round_id) >= firstId);
      const available = segment.length ? Math.min(windowSize,
        lastId - Number(segment[0].round_id) + 1) : 0;
      const hits = sample.filter(row => Number(row.multiplier) >= target).length;
      const minimum = Math.ceil(windowSize * .99 / target);
      return { windowSize, hits, minimum, available, ready: available === windowSize,
        estimated: available > sample.length };
    });
  }

  function classifyTrend(ratio) {
    if (!Number.isFinite(ratio)) return 0;
    if (ratio >= 1.2) return 2;
    if (ratio >= 1.1) return 1;
    if (ratio <= 0.8) return -2;
    if (ratio <= 0.9) return -1;
    return 0;
  }

  // A tendência é observada no payout-âncora, antes da primeira aposta do ciclo.
  // A referência é a frequência histórica acumulada até antes dessa rodada.
  function trendAtAnchors(source, payout, gapLimit = 20, windowSize = 500, minHistory = 5000) {
    const ordered = orderedRows(source);
    const target = Math.max(1.01, Number(payout) || 30);
    const limit = Math.max(0, Math.floor(Number(gapLimit) || 0));
    const window = Math.max(1, Math.floor(Number(windowSize) || 500));
    const minimum = Math.max(window, Math.floor(Number(minHistory) || 5000));
    const byRoundId = {};
    let previous = null, historicalCount = 0, historicalHits = 0;
    let hitPrefix = [0], missingPrefix = [0];
    for (const row of ordered) {
      const id = Number(row.round_id);
      if (previous !== null) {
        const missing = id - previous - 1;
        if (missing > limit) {
          hitPrefix = [0];
          missingPrefix = [0];
        } else {
          for (let step = 0; step < missing; step++) {
            hitPrefix.push(hitPrefix.at(-1));
            missingPrefix.push(missingPrefix.at(-1) + 1);
            historicalCount++;
          }
        }
      }
      const hit = Number(row.multiplier) >= target;
      const baseline = historicalCount >= minimum ? historicalHits / historicalCount : null;
      hitPrefix.push(hitPrefix.at(-1) + Number(hit));
      missingPrefix.push(missingPrefix.at(-1));
      historicalCount++;
      historicalHits += Number(hit);
      if (hit) {
        const ready = hitPrefix.length - 1 >= window && baseline > 0;
        const recentHits = ready ? hitPrefix.at(-1) - hitPrefix.at(-1 - window) : 0;
        const ratio = ready ? (recentHits / window) / baseline : null;
        const estimated = ready && missingPrefix.at(-1) > missingPrefix.at(-1 - window);
        byRoundId[id] = { level: classifyTrend(ratio), ratio, recentHits,
          baseline, windowSize: window, ready, estimated };
      }
      previous = id;
    }
    return { byRoundId, windowSize: window, minHistory: minimum };
  }

  return { thresholds, classify, calculate, latestWindows, classifyTrend, trendAtAnchors };
});
