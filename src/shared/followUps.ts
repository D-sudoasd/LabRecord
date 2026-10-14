import type { Snapshot } from './model.js';

export interface FollowUpSets {
  missingTimes: Set<string>;
  missingFiles: Set<string>;
  unresolvedIssues: Set<string>;
  unlinkedIssues: number;
}

export interface FollowUpEntry {
  itemId: string;
  sampleCode: string;
  gaps: string[];
}

export function experimentOptionLabel(
  name: string,
  code: string,
  followUpCount: number,
  actualChanged = 0,
) {
  const parts = [`${name} · ${code}`];
  if (followUpCount > 0) parts.push(`待核对 ${followUpCount}`);
  if (actualChanged > 0) parts.push(`实际已改 ${actualChanged}`);
  return parts.join(' · ');
}

export function followUpSets(snapshot: Snapshot, experimentId: string): FollowUpSets {
  const experimentItems = snapshot.items.filter((item) => item.experimentId === experimentId);
  const itemIds = new Set(experimentItems.map((item) => item.id));
  const runs = snapshot.runs.filter((run) => run.experimentId === experimentId);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const missingTimes = new Set(
    runs.filter((run) => !run.startedAt || !run.endedAt).map((run) => run.itemId),
  );
  const missingFiles = new Set(
    runs
      .filter((run) => !run.actual.filename && !run.actual.scanId && !run.actual.files)
      .map((run) => run.itemId),
  );
  const unresolvedIssues = new Set<string>();
  let unlinkedIssues = 0;
  for (const event of snapshot.events) {
    if (event.experimentId !== experimentId || event.type !== 'issue' || event.data.resolvedAt)
      continue;
    let linked = false;
    if (event.itemId && itemIds.has(event.itemId)) {
      unresolvedIssues.add(event.itemId);
      linked = true;
    }
    const run = event.runId ? runsById.get(event.runId) : undefined;
    if (run && itemIds.has(run.itemId)) {
      unresolvedIssues.add(run.itemId);
      linked = true;
    }
    if (!linked) unlinkedIssues += 1;
  }
  return { missingTimes, missingFiles, unresolvedIssues, unlinkedIssues };
}

/** Current unresolved issue texts on one operation. Notes are not included. */
export function itemOpenIssueTexts(snapshot: Snapshot, itemId: string) {
  const run = snapshot.runs.find((entry) => entry.itemId === itemId);
  return snapshot.events
    .filter((event) => {
      if (event.type !== 'issue' || event.data.resolvedAt) return false;
      return event.itemId === itemId || (!!run && event.runId === run.id);
    })
    .map((event) => event.text);
}

export function itemOpenIssueLabel(snapshot: Snapshot, itemId: string) {
  const issues = itemOpenIssueTexts(snapshot, itemId);
  return issues.length ? `未处理问题：${issues.join('、')}` : '';
}

export function followUpRoster(snapshot: Snapshot, experimentId: string): FollowUpEntry[] {
  const sets = followUpSets(snapshot, experimentId);
  return snapshot.items
    .filter((item) => item.experimentId === experimentId)
    .sort((a, b) => a.order - b.order)
    .flatMap((item) => {
      const gaps = [
        sets.missingTimes.has(item.id) ? '时间不完整' : '',
        sets.missingFiles.has(item.id) ? '文件未关联' : '',
        sets.unresolvedIssues.has(item.id) ? '未处理问题' : '',
      ].filter(Boolean);
      if (!gaps.length) return [];
      const run = snapshot.runs.find((entry) => entry.itemId === item.id);
      const sample =
        run?.snapshot.sample || snapshot.samples.find((entry) => entry.id === item.sampleId);
      return [{ itemId: item.id, sampleCode: sample?.code || '', gaps }];
    });
}
