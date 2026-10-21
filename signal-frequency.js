(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrashSignalFrequency = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHORT = 250;
  const LONG = 1000;

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
    const ordered = [...new Map((source || [])
      .filter(row => Number.isFinite(Number(row?.round_id)) && Number.isFinite(Number(row?.multiplier)))
      .map(row => [Number(row.round_id), row])).values()]
      .sort((a, b) => Number(a.round_id) - Number(b.round_id));
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

  return { thresholds, classify, calculate };
});
