import type { PlanItem, Snapshot } from './model.js';
import { itemOpenIssueTexts } from './followUps.js';

export interface RepeatSource {
  itemId: string;
  sampleCode: string;
  sampleId: string;
  folder: string;
  scanId: string;
}

/** The finished operation a retest points at. Does not create a run or read notes. */
export function repeatSource(snapshot: Snapshot, item: PlanItem): RepeatSource | null {
  if (!item.repeatOf) return null;
  const original = snapshot.items.find((entry) => entry.id === item.repeatOf);
  if (!original) return null;
  const run = snapshot.runs.find((entry) => entry.itemId === original.id);
  const sample =
    run?.snapshot.sample || snapshot.samples.find((entry) => entry.id === original.sampleId);
  return {
    itemId: original.id,
    sampleCode: sample?.code || '',
    sampleId: run?.snapshot.sample.id || sample?.id || '',
    folder: run ? run.filename : original.plannedName || '',
    scanId: String(run?.actual.scanId || ''),
  };
}

export function repeatSourceLabel(snapshot: Snapshot, item: PlanItem) {
  const source = repeatSource(snapshot, item);
  if (!source) return '';
  return [source.sampleCode, source.scanId ? `扫描 ${source.scanId}` : '', source.folder]
    .filter(Boolean)
    .join(' · ');
}

/** Unresolved issue texts on the finished operation a retest points at. Notes are not included. */
export function repeatSourceOpenIssues(snapshot: Snapshot, item: PlanItem) {
  const source = repeatSource(snapshot, item);
  if (!source) return [];
  return itemOpenIssueTexts(snapshot, source.itemId);
}

export function repeatSourceIssueLabel(snapshot: Snapshot, item: PlanItem) {
  const issues = repeatSourceOpenIssues(snapshot, item);
  return issues.length ? `原操作未处理问题：${issues.join('、')}` : '';
}
