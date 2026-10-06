import { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Copy,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Upload,
  SlidersHorizontal,
  ArrowRight,
  Layers,
  Package,
  Boxes,
  Pencil,
  TrendingUp,
} from 'lucide-react';
import type {
  Group,
  GroupPatch,
  Sample,
  Values,
  Mode,
  Priority,
  TablePreview,
} from '../shared/model';
import { groupCounts, sampleName, dimensions } from '../shared/model';
import { reportInsights } from '../shared/summary';
import { useWorkspace, unwrap } from './context';
import { AutoInput, Modal, Empty, FieldInputs, PriorityPill, SearchField } from './components';
import { ImportDialog } from './importDialog';
import { QuickAdd } from './QuickAdd';

export function GroupForm({
  group,
  onClose,
  ids,
  temporary = false,
}: {
  group?: Group;
  onClose: () => void;
  ids?: string[];
  temporary?: boolean;
}) {
  const { execute, experimentId, snapshot } = useWorkspace();
  const bulk = !!ids,
    experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  group = group ? snapshot.groups.find((g) => g.id === group!.id) || group : undefined;
  const [name, setName] = useState(group?.name || ''),
    [width, setWidth] = useState(group?.width || ''),
    [height, setHeight] = useState(group?.height || ''),
    [dimensionUnit, setDimensionUnit] = useState(group?.dimensionUnit || '');
  const [state, setState] = useState(group?.state || ''),
    [prepared, setPrepared] = useState(group?.preparedCount?.toString() || (temporary ? '1' : ''));
  const [mode, setMode] = useState<Mode>(group?.mode || '未定'),
    [priority, setPriority] = useState<Priority>(group?.priority || 'P0');
  const [thickness, setThickness] = useState(group?.thickness || ''),
    [unit, setUnit] = useState(group?.thicknessUnit || '');
  const [preparation, setPreparation] = useState(group?.preparation || ''),
    [notes, setNotes] = useState(group?.notes || '');
  const [values, setValues] = useState<Values>(group?.values || {}),
    [changed, setChanged] = useState(new Set<string>());
  const [working, setWorking] = useState(false),
    [error, setError] = useState('');
  function mark(key: string) {
    setChanged((old) => new Set([...old, key]));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    const patch: GroupPatch = {
      state,
      name,
      width,
      height,
      dimensionUnit,
      preparedCount: prepared.trim() ? Number(prepared) : null,
      mode,
      priority,
      thickness,
      thicknessUnit: unit,
      preparation,
      notes,
      values,
    };
    const actualPatch = bulk
      ? (Object.fromEntries(
          Object.entries(patch).filter(([key]) => changed.has(key)),
        ) as GroupPatch)
      : patch;
    try {
      if (bulk && !Object.keys(actualPatch).length) throw new Error('请至少修改一个字段。');
      await execute(
        group || bulk
          ? { type: 'updateGroups', ids: ids || [group!.id], patch: actualPatch }
          : { type: temporary ? 'temporary' : 'createGroup', experimentId, patch },
      );
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const label = (key: string, title: string) => (
    <span>
      {bulk && (
        <input
          type="checkbox"
          aria-label={`应用${title}`}
          checked={changed.has(key)}
          onChange={(event) =>
            setChanged((old) => {
              const next = new Set(old);
              event.target.checked ? next.add(key) : next.delete(key);
              return next;
            })
          }
        />
      )}{' '}
      {title}
    </span>
  );
  return (
    <Modal
      title={
        bulk
          ? `批量设置 ${ids!.length} 个样品组`
          : group
            ? '编辑样品组'
            : temporary
              ? '新增临时样品'
              : '新增样品'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-grid">
        <label className="field span-2">
          {label('name', '样品名称')}
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              mark('name');
            }}
            placeholder="例如 Ti2448 拉伸试样"
          />
        </label>
        {!bulk && (
          <label className="field span-2">
            <span>样品状态 *</span>
            <input
              autoFocus
              value={state}
              onChange={(event) => setState(event.target.value)}
              required
              placeholder="例如 Ti-demo-375C-aged"
            />
            <small>保留原始状态名称，具体样品在安排测试时单独编号。</small>
          </label>
        )}
        {!bulk && (
          <label className="field">
            <span>准备数量</span>
            <input
              type="number"
              min="0"
              max="10000"
              value={prepared}
              onChange={(event) => setPrepared(event.target.value)}
              placeholder="未知时留空"
            />
            <small>包含备样，不等于计划测试数量。</small>
          </label>
        )}
        <label className="field">
          {label('mode', 'In situ / Ex situ')}
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              mark('mode');
            }}
          >
            <option>未定</option>
            <option>In situ</option>
            <option>Ex situ</option>
          </select>
        </label>
        <label className="field">
          {label('priority', '优先级')}
          <select
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as Priority);
              mark('priority');
            }}
          >
            <option>P0</option>
            <option>P1</option>
            <option>P2</option>
          </select>
        </label>
        <label className="field">
          {label('thickness', '厚度')}
          <input
            value={thickness}
            onChange={(event) => {
              setThickness(event.target.value);
              mark('thickness');
            }}
            placeholder="未填写"
          />
        </label>
        <label className="field">
          {label('thicknessUnit', '厚度单位')}
          <select
            value={unit}
            onChange={(event) => {
              setUnit(event.target.value);
              mark('thicknessUnit');
            }}
          >
            <option value="">未指定</option>
            <option>mm</option>
            <option>μm</option>
            <option>nm</option>
            <option>cm</option>
          </select>
        </label>
        <label className="field">
          {label('width', '宽度')}
          <input
            value={width}
            onChange={(event) => {
              setWidth(event.target.value);
              mark('width');
            }}
          />
        </label>
        <label className="field">
          {label('height', '高度（可选）')}
          <input
            value={height}
            onChange={(event) => {
              setHeight(event.target.value);
              mark('height');
            }}
          />
        </label>
        <label className="field">
          {label('dimensionUnit', '宽度 / 高度单位')}
          <select
            value={dimensionUnit}
            onChange={(event) => {
              setDimensionUnit(event.target.value);
              mark('dimensionUnit');
            }}
          >
            <option value="">未指定</option>
            {['mm', 'μm', 'nm', 'cm'].map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </select>
        </label>
        <label className="field span-2">
          {label('preparation', '制备 / 试剂名称')}
          <input
            value={preparation}
            onChange={(event) => {
              setPreparation(event.target.value);
              mark('preparation');
            }}
            placeholder="制备批次、试剂准备名称或配方名称"
          />
        </label>
        <label className="field span-2">
          {label('notes', '备注')}
          <textarea
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              mark('notes');
            }}
            rows={3}
            placeholder="尺寸、成分、装样方向、操作要求等"
          />
        </label>
        {experiment.fields.length > 0 && (
          <div className="span-2">
            <FieldInputs
              immediate
              fields={experiment.fields}
              values={values}
              save={async (patch) => {
                setValues((old) => ({ ...old, ...patch }));
                mark('values');
              }}
            />
          </div>
        )}
        {error && (
          <p className="error-text span-2" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions span-2">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={working}>
            {working ? '保存中…' : bulk ? '应用修改' : temporary ? '保存并加入队列' : '保存样品组'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ArrangeDialog({
  group,
  onClose,
  spare = false,
}: {
  group: Group;
  onClose: () => void;
  spare?: boolean;
}) {
  const { snapshot, execute } = useWorkspace();
  const counts = groupCounts(snapshot, group);
  const [count, setCount] = useState(spare ? '1' : ''),
    [prefix, setPrefix] = useState(`${group.state}-`),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await execute({ type: 'arrange', groupId: group.id, count: Number(count), prefix });
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={spare ? '启用备样' : '安排待测样品'} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <div className="callout">
          <strong>{group.state}</strong>
          <p>
            准备 {group.preparedCount ?? '数量未定'} 个 · 已安排 {counts.planned} 个 · 备样{' '}
            {counts.spare ?? '数量未定'} 个
          </p>
        </div>
        <label className="field">
          <span>{spare ? '启用数量' : '本次加入待测队列的数量'} *</span>
          <input
            autoFocus
            type="number"
            min="1"
            max={counts.spare ?? 1000}
            required
            value={count}
            onChange={(event) => setCount(event.target.value)}
            placeholder="只填写本次要测试的数量"
          />
        </label>
        <label className="field">
          <span>样品编号前缀</span>
          <input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          <small>自动生成连续编号；已有编号会自动避开。生成后可以逐个修改。</small>
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '安排中…' : '加入待测队列'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function SampleEditor({ sample, onClose }: { sample: Sample; onClose: () => void }) {
  const { snapshot, execute } = useWorkspace();
  const group = snapshot.groups.find((g) => g.id === sample.groupId)!;
  const experiment = snapshot.experiments.find((e) => e.id === sample.experimentId)!;
  const [name, setName] = useState(sample.parameters.name ?? group.name ?? ''),
    [width, setWidth] = useState(sample.parameters.width ?? group.width ?? ''),
    [height, setHeight] = useState(sample.parameters.height ?? group.height ?? ''),
    [dimensionUnit, setDimensionUnit] = useState(
      sample.parameters.dimensionUnit ?? group.dimensionUnit ?? '',
    );
  const [code, setCode] = useState(sample.code),
    [thickness, setThickness] = useState(sample.parameters.thickness ?? group.thickness),
    [unit, setUnit] = useState(sample.parameters.thicknessUnit ?? group.thicknessUnit),
    [notes, setNotes] = useState(sample.parameters.notes ?? group.notes);
  const [values, setValues] = useState({ ...group.values, ...sample.values }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await execute({
        type: 'updateSamples',
        ids: [sample.id],
        code,
        parameters: { name, width, height, dimensionUnit, thickness, thicknessUnit: unit, notes },
        values,
      });
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="具体样品参数" onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <label className="field">
          <span>具体样品名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>宽度</span>
            <input value={width} onChange={(event) => setWidth(event.target.value)} />
          </label>
          <label className="field">
            <span>高度（可选）</span>
            <input value={height} onChange={(event) => setHeight(event.target.value)} />
          </label>
          <label className="field">
            <span>宽高单位</span>
            <input
              value={dimensionUnit}
              onChange={(event) => setDimensionUnit(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>样品编号 *</span>
          <input required value={code} onChange={(event) => setCode(event.target.value)} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>厚度</span>
            <input value={thickness} onChange={(event) => setThickness(event.target.value)} />
          </label>
          <label className="field">
            <span>单位</span>
            <input
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              placeholder="例如 mm"
            />
          </label>
        </div>
        <label className="field">
          <span>计划备注</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
        </label>
        <FieldInputs
          immediate
          fields={experiment.fields}
          values={values}
          save={async (patch) => setValues((old) => ({ ...old, ...patch }))}
        />
        <p className="hint">修改计划会用于后续操作，已有操作保存的计划内容保持原记录。</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button disabled={busy} className="button primary">
            保存样品参数
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function Plan() {
  const workspace = useWorkspace();
  const { snapshot, experimentId, execute, setPage, setItemId, notify } = workspace;
  const experiment = snapshot.experiments.find((e) => e.id === experimentId)!;
  const groups = snapshot.groups
    .filter((g) => g.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const [quickAdd, setQuickAdd] = useState(false);
  const quickAddTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        event.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        quickAddTrigger.current?.focus();
        setQuickAdd(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const [search, setSearch] = useState(''),
    [expanded, setExpanded] = useState(new Set<string>()),
    [selected, setSelected] = useState(new Set<string>());
  const [editing, setEditing] = useState<Group | 'new' | 'bulk' | null>(null),
    [arranging, setArranging] = useState<Group | null>(null),
    [sample, setSample] = useState<Sample | null>(null);
  const [paste, setPaste] = useState(false),
    [text, setText] = useState(''),
    [preview, setPreview] = useState<TablePreview | null>(null);
  const visible = groups.filter((g) =>
    `${g.name || ''} ${g.state} ${g.preparation} ${g.notes}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const insights = reportInsights(snapshot, experimentId);
  const preparationUnknown = groups.length > 0 && insights.unknownPreparation === groups.length;
  async function importFile() {
    try {
      const result = await unwrap(window.labrecord.previewFile());
      if (result) setPreview(result);
    } catch (failure) {
      notify((failure as Error).message, true);
    }
  }
  function toggle(id: string, set: (next: Set<string>) => void, collection: Set<string>) {
    const next = new Set(collection);
    next.has(id) ? next.delete(id) : next.add(id);
    set(next);
  }
  return (
    <div className="page plan-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">01 / 实验规划</div>
          <h1>实验前，把样品安排好</h1>
          <p>按状态整理准备情况，把要测试的样品加入待测队列。</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            void workspace
              .flush()
              .then(() => setPage('live'))
              .catch((error) => notify(error.message, true));
          }}
        >
          进入现场记录 <ArrowRight size={17} />
        </button>
      </div>
      <div className="stats-row plan-stats">
        <div className="stat">
          <Layers size={20} />
          <div>
            <strong>
              {groups.length}
              <small>组</small>
            </strong>
            <span>样品组</span>
          </div>
        </div>
        <div className="stat">
          <Package size={20} />
          <div>
            <strong>
              {preparationUnknown ? '未知' : insights.preparedKnown}
              {!preparationUnknown && <small>个</small>}
            </strong>
            <span>已知准备数量 · 包含备样</span>
            {insights.unknownPreparation > 0 && (
              <small className="stat-unknown">{insights.unknownPreparation} 组准备数量未知</small>
            )}
          </div>
        </div>
        <div className="stat accent">
          <span className="stat-icon">↗</span>
          <div>
            <strong>
              {insights.plannedSamples}
              <small>个</small>
            </strong>
            <span>已加入计划的不同样品</span>
          </div>
        </div>
        <div className="stat">
          <TrendingUp size={20} />
          <div>
            <strong>
              {insights.plannedOperations}
              <small>项</small>
            </strong>
            <span>计划操作</span>
          </div>
        </div>
        <div className="stat">
          <Boxes size={20} />
          <div>
            <strong>
              {preparationUnknown ? '未知' : insights.spareKnown}
              {!preparationUnknown && <small>个</small>}
            </strong>
            <span>备样 · 现场按需启用</span>
            {insights.unknownPreparation > 0 && (
              <small className="stat-unknown">{insights.unknownPreparation} 组备样数量未知</small>
            )}
          </div>
        </div>
      </div>
      <section className="card planning-card">
        <div className="card-toolbar">
          <div className="toolbar-title">
            <h2>样品准备</h2>
            <span>{groups.length} 个样品组</span>
          </div>
          <div className="toolbar-actions">
            <SearchField
              label="搜索样品组"
              placeholder="名称、状态或备注"
              value={search}
              onChange={setSearch}
            />
            <button className="button" onClick={importFile}>
              <Upload size={16} />
              导入表格
            </button>
            <button className="button" onClick={() => setPaste(true)}>
              <ClipboardPaste size={16} />
              粘贴多行
            </button>
            <button
              ref={quickAddTrigger}
              className="button primary"
              onClick={() => setQuickAdd(true)}
            >
              <Plus size={17} />
              新增样品
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="selection-bar">
            <span>已选 {selected.size} 组</span>
            <button className="button small" onClick={() => setEditing('bulk')}>
              <SlidersHorizontal size={14} />
              批量设置参数
            </button>
            <button className="text-button" onClick={() => setSelected(new Set())}>
              取消选择
            </button>
          </div>
        )}
        {groups.length === 0 ? (
          <Empty
            title="添加第一份实验样品"
            description="填写名称和尺寸，直接安排测试；已有表格也可导入或粘贴。"
          >
            <button className="button primary" onClick={() => setQuickAdd(true)}>
              <Plus size={16} />
              新增样品
            </button>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="plan-table">
              <thead>
                <tr>
                  <th className="sticky-cell">
                    <input
                      type="checkbox"
                      aria-label="选择当前全部样品组"
                      checked={visible.length > 0 && visible.every((g) => selected.has(g.id))}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked ? new Set(visible.map((g) => g.id)) : new Set(),
                        )
                      }
                    />
                    <span>样品 / 状态</span>
                  </th>
                  <th>准备 / 计划</th>
                  <th>尺寸</th>
                  <th>实验条件</th>
                  <th>计划备注</th>
                  <th>安排</th>
                </tr>
              </thead>
              <tbody>
                {!visible.length && (
                  <tr>
                    <td colSpan={6}>
                      <Empty title="没有找到样品" description="试试其他名称、状态或备注。">
                        <button className="button" onClick={() => setSearch('')}>
                          清除筛选
                        </button>
                      </Empty>
                    </td>
                  </tr>
                )}
                {visible.map((group) => {
                  const counts = groupCounts(snapshot, group);
                  const samples = snapshot.samples.filter((s) => s.groupId === group.id);
                  const save = (patch: GroupPatch) =>
                    execute({ type: 'updateGroups', ids: [group.id], patch }, false);
                  return (
                    <GroupRows
                      key={group.id}
                      group={group}
                      counts={counts}
                      expanded={expanded.has(group.id)}
                      selected={selected.has(group.id)}
                      toggleExpanded={() => toggle(group.id, setExpanded, expanded)}
                      toggleSelected={() => toggle(group.id, setSelected, selected)}
                      save={save}
                      samples={samples}
                      fields={experiment.fields}
                      onArrange={() => setArranging(group)}
                      onEdit={() => {
                        void workspace
                          .flush()
                          .then(() => setEditing(group))
                          .catch((error) => notify(error.message, true));
                      }}
                      onCopy={() => {
                        void workspace
                          .flush()
                          .then(() => execute({ type: 'copyGroup', id: group.id }))
                          .catch((error) => notify(error.message, true));
                      }}
                      onSample={setSample}
                      onLive={(sampleId) => {
                        void workspace
                          .flush()
                          .then(() => {
                            const item = snapshot.items.find((i) => i.sampleId === sampleId);
                            if (item) setItemId(item.id);
                            setPage('live');
                          })
                          .catch((error) => notify(error.message, true));
                      }}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>修改自动保存 · 数量未知时可以留空</span>
          <span>Alt + N 添加样品 · 展开查看编号和更多参数</span>
        </div>
      </section>
      <div className="planning-tip">
        <span className="tip-number">01</span>
        <div>
          <strong>准备数量和测试计划分开记录</strong>
          <p>
            例如准备 6 个、安排 4 个，另外 2
            个保留为备样。现场启用备样时再加入计划；同一样品重测会新增操作记录。
          </p>
        </div>
      </div>
      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} />}
      {editing && (
        <GroupForm
          group={typeof editing === 'object' ? editing : undefined}
          ids={editing === 'bulk' ? [...selected] : undefined}
          onClose={() => setEditing(null)}
        />
      )}
      {arranging && <ArrangeDialog group={arranging} onClose={() => setArranging(null)} />}
      {sample && <SampleEditor sample={sample} onClose={() => setSample(null)} />}
      {paste && (
        <Modal title="从 Excel / 飞书粘贴多行" onClose={() => setPaste(false)} wide>
          <div className="form-stack">
            <p className="hint">
              请一起复制表头和样品记录。数量会作为准备数量导入，待测样品之后另行安排。
            </p>
            <textarea
              className="paste-area"
              aria-label="表格文本"
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                '已完成\t样品状态\t数量\tIn situ/Ex situ\t实验时间\t优先级\t厚度\t备注\n0\t样品 A\t6\tIn situ\t\tP0\t\t'
              }
            />
            <footer className="modal-actions">
              <button className="button" onClick={() => setPaste(false)}>
                取消
              </button>
              <button
                className="button primary"
                onClick={() => {
                  void unwrap(window.labrecord.previewText(text))
                    .then((result) => {
                      setPreview(result);
                      setPaste(false);
                    })
                    .catch((failure) => notify(failure.message, true));
                }}
              >
                预览并映射字段
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {preview && <ImportDialog preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
function GroupRows({
  group,
  counts,
  expanded,
  selected,
  toggleExpanded,
  toggleSelected,
  save,
  samples,
  fields,
  onArrange,
  onEdit,
  onCopy,
  onSample,
  onLive,
}: {
  group: Group;
  counts: ReturnType<typeof groupCounts>;
  expanded: boolean;
  selected: boolean;
  toggleExpanded: () => void;
  toggleSelected: () => void;
  save: (patch: GroupPatch) => Promise<unknown>;
  samples: Sample[];
  fields: import('../shared/model').Field[];
  onArrange: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onSample: (sample: Sample) => void;
  onLive: (sampleId: string) => void;
}) {
  const title = sampleName(group);
  return (
    <>
      <tr className={selected ? 'selected-row' : ''}>
        <td className="sticky-cell state-cell">
          <input
            type="checkbox"
            aria-label={`选择 ${group.state}`}
            checked={selected}
            onChange={toggleSelected}
          />
          <button
            className="expand-button"
            aria-label={`展开 ${group.state}`}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <div className="sample-identity">
            <AutoInput
              className="sample-name-input"
              label={`${title} 样品名称`}
              value={group.name || ''}
              onSave={(name) => save({ name })}
              placeholder={group.state}
            />
            <small className="sample-state-caption">{group.state}</small>
            {group.legacyCompleted !== null && (
              <span className="legacy-label">
                原表：{group.legacyCompleted ? '已完成' : '未完成'}
                {group.legacyTime ? ' · ' + group.legacyTime : ''}
              </span>
            )}
          </div>
        </td>
        <td className="count-cell">
          <div className="prepared-inline">
            <AutoInput
              label={`${group.state} 准备数量`}
              value={group.preparedCount?.toString() ?? ''}
              onSave={(value) => save({ preparedCount: value.trim() ? Number(value) : null })}
              type="number"
              placeholder="未定"
            />
            <small>准备</small>
          </div>
          <strong>
            {counts.planned}
            <span> 计划</span>
          </strong>
          <small className={counts.shortage ? 'error-text' : ''}>
            {counts.shortage ? `准备不足 ${counts.shortage}` : `${counts.spare ?? '未定'} 备样`}
          </small>
        </td>
        <td className="size-cell">
          <div>
            <small>厚</small>
            <AutoInput
              label={`${group.state} 厚度`}
              value={group.thickness}
              onSave={(thickness) => save({ thickness })}
              placeholder="—"
            />
            <small>{group.thicknessUnit || '单位未定'}</small>
          </div>
          <div>
            <small>宽</small>
            <AutoInput
              label={`${group.state} 宽度`}
              value={group.width || ''}
              onSave={(width) => save({ width })}
              placeholder="—"
            />
            <small>{group.dimensionUnit || '单位未定'}</small>
          </div>
          {group.height && (
            <small>
              高 {group.height} {group.dimensionUnit}
            </small>
          )}
        </td>
        <td>
          <AutoInput
            label={`${group.state} 实验方式`}
            value={group.mode}
            onSave={(mode) => save({ mode: mode as Mode })}
            options={['未定', 'In situ', 'Ex situ'].map((value) => ({ value, label: value }))}
          />
          <AutoInput
            className={`priority-select ${group.priority.toLowerCase()}`}
            label={`${group.state} 优先级`}
            value={group.priority}
            onSave={(priority) => save({ priority: priority as Priority })}
            options={['P0', 'P1', 'P2'].map((value) => ({ value, label: value }))}
          />
        </td>
        <td>
          <AutoInput
            label={`${group.state} 计划备注`}
            value={group.notes}
            onSave={(notes) => save({ notes })}
            placeholder="点击补充"
          />
          <small className="prep-summary" title={group.preparation}>
            {group.preparation}
          </small>
        </td>
        <td>
          <div className="row-actions">
            <button className="button small arrange" onClick={onArrange}>
              <Plus size={14} />
              安排测试
            </button>
            <button
              className="icon-button"
              aria-label={`编辑 ${group.state}`}
              title="编辑样品与参数"
              onClick={onEdit}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={`复制 ${group.state}`}
              title="复制样品与参数"
              onClick={onCopy}
            >
              <Copy size={14} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="expanded-row">
          <td colSpan={6}>
            <div className="sample-expansion">
              <div className="sample-expansion-head">
                <span>组内待测样品 · {samples.length} 个</span>
                <span>
                  操作完成 {counts.completed} / {counts.total} 项
                </span>
              </div>
              {fields.length > 0 && (
                <FieldInputs
                  fields={fields}
                  values={group.values}
                  save={(values) => save({ values })}
                />
              )}
              {samples.length ? (
                samples.map((sample) => (
                  <div className="sample-strip" key={sample.id}>
                    <code>{sample.code}</code>
                    <span>{dimensions({ ...group, ...sample.parameters })}</span>
                    <span className="sample-note">
                      {sample.parameters.name || group.name || ''}
                    </span>
                    <button className="text-button" onClick={() => onSample(sample)}>
                      编辑样品参数
                    </button>
                    <button className="text-button" onClick={() => onLive(sample.id)}>
                      现场记录 <ArrowRight size={13} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="hint">尚未安排测试；准备的样品保留为备样。</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
