/** Tiny factory creatures. Fixed cell footprints; no timers or terminal escapes. */
import { APPLE_UIKIT, themeFor } from './colors.js';

const T = themeFor('dark');
export const WORKER_WIDTH = 16;
const WIDE_WORKER_WIDTH = 22;
const LARGE_PROPS = new Set(['developer', 'security', 'architect']);
export const WORKER_DESIGNS = ['dumpling', 'bean', 'puff'];
export const WORKER_STATES = ['working', 'thinking', 'idle', 'completed', 'failed'];
const PERIOD = { working: 150, thinking: 340, idle: 650, completed: 150, failed: 300 };
const TOOLS = {
  orchestrator: ['=|', '|='], explorer: ['o-', '-o'], architect: ['/_', '_/'],
  developer: ['==', '=='], reviewer: ['[=]', '[-]'], security: ['[+]', '[+]'],
  tester: ['°U', '·U'], other: ['T', 'T'],
};

// Props share the creature's pose/clock; larger workstations adapt to available cells.
function accessory(key, frame, state, width) {
  const active = state === 'working' && frame % 2 === 0;
  const wide = width >= WIDE_WORKER_WIDTH;
  if (key === 'developer') return {
    row: 2, col: wide ? 12 : 11,
    rows: wide ? ['┌───────┐', active ? '│▥▦▥▥▦▥▥│' : '│▥▥▥▥▥▥▥│', '└─[___]─┘']
      : ['┌───┐', active ? '│▥▦▥│' : '│▥▥▥│', '└[─]┘'],
  };
  if (key === 'security') return {
    row: 0, col: wide ? 12 : 11,
    rows: wide ? [active ? '^~^ ^~^' : ' ^   ^ ', active ? ' ^^^ ^ ' : '  ^ ^  ', '┌─┬─┬─┐', '├┬┴┬┴┬┤', '└┴─┴─┴┘']
      : [active ? '^~^ ^' : ' ^ ^ ', '  ^  ', '┌┬─┬┐', '├┴┬┴┤', '└─┴─┘'],
  };
  if (key === 'architect') return {
    row: 0, col: wide ? 12 : 11,
    rows: wide ? ['┌─────┐', '│▪ ▪ ▪│', '│▪ ▪ ▪│', '│▪ ▯ ▪│', '└──┴──┘']
      : ['┌───┐', '│▪ ▪│', '│▪ ▪│', '│ ▯ │', '└─┴─┘'],
  };
  let rows;
  switch (key) {
    case 'orchestrator': rows = [' ♪ ', active ? '─╥>' : '─╤>', '   ']; break; // tiny trumpet
    case 'explorer': rows = ['■ ■', '■ ■', '   ']; break; // four-pane XP flag
    case 'tester': rows = ['┌┬┐', active ? '├╋┤' : '├┼┤', '└┴┘']; break;
    default: rows = [];
  }
  return { row: 1, col: 12, rows };
}

/** Terminal apps have no OS motion media query: explicit flag/env take priority. */
export function prefersReducedMotion(env = process.env) {
  return env.FACTORY_REDUCED_MOTION === '1' || env.REDUCE_MOTION === '1' || env.TERM === 'dumb';
}

function seedFor(key) {
  return Array.from(key).reduce((seed, char) => ((seed * 31 + char.charCodeAt(0)) >>> 0), 7);
}

/** Six poses per state. Individual phase offsets keep the crew out of lockstep. */
export function workerFrame({ key = 'other', state = 'idle', elapsed = 0, reducedMotion = false } = {}) {
  if (reducedMotion) return 0;
  const period = PERIOD[state] ?? PERIOD.idle;
  // Completion is one little jump, then a happy resting pose, not endless hopping.
  if (state === 'completed') return Math.min(5, Math.floor(Math.max(0, elapsed) / period));
  return Math.floor((Math.max(0, elapsed) + seedFor(key) % (period * 6)) / period) % 6;
}

