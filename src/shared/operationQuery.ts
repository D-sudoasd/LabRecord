import type { PlanItem, Snapshot } from './model.js';

const IDENTIFIER = /^[0-9a-f-]{8,}$/i;

function unique(values: Array<string | undefined | null>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function textIncludes(haystack: string, query: string) {
  const needle = query.trim().toLowerCase();
  return !needle || haystack.toLowerCase().includes(needle);
}

export function identityMatches(ids: readonly string[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const values = ids.map((id) => id.trim()).filter(Boolean);
  if (values.some((id) => id.toLowerCase() === needle)) return true;
  if (!/[0-9a-f]/i.test(needle) || !IDENTIFIER.test(needle)) return false;
  return values.some((id) => id.toLowerCase().includes(needle));
}

export function operationIds(snapshot: Snapshot, item: PlanItem) {
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  const sample = snapshot.samples.find((entry) => entry.id === item.sampleId);
  return unique([
    sample?.id,
    item.sampleId,
    run?.sampleId,
    run?.snapshot.sample.id,
    item.id,
    run?.id,
  ]);
}

export function matchesOperationIdentity(snapshot: Snapshot, item: PlanItem, query: string) {
  return identityMatches(operationIds(snapshot, item), query);
}

export function groupIds(snapshot: Snapshot, groupId: string) {
  const ids: Array<string | undefined> = [groupId];
  for (const sample of snapshot.samples) {
    if (sample.groupId !== groupId) continue;
    ids.push(sample.id);
    for (const item of snapshot.items) {
      if (item.sampleId !== sample.id) continue;
      ids.push(...operationIds(snapshot, item));
    }
  }
  for (const run of snapshot.runs) {
    if (run.snapshot.group.id !== groupId) continue;
    ids.push(run.snapshot.sample.id, run.sampleId, run.itemId, run.id);
  }
  return unique(ids);
}

export function matchesGroupIdentity(snapshot: Snapshot, groupId: string, query: string) {
  return identityMatches(groupIds(snapshot, groupId), query);
}

export function recordIdentifiers(snapshot: Snapshot, itemId: string) {
  const item = snapshot.items.find((entry) => entry.id === itemId);
  if (!item) return null;
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  const live = snapshot.samples.find((entry) => entry.id === item.sampleId);
  return {
    sampleId: run?.snapshot.sample.id || live?.id || '',
    folder: run ? run.filename : item.plannedName || '',
  };
}
