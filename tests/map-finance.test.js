const assert = require('node:assert/strict');
const test = require('node:test');
const { cycleCost, exposure, project, summarise } = require('../map-finance.js');

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const stakeSum = (payout, count) => Array.from({ length: count }, (_, index) =>
  (payout / (payout - 1)) ** index).reduce((sum, stake) => sum + stake, 0);
const rows = (last, targetIds, payout = 30) => Array.from({ length: last }, (_, index) => ({
  round_id: index + 1,
  multiplier: targetIds.includes(index + 1) ? payout : 1
}));
const cfg = (payout, rounds, recoveries = 1, levels = 0, cycleMode = 'recover', levelMode = 'recover') =>
  ({ payout, cycleRounds: rounds, recoveries, levels, cycleMode, levelMode });

test('30x/21R: um win limpo e um loss custam a progressão inteira', () => {
  const configuration = cfg(30, 21);
  const report = project(rows(24, [1, 2, 24]), configuration, 0);
  const result = summarise(report.events, configuration);
  near(cycleCost(30, 21), stakeSum(30, 21));
  near(result.profit, 29 - cycleCost(30, 21));
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.heat[0], 1);
  assert.equal(result.cells[0][0].wins, 1);
  assert.equal(result.cells[0][0].losses, 1);
  near(Object.values(result.buckets).reduce((sum, bucket) => sum + bucket.profit, 0), result.profit);
});

test('bolinha preserva o payout-âncora anterior para a tendência pré-ciclo', () => {
  const report = project(rows(5, [1, 3, 5]), cfg(30, 21), 0);
  assert.equal(report.events[0].anchorRoundId, 1);
  assert.equal(report.events[0].roundId, 3);
  assert.equal(report.events[1].anchorRoundId, 3);
  assert.equal(report.events[1].roundId, 5);
});

test('20x/21R usa fator e custo próprios, não o de 30x', () => {
  const configuration = cfg(20, 21);
  const result = summarise(project(rows(24, [1, 2, 24], 20), configuration, 0).events, configuration);
  near(cycleCost(20, 21), stakeSum(20, 21));
  near(result.profit, 19 - cycleCost(20, 21));
});

test('C1 R recupera a perda de C0; C1 L recupera e lucra uma unidade de payout', () => {
  for (const [mode, expected] of [['recover', 0], ['profit', 29]]) {
    const configuration = cfg(30, 3, 2, 0, mode);
    const result = summarise(project(rows(5, [1, 5]), configuration, 0).events, configuration);
    near(result.profit, expected);
    assert.equal(result.wins, 1);
    assert.equal(result.losses, 0);
    assert.equal(result.cells[0][0].losses, 1);
    assert.equal(result.cells[0][1].wins, 1);
    assert.equal(result.heat[0], 1);
  }
});

test('divisor da perda altera igualmente C1, N1 e a exposição, sem mudar C0', () => {
  const firstLoss = cycleCost(30, 3);
  for (const divider of [1, 1.5, 2, 3]) {
    for (const mode of ['recover', 'profit']) {
      const target = mode === 'profit' ? 29 : 0;
      const cycle = { ...cfg(30, 3, 2, 0, mode), recoveryDivider: divider };
      const level = { ...cfg(30, 3, 1, 1, 'recover', mode), recoveryDivider: divider };
      const expected = -firstLoss * (1 - 1 / divider) + target;
      near(summarise(project(rows(5, [1, 5]), cycle, 0).events, cycle).profit, expected);
      near(summarise(project(rows(6, [1, 5, 6]), level, 0).events, level).profit, expected);
      near(exposure(cycle).rows[0].base, 1);
      near(exposure(cycle).rows[1].base, (firstLoss / divider + target) / 29);
    }
  }
});

test('a cor da bolinha representa o ciclo, não uma faixa antiga dentro de R', () => {
  const configuration = cfg(30, 31, 2);
  const c1 = project(rows(35, [1, 35]), configuration, 0).events.at(-1);
  assert.equal(c1.label, 34);
  assert.equal(c1.color, 'yellow');

  const c2 = project(rows(44, [1, 44]), cfg(30, 21, 3), 0).events.at(-1);
  assert.equal(c2.color, 'orange');

  const levelC0 = project(rows(64, [1, 33, 64]), cfg(30, 31, 1, 1), 0).events.at(-1);
  assert.equal(levelC0.color, 'green');
});

test('N1 só começa depois do próximo alvo e respeita R/L do nível', () => {
  for (const [mode, expected] of [['recover', 0], ['profit', 29]]) {
    const configuration = cfg(30, 3, 1, 1, 'recover', mode);
    const result = summarise(project(rows(6, [1, 5, 6]), configuration, 0).events, configuration);
    near(result.profit, expected);
    assert.equal(result.wins, 1);
    assert.equal(result.losses, 0);
    assert.equal(result.cells[0][0].losses, 1);
    assert.equal(result.cells[1][0].wins, 1);
  }
});

test('win parcial permanece no mesmo nível quando há mais recuperações configuradas', () => {
  const configuration = { ...cfg(30, 1, 1, 1), levelRecoveries: 2, recoveryDivider: 2 };
  // 1 ancora N0; 2 perde N0; 3 inicia N1; 4 recupera metade; 5 quita o restante em N1.
  const result = summarise(project(rows(5, [1, 3, 4, 5]), configuration, 0).events, configuration);
  near(result.profit, 0);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 0);
  assert.equal(result.cells[0][0].losses, 1);
  assert.equal(result.cells[1][0].wins, 2);
});

