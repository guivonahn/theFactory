/** Industrial skyline: sawtooth roof, stack, window bays and a production line. */
import { APPLE_UIKIT, themeFor } from './colors.js';
import { displayWidth } from './canvas.js';

const T = themeFor('dark');
const C = APPLE_UIKIT.dark.system;
const LETTERS = {
  F: ['█▀▀', '█▀ ', '▀  '], A: ['█▀█', '█▀█', '▀ ▀'],
  C: ['█▀▀', '█  ', '▀▀▀'], T: ['▀█▀', ' █ ', ' ▀ '],
  O: ['█▀█', '█ █', '▀▀▀'], R: ['█▀█', '██▀', '▀ ▀'],
  Y: ['█ █', '▀█▀', ' ▀ '],
};

export function isFactoryBusy(app) {
  return app.run?.state === 'running' ||
    (app.parallel?.counts?.running ?? 0) > 0 ||
    (app.parallel?.counts?.queued ?? 0) > 0 ||
    (app.parallel?.tasks ?? []).some((task) => ['running', 'ready'].includes(task.state)) ||
    [...(app.agents?.values() ?? [])].some((agent) => agent.status === 'working') ||
    (app.packets?.length ?? 0) > 0;
}

export function factoryGeometry(app) {
  const rows = app.layout?.sky?.rows ?? 0;
  if (app.layout?.tooSmall || !rows) return null;
  if (rows < 3) return { rows, tiny: true };
  const bodyWidth = 22;
  const largeLogo = app.width >= 60;
  const signWidth = largeLogo ? 31 : 10;
  const totalWidth = bodyWidth + 3 + signWidth;
  const col = Math.max(1, Math.floor((app.width - totalWidth) / 2));
  // A three-row building leaves actual air above the chimney in short headers.
  const bodyHeight = 3;
  const conveyor = rows >= 5;
  const top = rows - bodyHeight - (conveyor ? 1 : 0);
  return { rows, col, bodyWidth, bodyHeight, top, conveyor, largeLogo, signCol: col + bodyWidth + 3, stackCol: col + bodyWidth - 4, stackTop: Math.max(0, top - 1) };
}

/** Visible puffs attached to the pipe; no listeners or extra animation timers. */
export function smokePuffs(g, { now = 0, busy = false, reducedMotion = false } = {}) {
  if (!g || g.tiny) return [];
  const air = g.stackTop;
  const count = reducedMotion ? 1 : Math.max(1, Math.min(3, air));
  const puffs = [];
  for (let puff = 0; puff < count; puff++) {
    const phase = reducedMotion ? 0 : ((now / 2400) + puff / count) % 1;
    if (!busy && phase < 0.25) continue;
    const text = phase < 0.35 ? '( )' : phase < 0.65 ? 'o' : phase < 0.85 ? '°' : '·';
    const row = air ? air - 1 - Math.floor(phase * air) : 0;
    const drift = Math.floor(phase * (air ? 3 : 2));
    const col = air ? g.stackCol + 1 + drift - Math.floor(text.length / 2) : g.stackCol + 4 + drift;
    puffs.push({ row, col, text });
  }
  return puffs;
}

function caption(app, busy) {
  if (app.run?.state === 'error') return 'RUN INCOMPLETE';
  if (app.run?.state === 'aborted') return 'RUN CANCELLED';
  if (app.run?.state === 'done') return 'RUN COMPLETE';
  const working = app.parallel?.counts?.running || [...(app.agents?.values() ?? [])].filter((agent) => agent.status === 'working').length;
  return busy ? working ? `${working} WORKERS ACTIVE` : 'SYSTEM RUNNING' : 'SYSTEM READY';
}

export function drawFactory(app) {
  const g = factoryGeometry(app);
  if (!g) return;
  const { canvas } = app;
  const busy = isFactoryBusy(app);
  const now = app.reducedMotion ? 0 : app.now;
  const failed = app.run?.state === 'error';
  const happy = app.run?.state === 'done';
  if (g.tiny) {
    const col = Math.max(0, Math.floor((app.width - 16) / 2));
    canvas.write(0, col, '┌╥┐', T.textSecondary);
    canvas.write(0, col + 5, 'theFactory', T.textPrimary);
    if (g.rows > 1) {
      canvas.write(1, col, '└─┘', failed ? T.warning : T.textSecondary);
      canvas.write(1, col + 5, busy ? 'RUNNING' : happy ? 'COMPLETE' : 'READY', T.textSecondary);
    }
    if (busy) canvas.put(0, col + 3 + (app.reducedMotion ? 0 : Math.floor(now / 600) % 2), '°', T.textSecondary);
    return;
  }
  if (busy) app._factoryUntil = app.now + 1600;
  if (busy || !app.reducedMotion && app._factoryUntil > app.now) for (const puff of smokePuffs(g, { now, busy, reducedMotion: app.reducedMotion })) {
    canvas.write(puff.row, puff.col, puff.text, T.textPrimary);
  }
  const roof = `┌──┐${'_╱╲'.repeat(5)}──┐`;
  canvas.write(g.top, g.col, roof, T.textSecondary);
  for (let row = 1; row < g.bodyHeight - 1; row++) {
    canvas.write(g.top + row, g.col, `│${' '.repeat(g.bodyWidth - 2)}│`, T.textSecondary);
  }
  canvas.write(g.top + g.bodyHeight - 1, g.col, `└${'─'.repeat(g.bodyWidth - 2)}┘`, T.textSecondary);
  canvas.write(g.stackTop, g.stackCol, '┌╥┐', T.textSecondary);
  // Uniform industrial bays, never a face or a symmetrical pair of eyes.
  for (let bay = 0; bay < 4; bay++) {
    const col = g.col + 3 + bay * 4;
    const lit = busy && (app.reducedMotion || (Math.floor(now / 500) + bay) % 4 !== 0);
    canvas.write(g.top + 1, col, '▥▥', lit ? C.yellow : T.textSecondary);
    if (g.bodyHeight >= 4) canvas.write(g.top + 2, col, '══', T.textSecondary);
  }
  if (g.conveyor) {
    const row = g.top + g.bodyHeight;
    const wheel = busy && !app.reducedMotion ? ['┼', '╳'][Math.floor(now / 240) % 2] : '┼';
    canvas.write(row, g.col, `${wheel}${'─'.repeat(g.bodyWidth - 2)}${wheel}`, T.textSecondary);
    for (let parcel = 0; parcel < 3; parcel++) {
      const offset = (Math.floor(now / 240) * (busy ? 1 : 0) + parcel * 7) % (g.bodyWidth - 2);
      canvas.put(row, g.col + 1 + offset, '□', busy ? C.yellow : T.textSecondary);
    }
  }
  const signTop = g.top;
  canvas.write(signTop + 1, g.signCol, 'the', T.textSecondary);
  for (const [index, letter] of Array.from('FACTORY').entries()) {
    const glow = index === 0;
    for (let row = 0; row < 3; row++) canvas.write(signTop + row, g.signCol + 4 + index * 4, LETTERS[letter][row], glow ? C.yellow : T.textPrimary);
  }
  if (signTop + 3 < g.rows) {
    const text = caption(app, busy);
    const col = g.signCol + Math.max(0, Math.floor((31 - displayWidth(text)) / 2));
    canvas.write(signTop + 3, col, text, failed ? T.warning : happy ? T.success : T.textSecondary);
  }
}
