const assert = require('node:assert/strict');
const finance = require('../map-finance.js');
const cards = require('../header-campaign-cards.js');

const rows = multipliers => multipliers.map((multiplier, index) => ({
  round_id: index + 1,
  multiplier,
  captured_at: new Date(1_700_000_000_000 + index * 1_000).toISOString()
}));

{
  // N1 vencedor não é win direto; apenas os dois C0/N0 seguintes contam.
  const result = cards.derive(rows([2, 1.2, 2, 2, 2, 2]), {
    payout: 2, cycleRounds: 1, recoveries: 1, levels: 1, levelRecoveries: 1
  }, { engine: finance });
  assert.equal(result.directStreak, 2);
}

{
  // Após loss de N0, o card preserva N1 pendente até a próxima âncora.
  const result = cards.derive(rows([2, 1.2]), {
    payout: 2, cycleRounds: 1, recoveries: 1, levels: 1, levelRecoveries: 1
  }, { engine: finance });
  assert.deepEqual(result.pending, { level: 1, cycle: 0, position: 0, waitingLevel: true });
}

{
  // Win em C1 também quebra a sequência de wins diretos.
  const result = cards.derive(rows([2, 2, 1.2, 2]), {
    payout: 2, cycleRounds: 1, recoveries: 2, levels: 0, levelRecoveries: 1
  }, { engine: finance });
  assert.equal(result.directStreak, 0);
}

console.log('header-campaign-cards: ok');
