import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTerminalPalette, resolveTerminalPalette, terminalPalettes } from '../src/shared/terminal-palettes';
import { terminalBackground, terminalTheme } from '../src/renderer/terminal-theme';

test('legacy and invalid selections follow the interface with the original colors', () => {
  for (const value of [undefined, null, '', 'unknown', '#123456', 12, {}]) {
    assert.equal(normalizeTerminalPalette(value), 'follow-interface');
  }
  assert.equal(terminalBackground('dark'), '#000000');
  assert.equal(terminalBackground('light'), '#ffffff');
  assert.equal(terminalTheme('dark').foreground, '#dddddd');
  assert.equal(terminalTheme('light').foreground, '#242424');
  assert.equal(terminalTheme('dark').blue, '#8eb7e5');
  assert.equal(terminalTheme('light').blue, '#245da0');
  for (const theme of ['dark', 'light'] as const) {
    assert.deepEqual(terminalTheme(theme), terminalTheme(theme, 'follow-interface'));
    assert.deepEqual(terminalTheme(theme), terminalTheme(theme, 'invalid-palette'));
  }
});

test('explicit terminal palettes survive interface changes and keep image layers transparent', () => {
  for (const palette of terminalPalettes) {
    assert.equal(normalizeTerminalPalette(palette.id), palette.id);
    assert.equal(resolveTerminalPalette('dark', palette.id).id, palette.id);
    assert.deepEqual(terminalTheme('dark', palette.id), terminalTheme('light', palette.id));
    assert.equal(terminalBackground('dark', palette.id), terminalBackground('light', palette.id));
    assert.equal(terminalTheme('dark', palette.id).background, `${terminalBackground('dark', palette.id)}00`);
  }
});

test('all palettes contain valid colors with readable default foregrounds', () => {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  assert.equal(new Set(terminalPalettes.map(palette => palette.id)).size, terminalPalettes.length);
  for (const palette of terminalPalettes) {
    for (const [key, color] of Object.entries(palette.colors)) {
      assert.match(color, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${palette.id}.${key}`);
    }
    const background = luminance(palette.colors.background);
    for (const key of ['foreground', 'blue', 'green', 'cyan'] as const) {
      const foreground = luminance(palette.colors[key]);
      const contrast = (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
      assert.ok(contrast >= 4.5, `${palette.id}.${key}: ${contrast}`);
    }
  }
});

test('xterm theme updates cannot mutate future terminal palettes', () => {
  const original = terminalTheme('dark', 'graphite');
  const mutable = terminalTheme('dark', 'graphite');
  mutable.foreground = '#ff0000';
  mutable.blue = '#ff0000';
  assert.deepEqual(terminalTheme('dark', 'graphite'), original);
});
