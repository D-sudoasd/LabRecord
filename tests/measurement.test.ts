import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { CommandRejectedError } from '../src/desktop/store.js';
import { filenameFor, groupCounts, type MeasurementPlan } from '../src/shared/model.js';
import { measurementFor, reserveMeasurementNames } from '../src/shared/measurement.js';
import { createBackup, unpackBackup, inspectDatabase } from '../src/desktop/backups.js';
import {
  operationRows,
  exportFile,
  previewFile,
  importTable,
  parseDelimited,
} from '../src/desktop/tables.js';
import { renderReport } from '../src/desktop/reports.js';

// Explicit advanced rules remain supported; new experiments use a simpler default.
const SCIENTIFIC_PATTERN =
  '{experiment}_{material}_{state}_{sample}_{mode}_{regime}_{batch}_{run:03}';

function setup(t: Parameters<typeof fixture>[0]) {
  const result = fixture(t);
  const experimentId = result.store.command({
    type: 'createExperiment',
    code: 'P212-202610',
    name: '多制度离线实验',
    namingPattern: SCIENTIFIC_PATTERN,
  }).experimentId!;
  const measurement: MeasurementPlan = {
    mode: 'In situ',
    technique: 'SXRD',
    regime: 'cyclic',
    batch: 'B01',
    protocol: '0–2% 循环 10 次；1e-3 s⁻¹，RT',
  };
  const added = result.store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    prefix: 'S',
    measurement,
    patch: {
      material: 'Ti2448',
      state: '400C-aged',
      name: '拉伸试样',
      preparedCount: 3,
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      dimensionUnit: 'mm',
    },
  });
  return { ...result, experimentId, itemId: added.itemId!, measurement };
}

test('scientific names include material/state/mode/regime/batch, sanitize only the generated name and omit empty fields', (t) => {
  const { store, itemId } = setup(t);
  assert.equal(
    store.get('items', itemId).plannedName,
    'P212-202610_Ti2448_400C-aged_S01_IS_cyclic_B01_001',
  );
  assert.equal(
    filenameFor(SCIENTIFIC_PATTERN, 'E', 'S01', 2, {
      material: 'Ti / Nb',
      state: '400 °C',
      mode: 'ES',
    }),
    'E_Ti_Nb_400_°C_S01_ES_002',
  );
  assert.equal(
    filenameFor('{experiment}_{sample}_{run:03}', 'E', 'A / B', 2),
    'E_A___B_002',
    'legacy rules retain exact sanitation',
  );
  for (const name of ['NUL', 'CON.txt', 'COM1', 'LPT9.dat', '../outside', '{unknown}', 'ends.'])
    assert.throws(() => filenameFor(name, 'E', 'S', 1));
  assert.equal(store.snapshot().groups[0].state, '400C-aged');
});

test('optional naming fields preserve internal material and batch separators and literal rule separators', () => {
  assert.equal(filenameFor('{experiment}_{sample}_{run:03}', 'E$&', 'S$&', 1), 'E$&_S$&_001');
  assert.equal(
    filenameFor('{material}__{batch}__{run:03}', 'E', 'S', 1, {
      material: 'Ti--15Nb',
      batch: '350C--Ar',
    }),
    'Ti--15Nb__350C--Ar__001',
  );
  assert.equal(
    filenameFor('{material}__{batch}__{run:03}', 'E', 'S', 1, { material: 'Ti__15Nb', batch: '' }),
    'Ti__15Nb__001',
  );
  assert.equal(
    filenameFor('{material}_{mode}_{batch}_{regime}_{run:03}', 'E', 'S', 1, {
      material: 'Ti--15Nb',
    }),
    'Ti--15Nb_001',
  );
  assert.throws(() => filenameFor('{material}\u0001_{run}', 'E', 'S', 1, { material: 'Ti' }));
});

