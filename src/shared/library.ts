import type { PlanItem, Snapshot } from './model.js';
import { reportInsights } from './summary.js';
import { followUpRoster, itemOpenIssueLabel } from './followUps.js';
import { recordedPlanChangeCount } from './planChanges.js';
import { measurementFor, plannedGroup, regimeLabel, measurementSummary } from './measurement.js';
import { repeatSourceIssueLabel, repeatSourceLabel } from './repeats.js';
import { formatRecordedDuration, recordedDuration, runDurationLabel } from './duration.js';
import { recordedEndLabel, recordedStartLabel } from './recordedTime.js';
import { actualFilenameLabel, actualScanLabel } from './copyText.js';

export interface QueueTarget {
  itemId: string;
  sampleCode: string;
  operation: string;
  plannedName: string;
}

export interface LibraryCard {
  experimentId: string;
  name: string;
  code: string;
  description: string;
  groupCount: number;
  preparedKnown: number;
  unknownPreparation: number;
  plannedSamples: number;
  plannedOperations: number;
  spareKnown: number;
  completed: number;
  pending: number;
  running: number;
  skipped: number;
  interrupted: number;
  repeats: number;
  unresolvedIssues: number;
  missingTimes: number;
  missingFiles: number;
  recordedLabel: string;
  incompleteCount: number;
  actualChanged: number;
  next: QueueTarget | null;
  runningItem: QueueTarget | null;
  recent: LatestRecorded | null;
}

export interface BoardAction {
  key: string;
  kind: 'open' | 'running' | 'next' | 'recent' | 'check';
  experimentId: string;
  itemId: string;
  title: string;
  detail: string;
}

/** Known subtotal. A wholly unknown preparation stays「未知」and is not shown as zero. */
export function knownQuantity(known: number, unknownGroups: number, groupCount: number) {
  if (groupCount > 0 && unknownGroups === groupCount) return '未知';
  return String(known);
}