function pose(design, state, frame, key, height, width) {
  const active = frame === 1 || frame === 2 || frame === 4;
  const blink = frame === 4;
  let eyes = blink ? '─ ─' : '• •';
  let mouth = 'υ';
  let left = '▐';
  let right = '▌';
  let tool = '';
  let spark = '';
  let feet = '   ▄▄   ▄▄';
  if (state === 'working') {
    const tools = TOOLS[key] ?? TOOLS.other;
    right = active ? '┘' : '▌';
    tool = tools[active ? 0 : 1];
    spark = frame === 2 ? '·' : '';
    mouth = frame === 2 ? 'o' : 'υ';
    if (key === 'developer') { left = active ? '└' : '▐'; tool = active ? '[::]' : '[:·]'; }
    feet = active ? '  ▄▄   ▄▄' : feet;
  } else if (state === 'thinking') {
    eyes = frame === 1 || frame === 2 ? '• ·' : blink ? '─ ─' : '· •';
    mouth = 'ω'; right = active ? '┘' : '▌'; tool = active ? '?' : '';
  } else if (state === 'completed') {
    eyes = '^ ^'; mouth = 'υ'; left = frame < 4 ? '└' : '▐'; right = frame < 4 ? '┘' : '▌';
    spark = frame < 4 ? frame % 2 === 0 ? '*' : '+' : '·';
    feet = frame === 2 || frame === 3 ? '    ▪   ▪' : feet;
  } else if (state === 'failed') {
    eyes = active ? '@ ·' : '· @'; mouth = '~'; tool = '?'; spark = frame === 2 ? '~' : '';
    if (frame === 3) eyes = '@ @';
    if (frame === 5) mouth = 'o';
  }

  // Three original auditions: a chunky square worker, a bean, and a soot puff.
  let rows;
  if (design === 'bean') {
    rows = ['   _╭─┬─╮_', `   ( ${eyes} )`, `${left}  (  ${mouth}  )${right}${tool}`, '   (_____)', feet];
  } else if (design === 'puff') {
    rows = ['   _╭─┬─╮_', `  (˙${eyes}˙)`, `${left}(   ${mouth}   )${right}${tool}`, '   (____)', feet];
  } else {
    const smallTool = tool.replace('[::]', '[=]').replace('[:·]', '[·]');
    rows = ['   _╭─┬─╮_', `  ╭  ${eyes}  ╮`, `${left} │   ${mouth}   │${right}${smallTool}`, '  ╰─┬───┬─╯', feet];
  }
  if (key === 'reviewer') {
    // Actual square lenses and bridge, with blinking eyes behind the glasses.
    const lens = blink ? '─' : state === 'failed' ? '@' : state === 'completed' ? '^' : '•';
    rows[1] = `  ╭[${lens}]-[${lens}]╮`;
  }
  // Named crew keep their signature props in every state, rather than swapping
  // them for a generic question mark or an unrelated tool.
  if (key !== 'other') rows[2] = rows[2].slice(0, 12);
  if (state === 'thinking' && active) rows[0] += '┘';
  if (state === 'idle' && frame === 3) rows[2] = rows[2].replace('υ', 'ω');
  if (state === 'idle' && frame === 5) rows[1] = rows[1].replace('• •', '• ─');
  if (spark) rows[0] = `${spark}${rows[0].slice(1)} ${spark}`;
  // The sixth row is breathing/jump headroom; five-row terminals retain the face.
  if (height >= 6) {
    const lifted = (state === 'completed' && (frame === 2 || frame === 3)) ||
      (state === 'working' && frame === 2);
    rows = lifted ? [...rows, ''] : ['', ...rows];
  }
  if (!LARGE_PROPS.has(key) && ((state === 'idle' && (frame === 1 || frame === 2)) || (state === 'thinking' && frame === 2))) {
    rows = rows.map((line) => ` ${line}`);
  }
  const top = height >= 6 && rows[0].trim() === '' ? 1 : 0;
  if (LARGE_PROPS.has(key) && state === 'thinking' && frame === 2) rows[top + 1] = rows[top + 1].replace('• ·', '• o');
  const prop = accessory(key, frame, state, width);
  prop.rows.forEach((line, index) => {
    const row = top + prop.row + index;
    rows[row] = rows[row].padEnd(width).slice(0, prop.col) + line;
  });
  return rows.map((line) => line.padEnd(width)).slice(0, height);
}

// Precompute the tiny sprite atlas once. Rendering only selects and writes cells.
const ATLAS = new Map();
for (const design of WORKER_DESIGNS) for (const state of WORKER_STATES) {
  for (const key of Object.keys(TOOLS)) for (const height of [5, 6]) for (const width of [WORKER_WIDTH, WIDE_WORKER_WIDTH]) {
    ATLAS.set(`${design}:${state}:${key}:${height}:${width}`, Array.from({ length: 6 }, (_, frame) => pose(design, state, frame, key, height, width)));
  }
}

export function workerSprite({ design = 'dumpling', state = 'idle', key = 'other', frame = 0, height = 6, width = WORKER_WIDTH } = {}) {
  const safeDesign = WORKER_DESIGNS.includes(design) ? design : 'dumpling';
  const safeState = WORKER_STATES.includes(state) ? state : 'idle';
  const safeKey = Object.hasOwn(TOOLS, key) ? key : 'other';
  return ATLAS.get(`${safeDesign}:${safeState}:${safeKey}:${height === 5 ? 5 : 6}:${width >= WIDE_WORKER_WIDTH ? WIDE_WORKER_WIDTH : WORKER_WIDTH}`)[Math.max(0, Math.min(5, Math.floor(frame)))];
}

export function drawWorker(canvas, area, options = {}) {
  if (!area || area.width < WORKER_WIDTH || area.height < 5) return;
  const height = area.height >= 6 ? 6 : 5;
  const width = LARGE_PROPS.has(options.key) && area.width >= WIDE_WORKER_WIDTH ? WIDE_WORKER_WIDTH : WORKER_WIDTH;
  const frame = workerFrame(options);
  const rows = workerSprite({ ...options, frame, height, width });
  const prop = accessory(options.key, frame, options.state, width);
  const col = area.col + Math.floor((area.width - width) / 2);
  rows.forEach((line, row) => {
    for (const [offset, glyph] of Array.from(line).entries()) {
      if (glyph === ' ') continue;
      const isHat = /[╭─┬╮_]/u.test(glyph) && row === (height === 6 && rows[0].trim() === '' ? 1 : 0);
      const top = height === 6 && rows[0].trim() === '' ? 1 : 0;
      const propRow = row - top - prop.row;
      const isProp = offset >= prop.col && propRow >= 0 && propRow < prop.rows.length;
      const S = APPLE_UIKIT.dark.system;
      const propColor = options.key === 'explorer' ? [[S.red, S.green], [S.blue, S.yellow]][propRow]?.[offset === 12 ? 0 : 1]
        : options.key === 'security' ? propRow < 2 ? S.orange : S.brown
          : options.key === 'architect' && /[▪▯]/u.test(glyph) ? S.yellow
            : options.key === 'tester' ? S.green : options.key === 'orchestrator' ? S.yellow : options.color;
      const color = isProp && propColor ? propColor : isHat ? APPLE_UIKIT.dark.system.yellow
        : glyph === '*' ? T.warning
          : options.state === 'failed' ? T.warning : options.color ?? T.textPrimary;
      canvas.put(area.row + row, col + offset, glyph, color);
    }
  });
}
