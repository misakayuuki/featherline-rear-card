// Reproducible production-renderer preview. Every displayed datum below is synthetic.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let canvasLibrary;
try { canvasLibrary = require('@napi-rs/canvas'); }
catch (_) { canvasLibrary = require('../../.cache/render-tools/node_modules/@napi-rs/canvas'); }
const { createCanvas, GlobalFonts } = canvasLibrary;
const project = path.resolve(__dirname, '..');
const now = Date.UTC(2026, 9, 21, 10, 0);
const HOUR = 3_600_000;
const fontPath = 'C:/Windows/Fonts/msyh.ttc';
if (fs.existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, 'sans-serif');

function sample() {
  const times = [], values = [];
  for (let step = -12; step <= 12; step++) {
    times.push(now + step * HOUR / 2);
    values.push(126 + 16 * Math.sin(step / 4) - step * 0.5);
  }
  return {
    schema: 1, source: 'Featherline', generatedAt: now - 120_000, validUntil: now + 6 * HOUR,
    e2: { unit: 'pg/mL', windowStart: times[0], windowEnd: times.at(-1), times, values },
    nextDose: { at: now + 2 * HOUR + 18 * 60_000, label: '示例数据 · 非真实用药计划', timeText: '20:18' },
    today: { done: 1, total: 3, expiresAt: now + 6 * HOUR }, overdueCount: 0,
  };
}

function render(name, payload, privacy = false) {
  const canvas = createCanvas(912, 596), ctx = canvas.getContext('2d'), frames = [];
  const textBounds = [];
  const originalFillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y, ...rest) => {
    const width = ctx.measureText(text).width;
    const size = Number(/([\d.]+)px/.exec(ctx.font)?.[1] || 16);
    const left = ctx.textAlign === 'right' ? x - width : ctx.textAlign === 'center' ? x - width / 2 : x;
    textBounds.push({ text, left, right: left + width, top: y - size / 2, bottom: y + size / 2 });
    originalFillText(text, x, y, ...rest);
  };
  class Clock extends Date { static now() { return now; } }
  const sandbox = {
    Date: Clock, Number, Math, Promise,
    document: { getElementById: () => ({ width: 912, height: 596, getContext: () => ctx }) },
    requestAnimationFrame: callback => (frames.push(callback), frames.length), cancelAnimationFrame() {},
    setInterval() { return 1; }, clearInterval() {}, FEATHERLINE_PAYLOAD: payload,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['core.js', 'main.js']) vm.runInContext(fs.readFileSync(path.join(project, 'module/card', file), 'utf8'), sandbox);
  if (privacy) sandbox.FeatherlineCardPreview.update(payload, { privacy: true, cameraInset: 336 });
  while (frames.length) frames.shift()();
  for (const bounds of textBounds) {
    assert.ok(bounds.left >= 336 && bounds.right <= 912, 'text exceeds horizontal safe bounds: ' + bounds.text);
    assert.ok(bounds.top >= 0 && bounds.bottom <= 596, 'text exceeds vertical bounds: ' + bounds.text);
  }
  // These marks occupy the camera reserve only; the right-hand UI above is the actual module.
  ctx.fillText = originalFillText;
  for (const cy of [150, 347]) {
    ctx.fillStyle = '#08080b'; ctx.strokeStyle = '#29252e'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(158, cy, 82, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#171621'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(158, cy, 53, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#171726'; ctx.beginPath(); ctx.arc(144, cy - 14, 16, 0, Math.PI * 2); ctx.fill();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#f2bcce'; ctx.font = '21px sans-serif';
  ctx.fillText('示例数据', 158, 482);
  ctx.fillStyle = '#938796'; ctx.font = '16px sans-serif';
  ctx.fillText('未连接真实账号', 158, 515);
  ctx.fillText('镜头区域示意', 158, 548);
  const file = path.join(__dirname, name + '.png');
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(name + '.png: 912 × 596, safe text bounds verified (' + textBounds.length + ' text draws)');
}

render('structured-card', sample());
render('structured-card-privacy', sample(), true);
render('structured-card-empty', null);
