(function () {
  'use strict';
  if (window.__featherlineDispose) window.__featherlineDispose();
  var canvas = document.getElementById('rear');
  var ctx = canvas.getContext('2d');
  var actualW = window.CANVAS_W || canvas.width || 912;
  var actualH = window.CANVAS_H || canvas.height || 596;
  var stopped = false;
  var queued = false;
  var frame = null;
  var config = { cameraInset: 336, privacy: false };
  var configGeneration = 0;
  var bridgeApi = typeof bridge === 'undefined' ? null : bridge;
  var stored = null;
  if (bridgeApi && bridgeApi.card && bridgeApi.card.readSnapshot) {
    try { stored = bridgeApi.card.readSnapshot(); } catch (_) { stored = null; }
  }
  if (stored && stored.schema === 1 && stored.config) config = stored.config;
  // New embedded data is authoritative, including null when the user stops sharing.
  var payload = Object.prototype.hasOwnProperty.call(window, 'FEATHERLINE_PAYLOAD')
    ? window.FEATHERLINE_PAYLOAD
    : stored && stored.schema === 1 ? stored.payload : null;
  var colors = { bg: '#111015', panel: '#211d26', line: '#39303e', pink: '#f2bcce', white: '#f9edf3', soft: '#bdadb9', dim: '#877b88', green: '#b1d6be' };

  function rounded(x, y, w, h, radius) {
    var r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(value, x, y, size, color, width, weight, align) {
    var label = value == null ? '' : String(value);
    ctx.font = (weight || '400') + ' ' + size + 'px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = align || 'left';
    ctx.fillStyle = color;
    if (width && ctx.measureText(label).width > width) {
      while (label.length && ctx.measureText(label + '…').width > width) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, x, y);
  }
  function requestDraw() {
    if (stopped || queued) return;
    queued = true;
    frame = window.requestAnimationFrame(function () {
      queued = false;
      if (!stopped) draw();
    });
  }
  function draw() {
    var model = window.FeatherlineCore.view(payload, Date.now(), config);
    var inset = Math.max(280, Math.min(450, Number(config.cameraInset) || 336));
    var left = inset + 24;
    var right = 878;
    var width = right - left;
    ctx.save();
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, actualW, actualH);
    ctx.scale(actualW / 912, actualH / 596);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, 912, 596);
    // Decorative marks stay clear of the right-side content.
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, 83); ctx.lineTo(right, 83); ctx.stroke();
    ctx.strokeStyle = colors.pink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(left + 2, 56); ctx.lineTo(left + 19, 37); ctx.lineTo(left + 16, 51);
    ctx.lineTo(left + 8, 54); ctx.stroke();
    text('Featherline', left + 34, 49, 24, colors.white, width - 130, '500');
    text('E2', right, 50, 17, colors.soft, 90, '500', 'right');

    if (!model.connected) {
      text('还没有连接数据', left, 178, 34, colors.white, width, '500');
      text('雌二醇估算浓度', left, 234, 22, colors.soft, width);
      text('—', left, 298, 74, colors.dim, width);
      ctx.fillStyle = colors.panel; rounded(left, 382, width, 112, 23); ctx.fill();
      text('下一次用药', left + 23, 412, 20, colors.soft, width - 46);
      text('等待 Featherline 数据', left + 23, 456, 27, colors.white, width - 46);
      text('请在 Featherline 设置中开启背屏同步', left, 553, 18, colors.dim, width);
      ctx.restore();
      return;
    }

    text('雌二醇', left, 118, 23, colors.soft, width - 155);
    ctx.fillStyle = '#352731'; rounded(right - 130, 101, 130, 33, 16); ctx.fill();
    text('模型估算', right - 65, 118, 17, colors.pink, 110, '400', 'center');
    var estimate = model.estimateText || '—';
    var estimateSize = 110;
    ctx.font = '400 ' + estimateSize + 'px sans-serif';
    while (estimateSize > 55 && ctx.measureText(estimate).width > width - 120) {
      estimateSize -= 2;
      ctx.font = '400 ' + estimateSize + 'px sans-serif';
    }
    text(estimate, left - 3, 203, estimateSize, colors.white, width - 105, '400');
    text(model.unitLabel, right, 228, 24, colors.pink, 115, '400', 'right');
    text(model.estimateNote || '模型估算 · 非实测', left, 276, 18, colors.dim, width);

    var points = config.privacy ? [] : model.points || [];
    if (points.length > 1) {
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, 335); ctx.lineTo(right, 335); ctx.stroke();
      ctx.strokeStyle = colors.pink;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (var i = 0; i < points.length; i++) {
        var px = left + Math.max(0, Math.min(1, points[i].x)) * width;
        var py = 333 - Math.max(0, Math.min(1, points[i].y)) * 35;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, 327); ctx.lineTo(right, 327); ctx.stroke();
    }

    ctx.fillStyle = colors.panel; rounded(left, 357, width, 129, 22); ctx.fill();
    text('距下次用药', left + 22, 386, 19, colors.soft, width - 130);
    text(model.nextTimeText, right - 22, 386, 18, colors.soft, 110, '400', 'right');
    text(model.countdownText || '暂无日程', left + 21, 433, 39, colors.white, width - 42, '500');
    text(model.nextLabel, left + 22, 466, 16, colors.dim, width - 44);
    text(model.progressText, left, 519, 20, colors.soft, width);
    var foot = model.pendingText || model.freshnessText;
    ctx.fillStyle = model.stale ? '#dfba82' : colors.green;
    ctx.beginPath(); ctx.arc(left + 4, 559, 3.5, 0, Math.PI * 2); ctx.fill();
    text(foot, left + 17, 559, 17, model.stale ? '#dfba82' : colors.dim, width - 17);
    ctx.restore();
  }

  var refreshTimer = window.setInterval(requestDraw, 60000);
  window.__featherlineDispose = function () {
    stopped = true;
    window.clearInterval(refreshTimer);
    if (frame != null && window.cancelAnimationFrame) window.cancelAnimationFrame(frame);
  };
  // Preview harness can replace data; production has no input that records a dose.
  window.FeatherlineCardPreview = {
    update: function (nextPayload, nextConfig) {
      if (stopped) return;
      payload = nextPayload;
      if (nextConfig) config = nextConfig;
      requestDraw();
    }
  };
  async function persist() {
    if (stopped || !bridgeApi || !bridgeApi.card || !bridgeApi.card.saveSnapshot) return;
    try { await bridgeApi.card.saveSnapshot({schema:1,payload:payload,config:config}); } catch (_) { /* Preserve current frame. */ }
  }
  async function loadConfig() {
    if (!bridgeApi || !bridgeApi.config) { await persist(); return; }
    var ticket = configGeneration;
    try {
      var value = await bridgeApi.config.get();
      if (stopped || ticket !== configGeneration) return;
      config = value || {cameraInset:336,privacy:false};
      requestDraw(); await persist();
    } catch (_) { if (!stopped) await persist(); }
  }
  function configChanged(value) {
    if (stopped) return;
    configGeneration++;
    config = value || {cameraInset:336,privacy:false}; requestDraw(); persist();
  }
  requestDraw();
  persist();
  if (bridgeApi && bridgeApi.config && bridgeApi.config.onChange) bridgeApi.config.onChange(configChanged);
  if (bridgeApi && bridgeApi.card && bridgeApi.card.onRefresh) bridgeApi.card.onRefresh(function(){if(!stopped)loadConfig();});
  loadConfig();
})();
