import type { Experiment, Group, MeasurementPlan, PlanItem, Sample, Snapshot } from './model.js';
import { effectiveNotes, effectiveProtocol, FIELD_PATTERN, filenameFor } from './model.js';

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
    notes: effectiveNotes(group, sample.parameters),
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

/** Heating protocol for one operation. A started run keeps the snapshot text. */
export function operationProtocolLabel(snapshot: Snapshot, item: PlanItem) {
  const protocol = measurementFor(snapshot, item).protocol?.trim() || '';
  return protocol ? `实验制度 ${protocol}` : '';
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
  if (experiment.namingPattern === FIELD_PATTERN) validateFieldSampleCode(sample.code);
  return filenameFor(experiment.namingPattern, experiment.code, sample.code, number, {
    material: group.material?.trim() || group.name?.trim() || '',
    state: group.state === '未指定' ? '' : group.state,
    mode: group.mode === 'In situ' ? 'IS' : group.mode === 'Ex situ' ? 'ES' : '',
    technique: measurement?.technique || '',
    regime: measurement?.regime || '',
    batch: measurement?.batch || '',
  });
}

export function validateFieldSampleCode(code: string) {
  if (/[{}]/.test(code) || filenameFor(FIELD_PATTERN, '', code, 1) !== code)
    throw new Error('简写编号必须能直接用作 Windows 文件夹名，不能包含空格或特殊字符。');
}

/** A numeric suffix denotes a later measurement, so it cannot name another specimen. */
function shortNameAncestors(name: string) {
  const ancestors: string[] = [];
  let current = name.toLowerCase();
  while (/-\d+$/.test(current)) {
    current = current.slice(0, current.lastIndexOf('-'));
    ancestors.push(current);
  }
  return ancestors;
}

type ShortNameOwner = { name: string; sampleId: string | symbol };

function fieldNameIndex(snapshot: Snapshot, experimentId: string, excludeSampleId?: string) {
  const exact = new Map<string, ShortNameOwner[]>();
  const descendants = new Map<string, ShortNameOwner[]>();
  const append = (index: Map<string, ShortNameOwner[]>, key: string, owner: ShortNameOwner) => {
    const entries = index.get(key);
    if (entries) entries.push(owner);
    else index.set(key, [owner]);
  };
  const add = (name: string | undefined, sampleId: string | symbol) => {
    if (!name || sampleId === excludeSampleId) return;
    const owner = { name, sampleId };
    append(exact, name.toLowerCase(), owner);
    for (const ancestor of shortNameAncestors(name)) append(descendants, ancestor, owner);
  };
  for (const sample of snapshot.samples)
    if (sample.experimentId === experimentId) add(sample.code, sample.id);
  for (const item of snapshot.items)
    if (item.experimentId === experimentId) add(item.plannedName, item.sampleId);
  for (const run of snapshot.runs)
    if (run.experimentId === experimentId) add(run.filename, run.sampleId);
  const conflict = (name: string, sampleId: string | symbol) => {
    const normalized = name.toLowerCase();
    for (const key of [normalized, ...shortNameAncestors(normalized)]) {
      const found = exact.get(key)?.find((entry) => entry.sampleId !== sampleId);
      if (found) return found;
    }
    return descendants.get(normalized)?.find((entry) => entry.sampleId !== sampleId);
  };
  return { add, conflict };
}

function rejectFieldNameConflict(name: string, other: ShortNameOwner) {
  throw new Error(
    `编号或文件夹名“${name}”与其他样品的“${other.name}”可能混淆为同一样品的不同测量，请换一个编号或名称。`,
  );
}

/** Check new specimen codes against the same experiment's existing code and folder namespaces. */
export function validateFieldSampleCodes(
  snapshot: Snapshot,
  experimentId: string,
  codes: readonly string[],
  excludeSampleId?: string,
) {
  const experiment = snapshot.experiments.find((entry) => entry.id === experimentId);
  if (experiment?.namingPattern !== FIELD_PATTERN) return;
  const index = fieldNameIndex(snapshot, experimentId, excludeSampleId);
  codes.forEach((code) => {
    validateFieldSampleCode(code);
    const proposedOwner = Symbol('proposed specimen');
    const other = index.conflict(code, proposedOwner);
    if (other) rejectFieldNameConflict(code, other);
    index.add(code, proposedOwner);
  });
}

export function uniqueName(name: string, taken: Set<string>, marker = '', compact = false) {
  let result = name,
    suffix = 1;
  while (taken.has(result.toLowerCase())) {
    const tail = compact ? `-${++suffix}` : `_${marker}${String(++suffix).padStart(2, '0')}`;
    if (compact && name.length + tail.length > 200)
      throw new Error('简写编号太长，无法保留完整编号并为后续测量添加序号。');
    result = name.slice(0, 200 - tail.length) + tail;
  }
  taken.add(result.toLowerCase());
  return result;
}

const RUN_TOKEN = /\{run(?::0[1-9])?\}/;

