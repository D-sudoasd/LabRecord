import { useRef, useState, type FormEvent } from 'react';
import {
  Download,
  ClipboardCheck,
  AlertTriangle,
  Clock,
  FileSpreadsheet,
  FileText,
  ArrowLeftRight,
} from 'lucide-react';
import { useWorkspace, unwrap, type EventTarget } from './context';
import { StatusPill, Empty, timeText, Modal, eventLabel, SearchField } from './components';
import { TimesDialog } from './Live';
import { IssueEditDialog } from './IssueEditDialog';
import { MODE_OPTIONS, sampleName, STATUS_LABEL, type Status } from '../shared/model';
import { reportInsights } from '../shared/summary';
import { latestEndedMark } from '../shared/library';
import { formatRecordedDuration, recordedDuration, runDurationLabel } from '../shared/duration';
import { measurementFor, measurementSummary, operationProtocolLabel, plannedGroup } from '../shared/measurement';
import { materialSummary } from '../shared/materials';
import {
  actualProtocolLabel,
  operationPlanDrift,
  operationSizeLine,
  planChangeLabel,
  recordedPlanDiffers,
  recordedPlanSearchText,
  startedPlanChanges,
} from '../shared/planChanges';
import { eventDetailData, eventEarlierText, eventTimeLabel, issueEarlierText, operationHistory, operationStatusReason } from '../shared/history';
import { repeatSource, repeatSourceIssueLabel, repeatSourceLabel } from '../shared/repeats';
import { followUpRoster, followUpSets } from '../shared/followUps';
import { matchesOperationIdentity, recordIdentifiers, textIncludes } from '../shared/operationQuery';
import { MaterialPreparationSummary } from './MaterialPreparation';
import {
  actualFileReferences,
  actualReferenceValue,
  matchesReviewFilters,
  reviewFilterItemIds,
  type ReviewFilterKey,
} from './reviewFilters';
import { canCopyName } from '../shared/copyText';
import { pictureLabel } from './queueSearch';
import { recordedClock } from '../shared/recordedTime';
import {
  DeleteConfirm,
  itemsDeleteReason,
  itemsDeleteRequest,
  useContextMenu,
  type PendingDelete,
} from './rowMenu';
import './review.css';
function FileLinkDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { snapshot, execute } = useWorkspace();
  const run = snapshot.runs.find((entry) => entry.id === runId);
  const code = run?.snapshot.sample.code || '';
  const editing = Boolean(
    String(run?.actual.filename || '') ||
      String(run?.actual.scanId || '') ||
      String(run?.actual.files || ''),
  );
  const [filename, setFilename] = useState(String(run?.actual.filename || ''));
  const [scanId, setScanId] = useState(String(run?.actual.scanId || ''));
  const [files, setFiles] = useState(String(run?.actual.files || ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!run || busy) return;
    if (!filename.trim() && !scanId.trim() && !files.trim()) {
      setError('至少填写文件名、扫描编号或文件引用。');
      return;
    }
    setBusy(true);
    try {
      await execute({ type: 'saveRun', runId: run.id, actual: { filename, scanId, files } }, false);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? '修改数据文件' : '填写数据文件'} onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong>
        </p>
        <p className="hint">只写入已经开始的这条记录。不修改起止时间，也不改开始时的计划。</p>
        {!run && (
          <p className="error-text" role="alert">
            这条记录已不存在，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>实际文件名</span>
          <input
            aria-label="实际文件名"
            value={filename}
            disabled={busy || !run}
            onChange={(event) => setFilename(event.target.value)}
          />
        </label>
        <label className="field">
          <span>扫描编号</span>
          <input
            aria-label="扫描编号"
            value={scanId}
            disabled={busy || !run}
            onChange={(event) => setScanId(event.target.value)}
          />
        </label>
        <label className="field">
          <span>文件引用</span>
          <input
            aria-label="文件引用"
            value={files}
            disabled={busy || !run}
            onChange={(event) => setFiles(event.target.value)}
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || !run}>
            保存文件关联
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function NoteDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { snapshot, execute } = useWorkspace();
  const run = snapshot.runs.find((entry) => entry.id === runId);
  const code = run?.snapshot.sample.code || '';
  const [notes, setNotes] = useState(run?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!run || busy) return;
    setBusy(true);
    try {
      await execute({ type: 'saveRun', runId: run.id, notes }, false);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="修改现场备注" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong>
        </p>
        <p className="hint">只改这条已有记录的现场备注。不修改起止时间，也不改开始时的计划。</p>
        {!run && (
          <p className="error-text" role="alert">
            这条记录已不存在，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>现场备注</span>
          <textarea
            aria-label="现场备注"
            value={notes}
            disabled={busy || !run}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || !run}>
            保存备注
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ThicknessDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { snapshot, execute } = useWorkspace();
  const run = snapshot.runs.find((entry) => entry.id === runId);
  const code = run?.snapshot.sample.code || '';
  const [thickness, setThickness] = useState(String(run?.actual.thickness ?? ''));
  const [unit, setUnit] = useState(String(run?.actual.thicknessUnit ?? ''));
  const [width, setWidth] = useState(String(run?.actualSample?.width ?? ''));
  const [height, setHeight] = useState(String(run?.actualSample?.height ?? ''));
  const [dimensionUnit, setDimensionUnit] = useState(
    String(run?.actualSample?.dimensionUnit ?? ''),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!run || busy) return;
    setBusy(true);
    try {
      await execute(
        {
          type: 'saveRun',
          runId: run.id,
          actual: { thickness, thicknessUnit: unit },
          actualSample: { width, height, dimensionUnit },
        },
        false,
      );
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="修改实际尺寸" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong>
        </p>
        <p className="hint">
          只改这条已有记录的实际厚度、宽度和高度。不修改起止时间，也不改开始时的计划。没填的高度保持空白。
        </p>
        {!run && (
          <p className="error-text" role="alert">
            这条记录已不存在，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>实际厚度</span>
          <input
            aria-label="实际厚度"
            value={thickness}
            disabled={busy || !run}
            onChange={(event) => setThickness(event.target.value)}
          />
        </label>
        <label className="field">
          <span>厚度单位</span>
          <input
            aria-label="厚度单位"
            value={unit}
            disabled={busy || !run}
            onChange={(event) => setUnit(event.target.value)}
          />
        </label>
        <label className="field">
          <span>实际宽度</span>
          <input
            aria-label="实际宽度"
            value={width}
            disabled={busy || !run}
            onChange={(event) => setWidth(event.target.value)}
          />
        </label>
        <label className="field">
          <span>实际高度</span>
          <input
            aria-label="实际高度"
            value={height}
            disabled={busy || !run}
            onChange={(event) => setHeight(event.target.value)}
          />
        </label>
        <label className="field">
          <span>宽高单位</span>
          <input
            aria-label="宽高单位"
            value={dimensionUnit}
            disabled={busy || !run}
            onChange={(event) => setDimensionUnit(event.target.value)}
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || !run}>
            保存实际尺寸
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function PreparationDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { snapshot, execute } = useWorkspace();
  const run = snapshot.runs.find((entry) => entry.id === runId);
  const code = run?.snapshot.sample.code || '';
  const [name, setName] = useState(String(run?.actualSample?.name ?? ''));
  const [mode, setMode] = useState(String(run?.actual.mode ?? '未定'));
  const [preparation, setPreparation] = useState(String(run?.actual.preparation ?? ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!run || busy) return;
    setBusy(true);
    try {
      await execute(
        {
          type: 'saveRun',
          runId: run.id,
          actual: { preparation, mode },
          actualSample: { name },
        },
        false,
      );
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="修改实际制备" onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="dialog-target">
          记录目标：<strong>{code}</strong>
        </p>
        <p className="hint">
          只改这条已有记录的实际样品名、实验方式和制备试剂。不修改起止时间，也不改开始时的计划。清空后保持空白。
        </p>
        {!run && (
          <p className="error-text" role="alert">
            这条记录已不存在，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>实际样品名</span>
          <input
            aria-label="实际样品名"
            value={name}
            disabled={busy || !run}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>实际实验方式</span>
          <select
            aria-label="实际实验方式"
            value={mode}
            disabled={busy || !run}
            onChange={(event) => setMode(event.target.value)}
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>实际制备或试剂</span>
          <input
            aria-label="实际制备或试剂"
            value={preparation}
            disabled={busy || !run}
            onChange={(event) => setPreparation(event.target.value)}
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || !run}>
            保存实际制备
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function PicturesDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { snapshot } = useWorkspace();
  const item = snapshot.items.find((entry) => entry.id === itemId);
  const run = snapshot.runs.find((entry) => entry.itemId === itemId);
  const pictures = snapshot.attachments.filter((attachment) => attachment.runId === run?.id);
  const code = run?.snapshot.sample.code || '';
  return (
    <Modal title="现场图片" onClose={onClose}>
      <p className="dialog-target">
        记录目标：<strong>{code || '这条记录'}</strong>
      </p>
      <p className="hint">这里只查看已经保存的现场图片。打开或关闭都不改起止时间，也不改开始时的计划。</p>
      {pictures.length ? (
        <div className="review-picture-grid">
          {pictures.map((attachment) => (
            <figure key={attachment.id}>
              <img src={`labrecord://attachment/${attachment.id}`} alt={attachment.name} />
              <figcaption>{attachment.name}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="hint">{item ? '这条记录上已经没有图片。' : '这条记录已不存在，请关闭后重新打开。'}</p>
      )}
    </Modal>
  );
}

export function Review() {
  const { snapshot, experimentId, notify, flush, getSnapshot, setItemId, setPage, execute } =
    useWorkspace();
  const repeating = useRef(new Set<string>());
  const items = snapshot.items
    .filter((i) => i.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const [search, setSearch] = useState(''),
    [problemsOnly, setProblemsOnly] = useState(false),
    [actualOnly, setActualOnly] = useState(false),
    [statusFilter, setStatusFilter] = useState<'' | Status>(''),
    [reviewFilters, setReviewFilters] = useState<ReviewFilterKey[]>([]),
    [history, setHistory] = useState<string | null>(null),
    [times, setTimes] = useState<EventTarget | null>(null),
    [fileRunId, setFileRunId] = useState<string | null>(null),
    [noteRunId, setNoteRunId] = useState<string | null>(null),
    [thicknessRunId, setThicknessRunId] = useState<string | null>(null),
    [preparationRunId, setPreparationRunId] = useState<string | null>(null),
    [pictureItemId, setPictureItemId] = useState<string | null>(null),
    [issueEditId, setIssueEditId] = useState<string | null>(null),
    [exporting, setExporting] = useState(false),
    [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const { open: openMenu, menu } = useContextMenu();
  const issues = snapshot.events.filter(
      (e) => e.experimentId === experimentId && e.type === 'issue',
    ),
    unresolved = issues.filter((e) => !e.data.resolvedAt);
  const filterItemIds = reviewFilterItemIds(snapshot, experimentId);
  const roster = followUpRoster(snapshot, experimentId);
  const unlinkedIssues = followUpSets(snapshot, experimentId).unlinkedIssues;
  const visible = items.filter((item) => {
    const sample = snapshot.samples.find((s) => s.id === item.sampleId)!;
    const run = snapshot.runs.find((r) => r.itemId === item.id);
    const storedGroup = snapshot.groups.find((g) => g.id === sample.groupId)!;
    const group = run?.snapshot.group || plannedGroup(storedGroup, sample, item);
    const text = `${sampleName(group)} ${group.state} ${materialSummary(group)} ${run?.actualSample?.name || ''} ${run?.snapshot.sample.code || sample.code} ${run?.notes || ''} ${run?.actual.filename || ''} ${run?.actual.scanId || ''} ${run?.actual.files || ''} ${measurementSummary(measurementFor(snapshot, item))} ${operationProtocolLabel(snapshot, item)} ${run?.filename || item.plannedName || ''} ${operationSizeLine(group, run)} ${operationPlanDrift(snapshot, item) ? `当前计划已不同：${operationPlanDrift(snapshot, item)}` : ''} ${actualProtocolLabel(run)} ${recordedPlanSearchText(run)} ${pictureLabel(snapshot, run?.id)} ${repeatSourceLabel(snapshot, item)} ${latestEndedMark(snapshot, item.id)}`;
    return (
      (textIncludes(text, search) || matchesOperationIdentity(snapshot, item, search)) &&
      (!problemsOnly || issues.some((e) => e.itemId === item.id)) &&
      (!actualOnly || recordedPlanDiffers(run)) &&
      (!statusFilter || item.status === statusFilter) &&
      matchesReviewFilters(item.id, reviewFilters, filterItemIds)
    );
  });
  async function copyRecord(itemId: string, kind: 'id' | 'folder') {
    try {
      await flush();
      const identity = recordIdentifiers(getSnapshot(), itemId);
      const text = kind === 'id' ? identity?.sampleId : identity?.folder;
      if (!text) throw new Error(kind === 'id' ? '还没有样品 ID。' : '还没有数据文件夹名。');
      await unwrap(window.labrecord.copyName(text));
      notify(kind === 'id' ? '样品 ID 已复制。' : '数据文件夹名已复制。');
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制。', true);
    }
  }
  async function copyActualReference(itemId: string, label: string) {
    try {
      await flush();
      const text = actualReferenceValue(
        getSnapshot().runs.find((run) => run.itemId === itemId),
        label,
      );
      if (!canCopyName(text)) throw new Error(`还没有可复制的${label}。`);
      await unwrap(window.labrecord.copyName(text));
      notify(`${label}已复制。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法复制。', true);
    }
  }
  async function save(format: 'xlsx' | 'csv' | 'json') {
    setExporting(true);
    try {
      await flush();
      const path = await unwrap(window.labrecord.exportFile(experimentId, format));
      if (path) notify(`已导出：${path}`);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setExporting(false);
    }
  }
  const checks = reportInsights(snapshot, experimentId);
  const duration = recordedDuration(
    snapshot.runs.filter((run) => run.experimentId === experimentId),
  );
  const filterOptions: {
    key: ReviewFilterKey;
    label: string;
    count: number;
    unit: string;
    Icon: typeof Clock;
  }[] = [
    {
      key: 'missingTimes',
      label: '时间不完整',
      count: checks.missingTimes,
      unit: '次',
      Icon: Clock,
    },
    {
      key: 'missingFiles',
      label: '文件关联未补充',
      count: checks.missingFiles,
      unit: '次',
      Icon: FileText,
    },
    {
      key: 'unresolvedIssues',
      label: '未处理问题',
      count: checks.unresolvedIssues,
      unit: '条',
      Icon: AlertTriangle,
    },
  ];
  const actualChangedCount = items.filter((item) =>
    recordedPlanDiffers(snapshot.runs.find((run) => run.itemId === item.id)),
  ).length;
  const hasActiveFilters =
    !!search || problemsOnly || actualOnly || !!statusFilter || reviewFilters.length > 0;
  function clearFilters() {
    setSearch('');
    setProblemsOnly(false);
    setActualOnly(false);
    setStatusFilter('');
    setReviewFilters([]);
  }
  function toggleReviewFilter(filter: ReviewFilterKey) {
    setReviewFilters((current) =>
      current.includes(filter) ? current.filter((key) => key !== filter) : [...current, filter],
    );
  }
  async function openFollowUp(itemId: string, kind: 'times' | 'files') {
    try {
      await flush();
      const latest = getSnapshot();
      const item = latest.items.find(
        (entry) => entry.id === itemId && entry.experimentId === experimentId,
      );
      const run = latest.runs.find((entry) => entry.itemId === itemId);
      if (!item || !run) throw new Error('这条记录已不存在，请重新选择。');
      if (kind === 'times') {
        setTimes({ itemId: item.id, experimentId: item.experimentId, runId: run.id });
      } else {
        setFileRunId(run.id);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开记录。', true);
    }
  }
  async function report() {
    setExporting(true);
    try {
      await flush();
      const result = await unwrap(window.labrecord.exportReport(experimentId));
      if (result)
        notify(
          `报告已保存：${result.localPath}${result.archiveState === 'pending' ? ' · 等待上传到私人库' : result.archiveError ? ' · 云端归档未成功：' + result.archiveError : ''}`,
          result.archiveState === 'failed',
        );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="page review-page">
      <div className="page-heading">
        <div>
          <h1>回看导出</h1>
          <p>核对计划与记录，按样品或备注查找。</p>
        </div>
        <button
          className="button"
          disabled={exporting}
          onClick={() => {
            void save('xlsx');
          }}
        >
          <FileSpreadsheet size={17} />
          导出 Excel
        </button>
      </div>
      <section className="card report-action-card">
        <div className="report-art" aria-hidden="true">
          <FileText size={28} />
          <span>PDF · HTML</span>
        </div>
        <div className="report-action-copy">
          <h3>一键生成实验报告</h3>
          <p>PDF + 独立 HTML + 结构化 JSON + agent 说明 + 现场图片</p>
        </div>
        <button
          className="button primary"
          disabled={exporting}
          onClick={() => {
            void report();
          }}
        >
          <Download size={17} />
          {exporting ? '正在导出…' : '导出实验报告'}
        </button>
      </section>
      <div className="stats-row">
        <div className="stat">
          <ClipboardCheck size={22} />
          <div>
            <strong>
              {items.filter((i) => i.status === 'completed').length}
              <small>项</small>
            </strong>
            <span>已完成操作</span>
          </div>
        </div>
        <div className="stat">
          <Clock size={22} />
          <div>
            <strong>
              {snapshot.runs.filter((r) => r.experimentId === experimentId).length}
              <small>次</small>
            </strong>
            <span>独立操作记录 · 包括重测</span>
            <small className="recorded-duration">
              {duration.completeCount
                ? `已记录 ${formatRecordedDuration(duration.milliseconds)}`
                : '尚无完整起止'}
              {duration.incompleteCount > 0
                ? ` · ${duration.incompleteCount} 次起止不完整，未计入`
                : ''}
            </small>
          </div>
        </div>
        <div className="stat">
          <AlertTriangle size={22} />
          <div>
            <strong>
              {unresolved.length}
              <small>条</small>
            </strong>
            <span>待处理问题</span>
          </div>
        </div>
        <div className="stat-note">
          起止时间用于大致对应
          <br />
          <span>精确时间以仪器数据为准</span>
        </div>
      </div>
      {issues.length > 0 && (
        <section className="card issues-card">
          <div className="card-toolbar">
            <h2>现场问题</h2>
            <span>{issues.length} 条记录</span>
          </div>
          <div className="issue-list">
            {issues.map((issue) => {
              const issueRun = snapshot.runs.find((run) => run.id === issue.runId);
              const issueItem =
                snapshot.items.find((item) => item.id === issue.itemId) ||
                snapshot.items.find((item) => item.id === issueRun?.itemId);
              const issueSampleCode =
                issueRun?.snapshot.sample.code ||
                snapshot.samples.find((sample) => sample.id === issueItem?.sampleId)?.code ||
                '实验记录';
              const resolved = !!issue.data.resolvedAt;
              return (
                <div className={`review-issue ${resolved ? 'resolved' : 'pending'}`} key={issue.id}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  <div>
                    <div className="review-issue-heading">
                      <strong>
                        {String(issue.data.category)} · {issueSampleCode}
                      </strong>
                      <span className={`review-issue-status ${resolved ? 'resolved' : 'pending'}`}>
                        {resolved ? '已处理' : '待处理'}
                      </span>
                    </div>
                    <p>{issue.text}</p>
                    {issueEarlierText(issue) && (
                      <small className="issue-earlier">{issueEarlierText(issue)}</small>
                    )}
                    <small>{eventTimeLabel(snapshot, issue) || timeText(issue.createdAt, true)}</small>
                  </div>
                  <button
                    type="button"
                    className="button small"
                    aria-label={`修改问题：${issue.text}`}
                    onClick={() => setIssueEditId(issue.id)}
                  >
                    修改
                  </button>
                  {!resolved && (
                    <button
                      className="button small"
                      onClick={() => {
                        void execute({ type: 'resolveIssue', eventId: issue.id }, false).catch(
                          () => {},
                        );
                      }}
                    >
                      标记已处理
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-toolbar">
          <div className="toolbar-title">
            <h2>操作记录</h2>
            <span>{visible.length} 项</span>
          </div>
          <div className="toolbar-actions">
            <SearchField
              label="搜索操作记录"
              placeholder="样品、样品 ID、扫描编号或备注"
              value={search}
              onChange={setSearch}
            />
            <select
              className="review-status-filter"
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as '' | Status)}
            >
              <option value="">全部状态</option>
              {(['pending', 'running', 'completed', 'skipped', 'interrupted'] as const).map(
                (status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}（
                    {items.filter((item) => item.status === status).length}）
                  </option>
                ),
              )}
            </select>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(event) => setProblemsOnly(event.target.checked)}
              />
              只看有问题的操作
            </label>
            {(actualChangedCount > 0 || actualOnly) && (
              <button
                type="button"
                className={`button small${actualOnly ? ' active' : ''}`}
                aria-pressed={actualOnly}
                aria-label="实际已改"
                onClick={() => setActualOnly((value) => !value)}
              >
                实际已改 <span aria-hidden="true">{actualChangedCount}</span>
              </button>
            )}
            <button
              className="button"
              disabled={exporting}
              onClick={() => {
                void save('csv');
              }}
            >
              <Download size={16} />
              CSV
            </button>
            <button
              className="button"
              disabled={exporting}
              onClick={() => {
                void save('json');
              }}
            >
              <Download size={16} />
              JSON
            </button>
          </div>
        </div>
        <div className="review-followup">
          <div className="review-followup-copy">
            <strong>待核对</strong>
            <span>选择条件可与搜索和问题筛选叠加</span>
          </div>
          <div
            className="review-followup-filters"
            role="group"
            aria-label="按待核对事项筛选操作记录"
          >
            {filterOptions.map(({ key, label, count, unit, Icon }) => {
              const active = reviewFilters.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className="review-filter-button"
                  aria-pressed={active}
                  aria-label={`${label}，${count}${unit}`}
                  onClick={() => toggleReviewFilter(key)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{label}</span>
                  <span className="review-filter-count">
                    {count}
                    {unit}
                  </span>
                </button>
              );
            })}
          </div>
          {hasActiveFilters && (
            <button type="button" className="review-filter-clear" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>
        {(roster.length > 0 || unlinkedIssues > 0) && (
          <div className="review-roster">
            {roster.length > 0 && (
              <ul className="follow-up-roster" aria-label="待核对清单">
                {roster.map((entry) => {
                  const item = items.find((item) => item.id === entry.itemId)!;
                  return (
                    <li key={entry.itemId}>
                      <button
                        type="button"
                        className="follow-up-open"
                        aria-label={`打开 ${entry.sampleCode}`}
                        onClick={() => {
                          void flush()
                            .then(() => {
                              setItemId(entry.itemId);
                              setPage('live');
                            })
                            .catch((error) => notify(error.message, true));
                        }}
                      >
                        <strong>{entry.sampleCode}</strong>
                        <span>{entry.gaps.join('、')}</span>
                      </button>
                      {(filterItemIds.missingTimes.has(entry.itemId) ||
                        filterItemIds.missingFiles.has(entry.itemId)) && (
                        <div className="follow-up-actions">
                          {filterItemIds.missingTimes.has(entry.itemId) && (
                            <button
                              type="button"
                              className="button small"
                              aria-label={`补充时间 ${entry.sampleCode} 操作 ${item.order + 1}`}
                              onClick={() => void openFollowUp(entry.itemId, 'times')}
                            >
                              补充时间
                            </button>
                          )}
                          {filterItemIds.missingFiles.has(entry.itemId) && (
                            <button
                              type="button"
                              className="button small"
                              aria-label={`填写文件 ${entry.sampleCode} 操作 ${item.order + 1}`}
                              onClick={() => void openFollowUp(entry.itemId, 'files')}
                            >
                              填写文件
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {unlinkedIssues > 0 && (
              <p className="review-unlinked">未关联到操作的问题：{unlinkedIssues} 条。</p>
            )}
          </div>
        )}
        <div className="review-scroll-hint">
          <ArrowLeftRight size={14} aria-hidden="true" />
          <span>表格可横向滚动，查看实际文件、备注和操作</span>
        </div>
        {visible.length ? (
          <div className="table-wrap review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>样品编号</th>
                  <th>状态</th>
                  <th>开始时间</th>
                  <th>结束时间</th>
                  <th>实际文件 / 扫描编号</th>
                  <th>现场备注</th>
                  <th>记录</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => {
                  const run = snapshot.runs.find((r) => r.itemId === item.id),
                    sample =
                      run?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId)!;
                  const group = run?.snapshot.group || {
                    ...snapshot.groups.find((g) => g.id === sample.groupId)!,
                    ...sample.parameters,
                  };
                  const fileReferences = actualFileReferences(run);
                  const identity = recordIdentifiers(snapshot, item.id);
                  const source = repeatSource(snapshot, item);
                  const startedClock = run
                    ? recordedClock(run.startedAt, run.offsetMinutes, run.timezone)
                    : null;
                  const endedClock = run
                    ? recordedClock(run.endedAt, run.offsetMinutes, run.timezone)
                    : null;
                  const deleteReason = itemsDeleteReason(snapshot, [item.id]);
                  return (
                    <tr
                      key={item.id}
                      onContextMenu={(event) =>
                        openMenu(event, [
                          {
                            kind: 'item',
                            label: '查看',
                            onSelect: () => {
                              setItemId(item.id);
                              setPage('live');
                            },
                          },
                          {
                            kind: 'item',
                            label: '时间',
                            onSelect: () =>
                              setTimes({
                                itemId: item.id,
                                experimentId: item.experimentId,
                                runId: run?.id,
                              }),
                          },
                          { kind: 'item', label: '历史', onSelect: () => setHistory(item.id) },
                          {
                            kind: 'item',
                            label: '复制样品 ID',
                            disabled: !identity?.sampleId,
                            onSelect: () => {
                              void copyRecord(item.id, 'id');
                            },
                          },
                          {
                            kind: 'item',
                            label: '复制数据文件夹名',
                            disabled: !identity?.folder,
                            title: identity?.folder ? undefined : '还没有数据文件夹名。',
                            onSelect: () => {
                              void copyRecord(item.id, 'folder');
                            },
                          },
                          { kind: 'separator' },
                          {
                            kind: 'item',
                            label: deleteReason
                              ? item.status === 'running'
                                ? '删除未开始的测量（进行中）'
                                : '删除未开始的测量（已有记录）'
                              : '删除未开始的测量',
                            disabled: !!deleteReason,
                            danger: true,
                            title: deleteReason || undefined,
                            onSelect: () =>
                              setPendingDelete(itemsDeleteRequest(snapshot, [item.id])),
                          },
                        ])
                      }
                    >
                      <td>
                        <strong>{sample.code}</strong>
                        {latestEndedMark(snapshot, item.id) && (
                          <small className="review-latest">{latestEndedMark(snapshot, item.id)}</small>
                        )}
                        {operationPlanDrift(snapshot, item) && (
                          <small className="review-plan-drift">
                            当前计划已不同：{operationPlanDrift(snapshot, item)}
                          </small>
                        )}
                        {actualProtocolLabel(run) && (
                          <small className="review-actual-protocol">{actualProtocolLabel(run)}</small>
                        )}
                        {recordedPlanSearchText(run) && (
                          <small className="review-recorded-plan">{recordedPlanSearchText(run)}</small>
                        )}
                        {pictureLabel(snapshot, run?.id) && (
                          <small className="review-pictures">{pictureLabel(snapshot, run?.id)}</small>
                        )}
                        {run && snapshot.attachments.some((attachment) => attachment.runId === run.id) && (
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`查看图片 ${sample.code} 操作 ${item.order + 1}`}
                            onClick={() => setPictureItemId(item.id)}
                          >
                            查看图片
                          </button>
                        )}
                        {identity?.sampleId && (
                          <code className="review-sample-id">{identity.sampleId}</code>
                        )}
                        <div className="review-copy">
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`复制样品 ID ${sample.code} 操作 ${item.order + 1}`}
                            disabled={!identity?.sampleId}
                            onClick={() => {
                              void copyRecord(item.id, 'id');
                            }}
                          >
                            复制 ID
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`复制数据文件夹 ${sample.code} 操作 ${item.order + 1}`}
                            title={identity?.folder ? undefined : '还没有数据文件夹名。'}
                            disabled={!identity?.folder}
                            onClick={() => {
                              void copyRecord(item.id, 'folder');
                            }}
                          >
                            复制文件夹
                          </button>
                        </div>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`查看现场 ${sample.code}`}
                          onClick={() => {
                            setItemId(item.id);
                            setPage('live');
                          }}
                        >
                          查看现场
                        </button>
                        <small>
                          {run?.actualSample?.name ||
                            run?.snapshot.group.name ||
                            snapshot.groups.find((g) => g.id === sample.groupId)?.name ||
                            run?.snapshot.group.state ||
                            snapshot.groups.find((g) => g.id === sample.groupId)?.state}
                        </small>
                        <MaterialPreparationSummary value={group} compact />
                        {(item.measurement || run?.snapshot.measurement) && (
                          <small>{measurementSummary(measurementFor(snapshot, item))}</small>
                        )}
                        {operationProtocolLabel(snapshot, item) && (
                          <small className="review-protocol">{operationProtocolLabel(snapshot, item)}</small>
                        )}
                        {(run?.filename || item.plannedName) && (
                          <small className="review-folder-name">
                            {run?.filename || item.plannedName}
                          </small>
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
                        {source && (
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`查看原操作 ${source.sampleCode}`}
                            onClick={() => {
                              void flush()
                                .then(() => {
                                  setItemId(source.itemId);
                                  setPage('live');
                                })
                                .catch((error) => notify(error.message, true));
                            }}
                          >
                            查看原操作
                          </button>
                        )}
                        {run && startedPlanChanges(run).length > 0 && (
                          <ul
                            className="plan-changes"
                            aria-label={`${sample.code} 与开始时计划不同`}
                          >
                            {startedPlanChanges(run).map((change) => (
                              <li key={`${change.source}:${change.key}`}>
                                <span>{planChangeLabel(change)}</span>
                                <span>{change.planned}</span>
                                <span>{change.actual}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        <StatusPill status={item.status} />
                        {operationStatusReason(snapshot, item) && (
                          <small>原因：{operationStatusReason(snapshot, item)}</small>
                        )}
                      </td>
                      <td title={startedClock ? `${startedClock.clock} ${startedClock.zone}` : undefined}>
                        {startedClock?.clock || <span className="muted">—</span>}
                        {startedClock && <small className="review-clock-zone">{startedClock.zone}</small>}
                      </td>
                      <td title={endedClock ? `${endedClock.clock} ${endedClock.zone}` : undefined}>
                        {endedClock?.clock || <span className="muted">—</span>}
                        {endedClock && <small className="review-clock-zone">{endedClock.zone}</small>}
                        {run && <small className="review-duration">{runDurationLabel(run)}</small>}
                      </td>
                      <td>
                        {run ? (
                          fileReferences.length ? (
                            <>
                            <div className="review-actual-files">
                              {fileReferences.map((reference) => (
                                <div className="review-actual-file" key={reference.label}>
                                  <small>
                                    {reference.label}
                                    {canCopyName(reference.value) && (
                                      <button
                                        type="button"
                                        className="text-button"
                                        aria-label={`复制${reference.label} ${sample.code} 操作 ${item.order + 1}`}
                                        onClick={() => {
                                          void copyActualReference(item.id, reference.label);
                                        }}
                                      >
                                        复制
                                      </button>
                                    )}
                                  </small>
                                  <code
                                    title={
                                      canCopyName(reference.value)
                                        ? undefined
                                        : '请在文本中手动选择并复制'
                                    }
                                  >
                                    {reference.value}
                                  </code>
                                </div>
                              ))}
                            </div>
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`修改文件 ${sample.code} 操作 ${item.order + 1}`}
                              onClick={() => setFileRunId(run.id)}
                            >
                              修改
                            </button>
                            </>
                          ) : (
                            <>
                              <span className="review-file-state">未关联</span>
                              <button
                                type="button"
                                className="text-button"
                                aria-label={`填写文件 ${sample.code} 操作 ${item.order + 1}`}
                                onClick={() => setFileRunId(run.id)}
                              >
                                填写
                              </button>
                            </>
                          )
                        ) : (
                          <span className="review-file-state">尚未开始</span>
                        )}
                      </td>
                      <td>
                        <p className="review-note">{run?.notes || '—'}</p>
                        {run && (
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`修改备注 ${sample.code} 操作 ${item.order + 1}`}
                            onClick={() => setNoteRunId(run.id)}
                          >
                            修改
                          </button>
                        )}
                      </td>
                      <td>
                        <div className="review-actions">
                          <button
                            className="text-button"
                            onClick={() => {
                              setItemId(item.id);
                              setPage('live');
                            }}
                          >
                            查看
                          </button>
                          {(item.status === 'completed' || item.status === 'interrupted') && (
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`安排重测 ${sample.code} 操作 ${item.order + 1}`}
                              onClick={() => {
                                if (repeating.current.has(item.id)) return;
                                repeating.current.add(item.id);
                                void flush()
                                  .then(() => execute({ type: 'repeat', itemId: item.id }, false))
                                  .catch((error) => notify(error.message, true))
                                  .finally(() => repeating.current.delete(item.id));
                              }}
                            >
                              安排重测
                            </button>
                          )}
                          {run && (
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`修改实际尺寸 ${sample.code} 操作 ${item.order + 1}`}
                              onClick={() => setThicknessRunId(run.id)}
                            >
                              实际尺寸
                            </button>
                          )}
                          {run && (
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`修改实际制备 ${sample.code} 操作 ${item.order + 1}`}
                              onClick={() => setPreparationRunId(run.id)}
                            >
                              实际制备
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() =>
                              setTimes({
                                itemId: item.id,
                                experimentId: item.experimentId,
                                runId: run?.id,
                              })
                            }
                          >
                            时间
                          </button>
                          <button className="text-button" onClick={() => setHistory(item.id)}>
                            历史
                          </button>
                          <button
                            type="button"
                            className="text-button danger"
                            aria-label={`删除测量 ${sample.code}`}
                            title={deleteReason || '删除这项还没开始的测量'}
                            disabled={!!deleteReason}
                            onClick={() =>
                              setPendingDelete(itemsDeleteRequest(snapshot, [item.id]))
                            }
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="还没有计划操作"
            description="先在规划页安排测量操作，之后可在这里回看实际记录。"
          />
        ) : (
          <Empty
            title="没有符合条件的记录"
            description="试试调整搜索或筛选条件。未关联到操作的问题仍保留在上方的问题明细中。"
          >
            <button type="button" className="button" onClick={clearFilters}>
              清除筛选
            </button>
          </Empty>
        )}
        <div className="table-footer">
          <span>计划内容在开始操作时保存 · 修改历史可追溯</span>
          <span>右键可查看、复制、改时间或删除还没开始的测量 · 导出不受筛选影响</span>
        </div>
      </section>
      {history && (
        <Modal title="记录与修改历史" wide onClose={() => setHistory(null)}>
          <div className="history-list">
            {operationHistory(snapshot, history)
              .slice()
              .reverse()
              .map((event) => (
                <article key={event.id}>
                  <time>{eventTimeLabel(snapshot, event) || timeText(event.createdAt, true)}</time>
                  <strong>{eventLabel(event.type)}</strong>
                  <p>{event.text}</p>
                  {eventEarlierText(event) && (
                    <small className="issue-earlier">{eventEarlierText(event)}</small>
                  )}
                  {Object.keys(eventDetailData(event)).length > 0 && (
                    <pre>{JSON.stringify(eventDetailData(event), null, 2)}</pre>
                  )}
                </article>
              ))}
            {operationHistory(snapshot, history).length === 0 && (
              <p className="hint">这条操作还没有单独的修改历史。</p>
            )}
          </div>
        </Modal>
      )}
      {times && <TimesDialog {...times} onClose={() => setTimes(null)} />}
      {fileRunId && <FileLinkDialog runId={fileRunId} onClose={() => setFileRunId(null)} />}
      {noteRunId && <NoteDialog runId={noteRunId} onClose={() => setNoteRunId(null)} />}
      {thicknessRunId && (
        <ThicknessDialog runId={thicknessRunId} onClose={() => setThicknessRunId(null)} />
      )}
      {preparationRunId && (
        <PreparationDialog runId={preparationRunId} onClose={() => setPreparationRunId(null)} />
      )}
      {pictureItemId && <PicturesDialog itemId={pictureItemId} onClose={() => setPictureItemId(null)} />}
      {issueEditId && <IssueEditDialog eventId={issueEditId} onClose={() => setIssueEditId(null)} />}
      {menu}
      <DeleteConfirm pending={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}
