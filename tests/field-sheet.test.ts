import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { archiveSchema } from '../src/desktop/archive-validation.js';
import { createBackup, unpackBackup } from '../src/desktop/backups.js';
import {
  exportFile,
  importTable,
  previewRows,
  writeFieldSheetWorkbook,
} from '../src/desktop/tables.js';
import {
  fieldSheetHtml,
  fieldSheetPrintRows,
  fieldSheetPrintTable,
  fieldSheetRows,
  fieldSheetTable,
} from '../src/shared/fieldSheet.js';
import {
  assignSpecimenCodes,
  CODE_PATTERN_HYPHEN,
  CODE_PATTERN_PAD,
  planSpecimens,
  prefixFromCodes,
} from '../src/shared/model.js';
import { fixture } from './helpers.js';

test('sample codes keep two digits unless the experiment chooses another pattern', () => {
  assert.deepEqual(
    planSpecimens(['S01'], 2, 'S', { state: '固溶' }).map((row) => row.code),
    ['S02', 'S03'],
  );
  assert.deepEqual(
    planSpecimens([], 2, 'G', { state: '固溶' }, CODE_PATTERN_HYPHEN).map((row) => row.code),
    ['G-1', 'G-2'],
  );
  assert.deepEqual(
    planSpecimens(['G01'], 1, 'G', { state: '固溶' }, CODE_PATTERN_PAD).map((row) => row.code),
    ['G02'],
  );
  assert.deepEqual(
    planSpecimens([], 1, 'G', { state: '固溶' }, '{prefix}_{n:03}').map((row) => row.code),
    ['G_001'],
  );
  assert.throws(() => planSpecimens([], 1, 'G', { state: '固溶' }, '{n}'), /\{prefix\}/);
  assert.equal(prefixFromCodes(['TA-01', 'TA-02'], CODE_PATTERN_PAD), 'TA-');
  assert.equal(prefixFromCodes(['G-1', 'G-2'], CODE_PATTERN_HYPHEN), 'G');
  assert.equal(prefixFromCodes(['G-1', 'S01'], CODE_PATTERN_HYPHEN), '');
  assert.deepEqual(
    assignSpecimenCodes([], 2, 'G', { state: '固溶' }, CODE_PATTERN_HYPHEN, [
      { code: 'G-1' },
      {},
    ]).map((row) => row.code),
    ['G-1', 'G-2'],
  );
});

