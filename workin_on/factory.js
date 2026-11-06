/**
 * theFactory skyline (workin_on dev workspace): an animated ASCII factory
 * inspired by the 🏭 formula, drawn into the sky region carved out by
 * `buildLayout` (`layout.sky.rows` reserved at the top of the frame).
 *
 * Art anatomy (back to front):
 *   smoke puffs -> 4-row factory silhouette (tower box, sawtooth roof, window
 *   band, chimney stack poking above the roof when room allows) -> the big
 *   "the FACTORY" sign spelled in 4-tall block letters sized to the art.
 *
 * Graceful scaling:
 *   sky 3 rows (24-row terminals): 3-row building + plain-text wordmark;
 *   sky 4: full 4-row art, no smoke;
 *   sky 5: chimney grows a smoke row above the roof;
 *   sky 6: chimney pokes one row above the roof, smoke above it;
 *   sky 7: two smoke rows. Narrow terminals (<73 cols) fall back to the
 *   plain-text wordmark instead of squeezing the letters.
 *
 * Design rules honoured here:
 *  - zero dependencies; colours come only from `src/colors.js` tokens;
 *  - stateless per frame + one cooldown timestamp on the app instance: smoke
 *    is a deterministic pure function of `app.now`, flicker-free under the
 *    12 FPS render loop and a few dozen puts per frame (no extra CPU);
 *  - animates only while a run or parallel workers are busy, with a short
 *    cooldown so puffs finish their rise instead of vanishing mid-air;
 *  - paints first in `App.draw()`, so log/config overlays cover it as usual;
 *  - every glyph is width-1 and writes clip at canvas edges.
 */

import { themeFor, APPLE_UIKIT } from '../src/colors.js';

const T = themeFor('dark'); // terminal role tokens (exact JSON hex)
const GRAY = APPLE_UIKIT.dark.system; // smoke/wall grays

const WALL = GRAY.gray3; // #48484A — industrial body tone
const EDGE = T.border; // #38383A — outline tone (matches branches)
const GLOW = GRAY.yellow; // #FFD60A — working lights (windows + sign)

/** Smoke keeps finishing its rise for this long after the last busy frame. */
const COOLDOWN_MS = 1600;
/** Rise cycle of one smoke puff; puffs are staggered quarter-periods apart. */
const PUFF_PERIOD_MS = 2600;
const PUFFS = 4;

const SIGN_GAP_ROOM = 2; // gap between building and the sign
/** Sign letters: 4 rows tall, 6 columns wide, 1 air column between. */
const GLYPH_W = 6;
const SIGN_STRIDE = 7; // 6 glyph cols + 1 air col
const SIGN_ROWS = 4;
/** Big sign needs "the"+gap (4) + letters (7*7-1=48) + 16-wide building + 4 margin. */
const SIGN_MIN_WIDTH = 73;
/** Tiny fallback wordmark (narrow modes): 'theFactory' text width. */
const FALLBACK_W = 10;

const SIGN_GLYPHS = {
  F: ['██████', '██░░░░', '█████░', '██░░░░'],
  A: ['░████░', '██░░██', '██████', '██░░██'],
  C: ['░█████', '██░░░░', '██░░░░', '░█████'],
  T: ['██████', '░░██░░', '░░██░░', '░░██░░'],
  O: ['░████░', '██░░██', '██░░██', '░████░'],
  R: ['██████', '██░░██', '█████░', '██░░▟█'],
  Y: ['██░░██', '░░██░░', '░░██░░', '░░██░░'],
};

function signGlyphs(word = 'FACTORY') {
  return word.split('').map((ch) => SIGN_GLYPHS[ch] ?? SIGN_GLYPHS.A);
}