test('one physical sample supports many independent regimes without consuming spares; request retries are idempotent', (t) => {
  const { store, itemId, experimentId } = setup(t);
  const input = {
    type: 'scheduleMeasurements',
    itemIds: [itemId],
    repetitions: 2,
    measurement: {
      mode: 'Ex situ',
      regime: 'rotation',
      batch: 'B02',
      protocol: '-90° 至 90°，每 5° 一步',
    },
  } as const;
  const result = store.command(input, 'append-regime');
  store.command(input, 'append-regime');
  const snapshot = store.snapshot();
  assert.equal(snapshot.samples.length, 1);
  assert.equal(snapshot.items.length, 3);
  assert.equal(new Set(snapshot.items.map((item) => item.sampleId)).size, 1);
  assert.equal(snapshot.items.filter((item) => item.repeatOf).length, 0);
  assert.deepEqual(groupCounts(snapshot, snapshot.groups[0]), {
    planned: 1,
    spare: 2,
    shortage: 0,
    completed: 0,
    total: 3,
  });
  assert.equal(store.get('items', result.itemId!).measurement!.technique, 'SXRD');
  assert.equal(
    store.get('items', result.itemId!).plannedName,
    'P212-202610_Ti2448_400C-aged_S01_ES_rotation_B02_002',
  );
  const names = snapshot.items.map((item) => item.plannedName);
  store.command({
    type: 'reorder',
    experimentId,
    ids: snapshot.items.map((item) => item.id).reverse(),
  });
  assert.deepEqual(
    store.snapshot().items.map((item) => item.plannedName),
    names,
  );
  store.command({ type: 'start', itemId: snapshot.items[2].id });
  assert.equal(
    store.snapshot().runs[0].filename,
    names[2],
    'start order does not change the preallocated name',
  );
});

test('an appended regime keeps inheriting a group protocol that was still blank', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'METAL',
    name: '继承制度',
  }).experimentId!;
  const itemId = store.command({
    type: 'addSamples',
    experimentId,
    count: 1,
    patch: { state: '原态', name: '试样', preparedCount: 1 },
    measurement: { technique: '', regime: '', batch: '', mode: 'Ex situ' },
  }).itemId!;
  const appended = store.command({
    type: 'scheduleMeasurements',
    itemIds: [itemId],
    measurement: { regime: 'static' },
  }).itemId!;
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { protocol: '室温静置 10 min' },
  });
  const snapshot = store.snapshot();
  const source = snapshot.items.find((item) => item.id === itemId)!;
  const extra = snapshot.items.find((item) => item.id === appended)!;
  assert.equal(extra.measurement?.protocol, undefined);
  assert.equal(measurementFor(snapshot, source).protocol, '室温静置 10 min');
  assert.equal(measurementFor(snapshot, extra).protocol, '室温静置 10 min');
  assert.equal(source.plannedName, extra.plannedName?.replace(/_M\d+$/, ''));
});

test('per-operation parameters and historical names stay frozen; true repeat reuses the source snapshot', (t) => {
  const { store, itemId, measurement } = setup(t);
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  const original = structuredClone(store.snapshot().runs[0]);
  store.command({
    type: 'updateSamples',
    ids: [original.sampleId],
    code: 'NEW01',
    parameters: { name: '后改名字', protocol: '后改制度', mode: 'Ex situ' },
  });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { material: '其他材料', state: 'later' },
  });
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [itemId],
        measurement: { regime: 'step' },
      }),
    /已有实际记录/,
  );
  const repeated = store.command({ type: 'repeat', itemId }).itemId!;
  assert.deepEqual(measurementFor(store.snapshot(), store.get('items', repeated)), {
    ...measurement,
    customName: '',
  });
  store.command({ type: 'start', itemId: repeated });
  assert.equal(store.snapshot().runs[1].snapshot.group.protocol, original.snapshot.group.protocol);
  assert.deepEqual(store.snapshot().runs[0], original);
});

