import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ArrowRight, ChevronRight } from 'lucide-react';
import type { Experiment, PlanItem, Status } from '../shared/model';
import { sampleName, STATUS_LABEL } from '../shared/model';
import { reportInsights } from '../shared/summary';
import { formatRecordedDuration, recordedDuration } from '../shared/duration';
import { followUpRoster, followUpSets } from '../shared/followUps';
import { recordedPlanChangeText } from '../shared/planChanges';
import { latestRecorded } from '../shared/library';
import { actualFilenameLabel, actualScanLabel, canCopyName } from '../shared/copyText';
import { unwrap, useWorkspace } from './context';
import { Modal, timeText } from './components';
import { recordedClock } from '../shared/recordedTime';
import { eventTimeLabel, issueEarlierText } from '../shared/history';
import { overviewIssue, overviewOperation } from './overview';
import './overview.css';

const STATUSES: Status[] = ['pending', 'running', 'completed', 'skipped', 'interrupted'];

export function ExperimentOverview({
  experiment,
  onClose,
}: {
  experiment: Experiment;
  onClose: () => void;
}) {
  const { snapshot, getSnapshot, setPage, setItemId, setExperimentId, execute, flush, notify } =
    useWorkspace();
  const [resolving, setResolving] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const groups = snapshot.groups.filter((g) => g.experimentId === experiment.id);
  const insights = reportInsights(snapshot, experiment.id);
  const duration = recordedDuration(
    snapshot.runs.filter((run) => run.experimentId === experiment.id),
  );
  const roster = followUpRoster(snapshot, experiment.id);
  const unlinkedIssues = followUpSets(snapshot, experiment.id).unlinkedIssues;
  const actualChanges = snapshot.items
    .filter((item) => item.experimentId === experiment.id)
    .sort((a, b) => a.order - b.order)
    .flatMap((item) => {
      const run = snapshot.runs.find((entry) => entry.itemId === item.id);
      const text = recordedPlanChangeText(run);
      if (!text || !run) return [];
      return [{ item, code: run.snapshot.sample.code, text: text.replaceAll('\n', '；') }];
    });
  const issues = snapshot.events.filter(
    (e) => e.experimentId === experiment.id && e.type === 'issue' && !e.data.resolvedAt,
  );
  const preparationUnknown = groups.length > 0 && insights.unknownPreparation === groups.length;
  const completion = insights.plannedOperations
    ? Math.round((insights.completed / insights.plannedOperations) * 100)
    : 0;
  const recent = latestRecorded(snapshot, experiment.id);
  const running = snapshot.items.find((i) => i.status === 'running');
  const runningExperiment = snapshot.experiments.find((e) => e.id === running?.experimentId);
  const current = running && overviewOperation(snapshot, running);
  const runningClock = current?.run
    ? recordedClock(current.run.startedAt, current.run.offsetMinutes, current.run.timezone)
    : null;
  const blocked = navigating || resolving !== null;

  useEffect(() => {
    document.documentElement.classList.add('has-experiment-overview');
    return () => document.documentElement.classList.remove('has-experiment-overview');
  }, []);

  async function resolveIssue(eventId: string) {
    if (blocked) return;
    setResolving(eventId);
    try {
      await execute({ type: 'resolveIssue', eventId }, false);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setResolving(null);
    }
  }

  async function viewOperation(item: PlanItem) {
    if (blocked) return;
    setNavigating(true);
    try {
      await flush();
      setExperimentId(item.experimentId);
      setItemId(item.id);
      setPage('live');
      onClose();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setNavigating(false);
    }
  }

  return (
    <Modal
      title="实验概览"
      onClose={onClose}
      closeDisabled={blocked}
      wide
      className="overview-modal"
    >
      <div className="overview-content">
        <div className="overview-heading">
          <div>
            <p className="eyebrow">当前查看的实验 · {experiment.code}</p>
            <h3>{experiment.name}</h3>
          </div>
          <span>{groups.length} 个样品组</span>
        </div>
        {current && runningExperiment && (
          <section
            className={`overview-current ${runningExperiment.id !== experiment.id ? 'overview-other-running' : ''}`}
            aria-label="全库进行中的操作"
          >
            <div className="overview-section-heading">
              <h3>全库进行中的操作</h3>
              <button
                className="button small"
                disabled={blocked}
                onClick={() => void viewOperation(current.item)}
              >
                <ArrowRight size={16} />
                {navigating
                  ? '正在保存…'
                  : runningExperiment.id === experiment.id
                    ? '返回当前操作'
                    : '切换并返回'}
              </button>
            </div>
            <p>实验“{runningExperiment.name}”中有进行中的操作。</p>
            {current.sample && current.group && (
              <div className="current-operation">
                <div>
                  <strong>
                    {current.sample.code} · {current.item.operation}
                  </strong>
                  <p>
                    {current.run?.actualSample?.name ||
                      sampleName({ ...current.group, ...current.sample.parameters })}
                  </p>
                  <small>
                    物理样品 ID：<code>{current.sample.id}</code>
                  </small>
                  {current.run?.filename && <small>数据文件夹：{current.run.filename}</small>}
                  {actualFilenameLabel(current.run) && <small>{actualFilenameLabel(current.run)}</small>}
                  {actualScanLabel(current.run) && <small>{actualScanLabel(current.run)}</small>}
                  {canCopyName(current.run?.filename) && (
                    <button
                      type="button"
                      className="text-button"
                      aria-label="在概览中复制进行中的数据文件夹"
                      disabled={blocked}
                      onClick={() => {
                        void flush()
                          .then(async () => {
                            const data = getSnapshot();
                            const runningItem = data.items.find((item) => item.status === 'running');
                            const record =
                              runningItem && data.runs.find((run) => run.itemId === runningItem.id);
                            const name = record?.filename || '';
                            if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
                            await unwrap(window.labrecord.copyName(name));
                            notify('进行中的数据文件夹名已复制。');
                          })
                          .catch((error) => notify((error as Error).message, true));
                      }}
                    >
                      复制文件夹
                    </button>
                  )}
                  {canCopyName(String(current.run?.actual.filename || '').trim()) && (
                    <button
                      type="button"
                      className="text-button"
                      aria-label="在概览中复制进行中的实际文件名"
                      disabled={blocked}
                      onClick={() => {
                        void flush()
                          .then(async () => {
                            const data = getSnapshot();
                            const runningItem = data.items.find((item) => item.status === 'running');
                            const record =
                              runningItem && data.runs.find((run) => run.itemId === runningItem.id);
                            const name = String(record?.actual.filename || '').trim();
                            if (!canCopyName(name)) throw new Error('还没有可复制的实际文件名。');
                            await unwrap(window.labrecord.copyName(name));
                            notify('进行中的实际文件名已复制。');
                          })
                          .catch((error) => notify((error as Error).message, true));
                      }}
                    >
                      复制文件名
                    </button>
                  )}
                  {canCopyName(String(current.run?.actual.scanId || '').trim()) && (
                    <button
                      type="button"
                      className="text-button"
                      aria-label="在概览中复制进行中的扫描编号"
                      disabled={blocked}
                      onClick={() => {
                        void flush()
                          .then(async () => {
                            const data = getSnapshot();
                            const runningItem = data.items.find((item) => item.status === 'running');
                            const record =
                              runningItem && data.runs.find((run) => run.itemId === runningItem.id);
                            const name = String(record?.actual.scanId || '').trim();
                            if (!canCopyName(name)) throw new Error('还没有可复制的扫描编号。');
                            await unwrap(window.labrecord.copyName(name));
                            notify('进行中的扫描编号已复制。');
                          })
                          .catch((error) => notify((error as Error).message, true));
                      }}
                    >
                      复制扫描编号
                    </button>
                  )}
                </div>
                <span>
                  {runningClock ? `${runningClock.clock} ${runningClock.zone}` : '尚未记录'}
                </span>
              </div>
            )}
          </section>
        )}
        {recent && (
          <section className="overview-record" aria-label="最近记录">
            <div className="overview-section-heading">
              <h3>
                {recent.status === 'interrupted' ? '最近中断' : '最近完成'} {recent.sampleCode}
              </h3>
              <button
                type="button"
                className="button small"
                aria-label={`打开最近记录 ${recent.sampleCode}`}
                disabled={blocked}
                onClick={() => {
                  const item = snapshot.items.find((entry) => entry.id === recent.itemId);
                  if (item) void viewOperation(item);
                }}
              >
                打开
              </button>
            </div>
            <p>
              {[
                recent.duration ? `用时 ${recent.duration}` : '',
                recent.endedClock,
                recent.scanId ? `扫描 ${recent.scanId}` : '',
                recent.fileLabel,
                recent.folder,
                recent.openIssue,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {canCopyName(recent.folder) && (
              <button
                type="button"
                className="text-button"
                aria-label={`复制最近记录文件夹 ${recent.sampleCode}`}
                disabled={blocked}
                onClick={() => {
                  void flush()
                    .then(async () => {
                      const fresh = latestRecorded(getSnapshot(), experiment.id);
                      const name = fresh?.folder || '';
                      if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
                      await unwrap(window.labrecord.copyName(name));
                      notify('最近记录的数据文件夹名已复制。');
                    })
                    .catch((error) => notify((error as Error).message, true));
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
                disabled={blocked}
                onClick={() => {
                  void flush()
                    .then(async () => {
                      const fresh = latestRecorded(getSnapshot(), experiment.id);
                      const name = fresh?.scanId || '';
                      if (!canCopyName(name)) throw new Error('还没有可复制的扫描编号。');
                      await unwrap(window.labrecord.copyName(name));
                      notify('最近记录的扫描编号已复制。');
                    })
                    .catch((error) => notify((error as Error).message, true));
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
                disabled={blocked}
                onClick={() => {
                  void flush()
                    .then(async () => {
                      const fresh = latestRecorded(getSnapshot(), experiment.id);
                      const name = fresh?.filename || '';
                      if (!canCopyName(name)) throw new Error('还没有可复制的实际文件名。');
                      await unwrap(window.labrecord.copyName(name));
                      notify('最近记录的实际文件名已复制。');
                    })
                    .catch((error) => notify((error as Error).message, true));
                }}
              >
                复制文件名
              </button>
            )}
          </section>
        )}
        <section className="overview-stats" aria-label="样品与操作统计">
          <article className="stat-card" aria-label="准备数量">
            <div className="stat-label">准备数量</div>
            <div className="stat-value">
              {preparationUnknown ? '未知' : insights.preparedKnown}
              {!preparationUnknown && <small>个</small>}
            </div>
            <div className="stat-detail">
              {preparationUnknown
                ? '准备总数未填写'
                : insights.unknownPreparation
                  ? '已知小计 · 包含备样'
                  : '包含备样'}
            </div>
            {insights.unknownPreparation > 0 && (
              <div className="stat-detail">{insights.unknownPreparation} 组准备数量未知</div>
            )}
          </article>
          <article className="stat-card" aria-label="计划样品">
            <div className="stat-label">计划样品</div>
            <div className="stat-value">
              {insights.plannedSamples}
              <small>个</small>
            </div>
            <div className="stat-detail">不同物理样品 · 重测复用样品</div>
          </article>
          <article className="stat-card" aria-label="计划操作">
            <div className="stat-label">计划操作</div>
            <div className="stat-value">
              {insights.plannedOperations}
              <small>项</small>
            </div>
            <div className="stat-detail">含 {insights.repeats} 项重测</div>
          </article>
          <article className="stat-card" aria-label="备样">
            <div className="stat-label">备样</div>
            <div className="stat-value">
              {preparationUnknown ? '未知' : insights.spareKnown}
              {!preparationUnknown && <small>个</small>}
            </div>
            <div className="stat-detail">
              {preparationUnknown
                ? '备样总数未知'
                : insights.unknownPreparation
                  ? '已知小计 · 尚未启用'
                  : '尚未启用 · 不计入计划'}
            </div>
            {insights.unknownPreparation > 0 && (
              <div className="stat-detail">{insights.unknownPreparation} 组备样数量未知</div>
            )}
          </article>
        </section>

        <section className="overview-operations" aria-labelledby="overview-progress-title">
          <div className="overview-section-heading">
            <h3 id="overview-progress-title">操作进度</h3>
            <span aria-label="完成进度">
              {insights.completed} / {insights.plannedOperations} 项已完成
              {insights.plannedOperations ? ` · ${completion}%` : ' · 暂无计划操作'}
            </span>
          </div>
          <progress
            aria-label="已完成操作占比"
            value={insights.completed}
            max={insights.plannedOperations || 1}
          />
          <div className="operation-breakdown">
            {STATUSES.map((status) => (
              <div
                key={status}
                className={`operation-stat ${status}`}
                aria-label={STATUS_LABEL[status]}
              >
                <span className="operation-dot" aria-hidden="true" />
                <span>{STATUS_LABEL[status]}</span>
                <strong>{insights[status]}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="overview-record" aria-label="已记录用时">
          <div className="overview-section-heading">
            <h3>已记录用时</h3>
            <span>
              {duration.completeCount
                ? formatRecordedDuration(duration.milliseconds)
                : '尚无完整起止'}
            </span>
          </div>
          <p>
            {duration.incompleteCount
              ? `${duration.incompleteCount} 次起止不完整，未计入。`
              : '只累加起止都已写下、且结束不早于开始的间隔。'}
          </p>
        </section>

        {actualChanges.length > 0 && (
          <section className="overview-roster" aria-label="实际与开始时不同">
            <div className="overview-section-heading">
              <h3>实际与开始时不同</h3>
              <span>尚未开始的计划不列入</span>
            </div>
            <ul className="follow-up-roster" aria-label="实际与开始时不同的操作">
              {actualChanges.map((entry) => (
                <li key={entry.item.id}>
                  <button
                    type="button"
                    aria-label={`打开实际已改 ${entry.code} 操作 ${entry.item.order + 1}`}
                    disabled={blocked}
                    onClick={() => {
                      void viewOperation(entry.item);
                    }}
                  >
                    <strong>{entry.code}</strong>
                    <span>{entry.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(roster.length > 0 || unlinkedIssues > 0) && (
          <section className="overview-roster" aria-labelledby="overview-roster-title">
            <div className="overview-section-heading">
              <h3 id="overview-roster-title">待核对清单</h3>
              <span>尚未开始的计划不列入</span>
            </div>
            {roster.length > 0 && (
              <ul className="follow-up-roster" aria-label="待核对清单">
                {roster.map((entry) => {
                  const item = snapshot.items.find((candidate) => candidate.id === entry.itemId);
                  return (
                    <li key={entry.itemId}>
                      <button
                        type="button"
                        aria-label={`打开 ${entry.sampleCode}`}
                        disabled={blocked || !item}
                        onClick={() => {
                          if (item) void viewOperation(item);
                        }}
                      >
                        <strong>{entry.sampleCode}</strong>
                        <span>{entry.gaps.join('、')}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {unlinkedIssues > 0 && <p>未关联到操作的问题：{unlinkedIssues} 条。</p>}
          </section>
        )}

        <section className="overview-issues" aria-labelledby="overview-issues-title">
          <div className="overview-section-heading">
            <h3 id="overview-issues-title">未处理问题 ({insights.unresolvedIssues})</h3>
            <span>完成操作后仍需处理问题</span>
          </div>
          {issues.length ? (
            <div className="issues-list">
              {issues.map((issue) => {
                const target = overviewIssue(snapshot, issue);
                return (
                  <article key={issue.id} className="issue-item" aria-label={`问题：${issue.text}`}>
                    <div className="issue-header">
                      <AlertCircle size={17} className="issue-icon" aria-hidden="true" />
                      <span className="issue-category">
                        {String(issue.data.category || '未分类')}
                      </span>
                      <time className="issue-time" dateTime={issue.createdAt}>
                        {eventTimeLabel(snapshot, issue) || timeText(issue.createdAt, true)}
                      </time>
                    </div>
                    <p className="issue-text">{issue.text}</p>
                    {issueEarlierText(issue) && (
                      <small className="issue-earlier">{issueEarlierText(issue)}</small>
                    )}
                    <small className="issue-sample">
                      {target?.sample
                        ? `样品：${target.sample.code} · ${target.group?.state || ''}`
                        : '实验问题 · 未关联样品'}
                    </small>
                    <details className="issue-details">
                      <summary>查看详情</summary>
                      <dl>
                        <dt>问题 ID</dt>
                        <dd>
                          <code>{issue.id}</code>
                        </dd>
                        <dt>物理样品 ID</dt>
                        <dd>{target?.sample ? <code>{target.sample.id}</code> : '未关联样品'}</dd>
                        <dt>样品名称</dt>
                        <dd>
                          {target?.group && target.sample
                            ? sampleName({ ...target.group, ...target.sample.parameters })
                            : '未关联样品'}
                        </dd>
                        <dt>操作 ID</dt>
                        <dd>{target?.item ? <code>{target.item.id}</code> : '未关联操作'}</dd>
                        <dt>实际记录 ID</dt>
                        <dd>{issue.runId ? <code>{issue.runId}</code> : '未关联实际记录'}</dd>
                      </dl>
                    </details>
                    <div className="issue-actions">
                      {target?.sample && (
                        <button
                          className="text-button"
                          disabled={blocked}
                          onClick={() => void viewOperation(target.item)}
                        >
                          查看现场 <ChevronRight size={14} />
                        </button>
                      )}
                      <button
                        className="button small"
                        disabled={blocked}
                        onClick={() => void resolveIssue(issue.id)}
                      >
                        {resolving === issue.id ? '标记中…' : '标记已处理'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="overview-empty">
              <CheckCircle2 size={24} aria-hidden="true" />
              <p>暂无未处理问题</p>
            </div>
          )}
        </section>
        <footer className="modal-actions">
          <button className="button" disabled={blocked} onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </Modal>
  );
}
