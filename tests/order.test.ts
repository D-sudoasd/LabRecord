import test from 'node:test';
import assert from 'node:assert/strict';
import { placeId, swapAdjacent } from '../src/shared/order.js';

test('placing an item uses the full queue and keeps hidden neighbors in place', () => {
  assert.deepEqual(placeId(['A', 'B', 'C', 'D'], 'D', 'A', 'before'), ['D', 'A', 'B', 'C']);
  assert.deepEqual(placeId(['A', 'B', 'C', 'D'], 'A', 'C', 'after'), ['B', 'C', 'A', 'D']);
  assert.deepEqual(placeId(['A', 'B', 'C'], 'A', 'A', 'before'), ['A', 'B', 'C']);
  assert.equal(placeId(['A', 'B'], 'A', 'Z', 'before'), null);
});

test('adjacent swap refuses the ends of the queue', () => {
  assert.deepEqual(swapAdjacent(['A', 'B', 'C'], 'B', -1), ['B', 'A', 'C']);
  assert.deepEqual(swapAdjacent(['A', 'B', 'C'], 'B', 1), ['A', 'C', 'B']);
  assert.equal(swapAdjacent(['A', 'B'], 'A', -1), null);
  assert.equal(swapAdjacent(['A'], 'A', 1), null);
});
