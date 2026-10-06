import type { PlanItem, RecordEvent, Snapshot } from '../shared/model';

export function overviewOperation(snapshot: Snapshot, item: PlanItem) {
  const run = snapshot.runs.find((r) => r.itemId === item.id);
  const sample = run?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId);
  const group = run?.snapshot.group || snapshot.groups.find((g) => g.id === sample?.groupId);
  return { item, run, sample, group };
}

export function overviewIssue(snapshot: Snapshot, issue: RecordEvent) {
  const run = snapshot.runs.find(
    (r) => r.id === issue.runId && r.experimentId === issue.experimentId,
  );
  const item = snapshot.items.find(
    (i) => i.id === (issue.itemId || run?.itemId) && i.experimentId === issue.experimentId,
  );
  return item ? overviewOperation(snapshot, item) : undefined;
}
