import test from 'node:test';
import assert from 'node:assert/strict';
import { menuContainsPoint, menuPosition } from '../src/ui/menuPosition.js';
import { directoryContains } from '../src/desktop/reports.js';
import { join } from 'node:path';

test('a flipped menu stays off the pointer that opened it', () => {
  const position = menuPosition(790, 590, 180, 160, 800, 600);
  assert.equal(menuContainsPoint(position, 180, 160, 790, 590), false);
  assert.ok(position.left >= 8);
  assert.ok(position.top >= 8);
});

test('a drive root and a UNC share still contain their staging directory', () => {
  assert.equal(directoryContains('D:\\', join('D:\\', 'LabRecord-report-abc')), true);
  assert.equal(
    directoryContains('\\\\server\\share', join('\\\\server\\share', 'LabRecord-download-abc')),
    true,
  );
  assert.equal(directoryContains('D:\\lab', join('D:\\', 'lab-other', 'file')), false);
});
