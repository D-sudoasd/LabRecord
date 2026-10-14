export interface RecordedDuration {
  completeCount: number;
  incompleteCount: number;
  milliseconds: number;
}

/** Sum only runs whose start and end are both recorded and in order. Open or partial times stay out. */
export function recordedDuration(
  runs: readonly { startedAt: string | null; endedAt: string | null }[],
): RecordedDuration {
  let milliseconds = 0;
  let completeCount = 0;
  let incompleteCount = 0;
  for (const run of runs) {
    const start = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    const end = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      milliseconds += end - start;
      completeCount += 1;
    } else incompleteCount += 1;
  }
  return { completeCount, incompleteCount, milliseconds };
}

export function runDurationLabel(
  run: { startedAt: string | null; endedAt: string | null } | undefined,
) {
  if (!run) return '';
  const duration = recordedDuration([run]);
  return duration.completeCount === 1 ? formatRecordedDuration(duration.milliseconds) : '未计入';
}

export function formatRecordedDuration(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
  if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  return `${seconds} 秒`;
}
