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
} from 'lucide-react';
import type { PlanItem, Command } from '../shared/model';
import { filenameFor, groupCounts, sampleName, dimensions } from '../shared/model';
import { useWorkspace, unwrap, type EventTarget, type EventDraft } from './context';
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
import { QuickRecordBar, IssueTemplateDialog } from './QuickRecord';

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
    } catch (error) {
      setError((error as Error).message);
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
            disabled={busy || !validTarget}
            onChange={(event) => {
              intent.current = null;
              setStart(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>结束时间</span>
          <input
            aria-label="结束时间"
            type="datetime-local"
            step="1"
            value={end}
            disabled={busy || !validTarget}
            onChange={(event) => {
              intent.current = null;
              setEnd(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>修改说明（可选）</span>
          <input
            value={reason}
            disabled={busy || !validTarget}
            onChange={(event) => {
              intent.current = null;
              setReason(event.target.value);
            }}
            placeholder="例如忘记点完成，按实验日志补记"
          />
        </label>
        {run && (
          <p className="hint">
            原始开始：{timeText(run.originalStartedAt, true)}
            <br />
            原始结束：{timeText(run.originalEndedAt, true)}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
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
                <time>{timeText(event.createdAt)}</time>
                <span>{eventLabel(event.type)}</span>
              </div>
              <p>{event.text}</p>
              {event.type === 'issue' && (
                <div className="issue-meta">
                  <span>{String(event.data.category || '其他')}</span>
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
  const [timesTarget, setTimesTarget] = useState<EventTarget | null>(null),
    [eventDialog, setEventDialog] = useState<{ target: EventTarget; issue: boolean } | null>(null),
    [spareExperiment, setSpareExperiment] = useState<string | null>(null),
    [arrangeGroup, setArrangeGroup] = useState<string | null>(null),
    [temporary, setTemporary] = useState(false);
  const [issuesExperiment, setIssuesExperiment] = useState<string | null>(null);
  const actionGate = useRef(0),
    actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [actionGuard, setActionGuard] = useState(false);
  const [exporting, setExporting] = useState(false);
  const filesWorking = useRef(false);
  const composing = useRef(false);
  const [fileBusy, setFileBusy] = useState(false);
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
  const group = sample && snapshot.groups.find((g) => g.id === sample.groupId)!;
  const displayedGroup = run?.snapshot.group || (group && { ...group, ...sample.parameters });
  const completed = items.filter((i) => i.status === 'completed').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const interrupted = items.filter((i) => i.status === 'interrupted').length;
  // 下一待测项：按完整排序的第一个 pending，与搜索/筛选无关
  const nextPending = items.find((i) => i.status === 'pending');
  const visible = items.filter((item) => {
    const sample = snapshot.samples.find((s) => s.id === item.sampleId);
    const group = snapshot.groups.find((g) => g.id === sample?.groupId);
    const name = sample?.parameters.name || group?.name || '';
    return (
      (filter === 'all' || item.status === filter) &&
      `${sample?.code} ${name} ${group?.state}`.toLowerCase().includes(search.toLowerCase())
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
      if (allowed(workspace.getSnapshot())) await execute({ type, itemId: targetId });
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
  async function move(item: PlanItem, direction: number) {
    const index = items.findIndex((i) => i.id === item.id);
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    const ids = items.map((i) => i.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    try {
      await flush();
      await execute({ type: 'reorder', experimentId: item.experimentId, ids }, false);
    } catch (error) {
      notify((error as Error).message, true);
    }
  }
  let proposed = '';
  if (sample) {
    try {
      proposed =
        run?.filename ||
        filenameFor(
          experiment.namingPattern,
          experiment.code,
          sample.code,
          Math.max(
            0,
            ...snapshot.runs.filter((r) => r.experimentId === experimentId).map((r) => r.number),
          ) + 1,
        );
    } catch (error) {
      proposed = (error as Error).message;
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(proposed);
      notify('预期文件名已复制。');
    } catch {
      notify('无法复制，请选中文件名后手动复制。', true);
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
        <span>{items.length} 项</span>
      </header>
      <SearchField
        className="queue-search"
        label="搜索待测样品"
        placeholder="查找样品"
        value={search}
        onChange={setSearch}
      />
      <div className="queue-filters" role="group" aria-label="队列筛选">
        <button
          aria-pressed={filter === 'all'}
          className={filter === 'all' ? 'active' : ''}
          onClick={() => setFilter('all')}
        >
          全部
        </button>
        <button
          className={filter === 'pending' ? 'active' : ''}
          aria-pressed={filter === 'pending'}
          onClick={() => setFilter('pending')}
        >
          待测
        </button>
        <button
          className={filter === 'completed' ? 'active' : ''}
          aria-pressed={filter === 'completed'}
          onClick={() => setFilter('completed')}
        >
          已完成
        </button>
      </div>
      <div className="queue-list">
        {visible.map((item, index) => {
          const sample = snapshot.samples.find((s) => s.id === item.sampleId)!;
          const group = snapshot.groups.find((g) => g.id === sample.groupId)!;
          const repeated = !!item.repeatOf;
          return (
            <div className={`queue-row ${selected?.id === item.id ? 'current' : ''}`} key={item.id}>
              <button
                className="queue-choice"
                aria-label={`选择样品 ${sample.code} 操作 ${item.order + 1}`}
                aria-pressed={selected?.id === item.id}
                onClick={() => choose(item.id)}
              >
                <span className="queue-index">{String(item.order + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{sample.code}</strong>
                  <small>
                    {sample.parameters.name || sampleName(group)}
                    {repeated ? ' · 重测安排' : ''}
                  </small>
                  <StatusPill status={item.status} />
                </div>
                <PriorityPill value={group.priority} />
              </button>
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
                </div>
              )}
            </div>
          );
        })}
        {!visible.length && <p className="hint queue-empty">当前没有符合条件的操作。</p>}
      </div>
      <footer>
        <span className="pulse-dot neutral" />
        备样不在队列中
      </footer>
    </aside>
  );
  return (
    <div className={`page live-page${focused ? ' is-focused' : ''}`}>
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow">02 / 现场记录</div>
          <h1>专注当前样品</h1>
          <p className="live-progress">
            <progress aria-label="完成进度" value={completed} max={Math.max(1, items.length)} />
            <span>
              完成 {completed}/{items.length} · 待测 {pending}
              {skipped ? ` · 跳过 ${skipped}` : ''}
              {interrupted ? ` · 中断 ${interrupted}` : ''}
            </span>
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
        <div className="running-banner">
          <span>
            <span className="pulse-dot" />
            当前还有进行中的操作：
            {snapshot.samples.find((s) => s.id === globalRunning.sampleId)?.code}
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
            <Empty
              title="先安排要测试的样品"
              description="实验规划中准备的样品不会自动成为待测样品。"
            >
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
                  <h2>{sample.code}</h2>
                  <p>
                    <strong>{run?.actualSample?.name || sampleName(displayedGroup)}</strong>
                    {displayedGroup.name ? ` · ${displayedGroup.state}` : ''}
                  </p>
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
            {nextPending && nextPending.id !== selected.id && (
              <div className="next-pending-indicator">
                <ArrowRight size={16} />
                <span>
                  下一项：
                  <strong>
                    {String(nextPending.order + 1).padStart(2, '0')} ·{' '}
                    {snapshot.samples.find((s) => s.id === nextPending.sampleId)?.code}
                  </strong>
                </span>
              </div>
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
            {run && (
              <QuickRecordBar itemId={selected.id} experimentId={experimentId} runId={run.id} />
            )}
            {(displayedGroup.preparation || displayedGroup.notes) && (
              <details className="plan-reference">
                <summary>
                  计划制备与备注 <ChevronDown size={15} />
                </summary>
                {displayedGroup.preparation && (
                  <p>
                    <strong>制备 / 试剂：</strong>
                    {displayedGroup.preparation}
                  </p>
                )}
                {displayedGroup.notes && <p>{displayedGroup.notes}</p>}
              </details>
            )}
            <div className="parameter-summary">
              <div>
                <span>实验方式</span>
                <strong>{displayedGroup.mode}</strong>
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
                <strong>{timeText(run?.startedAt || null)}</strong>
                {run?.startedAt && (
                  <small>{new Date(run.startedAt).toLocaleDateString('zh-CN')}</small>
                )}
              </div>
              <ArrowRight className="time-arrow" size={18} />
              <div>
                <span>结束时间</span>
                <strong>{timeText(run?.endedAt || null)}</strong>
                {run?.endedAt && <small>{new Date(run.endedAt).toLocaleDateString('zh-CN')}</small>}
              </div>
              <button className="text-button time-edit" onClick={() => setTimesTarget(target())}>
                {run ? '修正时间' : '补录时间'}
              </button>
            </div>
            <div className="filename-card">
              <div>
                <span>预期文件名{!run && <small> · 开始时确定序号</small>}</span>
                <code>{proposed}</code>
              </div>
              <button
                className="icon-button"
                aria-label="复制预期文件名"
                title="复制预期文件名"
                onClick={copy}
              >
                <Copy size={17} />
              </button>
            </div>
            {run && (
              <Details title="实际参数与数据文件">
                <p className="hint">
                  参数默认沿用计划；现场有变化时在这里调整。文件名和扫描编号可用于对应仪器数据。
                </p>
                <div className="form-grid">
                  <label className="field">
                    <span>实际文件名 / 前缀</span>
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
                    <span>扫描编号</span>
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
                      options={['未定', 'In situ', 'Ex situ'].map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  </label>
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
                      · {timeText(event.createdAt, true)}
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
      {spareExperiment && (
        <Modal title="选择样品组启用备样" onClose={() => setSpareExperiment(null)}>
          <div className="spare-groups">
            {snapshot.groups
              .filter((g) => g.experimentId === spareExperiment)
              .map((group) => {
                const counts = groupCounts(snapshot, group);
                return (
                  <button
                    className="spare-group"
                    disabled={counts.spare === 0}
                    key={group.id}
                    onClick={() => {
                      setArrangeGroup(group.id);
                      setSpareExperiment(null);
                    }}
                  >
                    <div>
                      <strong>
                        {sampleName(group)}
                        {group.name ? ` · ${group.state}` : ''}
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
    </div>
  );
}
function LayersIcon() {
  return <ChevronDown size={16} />;
}