export function folderNameNote(pattern: string, sampleCode: string, name?: string) {
  if (!name) return '保存后可复制到数据文件夹';
  if (RUN_TOKEN.test(pattern)) {
    const serial = name.match(/_(\d+)$/);
    return serial
      ? `计划序号 ${serial[1]}，按本实验全部计划连号，不是样品编号`
      : '名称中的数字是计划序号，不是样品编号';
  }
  const legacy = name.match(/_(\d{3,})$/);
  if (legacy) return `旧的全表序号 ${legacy[1]}，已经开始的名称保持不变`;
  const repeat = name.match(/_(?:M)?(\d{2})$/);
  if (repeat) return `样品 ${sampleCode} 的第 ${Number(repeat[1])} 次测量`;
  if (pattern === FIELD_PATTERN && name.startsWith(`${sampleCode}-`)) {
    const suffix = name.slice(sampleCode.length + 1);
    if (/^\d+$/.test(suffix) && Number(suffix) >= 2)
      return `样品 ${sampleCode} 的第 ${suffix} 次测量`;
  }
  return `样品 ${sampleCode}`;
}

// Used both by dialog previews and the transaction that reserves the same names.
export function reserveMeasurementNames(
  snapshot: Snapshot,
  experimentId: string,
  targets: PlanItem[],
): PlanItem[] {
  const experiment = snapshot.experiments.find((entry) => entry.id === experimentId)!;
  const fieldNames =
    experiment.namingPattern === FIELD_PATTERN ? fieldNameIndex(snapshot, experimentId) : undefined;
  const ids = new Set(targets.map((entry) => entry.id));
  const taken = new Set([
    ...snapshot.runs
      .filter((entry) => entry.experimentId === experimentId)
      .map((entry) => entry.filename.toLowerCase()),
    ...snapshot.items
      .filter(
        (entry) => entry.experimentId === experimentId && !ids.has(entry.id) && entry.plannedName,
      )
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
  const marker = '';
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
        sample,
        group,
      };
    });
  const planned = new Map<string, string>();
  for (const { item, sample, group } of prepared) {
    if (!item.measurement?.customName?.trim()) continue;
    const candidate = measurementName(experiment, group, sample, item, item.nameNumber!);
    if (taken.has(candidate.toLowerCase()))
      throw new Error(`临时名称“${candidate}”已被其他操作使用，请换一个名称。`);
    if (fieldNames && candidate.toLowerCase() !== item.plannedName?.toLowerCase()) {
      const other = fieldNames.conflict(candidate, sample.id);
      if (other) rejectFieldNameConflict(candidate, other);
    }
    taken.add(candidate.toLowerCase());
    fieldNames?.add(candidate, sample.id);
    planned.set(item.id, candidate);
  }
  const pending: typeof prepared = [];
  for (const entry of prepared) {
    if (planned.has(entry.item.id)) continue;
    const kept = entry.item.plannedName;
    if (kept && !taken.has(kept.toLowerCase())) {
      taken.add(kept.toLowerCase());
      planned.set(entry.item.id, kept);
      continue;
    }
    if (kept) throw new Error(`计划名称“${kept}”已被其他操作使用。`);
    pending.push(entry);
  }
  for (const { item, sample, group } of pending.sort(
    (a, b) => a.item.nameNumber! - b.item.nameNumber! || a.item.order - b.item.order,
  )) {
    const candidate = measurementName(experiment, group, sample, item, item.nameNumber!);
    if (fieldNames) {
      const other = fieldNames.conflict(sample.code, sample.id);
      if (other) rejectFieldNameConflict(sample.code, other);
    }
    const name = uniqueName(candidate, taken, marker, experiment.namingPattern === FIELD_PATTERN);
    const other = fieldNames?.conflict(name, sample.id);
    if (other) rejectFieldNameConflict(name, other);
    fieldNames?.add(name, sample.id);
    planned.set(item.id, name);
  }
  return prepared.map(({ item }) => ({ ...item, plannedName: planned.get(item.id)! }));
}

/** Preview the same pending-name reservation that the store will commit on an explicit code edit. */
export function previewSampleCodeChange(snapshot: Snapshot, sampleId: string, rawCode: string) {
  const sample = snapshot.samples.find((entry) => entry.id === sampleId);
  if (!sample) throw new Error('样品不存在，请刷新后重试。');
  const code = rawCode.trim();
  if (!code) throw new Error('请填写样品编号。');
  if (code === sample.code) return [];
  const experiment = snapshot.experiments.find((entry) => entry.id === sample.experimentId)!;
  if (experiment.namingPattern === FIELD_PATTERN) {
    if (snapshot.runs.some((run) => run.sampleId === sample.id))
      throw new Error('该样品已有已开始的测量，基础编号不能更改。');
    validateFieldSampleCode(code);
  }
  if (
    snapshot.samples.some(
      (entry) =>
        entry.id !== sample.id &&
        entry.experimentId === sample.experimentId &&
        entry.code.toLowerCase() === code.toLowerCase(),
    )
  )
    throw new Error(`样品编号“${code}”在本实验中已存在。`);
  validateFieldSampleCodes(snapshot, sample.experimentId, [code], sample.id);
  const recorded = new Set(snapshot.runs.map((run) => run.itemId));
  const targets = snapshot.items
    .filter(
      (item) =>
        item.sampleId === sample.id &&
        !recorded.has(item.id) &&
        ['pending', 'skipped'].includes(item.status),
    )
    .map((item) =>
      item.measurement?.customName?.trim() ? item : { ...item, plannedName: undefined },
    );
  const changed = {
    ...snapshot,
    samples: snapshot.samples.map((entry) => (entry.id === sample.id ? { ...entry, code } : entry)),
  };
  const reserved = reserveMeasurementNames(changed, sample.experimentId, targets);
  return reserved.map((item) => ({
    itemId: item.id,
    oldName: snapshot.items.find((entry) => entry.id === item.id)?.plannedName ?? '',
    newName: item.plannedName ?? '',
  }));
}
