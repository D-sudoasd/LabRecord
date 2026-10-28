import test from 'node:test';
import assert from 'node:assert/strict';
import type { Group, Snapshot } from '../src/shared/model.js';
import { recordedStartLabel } from '../src/shared/recordedTime.js';
import { searchWorkspace } from '../src/ui/workspaceSearch.js';
import { fixture } from './helpers.js';

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

const measuredGroup: Group = {
  id: 'g1',
  experimentId: 'e1',
  state: '400C-aged',
  name: '拉伸组',
  material: 'Ti2448',
  composition: 'Ti-24Nb-4Zr-8Sn（wt.%）',
  processing: '冷轧',
  heatTreatment: '无',
  otherTreatment: '',
  preparedCount: 6,
  mode: 'In situ',
  priority: 'P0',
  thickness: '',
  thicknessUnit: '',
  preparation: '',
  notes: '隐藏词ZZZ',
  protocol: '10 °C/min 升至 375 °C',
  values: { 备注数字: '9988' },
  order: 0,
  legacyCompleted: null,
  legacyTime: '',
};

test('search finds regime labels and preparation fields, and still ignores notes and custom values', () => {
  const measured: Snapshot = {
    ...snapshot,
    groups: [measuredGroup],
    items: snapshot.items.map((item) =>
      item.id === 'i2'
        ? { ...item, measurement: { regime: 'cyclic', technique: 'SXRD', batch: 'B02' } }
        : item,
    ),
    runs: [
      {
        id: 'r1',
        experimentId: 'e1',
        itemId: 'i1',
        sampleId: 's1',
        number: 1,
        startedAt: '2026-10-13T01:00:00.000Z',
        endedAt: null,
        originalStartedAt: '2026-10-13T01:00:00.000Z',
        originalEndedAt: '2026-10-13T02:00:00.000Z',
        timezone: 'Asia/Shanghai',
        offsetMinutes: -480,
        filename: 'EXP-1_S01',
        snapshot: {
          group: measuredGroup,
          sample: snapshot.samples[0],
          operation: '测量',
          fields: [],
        },
        actual: {
          scanId: 'SCAN-88421',
          filename: 'frame_088421.cbf',
          files: 'D:\\beam\\SCAN-88421\\frame.cbf\nother.tif',
          thickness: '0.8',
          thicknessUnit: 'mm',
        },
        actualSample: { name: '', width: '', height: '', dimensionUnit: '' },
        notes: '隐藏词ZZZ',
      },
    ],
  };
  const regime = searchWorkspace(measured, '循环加载');
  assert.deepEqual(
    regime.map((hit) => hit.itemId),
    ['i2'],
  );
  assert.equal(regime[0].title, 'S01 · 循环加载');
  assert.deepEqual(
    searchWorkspace(measured, 'B02').map((hit) => hit.itemId),
    ['i2'],
  );
  const material = searchWorkspace(measured, 'Ti2448');
  assert.equal(material.length, 1);
  assert.equal(material[0].itemId, 'i1');
  assert.equal(material[0].detail, '拉伸实验 · EXP-1 · 时间不完整');
  assert.equal(searchWorkspace(measured, '循环加载')[0].detail, '拉伸实验 · EXP-1');
  assert.equal(
    searchWorkspace(measured, 'EXP-1').find((hit) => hit.kind === 'experiment')?.detail,
    'EXP-1 · 待核对 1 · 实际已改 1',
  );
  assert.equal(searchWorkspace(measured, '原位')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, '375')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 'wt.%').length, 1);
  assert.equal(searchWorkspace(measured, '隐藏词ZZZ').length, 0);
  assert.equal(searchWorkspace(measured, '9988').length, 0);
  assert.equal(searchWorkspace(measured, 'SCAN-88421')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 'SCAN-88421')[0].title, 'S01 · SCAN-88421');
  assert.equal(searchWorkspace(measured, 'other.tif')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 'frame_088421.cbf')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 's1')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 'r1')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, 'i2')[0].itemId, 'i2');
  const frozen = structuredClone(measured);
  frozen.runs[0].snapshot.sample = { ...frozen.runs[0].snapshot.sample, id: 'frozen-sample' };
  assert.equal(searchWorkspace(frozen, 'frozen-sample')[0].itemId, 'i1');
  assert.equal(searchWorkspace(frozen, 's1')[0].itemId, 'i1');
  assert.equal(searchWorkspace(frozen, 's1')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, '0.8')[0].itemId, 'i1');
  assert.equal(searchWorkspace(measured, '隐藏词ZZZ').length, 0);
});

