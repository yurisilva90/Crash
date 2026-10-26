(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrashHeaderCampaignCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isDirectWinner(outcome) {
    const cycles = Array.isArray(outcome?.cycles) ? outcome.cycles : [];
    return Boolean(outcome?.win) && cycles.length === 1 &&
      cycles[0]?.win === true && cycles[0]?.level === 0 && cycles[0]?.cycle === 0;
  }

  function derive(rows, config, options = {}) {
    const engine = options.engine || (typeof globalThis !== 'undefined' && globalThis.CrashMapFinance);
    if (!engine?.project) throw new Error('CrashMapFinance indisponível');

    const projection = engine.project(rows, config, options.gapLimit ?? 20);
    let directStreak = 0;
    for (const outcome of projection.events.flatMap(event => event.completed || [])) {
      // Recuperação concluída é neutra: não soma win direto, mas tampouco
      // interrompe a sequência. Apenas uma perda final zera o contador.
      if (isDirectWinner(outcome)) directStreak++;
      else if (!outcome.win) directStreak = 0;
    }

    const cfg = projection.config;
    const pending = projection.pending || null;
    return {
      directStreak,
      pending,
      maxLevel: cfg.maxLevel,
      maxCycle: cfg.maxCycle,
      rounds: cfg.rounds,
      levelRecoveries: cfg.levelRecoveries,
      recoveryDivider: cfg.recoveryDivider
    };
  }

  return { derive, isDirectWinner };
});