test('UI preview and transaction reserve identical names; rule changes preserve manual names and historical runs', (t) => {
  const { store, itemId, experimentId } = setup(t);
  const item = store.get('items', itemId);
  const measurement = {
    regime: 'step',
    batch: '350C-Ar',
    protocol: '逐级到 400 MPa，每级保载 30 s',
  };
  const preview = reserveMeasurementNames(store.snapshot(), experimentId, [
    { ...item, measurement: { ...item.measurement, ...measurement } },
  ])[0].plannedName;
  store.command({ type: 'configureMeasurements', ids: [itemId], measurement });
  assert.equal(store.get('items', itemId).plannedName, preview);
  store.command({
    type: 'configureMeasurements',
    ids: [itemId],
    measurement: { customName: 'Ti2448_现场临时-01' },
  });
  const appended = store.command({ type: 'scheduleMeasurements', itemIds: [itemId] }).itemId!;
  assert.notEqual(store.get('items', appended).plannedName, 'Ti2448_现场临时-01');
  store.command({ type: 'updateExperiment', id: experimentId, namingPattern: '{regime}' });
  assert.equal(store.get('items', itemId).plannedName, 'Ti2448_现场临时-01');
  assert.equal(store.get('items', appended).plannedName, 'step');
  store.command({ type: 'start', itemId });
  const original = structuredClone(store.snapshot().runs[0]);
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    namingPattern: '{material}_{run:03}',
  });
  assert.deepEqual(store.snapshot().runs[0], original);
});

test('manual conflicts, invalid metadata, mixed experiments and excess batch sizes roll back atomically', (t) => {
  const { store, itemId, experimentId } = setup(t);
  const second = store.command({ type: 'scheduleMeasurements', itemIds: [itemId] }).itemId!;
  store.command({
    type: 'configureMeasurements',
    ids: [itemId],
    measurement: { customName: 'ChosenName' },
  });
  const baseline = store.snapshot();
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [second],
        measurement: { customName: 'chosenname' },
      }),
    /已被/,
  );
  assert.deepEqual(store.snapshot(), baseline);
  assert.throws(
    () =>
      store.command({ type: 'configureMeasurements', ids: [second], measurement: { batch: 5 } }),
    /输入格式/,
  );
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [second],
        measurement: { unknown: 'x' },
      }),
    /输入格式/,
  );
  assert.throws(
    () =>
      store.command({
        type: 'scheduleMeasurements',
        itemIds: Array(11).fill(itemId),
        repetitions: 100,
      }),
    /重复/,
  );
  store.command({ type: 'scheduleMeasurements', itemIds: [itemId], repetitions: 10 });
  const uniqueIds = store
    .snapshot()
    .items.filter((item) => item.experimentId === experimentId)
    .slice(0, 11)
    .map((item) => item.id);
  const beforeExcess = store.snapshot();
  assert.throws(
    () => store.command({ type: 'scheduleMeasurements', itemIds: uniqueIds, repetitions: 100 }),
    /最多追加 1000/,
  );
  assert.deepEqual(store.snapshot(), beforeExcess);
  const otherExperiment = store.command({
    type: 'createExperiment',
    name: '其他',
    code: 'OTHER',
  }).experimentId!;
  const other = store.command({
    type: 'addSamples',
    experimentId: otherExperiment,
    patch: { state: 'x' },
    count: 1,
  }).itemId!;
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [second, other],
        measurement: { regime: 'rotation' },
      }),
    /同一实验/,
  );
  store.command({ type: 'start', itemId });
  const prior = store.snapshot();
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [second, itemId],
        measurement: { batch: 'new' },
      }),
    /已有实际记录/,
  );
  assert.deepEqual(store.snapshot(), prior);
  assert.equal(
    store.snapshot().experiments.find((entry) => entry.id === experimentId)!.namingPattern,
    SCIENTIFIC_PATTERN,
  );
});

