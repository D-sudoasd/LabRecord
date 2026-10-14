import type { Snapshot } from './model.js';
import { groupCounts } from './model.js';
export function enableGroupSpareLabel(spare: number | null) {
  if (spare === null) return '启用本组备样（数量未定）';
  if (spare === 0) return '本组没有剩余备样';
  return `启用本组备样（${spare}）`;
}

export function groupSpareLabel(spare: number | null) {
  return spare === null ? '本组备样数量未定' : `本组备样 ${spare}`;
}

export function spareProgressLabel(spareKnown: number, unknownGroups: number, groupCount: number) {
  if (groupCount > 0 && unknownGroups === groupCount) return '备样数量未定';
  if (unknownGroups > 0) return `备样 ${spareKnown} · ${unknownGroups} 组数量未定`;
  return `备样 ${spareKnown}`;
}

export function reportInsights(snapshot: Snapshot, experimentId: string) {
  const groups = snapshot.groups.filter((g) => g.experimentId === experimentId);
  const items = snapshot.items.filter((i) => i.experimentId === experimentId);
  const runs = snapshot.runs.filter((r) => r.experimentId === experimentId);
  const issues = snapshot.events.filter(
    (e) => e.experimentId === experimentId && e.type === 'issue' && !e.data.resolvedAt,
  );
  return {
    plannedOperations: items.length,
    plannedSamples: snapshot.samples.filter((s) => s.experimentId === experimentId).length,
    preparedKnown: groups.reduce((n, g) => n + (g.preparedCount || 0), 0),
    unknownPreparation: groups.filter((g) => g.preparedCount === null).length,
    spareKnown: groups.reduce((n, g) => n + (groupCounts(snapshot, g).spare || 0), 0),
    completed: items.filter((i) => i.status === 'completed').length,
    pending: items.filter((i) => i.status === 'pending').length,
    running: items.filter((i) => i.status === 'running').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    interrupted: items.filter((i) => i.status === 'interrupted').length,
    repeats: items.filter((i) => i.repeatOf).length,
    unresolvedIssues: issues.length,
    missingTimes: runs.filter((r) => !r.startedAt || !r.endedAt).length,
    missingFiles: runs.filter((r) => !r.actual.filename && !r.actual.scanId && !r.actual.files)
      .length,
    groupsWithoutWidth: groups.filter((g) => !g.width).length,
  };
}
