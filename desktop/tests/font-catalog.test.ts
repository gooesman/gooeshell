import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {availableFontFamilies, bundledFontFamilies, fontChoices, terminalFontLoads} from '../src/shared/fonts.ts';

test('font choices recommend only available families and retain missing saved choices separately', () => {
  const installed = ['Consolas', '@宋体', '宋体', 'Custom Terminal', 'consolas'];
  const available = availableFontFamilies(installed);
  assert.equal(available.filter(font => font.toLowerCase() === 'consolas').length, 1);
  assert.ok(!available.includes('@宋体'));
  assert.ok(!available.includes('Noto Sans SC'));
  const english = fontChoices(installed, 'english', 'Removed Personal Font');
  assert.equal(english.missing, 'Removed Personal Font');
  assert.ok(!english.other.includes('Removed Personal Font'));
  assert.ok(english.recommended.includes('DejaVu Sans Mono'));
  assert.ok(english.recommended.includes('Consolas'));
  const chinese = fontChoices(installed, 'chinese', '宋体');
  assert.deepEqual(chinese.recommended, ['宋体']);
  assert.equal(chinese.missing, '');
  const loads = terminalFontLoads({fontFamily: 'JetBrains Mono', chineseFont: '宋体', fontWeight: 700, fontSize: 14});
  assert.ok(loads.includes('400 14px "JetBrains Mono"'), 'xterm measures the regular face even when text is bold');
  assert.ok(loads.includes('700 14px "JetBrains Mono"'));
});

test('every bundled family has actual regular and bold font assets with correct metadata', async () => {
  const filenames: Record<string, [string, string]> = {
    'DejaVu Sans Mono': ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'],
    'JetBrains Mono': ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf'],
    'IBM Plex Mono': ['IBMPlexMono-Regular.ttf', 'IBMPlexMono-Bold.ttf'],
  };
  for (const family of bundledFontFamilies) {
    for (const [index, filename] of filenames[family].entries()) {
      const data = await readFile(new URL(`../public/fonts/${filename}`, import.meta.url));
      assert.equal(data.readUInt32BE(0), 0x00010000, `${filename} is a TrueType font`);
      const tables = new Map<string, number>();
      for (let i = 0; i < data.readUInt16BE(4); i++) {
        const start = 12 + i * 16;
        tables.set(data.toString('ascii', start, start + 4), data.readUInt32BE(start + 8));
      }
      const os2 = tables.get('OS/2');
      assert.notEqual(os2, undefined);
      assert.equal(data.readUInt16BE(os2! + 4), index === 0 ? 400 : 700, `${filename} weight`);
      const name = tables.get('name');
      assert.notEqual(name, undefined);
      const count = data.readUInt16BE(name! + 2), strings = name! + data.readUInt16BE(name! + 4);
      const families = new Set<string>();
      for (let i = 0; i < count; i++) {
        const record = name! + 6 + i * 12;
        if (data.readUInt16BE(record) !== 3 || data.readUInt16BE(record + 6) !== 1) continue;
        const start = strings + data.readUInt16BE(record + 10), length = data.readUInt16BE(record + 8);
        families.add(Buffer.from(data.subarray(start, start + length)).swap16().toString('utf16le'));
      }
      assert.ok(families.has(family), `${filename} has its advertised family name`);
    }
  }
});
