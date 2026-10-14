import type { Group, PlanItem, Run, Sample, Snapshot } from '../shared/model';
import { MODE_LABEL } from '../shared/model';
import { operationProtocolLabel, plannedGroup, regimeLabel } from '../shared/measurement';
import { followUpRoster } from '../shared/followUps';
import { runningOperationSummary } from '../shared/library';
import { identityMatches } from '../shared/operationQuery';
import { recordedStartLabel } from '../shared/recordedTime';
import { pictureLabel } from './queueSearch';
import { actualProtocolLabel, operationPlanDrift, operationSizeLine, recordedPlanChangeCount, recordedPlanSearchText } from '../shared/planChanges';

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

const PREPARATION_KEYS = [
  'material',
  'state',
  'name',
  'composition',
  'processing',
  'heatTreatment',
  'otherTreatment',
  'preparation',
] as const;

function preparationTerms(group: Group | undefined, sample: Sample) {
  const terms: (string | undefined)[] = [];
  for (const key of PREPARATION_KEYS) {
    const own = sample.parameters[key];
    terms.push(typeof own === 'string' && own.trim() ? own : group?.[key]);
  }
  const mode = sample.parameters.mode ?? group?.mode;
  if (mode && mode !== '未定') terms.push(mode, MODE_LABEL[mode]);
  return terms;
}

function measurementTerms(item: PlanItem) {
  const measurement = item.measurement;
  if (!measurement) return [];
  const regime = measurement.regime?.trim();
  return [
    measurement.technique,
    regime,
    regime ? regimeLabel(regime) : '',
    measurement.batch,
    measurement.customName,
    measurement.protocol,
    measurement.mode && measurement.mode !== '未定' ? measurement.mode : '',
    measurement.mode && measurement.mode !== '未定' ? MODE_LABEL[measurement.mode] : '',
  ].filter((value): value is string => !!value?.trim());
}

function referenceLabel(run: Run, query: string) {
  for (const value of [run.actual.scanId, run.actual.filename, run.actual.files]) {
    if (value == null || value === '') continue;
    const line = String(value)
      .split(/\r?\n/)
      .find((entry) => entry.toLowerCase().includes(query));
    if (line?.trim()) return line.trim();
  }
  return '';
}

function measurementTitle(item: PlanItem, query: string) {
  const regime = item.measurement?.regime?.trim();
  const label = regime ? regimeLabel(regime) : '';
  if (label && has(label, query)) return label;
  if (regime && has(regime, query)) return label || regime;
  return measurementTerms(item).find((term) => has(term, query)) || item.operation;
}

