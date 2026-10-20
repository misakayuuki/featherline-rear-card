const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../module/card/core.js');
const { NOW, MINUTE, HOUR, payload, frozen } = require('./fixtures.cjs');

test('official sample endpoints and midpoint are interpolated without a second PK model', () => {
  const p = payload();
  assert.equal(core.interpolate(p.e2, NOW - HOUR), 100);
  assert.equal(core.interpolate(p.e2, NOW), 126);
  assert.equal(core.interpolate(p.e2, NOW + HOUR / 2), 139);
  const view = core.view(p, NOW, {});
  assert.equal(view.estimateText, '126');
  assert.equal(view.unitLabel, 'pg/mL');
  assert.match(view.estimateNote, /模型估算.*非实测/);
});

test('display units stay attached to their supplied values and decimal units retain precision', () => {
  for (const [unit, values, expected] of [
    ['pg/mL', [100, 151], '126'],
    ['pmol/L', [400, 500], '450'],
    ['ng/dL', [10, 14.7], '12.35'],
    ['ng/mL', [0.12, 0.14], '0.13'],
    ['nmol/L', [0.3, 0.4], '0.35'],
  ]) {
    const p = payload(); p.e2.unit = unit; p.e2.values = values;
    const view = core.view(p, NOW, {});
    assert.equal(view.unitLabel, unit);
    assert.equal(view.estimateText, expected);
  }
});

test('a genuine zero concentration remains zero, distinct from missing data', () => {
  const p = payload(); p.e2.values = [0, 0];
  assert.equal(core.view(p, NOW, {}).estimateText, '0');
  assert.equal(core.view(payload({ e2: null }), NOW, {}).estimateText, '—');
});

test('invalid curves cannot display concentrations', () => {
  const invalid = [
    { times: [NOW, NOW], values: [1, 2] },
    { times: [NOW + HOUR, NOW - HOUR], values: [1, 2] },
    { times: [NOW - HOUR, NOW + HOUR], values: [1] },
    { values: [-1, 2] }, { values: [1, Infinity] }, { values: ['1', 2] },
    { times: [], values: [] }, { unit: 'mg/dL' }, { windowEnd: NOW - HOUR },
  ];
  for (const bad of invalid) {
    const p = payload(); Object.assign(p.e2, bad);
    assert.equal(core.interpolate(p.e2, NOW), null);
    assert.equal(core.view(p, NOW, {}).estimateText, '—');
  }
});

test('curve bounds reject extrapolation and the expiry endpoint is exclusive', () => {
  const p = payload();
  assert.equal(core.interpolate(p.e2, NOW - HOUR - 1), null);
  assert.equal(core.interpolate(p.e2, NOW + HOUR), null);
  assert.equal(core.interpolate(p.e2, NOW + HOUR + 1), null);
  p.e2.windowStart -= HOUR; p.e2.windowEnd += HOUR;
  assert.equal(core.interpolate(p.e2, NOW - HOUR - 1), null, 'a wider validity window does not extend the sample domain');
  assert.equal(core.interpolate(p.e2, NOW + HOUR + 1), null);
});

test('invalid payload identities and missing validity remain disconnected', () => {
  for (const p of [null, {}, payload({ schema: 2 }), payload({ source: 'Other' }), payload({ generatedAt: NaN }), payload({ validUntil: NOW - HOUR })]) {
    const view = core.view(p, NOW, {});
    assert.equal(view.connected, false);
    assert.equal(view.estimateText, '—');
  }
});

test('after 30 minutes the usable estimate is explicitly marked cached', () => {
  const boundary = core.view(payload({ generatedAt: NOW - 30 * MINUTE }), NOW, {});
  const stale = core.view(payload({ generatedAt: NOW - 30 * MINUTE - 1 }), NOW, {});
  assert.equal(boundary.stale, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.estimateText, '126');
  assert.match(stale.estimateNote, /缓存/);
  assert.match(stale.freshnessText, /缓存/);
});

test('after 24 hours or payload expiry old values are suppressed even within the curve', () => {
  for (const p of [payload({ generatedAt: NOW - 24 * HOUR - 1 }), payload({ validUntil: NOW })]) {
    const view = core.view(p, NOW, {});
    assert.equal(view.estimateText, '—');
    assert.deepEqual(view.points, []);
    assert.equal(view.countdownText, '等待更新');
    assert.match(view.freshnessText, /已过期/);
  }
});

test('a clock jump backwards beyond tolerance suppresses apparently future data', () => {
  const view = core.view(payload({ generatedAt: NOW + MINUTE + 1 }), NOW, {});
  assert.equal(view.estimateText, '—');
  assert.equal(view.countdownText, '等待更新');
  assert.match(view.freshnessText, /时间已改变/);
});

test('countdowns use absolute time and round up a partial minute', () => {
  const p = payload();
  assert.equal(core.view(p, NOW, {}).countdownText, '2小时 18分');
  assert.equal(core.view(p, p.nextDose.at - 30_000, {}).countdownText, '1分钟');
  assert.equal(core.view(p, p.nextDose.at - 5 * MINUTE, {}).countdownText, '5分钟');
});

test('at and after a scheduled dose, no dose is automatically recorded or marked done', () => {
  for (const offset of [0, -10 * MINUTE]) {
    const p = frozen(payload({ nextDose: { at: NOW + offset, label: '测试药物', timeText: '20:00' } }));
    const before = JSON.stringify(p);
    const view = core.view(p, NOW, {});
    assert.equal(view.countdownText, '已到计划时间');
    assert.match(view.pendingText, /核对/);
    assert.equal(view.progressText, '今日 1 / 3');
    assert.equal(JSON.stringify(p), before);
  }
});

test('crossing the supplied local midnight expires today progress without changing plans', () => {
  const midnight = NOW + 6 * HOUR;
  const p = payload({ today: { done: 3, total: 3, expiresAt: midnight }, generatedAt: midnight - MINUTE });
  assert.equal(core.view(p, midnight - 1, {}).progressText, '今日 3 / 3');
  assert.equal(core.view(p, midnight, {}).progressText, '今日进度待同步');
  assert.equal(core.view(p, midnight, {}).countdownText, '已到计划时间');
});

test('privacy hides values, medication details, schedule time, progress and curve', () => {
  const view = core.view(payload(), NOW, { privacy: true });
  assert.equal(view.estimateText, '•••');
  assert.equal(view.countdownText, '已隐藏');
  assert.equal(view.nextLabel, '下次计划用药');
  assert.equal(view.nextTimeText, '');
  assert.equal(view.progressText, '隐私模式');
  assert.deepEqual(view.points, []);
  assert.equal(view.pendingText, '');
});

test('source hide-details setting removes medication labels while retaining the planned time', () => {
  const view = core.view(payload({ hideDetails: true }), NOW, {});
  assert.equal(view.nextLabel, '下次计划用药');
  assert.equal(view.nextTimeText, '20:18');
  assert.equal(view.countdownText, '2小时 18分');
});
