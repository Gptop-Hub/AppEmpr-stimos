const assert = require('node:assert/strict');
const test = require('node:test');

const {
  startOfWeekISO,
  endOfWeekISO,
  resolvePeriodoRange,
} = require('../services/caixaService');

test('semana do fluxo de caixa vai de segunda ate domingo', () => {
  assert.equal(startOfWeekISO('2026-07-13'), '2026-07-13');
  assert.equal(endOfWeekISO('2026-07-13'), '2026-07-19');
  assert.equal(startOfWeekISO('2026-07-19'), '2026-07-13');
  assert.equal(endOfWeekISO('2026-07-19'), '2026-07-19');

  const range = resolvePeriodoRange({ periodo: 'semana' });
  assert.equal(new Date(`${range.de}T00:00:00`).getDay(), 1);
  assert.equal(new Date(`${range.ate}T00:00:00`).getDay(), 0);
});
