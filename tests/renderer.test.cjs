const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { NOW, MINUTE, HOUR, payload } = require('./fixtures.cjs');
const root = path.resolve(__dirname, '..');
const targets = [
  ['source', 'module/card'],
  ['compiled app assets', 'Featherline/app/src/main/assets/rearcard'],
];

function harness(folder, options = {}) {
  const frames = new Map(), intervals = new Map(), saves = [], text = [], changes = [], refreshes = [];
  const canceledFrames = [], clearedIntervals = [];
  let inFrame = false, nextId = 0, now = NOW, resolveConfig;
  const configPromise = new Promise(resolve => { resolveConfig = resolve; });
  function drawCall(name) {
    return (...args) => {
      assert.equal(inFrame, true, name + ' must run in RAF');
      if (name === 'fillText') text.push(String(args[0]));
    };
  }
  const ctx = {};
  for (const name of ['save', 'restore', 'setTransform', 'clearRect', 'scale', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'arcTo', 'closePath', 'stroke', 'fill', 'arc', 'fillText']) ctx[name] = drawCall(name);
  ctx.measureText = value => { assert.equal(inFrame, true, 'measureText must run in RAF'); return { width: String(value).length * 9 }; };
  const canvas = { width: 912, height: 596, getContext: () => ctx };
  class Clock extends Date { static now() { return now; } }
  const sandbox = {
    Date: Clock, Number, Math, Promise,
    document: { getElementById: id => { assert.equal(id, 'rear'); return canvas; } },
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => { canceledFrames.push(id); frames.delete(id); },
    setInterval: (callback, ms) => { assert.equal(ms, MINUTE); const id = ++nextId; intervals.set(id, callback); return id; },
    clearInterval: id => { clearedIntervals.push(id); intervals.delete(id); },
    bridge: {
      card: {
        readSnapshot: () => options.snapshot || null,
        saveSnapshot: async value => { saves.push(JSON.parse(JSON.stringify(value))); },
        onRefresh: callback => refreshes.push(callback),
      },
      config: { get: () => configPromise, onChange: callback => changes.push(callback) },
    },
  };
  sandbox.window = sandbox;
  if (Object.hasOwn(options, 'embedded')) sandbox.FEATHERLINE_PAYLOAD = options.embedded;
  vm.createContext(sandbox);
  const core = fs.readFileSync(path.join(root, folder, 'core.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, folder, 'main.js'), 'utf8');
  vm.runInContext(core, sandbox, { filename: folder + '/core.js' });
  function execute() { vm.runInContext(renderer, sandbox, { filename: folder + '/main.js' }); }
  function frame() {
    const current = [...frames.entries()];
    for (const [id, callback] of current) {
      if (!frames.delete(id)) continue;
      inFrame = true;
      try { callback(); } finally { inFrame = false; }
    }
  }
  return { sandbox, execute, frame, frames, intervals, saves, text, changes, refreshes, canceledFrames, clearedIntervals,
    resolveConfig, advance: milliseconds => { now += milliseconds; }, clearText: () => { text.length = 0; } };
}

for (const [name, folder] of targets) {
  test(name + ': initial embedded data wins over the old snapshot before any bridge response', () => {
    const old = payload(); old.e2.values = [888, 888];
    const h = harness(folder, { embedded: payload(), snapshot: { schema: 1, payload: old, config: { privacy: false } } });
    h.execute();
    assert.deepEqual(h.text, [], 'initialization only requests a frame');
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.ok(h.text.includes('126'));
    assert.ok(!h.text.includes('888'));
    assert.equal(h.saves[0].payload.e2.values[0], 100);
  });

  test(name + ': explicit null clears old health data in the first frame and saved snapshot', () => {
    const old = payload(); old.e2.values = [999, 999];
    const h = harness(folder, { embedded: null, snapshot: { schema: 1, payload: old } });
    h.execute(); h.frame();
    assert.ok(h.text.includes('还没有连接数据'));
    assert.ok(!h.text.includes('999'));
    assert.equal(h.saves[0].payload, null);
  });

  test(name + ': snapshot fallback works only when no embedded payload exists', () => {
    const h = harness(folder, { snapshot: { schema: 1, payload: payload(), config: { privacy: true } } });
    h.execute(); h.frame();
    assert.ok(h.text.includes('•••'));
    assert.ok(!h.text.includes('126'));
  });

  test(name + ': config events and minute ticks schedule RAF instead of drawing directly', () => {
    const h = harness(folder, { embedded: payload() });
    h.execute(); h.frame(); h.clearText();
    h.changes[0]({ privacy: true, cameraInset: 336 });
    assert.equal(h.text.length, 0);
    assert.equal(h.frames.size, 1);
    for (const tick of h.intervals.values()) tick();
    assert.equal(h.frames.size, 1, 'one queued frame coalesces events');
    h.frame();
    assert.ok(h.text.includes('已隐藏'));
    assert.ok(!h.text.includes('126'));
  });

  test(name + ': after sleep countdown reads wall time and never records a dose', () => {
    const p = payload({ nextDose: { at: NOW + 5 * MINUTE, label: '已有计划', timeText: '18:05' } });
    const original = JSON.stringify(p);
    const h = harness(folder, { embedded: p });
    h.execute(); h.frame(); h.clearText();
    h.advance(10 * MINUTE);
    for (const tick of h.intervals.values()) tick();
    h.frame();
    assert.ok(h.text.includes('已到计划时间'));
    assert.ok(h.text.includes('今日 1 / 3'));
    assert.equal(JSON.stringify(p), original);
    assert.deepEqual(Object.keys(h.sandbox.bridge).sort(), ['card', 'config']);
  });

  test(name + ': hot update disposes queued frames/timers and old callbacks cannot alter new data', async () => {
    const h = harness(folder, { embedded: payload() });
    h.execute();
    const oldChange = h.changes[0], oldPreview = h.sandbox.FeatherlineCardPreview;
    h.sandbox.FEATHERLINE_PAYLOAD = null;
    h.execute();
    assert.equal(h.intervals.size, 1);
    assert.equal(h.frames.size, 1);
    assert.ok(h.canceledFrames.length > 0);
    assert.ok(h.clearedIntervals.length > 0);
    h.frame(); h.clearText();
    oldChange({ privacy: false }); oldPreview.update(payload(), { privacy: false });
    assert.equal(h.frames.size, 0);
    h.resolveConfig({ privacy: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.frame();
    assert.ok(!h.text.includes('126'));
    assert.equal(h.saves.at(-1).payload, null);
  });

  test(name + ': a delayed config read cannot undo a newer privacy change', async () => {
    const h = harness(folder, { embedded: payload() });
    h.execute(); h.frame();
    h.changes[0]({ privacy: true }); h.frame(); h.clearText();
    h.resolveConfig({ privacy: false });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.frame();
    assert.ok(!h.text.includes('126'), 'a stale read must not expose a value after privacy was enabled');
    assert.equal(h.saves.at(-1).config.privacy, true);
  });
}
