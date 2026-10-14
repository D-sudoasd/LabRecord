import type { PlanItem, RecordEvent, Snapshot } from './model.js';
import { recordedClock } from './recordedTime.js';

/** Events for one operation, including those stored only against its run. */
export function operationHistory(snapshot: Snapshot, itemId: string): RecordEvent[] {
  const runId = snapshot.runs.find((run) => run.itemId === itemId)?.id ?? null;
  return snapshot.events.filter(
    (event) => event.itemId === itemId || (runId !== null && event.runId === runId),
  );
}

/** Latest skip or interrupt reason still in effect. Event text itself stays out of search. */
export function operationStatusReason(snapshot: Snapshot, item: PlanItem) {
  const marker = item.status === 'skipped' ? '跳过操作' : item.status === 'interrupted' ? '中断操作' : '';
  if (!marker) return '';
  const latest = snapshot.events
    .filter(
      (event) =>
        event.itemId === item.id &&
        (event.text === marker || event.text.startsWith(`${marker}：`)),
    )
    .at(-1);
  if (!latest?.text.startsWith(`${marker}：`)) return '';
  return latest.text.slice(marker.length + 1).trim();
}

/** Earlier wording kept on an edited issue or timeline note. Other events have none. */
export function eventEarlierText(event: { type: string; data: Record<string, unknown> }) {
  if (event.type !== 'issue' && event.type !== 'note') return '';
  if (!Array.isArray(event.data.previousText)) return '';
  const lines = event.data.previousText.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  return lines.length ? `曾写 ${lines.join('；')}` : '';
}

/** Detail kept beside an event after the earlier wording is shown separately. */
export function eventDetailData(event: { data: Record<string, unknown> }) {
  const data = { ...event.data };
  delete data.previousText;
  return data;
}
export function issueEarlierText(event: { type: string; data: Record<string, unknown> }) {
  return event.type === 'issue' ? eventEarlierText(event) : '';
}

/** Clock for an event attached to a run. Unlinked events have no saved offset. */
export function eventTimeLabel(snapshot: Snapshot, event: RecordEvent) {
  const run =
    (event.runId ? snapshot.runs.find((entry) => entry.id === event.runId) : undefined) ||
    (event.itemId ? snapshot.runs.find((entry) => entry.itemId === event.itemId) : undefined);
  if (!run) return '';
  const clock = recordedClock(event.createdAt, run.offsetMinutes, run.timezone);
  return clock ? `${clock.clock} ${clock.zone}` : '';
}
