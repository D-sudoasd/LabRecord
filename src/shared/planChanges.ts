import type { ActualSourceField, PlanItem, Run, Snapshot, Value, Values } from './model.js';
import { MODE_LABEL, filledSize } from './model.js';
import { materialSummary } from './materials.js';
import { plannedGroup } from './measurement.js';

export interface PlanChange {
  /** A custom field can have the same visible label as a built-in field. */
  source: 'builtin' | 'custom';
  key: string;
  label: string;
  planned: string;
  actual: string;
}

const BUILTIN_CHANGE_LABELS = new Set([
  '样品名',
  '样品状态',
  '宽度',
  '高度',
  '厚度',
  '宽高单位',
  '厚度单位',
  '实验制度',
  '实验方式',
  '制备/试剂',
]);

/** Disambiguate an explicitly named custom field only when its label collides. */
export function planChangeLabel(change: Pick<PlanChange, 'source' | 'label'>) {
  return change.source === 'custom' && BUILTIN_CHANGE_LABELS.has(change.label)
    ? `${change.label}（自定义）`
    : change.label;
}

const ACTUAL_REFERENCES = new Set(['filename', 'scanId', 'files']);

function text(value: unknown) {
  if (value == null) return '';
  return String(value).trim();
}

function shown(value: string) {
  return value || '未填写';
}

function measure(value: unknown, unit: unknown) {
  const number = text(value);
  if (!number) return '';
  const suffix = text(unit);
  return suffix ? `${number} ${suffix}` : number;
}