export function searchWorkspace(snapshot: Snapshot, raw: string, limit = 8): WorkspaceHit[] {
  const query = raw.trim().toLowerCase();
  if (!query) return [];
  const rosters = new Map(
    snapshot.experiments.map((experiment) => [experiment.id, followUpRoster(snapshot, experiment.id)]),
  );
  const detailFor = (experiment: { id: string; name: string; code: string }, itemId: string) => {
    const roster = rosters.get(experiment.id) ?? [];
    if (!itemId) {
      const changed = recordedPlanChangeCount(snapshot, experiment.id);
      const marks = [
        roster.length ? `待核对 ${roster.length}` : '',
        changed ? `实际已改 ${changed}` : '',
      ].filter(Boolean);
      return marks.length ? `${experiment.code} · ${marks.join(' · ')}` : experiment.code;
    }
    const gaps = roster.find((entry) => entry.itemId === itemId)?.gaps ?? [];
    const runningItem = snapshot.items.find((entry) => entry.id === itemId);
    const running =
      runningItem?.status === 'running' ? runningOperationSummary(snapshot, experiment.id) : '';
    const extra = [gaps.length ? gaps.join('、') : '', running].filter(Boolean);
    const base = `${experiment.name} · ${experiment.code}`;
    return extra.length ? `${base} · ${extra.join(' · ')}` : base;
  };
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
      detail: detailFor(experiment, ''),
      exact: same(experiment.name, query) || same(experiment.code, query),
    });
  }
  for (const sample of snapshot.samples) {
    const experiment = snapshot.experiments.find((entry) => entry.id === sample.experimentId);
    if (!experiment) continue;
    const group = snapshot.groups.find((entry) => entry.id === sample.groupId);
    const items = snapshot.items
      .filter((item) => item.sampleId === sample.id)
      .sort((a, b) => a.order - b.order);
    const runs = snapshot.runs.filter((run) => run.sampleId === sample.id);
    const codes = [sample.code, ...runs.map((run) => run.snapshot.sample.code)];
    const ids = [sample.id, ...runs.map((run) => run.snapshot.sample.id)];
    const names = [
      sample.parameters.name,
      ...runs.flatMap((run) => [run.snapshot.sample.parameters.name, run.actualSample?.name]),
    ];
    const preparation = preparationTerms(group, sample);
    const opened = items.find((entry) => entry.status === 'running') || items[0];
    const openedRun = opened && runs.find((entry) => entry.itemId === opened.id);
    const identityTerms = openedRun
      ? preparationTerms(openedRun.snapshot.group, openedRun.snapshot.sample)
      : preparation;
    const identity =
      codes.some((code) => has(code, query)) ||
      identityMatches(ids, query) ||
      names.some((name) => has(name, query)) ||
      identityTerms.some((value) => has(value, query));
    const exactOperation = items.find((item) => {
      const run = runs.find((entry) => entry.itemId === item.id);
      return same(item.id, query) || same(run?.id, query);
    });
    if (exactOperation) {
      hits.push({
        key: `operation:${exactOperation.id}`,
        kind: 'item',
        experimentId: experiment.id,
        itemId: exactOperation.id,
        groupId: sample.groupId,
        title: sample.code,
        detail: detailFor(experiment, exactOperation.id),
        exact: true,
      });
      continue;
    }
    const folders = items.flatMap((item) => {
      const run = runs.find((entry) => entry.itemId === item.id);
      const folder = run?.filename || item.plannedName || '';
      return has(folder, query) ? [{ item, folder }] : [];
    });
    const exact =
      codes.some((code) => same(code, query)) ||
      ids.some((id) => same(id, query)) ||
      names.some((name) => same(name, query)) ||
      identityTerms.some((value) => same(value, query));
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
        detail: detailFor(experiment, item?.id || ''),
        exact,
      });
    } else {
      const seen = new Set<string>();
      for (const { item, folder } of folders) {
        seen.add(item.id);
        hits.push({
          key: `folder:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${folder}`,
          detail: detailFor(experiment, item.id),
          exact: same(folder, query),
        });
      }
      for (const run of runs) {
        if (seen.has(run.itemId)) continue;
        const label = referenceLabel(run, query);
        if (!label) continue;
        seen.add(run.itemId);
        hits.push({
          key: `reference:${run.itemId}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: run.itemId,
          groupId: sample.groupId,
          title: `${sample.code} · ${label}`,
          detail: detailFor(experiment, run.itemId),
          exact: same(label, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const pictures = pictureLabel(snapshot, runs.find((entry) => entry.itemId === item.id)?.id);
        if (!has(pictures, query)) continue;
        seen.add(item.id);
        hits.push({
          key: `picture:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${pictures}`,
          detail: detailFor(experiment, item.id),
          exact: same(pictures, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const run = runs.find((entry) => entry.itemId === item.id);
        const sizeGroup = run?.snapshot.group || (group ? plannedGroup(group, sample, item) : group);
        const size = sizeGroup ? operationSizeLine(sizeGroup, run) : '';
        if (!has(size, query)) continue;
        seen.add(item.id);
        hits.push({
          key: `size:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${size}`,
          detail: detailFor(experiment, item.id),
          exact: same(size, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const run = runs.find((entry) => entry.itemId === item.id);
        const terms = run
          ? preparationTerms(run.snapshot.group, run.snapshot.sample)
          : preparation;
        const label = terms.find((value) => has(value, query));
        if (!label) continue;
        seen.add(item.id);
        hits.push({
          key: `preparation:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${label}`,
          detail: detailFor(experiment, item.id),
          exact: terms.some((value) => same(value, query)),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const run = runs.find((entry) => entry.itemId === item.id);
        if (!run?.snapshot.group && !group) continue;
        const protocol = operationProtocolLabel(snapshot, item);
        if (!has(protocol, query)) continue;
        seen.add(item.id);
        hits.push({
          key: `plan-protocol:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${protocol}`,
          detail: detailFor(experiment, item.id),
          exact: same(protocol, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const recordedProtocol = actualProtocolLabel(
          runs.find((entry) => entry.itemId === item.id),
        );
        if (has(recordedProtocol, query)) {
          seen.add(item.id);
          hits.push({
            key: `protocol:${item.id}`,
            kind: 'item',
            experimentId: sample.experimentId,
            itemId: item.id,
            groupId: sample.groupId,
            title: `${sample.code} · ${recordedProtocol}`,
            detail: detailFor(experiment, item.id),
            exact: same(recordedProtocol, query),
          });
          continue;
        }
        const drift = operationPlanDrift(snapshot, item);
        const driftText = drift ? `当前计划已不同：${drift}` : '';
        if (!has(driftText, query)) continue;
        seen.add(item.id);
        hits.push({
          key: `drift:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${driftText}`,
          detail: detailFor(experiment, item.id),
          exact: same(driftText, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const recorded = recordedPlanSearchText(runs.find((entry) => entry.itemId === item.id));
        if (!has(recorded, query)) continue;
        seen.add(item.id);
        hits.push({
          key: `recorded:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${recorded}`,
          detail: detailFor(experiment, item.id),
          exact: same(recorded, query),
        });
      }
      for (const item of items) {
        if (seen.has(item.id)) continue;
        const terms = measurementTerms(item);
        if (!terms.some((term) => has(term, query))) continue;
        hits.push({
          key: `measurement:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${measurementTitle(item, query)}`,
          detail: detailFor(experiment, item.id),
          exact: terms.some((term) => same(term, query)),
        });
      }
      for (const item of items) {
        if (seen.has(item.id) || item.status !== 'running') continue;
        const summary = runningOperationSummary(snapshot, item.experimentId);
        const clock = recordedStartLabel(runs.find((entry) => entry.itemId === item.id));
        const searchable = clock
          ? summary.replace(` · ${clock}`, '').replace(`${clock} · `, '')
          : summary;
        if (!has(searchable, query)) continue;
        hits.push({
          key: `running:${item.id}`,
          kind: 'item',
          experimentId: sample.experimentId,
          itemId: item.id,
          groupId: sample.groupId,
          title: `${sample.code} · ${summary}`,
          detail: detailFor(experiment, item.id),
          exact: same(summary, query),
        });
      }
    }
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits.slice(0, limit);
}
