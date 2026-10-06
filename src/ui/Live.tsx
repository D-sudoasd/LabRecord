import { useState, useEffect, useRef } from 'react';
import {
  Play,
  Check,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Search,
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
import type { PlanItem, Run, Mode } from '../shared/model';
import { filenameFor, groupCounts, sampleName, dimensions } from '../shared/model';
import { useWorkspace, unwrap } from './context';
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
} from './components';
import { ArrangeDialog } from './Plan';
import { QuickAdd } from './QuickAdd';

export function TimesDialog({
  item,
  run,
  onClose,
}: {
  item: PlanItem;
  run?: Run;
  onClose: () => void;
}) {
  const { execute } = useWorkspace();
  const [start, setStart] = useState(localInput(run?.startedAt || null)),
    [end, setEnd] = useState(localInput(run?.endedAt || null)),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await execute({
        type: 'times',
        itemId: item.id,
        startedAt: start ? new Date(start).toISOString() : null,
        endedAt: end ? new Date(end).toISOString() : null,
        reason,
      });
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={run ? '修正起止时间' : '补录起止时间'} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
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
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <label className="field">
          <span>修改说明（可选）</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
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
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            保存时间记录
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function EventDialog({
  item,
  run,
  onClose,
  issue,
}: {
  item: PlanItem;
  run?: Run;
  onClose: () => void;
  issue: boolean;
}) {
  const { execute } = useWorkspace();
  const [text, setText] = useState(''),
    [category, setCategory] = useState('装样问题'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await execute({
        type: 'addEvent',
        experimentId: item.experimentId,
        itemId: item.id,
        runId: run?.id,
        eventType: issue ? 'issue' : 'note',
        text,
        category,
      });
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={issue ? '记录现场问题' : '添加时间线记录'} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        {issue && (
          <label className="field">
            <span>问题类别</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
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
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            placeholder={
              issue
                ? '简要写下问题、处理方式或需要后续检查的内容'
                : '操作变化、观察现象、沟通信息等'
            }
            onKeyDown={(event) => {
              if (event.ctrlKey && event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <p className="hint">提交时自动记录时间 · Ctrl + Enter 快速提交</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className={`button ${issue ? 'warning' : 'primary'}`} disabled={busy}>
            {issue ? '保存问题记录' : '添加记录'}
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
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
    [timelineOpen, setTimelineOpen] = useState(false);
  const [times, setTimes] = useState(false),
    [eventType, setEventType] = useState<'note' | 'issue' | null>(null),
    [spare, setSpare] = useState(false),
    [arrangeGroup, setArrangeGroup] = useState<string | null>(null),
    [temporary, setTemporary] = useState(false);
  const actionGate = useRef(0),
    actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [actionGuard, setActionGuard] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(
    () => () => {
      if (actionTimer.current) clearTimeout(actionTimer.current);
    },
    [],
  );
  const sample = selected && snapshot.samples.find((s) => s.id === selected.sampleId)!;
  const run = selected && snapshot.runs.find((r) => r.itemId === selected.id);
  const group = sample && snapshot.groups.find((g) => g.id === sample.groupId)!;
  const displayedGroup = run?.snapshot.group || (group && { ...group, ...sample.parameters });
  const completed = items.filter((i) => i.status === 'completed').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  const interrupted = items.filter((i) => i.status === 'interrupted').length;
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
    setExporting(true);
    try {
      await flush();
      const result = await unwrap(window.labrecord.exportReport(experimentId));
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
    if (!selected || actionGuard || performance.now() < actionGate.current) return;
    actionGate.current = performance.now() + 450;
    setActionGuard(true);
    try {
      await flush();
      await execute({ type, itemId: selected.id });
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
      .then(() => setItemId(id))
      .catch((error) => notify(error.message, true));
  }
  async function move(item: PlanItem, direction: number) {
    const index = items.findIndex((i) => i.id === item.id);
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    const ids = items.map((i) => i.id);
    [ids[index], ids[next]] = [ids[next], ids[index]];
    await execute({ type: 'reorder', experimentId, ids }, false).catch(() => {});
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
  return (
    <div className="page live-page">
      <div className="page-heading compact-heading">
        <div>
          <div className="eyebrow">LIVE RECORD</div>
          <h1>专注当前样品</h1>
          <p>
            完成 {completed}/{items.length} · 待测 {pending}
            {skipped ? ` · 跳过 ${skipped}` : ''}
            {interrupted ? ` · 中断 ${interrupted}` : ''}
          </p>
        </div>
        <div className="heading-actions">
          {items.length > 0 &&
            !items.some((item) => item.status === 'pending' || item.status === 'running') && (
              <button
                className="button primary"
                disabled={Boolean(busy) || exporting}
                onClick={() => void exportReport()}
              >
                <FileText size={16} />
                {exporting ? '正在生成报告…' : '导出本次报告'}
              </button>
            )}
          <button className="button" onClick={() => setTemporary(true)}>
            <Plus size={16} />
            临时样品
          </button>
          <button className="button" onClick={() => setSpare(true)}>
            <LayersIcon />
            启用备样
          </button>
          <button className="button timeline-toggle" onClick={() => setTimelineOpen(true)}>
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
              setExperimentId(globalRunning.experimentId);
              setItemId(globalRunning.id);
            }}
          >
            返回当前操作 <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="live-layout">
        <aside className="queue card">
          <header>
            <h2>
              <List size={18} />
              待测队列
            </h2>
            <span>{items.length} 项</span>
          </header>
          <div className="queue-search search-input">
            <Search size={15} />
            <input
              aria-label="搜索待测样品"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="查找样品"
            />
          </div>
          <div className="queue-filters">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              全部
            </button>
            <button
              className={filter === 'pending' ? 'active' : ''}
              onClick={() => setFilter('pending')}
            >
              待测
            </button>
            <button
              className={filter === 'completed' ? 'active' : ''}
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
                <div
                  className={`queue-row ${selected?.id === item.id ? 'current' : ''}`}
                  key={item.id}
                >
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
        {!selected ? (
          <section className="card current-card">
            <Empty
              title="先安排要测试的样品"
              description="实验规划中准备的样品不会自动成为待测样品。"
            >
              <button className="button primary" onClick={() => setPage('plan')}>
                返回实验规划 <ArrowRight size={16} />
              </button>
            </Empty>
          </section>
        ) : (
          <section className="card current-card" key={selected.id}>
            <header className="current-heading">
              <div>
                <span className="eyebrow">
                  当前样品 · {String(selected.order + 1).padStart(2, '0')}
                </span>
                <h2>{sample.code}</h2>
                <p>
                  <strong>{run?.actualSample?.name || sampleName(displayedGroup)}</strong>
                  {displayedGroup.name ? ` · ${displayedGroup.state}` : ''}
                </p>
              </div>
              <StatusPill status={selected.status} />
            </header>
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
            <div className="operation-actions">
              {selected.status === 'pending' && (
                <>
                  <button
                    className="button primary start-button"
                    disabled={busy > 0 || actionGuard || !!globalRunning}
                    onClick={() => {
                      void action('start');
                    }}
                  >
                    <Play size={19} />
                    开始操作
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
                  >
                    <Check size={20} />
                    完成并切换下一项 <ArrowRight size={18} />
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
              <button className="text-button time-edit" onClick={() => setTimes(true)}>
                {run ? '修正时间' : '补录时间'}
              </button>
            </div>
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
                  <button className="text-button" onClick={() => setEventType('note')}>
                    开始前先记一条信息 <Plus size={14} />
                  </button>
                </div>
              )}
              <div className="quick-record-actions">
                <button className="button issue-button" onClick={() => setEventType('issue')}>
                  <AlertTriangle size={17} />
                  记录问题
                </button>
                <button className="button" onClick={() => setEventType('note')}>
                  <Plus size={16} />
                  添加时间线记录
                </button>
                <button
                  className="button"
                  disabled={!run}
                  onClick={() => {
                    if (run)
                      void unwrap(window.labrecord.addAttachment(run.id))
                        .then((data) => {
                          if (data) workspaceReplace(data);
                        })
                        .catch((error) => notify(error.message, true));
                  }}
                >
                  <ImagePlus size={17} />
                  添加图片
                </button>
              </div>
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
                  onClick={() => {
                    void unwrap(window.labrecord.chooseReference())
                      .then((paths) => {
                        if (paths.length)
                          return execute(
                            {
                              type: 'saveRun',
                              runId: run.id,
                              actual: {
                                files: [run.actual.files, ...paths].filter(Boolean).join('\n'),
                              },
                            },
                            false,
                          );
                      })
                      .catch((error) => notify(error.message, true));
                  }}
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
      {timelineOpen && (
        <TimelineDrawer
          itemId={selected?.id || ''}
          experimentId={experimentId}
          onClose={() => setTimelineOpen(false)}
        />
      )}
      {times && selected && (
        <TimesDialog item={selected} run={run} onClose={() => setTimes(false)} />
      )}
      {eventType && selected && (
        <EventDialog
          item={selected}
          run={run}
          issue={eventType === 'issue'}
          onClose={() => setEventType(null)}
        />
      )}
      {temporary && <QuickAdd onClose={() => setTemporary(false)} />}
      {spare && (
        <Modal title="选择样品组启用备样" onClose={() => setSpare(false)}>
          <div className="spare-groups">
            {snapshot.groups
              .filter((g) => g.experimentId === experimentId)
              .map((group) => {
                const counts = groupCounts(snapshot, group);
                return (
                  <button
                    className="spare-group"
                    disabled={counts.spare === 0}
                    key={group.id}
                    onClick={() => {
                      setArrangeGroup(group.id);
                      setSpare(false);
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
  function workspaceReplace(data: import('../shared/model').Snapshot) {
    workspace.replace(data);
  }
}
function LayersIcon() {
  return <ChevronDown size={16} />;
}