test('new measurement metadata, planned names and frozen snapshots survive v1 backup without format migration', async (t) => {
  const { store, itemId, directory } = setup(t);
  store.command({
    type: 'scheduleMeasurements',
    itemIds: [itemId],
    measurement: { mode: 'Ex situ', regime: 'static', batch: 'RT' },
  });
  store.command({ type: 'start', itemId });
  const before = store.snapshot();
  const file = join(directory, 'measurement.labrecord');
  await createBackup(store, file);
  const restored = await unpackBackup(file, join(directory, 'restored'));
  assert.deepEqual(restored, before);
  assert.equal(restored.schemaVersion, 1);
  const item = store.get('items', itemId);
  store.put('items', {
    ...item,
    measurement: { ...item.measurement, batch: 42 } as unknown as MeasurementPlan,
  });
  assert.throws(() => inspectDatabase(join(store.root, 'records.sqlite')), /字段类型/);
});

test('legacy v1 data remains untouched when read and receives optional naming only when edited', (t) => {
  const { store, itemId, reopen } = setup(t);
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  const item = store.get('items', itemId);
  delete item.measurement;
  delete item.nameNumber;
  delete item.plannedName;
  store.put('items', item);
  const run = store.snapshot().runs[0];
  delete run.snapshot.measurement;
  delete run.snapshot.group.material;
  store.put('runs', run);
  const raw = JSON.stringify(run.snapshot);
  const data = reopen().snapshot();
  assert.equal(data.items[0].measurement, undefined);
  assert.equal(JSON.stringify(data.runs[0].snapshot), raw);
  assert.equal(data.runs[0].originalStartedAt, run.originalStartedAt);
});

test('reserving a legacy plan name preserves its operation label and creates no actual run or time', (t) => {
  const { store, itemId } = setup(t);
  const item = store.get('items', itemId);
  delete item.measurement;
  delete item.nameNumber;
  delete item.plannedName;
  item.operation = '原表测量安排';
  store.put('items', item);
  store.command({ type: 'configureMeasurements', ids: [itemId], measurement: {} });
  assert.equal(store.get('items', itemId).operation, '原表测量安排');
  const reserved = store.get('items', itemId).plannedName;
  assert.ok(reserved);
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(store.snapshot().events.at(-1)!.text, '预留测量名称');
  const beforeRetry = store.snapshot();
  store.command({ type: 'configureMeasurements', ids: [itemId], measurement: {} });
  assert.deepEqual(
    store.snapshot(),
    beforeRetry,
    'retrying a reservation with another request ID must not create duplicate audit events',
  );
  store.command({ type: 'start', itemId });
  assert.equal(store.snapshot().runs[0].filename, reserved);
});