/** Anything actively moving across the canvas counts as busy. */
export function isFactoryBusy(app) {
  if (app.run.state === 'running') return true;
  const counts = app.parallel?.counts;
  if (counts && (counts.running > 0 || counts.queued > 0)) return true;
  // Packets in flight: covers demo/replay showcases and message bursts.
  if ((app.packets?.length ?? 0) > 0) return true;
  return false;
}

/** Feathered smoke glyphs: hollow-bold near the stack, tiny as it dissipates. */
const SMOKE_RAMP = ['○', '◌', '°', '·'];

/**
 * Paint one frame of the skyline into `app.canvas`.
 * Pure render: no timers, no listeners; safe to call at any fps or size.
 */
export function drawFactory(app) {
  const layout = app.layout;
  if (!layout || layout.tooSmall) return;
  const skyRows = layout.sky?.rows ?? 0;
  const canvas = app.canvas;
  const width = app.width;
  if (skyRows < 3 || width < 48) return;

  const busy = isFactoryBusy(app);
  if (busy) app._factoryUntil = app.now + COOLDOWN_MS;
  const smoking = app._factoryUntil > app.now;

  // --- Geometry ------------------------------------------------------------
  // The building anchors to the bottom of the sky slice; the sign rides the
  // same rows (or falls back to plain text when the canvas is too narrow).
  const bodyH = Math.min(4, skyRows);
  const buildingTop = skyRows - bodyH;
  const signBig = skyRows >= SIGN_ROWS && width >= SIGN_MIN_WIDTH;
  const signW = signBig ? 4 + (7 * SIGN_STRIDE - 1) : FALLBACK_W;
  const bodyW = Math.max(16, Math.min(30, width - (signW + SIGN_GAP_ROOM + 4)));
  const artW = bodyW + SIGN_GAP_ROOM + signW;
  const startCol = Math.max(1, Math.floor((width - artW) / 2));

  // Chimney pokes one row above the roof only when that still leaves a full
  // smoke row between the stack top and the frame edge.
  const poke = buildingTop >= 2;
  const rowStack = poke ? buildingTop - 1 : null;

  if (smoking) {
    drawSmoke({
      canvas,
      now: app.now,
      busy,
      chimneyCol: startCol + bodyW - 2,
      stackTopRow: rowStack ?? buildingTop,
      width,
    });
  }
  drawBuilding({ canvas, col: startCol, bodyTop: buildingTop, bodyH, bodyW, rowStack, busy, now: app.now });
  if (signBig) {
    drawSign({ canvas, col: startCol + bodyW + SIGN_GAP_ROOM, top: buildingTop, busy });
  } else {
    drawTextSign({ canvas, col: startCol + bodyW + SIGN_GAP_ROOM, top: buildingTop, bodyH, busy });
  }
}

/** Sawtooth profile: '‾/\‾/\\' repeated, remainder padded with '‾'. */
function teethString(len) {
  const unit = '‾/\\';
  return unit.repeat(Math.floor(len / 3)) + unit.slice(0, len % 3);
}

/**
 * Parametric silhouette: left tower (multi-row box), sawtooth roof, shaded
 * wall bands, right chimney stack ('▐█▌' three cols, poking a row above the
 * roof when `rowStack` is set). Busy lights the lower window band amber with
 * a slow shimmer; idle leaves dark insets so the silhouette reads "off".
 */
