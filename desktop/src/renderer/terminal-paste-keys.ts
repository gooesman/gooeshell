let releaseHeldEnter: (() => void) | undefined;

// Confirming a paste or activating a queue button changes focus immediately.
// Consume the rest of this physical press across terminals, even when the
// original tab closes. Register after the initial keyDown reaches its target.
export function holdPasteEnter() {
  if (releaseHeldEnter) return;
  const repeat = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const keyup = (event: KeyboardEvent) => { if (event.key === 'Enter') release(); };
  const release = () => {
    window.removeEventListener('keydown', repeat, true);
    window.removeEventListener('keyup', keyup, true);
    window.removeEventListener('blur', release);
    releaseHeldEnter = undefined;
  };
  releaseHeldEnter = release;
  window.addEventListener('keydown', repeat, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', release);
}