test('the field sheet lists every measurement in order and keeps per-run snapshots', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'P21',
    name: '现场表',
    namingPattern: '{sample}',
  }).experimentId!;
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    sampleCodePattern: CODE_PATTERN_HYPHEN,
  });
  const first = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '固溶',
      name: '第一组 Ti2448',
      material: 'Ti2448',
      preparedCount: 4,
      mode: 'In situ',
      priority: 'P0',
      protocol: '组级条件：375 °C 保温 30 min',
      composition: 'Ti-24Al-8Nb',
      processing: '冷轧 25%',
      heatTreatment: '350 °C 30 min',
      otherTreatment: '机械抛光',
      preparation: '样品组制备说明',
      notes: '第一组旧备注',
    },
    count: 1,
    prefix: 'G',
    specimens: [
      {
        name: '原表编号 A-01',
        state: '冷轧态',
        thickness: '1.0',
        thicknessUnit: 'mm',
        width: '2.5',
        height: '',
        dimensionUnit: 'mm',
      },
    ],
    measurement: {
      mode: 'In situ',
      technique: 'SXRD',
      regime: 'cyclic',
      batch: 'B01',
      protocol: '首测：0–2% 应变循环 10 次',
    },
  }).itemId!;
  const secondSample = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '未指定',
      name: '第二组 Ti2448',
      material: 'Ti2448',
      preparedCount: 3,
      mode: 'Ex situ',
      priority: 'P0',
      notes: '第二组旧备注',
    },
    count: 1,
    prefix: 'G',
    specimens: [
      {
        name: '原表编号 B-01',
        thickness: '0.8',
        thicknessUnit: 'mm',
        width: '3',
        height: '',
        dimensionUnit: 'mm',
      },
    ],
    measurement: {
      mode: 'Ex situ',
      technique: 'SAXS',
      regime: 'static',
      batch: 'RT',
      protocol: '室温静态测量',
    },
  }).itemId!;
  const repeated = store.command({
    type: 'scheduleMeasurements',
    itemIds: [first],
    measurement: {
      mode: 'In situ',
      technique: 'SXRD',
      regime: 'rotation',
      batch: 'B02',
      protocol: '-90° 至 90°，每 5° 一步',
    },
  }).itemId!;
  const initial = store.snapshot();
  const firstSample = initial.samples.find(
    (sample) => sample.id === initial.items.find((item) => item.id === first)!.sampleId,
  )!;
  assert.deepEqual(
    initial.items.map((item) => item.plannedName),
    ['G-1', 'G-2', 'G-1-2'],
  );
  store.command({ type: 'reorder', experimentId, ids: [first, repeated, secondSample] });
  const reordered = fieldSheetRows(store.snapshot(), experimentId);
  assert.deepEqual(
    reordered.map((row) => row.code),
    ['G-1', 'G-1-2', 'G-2'],
  );
  assert.deepEqual(
    reordered.map((row) => [row.itemId, row.sampleId]),
    [
      [first, firstSample.id],
      [repeated, firstSample.id],
      [secondSample, initial.items.find((item) => item.id === secondSample)!.sampleId],
    ],
  );
  assert.equal(reordered[0].status, 'pending');
  assert.equal(reordered[0].nameReserved, true);
  assert.equal(reordered[0].size, '厚 1.0 mm · 宽 2.5 mm');
  assert.match(reordered[0].protocol, /原位/);
  assert.match(reordered[0].protocol, /SXRD/);
  assert.match(reordered[0].protocol, /循环加载/);
  assert.match(reordered[0].protocol, /批次：B01/);
  assert.match(reordered[0].protocol, /首测：0–2% 应变循环 10 次/);
  assert.equal(reordered[1].protocol.includes('重测'), false, '追加制度保留同一样品而不是标为重测');
  assert.match(reordered[1].protocol, /旋转扫描/);
  assert.match(reordered[1].protocol, /B02/);
  assert.match(reordered[2].protocol, /离位/);
  assert.equal(reordered[2].size, '厚 0.8 mm · 宽 3 mm');
  assert.match(reordered[0].identity, /原表编号 A-01/);
  assert.match(reordered[0].identity, /第一组 Ti2448/);
  assert.match(reordered[0].identity, /状态：冷轧态/);
  assert.match(reordered[0].identity, /成分：Ti-24Al-8Nb/);
  assert.match(reordered[0].identity, /加工工艺：冷轧 25%/);
  assert.match(reordered[0].identity, /热处理制度：350 °C 30 min/);
  assert.match(reordered[0].identity, /其他工艺：机械抛光/);
  assert.match(reordered[0].identity, /制备 \/ 试剂名称：样品组制备说明/);
  assert.doesNotMatch(reordered[0].identity, /私密备注|notes|不要印/);
  assert.doesNotMatch(reordered[0].identity, new RegExp(firstSample.id));
  assert.match(reordered[2].identity, /状态：未指定/);

  store.command({ type: 'start', itemId: first });
  const runBefore = structuredClone(store.snapshot().runs[0]);
  store.command({
    type: 'updateGroups',
    ids: [firstSample.groupId],
    patch: {
      name: '后来改的组名',
      protocol: '后来修改的组条件',
      thickness: '9',
      thicknessUnit: 'mm',
      width: '8',
      dimensionUnit: 'mm',
      composition: '后改成分',
    },
  });
  store.command({
    type: 'updateSamples',
    ids: [firstSample.id],
    parameters: { name: '后改样品名', state: '后改状态' },
  });
  store.command({
    type: 'saveRun',
    runId: runBefore.id,
    actual: { mode: 'Ex situ', protocol: '1e-3 s^-1', thickness: '1.2', thicknessUnit: 'mm' },
    actualSample: { name: '实际样品名', width: '2.6', dimensionUnit: 'mm' },
  });
  const afterRun = store.snapshot();
  assert.deepEqual(afterRun.runs[0].snapshot, runBefore.snapshot);
  assert.equal(afterRun.runs[0].snapshot.sampleGroupName, '第一组 Ti2448');
  assert.equal(afterRun.runs[0].originalStartedAt, runBefore.originalStartedAt);
  const historical = fieldSheetRows(afterRun, experimentId).find((row) => row.itemId === first)!;
  assert.equal(historical.code, runBefore.filename);
  assert.match(historical.size, /实际 厚 1.2 mm · 宽 2.6 mm · 计划 厚 1.0 mm · 宽 2.5 mm/);
  assert.match(historical.protocol, /开始时/);
  assert.match(historical.protocol, /首测：0–2% 应变循环 10 次/);
  assert.match(historical.protocol, /实际实验方式 非原位 · 开始时 原位/);
  assert.match(historical.protocol, /实际制度 1e-3 s\^-1/);
  assert.doesNotMatch(historical.protocol, /后来修改的组条件/);
  assert.match(historical.identity, /原表编号 A-01/);
  assert.match(historical.identity, /第一组 Ti2448/);
  assert.match(historical.identity, /实际样品名：实际样品名/);
  assert.match(historical.identity, /开始时：原表编号 A-01/);
  assert.doesNotMatch(historical.identity, /后改样品名|后改组名|后改成分/);
  const stillPending = fieldSheetRows(afterRun, experimentId).find(
    (row) => row.itemId === repeated,
  )!;
  assert.equal(stillPending.code, afterRun.items.find((item) => item.id === repeated)!.plannedName);
  assert.match(stillPending.protocol, /-90° 至 90°，每 5° 一步/);
  assert.equal(stillPending.size, '厚 1.0 mm · 宽 2.5 mm', 'each row keeps its own sample plan');

  store.command({ type: 'skip', itemId: secondSample, reason: '排队原因不打印' });
  const skipped = fieldSheetRows(store.snapshot(), experimentId).find(
    (row) => row.itemId === secondSample,
  )!;
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.code, initial.items.find((item) => item.id === secondSample)!.plannedName);
  assert.match(skipped.protocol, /状态：已跳过/);
  assert.doesNotMatch(skipped.protocol, /排队原因不打印/);

  const html = fieldSheetHtml(store.snapshot(), experimentId);
  assert.match(html, /一行一项测量/);
  assert.match(
    html,
    /<colgroup><col class="code"><col class="size"><col class="protocol"><col class="identity"><col class="note"><\/colgroup>/,
  );
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /break-inside: avoid/);
  assert.equal(html.includes('未填写'), false);
  assert.equal(html.includes('样品组备注：第二组旧备注'), true);
  assert.equal(html.includes('排队原因不打印'), false);
  const printable = fieldSheetPrintRows(fieldSheetRows(store.snapshot(), experimentId));
  assert.equal(
    (html.match(/<small class="field-sheet-continuation">（续）<\/small>/g) || []).length,
    printable.filter((row) => row.continuation).length,
    'only actual continuation rows are labelled',
  );
  for (const row of fieldSheetRows(store.snapshot(), experimentId)) {
    const related = printable.filter((segment) => segment.cells[0] === row.code);
    assert.equal(related.map((segment) => segment.cells[2]).join(''), row.protocol);
    assert.equal(related.map((segment) => segment.cells[3]).join(''), row.identity);
  }

  await exportFile(store.snapshot(), experimentId, 'xlsx', join(directory, 'full.xlsx'));
  const full = new ExcelJS.Workbook();
  await full.xlsx.readFile(join(directory, 'full.xlsx'));
  assert.equal(full.worksheets[0].name, '实验规划');
  const fullSheet = full.getWorksheet('现场规划表')!;
  const readRows = (sheet: ExcelJS.Worksheet) =>
    Array.from({ length: sheet.rowCount }, (_, row) =>
      Array.from({ length: 5 }, (_, column) => sheet.getRow(row + 1).getCell(column + 1).text),
    );
  assert.deepEqual(readRows(fullSheet), fieldSheetPrintTable(store.snapshot(), experimentId));
  await writeFieldSheetWorkbook(store.snapshot(), experimentId, join(directory, 'sheet.xlsx'));
  const dedicated = new ExcelJS.Workbook();
  await dedicated.xlsx.readFile(join(directory, 'sheet.xlsx'));
  assert.deepEqual(
    dedicated.worksheets.map((sheet) => sheet.name),
    ['现场规划表'],
  );
  const sheet = dedicated.worksheets[0];
  const header = sheet.getRow(1).values as string[];
  assert.deepEqual(header.slice(1), ['简写编号', '尺寸', '原位参数', '实际样品信息', '备注']);
  assert.deepEqual(readRows(sheet), fieldSheetPrintTable(store.snapshot(), experimentId));
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.pageSetup.fitToHeight, 0);
  assert.equal(sheet.pageSetup.printTitlesRow, '1:1');
  assert.ok(sheet.getRow(2).height! >= 34);
  assert.ok(sheet.getColumn(1).width! >= 16);
  assert.equal(sheet.getRow(2).getCell(1).alignment?.wrapText, true);
  const ordinaryIndex = printable.findIndex((row) => !row.continued);
  assert.ok(
    ordinaryIndex >= 0 && sheet.getRow(ordinaryIndex + 2).height! <= 200,
    'ordinary printable rows remain compact',
  );

  const preview = previewRows([
    ['简写编号', '尺寸', '原位参数', '实际样品信息'],
    ['G-1', '厚 0.8 mm', '原位 · 升温', 'Ti2448'],
  ]);
  assert.equal(
    preview.warnings.some((warning) => warning.includes('不生成操作记录')),
    true,
  );
  const previewSnapshot = store.snapshot();
  assert.throws(
    () =>
      importTable(store, {
        experimentId,
        table: preview,
        mapping: { name: 0 },
        keepOtherColumns: true,
      }),
    /现场规划表只用于打印对照/,
  );
  assert.deepEqual(
    store.snapshot(),
    previewSnapshot,
    'an explicit field mapping cannot turn the print sheet into sample rows',
  );
  const runs = store.snapshot().runs.length;
  const groups = store.snapshot().groups.length;
  assert.throws(
    () =>
      importTable(store, {
        experimentId,
        table: preview,
        mapping: preview.mapping,
        keepOtherColumns: true,
      }),
    /不会导入为样品/,
  );
  assert.equal(store.snapshot().runs.length, runs);
  assert.equal(store.snapshot().groups.length, groups);
  assert.equal(store.snapshot().schemaVersion, 3);
  assert.equal(archiveSchema.safeParse(store.snapshot()).success, true);
  const backupPath = join(directory, 'sample-group-name.labrecord');
  await createBackup(store, backupPath);
  const restored = await unpackBackup(backupPath, join(directory, 'restored-group-name'));
  assert.deepEqual(restored, store.snapshot());
  assert.equal(restored.runs[0].snapshot.sampleGroupName, '第一组 Ti2448');
});