function orderedItems(snapshot: Snapshot, experimentId: string) {
  return snapshot.items
    .filter((item) => item.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
}

function targetFor(snapshot: Snapshot, item: PlanItem): QueueTarget {
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  const sample = snapshot.samples.find((entry) => entry.id === item.sampleId);
  return {
    itemId: item.id,
    sampleCode: run?.snapshot.sample.code || sample?.code || '',
    operation: item.operation,
    plannedName: run?.filename || item.plannedName || '',
  };
}

/** First pending item in the full queue order. Does not create a run or invent a time. */
export function nextPending(snapshot: Snapshot, experimentId: string): QueueTarget | null {
  const item = orderedItems(snapshot, experimentId).find((entry) => entry.status === 'pending');
  return item ? targetFor(snapshot, item) : null;
}

export interface NextOperationBrief {
  itemId: string;
  sampleCode: string;
  folder: string;
  measurement: string;
  preparation: string;
  protocol: string;
  repeat: string;
  sourceIssue: string;
}

/** What the next pending operation is, from the full order. Does not start it or read notes. */
export function nextOperationBrief(
  snapshot: Snapshot,
  experimentId: string,
): NextOperationBrief | null {
  const item = orderedItems(snapshot, experimentId).find((entry) => entry.status === 'pending');
  if (!item) return null;
  const sample = snapshot.samples.find((entry) => entry.id === item.sampleId);
  const stored = sample && snapshot.groups.find((entry) => entry.id === sample.groupId);
  if (!sample || !stored) return null;
  const group = plannedGroup(stored, sample, item);
  const measurement = measurementFor(snapshot, item);
  const thickness = group.thickness?.trim()
    ? [group.thickness.trim(), group.thicknessUnit?.trim()].filter(Boolean).join(' ')
    : '';
  const source = repeatSourceLabel(snapshot, item);
  return {
    itemId: item.id,
    sampleCode: sample.code,
    folder: item.plannedName || '',
    measurement: [
      measurement.mode === 'In situ' ? '原位' : measurement.mode === 'Ex situ' ? '离位' : '',
      measurement.technique?.trim(),
      measurement.regime?.trim() ? regimeLabel(measurement.regime) : '',
      measurement.batch?.trim() ? `批次 ${measurement.batch.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    preparation: [group.material?.trim(), group.state?.trim(), thickness].filter(Boolean).join(' · '),
    protocol: group.protocol?.trim() || '',
    repeat: source ? `重测自 ${source}` : '',
    sourceIssue: repeatSourceIssueLabel(snapshot, item),
  };
}

export interface LatestRecorded {
  itemId: string;
  sampleCode: string;
  folder: string;
  scanId: string;
  filename: string;
  fileLabel: string;
  duration: string;
  endedClock: string;
  status: PlanItem['status'];
  openIssue: string;
}

/** Most recently ended run in this experiment. Does not invent a time or read notes. */
export function latestRecorded(snapshot: Snapshot, experimentId: string): LatestRecorded | null {
  const run = snapshot.runs
    .filter((entry) => entry.experimentId === experimentId && entry.endedAt)
    .sort((a, b) => (a.endedAt! < b.endedAt! ? 1 : a.endedAt! > b.endedAt! ? -1 : 0))[0];
  if (!run?.endedAt) return null;
  const item = snapshot.items.find((entry) => entry.id === run.itemId);
  if (!item) return null;
  return {
    itemId: run.itemId,
    sampleCode: run.snapshot.sample.code,
    folder: run.filename,
    scanId: String(run.actual.scanId || ''),
    filename: String(run.actual.filename || '').trim(),
    fileLabel: actualFilenameLabel(run),
    duration: runDurationLabel(run),
    endedClock: recordedEndLabel(run),
    status: item.status,
    openIssue: itemOpenIssueLabel(snapshot, run.itemId),
  };
}

/** Mark for the single most recently ended operation. Empty on every other row. */
export function latestEndedMark(snapshot: Snapshot, itemId: string) {
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item) return '';
  const recent = latestRecorded(snapshot, item.experimentId);
  if (!recent || recent.itemId !== itemId) return '';
  if (recent.status === 'completed') return '最近完成';
  if (recent.status === 'interrupted') return '最近中断';
  return '';
}

/** One report sentence for that operation. Notes, issues and earlier wording stay out. */
export function latestEndedSummary(snapshot: Snapshot, experimentId: string) {
  const recent = latestRecorded(snapshot, experimentId);
  const mark = recent ? latestEndedMark(snapshot, recent.itemId) : '';
  if (!recent || !mark) return '';
  return [
    mark,
    recent.sampleCode,
    recent.duration ? `用时 ${recent.duration}` : '',
    recent.endedClock,
    recent.scanId ? `扫描 ${recent.scanId}` : '',
    recent.fileLabel,
    recent.folder,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The still-open operation in this experiment. Does not estimate a duration or read notes. */
export function runningOperationSummary(snapshot: Snapshot, experimentId: string) {
  const item = snapshot.items.find(
    (entry) => entry.experimentId === experimentId && entry.status === 'running',
  );
  const run = item && snapshot.runs.find((entry) => entry.itemId === item.id);
  if (!item || !run || run.endedAt) return '';
  const measurement = measurementFor(snapshot, item);
  const described =
    measurement.technique ||
    measurement.regime ||
    measurement.batch ||
    (measurement.mode && measurement.mode !== '未定')
      ? measurementSummary(measurement)
      : '';
  return [
    '进行中',
    run.snapshot.sample.code,
    recordedStartLabel(run),
    described,
    measurement.protocol?.trim() || '',
    actualScanLabel(run),
    actualFilenameLabel(run),
    '用时未计入',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function libraryBoard(snapshot: Snapshot): LibraryCard[] {
  return snapshot.experiments.map((experiment) => {
    const insights = reportInsights(snapshot, experiment.id);
    const duration = recordedDuration(
      snapshot.runs.filter((run) => run.experimentId === experiment.id),
    );
    const running = snapshot.items.find(
      (item) => item.experimentId === experiment.id && item.status === 'running',
    );
    return {
      experimentId: experiment.id,
      name: experiment.name,
      code: experiment.code,
      description: experiment.description,
      groupCount: snapshot.groups.filter((group) => group.experimentId === experiment.id).length,
      preparedKnown: insights.preparedKnown,
      unknownPreparation: insights.unknownPreparation,
      plannedSamples: insights.plannedSamples,
      plannedOperations: insights.plannedOperations,
      spareKnown: insights.spareKnown,
      completed: insights.completed,
      pending: insights.pending,
      running: insights.running,
      skipped: insights.skipped,
      interrupted: insights.interrupted,
      repeats: insights.repeats,
      unresolvedIssues: insights.unresolvedIssues,
      missingTimes: insights.missingTimes,
      missingFiles: insights.missingFiles,
      recordedLabel: duration.completeCount ? formatRecordedDuration(duration.milliseconds) : '',
      incompleteCount: duration.incompleteCount,
      actualChanged: recordedPlanChangeCount(snapshot, experiment.id),
      next: nextPending(snapshot, experiment.id),
      runningItem: running ? targetFor(snapshot, running) : null,
      recent: latestRecorded(snapshot, experiment.id),
    };
  });
}

export function boardActions(snapshot: Snapshot): BoardAction[] {
  const actions: BoardAction[] = [];
  for (const card of libraryBoard(snapshot)) {
    actions.push({
      key: `open:${card.experimentId}`,
      kind: 'open',
      experimentId: card.experimentId,
      itemId: '',
      title: card.name,
      detail: card.code,
    });
    if (card.runningItem)
      actions.push({
        key: `running:${card.runningItem.itemId}`,
        kind: 'running',
        experimentId: card.experimentId,
        itemId: card.runningItem.itemId,
        title: card.runningItem.sampleCode,
        detail: card.runningItem.operation,
      });
    if (card.next)
      actions.push({
        key: `next:${card.next.itemId}`,
        kind: 'next',
        experimentId: card.experimentId,
        itemId: card.next.itemId,
        title: card.next.sampleCode,
        detail: card.next.operation,
      });
    if (card.recent)
      actions.push({
        key: `recent:${card.recent.itemId}`,
        kind: 'recent',
        experimentId: card.experimentId,
        itemId: card.recent.itemId,
        title: card.recent.sampleCode,
        detail: [
          card.recent.status === 'interrupted' ? '最近中断' : '最近完成',
          card.recent.duration,
          card.recent.endedClock,
          card.recent.scanId,
          card.recent.fileLabel,
          card.recent.folder,
        ]
          .filter(Boolean)
          .join(' · '),
      });
    const check = followUpRoster(snapshot, card.experimentId)[0];
    if (check && check.itemId !== card.runningItem?.itemId)
      actions.push({
        key: `check:${check.itemId}`,
        kind: 'check',
        experimentId: card.experimentId,
        itemId: check.itemId,
        title: check.sampleCode,
        detail: check.gaps.join('、'),
      });
  }
  return actions;
}
