import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { renderReport } from '../src/desktop/reports.js';
import { csvRows, exportFile, parseDelimited } from '../src/desktop/tables.js';
import { fixture } from './helpers.js';

test('reports and exports preserve an explicitly blank specimen value, inheritance and zero', async (t) => {
  const { store, directory } = fixture(t);
  const experimentId = store.command({ type: 'demo' }).experimentId!;
  const initial = store.snapshot();
  const items = initial.items.slice().sort((a, b) => a.order - b.order);
  const [blank, zero, inherited] = items;
  store.command({ type: 'updateSamples', ids: [blank.sampleId], values: { temperature: null } });
  store.command({ type: 'updateSamples', ids: [zero.sampleId], values: { temperature: 0 } });

  const planned = store.snapshot();
  const rows = csvRows(planned, experimentId);
  const headers = rows[0].map(String);
  const itemIdColumn = headers.indexOf('plan_item_id');
  const plannedTemperature = headers.indexOf('计划 温度 / °C');
  const row = (id: string) => rows.find((entry) => entry[itemIdColumn] === id)!;
  assert.equal(row(blank.id)[plannedTemperature], null);
  assert.equal(row(zero.id)[plannedTemperature], 0);
  assert.equal(row(inherited.id)[plannedTemperature], 25);

  const plannedReport = await renderReport(planned, experimentId, store.root);
  const blankSampleCode = planned.samples.find((sample) => sample.id === blank.sampleId)!.code;
  const blankSection = plannedReport.html.split(`<h2>${blankSampleCode}`)[1].split('</section>')[0];
  assert.match(blankSection, /温度 \/ °C（计划 → 实际）<\/th><td>未记录 → 未记录<\/td>/);

  store.command({ type: 'start', itemId: blank.id });
  const started = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: started.id, actual: { temperature: 0 } });
  store.command({
    type: 'updateGroups',
    ids: [planned.samples.find((sample) => sample.id === blank.sampleId)!.groupId],
    patch: { values: { temperature: 99 } },
  });
  store.command({ type: 'updateSamples', ids: [blank.sampleId], values: { temperature: 42 } });
  const final = store.snapshot();
  assert.equal(final.runs[0].snapshot.sample.values.temperature, null);
  assert.equal(final.runs[0].snapshot.group.values.temperature, 25);
  assert.equal(final.runs[0].actual.temperature, 0);

  const finalRows = csvRows(final, experimentId);
  const finalHeader = finalRows[0].map(String);
  const operation = (id: string) =>
    finalRows.find((entry) => entry[finalHeader.indexOf('plan_item_id')] === id)!;
  assert.equal(operation(blank.id)[finalHeader.indexOf('计划 温度 / °C')], null);
  assert.equal(operation(blank.id)[finalHeader.indexOf('实际 温度 / °C')], 0);
  assert.equal(operation(zero.id)[finalHeader.indexOf('计划 温度 / °C')], 0);
  assert.equal(operation(inherited.id)[finalHeader.indexOf('计划 温度 / °C')], 99);

  const report = await renderReport(final, experimentId, store.root);
  const startedSection = report.html.split(`<h2>${blankSampleCode}`)[1].split('</section>')[0];
  assert.match(startedSection, /温度 \/ °C（计划 → 实际）<\/th><td>未记录 → 0<\/td>/);
  assert.doesNotMatch(startedSection, /温度 \/ °C（计划 → 实际）<\/th><td>(?:25|42|99) → 0<\/td>/);

  const csvPath = join(directory, 'custom-values.csv');
  const xlsxPath = join(directory, 'custom-values.xlsx');
  await exportFile(final, experimentId, 'csv', csvPath);
  await exportFile(final, experimentId, 'xlsx', xlsxPath);
  const csv = parseDelimited(await readFile(csvPath, 'utf8'));
  const csvOperation = csv.find((entry) => entry[csv[0].indexOf('plan_item_id')] === blank.id)!;
  assert.equal(csvOperation[csv[0].indexOf('计划 温度 / °C')], '');
  assert.equal(csvOperation[csv[0].indexOf('实际 温度 / °C')], '0');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.getWorksheet('操作记录')!;
  const sheetHeaders = sheet.getRow(1).values as string[];
  const sheetRow = sheet
    .getRows(2, sheet.rowCount - 1)!
    .find((entry) => entry.getCell(sheetHeaders.indexOf('plan_item_id')).value === blank.id)!;
  assert.equal(sheetRow.getCell(sheetHeaders.indexOf('计划 温度 / °C')).value, null);
  assert.equal(sheetRow.getCell(sheetHeaders.indexOf('实际 温度 / °C')).value, 0);
});
