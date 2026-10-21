const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const targets = require('./targets.cjs');

// Independent WCAG relative-luminance calculation checks actual canvas foreground/surface pairs.
function luminance(color) {
  const c = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) {
  return (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
}

for (const [name, folder] of targets) {
  const config = require(path.resolve(__dirname, '..', folder, 'config.js'));

  test(name + ': missing and malformed preferences produce safe independent defaults', () => {
    for (const input of [undefined, null, false, 12, 'blue', [], {}]) {
      assert.deepEqual(config.normalize(input), config.defaults);
    }
    const normalized = config.normalize({ theme: '__proto__', privacy: 'true', showTrend: 0,
      accentColor: 'red', backgroundColor: 'url(private)', cameraInset: Infinity });
    assert.deepEqual(normalized, config.defaults);
    normalized.theme = 'blue';
    assert.equal(config.defaults.theme, 'rose');
  });

  test(name + ': valid colors and booleans survive normalization without modifying the input', () => {
    const input = Object.freeze({ theme: 'lavender', accentColor: ' #AbC ', backgroundColor: '#FAFAFA',
      privacy: true, showTrend: false, cameraInset: '365.6', unexpected: 'ignored' });
    assert.deepEqual(config.normalize(input), {
      theme: 'lavender', accentColor: '#aabbcc', backgroundColor: '#fafafa', privacy: true,
      showTrend: false, cameraInset: 366,
    });
    for (const theme of Object.keys(config.presets)) assert.equal(config.normalize({ theme }).theme, theme);
  });

  test(name + ': camera reserve clamps numeric boundaries and rejects empty or nonnumeric values', () => {
    for (const [input, expected] of [[-1, 280], [280, 280], [450, 450], [999, 450], ['320', 320],
      ['', 336], [' ', 336], ['bad', 336], [null, 336], [false, 336], [NaN, 336]]) {
      assert.equal(config.normalize({ cameraInset: input }).cameraInset, expected, String(input));
    }
    for (const color of ['#abcd', '#12345', '#12345678', '#gggggg', '', null, 123]) {
      assert.equal(config.normalize({ accentColor: color, backgroundColor: color }).accentColor, '');
      assert.equal(config.normalize({ accentColor: color, backgroundColor: color }).backgroundColor, '');
    }
  });

  test(name + ': preset and custom light backgrounds retain readable small labels on their actual surfaces', () => {
    const choices = Object.keys(config.presets).map(theme => ({ theme })).concat([
      { backgroundColor: '#ffffff', accentColor: '#069989' },
      { backgroundColor: '#fafafa', accentColor: '#ffffff' },
      { backgroundColor: '#777777', accentColor: '#777777' },
      { backgroundColor: '#000000', accentColor: '#000000' },
    ]);
    for (const choice of choices) {
      const colors = config.palette(choice);
      for (const color of Object.values(colors)) assert.match(color, /^#[0-9a-f]{6}$/);
      for (const [foreground, background] of [['white', 'bg'], ['white', 'panel'], ['soft', 'bg'], ['soft', 'panel'],
        ['dim', 'bg'], ['dim', 'panel'], ['pink', 'bg'], ['badgeText', 'badge'], ['green', 'bg'], ['warning', 'bg']]) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(ratio >= 4.5, JSON.stringify(choice) + ' ' + foreground + '/' + background + ': ' + ratio.toFixed(3));
      }
    }
  });
}
