import type { Experiment, Group, MeasurementPlan, PlanItem, Sample, Snapshot } from './model.js';
import { effectiveProtocol, filenameFor } from './model.js';

export const REGIMES = [
  { value: 'monotonic', label: '单调拉伸 / 压缩' },
  { value: 'cyclic', label: '循环加载' },
  { value: 'step', label: '分级加载' },
  { value: 'rotation', label: '旋转扫描' },
  { value: 'thermal', label: '升降温 / 保温' },
  { value: 'static', label: '离位 / 静态测量' },
];
export const regimeLabel = (value: string = '') =>
  REGIMES.find((entry) => entry.value === value)?.label || value || '制度未定';

export function plannedGroup(group: Group, sample: Sample, item: PlanItem): Group {
  return {
    ...group,
    ...sample.parameters,
    mode: item.measurement?.mode ?? sample.parameters.mode ?? group.mode,
    protocol: item.measurement?.protocol ?? effectiveProtocol(group, sample.parameters),
  };
}

export function measurementFor(snapshot: Snapshot, item: PlanItem): MeasurementPlan {
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  const sample =
    run?.snapshot.sample || snapshot.samples.find((entry) => entry.id === item.sampleId)!;
  const group =
    run?.snapshot.group ||
    plannedGroup(
      snapshot.groups.find((entry) => entry.id === sample.groupId)!,
      sample,
      item,
    );
  const own = run ? run.snapshot.measurement : item.measurement;
  return {
    mode: group.mode,
    protocol: group.protocol ?? '',
    technique: own?.technique ?? '',
    regime: own?.regime ?? '',
    batch: own?.batch ?? '',
    customName: own?.customName ?? '',
  };
}

export function measurementSummary(value: MeasurementPlan) {
  return [
    value.mode === 'In situ' ? '原位' : value.mode === 'Ex situ' ? '离位' : '方式未定',
    value.technique,
    regimeLabel(value.regime),
    value.batch && `批次 ${value.batch}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function measurementName(
  experiment: Experiment,
  group: Group,
  sample: Sample,
  item: PlanItem,
  number: number,
) {
  const measurement = item.measurement;
  if (measurement?.customName?.trim()) {
    const name = measurement.customName.trim();
    // Validate literal names without interpreting braces as placeholders.
    if (/[{}]/.test(name)) throw new Error('临时名称不能包含命名占位符。');
    return filenameFor(name, experiment.code, sample.code, number);
  }
  return filenameFor(experiment.namingPattern, experiment.code, sample.code, number, {
    material: group.material?.trim() || group.name?.trim() || '',
    state: group.state === '未指定' ? '' : group.state,
    mode: group.mode === 'In situ' ? 'IS' : group.mode === 'Ex situ' ? 'ES' : '',
    technique: measurement?.technique || '',
    regime: measurement?.regime || '',
    batch: measurement?.batch || '',
  });
}

export function uniqueName(name: string, taken: Set<string>, marker = '') {
  let result = name,
    suffix = 1;
  while (taken.has(result.toLowerCase())) {
    const tail = `_${marker}${String(++suffix).padStart(2, '0')}`;
    result = name.slice(0, 200 - tail.length) + tail;
  }
  taken.add(result.toLowerCase());
  return result;
}

function keepsReservedName(kept: string, candidate: string, marker: string) {
  const current = kept.toLowerCase();
  const base = candidate.toLowerCase();
  if (current === base) return true;
  const prefix = `${base}_${marker.toLowerCase()}`;
  return current.startsWith(prefix) && /^\d{2,}$/.test(current.slice(prefix.length));
}

// Used both by dialog previews and the transaction that reserves the same names.
export function reserveMeasurementNames(
  snapshot: Snapshot,
  experimentId: string,
  targets: PlanItem[],
): PlanItem[] {
  const experiment = snapshot.experiments.find((entry) => entry.id === experimentId)!;
  const ids = new Set(targets.map((entry) => entry.id));
  const taken = new Set([
    ...snapshot.runs.map((entry) => entry.filename.toLowerCase()),
    ...snapshot.items
      .filter((entry) => !ids.has(entry.id) && entry.plannedName)
      .map((entry) => entry.plannedName!.toLowerCase()),
  ]);
  let next = Math.max(
    0,
    ...snapshot.items
      .filter((entry) => entry.experimentId === experimentId)
      .map((entry) => entry.nameNumber ?? 0),
    ...snapshot.runs
      .filter((entry) => entry.experimentId === experimentId)
      .map((entry) => entry.number),
  );
  const marker = /\{run(?::0[1-9])?\}/.test(experiment.namingPattern) ? '' : 'M';
  // New plan numbers follow queue order. Existing numbers stay put, so a later reorder cannot renumber them.
  const prepared = [...targets]
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const nameNumber = item.nameNumber ?? ++next;
      const sample = snapshot.samples.find((entry) => entry.id === item.sampleId)!;
      const group = plannedGroup(
        snapshot.groups.find((entry) => entry.id === sample.groupId)!,
        sample,
        { ...item, nameNumber },
      );
      return {
        item: { ...item, nameNumber },
        candidate: measurementName(experiment, group, sample, { ...item, nameNumber }, nameNumber),
      };
    });
  const planned = new Map<string, string>();
  for (const { item, candidate } of prepared) {
    if (!item.measurement?.customName?.trim()) continue;
    if (taken.has(candidate.toLowerCase()))
      throw new Error(`临时名称“${candidate}”已被其他操作使用，请换一个名称。`);
    taken.add(candidate.toLowerCase());
    planned.set(item.id, candidate);
  }
  const pending: typeof prepared = [];
  for (const entry of prepared) {
    if (planned.has(entry.item.id)) continue;
    const kept = entry.item.plannedName;
    if (
      kept &&
      keepsReservedName(kept, entry.candidate, marker) &&
      !taken.has(kept.toLowerCase())
    ) {
      taken.add(kept.toLowerCase());
      planned.set(entry.item.id, kept);
      continue;
    }
    pending.push(entry);
  }
  for (const { item, candidate } of pending.sort(
    (a, b) => a.item.nameNumber! - b.item.nameNumber! || a.item.order - b.item.order,
  ))
    planned.set(item.id, uniqueName(candidate, taken, marker));
  return prepared.map(({ item }) => ({ ...item, plannedName: planned.get(item.id)! }));
}
