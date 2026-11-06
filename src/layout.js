/**
 * Radial layout geometry: one central orchestrator box, six agent pillars
 * arranged in three bands, and orthogonal branch paths made of cell steps.
 */

import { AGENT_ORDER, agentByKey } from './agents.js';

export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 24;

const BAND_ROWS = { top: 0, middle: 1, bottom: 2 };
const SLOT_SPECS = [
  { key: 'explorer', side: 'left', band: 'top' },
  { key: 'architect', side: 'right', band: 'top' },
  { key: 'developer', side: 'left', band: 'middle' },
  { key: 'reviewer', side: 'right', band: 'middle' },
  { key: 'security', side: 'left', band: 'bottom' },
  { key: 'tester', side: 'right', band: 'bottom' },
];

/** Build an orthogonal step list from one cell to another. */
export function orthogonalPath(start, end, firstAxis = 'horizontal') {
  const steps = [{ row: start.row, col: start.col }];
  let row = start.row;
  let col = start.col;
  const moveRow = () => {
    const delta = Math.sign(end.row - row);
    while (row !== end.row) {
      row += delta;
      steps.push({ row, col });
    }
  };
  const moveCol = () => {
    const delta = Math.sign(end.col - col);
    while (col !== end.col) {
      col += delta;
      steps.push({ row, col });
    }
  };
  if (firstAxis === 'vertical') {
    moveRow();
    moveCol();
  } else {
    moveCol();
    moveRow();
  }
  return steps;
}

/**
 * Terminal sizing: `skyRowsFor(height)` rows are reserved at the top of the
 * frame for the animated factory skyline; the agent band shifts down by it.
 * 3 = 3-row factory squeezed (24-row terminals), up to 6 = building + wide
 * smoke sky. Constraint: `1 + rows` <= floor(height/2) - 8 so the top band
 * always clears the center box (held for everything >= 60x24).
 */
export function skyRowsFor(height) {
  return Math.max(3, Math.min(7, Math.floor((height - 24) / 2) + 3));
}

function agentSlotBox(side, band, width, height, boxWidth, boxHeight, centerRow, footerRows, skyRows) {
  const rowByBand = {
    top: 1 + skyRows,
    middle: centerRow - Math.floor(boxHeight / 2),
    bottom: height - boxHeight - footerRows,
  };
  const row = rowByBand[band];
  const col = side === 'left' ? 2 : width - boxWidth - 2;
  return { row, col, width: boxWidth, height: boxHeight };
}

function branchFor(spec, box, center) {
  const midRow = box.row + Math.floor(box.height / 2);
  const outsideCol = spec.side === 'left' ? box.col + box.width : box.col - 1;

  if (spec.band === 'middle') {
    const startCol = spec.side === 'left' ? center.col - 1 : center.col + center.width;
    return orthogonalPath(
      { row: center.row + Math.floor(center.height / 2), col: startCol },
      { row: midRow, col: outsideCol },
      'horizontal',
    );
  }

  if (spec.band === 'top') {
    const fraction = spec.side === 'left' ? 0.3 : 0.7;
    const startCol = center.col + Math.floor(center.width * fraction);
    return orthogonalPath(
      { row: center.row - 1, col: startCol },
      { row: midRow, col: outsideCol },
      'vertical',
    );
  }

  const startCol = spec.side === 'left' ? center.col : center.col + center.width - 1;
  return orthogonalPath(
    { row: center.row + center.height, col: startCol },
    { row: midRow, col: outsideCol },
    'vertical',
  );
}

/**
 * Two-lane branches: `path` carries center→agent traffic, `returnPath` the
 * agent→center lane, offset one cell perpendicular so the two directions
 * never overlap. Side of the offset flips with the box side so lanes stay
 * between the boxes they connect, not through them.
 */
function returnLaneFor(spec, path) {
  if (spec.band === 'middle') {
    // Horizontal lanes stack one row below.
    return path.map((cell) => ({ row: cell.row + 1, col: cell.col }));
  }
  if (spec.band === 'top') {
    // Vertical lanes sit one column inward on the left, outward on the right.
    const delta = spec.side === 'left' ? -1 : 1;
    return path.map((cell) => ({ row: cell.row, col: cell.col + delta }));
  }
  const delta = spec.side === 'left' ? 1 : -1;
  return path.map((cell) => ({ row: cell.row, col: cell.col + delta }));
}

/**
 * Compute the full frame geometry for a terminal size.
 * Returns `{ tooSmall: true }` below the 60x24 minimum.
 */
export function buildLayout(width, height, options = {}) {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { tooSmall: true, width, height, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT };
  }

  const footerRows = Math.max(1, Math.min(3, options.footerRows ?? 1));

  const boxWidth = Math.max(17, Math.min(28, Math.round(width * 0.27)));
  const boxHeight = height < 34 ? 5 : height < 36 ? 6 : 7;
  const centerWidth = Math.min(44, Math.max(20, width - 2 * (boxWidth + 5)));
  const center = {
    row: Math.floor(height / 2) - 3,
    col: Math.floor((width - centerWidth) / 2),
    width: centerWidth,
    height: 7,
  };
  center.midRow = center.row + Math.floor(center.height / 2);
  center.midCol = center.col + Math.floor(center.width / 2);
  const centerRow = Math.floor(height / 2);
  const skyRows = skyRowsFor(height);

  const agents = SLOT_SPECS.map((spec) => {
    const box = agentSlotBox(spec.side, spec.band, width, height, boxWidth, boxHeight, centerRow, footerRows, skyRows);
    const path = branchFor(spec, box, center);
    return {
      key: spec.key,
      label: agentByKey(spec.key)?.label ?? spec.key.toUpperCase(),
      side: spec.side,
      band: spec.band,
      box,
      path,
      returnPath: returnLaneFor(spec, path),
    };
  });

  const otherBox = {
    row: height - boxHeight - footerRows,
    col: center.midCol - Math.floor(boxWidth / 2),
    width: boxWidth,
    height: boxHeight,
  };
  const otherPath = orthogonalPath(
    { row: center.row + center.height, col: center.midCol },
    { row: otherBox.row - 1, col: otherBox.col + Math.floor(boxWidth / 2) },
    'vertical',
  );
  const other = {
    key: 'other',
    label: 'OTHER',
    side: 'center',
    band: 'bottom',
    box: otherBox,
    path: otherPath,
    returnPath: otherPath.map((cell) => ({ row: cell.row, col: cell.col - 1 })),
  };

  return {
    tooSmall: false,
    width,
    height,
    center,
    centerRow,
    footerRows,
    sky: { rows: skyRows },
    statusRow: height - footerRows,
    inputRow: footerRows >= 2 ? height - 1 : null,
    agents,
    other,
    agentOrder: AGENT_ORDER,
  };
}