test('an unreserved legacy name remains blank and is called out without inventing a run', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'OLD',
    name: '旧计划',
    namingPattern: '{experiment}_{sample}',
  }).experimentId!;
  const { itemId } = store.command({
    type: 'addSamples',
    experimentId,
    patch: { state: '未指定', name: '实物 A', preparedCount: 1, mode: '未定', priority: 'P0' },
    count: 1,
    prefix: 'S',
  });
  const item = store.get('items', itemId!);
  delete item.plannedName;
  delete item.nameNumber;
  store.put('items', item);
  const rows = fieldSheetRows(store.snapshot(), experimentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '');
  assert.equal(rows[0].nameReserved, false);
  assert.match(rows[0].protocol, /文件夹名未预留/);
  assert.equal(store.snapshot().runs.length, 0);
});

test('a normal legacy table may use one field-sheet word as a real custom field', (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'LEGACY',
    name: '旧表字段',
  }).experimentId!;
  const table = previewRows([
    ['名称', '尺寸'],
    ['旧表样品 A', '0.8 × 3 mm'],
  ]);
  assert.doesNotMatch(table.warnings.join('\n'), /现场规划表/);
  const imported = importTable(store, {
    experimentId,
    table,
    mapping: table.mapping,
    keepOtherColumns: true,
  });
  const field = imported.experiments
    .find((experiment) => experiment.id === experimentId)!
    .fields.find((candidate) => candidate.label === '尺寸');
  assert.ok(field);
  const group = imported.groups.find((candidate) => candidate.experimentId === experimentId)!;
  assert.equal(group.name, '旧表样品 A');
  assert.equal(group.values[field.id], '0.8 × 3 mm');
});

