const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { NOW, MINUTE, payload } = require('./fixtures.cjs');
const root = path.resolve(__dirname, '..');
const targets = require('./targets.cjs');

function harness(folder, options = {}) {
  const frames = new Map(), intervals = new Map(), saves = [], text = [], changes = [], refreshes = [];
  const canceledFrames = [], clearedIntervals = [], draws = [];
  let inFrame = false, nextId = 0, now = NOW, resolveConfig;
  const configPromise = new Promise(resolve => { resolveConfig = resolve; });
  function drawCall(name) {
    return (...args) => {
      assert.equal(inFrame, true, name + ' must run in RAF');
      if (name === 'fillText') text.push(String(args[0]));
      draws.push({ name, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, width: ctx.lineWidth });
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
  const renderer = fs.readFileSync(path.join(root, folder, 'main.js'), 'utf8');
  for (const file of ['config.js', 'core.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, folder, file), 'utf8'), sandbox, { filename: folder + '/' + file });
  }
  function execute() { vm.runInContext(renderer, sandbox, { filename: folder + '/main.js' }); }
  function frame() {
    const current = [...frames.entries()];
    for (const [id, callback] of current) {
      if (!frames.delete(id)) continue;
      inFrame = true;
      try { callback(); } finally { inFrame = false; }
    }
  }
  return { sandbox, execute, frame, frames, intervals, saves, text, draws, changes, refreshes, canceledFrames, clearedIntervals,
    resolveConfig, advance: milliseconds => { now += milliseconds; }, clearText: () => { text.length = 0; draws.length = 0; } };
}

for (const [name, folder] of targets) {
  test(name + ': card entry loads shared preferences before its model and renderer', () => {
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\s+src=["']([^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(scripts, ['config.js', 'core.js', 'data.js', 'main.js']);
    for (const file of scripts.filter(file => file !== 'data.js')) assert.ok(fs.existsSync(path.join(root, folder, file)), file);
  });

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
    assert.ok(h.text.includes('github.com/misakayuuki/'));
    assert.ok(h.text.includes('featherline-rear-card'));
    assert.ok(h.text.includes('在模块设置页可点击下载'));
    assert.ok(h.text.includes('已安装？在 App 设置 → 外观'));
    assert.ok(h.text.includes('尚未收到数据不代表 App 未安装'));
  });

  test(name + ': saved theme and camera reserve apply to the first frame before config responds', () => {
    const h = harness(folder, { embedded: payload(), snapshot: {
      schema: 1, payload: null, config: { theme: 'blue', cameraInset: 450 },
    } });
    h.execute(); h.frame();
    assert.equal(h.draws.find(d => d.name === 'fillRect').fill, '#0d1420');
    assert.ok(h.draws.some(d => d.name === 'stroke' && d.width === 2.5 && d.stroke === '#a9d2ff'));
    const heading = h.draws.find(d => d.name === 'fillText' && d.args[0] === 'Featherline');
    assert.equal(heading.args[1], 450 + 24 + 34);
    assert.equal(h.saves[0].config.theme, 'blue');
    assert.equal(h.saves[0].config.cameraInset, 450);
    assert.ok(h.text.includes('126'), 'a config-only snapshot must not erase embedded health data');
    assert.equal(h.saves[0].payload.e2.values[0], 100);
  });

  test(name + ': settings snapshot with null payload applies privacy before displaying embedded data', () => {
    const h = harness(folder, { embedded: payload(), snapshot: {
      schema: 1, payload: null, config: { theme: 'blue', privacy: true },
    } });
    h.execute(); h.frame();
    assert.equal(h.draws.find(d => d.name === 'fillRect').fill, '#0d1420');
    assert.ok(h.text.includes('•••'));
    assert.ok(h.text.includes('隐私模式'));
    assert.ok(!h.text.includes('126'));
    assert.ok(!h.text.includes('20:18'));
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 0);
    assert.equal(h.saves[0].payload.e2.values[0], 100, 'real source data stays authoritative');
    assert.equal(h.saves[0].config.privacy, true);
  });

  test(name + ': config changes repaint custom colors and persist normalized settings', () => {
    const h = harness(folder, { embedded: payload() });
    h.execute(); h.frame(); h.clearText();
    h.changes[0]({ theme: 'mint', backgroundColor: ' #FFF ', accentColor: '#123', cameraInset: '999' });
    assert.equal(h.draws.length, 0);
    h.frame();
    assert.equal(h.draws.find(d => d.name === 'fillRect').fill, '#ffffff');
    assert.ok(h.draws.some(d => d.name === 'stroke' && d.width === 2.5 && d.stroke === '#112233'));
    assert.equal(h.saves.at(-1).config.accentColor, '#112233');
    assert.equal(h.saves.at(-1).config.backgroundColor, '#ffffff');
    assert.equal(h.saves.at(-1).config.cameraInset, 450);
  });

  test(name + ': custom light theme uses the badge-specific readable text color', () => {
    const settings = { backgroundColor: '#ffffff', accentColor: '#069989' };
    const h = harness(folder, { embedded: payload(), snapshot: { schema: 1, config: settings } });
    h.execute(); h.frame();
    const colors = h.sandbox.FeatherlineConfig.palette(settings);
    assert.equal(h.draws.find(d => d.name === 'fillText' && d.args[0] === '模型估算').fill, colors.badgeText);
    assert.notEqual(colors.badgeText, colors.pink, 'the accent needs a stronger foreground on this badge');
  });

  test(name + ': hiding the trend removes curve strokes without hiding concentration or schedule', () => {
    const h = harness(folder, { embedded: payload() });
    h.execute(); h.frame();
    const withTrendLines = h.draws.filter(d => d.name === 'lineTo').length;
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 1);
    h.clearText(); h.changes[0]({ showTrend: false }); h.frame();
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 0);
    assert.ok(h.draws.filter(d => d.name === 'lineTo').length < withTrendLines);
    assert.ok(h.text.includes('126'));
    assert.ok(h.text.includes('2小时 18分'));
    assert.ok(h.text.includes('今日 1 / 3'));
    h.clearText(); h.changes[0]({ showTrend: true }); h.frame();
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 1);
  });

  test(name + ': snapshot fallback works only when no embedded payload exists', () => {
    const h = harness(folder, { snapshot: { schema: 1, payload: payload(), config: { privacy: true } } });
    h.execute(); h.frame();
    assert.ok(h.text.includes('•••'));
    assert.ok(!h.text.includes('126'));
    assert.ok(!h.text.includes('20:18'));
    assert.ok(!h.text.includes('测试药物 · 已有计划'));
    assert.ok(!h.text.includes('今日 1 / 3'));
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 0);
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
    assert.ok(!h.text.includes('20:18'));
    assert.ok(!h.text.includes('测试药物 · 已有计划'));
    assert.ok(!h.text.includes('今日 1 / 3'));
    assert.equal(h.draws.filter(d => d.name === 'stroke' && d.width === 2.5).length, 0);
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

  test(name + ': a delayed config read cannot restore the old theme or trend visibility', async () => {
    const h = harness(folder, { embedded: payload() });
    h.execute(); h.frame();
    h.changes[0]({ theme: 'blue', showTrend: false }); h.frame(); h.clearText();
    h.resolveConfig({ theme: 'rose', showTrend: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.frames.size, 0);
    assert.equal(h.saves.at(-1).config.theme, 'blue');
    assert.equal(h.saves.at(-1).config.showTrend, false);
  });
}
