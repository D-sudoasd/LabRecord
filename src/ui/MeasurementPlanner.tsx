import { useId, useRef, useState } from 'react';
import { Copy, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { MeasurementPlan, PlanItem } from '../shared/model';
import { MODE_OPTIONS } from '../shared/model';
import {
  measurementFor,
  measurementSummary,
  REGIMES,
  reserveMeasurementNames,
} from '../shared/measurement';
import { useWorkspace, unwrap, DesktopReplyError } from './context';
import { Modal, SearchField, StatusPill, useCommandClose } from './components';
import {
  DeleteConfirm,
  itemsDeleteReason,
  itemsDeleteRequest,
  useContextMenu,
  type DeleteRequest,
  type PendingDelete,
} from './rowMenu';

export function MeasurementFields({
  value,
  onChange,
  compact = false,
}: {
  value: MeasurementPlan;
  onChange: (value: MeasurementPlan) => void;
  compact?: boolean;
}) {
  const listId = useId();
  const set = (key: keyof MeasurementPlan, text: string) => onChange({ ...value, [key]: text });
  return (
    <div className="form-grid measurement-fields">
      {!compact && (
        <label className="field">
          <span>实验方式</span>
          <select
            aria-label="实验方式"
            value={value.mode ?? '未定'}
            onChange={(event) => set('mode', event.target.value)}
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>测量技术</span>
        <input
          aria-label="测量技术"
          list={`${listId}-techniques`}
          value={value.technique ?? ''}
          maxLength={80}
          onChange={(event) => set('technique', event.target.value)}
          placeholder="SXRD、SAXS 或自定义"
        />
        <datalist id={`${listId}-techniques`}>
          <option value="SXRD" />
          <option value="SAXS" />
          <option value="XAS" />
          <option value="成像" />
        </datalist>
      </label>
      <label className="field">
        <span>制度短码</span>
        <input
          aria-label="制度短码"
          list={`${listId}-regimes`}
          value={value.regime ?? ''}
          maxLength={80}
          onChange={(event) => set('regime', event.target.value)}
          placeholder="选择常用制度，或输入短码"
        />
        <datalist id={`${listId}-regimes`}>
          {REGIMES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </datalist>
        <small>用来区分同一件样品上的不同测量，如单调、循环、分级、旋转。</small>
      </label>
      <label className="field">
        <span>批次</span>
        <input
          aria-label="批次"
          value={value.batch ?? ''}
          onChange={(event) => set('batch', event.target.value)}
          maxLength={80}
          placeholder="如 B01、RT、350C-Ar"
        />
        <small>需要区分温度、气氛或方向时，在这里写简短标记。</small>
      </label>
      {!compact && (
        <label className="field span-2">
          <span>本次制度与条件</span>
          <textarea
            aria-label="本次制度与条件"
            rows={3}
            value={value.protocol ?? ''}
            maxLength={50000}
            onChange={(event) => set('protocol', event.target.value)}
            placeholder="如应变速率 1e-3 s⁻¹；0–2% 循环 10 次；或旋转范围、步长、曝光、温度与气氛"
          />
          <small>记录计划条件；原位和离位均可填写。切换方式不会清空文字。</small>
        </label>
      )}
    </div>
  );
}

export function MeasurementDialog({
  items,
  append = false,
  onClose,
}: {
  items: PlanItem[];
  append?: boolean;
  onClose: () => void;
}) {
  const { snapshot, execute, flush } = useWorkspace();
  const [value, setValue] = useState<MeasurementPlan>(() => ({
    ...measurementFor(snapshot, items[0]),
    ...(append ? { customName: '' } : {}),
  }));
  const [repetitions, setRepetitions] = useState('1');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const pending = useRef<{ command: import('../shared/model').Command; requestId: string } | null>(
    null,
  );
  const { close, closing } = useCommandClose({
    pending: !!pending.current,
    busy,
    onClose,
    onError: setError,
  });
  const experimentId = items[0].experimentId;
  const copies = append ? Number(repetitions) : 1;
  const validCopies =
    Number.isInteger(copies) && copies >= 1 && copies <= 100 && copies * items.length <= 1000;
  const historySignatures = new Set<string>();
  const history = snapshot.items
    .filter((item) => {
      if (
        !item.measurement &&
        !snapshot.runs.find((run) => run.itemId === item.id)?.snapshot.measurement
      )
        return false;
      const key = JSON.stringify({ ...measurementFor(snapshot, item), customName: '' });
      if (historySignatures.has(key)) return false;
      historySignatures.add(key);
      return true;
    })
    .slice(-80)
    .reverse();
  const multiple = items.length * copies > 1;
  const baseline = measurementFor(snapshot, items[0]);
  const owned = items[0].measurement ?? {};
  const changes = { ...value };
  // Leave inherited blanks unset so a later group protocol still applies. An edit, including an explicit empty string, is stored.
  (['mode', 'protocol', 'technique', 'regime', 'batch', 'customName'] as const).forEach((key) => {
    if (owned[key] === undefined && changes[key] === baseline[key]) delete changes[key];
  });
  if (multiple) delete changes.customName;
  let names: PlanItem[] = [],
    previewError = '';
  try {
    if (validCopies) {
      const end = Math.max(
        -1,
        ...snapshot.items
          .filter((item) => item.experimentId === experimentId)
          .map((item) => item.order),
      );
      const targets = items.flatMap((item, index) =>
        Array.from({ length: copies }, (_, copy) => ({
          ...item,
          measurement: { ...item.measurement, ...(append ? { customName: '' } : {}), ...changes },
          ...(append
            ? {
                id: `preview-${index}-${copy}`,
                order: end + 1 + index * copies + copy,
                nameNumber: undefined,
                plannedName: undefined,
              }
            : {}),
        })),
      );
      names = reserveMeasurementNames(snapshot, experimentId, targets);
    }
  } catch (failure) {
    previewError = (failure as Error).message;
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || closing || !validCopies || previewError) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await flush();
      // Keep an identical intent if a reply is lost after the transaction commits.
      pending.current ??= {
        requestId: requestId.current,
        command: append
          ? {
              type: 'scheduleMeasurements',
              itemIds: items.map((item) => item.id),
              repetitions: copies,
              measurement: changes,
            }
          : {
              type: 'configureMeasurements',
              ids: items.map((item) => item.id),
              measurement: changes,
            },
      };
      await execute(pending.current.command, false, pending.current.requestId);
      onClose();
    } catch (failure) {
      if (failure instanceof DesktopReplyError && failure.rejected) {
        pending.current = null;
        requestId.current = crypto.randomUUID();
      }
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={append ? '同一样品追加制度' : '配置测量制度'}
      onClose={close}
      wide
      closeDisabled={busy || closing}
    >
      <form className="form-stack" onSubmit={submit}>
        <p className="hint">
          {append
            ? '每个所选操作追加独立测量，复用物理样品，不占用备样。'
            : '统一配置所选待测操作，已有实际记录保持固定。'}{' '}
          已选 {items.length} 项。
        </p>
        <fieldset disabled={busy || closing || !!pending.current} className="measurement-editor">
          {history.length > 0 && (
            <label className="field">
              <span>复用历史测量配置</span>
              <select
                aria-label="复用历史测量配置"
                defaultValue=""
                onChange={(event) => {
                  const item = snapshot.items.find((entry) => entry.id === event.target.value);
                  if (item) setValue({ ...measurementFor(snapshot, item), customName: '' });
                }}
              >
                <option value="">选择本机已有配置…</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {snapshot.experiments.find((entry) => entry.id === item.experimentId)?.code} ·{' '}
                    {measurementSummary(measurementFor(snapshot, item))} ·{' '}
                    {measurementFor(snapshot, item).protocol?.slice(0, 50)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <MeasurementFields value={value} onChange={setValue} />
          {append && (
            <label className="field">
              <span>每项追加次数</span>
              <input
                aria-label="每项追加次数"
                type="number"
                min={1}
                max={100}
                required
                value={repetitions}
                onChange={(event) => setRepetitions(event.target.value)}
              />
              <small>
                共追加 {validCopies ? items.length * copies : '—'}{' '}
                项。每项保留独立名称、制度和记录。
              </small>
            </label>
          )}
          <details className="folder-rule">
            <summary>改这一项的文件夹名</summary>
            <label className="field">
              <span>文件夹名</span>
              <input
                aria-label="文件夹名"
                value={multiple ? '' : (value.customName ?? '')}
                disabled={multiple}
                maxLength={200}
                onChange={(event) => setValue({ ...value, customName: event.target.value })}
                placeholder="留空则用实验编号和样品编号"
              />
              <small>
                {multiple
                  ? '多项一起改时，各自的文件夹名保持不动。'
                  : '只改这一项。同一件样品再测时会重新生成。'}
              </small>
            </label>
          </details>
        </fieldset>
        {!validCopies && (
          <p className="error-text" role="alert">
            追加次数应为 1–100 的整数，一次最多追加 1000 项。
          </p>
        )}
        <div className="measurement-name-preview" aria-label="测量名称预览" aria-live="polite">
          <strong>数据文件夹</strong>
          {names.slice(0, 5).map((item) => (
            <code key={item.id}>{item.plannedName}</code>
          ))}
          {names.length > 5 && <small>另有 {names.length - 5} 项，保存后可在测量计划查看。</small>}
          {previewError && (
            <p className="error-text" role="alert">
              {previewError}
            </p>
          )}
        </div>
        {(error || pending.current) && (
          <p className="error-text" role="alert">
            {error}
            {pending.current && ' 本次内容已固定，请重试同一保存请求。'}
          </p>
        )}
        <footer className="modal-actions">
          <button className="button" type="button" disabled={busy || closing} onClick={close}>
            {pending.current ? '返回查看记录' : '取消'}
          </button>
          <button
            className="button primary"
            disabled={busy || closing || !validCopies || !!previewError}
          >
            {busy
              ? '正在保存…'
              : pending.current
                ? '重试保存'
                : append
                  ? '追加测量计划'
                  : '保存测量配置'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function MeasurementPlanner() {
  const workspace = useWorkspace();
  const { snapshot, experimentId, setItemId, setPage, notify, flush } = workspace;
  const items = snapshot.items
    .filter((item) => item.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const [search, setSearch] = useState(''),
    [selected, setSelected] = useState(new Set<string>());
  const [dialog, setDialog] = useState<{ ids: string[]; append: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const { open: openMenu, menu } = useContextMenu();
  function askDelete(request: DeleteRequest, ids: string[]) {
    setPendingDelete({
      ...request,
      onDone: () =>
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) next.delete(id);
          return next;
        }),
    });
  }
  function copyFolder(itemId: string) {
    void flush()
      .then(() => {
        const latest = workspace.getSnapshot();
        const freshName =
          latest.runs.find((entry) => entry.itemId === itemId)?.filename ||
          latest.items.find((entry) => entry.id === itemId)?.plannedName;
        if (!freshName) throw new Error('测量计划已变化，请重新选择。');
        return unwrap(window.labrecord.copyName(freshName));
      })
      .then(() => notify('数据文件夹名已复制。'))
      .catch((error) =>
        notify(error instanceof Error ? error.message : '无法复制，请选中名称后复制。', true),
      );
  }
  const visible = items.filter((item) => {
    const sample = snapshot.samples.find((entry) => entry.id === item.sampleId)!;
    const run = snapshot.runs.find((entry) => entry.itemId === item.id);
    const group =
      run?.snapshot.group || snapshot.groups.find((entry) => entry.id === sample.groupId)!;
    return `${run?.snapshot.sample.code || sample.code} ${group.material || ''} ${group.state} ${measurementSummary(measurementFor(snapshot, item))} ${run?.filename || item.plannedName || ''}`
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  const chosen = items.filter((item) => selected.has(item.id));
  const canConfigure =
    chosen.length > 0 &&
    chosen.every(
      (item) =>
        ['pending', 'skipped'].includes(item.status) &&
        !snapshot.runs.some((run) => run.itemId === item.id),
    );
  function open(ids: string[], append: boolean) {
    void flush()
      .then(() => setDialog({ ids, append }))
      .catch((error) => notify(error.message, true));
  }
  return (
    <section className="card measurement-planner" aria-label="测量计划">
      <div className="card-toolbar">
        <div className="toolbar-title">
          <h2>测量计划</h2>
          <span>{items.length} 项操作 · 可复用同一样品</span>
        </div>
        <SearchField
          label="搜索测量计划"
          placeholder="编号、制度或文件夹"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setSelected(new Set());
          }}
        />
      </div>
      <div className="measurement-toolbar">
        {chosen.length > 0 && (
          <span className="measurement-selection">
            已选 {chosen.length} 项{' '}
            <button type="button" className="text-button" onClick={() => setSelected(new Set())}>
              清空选择
            </button>
          </span>
        )}
        <p className="hint">
          一件样品可提前安排多种制度。复制这一列作为数据文件夹。还没开始的测量可以右键删除。
        </p>
        <button
          className="button small"
          disabled={!canConfigure}
          onClick={() =>
            open(
              chosen.map((item) => item.id),
              false,
            )
          }
        >
          <SlidersHorizontal size={14} />
          批量配置制度
        </button>
        <button
          className="button small"
          disabled={!chosen.length}
          onClick={() =>
            open(
              chosen.map((item) => item.id),
              true,
            )
          }
        >
          <Plus size={14} />
          同样品追加制度
        </button>
        <button
          type="button"
          className="button small danger"
          disabled={
            !chosen.length ||
            !!itemsDeleteReason(
              snapshot,
              chosen.map((item) => item.id),
            )
          }
          title={
            itemsDeleteReason(
              snapshot,
              chosen.map((item) => item.id),
            ) || '删除所选测量'
          }
          onClick={() => {
            const ids = chosen.map((item) => item.id);
            askDelete(itemsDeleteRequest(snapshot, ids), ids);
          }}
        >
          <Trash2 size={14} />
          删除所选测量
        </button>
      </div>
      {!items.length ? (
        <p className="hint measurement-empty">先添加或安排待测样品，再配置制度。</p>
      ) : (
        <div className="table-wrap measurement-table-wrap">
          <table className="measurement-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="选择当前全部测量操作"
                    checked={visible.length > 0 && visible.every((item) => selected.has(item.id))}
                    onChange={(event) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        for (const item of visible)
                          event.target.checked ? next.add(item.id) : next.delete(item.id);
                        return next;
                      })
                    }
                  />
                </th>
                <th>样品 / 测量制度</th>
                <th>数据文件夹</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const run = snapshot.runs.find((entry) => entry.itemId === item.id);
                const sample =
                  run?.snapshot.sample ||
                  snapshot.samples.find((entry) => entry.id === item.sampleId)!;
                const name = run?.filename || item.plannedName;
                const targetIds =
                  selected.has(item.id) && selected.size > 1 ? [...selected] : [item.id];
                const deleteReason = itemsDeleteReason(snapshot, targetIds);
                const configurable = ['pending', 'skipped'].includes(item.status) && !run;
                return (
                  <tr
                    key={item.id}
                    onContextMenu={(event) =>
                      openMenu(event, [
                        {
                          kind: 'item',
                          label: '配置制度',
                          disabled: !configurable,
                          title: configurable ? undefined : '已有实际记录的制度与名称已固定',
                          onSelect: () => open([item.id], false),
                        },
                        { kind: 'item', label: '追加制度', onSelect: () => open([item.id], true) },
                        {
                          kind: 'item',
                          label: '复制名称',
                          disabled: !name,
                          onSelect: () => copyFolder(item.id),
                        },
                        {
                          kind: 'item',
                          label: '现场查看',
                          onSelect: () => {
                            void flush()
                              .then(() => {
                                setItemId(item.id);
                                setPage('live');
                              })
                              .catch((error) => notify(error.message, true));
                          },
                        },
                        { kind: 'separator' },
                        {
                          kind: 'item',
                          label: deleteReason
                            ? item.status === 'running'
                              ? '删除这项测量（进行中）'
                              : '删除这项测量（已有记录）'
                            : targetIds.length > 1
                              ? `删除所选 ${targetIds.length} 项测量`
                              : '删除这项测量',
                          disabled: !!deleteReason,
                          danger: true,
                          title: deleteReason || undefined,
                          onSelect: () =>
                            askDelete(itemsDeleteRequest(snapshot, targetIds), targetIds),
                        },
                      ])
                    }
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择测量 ${item.order + 1} ${sample.code}`}
                        checked={selected.has(item.id)}
                        onChange={(event) =>
                          setSelected((old) => {
                            const next = new Set(old);
                            event.target.checked ? next.add(item.id) : next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <strong>{sample.code}</strong>
                      <small>
                        {measurementSummary(measurementFor(snapshot, item))}
                        {item.repeatOf ? ' · 重测' : ''}
                      </small>
                    </td>
                    <td>
                      <code>{name || '配置后生成'}</code>
                      {name && (
                        <button
                          className="text-button"
                          aria-label={`复制测量名称 ${item.order + 1}`}
                          onClick={() => copyFolder(item.id)}
                        >
                          <Copy size={13} />
                          复制
                        </button>
                      )}
                    </td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                    <td className="measurement-row-actions">
                      <button
                        className="button small"
                        disabled={!['pending', 'skipped'].includes(item.status) || !!run}
                        onClick={() => open([item.id], false)}
                      >
                        配置制度
                      </button>
                      <button className="button small" onClick={() => open([item.id], true)}>
                        追加制度
                      </button>
                      <button
                        className="text-button"
                        onClick={() => {
                          void flush()
                            .then(() => {
                              setItemId(item.id);
                              setPage('live');
                            })
                            .catch((error) => notify(error.message, true));
                        }}
                      >
                        现场查看
                      </button>
                      <button
                        type="button"
                        className="text-button danger"
                        aria-label={`删除测量 ${sample.code}`}
                        title={itemsDeleteReason(snapshot, [item.id]) || '删除这项还没开始的测量'}
                        disabled={!!itemsDeleteReason(snapshot, [item.id])}
                        onClick={() =>
                          askDelete(itemsDeleteRequest(snapshot, [item.id]), [item.id])
                        }
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={5}>没有找到测量计划，可清除搜索后重试。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {dialog && (
        <MeasurementDialog
          items={items.filter((item) => dialog.ids.includes(item.id))}
          append={dialog.append}
          onClose={() => {
            setDialog(null);
            setSelected(new Set());
          }}
        />
      )}
      {menu}
      <DeleteConfirm pending={pendingDelete} onClose={() => setPendingDelete(null)} />
    </section>
  );
}
