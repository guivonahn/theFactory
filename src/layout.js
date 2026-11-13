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

function agentSlotBox(side, band, width, boxWidth, boxHeight, bandRows) {
  const row = bandRows[band];
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
  if (options.workers) return workerLayout(width, height, footerRows);
  const skyRows = skyRowsFor(height);
  const centerRow = Math.floor(height / 2);
  const topRow = 1 + skyRows;

  // Boxes get noticeably bigger on roomy terminals while still leaving the
  // top band clear of the centre box and the branch gaps intact.
  const desiredWidth = Math.round(width * 0.39);
  const centerWidth = Math.min(44, Math.max(20, width - 2 * (desiredWidth + 5)));
  const maxBoxWidth = Math.floor((width - centerWidth) / 2) - 3;
  const boxWidth = Math.max(16, Math.min(40, desiredWidth, maxBoxWidth));
  const boxHeight = Math.max(
    5,
    Math.min(
      10,
      centerRow - topRow - 3,
      Math.floor((height - topRow - footerRows) / 3),
    ),
  );

  // Distribute the three bands with equal gaps between them.
  const available = height - footerRows - topRow;
  const gap = Math.max(0, Math.floor((available - 3 * boxHeight) / 2));
  const bandRows = {
    top: topRow,
    middle: topRow + boxHeight + gap,
    bottom: topRow + 2 * boxHeight + 2 * gap,
  };

  const center = {
    row: centerRow - 3,
    col: Math.floor((width - centerWidth) / 2),
    width: centerWidth,
    height: 7,
  };
  center.midRow = center.row + Math.floor(center.height / 2);
  center.midCol = center.col + Math.floor(center.width / 2);

  const agents = SLOT_SPECS.map((spec) => {
    const box = agentSlotBox(spec.side, spec.band, width, boxWidth, boxHeight, bandRows);
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
    row: bandRows.bottom,
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
    inputRows: footerRows >= 3 ? [height - 2, height - 1] : (footerRows >= 2 ? [height - 1] : []),
    agents,
    other,
    agentOrder: AGENT_ORDER,
  };
}

/** Reserve a real creature footprint above every label, even at 60x24. */
function workerLayout(width, height, footerRows) {
  const available = height - footerRows;
  const workerHeight = available >= 27 ? 6 : 5;
  const reservedSky = available >= 39 ? 6 : 4;
  const boxHeight = Math.max(2, Math.min(10, Math.floor((available - 3 * workerHeight - reservedSky) / 3)));
  const groupHeight = workerHeight + boxHeight;
  const skyRows = Math.min(7, available - 3 * groupHeight);
  const top = skyRows;
  const gap = Math.floor((available - top - 3 * groupHeight) / 2);
  const centerWidth = Math.min(44, Math.max(20, width - 2 * (Math.round(width * 0.39) + 5)));
  const boxWidth = Math.max(16, Math.min(40, Math.round(width * 0.39), Math.floor((width - centerWidth) / 2) - 4));
  const bandRows = Object.fromEntries(['top', 'middle', 'bottom'].map((band, index) => [band, top + index * (groupHeight + gap) + workerHeight]));
  const centerHeight = Math.min(7, boxHeight + 2);
  const center = {
    row: top + Math.floor((2 * groupHeight - workerHeight - centerHeight) / 2) + workerHeight,
    col: Math.floor((width - centerWidth) / 2), width: centerWidth, height: centerHeight,
  };
  center.midRow = center.row + Math.floor(center.height / 2);
  center.midCol = center.col + Math.floor(center.width / 2);
  const workerArea = (box) => ({ row: box.row - workerHeight, col: box.col, width: box.width, height: workerHeight });
  const agents = SLOT_SPECS.map((spec) => {
    const box = agentSlotBox(spec.side, spec.band, width, boxWidth, boxHeight, bandRows);
    const left = spec.side === 'left';
    const sourceCol = left ? center.col : center.col + center.width - 1;
    const targetCol = left ? box.col + box.width - 1 : box.col;
    const gutter = left ? center.col - 2 : center.col + center.width;
    const returnGutter = left ? center.col - 1 : center.col + center.width + 1;
    const targetRow = box.row + Math.floor((box.height - 1) / 2);
    const route = (start, end, via) => joinPath(
      orthogonalPath(start, { row: start.row, col: via }),
      orthogonalPath({ row: start.row, col: via }, { row: end.row, col: via }, 'vertical'),
      orthogonalPath({ row: end.row, col: via }, end),
    );
    const path = route({ row: center.row + 1, col: sourceCol }, { row: targetRow, col: targetCol }, gutter);
    const returnPath = route({ row: center.row + center.height - 2, col: sourceCol }, { row: targetRow + 1, col: targetCol }, returnGutter);
    return { ...spec, label: agentByKey(spec.key).label, box, worker: workerArea(box), path, returnPath };
  });
  // Auxiliary agents stay in the center lane below the orchestrator.
  const otherBox = { row: bandRows.bottom, col: center.col, width: center.width, height: boxHeight };
  const otherRoute = (offset, gutter) => joinPath(
    orthogonalPath({ row: center.row + center.height - 1, col: center.midCol + offset }, { row: center.row + center.height + offset, col: center.midCol + offset }, 'vertical'),
    orthogonalPath({ row: center.row + center.height + offset, col: center.midCol + offset }, { row: center.row + center.height + offset, col: gutter }),
    orthogonalPath({ row: center.row + center.height + offset, col: gutter }, { row: otherBox.row + offset, col: gutter }, 'vertical'),
    orthogonalPath({ row: otherBox.row + offset, col: gutter }, { row: otherBox.row + offset, col: otherBox.col }),
  );
  const otherPath = otherRoute(0, center.col - 2);
  return {
    tooSmall: false, width, height, footerRows, center, centerRow: center.midRow,
    centerWorker: workerArea(center), compact: boxHeight < 5,
    sky: { rows: skyRows }, statusRow: height - footerRows,
    inputRow: footerRows >= 2 ? height - 1 : null,
    inputRows: footerRows >= 3 ? [height - 2, height - 1] : footerRows >= 2 ? [height - 1] : [],
    agents, agentOrder: AGENT_ORDER,
    other: { key: 'other', label: 'OTHER', side: 'center', band: 'bottom', box: otherBox, worker: workerArea(otherBox), path: otherPath, returnPath: otherRoute(1, center.col - 1) },
  };
}

function joinPath(...parts) {
  return parts.flatMap((part, index) => index ? part.slice(1) : part);
}

/** Merge the physical lane topology, preserving corners and shared junctions. */
export function trackCellsFor(slots) {
  const cells = new Map();
  const add = (cell, direction) => {
    const key = `${cell.row}:${cell.col}`;
    const current = cells.get(key) ?? { ...cell, mask: 0 };
    current.mask |= direction;
    cells.set(key, current);
  };
  for (const slot of slots) for (const path of [slot.path, slot.returnPath]) {
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1], b = path[index];
      if (b.row < a.row) { add(a, 1); add(b, 4); }
      else if (b.row > a.row) { add(a, 4); add(b, 1); }
      else if (b.col > a.col) { add(a, 2); add(b, 8); }
      else if (b.col < a.col) { add(a, 8); add(b, 2); }
    }
  }
  const glyphs = { 1: '│', 2: '─', 3: '╰', 4: '│', 5: '│', 6: '╭', 7: '├', 8: '─', 9: '╯', 10: '─', 11: '┴', 12: '╮', 13: '┤', 14: '┬', 15: '┼' };
  return [...cells.values()].map((cell) => ({ ...cell, glyph: glyphs[cell.mask] }));
}
