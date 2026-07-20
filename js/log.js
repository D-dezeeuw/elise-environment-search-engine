/*
  ELISE — in-app activity log.

  Modules call logEvent() as events start and finish; the app registers a
  sink that mirrors the entries into spektrum state for the log modal.
  Standalone module (not spektrum state directly) so the data-layer
  modules can log without knowing about the UI.
*/

const MAX_ENTRIES = 120;

const entries = [];
let sink = null;
let seq = 0;

const stamp = () => {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

export function logEvent(text, level = 'info') {
  entries.push({ id: ++seq, time: stamp(), text, level });
  if (entries.length > MAX_ENTRIES) entries.shift();
  sink?.([...entries]);
}

export function onLog(fn) {
  sink = fn;
  fn([...entries]);
}
