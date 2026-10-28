import { useState, useEffect, useRef } from 'react';
import {
  Play,
  Check,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  SkipForward,
  RotateCcw,
  AlertTriangle,
  Clock,
  Copy,
  ImagePlus,
  FileText,
  Plus,
  List,
  X,
  Square,
  Link,
  ChevronDown,
  MoreHorizontal,
} from 'lucide-react';
import type { PlanItem, Command } from '../shared/model';
import { placeId, swapAdjacent } from '../shared/order';
import {
  groupCounts,
  sampleName,
  dimensions,
  MODE_LABEL,
  MODE_OPTIONS,
  PROTOCOL_PLACEHOLDER,
} from '../shared/model';
import {
  actualProtocolLabel,
  laterPlanDrift,
  operationPlanDrift,
  operationSizeLine,
  planChangeLabel,
  recordedPlanSearchText,
  startedPlanChanges,
} from '../shared/planChanges';
import { runDurationLabel } from '../shared/duration';
import { recordedEndLabel, recordedStartLabel } from '../shared/recordedTime';
import {
  useWorkspace,
  unwrap,
  DesktopReplyError,
  type EventTarget,
  type EventDraft,
} from './context';
import {
  AutoInput,
  Empty,
  StatusPill,
  PriorityPill,
  Modal,
  FieldInputs,
  timeText,
  localInput,
  eventLabel,
  Details,
  SearchField,
  ElapsedTime,
  useModalDialog,
} from './components';
import { ArrangeDialog } from './Plan';
import { QuickAdd } from './QuickAdd';
import { MaterialPreparationSummary } from './MaterialPreparation';
import { materialSummary } from '../shared/materials';
import { followUpLabels, reviewFilterItemIds, actualFilenameLabel } from './reviewFilters';
import { followUpRoster } from '../shared/followUps';
import { latestEndedMark, latestRecorded, nextOperationBrief } from '../shared/library';
import {
  enableGroupSpareLabel,
  groupSpareLabel,
  reportInsights,
  spareProgressLabel,
} from '../shared/summary';
import { repeatSource, repeatSourceIssueLabel } from '../shared/repeats';
import { matchesOperationIdentity, textIncludes } from '../shared/operationQuery';
import { EventTextDialog } from './IssueEditDialog';
import { pictureLabel, queueSearchText } from './queueSearch';
import {
  canCopyName,
  actualScanLabel,
  canCopyProtocol,
  protocolCopyText,
} from '../shared/copyText';
import { recordedClock } from '../shared/recordedTime';
import { eventTimeLabel, eventEarlierText, operationStatusReason } from '../shared/history';
import { QuickRecordBar, IssueTemplateDialog } from './QuickRecord';
import { MeasurementDialog } from './MeasurementPlanner';
import {
  DeleteConfirm,
  itemsDeleteReason,
  itemsDeleteRequest,
  useContextMenu,
  type PendingDelete,
} from './rowMenu';
import {
  measurementFor,
  measurementSummary,
  operationProtocolLabel,
  plannedGroup,
  reserveMeasurementNames,
} from '../shared/measurement';

