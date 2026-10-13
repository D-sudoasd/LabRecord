import type { Run, Snapshot } from '../shared/model.js';

export type ReviewFilterKey = 'missingTimes' | 'missingFiles' | 'unresolvedIssues';

export type ReviewFilterItemIds = Record<ReviewFilterKey, ReadonlySet<string>>;

export function actualFileReferences(run: Run | undefined) {
  if (!run) return [];
  return (
    [
      ['文件名', run.actual.filename],
      ['扫描编号', run.actual.scanId],
      ['文件引用', run.actual.files],
    ] as const
  ).flatMap(([label, value]) => (value ? [{ label, value: String(value) }] : []));
}

export function reviewFilterItemIds(snapshot: Snapshot, experimentId: string): ReviewFilterItemIds {
  const experimentItems = snapshot.items.filter((item) => item.experimentId === experimentId);
  const itemIds = new Set(experimentItems.map((item) => item.id));
  const runs = snapshot.runs.filter((run) => run.experimentId === experimentId);
  const runsById = new Map(runs.map((run) => [run.id, run]));

  // Match reportInsights: time and file gaps are counted only on existing runs.
  const missingTimes = new Set(
    runs.filter((run) => !run.startedAt || !run.endedAt).map((run) => run.itemId),
  );
  const missingFiles = new Set(
    runs
      .filter((run) => !run.actual.filename && !run.actual.scanId && !run.actual.files)
      .map((run) => run.itemId),
  );
  const unresolvedIssues = new Set<string>();

  for (const event of snapshot.events) {
    if (event.experimentId !== experimentId || event.type !== 'issue' || event.data.resolvedAt)
      continue;
    if (event.itemId && itemIds.has(event.itemId)) unresolvedIssues.add(event.itemId);
    const run = event.runId ? runsById.get(event.runId) : undefined;
    if (run && itemIds.has(run.itemId)) unresolvedIssues.add(run.itemId);
  }

  return { missingTimes, missingFiles, unresolvedIssues };
}

export function matchesReviewFilters(
  itemId: string,
  selected: readonly ReviewFilterKey[],
  itemIds: ReviewFilterItemIds,
) {
  return selected.every((filter) => itemIds[filter].has(itemId));
}
