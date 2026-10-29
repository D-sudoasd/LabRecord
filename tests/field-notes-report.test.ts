import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/desktop/reports.js';
import { fixture } from './helpers.js';

test('reports retain per-measurement notes and labelled legacy notes before and after start', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({ type: 'demo' }).experimentId!;
  const initial = store.snapshot();
  const [first, second] = initial.items.slice().sort((a, b) => a.order - b.order);
  const sample = initial.samples.find((entry) => entry.id === first.sampleId)!;
  store.command({ type: 'updateGroups', ids: [sample.groupId], patch: { notes: '原组备注' } });
  store.command({ type: 'updateSamples', ids: [sample.id], parameters: { notes: '原样品备注' } });
  store.command({ type: 'updateFieldRow', itemId: first.id, fieldNote: '待测 <标记> & 内容' });
  store.command({ type: 'updateFieldRow', itemId: second.id, fieldNote: '第二次独立备注' });
  assert.equal(store.snapshot().runs.length, 0, 'notes must not invent a run');

  let report = await renderReport(store.snapshot(), experimentId, store.root);
  assert.match(report.html, /待测 &lt;标记&gt; &amp; 内容/);
  assert.match(report.html, /样品备注：原样品备注/);
  assert.match(report.markdown, /待测 <标记> & 内容/);
  assert.match(report.markdown, /第二次独立备注/);

  store.command({ type: 'start', itemId: first.id });
  const started = store.snapshot().runs.find((entry) => entry.itemId === first.id)!;
  store.command({ type: 'saveRun', runId: started.id, notes: '原现场文字' });
  store.command({ type: 'updateFieldRow', itemId: first.id, fieldNote: '现场修正后的备注' });
  const after = store.snapshot();
  assert.equal(after.runs.find((entry) => entry.id === started.id)!.notes, '原现场文字');
  assert.deepEqual(after.runs.find((entry) => entry.id === started.id)!.snapshot, started.snapshot);
  report = await renderReport(after, experimentId, store.root);
  for (const document of [report.html, report.markdown]) {
    assert.match(document, /现场修正后的备注/);
    assert.match(document, /原现场备注：原现场文字/);
    assert.match(document, /样品备注：原样品备注/);
    assert.match(document, /第二次独立备注/);
  }
});

test('an explicitly empty measurement note keeps the old run note labelled rather than restoring it as new content', async (t) => {
  const { store } = fixture(t);
  const experimentId = store.command({ type: 'demo' }).experimentId!;
  const first = store.snapshot().items[0];
  store.command({ type: 'start', itemId: first.id });
  const run = store.snapshot().runs[0];
  store.command({ type: 'saveRun', runId: run.id, notes: '旧记录内容' });
  store.command({ type: 'updateFieldRow', itemId: first.id, fieldNote: '' });
  const after = store.snapshot();
  assert.equal(after.items.find((item) => item.id === first.id)!.fieldNote, '');
  assert.equal(after.runs[0].notes, '旧记录内容');
  const report = await renderReport(after, experimentId, store.root);
  assert.match(report.html, /原现场备注：旧记录内容/);
  assert.match(report.markdown, /原现场备注：旧记录内容/);
});
