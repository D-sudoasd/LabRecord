import type { Run, Snapshot } from '../shared/model.js';
import { followUpSets } from '../shared/followUps.js';

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

export function actualReferenceValue(run: Run | undefined, label: string) {
  return actualFileReferences(run).find((reference) => reference.label === label)?.value || '';
}

export { actualFilenameLabel } from '../shared/copyText.js';

export function followUpLabels(itemId: string, ids: ReviewFilterItemIds) {
  const labels: string[] = [];
  if (ids.missingTimes.has(itemId)) labels.push('时间不完整');
  if (ids.missingFiles.has(itemId)) labels.push('文件未关联');
  if (ids.unresolvedIssues.has(itemId)) labels.push('未处理问题');
  return labels;
}

export function reviewFilterItemIds(snapshot: Snapshot, experimentId: string): ReviewFilterItemIds {
  const sets = followUpSets(snapshot, experimentId);
  return {
    missingTimes: sets.missingTimes,
    missingFiles: sets.missingFiles,
    unresolvedIssues: sets.unresolvedIssues,
  };
}

export function matchesReviewFilters(
  itemId: string,
  selected: readonly ReviewFilterKey[],
  itemIds: ReviewFilterItemIds,
) {
  return selected.every((filter) => itemIds[filter].has(itemId));
}
