import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/shared/model.js';
import { searchWorkspace } from '../src/ui/workspaceSearch.js';

const snapshot: Snapshot = {
  schemaVersion: 1,
  experiments: [
    {
      id: 'e1',
      code: 'EXP-1',
      name: '拉伸实验',
      description: '隐藏词ZZZ',
      fields: [],
      namingPattern: '{experiment}_{sample}',
      createdAt: '2026-10-13T00:00:00.000Z',
    },
    {
      id: 'e2',
      code: 'EXP-2',
      name: '压缩实验',
      description: '',
      fields: [],
      namingPattern: '{experiment}_{sample}',
      createdAt: '2026-10-13T00:00:00.000Z',
    },
  ],
  groups: [],
  samples: [
    {
      id: 's1',
      experimentId: 'e1',
      groupId: 'g1',
      code: 'S01',
      values: { 备注数字: '9988' },
      parameters: { name: '合金A', notes: '隐藏词ZZZ' },
    },
    {
      id: 's2',
      experimentId: 'e2',
      groupId: 'g2',
      code: 'S02',
      values: {},
      parameters: { name: '合金B' },
    },
  ],
  items: [
    {
      id: 'i1',
      experimentId: 'e1',
      sampleId: 's1',
      operation: '测量',
      order: 0,
      status: 'pending',
      plannedName: 'EXP-1_S01',
    },
    {
      id: 'i2',
      experimentId: 'e1',
      sampleId: 's1',
      operation: '测量',
      order: 1,
      status: 'pending',
      plannedName: 'EXP-1_S01_02',
    },
    {
      id: 'i3',
      experimentId: 'e2',
      sampleId: 's2',
      operation: '测量',
      order: 0,
      status: 'running',
      plannedName: 'EXP-2_S02',
    },
  ],
  runs: [],
  events: [
    {
      id: 'ev',
      experimentId: 'e1',
      itemId: 'i1',
      runId: null,
      type: 'note',
      text: '隐藏词ZZZ',
      createdAt: '2026-10-13T00:00:00.000Z',
      data: {},
    },
  ],
  attachments: [],
};

test('workspace search matches sample identity and folder names, not notes or custom values', () => {
  assert.equal(searchWorkspace(snapshot, '隐藏词ZZZ').length, 0);
  assert.equal(searchWorkspace(snapshot, '9988').length, 0);
  const sample = searchWorkspace(snapshot, 'S01');
  assert.equal(sample.length, 1);
  assert.equal(sample[0].itemId, 'i1');
  assert.equal(sample[0].title, 'S01 · 合金A');
  const folder = searchWorkspace(snapshot, 'EXP-1_S01_02');
  assert.deepEqual(
    folder.map((hit) => hit.itemId),
    ['i2'],
  );
});

test('exact experiment code ranks ahead of a partial folder match and results stop at eight', () => {
  const ranked = searchWorkspace(snapshot, 'EXP-2');
  assert.equal(ranked[0].kind, 'experiment');
  assert.equal(ranked[0].experimentId, 'e2');
  const many: Snapshot = {
    ...snapshot,
    experiments: [
      snapshot.experiments[0],
      ...Array.from({ length: 9 }, (_, index) => ({
        ...snapshot.experiments[0],
        id: `extra-${index}`,
        code: `FIND-${index}`,
        name: `查找${index}`,
      })),
    ],
  };
  assert.equal(searchWorkspace(many, '查找').length, 8);
  assert.equal(searchWorkspace(snapshot, '   ').length, 0);
});
