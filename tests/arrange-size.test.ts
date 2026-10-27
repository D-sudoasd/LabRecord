import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t);
  const experimentId = data.store.command({
    type: 'createExperiment',
    code: 'SIZE',
    name: '尺寸按件',
  }).experimentId!;
  data.store.command({
    type: 'createGroup',
    experimentId,
    patch: {
      state: '共用旧尺寸',
      name: '旧组',
      preparedCount: 20,
      thickness: '0.8',
      thicknessUnit: 'mm',
      width: '3',
      dimensionUnit: 'mm',
    },
  });
  const group = data.store.snapshot().groups[0];
  return { ...data, experimentId, group };
}

test('arrange without sizes still inherits the group and writes no sample size', (t) => {
  const { store, group } = setup(t);
  store.command({ type: 'arrange', groupId: group.id, count: 2 });
  const samples = store.snapshot().samples;
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0].parameters, {});
  assert.deepEqual(samples[1].parameters, {});
  assert.equal(store.snapshot().groups[0].thickness, '0.8');
});

test('each arranged specimen keeps the size it was given, even when it matches the group', (t) => {
  const { store, group } = setup(t);
  store.command({
    type: 'arrange',
    groupId: group.id,
    count: 2,
    specimens: [
      { thickness: '1.1', thicknessUnit: 'mm', width: '3', height: '', dimensionUnit: 'mm' },
      { thickness: '0.4', thicknessUnit: 'μm', width: '2', height: '5', dimensionUnit: 'mm' },
    ],
  });
  const samples = store.snapshot().samples;
  assert.equal(samples[0].parameters.thickness, '1.1');
  assert.equal(samples[0].parameters.thicknessUnit, 'mm');
  assert.equal(samples[0].parameters.height, '');
  assert.equal(samples[1].parameters.thickness, '0.4');
  assert.equal(samples[1].parameters.thicknessUnit, 'μm');
  assert.equal(samples[1].parameters.width, '2');
  assert.equal(samples[1].parameters.height, '5');
  assert.equal(store.snapshot().groups[0].thickness, '0.8');

  store.command({
    type: 'arrange',
    groupId: group.id,
    count: 1,
    specimens: [
      { thickness: '0.8', thicknessUnit: 'mm', width: '3', height: '', dimensionUnit: 'mm' },
    ],
  });
  const same = store.snapshot().samples.at(-1)!;
  assert.equal(same.parameters.thickness, '0.8');
  assert.equal(same.parameters.width, '3');
  assert.equal('thickness' in same.parameters, true);
});

test('a name without size keys does not invent a sample size', (t) => {
  const { store, group } = setup(t);
  store.command({
    type: 'arrange',
    groupId: group.id,
    count: 1,
    specimens: [{ name: '甲' }],
  });
  const sample = store.snapshot().samples[0];
  assert.equal(sample.parameters.name, '甲');
  assert.equal('thickness' in sample.parameters, false);
  assert.equal('state' in sample.parameters, false);
  assert.equal('notes' in sample.parameters, false);
});

test('each arranged specimen keeps its own state and note', (t) => {
  const { store, group } = setup(t);
  store.command({
    type: 'updateGroups',
    ids: [group.id],
    patch: { notes: '组里的备注' },
  });
  store.command({
    type: 'arrange',
    groupId: group.id,
    count: 2,
    specimens: [
      { state: '时效', notes: '先测这件' },
      { state: '', notes: '' },
    ],
  });
  const samples = store.snapshot().samples;
  assert.equal(samples[0].parameters.state, '时效');
  assert.equal(samples[0].parameters.notes, '先测这件');
  assert.equal(samples[1].parameters.state, '共用旧尺寸');
  assert.equal('notes' in samples[1].parameters, false);
  assert.equal(store.snapshot().groups[0].state, '共用旧尺寸');
  assert.equal(store.snapshot().groups[0].notes, '组里的备注');
});

test('addSamples stores each specimen size and ignores specimens when nothing is arranged', (t) => {
  const { store, experimentId } = setup(t);
  store.command({
    type: 'addSamples',
    experimentId,
    count: 2,
    patch: { state: '新组', name: '按件' },
    specimens: [
      { thickness: '1.2', thicknessUnit: 'mm', width: '4', height: '', dimensionUnit: 'mm' },
      { thickness: '1.8', thicknessUnit: 'mm', width: '4', height: '1', dimensionUnit: 'mm' },
    ],
  });
  const snapshot = store.snapshot();
  const created = snapshot.groups.find((group) => group.state === '新组')!;
  assert.equal(created.thickness, '');
  const samples = snapshot.samples.filter((sample) => sample.groupId === created.id);
  assert.deepEqual(
    samples.map((sample) => sample.parameters.thickness),
    ['1.2', '1.8'],
  );
  assert.equal(samples[1].parameters.height, '1');

  const before = snapshot.samples.length;
  store.command({
    type: 'addSamples',
    experimentId,
    count: 0,
    patch: { state: '只准备', name: '备样' },
    specimens: [{ thickness: '9', thicknessUnit: 'mm', width: '', height: '', dimensionUnit: 'mm' }],
  });
  const after = store.snapshot();
  assert.equal(after.samples.length, before);
  assert.equal(after.groups.find((group) => group.state === '只准备')!.thickness, '');
});

test('a specimen list must match the number being arranged', (t) => {
  const { store, group } = setup(t);
  assert.throws(
    () =>
      store.command({
        type: 'arrange',
        groupId: group.id,
        count: 2,
        specimens: [{ thickness: '1' }],
      }),
    /名单要和本次安排的件数一致/,
  );
});
