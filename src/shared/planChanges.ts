import type { PlanItem, Run, Snapshot } from './model.js';
import { MODE_LABEL, filledSize } from './model.js';
import { materialSummary } from './materials.js';
import { plannedGroup } from './measurement.js';

export interface PlanChange {
  label: string;
  planned: string;
  actual: string;
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

function modeLabel(value: string) {
  if (value === 'In situ' || value === 'Ex situ' || value === '未定') return MODE_LABEL[value];
  return value;
}

/** Differences between the start snapshot and later actual edits. Absent keys are not treated as changes. */
export function startedPlanChanges(run: Run): PlanChange[] {
  const planned = run.snapshot.group;
  const changes: PlanChange[] = [];
  const push = (label: string, plannedValue: string, actualValue: string) => {
    if (plannedValue === actualValue) return;
    changes.push({ label, planned: shown(plannedValue), actual: shown(actualValue) });
  };

  if (run.actualSample) {
    push('样品名', text(planned.name), text(run.actualSample.name));
    push(
      '宽度',
      measure(planned.width, planned.dimensionUnit),
      measure(run.actualSample.width, run.actualSample.dimensionUnit),
    );
    push(
      '高度',
      measure(planned.height, planned.dimensionUnit),
      measure(run.actualSample.height, run.actualSample.dimensionUnit),
    );
  }
  if (hasOwn(run.actual, 'thickness') || hasOwn(run.actual, 'thicknessUnit'))
    push(
      '厚度',
      measure(planned.thickness, planned.thicknessUnit),
      measure(run.actual.thickness, run.actual.thicknessUnit),
    );
  if (hasOwn(run.actual, 'protocol'))
    push('实验制度', text(planned.protocol), text(run.actual.protocol));
  if (hasOwn(run.actual, 'mode'))
    push('实验方式', modeLabel(text(planned.mode)), modeLabel(text(run.actual.mode)));
  if (hasOwn(run.actual, 'preparation'))
    push('制备/试剂', text(planned.preparation), text(run.actual.preparation));

  for (const field of run.snapshot.fields) {
    if (ACTUAL_REFERENCES.has(field.id) || !hasOwn(run.actual, field.id)) continue;
    const plannedValue = run.snapshot.sample.values[field.id] ?? planned.values[field.id];
    push(field.label, text(plannedValue), text(run.actual[field.id]));
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
    .map((change) => `${change.label}：${change.planned} → ${change.actual}`)
    .join('\n');
}

const RECORDED_SEARCH_LABELS = new Set(['样品名', '实验方式', '制备/试剂']);

/** Search text for recorded name, mode, and preparation. Notes, file references, and custom values stay out. */
export function recordedPlanSearchText(run: Run | undefined | null) {
  if (!run) return '';
  return startedPlanChanges(run)
    .filter((change) => RECORDED_SEARCH_LABELS.has(change.label))
    .map((change) => `${change.label}：${change.planned} → ${change.actual}`)
    .join(' ');
}

const SIZE_LABELS = new Set(['厚度', '宽度', '高度']);

/** Plan size, or both actual and plan sizes when a recorded side differs. */
export function operationSizeLine(
  group: Parameters<typeof filledSize>[0],
  run?: Run | null,
) {
  const planned = filledSize(group);
  if (!run) return planned;
  const changed = new Set(
    startedPlanChanges(run)
      .map((change) => change.label)
      .filter((label) => SIZE_LABELS.has(label)),
  );
  if (!changed.size) return planned;
  const actual = filledSize({
    thickness: changed.has('厚度') ? text(run.actual.thickness) : group.thickness,
    thicknessUnit: changed.has('厚度') ? text(run.actual.thicknessUnit) : group.thicknessUnit,
    width: changed.has('宽度') ? text(run.actualSample?.width) : group.width,
    height: changed.has('高度') ? text(run.actualSample?.height) : group.height,
    dimensionUnit:
      changed.has('宽度') || changed.has('高度')
        ? text(run.actualSample?.dimensionUnit)
        : group.dimensionUnit,
  });
  return `实际 ${actual || '尺寸未填'} · 计划 ${planned || '尺寸未填'}`;
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
  const change = startedPlanChanges(run).find((entry) => entry.label === '实验制度');
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
