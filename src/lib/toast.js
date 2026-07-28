// Minimal toast pub/sub — no context/provider plumbing, just a module event bus.
// ponytail: module-level Set, fine for a single-page dashboard.

const listeners = new Set();
let seq = 0;

export function toast(message, kind = "error") {
  const t = { id: ++seq, message, kind };
  listeners.forEach((l) => l(t));
}

export function subscribeToast(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
