import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppEventHub } from '../src/renderer/app-event-hub';
import type { AppEvent } from '../src/shared/types';

function fixture() {
  const source = new Set<(event: AppEvent) => void>();
  let registrations = 0, removals = 0, deliveries = 0;
  const subscribe = createAppEventHub(handler => {
    registrations++; source.add(handler);
    return () => { removals++; source.delete(handler); };
  });
  return { subscribe, emit(event: AppEvent) { for (const handler of [...source]) { deliveries++; handler(event); } },
    metrics: () => ({ registrations, removals, deliveries, active: source.size }) };
}

test('many terminal tabs share one bridge callback and receive exact ordered bytes', () => {
  const f = fixture(), output = Array.from({ length: 12 }, () => [] as string[]), general: AppEvent[] = [];
  const stops = output.map((stream, index) => f.subscribe(event => {
    if (event.type === 'terminal' && event.sessionId === String(index)) stream.push(event.data);
  }));
  stops.push(f.subscribe(event => { if (event.type !== 'terminal') general.push(event); }));
  for (let index = 0; index < 1200; index++) f.emit({ type: 'terminal', sessionId: String(index % 12), data: String(index), bytes: 1 });
  f.emit({ type: 'sessionClosed', sessionId: '3', message: 'Disconnected' });
  output.forEach((stream, index) => assert.deepEqual(stream, Array.from({ length: 100 }, (_, n) => String(n * 12 + index))));
  assert.equal(general.length, 1);
  assert.deepEqual(f.metrics(), { registrations: 1, removals: 0, deliveries: 1201, active: 1 });
  stops.forEach(stop => stop());
  assert.equal(f.metrics().active, 0); assert.equal(f.metrics().removals, 1);
});

test('duplicate handlers have independent cleanup and StrictMode remount does not leak subscriptions', () => {
  const f = fixture(), events: AppEvent[] = [], handler = (event: AppEvent) => events.push(event);
  const first = f.subscribe(handler), second = f.subscribe(handler);
  first(); first(); f.emit({ type: 'notice', message: 'one' });
  assert.equal(events.length, 1);
  second(); const third = f.subscribe(handler); second();
  f.emit({ type: 'notice', message: 'two' });
  assert.equal(events.length, 2); assert.equal(f.metrics().active, 1);
  third(); assert.deepEqual(f.metrics(), { registrations: 2, removals: 2, deliveries: 2, active: 0 });
});

test('subscription changes during delivery use a stable listener snapshot', () => {
  const f = fixture(), seen: string[] = []; let second = () => {};
  const first = f.subscribe(() => { seen.push('first'); second(); f.subscribe(() => seen.push('new')); });
  second = f.subscribe(() => seen.push('second'));
  f.emit({ type: 'notice', message: 'test' });
  assert.deepEqual(seen, ['first', 'second']);
  first(); f.emit({ type: 'notice', message: 'again' });
  assert.deepEqual(seen, ['first', 'second', 'new']);
});

test('source subscription failure can be retried without retaining the failed callback', () => {
  let attempts = 0, saved: ((event: AppEvent) => void) | undefined;
  const hub = createAppEventHub(handler => { if (!attempts++) throw new Error('bridge unavailable'); saved = handler; return () => { saved = undefined; }; });
  assert.throws(() => hub(() => { throw new Error('failed callback retained'); }), /bridge unavailable/);
  let received = 0; const stop = hub(() => received++);
  saved!({ type: 'notice', message: 'ready' }); assert.equal(received, 1); stop(); assert.equal(saved, undefined);
});
