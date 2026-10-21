(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('settings-form');
  var statusNode = byId('save-status');
  var saveButton = byId('save-settings');
  var retryButton = byId('retry-load');
  var configApi = window.FeatherlineConfig;
  if (!configApi || !configApi.normalize || !configApi.palette) {
    statusNode.textContent = '外观组件未能加载，请更新或重新安装此模块。';
    statusNode.dataset.kind = 'error';
    return;
  }

  var bridgeApi = typeof bridge === 'undefined' ? null : bridge;
  var connected = !!(bridgeApi && bridgeApi.config && typeof bridgeApi.config.get === 'function' && typeof bridgeApi.config.set === 'function');
  var keys = ['theme', 'accentColor', 'backgroundColor', 'privacy', 'showTrend', 'cameraInset'];
  var draft = configApi.normalize(configApi.defaults);
  var persisted = configApi.normalize(configApi.defaults);
  var dirty = new Set();
  var invalidColors = new Set();
  var loaded = !connected;
  var loading = false;
  var saving = false;
  var loadFailed = false;
  var saveFailed = false;
  var snapshotPending = false;
  var remoteRevision = 0;
  var loadGeneration = 0;
  var lifecycleEpoch = 0;
  var alive = true;
  var themeButtons = [];
  var colorFields = {
    accentColor: { picker: byId('accent-color'), text: byId('accent-hex'), error: byId('accent-error'), reset: byId('accent-reset') },
    backgroundColor: { picker: byId('background-color'), text: byId('background-hex'), error: byId('background-error'), reset: byId('background-reset') }
  };
  var demoMessage = '预览模式：未连接卡片桥，修改仅影响此页，不会保存。';

  function setStatus(message, kind) {
    statusNode.textContent = message;
    statusNode.dataset.kind = kind || 'normal';
  }

  function rememberChange(key) {
    if (draft[key] === persisted[key]) dirty.delete(key);
    else dirty.add(key);
    saveFailed = false;
    if (!connected) setStatus(demoMessage, 'demo');
    else if (invalidColors.size) setStatus('请先检查颜色格式，再保存设置。', 'error');
    else setStatus(dirty.size ? '外观已预览，点击保存后应用到背屏。' : snapshotPending ? '配置已保存，首帧外观仍需同步。点击“重试同步”继续。' : '已与卡片桥保存的设置一致。');
  }

  function update(key, value) {
    if (!loaded || saving || loading) return;
    var next = Object.assign({}, draft);
    next[key] = value;
    draft = configApi.normalize(next);
    rememberChange(key);
    render();
  }

  function renderPreview() {
    var palette = configApi.palette(draft);
    var preview = byId('card-preview');
    var colors = { bg: 'bg', panel: 'panel', accent: 'pink', text: 'white', muted: 'soft', dim: 'dim', line: 'line', badge: 'badge', 'badge-text': 'badgeText' };
    Object.keys(colors).forEach(function (name) { preview.style.setProperty('--preview-' + name, palette[colors[name]]); });
    preview.style.setProperty('--camera-width', (draft.cameraInset / 912 * 100) + '%');
    byId('preview-value').textContent = draft.privacy ? '•••' : '126';
    byId('preview-countdown').textContent = draft.privacy ? '已隐藏' : '2小时 18分';
    byId('preview-progress').textContent = draft.privacy ? '隐私模式' : '今日 1 / 3';
    byId('preview-trend').classList.toggle('is-hidden', !draft.showTrend || draft.privacy);
    return palette;
  }

  function render() {
    var palette = renderPreview();
    var disabled = !loaded || loading || saving;
    Array.prototype.forEach.call(form.querySelectorAll('input, button'), function (control) { control.disabled = disabled; });
    themeButtons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.theme === draft.theme)); });
    var preset = configApi.presets[draft.theme];
    byId('theme-summary').textContent = (preset ? preset.label : '主题') + (draft.accentColor || draft.backgroundColor ? ' · 已自定义' : '');
    Object.keys(colorFields).forEach(function (key) {
      var field = colorFields[key];
      var effective = key === 'accentColor' ? palette.pink : palette.bg;
      field.picker.value = draft[key] || effective;
      field.text.placeholder = effective.toUpperCase();
      if (!invalidColors.has(key)) field.text.value = draft[key] ? draft[key].toUpperCase() : '';
      field.error.hidden = !invalidColors.has(key);
      field.text.setAttribute('aria-invalid', String(invalidColors.has(key)));
      field.reset.disabled = disabled || (!draft[key] && !invalidColors.has(key));
    });
    byId('show-trend').checked = draft.showTrend;
    byId('privacy').checked = draft.privacy;
    byId('camera-inset').value = draft.cameraInset;
    byId('inset-value').textContent = draft.cameraInset + ' px';
    retryButton.hidden = !loadFailed;
    retryButton.disabled = loading || saving;
    saveButton.disabled = !connected || disabled || (!dirty.size && !snapshotPending) || invalidColors.size > 0;
    saveButton.textContent = !connected ? '预览模式 · 不保存' : saving ? '保存中…' : snapshotPending && !dirty.size ? '重试同步' : saveFailed ? '重试保存' : '保存设置';
    form.setAttribute('aria-busy', String(loading || saving));
  }

  function acceptRemote(value) {
    persisted = configApi.normalize(value);
    keys.forEach(function (key) {
      if (!dirty.has(key) && !invalidColors.has(key)) draft[key] = persisted[key];
      if (dirty.has(key) && draft[key] === persisted[key]) dirty.delete(key);
    });
    loaded = true;
    loading = false;
    loadFailed = false;
    if (!saving && !saveFailed) {
      setStatus(invalidColors.size ? '请先检查颜色格式，再保存设置。' : dirty.size ? '已保留你的未保存修改，其他设置已更新。' : snapshotPending ? '配置已保存，首帧外观仍需同步。点击“重试同步”继续。' : '已读取卡片桥中的设置。', invalidColors.size ? 'error' : 'normal');
    }
    render();
  }

  async function load() {
    if (!connected || saving || !alive) return;
    var ticket = ++loadGeneration;
    var epoch = lifecycleEpoch;
    var revision = remoteRevision;
    loading = true;
    loadFailed = false;
    setStatus('正在读取已保存的设置…');
    render();
    try {
      var value = await bridgeApi.config.get();
      if (!alive || epoch !== lifecycleEpoch || ticket !== loadGeneration || revision !== remoteRevision) return;
      acceptRemote(value);
    } catch (_) {
      if (!alive || epoch !== lifecycleEpoch || ticket !== loadGeneration || revision !== remoteRevision) return;
      loading = false;
      loadFailed = true;
      setStatus('暂时无法读取设置。为避免覆盖原设置，请重新读取后再编辑。', 'error');
      render();
    }
  }

  async function save() {
    if (!connected || !loaded || loading || saving || invalidColors.size || (!dirty.size && !snapshotPending) || !alive) return;
    var epoch = lifecycleEpoch;
    var pending = keys.filter(function (key) { return dirty.has(key); });
    var target = configApi.normalize(draft);
    var completed = 0;
    var snapshotStage = false;
    var snapshotAvailable = !!(bridgeApi.card && typeof bridgeApi.card.saveSnapshot === 'function');
    saving = true;
    saveFailed = false;
    // Keep this intent through a history restore: a config write may complete while hidden.
    snapshotPending = true;
    setStatus('正在保存外观设置…');
    render();
    try {
      // Patch only changed, known keys. Never replace a config object or remove unknown keys.
      for (var i = 0; i < pending.length; i++) {
        var key = pending[i];
        await bridgeApi.config.set(key, target[key]);
        if (!alive || epoch !== lifecycleEpoch) return;
        persisted[key] = target[key];
        if (draft[key] === target[key]) dirty.delete(key);
        completed++;
      }
      snapshotStage = true;
      setStatus('配置已保存，正在同步首帧外观…');
      // A sleeping rear display cannot receive config.onChange. Seed its synchronous
      // first-frame snapshot with confirmed settings, without copying any health data.
      var revision = remoteRevision;
      var saved = await bridgeApi.config.get();
      if (!alive || epoch !== lifecycleEpoch) return;
      if (revision !== remoteRevision) saved = persisted;
      var snapshotConfig = configApi.normalize(saved);
      acceptRemote(snapshotConfig);
      if (!snapshotAvailable) throw new Error('Snapshot API unavailable');
      await bridgeApi.card.saveSnapshot({ schema: 1, config: snapshotConfig, payload: null });
      if (!alive || epoch !== lifecycleEpoch) return;
      snapshotPending = false;
      setStatus('设置已保存。背屏将在运行或下次读取时应用。', 'success');
      if (bridgeApi.card && typeof bridgeApi.card.requestRefresh === 'function') {
        try { await bridgeApi.card.requestRefresh(); }
        catch (_) { if (alive && epoch === lifecycleEpoch) setStatus('设置已保存；背屏刷新请求未确认，下次读取时会应用。', 'success'); }
      }
    } catch (_) {
      if (!alive || epoch !== lifecycleEpoch) return;
      // A failed reply may follow a successful write. Repeating these small value assignments
      // is idempotent; retry is explicit and never touches unrelated configuration.
      saveFailed = true;
      if (snapshotStage) {
        setStatus(snapshotAvailable ? '配置已保存，但首帧外观同步未完成。点击“重试同步”继续。' : '配置已保存，但首帧外观同步未完成。卡片桥缺少快照接口，请先更新卡片桥后重试。', 'error');
      } else {
        pending.slice(completed).forEach(function (key) { draft[key] = target[key]; dirty.add(key); });
        setStatus(completed ? '部分设置已保存。点击“重试保存”完成剩余修改。' : '保存未确认完成，修改仍保留在此页。可点击“重试保存”。', 'error');
      }
    } finally {
      if (alive && epoch === lifecycleEpoch) { saving = false; render(); }
    }
  }

  ['rose', 'lavender', 'mint', 'blue', 'amber'].forEach(function (name) {
    var preset = configApi.presets[name];
    if (!preset) return;
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'theme-option'; button.dataset.theme = name;
    button.setAttribute('aria-pressed', 'false'); button.disabled = true;
    var swatch = document.createElement('span'); swatch.className = 'theme-swatch'; swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--swatch-accent', preset.accent);
    swatch.style.setProperty('--swatch-bg', preset.bg);
    var label = document.createElement('span'); label.textContent = preset.label;
    button.appendChild(swatch); button.appendChild(label);
    button.addEventListener('click', function () {
      if (!loaded || loading || saving) return;
      invalidColors.clear();
      draft = configApi.normalize(Object.assign({}, draft, { theme: name, accentColor: '', backgroundColor: '' }));
      ['theme', 'accentColor', 'backgroundColor'].forEach(rememberChange);
      render();
    });
    themeButtons.push(button); byId('theme-presets').appendChild(button);
  });

  Object.keys(colorFields).forEach(function (key) {
    var field = colorFields[key];
    field.picker.addEventListener('input', function () { invalidColors.delete(key); update(key, field.picker.value); });
    field.text.addEventListener('input', function () {
      if (!loaded || loading || saving) return;
      var value = field.text.value.trim();
      if (value === '' || /^#[a-f0-9]{6}$/i.test(value)) {
        invalidColors.delete(key);
        update(key, value);
      } else {
        invalidColors.add(key);
        setStatus(connected ? '请先检查颜色格式，再保存设置。' : demoMessage, connected ? 'error' : 'demo');
        render();
      }
    });
    field.reset.addEventListener('click', function () { invalidColors.delete(key); update(key, ''); });
  });
  byId('show-trend').addEventListener('change', function (event) { update('showTrend', event.target.checked); });
  byId('privacy').addEventListener('change', function (event) { update('privacy', event.target.checked); });
  byId('camera-inset').addEventListener('input', function (event) { update('cameraInset', Number(event.target.value)); });
  byId('restore-defaults').addEventListener('click', function () {
    if (!loaded || loading || saving) return;
    invalidColors.clear();
    draft = configApi.normalize(configApi.defaults);
    keys.forEach(rememberChange);
    setStatus(connected ? '已恢复默认预览，点击保存后生效。' : '已恢复默认预览；未连接卡片桥，不会保存。', connected ? 'normal' : 'demo');
    render();
  });
  form.addEventListener('submit', function (event) { event.preventDefault(); save(); });
  retryButton.addEventListener('click', load);
  window.addEventListener('pagehide', function () {
    alive = false;
    ++loadGeneration;
    ++lifecycleEpoch;
    // The browser may preserve this document in BFCache. Never preserve a busy UI
    // whose old async continuation has deliberately been invalidated.
    saving = false;
    loading = false;
  });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted || alive) return;
    alive = true;
    saveFailed = false;
    if (connected) {
      loaded = false;
      load();
    } else {
      loaded = true;
      setStatus(demoMessage, 'demo');
      render();
    }
  });

  render();
  if (!connected) { setStatus(demoMessage, 'demo'); return; }
  if (typeof bridgeApi.config.onChange === 'function') {
    bridgeApi.config.onChange(function (value) {
      if (!alive) return;
      remoteRevision++;
      acceptRemote(value);
    });
  }
  load();
})();