test('CSV/XLSX/HTML/JSON include each operation regime and folder name; material reimports without inventing operations', async (t) => {
  const { store, itemId, experimentId, directory } = setup(t);
  const appended = store.command({
    type: 'scheduleMeasurements',
    itemIds: [itemId],
    measurement: { mode: 'Ex situ', regime: 'rotation', batch: 'RT', protocol: '-90° 至 90°' },
  }).itemId!;
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  store.command({
    type: 'updateGroups',
    ids: [store.snapshot().groups[0].id],
    patch: { material: '新计划材料' },
  });
  const rows = operationRows(store.snapshot(), experimentId);
  const header = rows[0];
  const column = (key: string) => header.indexOf(key);
  assert.equal(rows[1][column('材料短名')], 'Ti2448');
  assert.equal(rows[2][column('材料短名')], '新计划材料');
  assert.equal(rows[2][column('测量批次 / 条件短码')], 'RT');
  assert.equal(rows[2][column('计划方式')], 'Ex situ');
  assert.equal(rows[2][column('计划实验制度')], '-90° 至 90°');
  assert.equal(rows[2][column('预期文件名')], store.get('items', appended).plannedName);
  const report = await renderReport(store.snapshot(), experimentId, store.root);
  assert.match(report.html, /Ti2448/);
  assert.match(report.html, /rotation|旋转扫描/);
  assert.ok(report.html.includes(store.get('items', appended).plannedName!));
  assert.match(report.markdown, /测量配置/);
  const csvPath = join(directory, 'operations.csv');
  const jsonPath = join(directory, 'records.json');
  await exportFile(store.snapshot(), experimentId, 'csv', csvPath);
  await exportFile(store.snapshot(), experimentId, 'json', jsonPath);
  const csv = parseDelimited(await readFile(csvPath, 'utf8'));
  const pendingCsv = csv.find(
    (row) => row[0] === '操作' && row[csv[0].indexOf('plan_item_id')] === appended,
  )!;
  assert.equal(pendingCsv[csv[0].indexOf('测量批次 / 条件短码')], 'RT');
  assert.equal(pendingCsv[csv[0].indexOf('计划实验制度')], '-90° 至 90°');
  assert.equal(pendingCsv[csv[0].indexOf('预期文件名')], store.get('items', appended).plannedName);
  const json = JSON.parse(await readFile(jsonPath, 'utf8'));
  const pendingJson = json.items.find((item: { id: string }) => item.id === appended);
  assert.deepEqual(pendingJson.measurement, store.get('items', appended).measurement);
  assert.equal(pendingJson.plannedName, store.get('items', appended).plannedName);
  assert.equal(json.runs[0].snapshot.measurement.regime, 'cyclic');
  assert.equal(json.runs[0].snapshot.group.material, 'Ti2448');
  const path = join(directory, 'planning.xlsx');
  await exportFile(store.snapshot(), experimentId, 'xlsx', path);
  const table = await previewFile(path);
  const target = store.command({
    type: 'createExperiment',
    name: '重新导入',
    code: 'IMPORT',
  }).experimentId!;
  importTable(store, {
    experimentId: target,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  assert.equal(
    store.snapshot().groups.find((entry) => entry.experimentId === target)!.material,
    '新计划材料',
  );
  assert.equal(store.snapshot().items.filter((entry) => entry.experimentId === target).length, 0);
});

test('experiment template reuse preserves rules, typed fields and units while new sample identities remain independent', (t) => {
  const { store, experimentId } = setup(t);
  const fields = [
    { id: 'load', label: '目标载荷', type: 'number', unit: 'MPa', options: [] },
  ] as const;
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    fields,
    namingPattern: '{material}_{regime}_{batch}_{run:03}',
  });
  const source = store.get('experiments', experimentId);
  const copy = store.command({
    type: 'createExperiment',
    code: 'NEXT',
    name: '下一次机时',
    fields: source.fields,
    namingPattern: source.namingPattern,
  }).experimentId!;
  assert.deepEqual(store.get('experiments', copy).fields, source.fields);
  assert.equal(store.get('experiments', copy).namingPattern, source.namingPattern);
  assert.equal(store.snapshot().samples.filter((entry) => entry.experimentId === copy).length, 0);
  assert.throws(
    () =>
      store.command({
        type: 'createExperiment',
        code: 'BAD',
        name: '错误模板',
        namingPattern: '{wrong}',
      }),
    /命名规则/,
  );
});

test('legacy time backfill keeps newly reserved names and original unknown times through a verified backup', async (t) => {
  const { store, itemId, directory } = setup(t);
  const item = store.get('items', itemId);
  delete item.plannedName;
  delete item.nameNumber;
  store.put('items', item);
  store.command({ type: 'times', itemId, startedAt: null, endedAt: '2026-10-09T04:00:00.000Z' });
  const run = store.snapshot().runs[0];
  assert.equal(store.get('items', itemId).plannedName, run.filename);
  assert.equal(store.get('items', itemId).nameNumber, 1);
  assert.equal(run.startedAt, null);
  assert.equal(run.originalStartedAt, null);
  assert.equal(run.originalEndedAt, null);
  const file = join(directory, 'legacy-time.labrecord');
  await createBackup(store, file);
  const restored = await unpackBackup(file, join(directory, 'restored-times'));
  assert.deepEqual(restored, store.snapshot());
});

