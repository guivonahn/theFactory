import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../src/layout.js';

function assertInside(box, width, height) {
  assert.ok(box.row >= 0, `row ${box.row} is inside the frame`);
  assert.ok(box.col >= 0, `col ${box.col} is inside the frame`);
  assert.ok(box.row + box.height <= height, `box bottom ${box.row + box.height} <= ${height}`);
  assert.ok(box.col + box.width <= width, `box right ${box.col + box.width} <= ${width}`);
}

function assertBandsDoNotOverlap(layout) {
  for (const side of ['left', 'right']) {
    const boxes = Object.fromEntries(
      layout.agents.filter((slot) => slot.side === side).map((slot) => [slot.band, slot.box]),
    );
    assert.ok(boxes.top.row + boxes.top.height <= boxes.middle.row, `${side}: top clears middle`);
    assert.ok(boxes.middle.row + boxes.middle.height <= boxes.bottom.row, `${side}: middle clears bottom`);
  }
}

test('agent boxes grow at 100x40', () => {
  const layout = buildLayout(100, 40);
  for (const slot of [...layout.agents, layout.other]) {
    assert.ok(slot.box.width > 24, `${slot.key} is wider than 24`);
    assert.ok(slot.box.height > 5, `${slot.key} is taller than 5`);
  }
});

test('all agent boxes fit inside the 60x24 frame', () => {
  for (const footerRows of [1, 2, 3]) {
    const layout = buildLayout(60, 24, { footerRows });
    assert.equal(layout.tooSmall, false);
    assert.equal(layout.agents.length, 6);
    for (const slot of [...layout.agents, layout.other]) {
      assertInside(slot.box, 60, 24);
    }
  }
});

test('top, middle, and bottom bands do not overlap vertically', () => {
  for (const [width, height] of [[60, 24], [100, 40]]) {
    assertBandsDoNotOverlap(buildLayout(width, height));
  }
});

test('layout exposes one or two input rows without changing inputRow', () => {
  const twoRows = buildLayout(100, 32, { footerRows: 2 });
  assert.deepEqual(twoRows.inputRows, [31]);
  assert.equal(twoRows.inputRow, 31);

  const threeRows = buildLayout(100, 32, { footerRows: 3 });
  assert.deepEqual(threeRows.inputRows, [30, 31]);
  assert.equal(threeRows.inputRow, 31);
  assert.equal(threeRows.statusRow, 29);
});

test('layout still rejects sizes below 60x24', () => {
  assert.equal(buildLayout(59, 24).tooSmall, true);
  assert.equal(buildLayout(60, 23).tooSmall, true);
});