function drawBuilding({ canvas, col, bodyTop, bodyH, bodyW, rowStack, busy, now }) {
  const towerW = bodyH === 4 ? 5 : 4; // '┌▓▓▓┐' vs '┌▓▓┐'
  const teethW = bodyW - towerW - 3; // tower + right chimney '▐█▌'
  const towerTop = bodyH === 4 ? '┌▓▓▓┐' : '┌▓▓┐';
  const towerSide = `│${'▓'.repeat(towerW - 2)}│`;
  const towerFoot = bodyH === 4 ? '└▓▓▓┘' : '└▓▓┘';

  const roof = `${towerTop}${teethString(teethW)}▐█▌`;
  canvas.write(bodyTop, col, roof, WALL);
  canvas.write(bodyTop, col, towerTop, EDGE);

  for (let r = 1; r < bodyH; r += 1) {
    const tower = r === bodyH - 1 ? towerFoot : towerSide;
    canvas.write(bodyTop + r, col, `${tower}${'░'.repeat(teethW)}▐█▌`, WALL);
    canvas.write(bodyTop + r, col, tower, EDGE);
  }
  if (rowStack != null) canvas.write(rowStack, col + bodyW - 3, '▐█▌', WALL);

  // Main window band on the foot row: 2-wide pairs, slow shimmer phase.
  const shimmer = Math.floor(now / 900) % 2;
  const bandRow = bodyTop + bodyH - 1;
  for (let i = 0; i + 1 < teethW; i += 3) {
    const windowCol = col + towerW + i;
    const lit = busy && (i / 3 + shimmer) % 3 !== 0;
    const style = lit ? GLOW : EDGE;
    canvas.put(bandRow, windowCol, '▪', style);
    canvas.put(bandRow, windowCol + 1, '▪', style);
  }
  // Sparse dark vents on the upper wall row for texture (never lit).
  if (bodyH === 4) {
    for (let i = 2; i < teethW; i += 5) {
      canvas.put(bodyTop + 1, col + towerW + i, '▪', EDGE);
    }
  }
}

/**
 * Big pixel sign beside the building: tiny "the" then FACTORY in 4-row block
 * letters, glowing amber while the agents are working, white at rest.
 */
function drawSign({ canvas, col, top, busy }) {
  const style = busy ? GLOW : T.textPrimary;
  canvas.write(top + 1, col, 'the', T.textSecondary);
  const glyphs = signGlyphs();
  const letterCol0 = col + 4; // "the" + one col gap
  for (let row = 0; row < SIGN_ROWS; row += 1) {
    let cursor = letterCol0;
    for (const glyph of glyphs) {
      canvas.write(top + row, cursor, glyph[row], style);
      cursor += SIGN_STRIDE; // 6 glyph cols + 1 col of air
    }
  }
}

/** Narrow-canvas fallback: the original two-tone text wordmark. */
function drawTextSign({ canvas, col, top, bodyH, busy }) {
  const row = top + Math.floor(bodyH / 2);
  canvas.write(row, col, 'the', busy ? GLOW : T.textSecondary);
  canvas.write(row, col + 3, 'Factory', busy ? GLOW : T.textPrimary);
}

/**
 * Deterministic smoke: puffs rise from the chimney stack, drift right with a
 * slow wobble, and shrink along SMOKE_RAMP as they dissipate. During cooldown
 * freshly-emitted phases are suppressed so the plume thins, never resets.
 * Painted before the building/sign so drifting puffs never occlude the art.
 */
function drawSmoke({ canvas, now, busy, chimneyCol, stackTopRow, width }) {
  const available = Math.max(0, stackTopRow); // rows of travel above the stack
  if (available <= 0) return;
  for (let puff = 0; puff < PUFFS; puff += 1) {
    const phase = ((now / PUFF_PERIOD_MS) + puff / PUFFS) % 1; // 0..1 through rise
    if (!busy && phase < 0.2) continue; // cooldown: only existing puffs finish

    const rise = phase * available;
    const row = Math.max(0, stackTopRow - 1 - Math.floor(rise));
    const drift = Math.round(phase * 2.2 + Math.sin(now / 700 + puff * 1.7) * 0.9);
    const col = chimneyCol + drift;
    if (col < 0 || col >= width) continue;
    const glyph = SMOKE_RAMP[Math.min(SMOKE_RAMP.length - 1, Math.floor(phase * SMOKE_RAMP.length))];
    const style = phase < 0.4 ? GRAY.gray2 : GRAY.gray3; // fades with altitude
    canvas.put(row, col, glyph, style);
  }
}
