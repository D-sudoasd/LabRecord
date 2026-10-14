export interface RecordedClock {
  clock: string;
  zone: string;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function offsetZone(minutes: number) {
  if (!Number.isFinite(minutes)) return 'UTC';
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(Math.trunc(minutes));
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest ? `UTC${sign}${hours}:${pad(rest)}` : `UTC${sign}${hours}`;
}

/** Clock at the offset saved with the record. It does not use the computer's current timezone. */
export function recordedClock(
  time: string | null | undefined,
  offsetMinutes: number,
  timezone = '',
): RecordedClock | null {
  if (!time || !Number.isFinite(offsetMinutes)) return null;
  const instant = new Date(time);
  if (Number.isNaN(instant.getTime())) return null;
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  if (Number.isNaN(shifted.getTime())) return null;
  return {
    clock: `${shifted.getUTCFullYear()}/${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
    zone: timezone.trim() || offsetZone(offsetMinutes),
  };
}

/** End clock already stored on a run. Open runs and unreadable times stay blank. */
export function recordedEndLabel(
  run: { endedAt: string | null; offsetMinutes: number; timezone?: string } | null | undefined,
) {
  if (!run?.endedAt) return '';
  const clock = recordedClock(run.endedAt, run.offsetMinutes, run.timezone);
  return clock ? `结束 ${clock.clock} ${clock.zone}` : '';
}

/** Start clock already stored on a run. Runs that have not started stay blank. */
export function recordedStartLabel(
  run: { startedAt: string | null; offsetMinutes: number; timezone?: string } | null | undefined,
) {
  if (!run?.startedAt) return '';
  const clock = recordedClock(run.startedAt, run.offsetMinutes, run.timezone);
  return clock ? `开始 ${clock.clock} ${clock.zone}` : '';
}
