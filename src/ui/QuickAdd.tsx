import { useRef, useState, useEffect } from 'react';
import { Plus, Copy, Layers, Package, CheckCircle2 } from 'lucide-react';
import {
  MODE_OPTIONS,
  PROTOCOL_PLACEHOLDER,
  planSpecimens,
  type GroupPatch,
  type Mode,
  type MeasurementPlan,
  type Group,
  type PlanItem,
} from '../shared/model';
import { measurementFor, reserveMeasurementNames } from '../shared/measurement';
import { MeasurementFields } from './MeasurementPlanner';
import { MaterialPreparationFields } from './MaterialPreparation';
import { useWorkspace, DesktopReplyError } from './context';
import { Modal, FieldInputs, useCommandClose } from './components';
import { emptySpecimenSize, SpecimenSizeFields, type SpecimenSize } from './specimenSize';

function draftSignature(
  patch: GroupPatch,
  count: string,
  prefix: string,
  measurement: MeasurementPlan,
  sizes: SpecimenSize[],
) {
  return JSON.stringify([patch, count, prefix, measurement, sizes]);
}

export function QuickAdd({ onClose }: { onClose: () => void }) {
  const { experimentId, snapshot, execute, getSnapshot } = useWorkspace();
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  const latest = snapshot.groups.filter((g) => g.experimentId === experimentId).at(-1);
  const [patch, setPatch] = useState<GroupPatch>({
    name: '',
    state: '',
    preparedCount: 1,
    mode: '未定',
    priority: 'P0',
    notes: '',
    protocol: '',
    values: {},
  });
  const [count, setCount] = useState('1'),
    [prefix, setPrefix] = useState('S'),
    [sizeRows, setSizeRows] = useState<(SpecimenSize & { sizeEdited: boolean })[]>([]);
  const [measurement, setMeasurement] = useState<MeasurementPlan>({
    technique: '',
    regime: '',
    batch: '',
  });
  const cleanDraft = useRef(draftSignature(patch, count, prefix, measurement, sizeRows));
  const [namingOpen, setNamingOpen] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [added, setAdded] = useState(0),
    [addedLine, setAddedLine] = useState(''),
    [copied, setCopied] = useState(false),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  const planned = count.trim() ? Number(count) : null;
  const prepared = patch.preparedCount ?? null;
  const validCounts =
    planned !== null &&
    Number.isInteger(planned) &&
    planned >= 0 &&
    planned <= 1000 &&
    (prepared === null ||
      (Number.isInteger(prepared) && prepared >= 0 && prepared <= 10000 && planned <= prepared));
  const spare = validCounts && prepared !== null ? prepared - planned! : null;
  const arrangedCount = validCounts && planned !== null && planned >= 1 ? planned : 0;
  const sizeCodes = planSpecimens(
    snapshot.samples.filter((sample) => sample.experimentId === experimentId).map((sample) => sample.code),
    arrangedCount,
    prefix,
    { state: patch.state?.trim() || '未指定' },
  )
    .map((item) => item.code)
    .join('\n');
  useEffect(() => {
    const codes = sizeCodes ? sizeCodes.split('\n') : [];
    setSizeRows((current) =>
      codes.map((_, index) => {
        const previous = current[index];
        if (previous?.sizeEdited) return previous;
        return { ...emptySpecimenSize(), sizeEdited: false };
      }),
    );
  }, [sizeCodes]);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const intent = useRef<{
    command: Extract<import('../shared/model').Command, { type: 'addSamples' }>;
    requestId: string;
    continueAdding: boolean;
  } | null>(null);
  const { close, closing } = useCommandClose({
    pending: !!intent.current,
    busy,
    onClose,
    onError: setError,
  });
  const discardButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hasChanges = draftSignature(patch, count, prefix, measurement, sizeRows) !== cleanDraft.current;
  function requestClose() {
    if (busy || closing) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (intent.current || !hasChanges) {
      close();
      return;
    }
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmDiscard(true);
  }
  useEffect(() => {
    if (confirmDiscard) discardButton.current?.focus();
    else returnFocus.current?.focus();
  }, [confirmDiscard]);
  function keepEditing() {
    setConfirmDiscard(false);
  }
  useEffect(() => {
    if (added > 0 && !busy && !intent.current) nameInput.current?.focus();
  }, [added, busy]);
  const set = (key: keyof GroupPatch, value: unknown) =>
    setPatch((old) => ({ ...old, [key]: value }));
  async function submit(continueAdding: boolean) {
    if (submitting.current || closing || !validCounts) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!patch.name?.trim()) throw new Error('请填写样品统称。');
      if (!count.trim()) throw new Error('请填写计划测试数量；仅准备样品可填 0。');
      const plannedCount = Number(count);
      if (plannedCount >= 1 && sizeRows.length !== plannedCount)
        throw new Error('尺寸行还没准备好，请再试一次。');
      const {
        thickness: _thickness,
        thicknessUnit: _thicknessUnit,
        width: _width,
        height: _height,
        dimensionUnit: _dimensionUnit,
        ...groupPatch
      } = patch;
      intent.current ??= {
        command: {
          type: 'addSamples',
          experimentId,
          patch: { ...groupPatch, name: patch.name.trim(), state: patch.state?.trim() || '未指定' },
          count: plannedCount,
          prefix,
          specimens:
            plannedCount >= 1
              ? sizeRows.map(({ sizeEdited: _edited, ...size }) => size)
              : undefined,
          measurement: { ...measurement, mode: patch.mode },
        },
        requestId: crypto.randomUUID(),
        continueAdding,
      };
      const before = new Set(
        getSnapshot()
          .samples.filter((sample) => sample.experimentId === experimentId)
          .map((sample) => sample.code),
      );
      await execute(intent.current.command, true, intent.current.requestId);
      const keepAdding = intent.current.continueAdding;
      intent.current = null;
      if (!keepAdding) {
        onClose();
        return;
      }
      const samples = getSnapshot().samples.filter(
        (sample) => sample.experimentId === experimentId,
      );
      const created = samples.map((sample) => sample.code).filter((code) => !before.has(code));
      const span = (codes: string[]) =>
        codes.length > 1 ? `${codes[0]}–${codes[codes.length - 1]}` : codes[0] || '';
      if (plannedCount > 0) {
        const next = planSpecimens(
          samples.map((sample) => sample.code),
          plannedCount,
          prefix,
          { state: patch.state || '未指定' },
        ).map((row) => row.code);
        setAddedLine(`已加入 ${span(created)}。下一组 ${span(next)}。`);
      } else setAddedLine('已加入备样。');
      setAdded((n) => n + 1);
      const nextPatch = { ...patch, name: '', state: '' };
      setPatch(nextPatch);
      const clearedSizes = sizeRows.map(() => ({ ...emptySpecimenSize(), sizeEdited: false }));
      setSizeRows(clearedSizes);
      cleanDraft.current = draftSignature(nextPatch, count, prefix, measurement, clearedSizes);
    } catch (failure) {
      if (failure instanceof DesktopReplyError && failure.rejected) intent.current = null;
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="添加样品"
      onClose={requestClose}
      className="quick-add-modal"
      closeDisabled={busy || closing}
    >
      <form
        className="form-grid quick-add-form"
        hidden={confirmDiscard}
        style={confirmDiscard ? { display: 'none' } : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        onKeyDown={(event) => {
          if (!event.ctrlKey || event.key !== 'Enter') return;
          event.preventDefault();
          if (!event.repeat && !event.nativeEvent.isComposing && !busy) void submit(true);
        }}
      >
        <fieldset
          className="quick-add-fields form-grid span-2"
          disabled={busy || closing || !!intent.current}
        >
          <div className="quick-add-intro span-2">
            <p>名称必填，其余按需补充。样品编号自动生成。</p>
            {latest && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  const {
                    preparedCount,
                    mode,
                    priority,
                    preparation,
                    notes,
                    protocol,
                    material,
                    composition,
                    processing,
                    heatTreatment,
                    otherTreatment,
                    values,
                  } = latest;
                  setPatch((old) => ({
                    ...old,
                    preparedCount,
                    mode,
                    priority,
                    preparation,
                    notes,
                    protocol: protocol || '',
                    material: material || '',
                    composition,
                    processing,
                    heatTreatment,
                    otherTreatment,
                    values,
                  }));
                  setCount('1');
                  const source = snapshot.items.find((item) =>
                    snapshot.samples.some(
                      (sample) => sample.id === item.sampleId && sample.groupId === latest.id,
                    ),
                  );
                  if (source) {
                    const inherited = measurementFor(snapshot, source);
                    setMeasurement({
                      technique: inherited.technique,
                      regime: inherited.regime,
                      batch: inherited.batch,
                    });
                  }
                  setCopied(true);
                  nameInput.current?.focus();
                }}
              >
                <Copy size={14} />
                沿用上一组参数
              </button>
            )}
          </div>
          {copied && (
            <p className="template-feedback span-2" role="status">
              <CheckCircle2 size={15} />
              已沿用上一组参数，请确认本组数量。
            </p>
          )}
          <fieldset className="form-section span-2">
            <legend>
              <Layers size={16} />
              样品信息
            </legend>
            <div className="form-grid">
              {addedLine && (
                <p className="template-feedback span-2" role="status">
                  <CheckCircle2 size={15} />
                  {addedLine}
                </p>
              )}
              <label className="field">
                <span>样品统称 *</span>
                <input
                  ref={nameInput}
                  autoFocus
                  required
                  aria-label="样品统称 *"
                  value={patch.name || ''}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="例如 Ti2448 拉伸试样 / 合金 A"
                />
                <small>这一组的名字。成分和制备写在下面。</small>
              </label>
              <label className="field">
                <span>样品状态</span>
                <input
                  aria-label="样品状态"
                  value={patch.state || ''}
                  onChange={(e) => set('state', e.target.value)}
                  placeholder="已有状态简称或原表文字，可留空"
                />
                <small>原始标记原样保留；详细加工与热处理在下方分别填写。</small>
              </label>
            </div>
          </fieldset>
          <fieldset className="form-section span-2">
            <legend>
              <Package size={16} />
              准备与测试
            </legend>
            <div className="form-grid">
              <label className="field">
                <span>准备数量</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  value={patch.preparedCount ?? ''}
                  onChange={(e) =>
                    set('preparedCount', e.target.value.trim() ? Number(e.target.value) : null)
                  }
                />
              </label>
              <label className="field">
                <span>计划测试数量</span>
                <input
                  type="number"
                  required
                  min="0"
                  max="1000"
                  aria-label="计划测试数量"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
                <small>仅准备备样时填 0。</small>
              </label>
            </div>
            <div className="quantity-preview" aria-label="样品数量预览" role="status">
              <span>
                <strong>{prepared ?? '—'}</strong>准备
              </span>
              <span>
                <strong>{planned ?? '—'}</strong>计划测试
              </span>
              <span>
                <strong>{spare ?? '—'}</strong>备样
              </span>
            </div>
            {!validCounts && (
              <p className="error-text quantity-hint" role="alert">
                计划测试数量应为 0–1000 的整数，且不超过准备数量；准备数量未知可留空。
              </p>
            )}
            {arrangedCount > 0 ? (
              <ol className="specimen-plan">
                {sizeCodes.split('\n').map((code, index) => {
                  const row = sizeRows[index];
                  if (!row) return null;
                  return (
                    <li key={code}>
                      <code>{code}</code>
                      <SpecimenSizeFields
                        code={code}
                        value={row}
                        onChange={(next) =>
                          setSizeRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, ...next, sizeEdited: true } : entry,
                            ),
                          )
                        }
                      />
                      {row.sizeEdited && sizeRows.slice(index + 1).some((entry) => !entry.sizeEdited) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setSizeRows((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex > index && !entry.sizeEdited
                                  ? {
                                      ...entry,
                                      thickness: row.thickness,
                                      thicknessUnit: row.thicknessUnit,
                                      width: row.width,
                                      height: row.height,
                                      dimensionUnit: row.dimensionUnit,
                                      sizeEdited: true,
                                    }
                                  : entry,
                              ),
                            )
                          }
                        >
                          后面也用这个尺寸
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="hint">尺寸在安排时按每一件填写。</p>
            )}
            <div className="form-grid">
              <label className="field">
                <span>实验方式</span>
                <select
                  aria-label="实验方式"
                  value={patch.mode}
                  onChange={(e) => set('mode', e.target.value as Mode)}
                >
                  {MODE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {(patch.mode === 'In situ' || patch.mode === 'Ex situ') && (
                <label className="field span-2 protocol-card">
                  <span>实验制度</span>
                  <textarea
                    aria-label="实验制度"
                    rows={4}
                    value={patch.protocol || ''}
                    onChange={(e) => set('protocol', e.target.value)}
                    placeholder={PROTOCOL_PLACEHOLDER}
                  />
                  <small>具体样品可以再单独改。留空也可以先安排。</small>
                </label>
              )}
              {patch.mode === '未定' && patch.protocol?.trim() && (
                <details className="protocol-kept span-2">
                  <summary>仍保留实验制度</summary>
                  <p>{patch.protocol}</p>
                </details>
              )}
            </div>
          </fieldset>
          <details
            className="form-section span-2"
            open={namingOpen}
            onToggle={(event) => setNamingOpen(event.currentTarget.open)}
          >
            <summary>测量技术与制度（可选）</summary>
            <MeasurementFields compact value={measurement} onChange={setMeasurement} />
            <label className="field">
              <span>材料牌号</span>
              <input
                aria-label="材料牌号"
                value={patch.material || ''}
                maxLength={300}
                onChange={(event) => set('material', event.target.value)}
                placeholder="与样品统称不同时再填"
              />
            </label>
          </details>
          <div className="span-2">
            <QuickNamePreview
              patch={patch}
              measurement={measurement}
              prefix={prefix}
              count={validCounts ? planned! : 0}
            />
          </div>
          <MaterialPreparationFields
            collapsible
            value={patch}
            onChange={(key, value) => set(key, value)}
          />
          <details className="span-2 quick-add-extra">
            <summary>更多信息 · 制备、条件与备注</summary>
            <div className="form-grid">
              <label className="field">
                <span>编号前缀</span>
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="S" />
                <small>相同实验内自动避开已有编号。</small>
              </label>
              <label className="field">
                <span>优先级</span>
                <select value={patch.priority} onChange={(e) => set('priority', e.target.value)}>
                  <option>P0</option>
                  <option>P1</option>
                  <option>P2</option>
                </select>
              </label>
              <label className="field span-2">
                <span>制备批次 / 原制备备注</span>
                <input
                  value={patch.preparation || ''}
                  onChange={(e) => set('preparation', e.target.value)}
                />
              </label>
              <label className="field span-2">
                <span>计划备注</span>
                <textarea
                  rows={2}
                  value={patch.notes || ''}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </label>
              {!!experiment.fields.length && (
                <div className="span-2">
                  <FieldInputs
                    immediate
                    fields={experiment.fields}
                    values={patch.values || {}}
                    save={async (values) =>
                      setPatch((old) => ({ ...old, values: { ...old.values, ...values } }))
                    }
                  />
                </div>
              )}
            </div>
          </details>
        </fieldset>
        {added > 0 && (
          <p className="hint span-2" role="status">
            已连续添加 {added} 组；数量和条件已保留，可继续输入名称。
          </p>
        )}
        {error && (
          <p className="error-text span-2" role="alert">
            {error}
            {intent.current && ' 内容已固定；重试添加会沿用同一请求，避免重复创建样品。'}
          </p>
        )}
        <footer className="modal-actions span-2">
          <span className="shortcut-hint">Ctrl + Enter 连续添加</span>
          <button
            type="button"
            className="button"
            disabled={busy || closing || !validCounts || !!intent.current}
            onClick={() => {
              void submit(true);
            }}
          >
            保存并继续添加
          </button>
          <button className="button primary" disabled={busy || closing || !validCounts}>
            <Plus size={16} />
            {busy
              ? '添加中…'
              : intent.current
                ? '重试添加'
                : planned === 0
                  ? '添加为备样'
                  : '添加并安排测试'}
          </button>
        </footer>
      </form>
      {confirmDiscard && (
        <section
          className="modal-body"
          role="alertdialog"
          aria-labelledby="quick-add-discard-title"
          aria-describedby="quick-add-discard-description"
        >
          <h3 id="quick-add-discard-title">放弃这次样品填写？</h3>
          <p id="quick-add-discard-description">这组样品还没有保存。继续填写会保留已输入的内容。</p>
          <footer className="modal-actions">
            <button ref={discardButton} type="button" className="button" onClick={keepEditing}>
              继续填写
            </button>
            <button type="button" className="button danger" onClick={onClose}>
              放弃填写
            </button>
          </footer>
        </section>
      )}
    </Modal>
  );
}

