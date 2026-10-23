const assert = require('node:assert/strict');
const test = require('node:test');
const { runtimeReading, roundReading, recentGaps, gapChanges } = require('../dashboard-notifications.js');

const now = Date.parse('2026-10-22T12:00:00Z');

test('saldo só fica verde com saldo e estado da aposta presentes e recentes', () => {
  const row = { captured_at: '2026-10-22T11:59:30Z', balance: 20, bet_active: false };
  assert.equal(runtimeReading(row, true, now), true);
  assert.equal(runtimeReading({ ...row, bet_active: true }, true, now), true);
  assert.equal(runtimeReading({ ...row, bet_active: undefined }, true, now), false);
  assert.equal(runtimeReading({ ...row, balance: null }, true, now), false);
  assert.equal(runtimeReading(row, false, now), false);
  assert.equal(runtimeReading({ ...row, captured_at: '2026-10-22T11:58:00Z' }, true, now), false);
});

test('coleta só é atual se a rodada mais nova tiver horário recente e consulta conectada', () => {
  const rows = [{ round_id: 9720000, captured_at: '2026-10-22T11:59:00Z' }];
  assert.equal(roundReading(rows, true, now), true);
  assert.equal(roundReading(rows, false, now), false);
  assert.equal(roundReading(rows, true, now + 180000), false);
});

test('lacunas estáveis geram aviso e só são marcadas preenchidas após surgir o ID', () => {
  const rows = [9720000, 9720001, 9720003, 9720004, 9720005, 9720006, 9720007, 9720008, 9720009].map(round_id => ({ round_id }));
  assert.deepEqual(recentGaps(rows, 300, 5), [9720002]);
  const first = gapChanges([], [9720002], rows);
  assert.deepEqual(first.detected, [9720002]);
  assert.deepEqual(first.open, [9720002]);
  const stillMissing = gapChanges(first.open, [], rows);
  assert.deepEqual(stillMissing.filled, []);
  const fixed = gapChanges(first.open, [], [...rows, { round_id: 9720002 }]);
  assert.deepEqual(fixed.filled, [9720002]);
  assert.deepEqual(fixed.open, []);
});
