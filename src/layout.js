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

function agentSlotBox(side, band, width, height, boxWidth, boxHeight, centerRow, footerRows) {
  const rowByBand = {
    top: 1,
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
 * Compute the full frame geometry for a terminal size.
 * Returns `{ tooSmall: true }` below the 60x24 minimum.
 */
export function buildLayout(width, height, options = {}) {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { tooSmall: true, width, height, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT };
  }

  const footerRows = Math.max(1, Math.min(3, options.footerRows ?? 1));

  const boxWidth = Math.max(16, Math.min(24, Math.round(width * 0.25)));
  const boxHeight = 5;
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

  const agents = SLOT_SPECS.map((spec) => {
    const box = agentSlotBox(spec.side, spec.band, width, height, boxWidth, boxHeight, centerRow, footerRows);
    return {
      key: spec.key,
      label: agentByKey(spec.key)?.label ?? spec.key.toUpperCase(),
      side: spec.side,
      band: spec.band,
      box,
      path: branchFor(spec, box, center),
    };
  });

  const otherBox = {
    row: height - boxHeight - footerRows,
    col: center.midCol - Math.floor(boxWidth / 2),
    width: boxWidth,
    height: boxHeight,
  };
  const other = {
    key: 'other',
    label: 'OTHER',
    side: 'center',
    band: 'bottom',
    box: otherBox,
    path: orthogonalPath(
      { row: center.row + center.height, col: center.midCol },
      { row: otherBox.row - 1, col: otherBox.col + Math.floor(boxWidth / 2) },
      'vertical',
    ),
  };

  return {
    tooSmall: false,
    width,
    height,
    center,
    centerRow,
    footerRows,
    statusRow: height - footerRows,
    inputRow: footerRows >= 2 ? height - 1 : null,
    agents,
    other,
    agentOrder: AGENT_ORDER,
  };
}
