(function (root) {
  'use strict';
  var MINUTE = 60000, HOUR = 3600000;
  function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
  function duration(ms) {
    var m = Math.max(0, Math.ceil(ms / MINUTE));
    if (m >= 1440) return Math.floor(m / 1440) + '天 ' + Math.floor(m % 1440 / 60) + '小时';
    if (m >= 60) return Math.floor(m / 60) + '小时 ' + m % 60 + '分';
    return m + '分钟';
  }
  function validCurve(e) {
    return e && ['pg/mL','pmol/L','ng/dL','ng/mL','nmol/L'].indexOf(e.unit) >= 0 &&
      finite(e.windowStart) && finite(e.windowEnd) && e.windowEnd > e.windowStart &&
      Array.isArray(e.times) && Array.isArray(e.values) && e.times.length > 1 && e.times.length <= 2048 && e.times.length === e.values.length &&
      e.times.every(function (t, i) { return finite(t) && finite(e.values[i]) && e.values[i] >= 0 && (!i || t > e.times[i - 1]); });
  }
  function interpolate(e, now) {
    if (!validCurve(e) || now < e.windowStart || now >= e.windowEnd || now < e.times[0] || now > e.times[e.times.length - 1]) return null;
    for (var i = 1; i < e.times.length; i++) if (e.times[i] >= now) {
      var fraction = (now - e.times[i - 1]) / (e.times[i] - e.times[i - 1]);
      return e.values[i - 1] + (e.values[i] - e.values[i - 1]) * fraction;
    }
    return null;
  }
  function view(p, now, config) {
    config = config || {};
    var v = {connected:false,estimateText:'—',unitLabel:'pg/mL',estimateNote:'模型估算 · 非实测',countdownText:'等待数据',nextLabel:'下次计划用药',nextTimeText:'',progressText:'今日 — / —',freshnessText:'请在 Featherline 中开启背屏同步',stale:true,points:[],pendingText:''};
    if (!p || p.schema !== 1 || p.source !== 'Featherline' || !finite(p.generatedAt) || !finite(p.validUntil) || p.validUntil <= p.generatedAt) return v;
    v.connected = true;
    var age = now - p.generatedAt;
    var invalidTime = age < -MINUTE;
    var expired = now >= p.validUntil || age > 24 * HOUR || invalidTime;
    v.stale = expired || age > 30 * MINUTE;
    v.freshnessText = invalidTime ? '时间已改变 · 请打开应用同步' : expired ? '数据已过期 · 请打开应用同步' : v.stale ? '缓存 · ' + duration(age) + '前同步' : age < MINUTE ? '刚刚同步' : Math.floor(age / MINUTE) + '分钟前同步';
    var value = expired ? null : interpolate(p.e2, now);
    if (p.e2 && validCurve(p.e2)) v.unitLabel = p.e2.unit;
    if (value !== null) {
      v.estimateText = (v.unitLabel === 'pg/mL' || v.unitLabel === 'pmol/L') ? String(Math.round(value)) : String(Number(value.toFixed(2)));
      v.estimateNote = v.stale ? '缓存模型估算 · 非实测' : '模型估算 · 非实测';
      // Compact trend around now. Values are original Featherline samples, never a second PK model.
      var samples = p.e2.times.map(function (t,i) { return {t:t,v:p.e2.values[i]}; }).filter(function (x) { return x.t >= now - 6*HOUR && x.t <= now + 6*HOUR; });
      if (samples.length > 1) {
        var min = Math.min.apply(null,samples.map(function(x){return x.v;}));
        var max = Math.max.apply(null,samples.map(function(x){return x.v;}));
        v.points = samples.map(function(x){return {x:(x.t-samples[0].t)/(samples[samples.length-1].t-samples[0].t),y:(x.v-min)/Math.max(1,max-min)};});
      }
    } else v.estimateNote = expired ? '等待最新估算数据' : '暂无可用模型估算';
    if (!expired && p.nextDose && finite(p.nextDose.at)) {
      var remaining = p.nextDose.at - now;
      v.nextLabel = p.hideDetails ? '下次计划用药' : String(p.nextDose.label || '下次计划用药');
      v.nextTimeText = String(p.nextDose.timeText || '');
      v.countdownText = remaining > 0 ? duration(remaining) : '已到计划时间';
      if (remaining <= 0) v.pendingText = v.stale ? '缓存计划 · 请到 Featherline 核对' : '请到 Featherline 核对用药记录';
    } else v.countdownText = expired ? '等待更新' : p.nextDoseSearchLimited ? '暂无近期安排' : '暂无后续计划';
    if (!expired && p.today && finite(p.today.done) && finite(p.today.total) && p.today.done >= 0 && p.today.total >= p.today.done && finite(p.today.expiresAt) && now < p.today.expiresAt) {
      v.progressText = '今日 ' + p.today.done + ' / ' + p.today.total;
      if (p.overdueCount > 0) v.progressText += ' · ' + p.overdueCount + '项待核对';
    } else if (p.today && now >= p.today.expiresAt) v.progressText = '今日进度待同步';
    if (config.privacy) {
      v.estimateText='•••';v.nextLabel='下次计划用药';v.nextTimeText='';v.countdownText='已隐藏';v.progressText='隐私模式';v.points=[];v.pendingText='';
    }
    return v;
  }
  root.FeatherlineCore = {view:view,interpolate:interpolate};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FeatherlineCore;
})(typeof window !== 'undefined' ? window : globalThis);
