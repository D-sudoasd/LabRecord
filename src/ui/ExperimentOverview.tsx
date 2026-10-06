import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ArrowRight, ChevronRight } from 'lucide-react';
import type { Experiment, PlanItem, Status } from '../shared/model';
import { sampleName, STATUS_LABEL } from '../shared/model';
import { reportInsights } from '../shared/summary';
import { useWorkspace } from './context';
import { Modal, timeText } from './components';
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
  const { snapshot, setPage, setItemId, setExperimentId, execute, flush, notify } = useWorkspace();
  const [resolving, setResolving] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const groups = snapshot.groups.filter((g) => g.experimentId === experiment.id);
  const insights = reportInsights(snapshot, experiment.id);
  const issues = snapshot.events.filter(
    (e) => e.experimentId === experiment.id && e.type === 'issue' && !e.data.resolvedAt,
  );
  const preparationUnknown = groups.length > 0 && insights.unknownPreparation === groups.length;
  const completion = insights.plannedOperations
    ? Math.round((insights.completed / insights.plannedOperations) * 100)
    : 0;
  const running = snapshot.items.find((i) => i.status === 'running');
  const runningExperiment = snapshot.experiments.find((e) => e.id === running?.experimentId);
  const current = running && overviewOperation(snapshot, running);
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
                </div>
                <span>{timeText(current.run?.startedAt || null, true)}</span>
              </div>
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
                        {timeText(issue.createdAt, true)}
                      </time>
                    </div>
                    <p className="issue-text">{issue.text}</p>
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