test('historical field-sheet identity keeps the original group name without backfilling legacy snapshots', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'HISTORY',
    name: '历史样品信息',
    namingPattern: '{sample}',
  }).experimentId!;
  const first = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '固溶',
      name: '旧组名 A',
      material: 'Ti2448',
      preparedCount: 1,
      mode: 'In situ',
      priority: 'P0',
    },
    count: 1,
    prefix: 'G',
    specimens: [{ name: '原表编号 A-01' }],
  }).itemId!;
  const second = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '固溶',
      name: '旧组名 B',
      material: 'Ti2448',
      preparedCount: 1,
      mode: 'In situ',
      priority: 'P0',
    },
    count: 1,
    prefix: 'G',
  }).itemId!;
  store.command({ type: 'start', itemId: first });
  store.command({ type: 'finish', itemId: first });
  store.command({ type: 'start', itemId: second });
  const runs = store.snapshot().runs;
  for (const run of runs) {
    delete run.snapshot.sampleGroupName;
    store.put('runs', run);
  }
  assert.equal(archiveSchema.safeParse(store.snapshot()).success, true);
  store.command({
    type: 'updateGroups',
    ids: store.snapshot().groups.map((group) => group.id),
    patch: { name: '后改的组名' },
  });
  const rows = fieldSheetRows(store.snapshot(), experimentId);
  const namedSample = rows.find((row) => row.itemId === first)!;
  assert.match(namedSample.identity, /原表编号 A-01/);
  assert.doesNotMatch(namedSample.identity, /旧组名 A|后改的组名/);
  const unnamedSample = rows.find((row) => row.itemId === second)!;
  assert.match(unnamedSample.identity, /旧组名 B/);
  assert.doesNotMatch(unnamedSample.identity, /后改的组名/);

  const backupPath = join(directory, 'legacy-sample-group-name.labrecord');
  await createBackup(store, backupPath);
  const restored = await unpackBackup(backupPath, join(directory, 'legacy-restored'));
  assert.deepEqual(restored.runs, store.snapshot().runs);
  assert.equal(
    restored.runs.every((run) => run.snapshot.sampleGroupName === undefined),
    true,
  );
});

