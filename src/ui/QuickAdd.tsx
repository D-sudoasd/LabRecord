import { useRef, useState } from 'react';
import { Plus, Copy, Layers, Ruler, Package, CheckCircle2 } from 'lucide-react';
import type { GroupPatch, Mode } from '../shared/model';
import { useWorkspace } from './context';
import { Modal, FieldInputs } from './components';

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
    values: {},
  });
  const [count, setCount] = useState('1'),
    [prefix, setPrefix] = useState('S');
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
  const set = (key: keyof GroupPatch, value: unknown) =>
    setPatch((old) => ({ ...old, [key]: value }));
  async function submit(continueAdding: boolean) {
    if (submitting.current || !validCounts) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!patch.name?.trim()) throw new Error('请填写样品名称。');
      if (!count.trim()) throw new Error('请填写计划测试数量；仅准备样品可填 0。');
      await execute({
        type: 'addSamples',
        experimentId,
        patch: { ...patch, name: patch.name.trim(), state: patch.state?.trim() || '未指定' },
        count: Number(count),
        prefix,
      });
      if (!continueAdding) {
        onClose();
        return;
      }
      setAdded((n) => n + 1);
      setPatch((old) => ({ ...old, name: '', state: '' }));
      nameInput.current?.focus();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="添加样品" onClose={onClose} className="quick-add-modal">
      <form
        className="form-grid quick-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault();
            if (!busy) void submit(true);
          }
        }}
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
                  values,
                }));
                setCount('1');
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
              <span>样品名称 *</span>
              <input
                ref={nameInput}
                autoFocus
                required
                value={patch.name || ''}
                onChange={(e) => set('name', e.target.value)}
                placeholder="例如 Ti2448 拉伸试样 / 合金 A"
              />
            </label>
            <label className="field">
              <span>样品状态</span>
              <input
                value={patch.state || ''}
                onChange={(e) => set('state', e.target.value)}
                placeholder="例如 400 °C 时效 / Ti-demo-reference，可留空"
              />
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
            <p className="error-text quantity-hint">
              计划测试数量应为 0–1000 的整数，且不超过准备数量；准备数量未知可留空。
            </p>
          )}
        </fieldset>
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
              <span>实验方式</span>
              <select value={patch.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
                <option>未定</option>
                <option>In situ</option>
                <option>Ex situ</option>
              </select>
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
              <span>制备 / 试剂名称</span>
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
        {added > 0 && (
          <p className="hint span-2" role="status">
            已连续添加 {added} 组；尺寸、数量和条件已保留，可继续输入名称。
          </p>
        )}
        {error && (
          <p className="error-text span-2" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions span-2">
          <span className="shortcut-hint">Ctrl + Enter 连续添加</span>
          <button
            type="button"
            className="button"
            disabled={busy || !validCounts}
            onClick={() => {
              void submit(true);
            }}
          >
            保存并继续添加
          </button>
          <button className="button primary" disabled={busy || !validCounts}>
            <Plus size={16} />
            {busy ? '添加中…' : planned === 0 ? '添加为备样' : '添加并安排测试'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