function hasOwn(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Preserve the difference between an absent field, a legacy blank and a deliberate edit. */
export function actualFieldSource(run: Run | undefined | null, field: ActualSourceField | undefined) {
  if (!run) return '';
  if (!field) return '未记录';
  const [section, key] = field.split('.') as ['actual' | 'actualSample', string];
  const values = section === 'actualSample' ? run.actualSample : run.actual;
  if (!values || !hasOwn(values, key)) return '未记录';
  const value = (values as Record<string, unknown>)[key];
  const source = run.actualSources?.[field];
  if (source === 'planned') return '开始时按计划初始化';
  if (source === 'edited') {
    if (value === null) return '用户更正（明确空值）';
    return value === '' ? '用户更正（已清空）' : '用户更正';
  }
  return value === '' || value === null || value === undefined
    ? '旧版空值（含义不明）'
    : '旧版记录（来源不明）';
}

/** A saved group name is not automatically a per-specimen original identifier. */
export function actualSpecimenNameField(run: Run | undefined | null): ActualSourceField | undefined {
  const actual = run?.actualSample;
  if (!run || !actual) return undefined;
  if (hasOwn(actual, 'specimenName')) return 'actualSample.specimenName';
  if (!hasOwn(actual, 'name')) return undefined;
  if (run.actualSources?.['actualSample.name'] === 'edited') return 'actualSample.name';
  // An older saved empty name is evidence of an ambiguous blank, even when
  // the start-time group name is also empty; it is not an absent field.
  if (run.actualSources?.['actualSample.name'] === 'legacy' && actual.name === '')
    return 'actualSample.name';
  if ((actual.name ?? '') !== (run.snapshot.group.name ?? '')) return 'actualSample.name';
  const specimen = run.snapshot.sample.parameters;
  return hasOwn(specimen, 'name') && specimen.name === actual.name
    ? 'actualSample.name'
    : undefined;
}

export function actualSpecimenName(run: Run | undefined | null): string | undefined {
  const field = actualSpecimenNameField(run);
  if (field === 'actualSample.specimenName') return run?.actualSample?.specimenName ?? '';
  if (field === 'actualSample.name') return run?.actualSample?.name ?? '';
  return undefined;
}

/** An explicitly empty specimen value overrides the group, just as it does at run start. */
export function plannedCustomFieldValue(
  sampleValues: Values,
  groupValues: Values,
  fieldId: string,
): Value | undefined {
  if (hasOwn(sampleValues, fieldId)) return sampleValues[fieldId];
  if (hasOwn(groupValues, fieldId)) return groupValues[fieldId];
  return undefined;
}

function modeLabel(value: string) {
  if (value === 'In situ' || value === 'Ex situ' || value === '未定') return MODE_LABEL[value];
  return value;
}

/** Differences between the start snapshot and later actual edits. Absent keys are not treated as changes. */
export function startedPlanChanges(run: Run): PlanChange[] {
  const planned = run.snapshot.group;
  const changes: PlanChange[] = [];
  const push = (
    key: string,
    label: string,
    plannedValue: string,
    actualValue: string,
    source: PlanChange['source'] = 'builtin',
    actualField?: ActualSourceField,
  ) => {
    if (plannedValue === actualValue) return;
    // An old blank records no evidence that a value was intentionally cleared.
    if (actualField && !actualValue && actualFieldSource(run, actualField) === '旧版空值（含义不明）')
      return;
    const actual = shown(actualValue);
    changes.push({ source, key, label, planned: shown(plannedValue), actual });
  };
  const pushSize = (
    key: string,
    label: string,
    plannedValue: unknown,
    plannedUnit: unknown,
    actualValue: unknown,
    actualUnit: unknown,
    actualField: ActualSourceField,
  ) => {
    // A number without either unit cannot be compared to a dimensional value.
    if (text(plannedValue) && text(actualValue) && (!text(plannedUnit) || !text(actualUnit))) return;
    push(key, label, measure(plannedValue, plannedUnit), measure(actualValue, actualUnit), 'builtin', actualField);
  };

  if (run.actualSample) {
    if (hasOwn(run.actualSample, 'specimenName'))
      push(
        'name',
        '样品名',
        text(run.snapshot.sample.parameters.name),
        text(run.actualSample.specimenName),
        'builtin',
        'actualSample.specimenName',
      );
    else if (hasOwn(run.actualSample, 'name'))
      push(
        'name',
        '样品名',
        text(planned.name),
        text(run.actualSample.name),
        'builtin',
        'actualSample.name',
      );
    if (hasOwn(run.actualSample, 'state'))
      push('state', '样品状态', text(planned.state), text(run.actualSample.state), 'builtin', 'actualSample.state');
    if (hasOwn(run.actualSample, 'width'))
      pushSize('width', '宽度', planned.width, planned.dimensionUnit,
        run.actualSample.width, run.actualSample.dimensionUnit, 'actualSample.width');
    if (hasOwn(run.actualSample, 'height'))
      pushSize('height', '高度', planned.height, planned.dimensionUnit,
        run.actualSample.height, run.actualSample.dimensionUnit, 'actualSample.height');
    if (hasOwn(run.actualSample, 'dimensionUnit') &&
        ((!hasOwn(run.actualSample, 'width') && !hasOwn(run.actualSample, 'height')) ||
          (!text(run.actualSample.dimensionUnit) &&
            run.actualSources?.['actualSample.dimensionUnit'] === 'edited')))
      push('dimensionUnit', '宽高单位', text(planned.dimensionUnit), text(run.actualSample.dimensionUnit),
        'builtin', 'actualSample.dimensionUnit');
  }
  if (hasOwn(run.actual, 'thickness'))
    pushSize(
      'thickness',
      '厚度',
      planned.thickness,
      planned.thicknessUnit,
      run.actual.thickness,
      run.actual.thicknessUnit,
      'actual.thickness',
    );
  if (hasOwn(run.actual, 'thicknessUnit') && (!hasOwn(run.actual, 'thickness') ||
      (!text(run.actual.thicknessUnit) && run.actualSources?.['actual.thicknessUnit'] === 'edited')))
    push('thicknessUnit', '厚度单位', text(planned.thicknessUnit), text(run.actual.thicknessUnit),
      'builtin', 'actual.thicknessUnit');
  if (hasOwn(run.actual, 'protocol'))
    push('protocol', '实验制度', text(planned.protocol), text(run.actual.protocol));
  if (hasOwn(run.actual, 'mode'))
    push('mode', '实验方式', modeLabel(text(planned.mode)), modeLabel(text(run.actual.mode)));
  if (hasOwn(run.actual, 'preparation'))
    push('preparation', '制备/试剂', text(planned.preparation), text(run.actual.preparation));

  for (const field of run.snapshot.fields) {
    if (ACTUAL_REFERENCES.has(field.id) || !hasOwn(run.actual, field.id)) continue;
    const plannedValue = plannedCustomFieldValue(
      run.snapshot.sample.values,
      planned.values,
      field.id,
    );
    push(field.id, field.label, text(plannedValue), text(run.actual[field.id]), 'custom');
  }
  return changes;
}

/** A started run whose recorded plan fields differ from its snapshot. Notes and file references do not count. */
export function recordedPlanDiffers(run: Run | undefined | null) {
  return !!run && startedPlanChanges(run).length > 0;
}

/** How many started runs in one experiment differ from their snapshots. */
export function recordedPlanChangeCount(snapshot: Snapshot, experimentId: string) {
  return snapshot.runs.filter(
    (run) => run.experimentId === experimentId && recordedPlanDiffers(run),
  ).length;
}

/** Export text for those differences. Empty when the run is absent or unchanged. */
export function recordedPlanChangeText(run: Run | undefined | null) {
  if (!run) return '';
  return startedPlanChanges(run)
    .map((change) => `${planChangeLabel(change)}：${change.planned} → ${change.actual}`)
    .join('\n');
}

const RECORDED_SEARCH_KEYS = new Set(['name', 'state', 'mode', 'preparation']);

/** Search recorded identity, mode, and preparation without notes, references, or custom values. */
export function recordedPlanSearchText(run: Run | undefined | null) {
  if (!run) return '';
  return startedPlanChanges(run)
    .filter((change) => change.source === 'builtin' && RECORDED_SEARCH_KEYS.has(change.key))
    .map((change) => `${change.label}：${change.planned} → ${change.actual}`)
    .join(' ');
}

const SIZE_KEYS = new Set(['thickness', 'width', 'height']);

/** Plan size, or both actual and plan sizes when a recorded side differs. */
export function operationSizeLine(group: Parameters<typeof filledSize>[0], run?: Run | null) {
  const planned = filledSize(group);
  if (!run) return planned;
  const changed = new Set(
    startedPlanChanges(run)
      .filter((change) => change.source === 'builtin' && SIZE_KEYS.has(change.key))
      .map((change) => change.key),
  );
  const sample = run.actualSample ?? {};
  const actual = [
    ['厚', run.actual.thickness, run.actual.thicknessUnit],
    ['宽', sample.width, sample.dimensionUnit],
    ['高', sample.height, sample.dimensionUnit],
  ].flatMap(([label, value, unit]) => text(value)
    ? [`${label} ${text(value)}${text(unit) ? ` ${text(unit)}` : '（单位未记录）'}`]
    : []).join(' · ');
  const blanks = ([
    ['厚', 'actual.thickness'],
    ['宽', 'actualSample.width'],
    ['高', 'actualSample.height'],
  ] as const).flatMap(([label, field]) => {
    const source = actualFieldSource(run, field);
    if (source === '旧版空值（含义不明）') return [`${label} ${source}`];
    if (source === '用户更正（已清空）') return [`${label} 已清空`];
    if (source === '用户更正（明确空值）') return [`${label} 明确空值`];
    return [];
  });
  const actualDisplay = [actual, ...blanks].filter(Boolean).join(' · ');
  if (!changed.size) {
    const missingPlanned = (text(group.thickness) && !hasOwn(run.actual, 'thickness')) ||
      (text(group.width) && !hasOwn(sample, 'width')) ||
      (text(group.height) && !hasOwn(sample, 'height'));
    const missingUnits = (text(group.thickness) && text(run.actual.thickness) &&
        (!text(group.thicknessUnit) || !text(run.actual.thicknessUnit))) ||
      ((text(group.width) && text(sample.width) || text(group.height) && text(sample.height)) &&
        (!text(group.dimensionUnit) || !text(sample.dimensionUnit)));
    if (actualDisplay && (missingUnits || blanks.length))
      return `实际 ${actualDisplay} · 开始时 ${planned || '尺寸未填'}`;
    return missingPlanned && planned ? `开始时 ${planned}` : planned;
  }
  return `实际 ${actualDisplay || '尺寸未填'} · 计划 ${planned || '尺寸未填'}`;
}

/** How the current plan moved after a run started. Notes are ignored. */
export function laterPlanDrift(
  frozen: Parameters<typeof filledSize>[0] &
    Parameters<typeof materialSummary>[0] & { protocol?: string },
  current: Parameters<typeof filledSize>[0] &
    Parameters<typeof materialSummary>[0] & { protocol?: string },
) {
  const parts: string[] = [];
  const frozenSize = filledSize(frozen);
  const currentSize = filledSize(current);
  if (frozenSize !== currentSize) parts.push(currentSize ? `尺寸 ${currentSize}` : '尺寸已清空');
  const frozenMaterial = materialSummary(frozen);
  const currentMaterial = materialSummary(current);
  if (frozenMaterial !== currentMaterial) parts.push(currentMaterial || '制备已清空');
  const protocol = (value: { protocol?: string }) => (value.protocol || '').trim();
  if (protocol(frozen) !== protocol(current))
    parts.push(protocol(current) ? `实验制度 ${protocol(current)}` : '实验制度已清空');
  return parts.join(' · ');
}

/** Actual protocol when it differs from the start snapshot. Notes are not included. */
export function actualProtocolLabel(run: Run | undefined | null) {
  if (!run) return '';
  const change = startedPlanChanges(run).find(
    (entry) => entry.source === 'builtin' && entry.key === 'protocol',
  );
  if (!change) return '';
  const planned = text(run.snapshot.group.protocol);
  return planned ? `实际制度 ${change.actual} · 开始时 ${planned}` : `实际制度 ${change.actual}`;
}

/** Current plan versus the snapshot captured when the run started. Pending items have none. */
export function operationPlanDrift(snapshot: Snapshot, item: PlanItem) {
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  if (!run) return '';
  const liveSample = snapshot.samples.find((entry) => entry.id === item.sampleId);
  const liveGroup = liveSample && snapshot.groups.find((entry) => entry.id === liveSample.groupId);
  if (!liveSample || !liveGroup) return '';
  return laterPlanDrift(run.snapshot.group, plannedGroup(liveGroup, liveSample, item));
}
