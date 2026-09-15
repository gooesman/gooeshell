import assert from 'node:assert/strict';
import test from 'node:test';
import { TransferProgress, TransferRate } from '../src/main/transfer-speed';
import type { TransferInfo } from '../src/shared/types';

function infoFor(): TransferInfo {
  return { id: 'test', sessionId: 'session', direction: 'upload', name: 'file', source: '/file', destination: '/copy',
    done: 0, total: 100_000, state: 'queued' };
}

test('rolling rate uses newly transferred bytes and falls to zero without new data', () => {
  let now = 0;
  const rate = new TransferRate(() => now);
  assert.equal(rate.value(), 0);
  now = 500; rate.add(1000);
  assert.equal(rate.value(), 2000);
  now = 1000; rate.add(1000);
  assert.equal(rate.value(), 2000);
  now = 2000;
  assert.equal(rate.value(), 1000);
  now = 2600;
  assert.equal(rate.value(), 500);
  now = 3000;
  assert.equal(rate.value(), 0);
  rate.add(2000);
  assert.equal(rate.value(), 1000);
  rate.reset();
  assert.equal(rate.value(), 0);
});

test('startup rates stay finite and invalid byte counts cannot corrupt a measurement', () => {
  const rate = new TransferRate(() => 123);
  for (const bytes of [NaN, Infinity, -1, 1.5]) rate.add(bytes);
  assert.equal(rate.value(), 0);
  rate.add(64 * 1024);
  assert.equal(rate.value(), 655360);
});

test('resume offsets and checking, packing or extraction progress do not contribute to network speed', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const info = infoFor(), abort = new AbortController();
  const progress = new TransferProgress(info, () => {}, abort.signal, () => now);
  t.after(() => progress.dispose());
  progress.phase('checking');
  info.done = 90_000;
  progress.transferred(90_000);
  assert.equal(info.bytesPerSecond, undefined);
  progress.phase('transferring');
  assert.equal(info.bytesPerSecond, 0);
  now = 1000; info.done += 1000; progress.transferred(1000);
  assert.equal(info.bytesPerSecond, 1000);
  for (const state of ['checking', 'packing', 'extracting', 'completed', 'failed', 'cancelled'] as const) {
    progress.phase(state);
    info.done += 1000; progress.transferred(1000);
    assert.equal(info.bytesPerSecond, undefined);
  }
});

test('one bounded refresh timer reports stalled zero and is removed on abort/disposal', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const info = infoFor(), abort = new AbortController();
  const events: TransferInfo[] = [];
  const progress = new TransferProgress(info, () => events.push({ ...info }), abort.signal, () => now);
  progress.phase('transferring');
  now = 100; progress.transferred(1000);
  for (let tick = 1; tick <= 9; tick++) {
    now = 100 + tick * 250;
    t.mock.timers.tick(250);
  }
  assert.equal(info.bytesPerSecond, 0);
  assert.equal(events.length, 10);
  assert.ok(events.some(event => (event.bytesPerSecond ?? 0) > 0));
  abort.abort();
  assert.equal(info.bytesPerSecond, undefined);
  const count = events.length;
  now += 10000; t.mock.timers.tick(10000);
  progress.transferred(1000); progress.phase('transferring'); progress.dispose(); abort.abort();
  assert.equal(info.bytesPerSecond, undefined);
  assert.equal(events.length, count);
});

test('leaving the transfer phase removes refreshes and starting the next file resets the sample', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, events = 0;
  const info = infoFor(), abort = new AbortController();
  const progress = new TransferProgress(info, () => { events++; }, abort.signal, () => now);
  t.after(() => progress.dispose());
  progress.phase('transferring'); now = 1000; progress.transferred(4000);
  assert.equal(info.bytesPerSecond, 4000);
  progress.phase('checking');
  const checked = events;
  now += 10000; t.mock.timers.tick(10000);
  assert.equal(events, checked);
  progress.phase('transferring');
  assert.equal(info.bytesPerSecond, 0);
  now += 1000; progress.transferred(1000);
  assert.equal(info.bytesPerSecond, 1000);
});
