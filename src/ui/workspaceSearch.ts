import type { Snapshot } from '../shared/model';

export interface WorkspaceHit {
  key: string;
  kind: 'experiment' | 'item';
  experimentId: string;
  itemId: string;
  groupId: string;
  title: string;
  detail: string;
  exact: boolean;
}

let pendingGroup = '';

export function focusGroup(id: string) {
  pendingGroup = id;
}

export function consumePendingGroup() {
  const id = pendingGroup;
  pendingGroup = '';
  return id;
}

function has(value: string | undefined | null, query: string) {
  return !!value && value.toLowerCase().includes(query);
}

function same(value: string | undefined | null, query: string) {
  return !!value && value.toLowerCase() === query;
}

export function searchWorkspace(snapshot: Snapshot, raw: string, limit = 8): WorkspaceHit[] {
  const query = raw.trim().toLowerCase();
  if (!query) return [];
  const hits: WorkspaceHit[] = [];
  for (const experiment of snapshot.experiments) {
    if (!has(experiment.name, query) && !has(experiment.code, query)) continue;
    hits.push({
      key: `experiment:${experiment.id}`,
      kind: 'experiment',
      experimentId: experiment.id,
      itemId: '',
      groupId: '',
      title: experiment.name,
      detail: experiment.code,
      exact: same(experiment.name, query) || same(experiment.code, query),
    });
  }
  for (const sample of snapshot.samples) {
    const experiment = snapshot.experiments.find((entry) => entry.id === sample.experimentId);
    if (!experiment) continue;
    const items = snapshot.items
      .filter((item) => item.sampleId === sample.id)
      .sort((a, b) => a.order - b.order);
    const runs = snapshot.runs.filter((run) => run.sampleId === sample.id);
    const codes = [sample.code, ...runs.map((run) => run.snapshot.sample.code)];
    const names = [
      sample.parameters.name,
      ...runs.flatMap((run) => [run.snapshot.sample.parameters.name, run.actualSample?.name]),
    ];
    const identity =
      codes.some((code) => has(code, query)) || names.some((name) => has(name, query));
    const folders = items.flatMap((item) => {
      const run = runs.find((entry) => entry.itemId === item.id);
      const folder = run?.filename || item.plannedName || '';
      return has(folder, query) ? [{ item, folder }] : [];
    });
    if (identity) {
      const item = items.find((entry) => entry.status === 'running') || items[0];
      hits.push({
        key: `sample:${sample.id}`,
        kind: 'item',
        experimentId: sample.experimentId,
        itemId: item?.id || '',
        groupId: sample.groupId,
        title: sample.parameters.name?.trim()
          ? `${sample.code} · ${sample.parameters.name.trim()}`
          : sample.code,
        detail: `${experiment.name} · ${experiment.code}`,
        exact: codes.some((code) => same(code, query)) || names.some((name) => same(name, query)),
      });
    } else {
      for (const { item, folder } of folders) {
        hits.push({
          key: `folder:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${folder}`,
          detail: `${experiment.name} · ${experiment.code}`,
          exact: same(folder, query),
        });
      }
    }
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits.slice(0, limit);
}
