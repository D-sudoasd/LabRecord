import test from 'node:test';
import assert from 'node:assert/strict';
import { isExperimentCodeTaken, suggestExperimentCode } from '../src/ui/experimentCode.js';

const day = new Date('2026-10-25T12:00:00');

test('suggests the date-based experiment code or the next unused suffix', () => {
  assert.equal(suggestExperimentCode([], day), 'EXP-20261025');
  assert.equal(suggestExperimentCode(['EXP-20261025'], day), 'EXP-20261025-02');
  assert.equal(
    suggestExperimentCode(['EXP-20261025', 'EXP-20261025-02', 'EXP-20261025-03'], day),
    'EXP-20261025-04',
  );
});

test('code uniqueness matches the store case-insensitive comparison', () => {
  assert.equal(isExperimentCodeTaken(['EXP-20261025'], 'exp-20261025'), true);
  assert.equal(isExperimentCodeTaken(['EXP-20261025'], ' EXP-20261025 '), true);
  assert.equal(suggestExperimentCode(['exp-20261025'], day), 'EXP-20261025-02');
  assert.equal(isExperimentCodeTaken(['EXP-20261025'], 'EXP-20261025-02'), false);
  assert.equal(isExperimentCodeTaken(['EXP-20261025'], '   '), false);
});
