const assert = require('node:assert/strict');
const test = require('node:test');
const { thresholds, classify, calculate, latestWindows, classifyTrend, trendAtAnchors } = require('../signal-frequency.js');

const rows = (hits, count = 1000) => Array.from({ length: count }, (_, index) => ({
  round_id: index + 1,
  multiplier: hits.has(index + 1) ? 30 : 1
}));

test('metas do farol seguem o payout do cabeçalho', () => {
  assert.deepEqual(thresholds(30), { short: 9, long: 33 });
  assert.deepEqual(thresholds(20), { short: 13, long: 50 });
});

test('cada combinação das duas frequências tem uma cor própria', () => {
  assert.equal(classify(9, 33, 30, true), 'green');
  assert.equal(classify(9, 9, 30, true), 'yellow');
  assert.equal(classify(0, 33, 30, true), 'blue');
  assert.equal(classify(8, 32, 30, true), 'red');
  assert.equal(classify(9, 33, 30, false), 'unknown');
});

test('a classificação usa apenas rodadas disponíveis até o instante da entrada', () => {
  const lateHits = new Set(Array.from({ length: 9 }, (_, index) => 992 + index));
  const result = calculate(rows(lateHits), 30, 0);
  assert.equal(result.byRoundId[999].tone, 'unknown');
  assert.equal(result.byRoundId[1000].tone, 'yellow');
  assert.equal(result.byRoundId[1000].shortHits, 9);
});

test('gap longo reinicia as janelas e gap curto sinaliza estimativa', () => {
  const base = rows(new Set(), 1000);
  const long = calculate([...base, { round_id: 1025, multiplier: 1 }], 30, 20);
  assert.equal(long.last.tone, 'unknown');
  const short = calculate([...base, { round_id: 1002, multiplier: 1 }], 30, 20);
  assert.equal(short.last.tone, 'red');
  assert.equal(short.last.estimated, true);
});

test('cartão de frequência usa os mesmos IDs e gaps do farol', () => {
  const source = [
    { round_id: 1, multiplier: 30 },
    { round_id: 2, multiplier: 1 },
    { round_id: 4, multiplier: 30 }
  ];
  const joined = latestWindows(source, 30, 2, [4])[0];
  assert.equal(joined.available, 4);
  assert.equal(joined.hits, 2);
  assert.equal(joined.estimated, true);
  const split = latestWindows(source, 30, 0, [4])[0];
  assert.equal(split.available, 1);
  assert.equal(split.hits, 1);
});

test('setas de tendência usam somente uma ou duas marcas, inclusive além de 30%', () => {
  assert.equal(classifyTrend(1.09), 0);
  assert.equal(classifyTrend(1.1), 1);
  assert.equal(classifyTrend(1.2), 2);
  assert.equal(classifyTrend(1.4), 2);
  assert.equal(classifyTrend(0.91), 0);
  assert.equal(classifyTrend(0.9), -1);
  assert.equal(classifyTrend(0.8), -2);
  assert.equal(classifyTrend(0.6), -2);
});

test('tendência da âncora não usa resultados posteriores e separa gaps longos', () => {
  const base = rows(new Set(Array.from({ length: 275 }, (_, index) => 20 * (index + 1))), 5500);
  const state = trendAtAnchors(base, 30, 20, 500, 5000);
  assert.equal(state.byRoundId[5500].ready, true);
  assert.equal(state.byRoundId[5500].recentHits, 25);
  assert.equal(state.byRoundId[5500].level, 0);
  const afterGap = trendAtAnchors([...base, { round_id: 5525, multiplier: 30 }], 30, 20, 500, 5000);
  assert.equal(afterGap.byRoundId[5525].ready, false);
});
