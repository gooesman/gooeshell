import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerminalBytes, decodeTerminalBytesFallback } from '../src/renderer/terminal-output';

for (const [name, decode] of [['automatic', decodeTerminalBytes], ['compatibility', decodeTerminalBytesFallback]] as const) {
  test(`${name} terminal decoder preserves every byte and base64 padding boundary`, () => {
    for (const size of [0, 1, 2, 3, 255, 256, 257, 4096, 32768, 131072]) {
      const expected = Uint8Array.from({ length: size }, (_, index) => index % 256);
      assert.deepEqual(decode(Buffer.from(expected).toString('base64')), expected, `${size} bytes`);
    }
  });
  test(`${name} terminal decoder preserves split Chinese, emoji and control sequences`, () => {
    const expected = Buffer.from('\x1b[?1049h\x1b[32m中文终端😀\x1b[0m\r\n\x1b[?2004h');
    for (const size of [1, 2, 3, 5, 7]) {
      const packets = [];
      for (let start = 0; start < expected.length; start += size) packets.push(decode(expected.subarray(start, start + size).toString('base64')));
      assert.deepEqual(Buffer.concat(packets), expected, `${size}-byte packets`);
    }
  });
}
