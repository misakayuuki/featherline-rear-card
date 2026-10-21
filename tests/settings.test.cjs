const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const targets = require('./targets.cjs');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(cardFolder, options = {}) {
  const webFolder = cardFolder === 'module/card' ? 'module/webroot' : cardFolder + '/webroot';
  const html = fs.readFileSync(path.join(root, webFolder, 'index.html'), 'utf8');
  const elements = new Map(), all = [], changes = [], writes = [], windows = new Map(), snapshots = [], order = [];
  let refreshCount = 0, reads = 0;
  const remote = { ...options.remote };
  function element(tag, id) {
    const listeners = new Map(), attributes = new Map(), classes = new Set(), style = new Map();
    const node = { tagName: tag, id, dataset: {}, disabled: false, hidden: false, value: '', checked: false,
      textContent: '', children: [], style: { setProperty: (key, value) => style.set(key, value), getPropertyValue: key => style.get(key) },
      classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key), contains: key => classes.has(key) },
      setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key),
      appendChild: child => node.children.push(child),
      addEventListener: (event, callback) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(callback); },
      querySelectorAll: () => all.filter(item => item.tagName === 'input' || item.tagName === 'button'),
      fire: event => { for (const callback of listeners.get(event) || []) callback({ target: node, preventDefault() {} }); },
    };
    all.push(node);
    if (id) elements.set(id, node);
    return node;
  }
  for (const [, tag, attrs] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(attrs)?.[1];
    if (id) element(tag, id);
  }
  const sandbox = {
    Number, Math, Promise, Set,
    document: {
      getElementById: id => { assert.ok(elements.has(id), 'unknown element ' + id); return elements.get(id); },
      createElement: tag => element(tag),
    },
    addEventListener: (event, callback) => windows.set(event, callback),
  };
  if (!options.disconnected) sandbox.bridge = {
    config: {
      get: () => { reads++; return options.get ? options.get(reads) : Promise.resolve(clone(remote)); },
      set: async (key, value) => {
        writes.push([key, value]);
        order.push('set:' + key);
        if (options.set) await options.set(key, value, writes.length);
        remote[key] = value;
        for (const callback of changes) callback(clone(remote));
      },
      onChange: callback => changes.push(callback),
    },
    card: {
      ...(options.noSnapshot ? {} : { saveSnapshot: async value => {
        snapshots.push(clone(value)); order.push('snapshot');
        if (options.snapshot) await options.snapshot(value, snapshots.length);
      } }),
      requestRefresh: async () => { refreshCount++; order.push('refresh'); },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, cardFolder, 'config.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, webFolder, 'settings.js'), 'utf8'), sandbox);
  return { html, elements, writes, remote, windows, snapshots, order, node: id => elements.get(id),
    get reads() { return reads; }, get refreshCount() { return refreshCount; },
    change: value => changes.forEach(callback => callback(value)),
    theme: name => all.find(node => node.dataset.theme === name).fire('click'),
    input: (id, value, event = 'input') => { const node = elements.get(id); if (typeof value === 'boolean') node.checked = value; else node.value = value; node.fire(event); },
    save: () => elements.get('settings-form').fire('submit'),
  };
}

for (const [name, folder] of targets) {
  test(name + ': settings entry loads the bridge before shared config and offers a real release download', () => {
    const h = harness(folder, { disconnected: true });
    const scripts = [...h.html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(scripts, ['bridge-shim.js', '../card/config.js', 'settings.js']);
    assert.match(h.html, /href="https:\/\/github\.com\/misakayuuki\/featherline-rear-card\/releases"/);
    assert.match(h.html, /官方原版暂不提供这个接口/);
    assert.match(h.html, /此页面无法检查手机是否已安装 App/);
  });

  test(name + ': without the bridge preferences only preview and can never claim to save', async () => {
    const h = harness(folder, { disconnected: true });
    h.theme('blue'); h.input('privacy', true, 'change'); h.save(); await settle();
    assert.equal(h.node('preview-value').textContent, '•••');
    assert.equal(h.node('preview-countdown').textContent, '已隐藏');
    assert.ok(h.node('preview-trend').classList.contains('is-hidden'));
    assert.equal(h.node('save-settings').disabled, true);
    assert.match(h.node('save-status').textContent, /预览模式.*不会保存/);
    assert.deepEqual(h.writes, []);
  });

  test(name + ': a failed initial read prevents edits until explicit retry succeeds', async () => {
    const h = harness(folder, { get: read => read === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ theme: 'mint' }) });
    await settle();
    assert.equal(h.node('privacy').disabled, true);
    assert.equal(h.node('retry-load').hidden, false);
    h.theme('blue'); h.save(); await settle();
    assert.deepEqual(h.writes, []);
    h.node('retry-load').fire('click'); await settle();
    assert.equal(h.reads, 2);
    assert.equal(h.node('privacy').disabled, false);
    assert.match(h.node('theme-summary').textContent, /薄荷/);
  });

  test(name + ': saving patches only dirty known keys and keeps unrelated bridge configuration', async () => {
    const h = harness(folder, { remote: { theme: 'rose', unknownSetting: { untouched: true } } });
    await settle(); h.input('privacy', true, 'change'); h.input('camera-inset', '410'); h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', true], ['cameraInset', 410]]);
    assert.deepEqual(h.remote.unknownSetting, { untouched: true });
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.snapshots[0].schema, 1);
    assert.equal(h.snapshots[0].payload, null);
    assert.equal(h.snapshots[0].config.privacy, true);
    assert.equal(h.snapshots[0].config.cameraInset, 410);
    assert.deepEqual(h.order, ['set:privacy', 'set:cameraInset', 'snapshot', 'refresh']);
    assert.equal(h.refreshCount, 1);
    assert.equal(h.node('save-settings').disabled, true);
    assert.match(h.node('save-status').textContent, /设置已保存/);
  });

  test(name + ': partial failure keeps unsaved fields and retry does not repeat completed keys', async () => {
    const h = harness(folder, { set: (_key, _value, call) => call === 2 ? Promise.reject(new Error('failed')) : Promise.resolve() });
    await settle(); h.theme('blue'); h.input('privacy', true, 'change'); h.save(); await settle();
    assert.deepEqual(h.writes, [['theme', 'blue'], ['privacy', true]]);
    assert.equal(h.node('save-settings').textContent, '重试保存');
    assert.equal(h.node('preview-value').textContent, '•••');
    assert.equal(h.refreshCount, 0);
    h.save(); await settle();
    assert.deepEqual(h.writes, [['theme', 'blue'], ['privacy', true], ['privacy', true]]);
    assert.equal(h.refreshCount, 1);
    assert.equal(h.node('save-settings').disabled, true);
  });

  test(name + ': a remote change wins over an older pending read while local unsaved edits survive', async () => {
    const pending = deferred();
    const h = harness(folder, { get: () => pending.promise });
    h.change({ theme: 'blue', privacy: true });
    pending.resolve({ theme: 'rose', privacy: false }); await settle();
    assert.equal(h.node('preview-value').textContent, '•••');
    assert.match(h.node('theme-summary').textContent, /晴蓝/);
    h.input('privacy', false, 'change');
    h.change({ theme: 'mint', privacy: true, showTrend: false });
    assert.equal(h.node('privacy').checked, false);
    assert.equal(h.node('show-trend').checked, false);
    assert.match(h.node('theme-summary').textContent, /薄荷/);
    assert.equal(h.node('save-settings').disabled, false);
    h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', false]]);
  });

  test(name + ': malformed colors block saving and restoring defaults remains an explicit save', async () => {
    const h = harness(folder, { remote: { theme: 'blue' } });
    await settle(); h.input('accent-hex', '#xyz'); h.input('privacy', true, 'change');
    assert.equal(h.node('accent-hex').getAttribute('aria-invalid'), 'true');
    assert.equal(h.node('accent-error').hidden, false);
    assert.equal(h.node('save-settings').disabled, true);
    h.save(); await settle(); assert.deepEqual(h.writes, []);
    h.node('restore-defaults').fire('click');
    assert.equal(h.node('accent-error').hidden, true);
    assert.equal(h.node('privacy').checked, false);
    assert.equal(h.node('save-settings').disabled, false);
    assert.deepEqual(h.writes, [], 'reset must not save automatically');
    h.save(); await settle(); assert.deepEqual(h.writes, [['theme', 'rose']]);
  });

  test(name + ': leaving the page stops a pending save from submitting additional fields', async () => {
    const first = deferred();
    const h = harness(folder, { set: () => first.promise });
    await settle(); h.theme('blue'); h.input('privacy', true, 'change'); h.save();
    assert.deepEqual(h.writes, [['theme', 'blue']]);
    h.windows.get('pagehide')(); first.resolve(); await settle();
    assert.deepEqual(h.writes, [['theme', 'blue']]);
    assert.equal(h.refreshCount, 0);
  });

  test(name + ': a failed first-frame snapshot retries without rewriting successfully saved preferences', async () => {
    const h = harness(folder, { snapshot: (_value, call) => call === 1 ? Promise.reject(new Error('storage busy')) : Promise.resolve() });
    await settle(); h.input('privacy', true, 'change'); h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', true]]);
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.refreshCount, 0, 'do not refresh before the new privacy snapshot exists');
    assert.equal(h.node('save-settings').disabled, false);
    assert.match(h.node('save-status').textContent, /快照|首帧/);
    h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', true]], 'retry must not rewrite successful config keys');
    assert.equal(h.snapshots.length, 2);
    assert.equal(h.snapshots[1].config.privacy, true);
    assert.equal(h.refreshCount, 1);
    assert.equal(h.node('save-settings').disabled, true);
  });

  test(name + ': hosts without snapshot support warn instead of promising a ready first frame', async () => {
    const h = harness(folder, { noSnapshot: true });
    await settle(); h.input('privacy', true, 'change'); h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', true]]);
    assert.match(h.node('save-status').textContent, /快照|首帧/);
    assert.match(h.node('save-status').textContent, /不支持|无法|不能|未确认|缺少/);
    assert.notEqual(h.node('save-status').dataset.kind, 'success');
  });

  test(name + ': returning from browser page cache re-reads settings and permits saving again', async () => {
    const h = harness(folder);
    await settle(); h.windows.get('pagehide')({ persisted: true });
    assert.ok(h.windows.has('pageshow'), 'returning cached pages must restore their lifecycle');
    h.windows.get('pageshow')({ persisted: true }); await settle();
    assert.equal(h.reads, 2);
    h.input('privacy', true, 'change'); h.save(); await settle();
    assert.deepEqual(h.writes, [['privacy', true]]);
    assert.equal(h.refreshCount, 1);
    assert.equal(h.node('save-settings').disabled, true);
  });

  test(name + ': returning during an older save isolates its continuation and leaves remaining edits retryable', async () => {
    const first = deferred();
    const h = harness(folder, { set: (_key, _value, call) => call === 1 ? first.promise : Promise.resolve() });
    await settle(); h.theme('blue'); h.input('privacy', true, 'change'); h.save();
    h.windows.get('pagehide')({ persisted: true });
    assert.ok(h.windows.has('pageshow'));
    h.windows.get('pageshow')({ persisted: true }); await settle();
    first.resolve(); await settle();
    assert.deepEqual(h.writes, [['theme', 'blue']], 'old coroutine cannot continue with the privacy write');
    assert.equal(h.node('save-settings').disabled, false);
    h.save(); await settle();
    assert.deepEqual(h.writes, [['theme', 'blue'], ['privacy', true]]);
    assert.equal(h.refreshCount, 1);
  });
}