test('long printable cells continue on bounded physical rows with the original code and exact text', async (t) => {
  const { store, directory } = fixture(t);
  const markers = Array.from({ length: 130 }, (_, index) => String(index + 1).padStart(4, '0'));
  const longProtocol = markers
    .map(
      (marker) =>
        `PROTO-${marker}-START|LONG-PROTOCOL-CHUNK-${marker}|${'循环加载，升温 10 °C/min，保温 30 min；'.repeat(4)}|PROTO-${marker}-END`,
    )
    .join('\n');
  const longIdentity = markers.map((marker) => `IDENT-${marker}`).join('；');
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'LONG',
    name: '长制度现场表',
    namingPattern: '{sample}',
  }).experimentId!;
  store.command({
    type: 'updateExperiment',
    id: experimentId,
    sampleCodePattern: CODE_PATTERN_HYPHEN,
  });
  const { itemId } = store.command({
    type: 'addSamples',
    experimentId,
    patch: {
      state: '固溶',
      name: 'Ti2448',
      composition: longIdentity,
      preparedCount: 1,
      mode: 'In situ',
      priority: 'P0',
    },
    count: 1,
    prefix: 'G',
    specimens: [
      {
        name: '原表编号 A-01',
        thickness: '1.0',
        thicknessUnit: 'mm',
        width: '3.0',
        dimensionUnit: 'mm',
      },
    ],
    measurement: {
      mode: 'In situ',
      technique: 'SXRD',
      regime: 'cyclic',
      batch: 'B01',
      protocol: longProtocol,
    },
  });
  const snapshot = store.snapshot();
  assert.equal(snapshot.items[0].id, itemId);
  const logical = fieldSheetRows(snapshot, experimentId);
  const logicalTable = fieldSheetTable(snapshot, experimentId);
  assert.equal(logical.length, 1, 'the on-screen projection stays one row per measurement');
  assert.equal(logicalTable.length, 2, 'the logical table stays one row per measurement');
  for (const marker of markers) {
    assert.equal(logical[0].protocol.split(`PROTO-${marker}-START`).length - 1, 1);
    assert.equal(logical[0].protocol.split(`LONG-PROTOCOL-CHUNK-${marker}`).length - 1, 1);
    assert.equal(logical[0].protocol.split(`PROTO-${marker}-END`).length - 1, 1);
    assert.equal(logical[0].identity.split(`IDENT-${marker}`).length - 1, 1);
  }
  const physicalRows = fieldSheetPrintRows(logical);
  const physicalTable = fieldSheetPrintTable(snapshot, experimentId);
  assert.ok(physicalRows.length > 1, 'long text is split into print continuations');
  assert.equal(physicalRows[0].continuation, false);
  assert.ok(physicalRows.slice(1).every((row) => row.continuation));
  assert.deepEqual(physicalTable, [
    ['简写编号', '尺寸', '原位参数', '实际样品信息', '备注'],
    ...physicalRows.map((row) => row.cells),
  ]);
  assert.ok(
    physicalRows.every((row) => row.cells[0] === 'G-1'),
    'every continuation repeats the exact folder name',
  );
  assert.deepEqual(
    [1, 2, 3, 4].map((column) => physicalRows.map((row) => row.cells[column]).join('')),
    logicalTable[1].slice(1),
    'concatenated print cells exactly recover each original long value',
  );
  for (const row of physicalRows) {
    const value = row.cells[2];
    if (!value) continue;
    const firstCodePoint = value.charCodeAt(0);
    const lastCodePoint = value.charCodeAt(value.length - 1);
    assert.equal(
      firstCodePoint >= 0xdc00 && firstCodePoint <= 0xdfff,
      false,
      'no segment begins with half a surrogate pair',
    );
    assert.equal(
      lastCodePoint >= 0xd800 && lastCodePoint <= 0xdbff,
      false,
      'no segment ends with half a surrogate pair',
    );
  }
  const html = fieldSheetHtml(snapshot, experimentId);
  assert.equal((html.match(/<tr>/g) || []).length, physicalRows.length + 1);
  assert.equal(
    (html.match(/<small class="field-sheet-continuation">（续）<\/small>/g) || []).length,
    physicalRows.length - 1,
  );

  const singlePath = join(directory, 'long-sheet.xlsx');
  await writeFieldSheetWorkbook(snapshot, experimentId, singlePath);
  const single = new ExcelJS.Workbook();
  await single.xlsx.readFile(singlePath);
  const singleSheet = single.getWorksheet('现场规划表')!;
  assert.equal(singleSheet.rowCount, physicalRows.length + 1);
  assert.ok(singleSheet.getRows(2, singleSheet.rowCount - 1)!.every((row) => row.height! < 409.5));
  assert.ok(singleSheet.getRows(2, singleSheet.rowCount - 1)!.every((row) => row.height! >= 250));
  assert.ok(
    singleSheet.getRow(2).height! > 150,
    'long continuation rows use a conservative printable height',
  );
  assert.ok(
    singleSheet
      .getRows(2, singleSheet.rowCount - 1)!
      .every(
        (row, index) =>
          row.getCell(1).value === 'G-1' &&
          (index === 0) === (row.getCell(1).numFmt !== '@"（续）"'),
      ),
    'Excel stores the exact code and applies a display-only continuation format',
  );
  assert.deepEqual(
    singleSheet.getRows(2, singleSheet.rowCount - 1)!.map((row) => row.getCell(1).text),
    physicalRows.map((row) => row.cells[0]),
  );

  const fullPath = join(directory, 'long-full.xlsx');
  await exportFile(snapshot, experimentId, 'xlsx', fullPath);
  const full = new ExcelJS.Workbook();
  await full.xlsx.readFile(fullPath);
  const fullSheet = full.getWorksheet('现场规划表')!;
  assert.equal(fullSheet.rowCount, physicalRows.length + 1);
  assert.equal(fullSheet.pageSetup.printTitlesRow, '1:1');
  assert.ok(fullSheet.getRows(2, fullSheet.rowCount - 1)!.every((row) => row.height! < 409.5));
  assert.ok(fullSheet.getRows(2, fullSheet.rowCount - 1)!.every((row) => row.height! >= 250));
  assert.ok(
    fullSheet
      .getRows(2, fullSheet.rowCount - 1)!
      .slice(1)
      .every((row) => row.getCell(1).numFmt === '@"（续）"'),
  );
  assert.equal(store.snapshot().runs.length, 0, 'print continuations do not create actual runs');
});

