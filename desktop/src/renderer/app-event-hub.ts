import type { AppEvent } from '../shared/types';

type Handler = (event: AppEvent) => void;
type Subscribe = (handler: Handler) => () => void;

/** One contextBridge subscription per renderer. Extra tabs share the already
 * delivered event instead of copying it across isolated worlds for every tab. */
export function createAppEventHub(source: Subscribe): Subscribe {
  const subscribers = new Map<symbol, Handler>();
  let stop: (() => void) | undefined;
  return handler => {
    const key = Symbol();
    subscribers.set(key, handler);
    if (!stop) {
      try {
        stop = source(event => {
          // Match EventEmitter's snapshot semantics when a callback subscribes
          // or unsubscribes during delivery; each registration is independent.
          for (const callback of [...subscribers.values()]) callback(event);
        });
      } catch (error) { subscribers.delete(key); throw error; }
    }
    return () => {
      subscribers.delete(key);
      if (!subscribers.size && stop) { const unsubscribe = stop; stop = undefined; unsubscribe(); }
    };
  };
}