function QuickNamePreview({
  patch,
  measurement,
  prefix,
  count,
}: {
  patch: GroupPatch;
  measurement: MeasurementPlan;
  prefix: string;
  count: number;
}) {
  const { snapshot, experimentId } = useWorkspace();
  if (!count || !patch.name?.trim())
    return <p className="hint">填写样品统称后可以看到数据文件夹名。只准备备样时不生成。</p>;
  try {
    const group = {
      id: 'preview-group',
      experimentId,
      ...patch,
      state: patch.state?.trim() || '未指定',
    } as Group;
    const assigned = planSpecimens(
      snapshot.samples
        .filter((sample) => sample.experimentId === experimentId)
        .map((sample) => sample.code),
      Math.min(3, count),
      prefix || 'S',
      group,
    );
    const samples = assigned.map((entry, index) => ({
      id: `preview-sample-${index}`,
      experimentId,
      groupId: group.id,
      code: entry.code,
      values: {},
      parameters: {},
    }));
    const end = Math.max(
      -1,
      ...snapshot.items
        .filter((item) => item.experimentId === experimentId)
        .map((item) => item.order),
    );
    const items: PlanItem[] = samples.map((sample, index) => ({
      id: `preview-item-${index}`,
      experimentId,
      sampleId: sample.id,
      operation: '测量',
      order: end + 1 + index,
      status: 'pending',
      measurement: { ...measurement, mode: patch.mode },
    }));
    const names = reserveMeasurementNames(
      {
        ...snapshot,
        groups: [...snapshot.groups, group],
        samples: [...snapshot.samples, ...samples],
      },
      experimentId,
      items,
    );
    return (
      <div className="measurement-name-preview" aria-label="快速添加名称预览" aria-live="polite">
        <strong>数据文件夹</strong>
        {names.map((item) => (
          <code key={item.id}>{item.plannedName}</code>
        ))}
        {count > 3 && <small>其余 {count - 3} 项同样生成。</small>}
      </div>
    );
  } catch (error) {
    return (
      <p className="error-text" role="alert">
        {(error as Error).message}
      </p>
    );
  }
}