test('wide ASCII cells estimate printable height and continue without truncating long strings', async (t) => {
  const segment = (protocol: string) =>
    fieldSheetPrintRows([
      {
        itemId: 'item',
        sampleId: 'sample',
        status: 'pending',
        code: 'G-1',
        nameReserved: true,
        size: '',
        protocol,
        identity: '',
        note: '',
        noteSource: 'empty',
        legacyNotes: '',
      },
    ]);
  const shortWide = 'W'.repeat(80);
  assert.equal(segment(shortWide).length, 1, 'a moderate wide-ASCII value stays on one line item');
  for (const longText of ['M'.repeat(280), `混合宽字形 ${'WM'.repeat(80)} 结束`]) {
    const rows = segment(longText);
    assert.ok(
      rows.length > 1,
      'long wide-ASCII text is continued before Excel row height becomes unsafe',
    );
    assert.ok(rows.every((row) => row.cells[0] === 'G-1'));
    assert.equal(rows.map((row) => row.cells[2]).join(''), longText);
  }

  const { store, directory } = fixture(t);
  const experimentId = store.command({
    type: 'createExperiment',
    code: 'ASCII',
    name: '宽字形行高',
    namingPattern: '{sample}',
  }).experimentId!;
  const addSample = (name: string, protocol: string) =>
    store.command({
      type: 'addSamples',
      experimentId,
      patch: {
        state: '固溶',
        name,
        preparedCount: 1,
        mode: 'In situ',
        priority: 'P0',
        protocol,
      },
      count: 1,
      prefix: 'G',
    });
  addSample('普通条件', '室温');
  addSample('宽英文条件', shortWide);
  const path = join(directory, 'wide-ascii.xlsx');
  await writeFieldSheetWorkbook(store.snapshot(), experimentId, path);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet('现场规划表')!;
  assert.equal(sheet.rowCount, 3, '80 wide ASCII characters do not require a continuation row');
  const ordinaryHeight = sheet.getRow(2).height!;
  const wideHeight = sheet.getRow(3).height!;
  assert.ok(ordinaryHeight <= 65, `ordinary row stays compact (${ordinaryHeight} pt)`);
  assert.ok(wideHeight >= 85, `wide glyphs receive wrap height (${wideHeight} pt)`);
  assert.ok(
    wideHeight <= 145,
    `moderate wide text remains bounded with wrap margin (${wideHeight} pt)`,
  );
});
