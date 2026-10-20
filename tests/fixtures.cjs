const NOW = Date.UTC(2026, 9, 21, 10, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
function payload(overrides = {}) {
  return {
    schema: 1, source: 'Featherline', generatedAt: NOW - 2 * MINUTE, validUntil: NOW + 72 * HOUR,
    e2: { unit: 'pg/mL', windowStart: NOW - HOUR, windowEnd: NOW + HOUR,
      times: [NOW - HOUR, NOW + HOUR], values: [100, 152] },
    nextDose: { at: NOW + 2 * HOUR + 18 * MINUTE, label: '测试药物 · 已有计划', timeText: '20:18' },
    today: { done: 1, total: 3, expiresAt: NOW + 6 * HOUR },
    overdueCount: 0,
    ...overrides,
  };
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
module.exports = { NOW, MINUTE, HOUR, payload, frozen };
