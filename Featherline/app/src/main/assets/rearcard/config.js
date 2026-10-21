(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;else root.FeatherlineConfig = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var defaults = {
    theme: 'rose',
    accentColor: '',
    backgroundColor: '',
    privacy: false,
    showTrend: true,
    cameraInset: 336
  };
  var presets = {
    rose: {
      label: '樱粉',
      accent: '#f2bcce',
      bg: '#111015'
    },
    lavender: {
      label: '雾紫',
      accent: '#cbbcff',
      bg: '#12101c'
    },
    mint: {
      label: '薄荷',
      accent: '#a5decb',
      bg: '#0c1715'
    },
    blue: {
      label: '晴蓝',
      accent: '#a9d2ff',
      bg: '#0d1420'
    },
    amber: {
      label: '暖杏',
      accent: '#f2cf9e',
      bg: '#19130e'
    }
  };
  function hex(value) {
    if (typeof value !== 'string') return '';
    value = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(value)) value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    return /^#[0-9a-f]{6}$/.test(value) ? value : '';
  }
  function normalize(value) {
    var input = value && typeof value === 'object' ? value : {};
    var inset = typeof input.cameraInset === 'number' || typeof input.cameraInset === 'string' && input.cameraInset.trim() !== '' ? Number(input.cameraInset) : NaN;
    return {
      theme: Object.prototype.hasOwnProperty.call(presets, input.theme) ? input.theme : defaults.theme,
      accentColor: hex(input.accentColor),
      backgroundColor: hex(input.backgroundColor),
      privacy: input.privacy === true,
      showTrend: input.showTrend !== false,
      cameraInset: Number.isFinite(inset) ? Math.round(Math.max(280, Math.min(450, inset))) : defaults.cameraInset
    };
  }
  function rgb(color) {
    return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
  }
  function mix(a, b, fraction) {
    var x = rgb(a),
      y = rgb(b),
      result = '#';
    for (var i = 0; i < 3; i++) result += ('0' + Math.round(x[i] + (y[i] - x[i]) * fraction).toString(16)).slice(-2);
    return result;
  }
  function luminance(color) {
    var c = rgb(color);
    for (var i = 0; i < 3; i++) {
      c[i] /= 255;
      c[i] = c[i] <= 0.04045 ? c[i] / 12.92 : Math.pow((c[i] + 0.055) / 1.055, 2.4);
    }
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  }
  function contrast(a, b) {
    var x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function readable(color, background, target) {
    var foreground = contrast('#ffffff', background) >= contrast('#000000', background) ? '#ffffff' : '#000000';
    for (var step = 0; step <= 20; step++) {
      var candidate = mix(color, foreground, step / 20);
      if (contrast(candidate, background) >= target) return candidate;
    }
    return foreground;
  }
  function palette(value) {
    var config = normalize(value),
      preset = presets[config.theme];
    var bg = config.backgroundColor || preset.bg;
    var accent = readable(config.accentColor || preset.accent, bg, 4.5);
    var foreground = contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
    var panel = mix(bg, foreground, 0.06);
    if (contrast(foreground, panel) < 4.5) panel = mix(bg, foreground === '#ffffff' ? '#000000' : '#ffffff', 0.06);
    function bodyText(fraction) {
      var initial = mix(bg, foreground, fraction);
      for (var step = 0; step <= 20; step++) {
        var candidate = mix(initial, foreground, step / 20);
        if (contrast(candidate, bg) >= 4.5 && contrast(candidate, panel) >= 4.5) return candidate;
      }
      return foreground;
    }
    var badge = mix(bg, accent, 0.1);
    return {
      bg: bg,
      panel: panel,
      line: mix(bg, foreground, 0.18),
      pink: accent,
      white: bodyText(0.94),
      soft: bodyText(0.71),
      dim: bodyText(0.53),
      green: readable('#b1d6be', bg, 4.5),
      badge: badge,
      badgeText: readable(accent, badge, 4.5),
      warning: readable('#dfba82', bg, 4.5)
    };
  }
  return {
    defaults: defaults,
    presets: presets,
    normalize: normalize,
    palette: palette
  };
});