test('workspace search keeps the start protocol after the operation ends and the plan changes', () => {
  const measured: Snapshot = {
    ...snapshot,
    groups: [measuredGroup],
    items: snapshot.items.map((item) =>
      item.id === 'i2'
        ? { ...item, measurement: { regime: 'cyclic', technique: 'SXRD', batch: 'B02' } }
        : item,
    ),
    runs: [
      {
        id: 'r1',
        experimentId: 'e1',
        itemId: 'i1',
        sampleId: 's1',
        number: 1,
        startedAt: '2026-10-13T01:00:00.000Z',
        endedAt: '2026-10-13T02:00:00.000Z',
        originalStartedAt: '2026-10-13T01:00:00.000Z',
        originalEndedAt: null,
        timezone: 'Asia/Shanghai',
        offsetMinutes: -480,
        filename: 'EXP-1_S01',
        snapshot: {
          group: measuredGroup,
          sample: snapshot.samples[0],
          operation: '测量',
          fields: [],
        },
        actual: {
          scanId: 'SCAN-88421',
          filename: 'frame_088421.cbf',
          files: 'D:\\beam\\SCAN-88421\\frame.cbf\nother.tif',
          thickness: '0.8',
          thicknessUnit: 'mm',
        },
        actualSample: { name: '', width: '', height: '', dimensionUnit: '' },
        notes: '隐藏词ZZZ',
      },
    ],
  };
  const changed = structuredClone(measured);
  changed.groups[0] = { ...changed.groups[0], protocol: '后来改成 450 °C' };
  changed.items = changed.items.map((item) =>
    item.id === 'i1' ? { ...item, status: 'completed' } : item,
  );
  const started = searchWorkspace(changed, '375');
  assert.deepEqual(
    started.map((hit) => hit.itemId),
    ['i1'],
  );
  assert.match(started[0].title, /实验制度 10 °C\/min 升至 375 °C/);
  assert.equal(started[0].title.includes('隐藏词ZZZ'), false);
  assert.equal(searchWorkspace(changed, '隐藏词ZZZ').length, 0);
  assert.equal(searchWorkspace(changed, '9988').length, 0);
  assert.equal(changed.runs[0].snapshot.group.protocol, '10 °C/min 升至 375 °C');
  assert.equal(changed.runs[0].originalStartedAt, '2026-10-13T01:00:00.000Z');
  const current = searchWorkspace(changed, '450');
  assert.equal(
    current.some((hit) => hit.itemId === 'i1'),
    true,
  );
});

test('workspace search keeps a changed actual thickness on that operation', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'SIZE-1',
    name: '尺寸查找',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      preparedCount: 2,
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      dimensionUnit: 'mm',
      notes: '样品组备注ZZZ',
      values: { composition: '演示材料' },
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: { thickness: '1.1' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { thickness: '9.9' },
  });
  const snapshot = store.snapshot();
  assert.deepEqual(
    searchWorkspace(snapshot, '1.1').map((hit) => hit.itemId),
    [first.id],
  );
  assert.match(
    searchWorkspace(snapshot, '9.9').find((hit) => hit.itemId === first.id)?.title || '',
    /当前计划已不同/,
  );
  assert.equal(
    searchWorkspace(snapshot, '9.9').some((hit) => hit.itemId === second.id),
    true,
  );
  assert.equal(searchWorkspace(snapshot, '现场备注ZZZ').length, 0);
  assert.equal(searchWorkspace(snapshot, '样品组备注ZZZ').length, 0);
  assert.equal(searchWorkspace(snapshot, '演示材料').length, 0);
  assert.equal(snapshot.runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(snapshot.runs[0].snapshot.group.thickness, '0.8');
});

