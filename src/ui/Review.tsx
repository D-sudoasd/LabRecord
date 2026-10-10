import { useState } from 'react';
import {
  Download,
  ClipboardCheck,
  AlertTriangle,
  Clock,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import { useWorkspace, unwrap, type EventTarget } from './context';
import { StatusPill, Empty, timeText, Modal, eventLabel, SearchField } from './components';
import { TimesDialog } from './Live';
import { sampleName } from '../shared/model';
import { reportInsights } from '../shared/summary';
import { measurementFor, measurementSummary } from '../shared/measurement';
import { materialSummary } from '../shared/materials';
import { MaterialPreparationSummary } from './MaterialPreparation';
import {
  DeleteConfirm,
  itemsDeleteReason,
  itemsDeleteRequest,
  useContextMenu,
  type PendingDelete,
} from './rowMenu';
export function Review() {
  const { snapshot, experimentId, notify, flush, setItemId, setPage, execute } = useWorkspace();
  const items = snapshot.items
    .filter((i) => i.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const [search, setSearch] = useState(''),
    [problemsOnly, setProblemsOnly] = useState(false),
    [history, setHistory] = useState<string | null>(null),
    [times, setTimes] = useState<EventTarget | null>(null),
    [exporting, setExporting] = useState(false),
    [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const { open: openMenu, menu } = useContextMenu();
  const issues = snapshot.events.filter(
      (e) => e.experimentId === experimentId && e.type === 'issue',
    ),
    unresolved = issues.filter((e) => !e.data.resolvedAt);
  const visible = items.filter((item) => {
    const sample = snapshot.samples.find((s) => s.id === item.sampleId)!;
    const run = snapshot.runs.find((r) => r.itemId === item.id);
    const group = run?.snapshot.group || snapshot.groups.find((g) => g.id === sample.groupId)!;
    return (
      `${sampleName(group)} ${group.state} ${materialSummary(group)} ${run?.actualSample?.name || ''} ${run?.snapshot.sample.code || sample.code} ${run?.notes || ''} ${run?.actual.filename || ''} ${run?.actual.scanId || ''} ${measurementSummary(measurementFor(snapshot, item))} ${run?.filename || item.plannedName || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!problemsOnly || issues.some((e) => e.itemId === item.id))
    );
  });
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
          <div className="eyebrow">03 / 回看导出</div>
          <h1>回看实验，把记录带走</h1>
          <p>核对计划与实际操作，按样品、文件名或备注查找记录。</p>
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
          <small className="hint">
            待核对：{checks.missingTimes} 次时间不完整 · {checks.missingFiles} 次文件关联未补充 ·{' '}
            {checks.unresolvedIssues} 条未处理问题
          </small>
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
            {issues.map((issue) => (
              <div
                className={`review-issue ${issue.data.resolvedAt ? 'resolved' : ''}`}
                key={issue.id}
              >
                <AlertTriangle size={16} />
                <div>
                  <strong>
                    {String(issue.data.category)} ·{' '}
                    {snapshot.samples.find(
                      (s) => s.id === snapshot.items.find((i) => i.id === issue.itemId)?.sampleId,
                    )?.code || '实验记录'}
                  </strong>
                  <p>{issue.text}</p>
                  <small>{timeText(issue.createdAt, true)}</small>
                </div>
                {issue.data.resolvedAt ? (
                  <span className="resolved-label">已处理</span>
                ) : (
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
            ))}
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
              placeholder="样品 / 文件名 / 备注"
              value={search}
              onChange={setSearch}
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(event) => setProblemsOnly(event.target.checked)}
              />
              只看有问题的操作
            </label>
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
        {visible.length ? (
          <div className="table-wrap">
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
                        {(run?.filename || item.plannedName) && (
                          <small className="review-folder-name">
                            {run?.filename || item.plannedName}
                          </small>
                        )}
                      </td>
                      <td>
                        <StatusPill status={item.status} />
                      </td>
                      <td>
                        {run?.startedAt ? (
                          timeText(run.startedAt, true)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {run?.endedAt ? (
                          timeText(run.endedAt, true)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <code>{String(run?.actual.filename || run?.filename || '—')}</code>
                        <small>{String(run?.actual.scanId || '')}</small>
                      </td>
                      <td>
                        <p className="review-note">{run?.notes || '—'}</p>
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
        ) : (
          <Empty
            title="还没有操作记录"
            description="在现场页开始操作，或补录已有实验的时间与备注。"
          />
        )}
        <div className="table-footer">
          <span>计划内容在开始操作时保存 · 修改历史可追溯</span>
          <span>右键可查看、改时间或删除还没开始的测量 · 导出不受筛选影响</span>
        </div>
      </section>
      {history && (
        <Modal title="记录与修改历史" wide onClose={() => setHistory(null)}>
          <div className="history-list">
            {snapshot.events
              .filter((e) => e.itemId === history)
              .reverse()
              .map((event) => (
                <article key={event.id}>
                  <time>{timeText(event.createdAt, true)}</time>
                  <strong>{eventLabel(event.type)}</strong>
                  <p>{event.text}</p>
                  {Object.keys(event.data).length > 0 && (
                    <pre>{JSON.stringify(event.data, null, 2)}</pre>
                  )}
                </article>
              ))}
          </div>
        </Modal>
      )}
      {times && <TimesDialog {...times} onClose={() => setTimes(null)} />}
      {menu}
      <DeleteConfirm pending={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}