test('confirmed rejection is distinct from a committed write whose snapshot reply failed', (t) => {
  const { store, itemId } = setup(t);
  assert.throws(
    () =>
      store.command({ type: 'configureMeasurements', ids: [itemId], measurement: { batch: 1 } }),
    CommandRejectedError,
  );
  assert.throws(
    () =>
      store.command({
        type: 'configureMeasurements',
        ids: [itemId],
        measurement: { customName: 'CON' },
      }),
    CommandRejectedError,
  );
  const input = { type: 'scheduleMeasurements', itemIds: [itemId] } as const;
  const savedSnapshot = store.snapshot.bind(store);
  let lose = true;
  store.snapshot = () => {
    if (lose && store.db.prepare('SELECT id FROM requests WHERE id=?').get('post-commit-failure')) {
      lose = false;
      throw new Error('模拟提交后快照读取失败');
    }
    return savedSnapshot();
  };
  assert.throws(
    () => store.command(input, 'post-commit-failure'),
    (error) =>
      error instanceof Error &&
      !(error instanceof CommandRejectedError) &&
      /提交后/.test(error.message),
  );
  assert.equal(store.snapshot().items.length, 2);
  store.command(input, 'post-commit-failure');
  assert.equal(store.snapshot().items.length, 2);
});

test('operation count limit rejects a further append before writing any operation or event', (t) => {
  const { store, itemId, experimentId } = setup(t);
  const sampleId = store.get('items', itemId).sampleId;
  // Seed a valid legacy queue without optional metadata; this isolates the count guard.
  store.transaction(() => {
    for (let index = 1; index < 10000; index++)
      store.put('items', {
        id: `legacy-limit-${index}`,
        experimentId,
        sampleId,
        operation: '测量',
        order: index,
        status: 'pending',
      });
  });
  const before = store.snapshot();
  assert.throws(() => store.command({ type: 'scheduleMeasurements', itemIds: [itemId] }), /10,000/);
  assert.deepEqual(store.snapshot(), before);
});

test('backup rejects new cross-experiment name collisions while preserving old v1 duplicate run names', async (t) => {
  const { store, experimentId, itemId, directory } = setup(t);
  const otherId = store.command({
    type: 'createExperiment',
    code: 'OTHER-BT',
    name: '另一次机时',
  }).experimentId!;
  const otherItemId = store.command({
    type: 'addSamples',
    experimentId: otherId,
    patch: { state: 'same-state' },
    count: 1,
    prefix: 'S',
  }).itemId!;
  const original = store.get('items', otherItemId);
  store.put('items', {
    ...original,
    plannedName: store.get('items', itemId).plannedName!.toUpperCase(),
  });
  assert.throws(() => inspectDatabase(join(store.root, 'records.sqlite')), /计划名称重复/);
  store.put('items', original);
  store.command({ type: 'start', itemId });
  store.command({ type: 'finish', itemId });
  store.command({ type: 'start', itemId: otherItemId });
  store.command({ type: 'finish', itemId: otherItemId });
  for (const item of store.snapshot().items) {
    delete item.plannedName;
    delete item.nameNumber;
    delete item.measurement;
    store.put('items', item);
  }
  for (const run of store.snapshot().runs) {
    run.filename = 'legacy-same-name';
    delete run.snapshot.measurement;
    delete run.snapshot.group.material;
    store.put('runs', run);
  }
  for (const id of [experimentId, otherId])
    store.put('experiments', { ...store.get('experiments', id), namingPattern: '{sample}' });
  const before = store.snapshot();
  const path = join(directory, 'legacy-duplicate-names.labrecord');
  await createBackup(store, path);
  const restored = await unpackBackup(path, join(directory, 'legacy-duplicates'));
  assert.deepEqual(restored, before);
});