export function TimesDialog({
  itemId,
  experimentId,
  runId,
  onClose,
}: {
  itemId: string;
  experimentId: string;
  runId?: string;
  onClose: () => void;
}) {
  const { execute, snapshot } = useWorkspace();
  const run = runId && snapshot.runs.find((r) => r.id === runId);
  const item = snapshot.items.find((i) => i.id === itemId);

  const [start, setStart] = useState(run ? localInput(run.startedAt) : ''),
    [end, setEnd] = useState(run ? localInput(run.endedAt) : ''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submitting = useRef(false);
  const intent = useRef<{ command: Extract<Command, { type: 'times' }>; requestId: string } | null>(
    null,
  );
  const validTarget =
    item?.experimentId === experimentId &&
    (!runId || (run && run.itemId === itemId && run.experimentId === experimentId));
  const code = snapshot.samples.find((s) => s.id === item?.sampleId)?.code || itemId;
  const originalStart = run
    ? recordedClock(run.originalStartedAt, run.offsetMinutes, run.timezone)
    : null;
  const originalEnd = run
    ? recordedClock(run.originalEndedAt, run.offsetMinutes, run.timezone)
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || !validTarget) return;
    submitting.current = true;
    setBusy(true);
    try {
      intent.current ||= {
        command: {
          type: 'times',
          itemId,
          startedAt: start ? new Date(start).toISOString() : null,
          endedAt: end ? new Date(end).toISOString() : null,
          reason,
        },
        requestId: crypto.randomUUID(),
      };
      await execute(intent.current.command, false, intent.current.requestId);
      onClose();
    } catch (failure) {
      if (failure instanceof DesktopReplyError && failure.rejected) intent.current = null;
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={run ? '修正起止时间' : '补录起止时间'} onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong>
        </p>
        {!validTarget && (
          <p className="error-text" role="alert">
            目标记录不存在或关联已改变，请关闭后重新打开。
          </p>
        )}
        <div className="callout">
          <p>时间用于和实验数据大致对应。未知时间可以留空；原始点击时间和修改历史会保留。</p>
        </div>
        <label className="field">
          <span>开始时间</span>
          <input
            aria-label="开始时间"
            type="datetime-local"
            step="1"
            value={start}
            disabled={busy || !validTarget || !!intent.current}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label className="field">
          <span>结束时间</span>
          <input
            aria-label="结束时间"
            type="datetime-local"
            step="1"
            value={end}
            disabled={busy || !validTarget || !!intent.current}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <label className="field">
          <span>修改说明（可选）</span>
          <input
            value={reason}
            disabled={busy || !validTarget || !!intent.current}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如忘记点完成，按实验日志补记"
          />
        </label>
        {run && (
          <p className="hint">
            原始开始：{originalStart ? `${originalStart.clock} ${originalStart.zone}` : '尚未记录'}
            <br />
            原始结束：{originalEnd ? `${originalEnd.clock} ${originalEnd.zone}` : '尚未记录'}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
            {intent.current && ' 内容已固定，请重试保存以恢复同一请求。'}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button primary" disabled={busy || !validTarget}>
            保存时间记录
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function EventDialog({
  itemId,
  experimentId,
  runId,
  onClose,
  issue,
}: EventTarget & {
  onClose: () => void;
  issue: boolean;
}) {
  const { execute, snapshot, eventDrafts, registerDraft, clearDraft, flush } = useWorkspace();
  const key = `event-${experimentId}-${itemId}-${issue ? 'issue' : 'note'}`;
  const [draft, setDraft] = useState<EventDraft>(
    () =>
      eventDrafts.get(key) || {
        target: { itemId, experimentId, runId },
        text: '',
        category: '装样问题',
        template: '',
      },
  );
  const current = useRef(draft);
  const saving = useRef<Promise<void> | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const targetItem = snapshot.items.find((i) => i.id === draft.target.itemId);
  const code =
    snapshot.samples.find((s) => s.id === targetItem?.sampleId)?.code || draft.target.itemId;
  const locked = busy || Boolean(draft.intent);

  function change(patch: Partial<EventDraft>) {
    const next = { ...current.current, ...patch };
    current.current = next;
    eventDrafts.set(key, next);
    setDraft(next);
  }
  // This callback is registered only after an explicit submission. Cancelled text is not an event.
  function persist(
    submitted: EventDraft & { intent: NonNullable<EventDraft['intent']> },
  ): Promise<void> {
    if (saving.current) return saving.current;
    setBusy(true);
    const operation = (async () => {
      try {
        await execute(submitted.intent.command, false, submitted.intent.requestId);
        clearDraft(key);
        eventDrafts.delete(key);
        setError('');
        onClose();
      } catch (failure) {
        setError((failure as Error).message);
        registerDraft(key, () => persist(submitted), true);
        throw failure;
      } finally {
        setBusy(false);
      }
    })();
    saving.current = operation;
    void operation
      .finally(() => {
        saving.current = null;
      })
      .catch(() => {});
    return operation;
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (submitting.current || !current.current.text.trim()) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (!current.current.intent)
        change({
          intent: {
            command: {
              type: 'addEvent',
              ...current.current.target,
              eventType: issue ? 'issue' : 'note',
              text: current.current.text,
              category: current.current.category,
            },
            requestId: crypto.randomUUID(),
          },
        });
      const submitted = current.current as EventDraft & {
        intent: NonNullable<EventDraft['intent']>;
      };
      registerDraft(key, () => persist(submitted));
      await flush();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={issue ? '记录现场问题' : '添加时间线记录'} onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong> · {draft.target.runId ? '本次操作' : '操作开始前'}
        </p>
        {issue && (
          <IssueTemplateDialog
            selected={draft.template}
            disabled={locked}
            onSelect={(template) =>
              change({ category: template.category, text: template.text, template: template.id })
            }
          />
        )}
        {issue && (
          <label className="field">
            <span>问题类别</span>
            <select
              disabled={locked}
              value={draft.category}
              onChange={(event) => change({ category: event.target.value })}
            >
              <option>装样问题</option>
              <option>设备异常</option>
              <option>信号异常</option>
              <option>样品变化</option>
              <option>其他</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>{issue ? '发生了什么？' : '记录内容'}</span>
          <textarea
            autoFocus
            required
            value={draft.text}
            disabled={locked}
            onChange={(event) => change({ text: event.target.value })}
            rows={3}
            placeholder={
              issue
                ? '简要写下问题、处理方式或需要后续检查的内容'
                : '操作变化、观察现象、沟通信息等'
            }
            onKeyDown={(event) => {
              if (
                event.ctrlKey &&
                !event.altKey &&
                !event.metaKey &&
                !event.shiftKey &&
                event.key === 'Enter' &&
                !event.repeat &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <p className="hint">
          提交后记录时间 · Ctrl + Enter 提交。取消后可在本窗口继续草稿；未提交内容不保存到数据库。
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className={`button ${issue ? 'warning' : 'primary'}`}
            disabled={busy || !draft.text.trim()}
          >
            {draft.intent ? '重试此记录' : issue ? '保存问题记录' : '添加记录'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function Timeline({ itemId, experimentId }: { itemId: string; experimentId: string }) {
  const { snapshot, execute } = useWorkspace();
  const [all, setAll] = useState(false);
  const [editEvent, setEditEvent] = useState<{ id: string; kind: 'issue' | 'note' } | null>(null);
  const events = snapshot.events
    .filter((e) => e.experimentId === experimentId && (all || e.itemId === itemId))
    .slice()
    .reverse();
  return (
    <div className="timeline-panel">
      <div className="timeline-header">
        <h3>
          <Clock size={17} />
          时间线
        </h3>
        <button className="text-button" onClick={() => setAll(!all)}>
          {all ? '当前样品' : '全部记录'}
        </button>
      </div>
      <div className="timeline-content">
        {events.length ? (
          events.map((event) => (
            <div className={`timeline-event ${event.type}`} key={event.id}>
              <span className="timeline-dot" />
              <div className="event-meta">
                <time>{eventTimeLabel(snapshot, event) || timeText(event.createdAt)}</time>
                <span>{eventLabel(event.type)}</span>
              </div>
              <p>{event.text}</p>
              {eventEarlierText(event) && (
                <small className="issue-earlier">{eventEarlierText(event)}</small>
              )}
              {event.type === 'note' && (
                <div className="issue-meta">
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`在时间线修改记录：${event.text}`}
                    onClick={() => setEditEvent({ id: event.id, kind: 'note' })}
                  >
                    修改
                  </button>
                </div>
              )}
              {event.type === 'issue' && (
                <div className="issue-meta">
                  <span>{String(event.data.category || '其他')}</span>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`在时间线修改问题：${event.text}`}
                    onClick={() => setEditEvent({ id: event.id, kind: 'issue' })}
                  >
                    修改
                  </button>
                  {event.data.resolvedAt ? (
                    <span>已处理</span>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => {
                        void execute({ type: 'resolveIssue', eventId: event.id }, false).catch(
                          () => {},
                        );
                      }}
                    >
                      标记已处理
                    </button>
                  )}
                </div>
              )}
              {event.type === 'correction' && (
                <details>
                  <summary>查看修改历史</summary>
                  <pre>{JSON.stringify(event.data, null, 2)}</pre>
                </details>
              )}
            </div>
          ))
        ) : (
          <div className="timeline-empty">
            <Clock size={28} />
            <p>
              开始、完成、备注和问题
              <br />
              会按时间记录在这里
            </p>
          </div>
        )}
      </div>
      <div className="timeline-foot">现场记录时间 · 仪器时间戳另行保留</div>
      {editEvent && (
        <EventTextDialog
          eventId={editEvent.id}
          kind={editEvent.kind}
          onClose={() => setEditEvent(null)}
        />
      )}
    </div>
  );
}
function TimelineDrawer({
  itemId,
  experimentId,
  onClose,
}: {
  itemId: string;
  experimentId: string;
  onClose: () => void;
}) {
  const ref = useModalDialog();
  return (
    <dialog
      ref={ref}
      className="timeline-drawer-modal timeline-drawer"
      aria-label="现场时间线"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        className="icon-button drawer-close"
        autoFocus
        aria-label="关闭时间线"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <Timeline itemId={itemId} experimentId={experimentId} />
    </dialog>
  );
}
export function Live() {
  const [measurementDialog, setMeasurementDialog] = useState<{
    item: PlanItem;
    append: boolean;
  } | null>(null);
  const workspace = useWorkspace();
  const {
    snapshot,
    experimentId,
    itemId,
    setItemId,
    setPage,
    setExperimentId,
    execute,
    busy,
    notify,
    flush,
  } = workspace;
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  const items = snapshot.items
    .filter((i) => i.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const followUps = reviewFilterItemIds(snapshot, experimentId);
  const rosterIds = new Set(followUpRoster(snapshot, experimentId).map((entry) => entry.itemId));
  const selected =
    items.find((i) => i.id === itemId) ||
    items.find((i) => i.status === 'running') ||
    items.find((i) => i.status === 'pending') ||
    items[0];
  const globalRunning = snapshot.items.find((i) => i.status === 'running');
  const [filter, setFilter] = useState('all'),
    [search, setSearch] = useState(''),
    [focused, setFocused] = useState(false),
    [queueOpen, setQueueOpen] = useState(false),
    [moreTarget, setMoreTarget] = useState<EventTarget | null>(null),
    [timelineTarget, setTimelineTarget] = useState<EventTarget | null>(null);
  const queueListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = queueListRef.current;
    const heading = list?.querySelector('.queue-row.current .queue-choice strong');
    if (!list || !heading) return;
    const bounds = list.getBoundingClientRect();
    const title = heading.getBoundingClientRect();
    if (title.top < bounds.top || title.bottom > bounds.bottom) {
      list.scrollTop += title.top - bounds.top - 12;
    }
  }, [selected?.id, selected?.status, focused, queueOpen, filter, search]);
  const [actualOpen, setActualOpen] = useState(false);
  const openActualFor = useRef<string | null>(null);
  useEffect(() => {
    if (openActualFor.current && openActualFor.current === selected?.id) {
      openActualFor.current = null;
      setActualOpen(true);
      return;
    }
    setActualOpen(false);
  }, [selected?.id]);
  useEffect(() => {
    if (!actualOpen) return;
    document.getElementById('live-actual-files')?.scrollIntoView({ block: 'nearest' });
  }, [actualOpen]);
  const [timesTarget, setTimesTarget] = useState<EventTarget | null>(null),
    [eventDialog, setEventDialog] = useState<{ target: EventTarget; issue: boolean } | null>(null),
    [spareExperiment, setSpareExperiment] = useState<string | null>(null),
    [arrangeGroup, setArrangeGroup] = useState<string | null>(null),
    [temporary, setTemporary] = useState(false);
  const [issuesExperiment, setIssuesExperiment] = useState<string | null>(null);
  const [reasonPrompt, setReasonPrompt] = useState<{
    type: 'skip' | 'interrupt';
    itemId: string;
  } | null>(null);
  const [reasonText, setReasonText] = useState('');
  const actionGate = useRef(0),
    actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [actionGuard, setActionGuard] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const { open: openMenu, menu: rowMenu } = useContextMenu();
  const filesWorking = useRef(false);
  const composing = useRef(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const hintRef = useRef<{ id: string; where: 'before' | 'after' } | null>(null);
  const [dropHint, setDropHint] = useState<{
    id: string;
    where: 'before' | 'after';
    label: string;
  } | null>(null);
  const [draggingId, setDraggingId] = useState('');
  useEffect(
    () => () => {
      if (actionTimer.current) clearTimeout(actionTimer.current);
    },
    [],
  );
  // 全局键盘快捷键：F8 开始/完成
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // 不拦截在 input/textarea/select/contenteditable 或 IME composition 时的事件
      if (
        event.repeat ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        composing.current ||
        event.keyCode === 229
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)
      ) {
        return;
      }
      // 检查是否有打开的对话框
      if (document.querySelector('dialog[open]')) {
        return;
      }

      if (event.code === 'F8' && selected && !actionGuard && busy === 0) {
        event.preventDefault();
        if (selected.status === 'pending') {
          void action('start');
        } else if (selected.status === 'running') {
          void action('finish');
        }
      }
    }
    const compositionStart = () => {
      composing.current = true;
    };
    const compositionEnd = () => {
      composing.current = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('compositionstart', compositionStart);
    window.addEventListener('compositionend', compositionEnd);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', compositionStart);
      window.removeEventListener('compositionend', compositionEnd);
    };
  }, [selected, busy, actionGuard]);
  const sample = selected && snapshot.samples.find((s) => s.id === selected.sampleId)!;
  const run = selected && snapshot.runs.find((r) => r.itemId === selected.id);
  const startedClockLabel = run ? recordedStartLabel(run) : '';
  const fileLabel = actualFilenameLabel(run || undefined);
  const group = sample && snapshot.groups.find((g) => g.id === sample.groupId)!;
  const displayedGroup =
    run?.snapshot.group || (group && sample && selected && plannedGroup(group, sample, selected));
  const liveSize = displayedGroup ? operationSizeLine(displayedGroup, run || undefined) : '';
  const liveMaterials = displayedGroup ? materialSummary(displayedGroup) : '';
  const liveDrift =
    run && group && sample && selected
      ? laterPlanDrift(run.snapshot.group, plannedGroup(group, sample, selected))
      : '';
  const liveProtocol = actualProtocolLabel(run);
  const liveRecorded = recordedPlanSearchText(run);
  const completed = items.filter((i) => i.status === 'completed').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const interrupted = items.filter((i) => i.status === 'interrupted').length;
  const insights = reportInsights(snapshot, experimentId);
  const spareLabel = spareProgressLabel(
    insights.spareKnown,
    insights.unknownPreparation,
    snapshot.groups.filter((entry) => entry.experimentId === experimentId).length,
  );
  const currentSpare = group ? groupSpareLabel(groupCounts(snapshot, group).spare) : '';
  const upcoming = nextOperationBrief(snapshot, experimentId);
  const firstGap = followUpRoster(snapshot, experimentId)[0];
  const recent = latestRecorded(snapshot, experimentId);
  const recentRun = recent
    ? snapshot.runs.find((entry) => entry.itemId === recent.itemId)
    : undefined;
  const recentNeedsFile =
    !!recentRun &&
    !recentRun.actual.filename &&
    !recentRun.actual.scanId &&
    !recentRun.actual.files;
  const source = selected ? repeatSource(snapshot, selected) : null;
  const driftIds = new Set(
    items.filter((item) => operationPlanDrift(snapshot, item)).map((item) => item.id),
  );
  const visible = items.filter((item) => {
    const text = queueSearchText(snapshot, item);
    return (
      (filter === 'all' ||
        (filter === 'followup'
          ? rosterIds.has(item.id)
          : filter === 'drift'
            ? driftIds.has(item.id)
            : item.status === filter)) &&
      (textIncludes(text, search) || matchesOperationIdentity(snapshot, item, search))
    );
  });
  async function exportReport() {
    const targetExperiment = experimentId;
    setExporting(true);
    try {
      await flush();
      const result = await unwrap(window.labrecord.exportReport(targetExperiment));
      if (result)
        notify(
          `实验报告已生成：${result.localPath}${result.archiveState === 'pending' ? ' · 等待上传到私人库' : result.archiveError ? ' · 云端归档未成功：' + result.archiveError : ''}`,
          result.archiveState === 'failed',
        );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setExporting(false);
    }
  }
  async function action(type: 'start' | 'finish' | 'interrupt' | 'skip' | 'unskip' | 'repeat') {
    if (!selected || busy > 0 || actionGuard || performance.now() < actionGate.current) return;
    const targetId = selected.id;
    const allowed = (data: ReturnType<typeof workspace.getSnapshot>) => {
      const status = data.items.find((i) => i.id === targetId)?.status;
      if (type === 'start')
        return status === 'pending' && !data.items.some((i) => i.status === 'running');
      if (type === 'finish' || type === 'interrupt') return status === 'running';
      if (type === 'skip') return status === 'pending';
      if (type === 'unskip') return status === 'skipped';
      return status === 'completed' || status === 'interrupted';
    };
    if (!allowed(workspace.getSnapshot())) return;
    actionGate.current = performance.now() + 450;
    setActionGuard(true);
    try {
      await flush();
      if (allowed(workspace.getSnapshot()))
        await execute(
          { type, itemId: targetId },
          type === 'start' || type === 'finish' || type === 'repeat',
        );
    } catch {
    } finally {
      actionTimer.current = setTimeout(
        () => setActionGuard(false),
        Math.max(0, actionGate.current - performance.now()),
      );
    }
  }
  function choose(id: string) {
    void flush()
      .then(() => {
        setItemId(id);
        setQueueOpen(false);
      })
      .catch((error) => notify(error.message, true));
  }
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        composing.current ||
        event.keyCode === 229 ||
        busy > 0 ||
        actionGuard
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select') || target.isContentEditable)
      )
        return;
      if (document.querySelector('dialog[open], [role="menu"]')) return;
      const index = items.findIndex((item) => item.id === selected?.id);
      const next = items[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (index < 0 || !next) return;
      event.preventDefault();
      choose(next.id);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, selected, busy, actionGuard]);
  async function commitOrder(ids: string[] | null) {
    if (!ids) return false;
    try {
      await flush();
      const current = workspace
        .getSnapshot()
        .items.filter((entry) => entry.experimentId === experimentId)
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.id);
      if (
        ids.length !== current.length ||
        new Set(ids).size !== ids.length ||
        current.some((id) => !ids.includes(id))
      ) {
        notify('队列已变化，请重新排序。', true);
        return false;
      }
      if (ids.every((id, index) => id === current[index])) return false;
      await execute({ type: 'reorder', experimentId, ids }, false);
      return true;
    } catch (error) {
      notify((error as Error).message, true);
      return false;
    }
  }
  async function move(item: PlanItem, direction: number) {
    const index = items.findIndex((entry) => entry.id === item.id);
    const neighbor = items[index + direction];
    if (!neighbor) return;
    const hidden = !visible.some((entry) => entry.id === neighbor.id);
    const moved = await commitOrder(
      swapAdjacent(
        items.map((entry) => entry.id),
        item.id,
        direction < 0 ? -1 : 1,
      ),
    );
    if (moved && hidden) notify('已与被隐藏的相邻操作交换。');
  }
  function gripDown(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    dragRef.current = { id, x: event.clientX, y: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function gripMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    if (!drag.active) setDraggingId(drag.id);
    drag.active = true;
    const row = (
      document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    )?.closest('.queue-row');
    const target = row?.getAttribute('data-item-id');
    if (!row || !target || target === drag.id) {
      hintRef.current = null;
      setDropHint(null);
      return;
    }
    const rect = row.getBoundingClientRect();
    const where = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const next = placeId(
      items.map((entry) => entry.id),
      drag.id,
      target,
      where,
    );
    hintRef.current = { id: target, where };
    setDropHint({
      id: target,
      where,
      label: `插到完整队列第 ${next ? next.indexOf(drag.id) + 1 : 0} 位`,
    });
  }
  function gripUp() {
    const drag = dragRef.current;
    const hint = hintRef.current;
    dragRef.current = null;
    hintRef.current = null;
    setDraggingId('');
    setDropHint(null);
    if (!drag?.active || !hint) return;
    void commitOrder(
      placeId(
        items.map((entry) => entry.id),
        drag.id,
        hint.id,
        hint.where,
      ),
    );
  }
  function onQueueKey(event: React.KeyboardEvent, item: PlanItem) {
    if (
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.repeat ||
      event.nativeEvent.isComposing ||
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
    )
      return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.queue-index, .queue-choice')) return;
    event.preventDefault();
    void move(item, event.key === 'ArrowUp' ? -1 : 1);
  }
  let proposed = '';
  if (sample) {
    try {
      proposed =
        run?.filename ||
        selected?.plannedName ||
        (selected
          ? reserveMeasurementNames(snapshot, experimentId, [selected])[0].plannedName!
          : '');
    } catch (error) {
      proposed = (error as Error).message;
    }
  }
  async function copy() {
    const targetId = selected?.id;
    if (!targetId) return;
    try {
      await flush();
      let data = workspace.getSnapshot();
      let item = data.items.find((entry) => entry.id === targetId);
      let record = data.runs.find((entry) => entry.itemId === targetId);
      if (!item) throw new Error('当前操作已变化，请重新选择。');
      if (!record && !item.plannedName) {
        await execute({ type: 'configureMeasurements', ids: [targetId], measurement: {} }, false);
        data = workspace.getSnapshot();
        item = data.items.find((entry) => entry.id === targetId);
        record = data.runs.find((entry) => entry.itemId === targetId);
      }
      const name = record?.filename || item?.plannedName;
      if (!name) throw new Error('还没有数据文件夹名。');
      await unwrap(window.labrecord.copyName(name));
      notify('数据文件夹名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制，请选中文件名后手动复制。', true);
    }
  }
  async function copySampleId() {
    const targetId = selected?.id;
    if (!targetId) return;
    try {
      await flush();
      const data = workspace.getSnapshot();
      const item = data.items.find((entry) => entry.id === targetId);
      const record = data.runs.find((entry) => entry.itemId === targetId);
      const id =
        record?.snapshot.sample.id || data.samples.find((entry) => entry.id === item?.sampleId)?.id;
      if (!id) throw new Error('还没有样品 ID。');
      await unwrap(window.labrecord.copyName(id));
      notify('样品 ID 已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制样品 ID。', true);
    }
  }
  async function copyUpcomingFolder() {
    try {
      await flush();
      const fresh = nextOperationBrief(workspace.getSnapshot(), experimentId);
      const name = fresh?.folder || '';
      if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
      await unwrap(window.labrecord.copyName(name));
      notify('下一项数据文件夹名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制下一项数据文件夹名。', true);
    }
  }
  async function copyUpcomingProtocol() {
    try {
      await flush();
      const fresh = nextOperationBrief(workspace.getSnapshot(), experimentId);
      const text = protocolCopyText(fresh?.protocol);
      if (!canCopyProtocol(text)) throw new Error('还没有可复制的实验制度。');
      await unwrap(window.labrecord.copyText(text));
      notify('下一项实验制度已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制下一项实验制度。', true);
    }
  }
  async function copyDisplayedProtocol() {
    try {
      await flush();
      const data = workspace.getSnapshot();
      const item = selected && data.items.find((entry) => entry.id === selected.id);
      if (!item) throw new Error('还没有可复制的实验制度。');
      const record = data.runs.find((entry) => entry.itemId === item.id);
      const current = data.samples.find((entry) => entry.id === item.sampleId);
      const stored = data.groups.find((entry) => entry.id === current?.groupId);
      const sample = record?.snapshot.sample || current;
      const protocolGroup =
        record?.snapshot.group ||
        (stored && sample ? plannedGroup(stored, sample, item) : undefined);
      const text = protocolCopyText(protocolGroup?.protocol);
      if (!canCopyProtocol(text)) throw new Error('还没有可复制的实验制度。');
      await unwrap(window.labrecord.copyText(text));
      notify(record ? '开始时的实验制度已复制。' : '实验制度已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制实验制度。', true);
    }
  }
  async function copyRecentScan() {
    try {
      await flush();
      const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
      const name = fresh?.scanId || '';
      if (!canCopyName(name)) throw new Error('还没有可复制的扫描编号。');
      await unwrap(window.labrecord.copyName(name));
      notify('最近记录的扫描编号已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制最近记录的扫描编号。', true);
    }
  }
  async function copyRecentFile() {
    try {
      await flush();
      const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
      const name = fresh?.filename || '';
      if (!canCopyName(name)) throw new Error('还没有可复制的实际文件名。');
      await unwrap(window.labrecord.copyName(name));
      notify('最近记录的实际文件名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制最近记录的实际文件名。', true);
    }
  }
  async function copyRecentFolder() {
    try {
      await flush();
      const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
      const name = fresh?.folder || '';
      if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
      await unwrap(window.labrecord.copyName(name));
      notify('最近记录的数据文件夹名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制最近记录的数据文件夹名。', true);
    }
  }
  async function copyRunningFile() {
    try {
      await flush();
      const data = workspace.getSnapshot();
      const current = data.items.find((item) => item.status === 'running');
      const record = current && data.runs.find((run) => run.itemId === current.id);
      const name = String(record?.actual.filename || '').trim();
      if (!canCopyName(name)) throw new Error('还没有可复制的实际文件名。');
      await unwrap(window.labrecord.copyName(name));
      notify('进行中的实际文件名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制进行中的实际文件名。', true);
    }
  }
  async function copyRunningScan() {
    try {
      await flush();
      const data = workspace.getSnapshot();
      const current = data.items.find((item) => item.status === 'running');
      const record = current && data.runs.find((run) => run.itemId === current.id);
      const name = String(record?.actual.scanId || '').trim();
      if (!canCopyName(name)) throw new Error('还没有可复制的扫描编号。');
      await unwrap(window.labrecord.copyName(name));
      notify('进行中的扫描编号已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制进行中的扫描编号。', true);
    }
  }
  async function copyRunningFolder() {
    try {
      await flush();
      const data = workspace.getSnapshot();
      const current = data.items.find((item) => item.status === 'running');
      const record = current && data.runs.find((run) => run.itemId === current.id);
      const name = record?.filename || '';
      if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
      await unwrap(window.labrecord.copyName(name));
      notify('进行中的数据文件夹名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制进行中的数据文件夹名。', true);
    }
  }
  async function copyActual(key: 'filename' | 'scanId') {
    const targetId = selected?.id;
    if (!targetId) return;
    const label = key === 'scanId' ? '扫描编号' : '实际文件名';
    try {
      await flush();
      const record = workspace.getSnapshot().runs.find((entry) => entry.itemId === targetId);
      const text = String(record?.actual[key] || '');
      if (!canCopyName(text)) throw new Error(`还没有可复制的${label}。`);
      await unwrap(window.labrecord.copyName(text));
      notify(`${label}已复制。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : `无法复制${label}。`, true);
    }
  }
  function target(): EventTarget {
    return { itemId: selected!.id, experimentId: selected!.experimentId, runId: run?.id };
  }
  function openEvent(issue: boolean) {
    if (selected) setEventDialog({ target: target(), issue });
  }
  async function addImage(targetRunId: string) {
    if (filesWorking.current) return;
    filesWorking.current = true;
    setFileBusy(true);
    try {
      await flush();
      const result = await unwrap(window.labrecord.addAttachment(targetRunId));
      await flush();
      if (result) workspace.replace(await unwrap(window.labrecord.snapshot()));
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      filesWorking.current = false;
      setFileBusy(false);
    }
  }
  async function removeImage(attachmentId: string) {
    if (filesWorking.current) return;
    filesWorking.current = true;
    setFileBusy(true);
    try {
      await flush();
      await unwrap(window.labrecord.removeAttachment(attachmentId));
      workspace.replace(await unwrap(window.labrecord.snapshot()));
      setPendingImage(null);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      filesWorking.current = false;
      setFileBusy(false);
    }
  }
  async function chooseFiles(targetRunId: string) {
    if (filesWorking.current) return;
    filesWorking.current = true;
    setFileBusy(true);
    try {
      await flush();
      const paths = await unwrap(window.labrecord.chooseReference());
      if (!paths.length) return;
      // Input can change while the native selector is open. Save it before reading the merge base.
      await flush();
      const latest = await unwrap(window.labrecord.snapshot());
      const latestRun = latest.runs.find((r) => r.id === targetRunId);
      if (!latestRun) throw new Error('运行记录不存在或已变更。');
      await execute(
        {
          type: 'saveRun',
          runId: targetRunId,
          actual: {
            files: [latestRun.actual.files, ...paths].filter(Boolean).join('\n'),
          },
        },
        false,
      );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      filesWorking.current = false;
      setFileBusy(false);
    }
  }
  const queue = (
    <aside className="queue card">
      <header>
        <h2>
          <List size={18} />
          待测队列
        </h2>
        <span>
          {filter !== 'all' || search ? `${visible.length} / ${items.length}` : items.length} 项
        </span>
      </header>
      <SearchField
        className="queue-search"
        label="搜索待测样品"
        placeholder="编号、样品 ID 或文件夹"
        value={search}
        onChange={setSearch}
      />
      <div className="queue-filters" role="group" aria-label="队列筛选">
        <button
          aria-label="全部"
          aria-pressed={filter === 'all'}
          className={filter === 'all' ? 'active' : ''}
          onClick={() => setFilter('all')}
        >
          全部 <span aria-hidden="true">{items.length}</span>
        </button>
        <button
          aria-label="待测"
          className={filter === 'pending' ? 'active' : ''}
          aria-pressed={filter === 'pending'}
          onClick={() => setFilter('pending')}
        >
          待测 <span aria-hidden="true">{pending}</span>
        </button>
        <button
          aria-label="已完成"
          className={filter === 'completed' ? 'active' : ''}
          aria-pressed={filter === 'completed'}
          onClick={() => setFilter('completed')}
        >
          已完成 <span aria-hidden="true">{completed}</span>
        </button>
        {rosterIds.size > 0 && (
          <button
            aria-label="待核对"
            aria-pressed={filter === 'followup'}
            className={filter === 'followup' ? 'active' : ''}
            onClick={() => setFilter('followup')}
          >
            待核对 <span aria-hidden="true">{rosterIds.size}</span>
          </button>
        )}
        {skipped > 0 && (
          <button
            aria-label="已跳过"
            aria-pressed={filter === 'skipped'}
            className={filter === 'skipped' ? 'active' : ''}
            onClick={() => setFilter('skipped')}
          >
            已跳过 <span aria-hidden="true">{skipped}</span>
          </button>
        )}
        {driftIds.size > 0 && (
          <button
            aria-label="计划已变"
            aria-pressed={filter === 'drift'}
            className={filter === 'drift' ? 'active' : ''}
            onClick={() => setFilter('drift')}
          >
            计划已变 <span aria-hidden="true">{driftIds.size}</span>
          </button>
        )}
        {interrupted > 0 && (
          <button
            aria-label="已中断"
            aria-pressed={filter === 'interrupted'}
            className={filter === 'interrupted' ? 'active' : ''}
            onClick={() => setFilter('interrupted')}
          >
            已中断 <span aria-hidden="true">{interrupted}</span>
          </button>
        )}
      </div>
      <div className="queue-list" ref={queueListRef}>
        {visible.map((item) => {
          const history = snapshot.runs.find((run) => run.itemId === item.id);
          const sample =
            history?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId)!;
          const storedGroup = snapshot.groups.find((entry) => entry.id === sample.groupId);
          const group =
            history?.snapshot.group ||
            (storedGroup ? plannedGroup(storedGroup, sample, item) : storedGroup!);
          const repeated = !!item.repeatOf;
          const source = repeatSource(snapshot, item);
          const statusReason = operationStatusReason(snapshot, item);
          const size = operationSizeLine(group, history);
          const protocolLabel = operationProtocolLabel(snapshot, item);
          const materials = materialSummary(group);
          const liveSample = snapshot.samples.find((entry) => entry.id === item.sampleId);
          const liveGroup = snapshot.groups.find((entry) => entry.id === liveSample?.groupId);
          const drift =
            history && liveSample && liveGroup
              ? laterPlanDrift(history.snapshot.group, plannedGroup(liveGroup, liveSample, item))
              : '';
          const queueIndex = items.findIndex((entry) => entry.id === item.id);
          const deleteReason = itemsDeleteReason(snapshot, [item.id]);
          const rowMenu = [
            { kind: 'item' as const, label: '选择', onSelect: () => choose(item.id) },
            {
              kind: 'item' as const,
              label: '上移',
              disabled: queueIndex <= 0,
              onSelect: () => void move(item, -1),
            },
            {
              kind: 'item' as const,
              label: '下移',
              disabled: queueIndex < 0 || queueIndex >= items.length - 1,
              onSelect: () => void move(item, 1),
            },
            { kind: 'separator' as const },
            {
              kind: 'item' as const,
              label: deleteReason
                ? item.status === 'running'
                  ? '删除未开始的测量（进行中）'
                  : '删除未开始的测量（已有记录）'
                : '删除未开始的测量',
              disabled: !!deleteReason,
              danger: true,
              title: deleteReason || undefined,
              onSelect: () => setPendingDelete(itemsDeleteRequest(snapshot, [item.id])),
            },
          ];
          return (
            <div
              className={`queue-row ${selected?.id === item.id ? 'current' : ''} ${
                dropHint?.id === item.id ? `drop-${dropHint.where}` : ''
              } ${draggingId === item.id ? 'is-dragging' : ''}`}
              key={item.id}
              data-item-id={item.id}
              onKeyDown={(event) => onQueueKey(event, item)}
              onContextMenu={(event) => openMenu(event, rowMenu)}
            >
              <div className="queue-line">
                <button
                  type="button"
                  className="queue-grip queue-index"
                  aria-label={`拖动调整样品 ${sample.code} 的完整队列顺序`}
                  onPointerDown={(event) => gripDown(event, item.id)}
                  onPointerMove={gripMove}
                  onPointerUp={gripUp}
                  onPointerCancel={gripUp}
                >
                  {String(item.order + 1).padStart(2, '0')}
                </button>
                <button
                  className="queue-choice"
                  aria-label={`选择样品 ${sample.code} 操作 ${item.order + 1}`}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => choose(item.id)}
                >
                  <div>
                    <strong>{sample.parameters.name?.trim() || sample.code}</strong>
                    <small>
                      {sample.parameters.name?.trim()
                        ? `${sample.code} · ${group.state}`
                        : sampleName(group)}
                      {repeated ? ' · 重测安排' : ''}
                    </small>
                    {(item.measurement || history?.snapshot.measurement) && (
                      <small>{measurementSummary(measurementFor(snapshot, item))}</small>
                    )}
                    {protocolLabel && (
                      <small className="queue-protocol" title={protocolLabel}>
                        {protocolLabel}
                      </small>
                    )}
                    {size && <small>{size}</small>}
                    {drift && <small>当前计划已不同：{drift}</small>}
                    {actualProtocolLabel(history) && <small>{actualProtocolLabel(history)}</small>}
                    {recordedPlanSearchText(history) && (
                      <small>{recordedPlanSearchText(history)}</small>
                    )}
                    {materials && <small>{materials}</small>}
                    {history && <small>用时 {runDurationLabel(history)}</small>}
                    {recordedStartLabel(history) && <small>{recordedStartLabel(history)}</small>}
                    {recordedEndLabel(history) && <small>{recordedEndLabel(history)}</small>}
                    {(history ? history.filename : item.plannedName) && (
                      <small>{history ? history.filename : item.plannedName}</small>
                    )}
                    {history?.actual.scanId && <small>扫描 {history.actual.scanId}</small>}
                    {actualFilenameLabel(history) && <small>{actualFilenameLabel(history)}</small>}
                    {pictureLabel(snapshot, history?.id) && (
                      <small>{pictureLabel(snapshot, history?.id)}</small>
                    )}
                    {source && (
                      <small>
                        重测自 {source.sampleCode}
                        {source.scanId ? ` · 扫描 ${source.scanId}` : ''}
                        {source.folder ? ` · ${source.folder}` : ''}
                        {repeatSourceIssueLabel(snapshot, item)
                          ? ` · ${repeatSourceIssueLabel(snapshot, item)}`
                          : ''}
                      </small>
                    )}
                    <span className="queue-status">
                      <StatusPill status={item.status} />
                      <PriorityPill value={group.priority} />
                    </span>
                    {statusReason && <small>原因：{statusReason}</small>}
                    {followUpLabels(item.id, followUps).map((label) => (
                      <small key={label} className="queue-gap">
                        {label}
                      </small>
                    ))}
                  </div>
                </button>
                <button
                  type="button"
                  className="queue-more"
                  aria-label={`更多 ${sample.code}`}
                  aria-haspopup="menu"
                  onClick={(event) => openMenu(event, rowMenu)}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
              {selected?.id === item.id && (
                <div className="queue-order">
                  <button
                    aria-label="向上调整顺序"
                    disabled={item.order === items[0]?.order}
                    onClick={() => {
                      void move(item, -1);
                    }}
                  >
                    <ArrowUp size={13} />
                    上移
                  </button>
                  <button
                    aria-label="向下调整顺序"
                    disabled={item.order === items[items.length - 1]?.order}
                    onClick={() => {
                      void move(item, 1);
                    }}
                  >
                    <ArrowDown size={13} />
                    下移
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`删除未开始的测量 ${sample.code}`}
                    title={itemsDeleteReason(snapshot, [item.id]) || '删除这项还没开始的测量'}
                    disabled={!!itemsDeleteReason(snapshot, [item.id])}
                    onClick={() => setPendingDelete(itemsDeleteRequest(snapshot, [item.id]))}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!visible.length && (
          <div className="queue-empty">
            <p className="hint">{items.length ? '没有符合筛选条件的操作' : '还没有安排测量'}</p>
            {(filter !== 'all' || search) && (
              <button
                className="text-button"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
              >
                清除队列筛选
              </button>
            )}
          </div>
        )}
      </div>
      <footer>
        <span className="pulse-dot neutral" />
        {dropHint?.label ||
          '按住序号拖动可调整完整队列。Alt + 左右方向键只切换相邻操作，不开始。备样不在队列中。'}
        {group && (
          <button
            type="button"
            className="text-button"
            aria-label={enableGroupSpareLabel(groupCounts(snapshot, group).spare)}
            disabled={groupCounts(snapshot, group).spare === 0 || busy > 0}
            onClick={() => setArrangeGroup(group.id)}
          >
            {enableGroupSpareLabel(groupCounts(snapshot, group).spare)}
          </button>
        )}
      </footer>
    </aside>
  );
  const awayRun =
    globalRunning && globalRunning.id !== selected?.id
      ? snapshot.runs.find((entry) => entry.itemId === globalRunning.id)
      : undefined;
  const awayClock = awayRun
    ? recordedClock(awayRun.startedAt, awayRun.offsetMinutes, awayRun.timezone)
    : null;
  const awayCode =
    awayRun?.snapshot.sample.code ||
    snapshot.samples.find((entry) => entry.id === globalRunning?.sampleId)?.code ||
    '';
  const awayFolder = awayRun?.filename || '';
  const awayFile = actualFilenameLabel(awayRun);
  const awayScan = actualScanLabel(awayRun);
  const liveCode = (run ? run.snapshot.sample.code : sample?.code) || '';
  const liveGiven = (run ? run.snapshot.sample.parameters.name : sample?.parameters.name)?.trim();
  const liveName = liveGiven || (displayedGroup ? sampleName(displayedGroup) : '');
  const liveTitle =
    selected && liveCode
      ? !liveName || liveName === liveCode
        ? liveCode
        : `${liveCode} · ${liveName}`
      : '现场记录';
  return (
    <div className={`page live-page${focused ? ' is-focused' : ''}`}>
      <div className="page-heading compact-heading">
        <div>
          <h1>{liveTitle}</h1>
          <p className="live-progress">
            <progress aria-label="完成进度" value={completed} max={Math.max(1, items.length)} />
            <span>
              完成 {completed}/{items.length} · 待测 {pending} · {spareLabel}
              {skipped ? ` · 跳过 ${skipped}` : ''}
              {interrupted ? ` · 中断 ${interrupted}` : ''}
            </span>
            {currentSpare && <span>{currentSpare}</span>}
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button focus-toggle"
            aria-pressed={focused}
            onClick={() => setFocused(!focused)}
          >
            {focused ? '退出专注' : '专注当前样品'}
          </button>
          <button className="button" onClick={() => setQueueOpen(true)}>
            <List size={16} />
            队列与搜索
          </button>
          <button
            className="button more-actions-toggle"
            onClick={() =>
              setMoreTarget({ itemId: selected?.id || '', experimentId, runId: run?.id })
            }
          >
            更多操作 <ChevronDown size={16} />
          </button>
          <button
            className="button focus-secondary"
            onClick={() => setIssuesExperiment(experimentId)}
          >
            <AlertTriangle size={16} />
            未处理问题（
            {
              snapshot.events.filter(
                (e) => e.experimentId === experimentId && e.type === 'issue' && !e.data.resolvedAt,
              ).length
            }
            ）
          </button>
          {items.length > 0 &&
            !items.some((item) => item.status === 'pending' || item.status === 'running') && (
              <button
                className="button primary focus-secondary"
                disabled={Boolean(busy) || exporting}
                onClick={() => void exportReport()}
              >
                <FileText size={16} />
                {exporting ? '正在生成报告…' : '导出本次报告'}
              </button>
            )}
          <button
            className="button focus-secondary"
            disabled={busy > 0}
            onClick={() => {
              void flush()
                .then(() => setTemporary(true))
                .catch((error) => notify(error.message, true));
            }}
          >
            <Plus size={16} />
            临时样品
          </button>
          <button
            className="button focus-secondary"
            disabled={busy > 0}
            onClick={() => {
              const targetExperiment = experimentId;
              void flush()
                .then(() => setSpareExperiment(targetExperiment))
                .catch((error) => notify(error.message, true));
            }}
          >
            <LayersIcon />
            启用备样
          </button>
          <button
            className="button timeline-toggle focus-secondary"
            onClick={() => setTimelineTarget({ itemId: selected?.id || '', experimentId })}
          >
            <Clock size={17} />
            时间线
          </button>
        </div>
      </div>
      {globalRunning && globalRunning.id !== selected?.id && (
        <div className="running-banner" role="region" aria-label="现场进行中的操作">
          <span>
            <span className="pulse-dot" />
            <span className="running-banner-text">
              当前还有进行中的操作：{awayCode}
              {awayClock ? ` · ${awayClock.clock} ${awayClock.zone}` : ''}
              {awayFolder ? ` · ${awayFolder}` : ''}
              {awayFile ? ` · ${awayFile}` : ''}
              {awayScan ? ` · ${awayScan}` : ''}
            </span>
            {canCopyName(awayFolder) && (
              <button
                type="button"
                className="text-button"
                aria-label="复制进行中的数据文件夹"
                onClick={() => {
                  void copyRunningFolder();
                }}
              >
                复制文件夹
              </button>
            )}
            {canCopyName(String(awayRun?.actual.filename || '').trim()) && (
              <button
                type="button"
                className="text-button"
                aria-label="复制进行中的实际文件名"
                onClick={() => {
                  void copyRunningFile();
                }}
              >
                复制文件名
              </button>
            )}
            {canCopyName(String(awayRun?.actual.scanId || '').trim()) && (
              <button
                type="button"
                className="text-button"
                aria-label="复制进行中的扫描编号"
                onClick={() => {
                  void copyRunningScan();
                }}
              >
                复制扫描编号
              </button>
            )}
          </span>
          <button
            className="text-button"
            onClick={() => {
              void flush()
                .then(() => {
                  setExperimentId(globalRunning.experimentId);
                  setItemId(globalRunning.id);
                })
                .catch((error) => notify(error.message, true));
            }}
          >
            返回当前操作 <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="live-layout">
        {!focused && !queueOpen && queue}
        {!selected ? (
          <section className="card current-card">
            <Empty title="还没有待测样品" description="回到实验规划，把要测的样品加入队列。">
              <button
                className="button primary"
                onClick={() => {
                  void flush()
                    .then(() => setPage('plan'))
                    .catch((error) => notify(error.message, true));
                }}
              >
                返回实验规划 <ArrowRight size={16} />
              </button>
            </Empty>
          </section>
        ) : (
          <section className="card current-card" key={selected.id}>
            <div className="current-controls">
              <header className="current-heading">
                <div>
                  <span className="eyebrow">
                    {selected.status === 'running' ? '正在操作' : '正在查看'} · 操作{' '}
                    {String(selected.order + 1).padStart(2, '0')}
                  </span>
                  <h2>
                    {(run ? run.snapshot.sample.parameters.name : sample.parameters.name)?.trim() ||
                      run?.snapshot.sample.code ||
                      sample.code}
                  </h2>
                  <p title={liveSize || undefined}>
                    {(run
                      ? run.snapshot.sample.parameters.name
                      : sample.parameters.name
                    )?.trim() ? (
                      <strong>
                        {run?.snapshot.sample.code || sample.code} · {displayedGroup.state}
                        {liveSize ? ` · ${liveSize}` : ''}
                      </strong>
                    ) : (
                      <>
                        <strong>{run?.actualSample?.name || sampleName(displayedGroup)}</strong>
                        {displayedGroup.name ? ` · ${displayedGroup.state}` : ''}
                        {liveSize ? ` · ${liveSize}` : ''}
                      </>
                    )}
                  </p>
                  {liveMaterials && <p className="current-material">{liveMaterials}</p>}
                  {liveDrift && <p className="plan-drift">当前计划已不同：{liveDrift}</p>}
                  {liveProtocol && <p className="actual-protocol">{liveProtocol}</p>}
                  {liveRecorded && <p className="recorded-plan">{liveRecorded}</p>}
                  <p className="next-step">
                    {selected.status === 'pending' &&
                    globalRunning &&
                    globalRunning.id !== selected.id
                      ? '待测。先完成正在进行的操作。'
                      : selected.status === 'pending'
                        ? '待测。下一步：开始。'
                        : selected.status === 'running'
                          ? '进行中。下一步：完成。'
                          : selected.status === 'completed'
                            ? '已完成。'
                            : selected.status === 'skipped'
                              ? '已跳过。'
                              : '已中断。'}
                    {operationStatusReason(snapshot, selected)
                      ? `原因：${operationStatusReason(snapshot, selected)}`
                      : ''}
                    {startedClockLabel ? ` ${startedClockLabel}` : ''}
                    {fileLabel ? ` ${fileLabel}` : ''}
                  </p>
                  {latestEndedMark(snapshot, selected.id) && (
                    <p className="latest-ended">{latestEndedMark(snapshot, selected.id)}</p>
                  )}
                  {recordedEndLabel(run) && <p className="recorded-end">{recordedEndLabel(run)}</p>}
                  {followUpLabels(selected.id, followUps).length > 0 && (
                    <ul className="current-gaps" aria-label="待核对">
                      {followUpLabels(selected.id, followUps).map((label) => (
                        <li key={label}>
                          <button
                            type="button"
                            className="current-gap"
                            onClick={() => {
                              if (label === '时间不完整') {
                                setTimesTarget({
                                  itemId: selected.id,
                                  experimentId,
                                  runId: run?.id,
                                });
                                return;
                              }
                              if (label === '文件未关联') {
                                setActualOpen(true);
                                return;
                              }
                              if (label === '未处理问题') setIssuesExperiment(experimentId);
                            }}
                          >
                            {label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="current-state">
                  <StatusPill status={selected.status} />
                  <ElapsedTime
                    startedAt={run?.startedAt || null}
                    endedAt={run?.endedAt || null}
                    running={selected.status === 'running'}
                  />
                </div>
              </header>
              {(selected.measurement?.regime ||
                selected.measurement?.technique ||
                selected.measurement?.batch) && (
                <div className="measurement-current-summary">
                  {measurementSummary(measurementFor(snapshot, selected))}
                </div>
              )}
              <div className="operation-actions">
                {selected.status === 'pending' && (
                  <>
                    <button
                      className="button primary start-button"
                      disabled={busy > 0 || actionGuard || !!globalRunning}
                      onClick={() => {
                        void action('start');
                      }}
                      aria-keyshortcuts="F8"
                      title="快捷键：F8"
                    >
                      <Play size={19} />
                      开始操作 <kbd aria-hidden="true">F8</kbd>
                    </button>
                    <button
                      className="button"
                      disabled={busy > 0 || actionGuard}
                      onClick={() => {
                        void action('skip');
                      }}
                    >
                      <SkipForward size={17} />
                      跳过
                    </button>
                    <button
                      className="text-button"
                      disabled={busy > 0 || actionGuard}
                      onClick={() => {
                        setReasonText('');
                        setReasonPrompt({ type: 'skip', itemId: selected.id });
                      }}
                    >
                      写原因后跳过
                    </button>
                  </>
                )}
                {selected.status === 'running' && (
                  <>
                    <button
                      className="button primary finish-button"
                      disabled={busy > 0 || actionGuard}
                      onClick={() => {
                        void action('finish');
                      }}
                      aria-keyshortcuts="F8"
                      title="快捷键：F8"
                    >
                      <Check size={20} />
                      完成并切换下一项 <kbd aria-hidden="true">F8</kbd> <ArrowRight size={18} />
                    </button>
                    <button
                      className="button"
                      disabled={busy > 0 || actionGuard}
                      onClick={() => {
                        void action('interrupt');
                      }}
                    >
                      <Square size={16} />
                      中断
                    </button>
                    <button
                      className="text-button"
                      disabled={busy > 0 || actionGuard}
                      onClick={() => {
                        setReasonText('');
                        setReasonPrompt({ type: 'interrupt', itemId: selected.id });
                      }}
                    >
                      写原因后中断
                    </button>
                  </>
                )}
                {(selected.status === 'completed' || selected.status === 'interrupted') && (
                  <button
                    className="button"
                    disabled={busy > 0 || actionGuard}
                    onClick={() => {
                      void action('repeat');
                    }}
                  >
                    <RotateCcw size={17} />
                    安排重测
                  </button>
                )}
                {selected.status === 'skipped' && (
                  <button
                    className="button"
                    disabled={busy > 0 || actionGuard}
                    onClick={() => {
                      void action('unskip');
                    }}
                  >
                    <RotateCcw size={17} />
                    恢复到待测队列
                  </button>
                )}
              </div>
            </div>
            {run && (
              <QuickRecordBar itemId={selected.id} experimentId={experimentId} runId={run.id} />
            )}
            <div className="record-section">
              <div className="section-title">
                <h3>
                  <FileText size={17} />
                  现场备注
                </h3>
                <span>自动保存</span>
              </div>
              {run ? (
                <AutoInput
                  key={run.id}
                  label="现场备注"
                  multiline
                  value={run.notes}
                  onSave={(notes) => execute({ type: 'saveRun', runId: run.id, notes }, false)}
                  placeholder="直接记录变化、观察现象或注意事项…"
                  className="live-notes"
                />
              ) : (
                <div className="note-before-start">
                  <p>开始后可以直接编辑现场备注。</p>
                  <button className="text-button" onClick={() => openEvent(false)}>
                    开始前先记一条信息 <Plus size={14} />
                  </button>
                </div>
              )}
            </div>
            <div className="quick-record-actions" role="group" aria-label="现场快速记录">
              <button className="button issue-button" onClick={() => openEvent(true)}>
                <AlertTriangle size={17} />
                记录问题
              </button>
              <button className="button" onClick={() => openEvent(false)}>
                <Plus size={16} />
                添加时间线记录
              </button>
              <button
                className="button"
                disabled={!run || fileBusy}
                onClick={() => {
                  if (run) void addImage(run.id);
                }}
              >
                <ImagePlus size={17} />
                添加图片
              </button>
            </div>
            <div className="filename-card current-folder-card">
              <div>
                <span>数据文件夹</span>
                <code>{proposed}</code>
              </div>
              <button
                className="icon-button"
                aria-label="复制数据文件夹名"
                title="复制数据文件夹名"
                onClick={copy}
              >
                <Copy size={17} />
              </button>
            </div>
            {source && (
              <div className="next-pending-indicator" role="region" aria-label="重测来源">
                <div>
                  <strong>重测自 {source.sampleCode}</strong>
                  {source.scanId && <span>扫描 {source.scanId}</span>}
                  {source.folder && <span>{source.folder}</span>}
                  {selected && repeatSourceIssueLabel(snapshot, selected) && (
                    <span>{repeatSourceIssueLabel(snapshot, selected)}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`查看原操作 ${source.sampleCode}`}
                  onClick={() => {
                    void flush()
                      .then(() => setItemId(source.itemId))
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  查看原操作
                </button>
              </div>
            )}
            {recent && recent.itemId !== selected.id && (
              <div className="next-pending-indicator" role="region" aria-label="最近记录">
                <div>
                  <strong>
                    {recent.status === 'interrupted' ? '最近中断' : '最近完成'} {recent.sampleCode}
                  </strong>
                  {recent.duration && <span>{recent.duration}</span>}
                  {recent.endedClock && <span>{recent.endedClock}</span>}
                  {recent.scanId && <span>扫描 {recent.scanId}</span>}
                  {recent.fileLabel && <span>{recent.fileLabel}</span>}
                  {recent.folder && <span>{recent.folder}</span>}
                  {recent.openIssue && <span>{recent.openIssue}</span>}
                </div>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`查看最近记录 ${recent.sampleCode}`}
                  onClick={() => {
                    void flush()
                      .then(() => setItemId(recent.itemId))
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  查看
                </button>
                {canCopyName(recent.folder) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`复制最近记录文件夹 ${recent.sampleCode}`}
                    onClick={() => {
                      void copyRecentFolder();
                    }}
                  >
                    复制文件夹
                  </button>
                )}
                {canCopyName(recent.scanId) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`复制最近记录扫描编号 ${recent.sampleCode}`}
                    onClick={() => {
                      void copyRecentScan();
                    }}
                  >
                    复制扫描编号
                  </button>
                )}
                {canCopyName(recent.filename) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`复制最近记录文件名 ${recent.sampleCode}`}
                    onClick={() => {
                      void copyRecentFile();
                    }}
                  >
                    复制文件名
                  </button>
                )}
                {recentNeedsFile && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`填写最近记录的文件 ${recent.sampleCode}`}
                    onClick={() => {
                      void flush()
                        .then(() => {
                          openActualFor.current = recent.itemId;
                          setItemId(recent.itemId);
                        })
                        .catch((error) => notify(error.message, true));
                    }}
                  >
                    填写文件
                  </button>
                )}
              </div>
            )}
            {firstGap && firstGap.itemId !== selected.id && (
              <div className="next-pending-indicator" role="region" aria-label="现场先核对">
                <div>
                  <strong>先核对 {firstGap.sampleCode}</strong>
                  <span>{firstGap.gaps.join('、')}</span>
                </div>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`查看待核对 ${firstGap.sampleCode}`}
                  onClick={() => {
                    void flush()
                      .then(() => setItemId(firstGap.itemId))
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  去核对
                </button>
              </div>
            )}
            {upcoming && upcoming.itemId !== selected.id && (
              <div className="next-pending-indicator" role="region" aria-label="现场下一项">
                <ArrowRight size={16} />
                <div>
                  <strong>下一项 {upcoming.sampleCode}</strong>
                  {upcoming.measurement && <span>{upcoming.measurement}</span>}
                  {upcoming.preparation && <span>{upcoming.preparation}</span>}
                  {upcoming.protocol && <span title={upcoming.protocol}>{upcoming.protocol}</span>}
                  {upcoming.repeat && <span>{upcoming.repeat}</span>}
                  {upcoming.sourceIssue && <span>{upcoming.sourceIssue}</span>}
                  {upcoming.folder && <span>{upcoming.folder}</span>}
                </div>
                {upcoming.sourceIssue && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`查看下一项的原操作 ${upcoming.sampleCode}`}
                    onClick={() => {
                      void flush()
                        .then(() => {
                          const fresh = workspace.getSnapshot();
                          const item = fresh.items.find((entry) => entry.id === upcoming.itemId);
                          const source = item && repeatSource(fresh, item);
                          if (!source) throw new Error('原操作已不存在。');
                          setItemId(source.itemId);
                        })
                        .catch((error) => notify(error.message, true));
                    }}
                  >
                    查看原操作
                  </button>
                )}
                {canCopyName(upcoming.folder) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`复制下一项文件夹 ${upcoming.sampleCode}`}
                    onClick={() => {
                      void copyUpcomingFolder();
                    }}
                  >
                    复制文件夹
                  </button>
                )}
                {canCopyProtocol(upcoming.protocol) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`复制下一项实验制度 ${upcoming.sampleCode}`}
                    onClick={() => {
                      void copyUpcomingProtocol();
                    }}
                  >
                    复制制度
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  aria-label={`查看下一项 ${upcoming.sampleCode}`}
                  onClick={() => {
                    void flush()
                      .then(() => setItemId(upcoming.itemId))
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  查看
                </button>
              </div>
            )}
            {(materialSummary(displayedGroup) ||
              displayedGroup.preparation ||
              displayedGroup.notes) && (
              <details className="plan-reference">
                <summary>
                  计划制备与备注 <ChevronDown size={15} />
                </summary>
                <MaterialPreparationSummary value={displayedGroup} />
                {displayedGroup.preparation && (
                  <p>
                    <strong>制备 / 试剂：</strong>
                    {displayedGroup.preparation}
                  </p>
                )}
                {displayedGroup.notes && <p>{displayedGroup.notes}</p>}
              </details>
            )}
            {(displayedGroup.mode !== '未定' || displayedGroup.protocol?.trim()) && (
              <section className="protocol-card">
                {displayedGroup.mode !== '未定' ? (
                  run ? (
                    <>
                      <span>开始时的实验制度</span>
                      <p>{displayedGroup.protocol?.trim() || '开始时尚未填写'}</p>
                    </>
                  ) : (
                    <>
                      <span>实验制度</span>
                      <AutoInput
                        multiline
                        label="实验制度"
                        value={displayedGroup.protocol ?? ''}
                        placeholder={PROTOCOL_PLACEHOLDER}
                        onSave={(protocol) =>
                          execute(
                            {
                              type: 'configureMeasurements',
                              ids: [selected.id],
                              measurement: { protocol },
                            },
                            false,
                          )
                        }
                      />
                      <small>
                        {group.protocol?.trim()
                          ? '改这里只影响本次测量；同一样品的其他制度各自保留。'
                          : '开始后保留当时写下的制度，之后再改计划不会改掉这一次。'}
                      </small>
                    </>
                  )
                ) : (
                  <details>
                    <summary>仍保留实验制度</summary>
                    <p>{displayedGroup.protocol}</p>
                  </details>
                )}
                {canCopyProtocol(displayedGroup.protocol) && (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={run ? '复制开始时的实验制度' : '复制当前实验制度'}
                    onClick={() => {
                      void copyDisplayedProtocol();
                    }}
                  >
                    复制制度
                  </button>
                )}
              </section>
            )}
            <div className="parameter-summary">
              <div>
                <span>实验方式</span>
                <strong>{MODE_LABEL[displayedGroup.mode] || displayedGroup.mode}</strong>
              </div>
              <div>
                <span>优先级</span>
                <PriorityPill value={displayedGroup.priority} />
              </div>
              <div>
                <span>计划尺寸</span>
                <strong>{dimensions(displayedGroup)}</strong>
              </div>
            </div>
            <div className="time-card">
              <div>
                <span>
                  <Clock size={14} />
                  开始时间
                </span>
                <strong>
                  {run
                    ? recordedClock(run.startedAt, run.offsetMinutes, run.timezone)?.clock ||
                      '尚未记录'
                    : '尚未记录'}
                </strong>
                {run?.startedAt && (
                  <small>
                    {recordedClock(run.startedAt, run.offsetMinutes, run.timezone)?.zone}
                  </small>
                )}
              </div>
              <ArrowRight className="time-arrow" size={18} />
              <div>
                <span>结束时间</span>
                <strong>
                  {run
                    ? recordedClock(run.endedAt, run.offsetMinutes, run.timezone)?.clock ||
                      '尚未记录'
                    : '尚未记录'}
                </strong>
                {run?.endedAt && (
                  <small>{recordedClock(run.endedAt, run.offsetMinutes, run.timezone)?.zone}</small>
                )}
              </div>
              <button className="text-button time-edit" onClick={() => setTimesTarget(target())}>
                {run ? '修正时间' : '补录时间'}
              </button>
            </div>
            <div className="filename-card">
              <div>
                <span>样品 ID</span>
                <code>{run?.snapshot.sample.id || sample?.id}</code>
              </div>
              <button
                className="icon-button"
                aria-label="复制样品 ID"
                title="复制稳定样品 ID"
                onClick={() => {
                  void copySampleId();
                }}
              >
                <Copy size={17} />
              </button>
            </div>
            <div className="measurement-live-actions">
              {!run && (
                <button
                  className="button small"
                  onClick={() => {
                    void flush()
                      .then(() => setMeasurementDialog({ item: selected, append: false }))
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  配置制度
                </button>
              )}
              <button
                className="button small"
                onClick={() => {
                  void flush()
                    .then(() => setMeasurementDialog({ item: selected, append: true }))
                    .catch((error) => notify(error.message, true));
                }}
              >
                同样品追加制度
              </button>
            </div>
            {run && startedPlanChanges(run).length > 0 && (
              <ul className="plan-changes" aria-label="与开始时计划不同">
                {startedPlanChanges(run).map((change) => (
                  <li key={`${change.source}:${change.key}`}>
                    <span>{planChangeLabel(change)}</span>
                    <span>{change.planned}</span>
                    <span>{change.actual}</span>
                  </li>
                ))}
              </ul>
            )}
            {run && (
              <Details
                id="live-actual-files"
                title="实际参数与数据文件"
                open={actualOpen}
                onToggle={setActualOpen}
              >
                <p className="hint">
                  参数默认沿用计划；现场有变化时在这里调整。文件名和扫描编号可用于对应仪器数据。
                </p>
                <div className="form-grid">
                  <label className="field">
                    <span>
                      实际文件名 / 前缀
                      <button
                        type="button"
                        className="text-button field-copy"
                        aria-label="复制实际文件名"
                        disabled={!canCopyName(String(run.actual.filename || ''))}
                        onClick={() => {
                          void copyActual('filename');
                        }}
                      >
                        复制
                      </button>
                    </span>
                    <AutoInput
                      label="实际文件名"
                      value={String(run.actual.filename || '')}
                      onSave={(filename) =>
                        execute({ type: 'saveRun', runId: run.id, actual: { filename } }, false)
                      }
                      placeholder="仪器保存的名称"
                    />
                  </label>
                  <label className="field">
                    <span>
                      扫描编号
                      <button
                        type="button"
                        className="text-button field-copy"
                        aria-label="复制扫描编号"
                        disabled={!canCopyName(String(run.actual.scanId || ''))}
                        onClick={() => {
                          void copyActual('scanId');
                        }}
                      >
                        复制
                      </button>
                    </span>
                    <AutoInput
                      label="扫描编号"
                      value={String(run.actual.scanId || '')}
                      onSave={(scanId) =>
                        execute({ type: 'saveRun', runId: run.id, actual: { scanId } }, false)
                      }
                      placeholder="例如 scan_0123"
                    />
                  </label>
                  <label className="field">
                    <span>实际实验方式</span>
                    <AutoInput
                      label="实际实验方式"
                      value={String(run.actual.mode)}
                      onSave={(mode) =>
                        execute({ type: 'saveRun', runId: run.id, actual: { mode } }, false)
                      }
                      options={MODE_OPTIONS}
                    />
                  </label>
                  {((String(run.actual.mode) !== '未定' && !!run.actual.mode) ||
                    displayedGroup.mode !== '未定' ||
                    String(run.actual.protocol || '').trim()) && (
                    <label className="field span-2">
                      <span>实际实验制度</span>
                      <AutoInput
                        multiline
                        label="实际实验制度"
                        value={String(run.actual.protocol || '')}
                        onSave={(protocol) =>
                          execute({ type: 'saveRun', runId: run.id, actual: { protocol } }, false)
                        }
                        placeholder={displayedGroup.protocol || PROTOCOL_PLACEHOLDER}
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>实际厚度</span>
                    <div className="thickness-input">
                      <AutoInput
                        label="实际厚度"
                        value={String(run.actual.thickness || '')}
                        onSave={(thickness) =>
                          execute({ type: 'saveRun', runId: run.id, actual: { thickness } }, false)
                        }
                      />
                      <AutoInput
                        label="实际厚度单位"
                        value={String(run.actual.thicknessUnit || '')}
                        onSave={(thicknessUnit) =>
                          execute(
                            { type: 'saveRun', runId: run.id, actual: { thicknessUnit } },
                            false,
                          )
                        }
                        placeholder="单位"
                      />
                    </div>
                  </label>
                  <label className="field">
                    <span>实际样品名称</span>
                    <AutoInput
                      label="实际样品名称"
                      value={run.actualSample?.name || ''}
                      onSave={(name) =>
                        execute({ type: 'saveRun', runId: run.id, actualSample: { name } }, false)
                      }
                    />
                  </label>
                  {(['width', 'height', 'dimensionUnit'] as const).map((key) => (
                    <label className="field" key={key}>
                      <span>
                        {key === 'width'
                          ? '实际宽度'
                          : key === 'height'
                            ? '实际高度（可选）'
                            : '实际宽高单位'}
                      </span>
                      <AutoInput
                        label={
                          key === 'width'
                            ? '实际宽度'
                            : key === 'height'
                              ? '实际高度'
                              : '实际宽高单位'
                        }
                        value={run.actualSample?.[key] || ''}
                        onSave={(value) =>
                          execute(
                            { type: 'saveRun', runId: run.id, actualSample: { [key]: value } },
                            false,
                          )
                        }
                      />
                    </label>
                  ))}
                  <label className="field span-2">
                    <span>实际制备 / 试剂名称</span>
                    <AutoInput
                      label="实际制备或试剂名称"
                      value={String(run.actual.preparation || '')}
                      onSave={(preparation) =>
                        execute({ type: 'saveRun', runId: run.id, actual: { preparation } }, false)
                      }
                    />
                  </label>
                </div>
                <FieldInputs
                  fields={run.snapshot.fields}
                  values={run.actual}
                  save={(actual) => execute({ type: 'saveRun', runId: run.id, actual }, false)}
                />
                <label className="field">
                  <span>数据文件引用</span>
                  <AutoInput
                    label="数据文件引用"
                    multiline
                    value={String(run.actual.files || '')}
                    onSave={(files) =>
                      execute({ type: 'saveRun', runId: run.id, actual: { files } }, false)
                    }
                    placeholder="粘贴路径，或选择本地文件"
                  />
                </label>
                <button
                  className="button small"
                  disabled={fileBusy}
                  onClick={() => void chooseFiles(run.id)}
                >
                  <Link size={14} />
                  选择数据文件
                </button>
              </Details>
            )}
            {run && snapshot.attachments.some((a) => a.runId === run.id) && (
              <div className="attachment-grid">
                {snapshot.attachments
                  .filter((a) => a.runId === run.id)
                  .map((attachment) => (
                    <figure key={attachment.id}>
                      <img src={`labrecord://attachment/${attachment.id}`} alt={attachment.name} />
                      <figcaption>{attachment.name}</figcaption>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`移除图片 ${attachment.name}`}
                        disabled={fileBusy}
                        onClick={() => setPendingImage(attachment.id)}
                      >
                        移除
                      </button>
                    </figure>
                  ))}
              </div>
            )}
          </section>
        )}
        <aside className="card timeline-desktop">
          <Timeline itemId={selected?.id || ''} experimentId={experimentId} />
        </aside>
      </div>
      {queueOpen && (
        <Modal title="待测队列与搜索" className="queue-dialog" onClose={() => setQueueOpen(false)}>
          {queue}
        </Modal>
      )}
      {rowMenu}
      <DeleteConfirm pending={pendingDelete} onClose={() => setPendingDelete(null)} />
      {reasonPrompt && (
        <Modal
          title={reasonPrompt.type === 'skip' ? '写原因后跳过' : '写原因后中断'}
          onClose={() => setReasonPrompt(null)}
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              const reason = reasonText.trim();
              const prompt = reasonPrompt;
              if (!reason || !prompt || busy > 0) return;
              void (async () => {
                try {
                  await flush();
                } catch (error) {
                  notify(error instanceof Error ? error.message : '请先保存当前输入。', true);
                  return;
                }
                const current = workspace
                  .getSnapshot()
                  .items.find((item) => item.id === prompt.itemId);
                const allowed =
                  prompt.type === 'skip'
                    ? current?.status === 'pending'
                    : current?.status === 'running';
                if (!allowed) return;
                setItemId(prompt.itemId);
                try {
                  await execute({ type: prompt.type, itemId: prompt.itemId, reason }, false);
                  setReasonPrompt(null);
                } catch {
                  // execute already reports the failure and leaves this operation selected.
                }
              })();
            }}
          >
            <p className="hint">
              {reasonPrompt.type === 'skip'
                ? '原因记在这条操作上。不开始，也不生成实际记录。'
                : '原因记在这条已开始的记录上。不改开始时间，也不另开一条记录。'}
            </p>
            <label className="field">
              <span>原因</span>
              <input
                aria-label="原因"
                value={reasonText}
                maxLength={80}
                onChange={(event) => setReasonText(event.target.value)}
              />
            </label>
            <footer className="modal-actions">
              <button type="button" className="button" onClick={() => setReasonPrompt(null)}>
                取消
              </button>
              <button type="submit" className="button primary" disabled={!reasonText.trim()}>
                {reasonPrompt.type === 'skip' ? '确认跳过' : '确认中断'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {moreTarget && (
        <Modal title="更多现场操作" onClose={() => setMoreTarget(null)}>
          <div className="field-more-actions">
            <button
              className="button"
              onClick={() => {
                setTimelineTarget(moreTarget);
                setMoreTarget(null);
              }}
            >
              <Clock size={17} />
              时间线
            </button>
            <button
              className="button"
              onClick={() => {
                setIssuesExperiment(moreTarget.experimentId);
                setMoreTarget(null);
              }}
            >
              <AlertTriangle size={17} />
              未处理问题（
              {
                snapshot.events.filter(
                  (e) =>
                    e.experimentId === moreTarget.experimentId &&
                    e.type === 'issue' &&
                    !e.data.resolvedAt,
                ).length
              }
              ）
            </button>
            <button
              className="button"
              disabled={busy > 0}
              onClick={() => {
                void flush()
                  .then(() => {
                    setMoreTarget(null);
                    setTemporary(true);
                  })
                  .catch((error) => notify(error.message, true));
              }}
            >
              <Plus size={17} />
              临时样品
            </button>
            <button
              className="button"
              disabled={busy > 0}
              onClick={() => {
                const id = moreTarget.experimentId;
                void flush()
                  .then(() => {
                    setMoreTarget(null);
                    setSpareExperiment(id);
                  })
                  .catch((error) => notify(error.message, true));
              }}
            >
              <LayersIcon />
              启用备样
            </button>
            {snapshot.items.find((item) => item.id === moreTarget.itemId)?.status === 'pending' && (
              <button
                className="button"
                onClick={() => {
                  setReasonText('');
                  setReasonPrompt({ type: 'skip', itemId: moreTarget.itemId });
                  setMoreTarget(null);
                }}
              >
                <SkipForward size={17} />
                写原因后跳过
              </button>
            )}
            {snapshot.items.find((item) => item.id === moreTarget.itemId)?.status === 'running' && (
              <button
                className="button"
                onClick={() => {
                  setReasonText('');
                  setReasonPrompt({ type: 'interrupt', itemId: moreTarget.itemId });
                  setMoreTarget(null);
                }}
              >
                <Square size={17} />
                写原因后中断
              </button>
            )}
            {items.length > 0 &&
              !items.some((item) => item.status === 'pending' || item.status === 'running') && (
                <button
                  className="button primary"
                  disabled={busy > 0 || exporting}
                  onClick={() => {
                    setMoreTarget(null);
                    void exportReport();
                  }}
                >
                  <FileText size={17} />
                  导出本次报告
                </button>
              )}
          </div>
        </Modal>
      )}
      {timelineTarget && (
        <TimelineDrawer
          itemId={timelineTarget.itemId}
          experimentId={timelineTarget.experimentId}
          onClose={() => setTimelineTarget(null)}
        />
      )}
      {timesTarget && <TimesDialog {...timesTarget} onClose={() => setTimesTarget(null)} />}
      {eventDialog && (
        <EventDialog
          {...eventDialog.target}
          issue={eventDialog.issue}
          onClose={() => setEventDialog(null)}
        />
      )}
      {issuesExperiment && (
        <Modal title="未处理的问题" onClose={() => setIssuesExperiment(null)}>
          <div className="unresolved-issues">
            {snapshot.events
              .filter(
                (e) =>
                  e.experimentId === issuesExperiment && e.type === 'issue' && !e.data.resolvedAt,
              )
              .map((event) => (
                <article key={event.id} className="unresolved-issue-item">
                  <div>
                    <strong>{String(event.data.category || '其他')}</strong>
                    <p>{event.text}</p>
                    <small>
                      {event.itemId
                        ? `样品 ${snapshot.samples.find((s) => s.id === snapshot.items.find((i) => i.id === event.itemId)?.sampleId)?.code || '未知'}`
                        : '实验级问题'}{' '}
                      · {eventTimeLabel(snapshot, event) || timeText(event.createdAt, true)}
                    </small>
                  </div>
                  {event.itemId && (
                    <button
                      className="button small"
                      onClick={() => {
                        void flush()
                          .then(() => {
                            setExperimentId(event.experimentId);
                            setItemId(event.itemId!);
                            setIssuesExperiment(null);
                            setTimelineTarget({
                              itemId: event.itemId!,
                              experimentId: event.experimentId,
                            });
                          })
                          .catch((error) => notify(error.message, true));
                      }}
                    >
                      定位
                    </button>
                  )}
                  <button
                    className="button small"
                    disabled={busy > 0}
                    onClick={() => {
                      void execute({ type: 'resolveIssue', eventId: event.id }, false).catch(
                        () => {},
                      );
                    }}
                  >
                    标记已处理
                  </button>
                </article>
              ))}
            {!snapshot.events.some(
              (e) =>
                e.experimentId === issuesExperiment && e.type === 'issue' && !e.data.resolvedAt,
            ) && <p>当前没有未处理的问题。</p>}
          </div>
        </Modal>
      )}
      {temporary && <QuickAdd onClose={() => setTemporary(false)} />}
      {measurementDialog && (
        <MeasurementDialog
          items={[measurementDialog.item]}
          append={measurementDialog.append}
          onClose={() => setMeasurementDialog(null)}
        />
      )}
      {spareExperiment && (
        <Modal title="选择样品组启用备样" onClose={() => setSpareExperiment(null)}>
          <div className="spare-groups">
            {snapshot.groups
              .filter((entry) => entry.experimentId === spareExperiment)
              .sort((a, b) => Number(b.id === group?.id) - Number(a.id === group?.id))
              .map((entry) => {
                const counts = groupCounts(snapshot, entry);
                const current = entry.id === group?.id;
                return (
                  <button
                    type="button"
                    className={`spare-group${current ? ' is-current' : ''}`}
                    disabled={counts.spare === 0}
                    key={entry.id}
                    aria-label={`启用备样 ${sampleName(entry)}${current ? ' 当前样品组' : ''}`}
                    onClick={() => {
                      setArrangeGroup(entry.id);
                      setSpareExperiment(null);
                    }}
                  >
                    <div>
                      <strong>
                        {sampleName(entry)}
                        {entry.name ? ` · ${entry.state}` : ''}
                        {current ? ' · 当前样品组' : ''}
                      </strong>
                      <span>
                        已安排 {counts.planned} 个 · 备样 {counts.spare ?? '数量未定'} 个
                      </span>
                    </div>
                    <ArrowRight size={16} />
                  </button>
                );
              })}
          </div>
          <p className="hint">数量未知的样品组可以追加计划，准备数量在规划页另行核对。</p>
        </Modal>
      )}
      {arrangeGroup && (
        <ArrangeDialog
          group={snapshot.groups.find((g) => g.id === arrangeGroup)!}
          spare
          onClose={() => setArrangeGroup(null)}
        />
      )}
      {pendingImage && (
        <Modal title="移除现场图片" onClose={() => setPendingImage(null)} closeDisabled={fileBusy}>
          <p className="dialog-target">
            图片：
            <strong>
              {snapshot.attachments.find((entry) => entry.id === pendingImage)?.name || '这张图片'}
            </strong>
          </p>
          <p className="hint">只从这条记录移除这张图片。不改起止时间，也不改开始时的计划。</p>
          <footer className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={fileBusy}
              onClick={() => setPendingImage(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger"
              disabled={fileBusy}
              onClick={() => {
                void removeImage(pendingImage);
              }}
            >
              确认移除
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function LayersIcon() {
  return <ChevronDown size={16} />;
}