test('workspace search keeps the start preparation and finds a later change only as drift', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'PREP-1',
    name: '制备查找',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '原状态',
      material: 'Ti2448',
      mode: 'In situ',
      heatTreatment: '400 °C × 2 h',
      preparation: '制备批次 A',
      preparedCount: 2,
    },
    count: 2,
  });
  const [first, second] = store.snapshot().items;
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: {
      material: 'NewAlloy',
      mode: 'Ex situ',
      heatTreatment: '后来改成 800 °C',
      preparation: '制备批次 B',
    },
  });
  const data = store.snapshot();
  assert.deepEqual(
    searchWorkspace(data, '400 °C').map((hit) => hit.itemId),
    [first.id],
  );
  assert.equal(searchWorkspace(data, '400 °C')[0].title.includes('后来改成'), false);
  const nextHeat = searchWorkspace(data, '800 °C');
  assert.match(nextHeat.find((hit) => hit.itemId === first.id)?.title || '', /当前计划已不同/);
  assert.equal(
    (nextHeat.find((hit) => hit.itemId === second.id)?.title || '').includes('当前计划已不同'),
    false,
  );
  assert.deepEqual(
    searchWorkspace(data, 'In situ').map((hit) => hit.itemId),
    [first.id],
  );
  assert.deepEqual(
    searchWorkspace(data, 'Ex situ').map((hit) => hit.itemId),
    [second.id],
  );
  assert.deepEqual(
    searchWorkspace(data, '制备批次 A').map((hit) => hit.itemId),
    [first.id],
  );
  assert.deepEqual(
    searchWorkspace(data, '制备批次 B').map((hit) => hit.itemId),
    [second.id],
  );
  assert.deepEqual(
    searchWorkspace(data, 'Ti2448').map((hit) => hit.itemId),
    [first.id],
  );
  assert.deepEqual(
    searchWorkspace(data, 'NewAlloy').map((hit) => hit.itemId),
    [second.id],
  );
  assert.equal(data.runs[0].snapshot.group.heatTreatment, '400 °C × 2 h');
  assert.equal(data.runs[0].snapshot.group.material, 'Ti2448');
  assert.equal(data.runs[0].snapshot.group.mode, 'In situ');
  assert.equal(data.runs[0].snapshot.group.preparation, '制备批次 A');
  assert.equal(data.runs[0].originalStartedAt, run.originalStartedAt);
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

test('workspace search finds the open operation by the uncounted duration and ignores notes', (t) => {
  const { store } = fixture(t, () => new Date('2026-10-13T01:00:00.000Z'));
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'SRCH',
    name: '搜索进行中',
  }).experimentId!;
  store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '原状态', preparedCount: 2, notes: '隐藏词ZZZ' },
    count: 2,
  });
  const first = store.snapshot().items[0];
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({
    type: 'saveRun',
    runId: run.id,
    notes: '现场备注ZZZ',
    actual: { scanId: 'SCAN-RUN-1', filename: 'frame-001.cbf', files: 'E:\\raw\\hidden.cbf' },
  });
  const hits = searchWorkspace(store.snapshot(), '用时未计入');
  assert.equal(hits.length, 1);
  const openRun = store.snapshot().runs[0];
  const sampleId = store.snapshot().samples[0].id;
  assert.equal(searchWorkspace(store.snapshot(), recordedStartLabel(openRun)).length, 0);
  assert.equal(searchWorkspace(store.snapshot(), '4').length, 0);
  assert.equal(searchWorkspace(store.snapshot(), sampleId)[0].itemId, first.id);
  assert.equal(
    searchWorkspace(store.snapshot(), sampleId.slice(0, 8)).some((hit) => hit.itemId === first.id),
    true,
  );
  assert.equal(hits[0].itemId, first.id);
  assert.match(hits[0].title, /用时未计入/);
  assert.equal(hits[0].title.includes('现场备注ZZZ'), false);
  assert.equal(hits[0].title.includes('hidden.cbf'), false);
  assert.match(searchWorkspace(store.snapshot(), 'G-1')[0].detail, /用时未计入/);
  assert.equal(searchWorkspace(store.snapshot(), '现场备注ZZZ').length, 0);
  assert.equal(searchWorkspace(store.snapshot(), '隐藏词ZZZ').length, 0);
  store.command({ type: 'finish', itemId: first.id });
  assert.equal(searchWorkspace(store.snapshot(), '用时未计入').length, 0);
  assert.equal(store.snapshot().runs[0].originalStartedAt, run.originalStartedAt);
  assert.equal(store.snapshot().runs[0].endedAt !== null, true);
  assert.equal(store.snapshot().groups[0].preparedCount, 2);
});