test('win parcial recebe jade e não é contado como win financeiro concluído', () => {
  const configuration = { ...cfg(30, 1, 1, 1), levelRecoveries: 2, recoveryDivider: 2 };
  const report = project(rows(5, [1, 3, 4, 5]), configuration, 0);
  const partial = report.events.find(event => event.roundId === 4);
  assert.equal(partial.color, 'jade');
  assert.equal(partial.partialWin, true);
  near(partial.remainingDebt, 0.5);
  const result = summarise(report.events, configuration);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 0);
});

test('um gap pequeno é estimado; acima do limite separa e não inventa operação', () => {
  const input = [{ round_id: 1, multiplier: 30 }, { round_id: 3, multiplier: 30 }];
  const configuration = cfg(30, 3);
  const joined = summarise(project(input, configuration, 1).events, configuration);
  near(joined.profit, 29);
  assert.equal(joined.estimated, 1);
  const separated = summarise(project(input, configuration, 0).events, configuration);
  assert.equal(separated.wins, 0);
  assert.equal(separated.losses, 0);
  near(separated.profit, 0);
});

test('recortes usam os mesmos eventos para placar, card, heatmap e níveis', () => {
  const configuration = cfg(30, 3);
  const projected = project(rows(9, [1, 2, 6, 7, 9]), configuration, 0);
  const lastTwo = projected.events.slice(-2);
  const result = summarise(lastTwo, configuration);
  assert.equal(lastTwo.length, 2);
  assert.equal(result.wins + result.losses, 2);
  assert.equal(result.heat.reduce((sum, count) => sum + count, 0), result.wins);
  near(result.profit, Object.values(result.buckets).reduce((sum, bucket) => sum + bucket.profit, 0));
});

test('loss é atribuído ao sinal da entrada, não automaticamente ao farol vermelho', () => {
  const configuration = cfg(30, 3);
  const result = summarise(project(rows(5, [1, 5]), configuration, 0,
    { 1: 'green', 5: 'red' }).events, configuration);
  assert.equal(result.buckets.green.losses, 1);
  assert.equal(result.buckets.red.losses, 0);
  near(result.buckets.green.profit, -cycleCost(30, 3));
});

test('30x/31R não usa 31 unidades fixas como custo de loss', () => {
  const configuration = cfg(30, 31);
  const report = project(rows(34, [1, 2, 34]), configuration, 0);
  const result = summarise(report.events, configuration);
  near(result.profit, 29 - stakeSum(30, 31));
  assert.ok(cycleCost(30, 31) > 31);
});

test('a exposição de C1 perdido inclui ambas as progressões', () => {
  const configuration = cfg(30, 3, 2);
  const report = project(rows(8, [1, 8]), configuration, 0);
  const result = summarise(report.events, configuration);
  const firstCost = cycleCost(30, 3);
  const secondBase = firstCost / 29;
  near(result.profit, -(firstCost + secondBase * firstCost));
  assert.equal(result.losses, 1);
  assert.equal(result.cycleLosses, 2);
  assert.equal(result.maxLoss, 2);
});

test('N1 L mantém a meta de lucro mesmo quando o acerto chega em C1 do nível', () => {
  const configuration = cfg(30, 3, 2, 1, 'recover', 'profit');
  const result = summarise(project(rows(12, [1, 8, 12]), configuration, 0).events, configuration);
  near(result.profit, 29);
  assert.equal(result.cells[0][0].losses, 1);
  assert.equal(result.cells[0][1].losses, 1);
  assert.equal(result.cells[1][0].losses, 1);
  assert.equal(result.cells[1][1].wins, 1);
});

test('exposição e histórico têm o mesmo custo quando todos C/N perdem', () => {
  for (const cycleMode of ['recover', 'profit']) {
    for (const levelMode of ['recover', 'profit']) {
      const configuration = cfg(30, 3, 2, 1, cycleMode, levelMode);
      const plan = exposure(configuration);
      const result = summarise(project(rows(14, [1, 8]), configuration, 0).events, configuration);
      near(result.profit, -plan.total);
      assert.equal(plan.rows.length, 4);
      assert.equal(result.cycleLosses, 4);
    }
  }
});

test('C1 em N1 segue R/L configurado no cabeçalho, inclusive modos mistos', () => {
  for (const cycleMode of ['recover', 'profit']) {
    for (const levelMode of ['recover', 'profit']) {
      const configuration = cfg(30, 3, 2, 1, cycleMode, levelMode);
      const result = summarise(project(rows(12, [1, 8, 12]), configuration, 0).events, configuration);
      near(result.profit, cycleMode === 'profit' || levelMode === 'profit' ? 29 : 0);
      assert.equal(result.cells[1][1].wins, 1);
    }
  }
});

test('cinco estados do farol preservam o total de wins, losses e resultado', () => {
  const configuration = cfg(30, 3);
  const source = rows(7, [1, 2, 7]);
  const result = summarise(project(source, configuration, 0,
    { 1: 'blue', 2: 'unknown', 7: 'yellow' }).events, configuration);
  assert.equal(result.buckets.blue.wins, 1);
  assert.equal(result.buckets.unknown.losses, 1);
  near(Object.values(result.buckets).reduce((sum, bucket) => sum + bucket.profit, 0), result.profit);
});
