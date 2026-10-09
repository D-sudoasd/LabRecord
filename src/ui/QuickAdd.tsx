import { useRef, useState, useEffect } from 'react';
import { Plus, Copy, Layers, Ruler, Package, CheckCircle2 } from 'lucide-react';
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

export function QuickAdd({ onClose }: { onClose: () => void }) {
  const { experimentId, snapshot, execute } = useWorkspace();
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  const latest = snapshot.groups.filter((g) => g.experimentId === experimentId).at(-1);
  const [patch, setPatch] = useState<GroupPatch>({
    name: '',
    state: '',
    preparedCount: 1,
    thicknessUnit: 'mm',
    dimensionUnit: 'mm',
    mode: '未定',
    priority: 'P0',
    thickness: '',
    width: '',
    height: '',
    notes: '',
    protocol: '',
    values: {},
  });
  const [count, setCount] = useState('1'),
    [prefix, setPrefix] = useState('S');
  const [measurement, setMeasurement] = useState<MeasurementPlan>({
    technique: '',
    regime: '',
    batch: '',
  });
  const [namingOpen, setNamingOpen] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [added, setAdded] = useState(0),
    [copied, setCopied] = useState(false);
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
      intent.current ??= {
        command: {
          type: 'addSamples',
          experimentId,
          patch: { ...patch, name: patch.name.trim(), state: patch.state?.trim() || '未指定' },
          count: Number(count),
          prefix,
          measurement: { ...measurement, mode: patch.mode },
        },
        requestId: crypto.randomUUID(),
        continueAdding,
      };
      await execute(intent.current.command, true, intent.current.requestId);
      const keepAdding = intent.current.continueAdding;
      intent.current = null;
      if (!keepAdding) {
        onClose();
        return;
      }
      setAdded((n) => n + 1);
      setPatch((old) => ({ ...old, name: '', state: '' }));
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
      onClose={close}
      className="quick-add-modal"
      closeDisabled={busy || closing}
    >
      <form
        className="form-grid quick-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy) void submit(true);
          }
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
                    thickness,
                    thicknessUnit,
                    width,
                    height,
                    dimensionUnit,
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
                    thickness,
                    thicknessUnit,
                    width: width || '',
                    height: height || '',
                    dimensionUnit: dimensionUnit || '',
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
                <small>填写材料牌号或组名；下方分别记录成分与制备状态。</small>
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
              <label className="field span-2">
                <span>材料短名（用于命名，可选）</span>
                <input
                  value={patch.material || ''}
                  maxLength={300}
                  onChange={(event) => set('material', event.target.value)}
                  placeholder="如 Ti2448、Ti15Nb；留空沿用样品统称"
                />
              </label>
            </div>
          </fieldset>
          <MaterialPreparationFields value={patch} onChange={(key, value) => set(key, value)} />
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
            <div className="form-grid">
              <label className="field">
                <span>实验方式</span>
                <select
                  aria-label="实验方式"
                  value={patch.mode}
                  onChange={(e) => {
                    set('mode', e.target.value as Mode);
                    if (e.target.value !== '未定') setNamingOpen(true);
                  }}
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
            <summary>测量制度与自动命名（可选）</summary>
            <MeasurementFields compact value={measurement} onChange={setMeasurement} />
          </details>
          <div className="span-2">
            <QuickNamePreview
              patch={patch}
              measurement={measurement}
              prefix={prefix}
              count={validCounts ? planned! : 0}
            />
          </div>
          <fieldset className="form-section span-2">
            <legend>
              <Ruler size={16} />
              样品尺寸 <small>可稍后补充</small>
            </legend>
            <div className="dimension-fields">
              <label className="field">
                <span>厚度</span>
                <input
                  value={patch.thickness || ''}
                  onChange={(e) => set('thickness', e.target.value)}
                  inputMode="decimal"
                  placeholder="未填写"
                />
              </label>
              <label className="field">
                <span>厚度单位</span>
                <select
                  value={patch.thicknessUnit || ''}
                  onChange={(event) => set('thicknessUnit', event.target.value)}
                >
                  <option value="">未指定</option>
                  {['mm', 'μm', 'nm', 'cm'].map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>宽度</span>
                <input
                  value={patch.width || ''}
                  onChange={(e) => set('width', e.target.value)}
                  inputMode="decimal"
                  placeholder="未填写"
                />
              </label>
              <label className="field">
                <span>宽高单位</span>
                <select
                  value={patch.dimensionUnit || ''}
                  onChange={(e) => {
                    set('dimensionUnit', e.target.value);
                  }}
                >
                  <option value="">未指定</option>
                  {['mm', 'μm', 'nm', 'cm'].map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          <details className="span-2 quick-add-extra">
            <summary>更多信息 · 高度、制备、条件与备注</summary>
            <div className="form-grid">
              <label className="field">
                <span>高度（可选）</span>
                <input
                  value={patch.height || ''}
                  onChange={(e) => set('height', e.target.value)}
                  inputMode="decimal"
                />
              </label>
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
            已连续添加 {added} 组；尺寸、数量和条件已保留，可继续输入名称。
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
    return <p className="hint">填写样品统称后预览自动名称；仅准备备样时不生成测量名称。</p>;
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
        <strong>数据文件夹名称</strong>
        {names.map((item) => (
          <code key={item.id}>{item.plannedName}</code>
        ))}
        {count > 3 && <small>其余 {count - 3} 项按相同规则连续生成。</small>}
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
