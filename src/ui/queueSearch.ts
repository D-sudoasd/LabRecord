import type { PlanItem, Snapshot } from '../shared/model';
import { materialSummary } from '../shared/materials';
import { measurementFor, measurementSummary, plannedGroup } from '../shared/measurement';
import { actualProtocolLabel, operationPlanDrift, operationSizeLine, recordedPlanSearchText } from '../shared/planChanges';

/** Text the live queue can match. Notes and event text stay out. */
export function queueSearchText(snapshot: Snapshot, item: PlanItem) {
  const history = snapshot.runs.find((run) => run.itemId === item.id);
  const sample =
    history?.snapshot.sample || snapshot.samples.find((entry) => entry.id === item.sampleId);
  const storedGroup = snapshot.groups.find((entry) => entry.id === sample?.groupId);
  const group =
    history?.snapshot.group ||
    (storedGroup && sample ? plannedGroup(storedGroup, sample, item) : storedGroup);
  const folder = history ? history.filename : item.plannedName || '';
  return [
    sample?.code,
    sample?.parameters.name || group?.name,
    group?.material,
    group?.state,
    materialSummary(group || {}),
    measurementSummary(measurementFor(snapshot, item)),
    group?.protocol?.trim() ? `实验制度 ${group.protocol.trim()}` : '',
    folder,
    history?.actual.scanId,
    history?.actual.filename,
    history?.actual.files,
    group ? operationSizeLine(group, history) : '',
    operationPlanDrift(snapshot, item)
      ? `当前计划已不同：${operationPlanDrift(snapshot, item)}`
      : '',
    actualProtocolLabel(history),
    recordedPlanSearchText(history),
    pictureLabel(snapshot, history?.id),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Picture file names attached to one run. Event text is not included. */
export function pictureLabel(snapshot: Snapshot, runId: string | undefined) {
  if (!runId) return '';
  const names = snapshot.attachments
    .filter((attachment) => attachment.runId === runId)
    .map((attachment) => attachment.name.trim())
    .filter(Boolean);
  return names.length ? `图片 ${names.join('、')}` : '';
}

export function groupOperationText(snapshot: Snapshot, groupId: string) {
  return snapshot.items
    .filter((item) =>
      snapshot.samples.some((sample) => sample.id === item.sampleId && sample.groupId === groupId),
    )
    .map((item) => queueSearchText(snapshot, item))
    .join(' ');
}
