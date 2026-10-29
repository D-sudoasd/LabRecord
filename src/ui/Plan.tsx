import { useState, useEffect, useRef, type MouseEvent } from 'react';
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
  Trash2,
} from 'lucide-react';
import type {
  Group,
  GroupPatch,
  Sample,
  Values,
  Mode,
  Priority,
  TablePreview,
  MeasurementPlan,
} from '../shared/model';
import {
  CODE_PATTERN_HYPHEN,
  groupCounts,
  sampleName,
  sampleOverrideLabel,
  STATUS_LABEL,
  dimensions,
  filledSize,
  MODE_OPTIONS,
  PROTOCOL_PLACEHOLDER,
  assignSpecimenCodes,
  planSpecimens,
  prefixFromCodes,
  sharedSamplePrefix,
} from '../shared/model';
import { reportInsights } from '../shared/summary';
import { emptySpecimenSize, SpecimenSizeFields, type SpecimenSize } from './specimenSize';
import { operationStatusReason } from '../shared/history';
import { operationPlanDrift } from '../shared/planChanges';
import {
  operationProtocolLabel,
  previewSampleCodeChange,
  validateFieldSampleCodes,
} from '../shared/measurement';
import { formatRecordedDuration, recordedDuration, runDurationLabel } from '../shared/duration';
import { recordedEndLabel, recordedStartLabel } from '../shared/recordedTime';
import { actualFilenameLabel } from './reviewFilters';
import { latestRecorded, nextOperationBrief, nextPending } from '../shared/library';
import { repeatSource } from '../shared/repeats';
import { followUpRoster } from '../shared/followUps';
import { matchesGroupIdentity, textIncludes } from '../shared/operationQuery';
import { groupOperationText } from './queueSearch';
import { canCopyName, canCopyProtocol, protocolCopyText } from '../shared/copyText';
import { OperationMix } from './LibraryBoard';
import { useWorkspace, unwrap, DesktopReplyError } from './context';
import { consumePendingGroup } from './workspaceSearch';
import {
  AutoInput,
  Modal,
  Empty,
  FieldInputs,
  PriorityPill,
  SearchField,
  useCommandClose,
} from './components';
import { ImportDialog } from './importDialog';
import { QuickAdd } from './QuickAdd';
import { MeasurementPlanner, MeasurementFields, MeasurementDialog } from './MeasurementPlanner';
import { FieldSheetCard } from './FieldSheetCard';
import { MaterialPreparationFields, MaterialPreparationSummary } from './MaterialPreparation';
import { MATERIAL_FIELDS, materialSummary } from '../shared/materials';
import {
  DeleteConfirm,
  groupDeleteRequest,
  groupsDeleteReason,
  sampleDeleteReason,
  sampleDeleteRequest,
  useContextMenu,
  type DeleteRequest,
  type MenuEntry,
  type PendingDelete,
} from './rowMenu';

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
  const [name, setName] = useState(group?.name || '');
  const [material, setMaterial] = useState(group?.material || '');
  const [materials, setMaterials] = useState<GroupPatch>(
    Object.fromEntries(
      MATERIAL_FIELDS.filter(({ key }) => group?.[key] !== undefined).map(({ key }) => [
        key,
        group![key],
      ]),
    ),
  );
  const [state, setState] = useState(group?.state || ''),
    [prepared, setPrepared] = useState(group?.preparedCount?.toString() || (temporary ? '1' : ''));
  const [mode, setMode] = useState<Mode>(group?.mode || '未定'),
    [priority, setPriority] = useState<Priority>(group?.priority || 'P0');
  const [preparation, setPreparation] = useState(group?.preparation || ''),
    [notes, setNotes] = useState(group?.notes || ''),
    [protocol, setProtocol] = useState(group?.protocol || '');
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
      state: state.trim() || '未指定',
      name,
      material,
      ...materials,
      preparedCount: prepared.trim() ? Number(prepared) : null,
      mode,
      priority,
      preparation,
      notes,
      protocol,
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
          {label('name', '样品统称')}
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              mark('name');
            }}
            placeholder="例如 Ti2448 拉伸试样"
          />
          <small>这一组的公共名字。每一件的名字在安排测试时另写。</small>
        </label>
        {!bulk && (
          <label className="field span-2">
            <span>样品状态（原始标记，可选）</span>
            <input
              autoFocus
              value={state}
              onChange={(event) => setState(event.target.value)}
              placeholder="如 NOHR_aged；保留原表文字，可留空"
            />
            <small>这一组的默认状态。安排测试时每一件可以改成自己的状态，也可以单独写备注。</small>
          </label>
        )}
        <MaterialPreparationFields
          value={materials}
          label={label}
          onChange={(key, value) => {
            setMaterials((old) => ({ ...old, [key]: value }));
            mark(key);
          }}
        />
        <details className="field span-2">
          <summary>与统称不同时再填</summary>
          <label className="field">
            {label('material', '材料牌号')}
            <input
              aria-label="材料牌号"
              value={material}
              maxLength={300}
              onChange={(event) => {
                setMaterial(event.target.value);
                mark('material');
              }}
              placeholder="留空则文件夹仍只用样品编号"
            />
          </label>
        </details>
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
            {MODE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
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
        <p className="hint span-2">尺寸在安排测试时按每一件填写。这里不再写全组共用的尺寸。</p>
        {mode !== '未定' ? (
          <label className="field span-2 protocol-card">
            {label('protocol', '实验制度')}
            <textarea
              value={protocol}
              onChange={(event) => {
                setProtocol(event.target.value);
                mark('protocol');
              }}
              rows={4}
              placeholder={PROTOCOL_PLACEHOLDER}
            />
            <small>升温、保温、气氛、载荷或采集间隔。具体样品留空时沿用这里。</small>
          </label>
        ) : (
          protocol.trim() && (
            <details className="protocol-kept span-2">
              <summary>仍保留实验制度</summary>
              <p>{protocol}</p>
            </details>
          )
        )}
        <label className="field span-2">
          {label('preparation', '制备批次 / 原制备备注')}
          <input
            value={preparation}
            onChange={(event) => {
              setPreparation(event.target.value);
              mark('preparation');
            }}
            placeholder="保留已有制备、试剂或批次信息"
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
            placeholder="装样方向、其他需要记住的事"
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
  const [measurement, setMeasurement] = useState<MeasurementPlan>({});
  const submitting = useRef(false);
  const intent = useRef<{
    command: Extract<import('../shared/model').Command, { type: 'arrange' }>;
    requestId: string;
  } | null>(null);
  const cap = Math.min(1000, counts.spare ?? 1000);
  const [count, setCount] = useState('1'),
    [prefix, setPrefix] = useState(() =>
      snapshot.experiments.find((entry) => entry.id === group.experimentId)?.sampleCodePattern ===
      CODE_PATTERN_HYPHEN
        ? 'G'
        : 'S',
    ),
    [rows, setRows] = useState<
      ({
        name: string;
        nameEdited: boolean;
        protocol: string;
        protocolEdited: boolean;
        state: string;
        stateEdited: boolean;
        notes: string;
        notesEdited: boolean;
        code: string;
        codeEdited: boolean;
        sizeEdited: boolean;
      } & SpecimenSize)[]
    >([]),
    [paste, setPaste] = useState(''),
    [pasteNote, setPasteNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [hiddenConfirm, setHiddenConfirm] = useState(false);
  const hiddenReturnButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const acceptedHidden = useRef('');
  const { close, closing } = useCommandClose({
    pending: !!intent.current,
    busy,
    onClose,
    onError: setError,
  });
  const existingCodes = snapshot.samples
    .filter((sample) => sample.experimentId === group.experimentId)
    .map((sample) => sample.code)
    .join('\n');
  const pattern = snapshot.experiments.find(
    (entry) => entry.id === group.experimentId,
  )?.sampleCodePattern;
  const groupPrefix = pattern
    ? prefixFromCodes(
        snapshot.samples
          .filter((sample) => sample.groupId === group.id)
          .map((sample) => sample.code),
        pattern,
      )
    : sharedSamplePrefix(
        snapshot.samples
          .filter((sample) => sample.groupId === group.id)
          .map((sample) => sample.code),
      );
  const offerPrefix = groupPrefix && groupPrefix !== prefix ? groupPrefix : '';
  const numeric = count.trim() === '' ? Number.NaN : Number(count);
  const overCap = Number.isInteger(numeric) && numeric > cap;
  const planned = Number.isInteger(numeric) && numeric >= 1 && numeric <= cap ? numeric : 0;
  const hiddenRows = planned ? rows.slice(planned) : [];
  const hiddenEditedCount = hiddenRows.filter(
    (row) => row.nameEdited || row.protocolEdited || row.stateEdited || row.notesEdited ||
      row.codeEdited || row.sizeEdited,
  ).length;
  const hiddenSignature = JSON.stringify([planned, hiddenRows]);
  useEffect(() => {
    if (hiddenConfirm) hiddenReturnButton.current?.focus();
    else returnFocus.current?.focus();
  }, [hiddenConfirm]);
  let codeError = '';
  let preview: { code: string; ordinal: string }[] = [];
  if (planned) {
    try {
      preview = assignSpecimenCodes(
        existingCodes ? existingCodes.split('\n') : [],
        planned,
        prefix,
        group,
        pattern,
        rows.map((row) => ({ code: row?.codeEdited ? row.code : undefined })),
      );
      validateFieldSampleCodes(
        snapshot,
        group.experimentId,
        preview.map((row) => row.code),
      );
    } catch (failure) {
      codeError = failure instanceof Error ? failure.message : '样品编号无效。';
      try {
        preview = planSpecimens(
          existingCodes ? existingCodes.split('\n') : [],
          planned,
          prefix,
          group,
          pattern,
        );
      } catch (inner) {
        codeError = inner instanceof Error ? inner.message : codeError;
      }
    }
  }
  useEffect(() => {
    setRows((current) => [
      ...preview.map((_, index) => {
        const previous = current[index];
        const size = previous?.sizeEdited
          ? previous
          : { ...emptySpecimenSize(group), sizeEdited: false };
        const state = previous?.stateEdited ? previous.state : group.state;
        return {
          name: previous?.name ?? '',
          nameEdited: previous?.nameEdited ?? false,
          protocol: previous?.protocol ?? '',
          protocolEdited: previous?.protocolEdited ?? false,
          state,
          stateEdited: previous?.stateEdited ?? false,
          notes: previous?.notesEdited ? previous.notes : '',
          notesEdited: previous?.notesEdited ?? false,
          code: previous?.codeEdited ? previous.code : '',
          codeEdited: previous?.codeEdited ?? false,
          thickness: size.thickness,
          thicknessUnit: size.thicknessUnit,
          width: size.width,
          height: size.height,
          dimensionUnit: size.dimensionUnit,
          sizeEdited: size.sizeEdited,
        };
      }),
      ...current.slice(preview.length),
    ]);
  }, [
    planned,
    prefix,
    pattern,
    group.name,
    group.state,
    group.thicknessUnit,
    group.dimensionUnit,
    existingCodes,
  ]);
  function fillNames() {
    const lines = paste
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!lines.length) return;
    const next = Math.min(cap, Math.max(planned, lines.length));
    const skipped = lines.length - next;
    const assigned = planSpecimens(
      existingCodes ? existingCodes.split('\n') : [],
      next,
      prefix,
      group,
      pattern,
    );
    setCount(String(next));
    setRows((current) => [
      ...assigned.map((_, index) => {
        const size = current[index]?.sizeEdited
          ? current[index]
          : { ...emptySpecimenSize(group), sizeEdited: false };
        const state = current[index]?.stateEdited ? current[index].state : group.state;
        return {
          name: lines[index] ?? current[index]?.name ?? '',
          nameEdited: lines[index] !== undefined || (current[index]?.nameEdited ?? false),
          protocol: current[index]?.protocol ?? '',
          protocolEdited: current[index]?.protocolEdited ?? false,
          state,
          stateEdited: current[index]?.stateEdited ?? false,
          notes: current[index]?.notesEdited ? current[index].notes : '',
          notesEdited: current[index]?.notesEdited ?? false,
          code: current[index]?.codeEdited ? current[index].code : '',
          codeEdited: current[index]?.codeEdited ?? false,
          thickness: size.thickness,
          thicknessUnit: size.thicknessUnit,
          width: size.width,
          height: size.height,
          dimensionUnit: size.dimensionUnit,
          sizeEdited: size.sizeEdited,
        };
      }),
      ...current.slice(assigned.length),
    ]);
    setPasteNote(skipped > 0 ? `${skipped} 行超出还能安排的数量，没有写入。` : '');
  }
  async function submit(acceptHidden = false) {
    if (submitting.current || closing || planned < 1 || rows.length < planned || codeError) return;
    if (hiddenEditedCount && !intent.current && acceptedHidden.current !== hiddenSignature) {
      if (!acceptHidden) {
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setHiddenConfirm(true);
        return;
      }
      acceptedHidden.current = hiddenSignature;
    }
    submitting.current = true;
    setBusy(true);
    try {
      intent.current ??= {
        command: {
          type: 'arrange',
          groupId: group.id,
          count: planned,
          prefix,
          specimens: rows.slice(0, planned).map((row) => ({
            name: row.name,
            protocol: row.protocol,
            state: row.state,
            notes: row.notes,
            thickness: row.thickness,
            thicknessUnit: row.thicknessUnit,
            width: row.width,
            height: row.height,
            dimensionUnit: row.dimensionUnit,
            ...(row.code.trim() ? { code: row.code.trim() } : {}),
          })),
          measurement,
        },
        requestId: crypto.randomUUID(),
      };
      await execute(intent.current.command, true, intent.current.requestId);
      onClose();
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
      title={spare ? '启用备样' : '安排待测样品'}
      onClose={() => hiddenConfirm ? setHiddenConfirm(false) : close()}
      closeDisabled={busy || closing}
    >
      <form
        className="form-stack"
        hidden={hiddenConfirm}
        style={hiddenConfirm ? { display: 'none' } : undefined}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <fieldset className="measurement-editor" disabled={busy || closing || !!intent.current}>
          <details className="form-section">
            <summary>本批测量技术与制度（可选）</summary>
            <MeasurementFields compact value={measurement} onChange={setMeasurement} />
            <p className="hint">每一件的实验制度仍可在下面单独写。</p>
          </details>
          <div className="callout">
            <strong>{group.state}</strong>
            <p>
              准备 {group.preparedCount ?? '数量未定'} 个 · 已安排 {counts.planned} 个 · 备样{' '}
              {counts.spare ?? '数量未定'} 个
              {group.name?.trim() ? ` · 统称 ${group.name.trim()}` : ''}
            </p>
          </div>
          <label className="field">
            <span>{spare ? '启用数量' : '本次加入待测队列的数量'} *</span>
            <input
              autoFocus
              type="number"
              min="1"
              max={cap}
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
              placeholder="只填写本次要测试的数量"
            />
          </label>
          {counts.spare !== null && counts.spare > 1 && counts.spare <= 1000 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setCount(String(counts.spare))}
            >
              全部安排 {counts.spare} 个
            </button>
          )}
          <label className="field">
            <span>样品编号前缀</span>
            <input
              aria-label="样品编号前缀"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </label>
          {offerPrefix && (
            <button type="button" className="text-button" onClick={() => setPrefix(offerPrefix)}>
              沿用已有前缀 {offerPrefix}
            </button>
          )}
          <p className="hint">
            编号按安排顺序接着编，下一组也顺着来。每一件的原始编号或名称可按实际填写，留空则保留空值。重测仍用这件的编号。
            每一件单独写样品状态和备注。状态留空则记下本组现在的状态。备注留空则沿用样品组。
            每一件单独写尺寸。留空表示这一件还没量，不会套用别人的尺寸。
            某一件要换成别的编号，填写自定编号；留空则按当前样式接着编。
          </p>
          {codeError && (
            <p id="arrange-code-error" role="alert" className="error-text">
              {codeError}
            </p>
          )}
          {preview.length > 0 && (
            <ol className="specimen-plan">
              {preview.map((item, index) => {
                const row = rows[index];
                return (
                  <li key={index}>
                    <code>{item.code}</code>
                    <label className="field">
                      <span>{preview[index]?.code || item.code} 自定编号</span>
                      <input
                        aria-label={`${preview[index]?.code || item.code} 自定编号`}
                        value={row?.code ?? ''}
                        placeholder="留空则使用当前编号"
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, code: event.target.value, codeEdited: true }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>{item.code} 样品名</span>
                      <input
                        aria-label={`${item.code} 样品名`}
                        value={row?.name ?? ''}
                        placeholder="原始编号或名称，可留空"
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, name: event.target.value, nameEdited: true }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>{item.code} 样品状态</span>
                      <input
                        aria-label={`${item.code} 样品状态`}
                        value={row?.state ?? ''}
                        placeholder={group.state || '本组状态'}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, state: event.target.value, stateEdited: true }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    {!!row?.stateEdited &&
                      rows.slice(index + 1, preview.length).some((entry) => !entry.stateEdited) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setRows((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex > index &&
                                entryIndex < preview.length &&
                                !entry.stateEdited
                                  ? { ...entry, state: row.state, stateEdited: true }
                                  : entry,
                              ),
                            )
                          }
                        >
                          后面也用这个状态
                        </button>
                      )}
                    <label className="field">
                      <span>{item.code} 备注</span>
                      <textarea
                        aria-label={`${item.code} 备注`}
                        rows={2}
                        value={row?.notes ?? ''}
                        placeholder={group.notes?.trim() || '留空则沿用样品组'}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, notes: event.target.value, notesEdited: true }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    {!!row?.notes.trim() &&
                      !!row.notesEdited &&
                      rows.slice(index + 1, preview.length).some((entry) => !entry.notesEdited) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setRows((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex > index &&
                                entryIndex < preview.length &&
                                !entry.notesEdited
                                  ? { ...entry, notes: row.notes, notesEdited: true }
                                  : entry,
                              ),
                            )
                          }
                        >
                          后面也用这个备注
                        </button>
                      )}
                    <label className="field">
                      <span>{item.code} 实验制度</span>
                      <textarea
                        aria-label={`${item.code} 实验制度`}
                        rows={2}
                        value={row?.protocol ?? ''}
                        placeholder={group.protocol?.trim() || '留空则沿用样品组'}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? {
                                    ...entry,
                                    protocol: event.target.value,
                                    protocolEdited: true,
                                  }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    {!!row?.protocol.trim() &&
                      rows
                        .slice(index + 1, preview.length)
                        .some((entry) => !entry.protocolEdited) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setRows((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex > index &&
                                entryIndex < preview.length &&
                                !entry.protocolEdited
                                  ? { ...entry, protocol: row.protocol, protocolEdited: true }
                                  : entry,
                              ),
                            )
                          }
                        >
                          后面的空行也用这个
                        </button>
                      )}
                    {row && (
                      <SpecimenSizeFields
                        code={item.code}
                        value={row}
                        onChange={(next) =>
                          setRows((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, ...next, sizeEdited: true }
                                : entry,
                            ),
                          )
                        }
                      />
                    )}
                    {row?.sizeEdited &&
                      rows.slice(index + 1, preview.length).some((entry) => !entry.sizeEdited) && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            setRows((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex > index &&
                                entryIndex < preview.length &&
                                !entry.sizeEdited
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
          )}
          <label className="field">
            <span>粘贴样品名</span>
            <textarea
              aria-label="粘贴样品名"
              rows={2}
              value={paste}
              placeholder="一行一件，按顺序填入样品名"
              onChange={(event) => setPaste(event.target.value)}
            />
          </label>
          <button type="button" className="button" onClick={fillNames}>
            按行填入样品名
          </button>
          {overCap && (
            <p className="error-text" role="alert">
              本次最多安排 {cap} 个，不能超过剩余备样或 1000。
            </p>
          )}
          {pasteNote && <p className="hint">{pasteNote}</p>}
          <p className="hint">
            制度留空，或写成和样品组一样，都表示沿用样品组。不同的工艺写在对应的那一件上。
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
            {intent.current && ' 内容已固定，请重试安排以恢复同一请求。'}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy || closing} onClick={close}>
            {intent.current ? '返回查看记录' : '取消'}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || closing || planned < 1 || !!codeError}
            aria-describedby={codeError ? 'arrange-code-error' : undefined}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? '安排中…' : intent.current ? '重试安排' : '加入待测队列'}
          </button>
        </footer>
      </form>
      {hiddenConfirm && (
        <section
          className="modal-body"
          role="alertdialog"
          aria-labelledby="arrange-hidden-title"
          aria-describedby="arrange-hidden-description"
        >
          <h3 id="arrange-hidden-title">有已填写的样品被数量缩减隐藏</h3>
          <p id="arrange-hidden-description">
            {hiddenEditedCount} 件隐藏样品包含已编辑内容，不会随当前数量保存。返回检查可恢复查看。
          </p>
          <footer className="modal-actions">
            <button ref={hiddenReturnButton} type="button" className="button" onClick={() => setHiddenConfirm(false)}>
              返回检查
            </button>
            <button type="button" className="button danger" onClick={() => {
              setHiddenConfirm(false);
              void submit(true);
            }}>
              放弃隐藏内容并保存
            </button>
          </footer>
        </section>
      )}
    </Modal>
  );
}
function SampleEditor({
  sample,
  onClose,
  detailsOnly = false,
}: {
  sample: Sample;
  onClose: () => void;
  detailsOnly?: boolean;
}) {
  const { snapshot, execute } = useWorkspace();
  const group = snapshot.groups.find((g) => g.id === sample.groupId)!;
  const experiment = snapshot.experiments.find((e) => e.id === sample.experimentId)!;
  const [name, setName] = useState(sample.parameters.name ?? ''),
    [state, setState] = useState(sample.parameters.state ?? group.state),
    [width, setWidth] = useState(sample.parameters.width ?? group.width ?? ''),
    [height, setHeight] = useState(sample.parameters.height ?? group.height ?? ''),
    [dimensionUnit, setDimensionUnit] = useState(
      sample.parameters.dimensionUnit ?? group.dimensionUnit ?? '',
    );
  const [code, setCode] = useState(sample.code),
    [thickness, setThickness] = useState(sample.parameters.thickness ?? group.thickness),
    [unit, setUnit] = useState(sample.parameters.thicknessUnit ?? group.thicknessUnit),
    [notes, setNotes] = useState(sample.parameters.notes ?? ''),
    [protocol, setProtocol] = useState(sample.parameters.protocol ?? '');
  const [materials, setMaterials] = useState<GroupPatch>({ ...group, ...sample.parameters });
  const [materialChanges, setMaterialChanges] = useState(new Set<string>());
  const [notesChanged, setNotesChanged] = useState(false);
  const [values, setValues] = useState({ ...group.values, ...sample.values }),
    [valueChanges, setValueChanges] = useState<import('../shared/model').Values>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const shortNameRule = experiment.namingPattern === '{sample}';
  const hasStartedMeasurement = snapshot.runs.some((run) => run.sampleId === sample.id);
  const motherCodeLocked = shortNameRule && hasStartedMeasurement;
  let codePreview: ReturnType<typeof previewSampleCodeChange> = [];
  let codePreviewError = '';
  if (code.trim() && code.trim() !== sample.code && !motherCodeLocked) {
    try {
      codePreview = previewSampleCodeChange(snapshot, sample.id, code);
    } catch (failure) {
      codePreviewError = failure instanceof Error ? failure.message : '无法预览编号变化。';
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await execute({
        type: 'updateSamples',
        ids: [sample.id],
        ...(!motherCodeLocked ? { code } : {}),
        parameters: {
          ...(!detailsOnly
            ? {
                name: name.trim(),
                state: state.trim() || group.state,
                width,
                height,
                dimensionUnit,
                thickness,
                thicknessUnit: unit,
                protocol: protocol.trim() === (group.protocol ?? '').trim() ? '' : protocol,
              }
            : {}),
          ...(!detailsOnly || notesChanged ? { notes } : {}),
          ...Object.fromEntries(
            MATERIAL_FIELDS.filter(({ key }) => materialChanges.has(key)).map(({ key }) => [
              key,
              materials[key],
            ]),
          ),
        },
        values: detailsOnly ? valueChanges : values,
      });
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={detailsOnly ? '更多样品信息' : '具体样品参数'} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        {!detailsOnly && (
          <>
            <label className="field sample-name-input">
              <span>原始编号或名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如原表中的样品号；可留空"
              />
            </label>
            <label className="field">
              <span>这一件的样品状态</span>
              <input
                value={state}
                onChange={(event) => setState(event.target.value)}
                placeholder={group.state || '本组状态'}
              />
              <small>留空则记下本组现在的状态。</small>
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
          </>
        )}
        <MaterialPreparationFields
          value={materials}
          onChange={(key, value) => {
            setMaterials((old) => ({ ...old, [key]: value }));
            setMaterialChanges((old) => new Set([...old, key]));
          }}
        />
        <label className="field">
          <span>{shortNameRule ? '实物样品母码 *' : '样品编号 *'}</span>
          <input
            required
            aria-label={shortNameRule ? '实物样品母码' : '样品编号'}
            value={code}
            readOnly={motherCodeLocked}
            onChange={(event) => setCode(event.target.value)}
          />
          {motherCodeLocked ? (
            <small>这件样品已有开始记录的测量，母码已固定；本窗口仍可修改其他样品信息。</small>
          ) : codePreviewError ? (
            <p className="error-text" role="alert">
              {codePreviewError}
            </p>
          ) : codePreview.length > 0 ? (
            <div className="sample-code-preview" aria-label="受影响的文件夹名预览">
              <strong>保存后会更新这些尚未开始的测量文件夹名</strong>
              <ul>
                {codePreview.map((change) => (
                  <li key={change.itemId}>
                    <code>{change.oldName || '尚未预留'}</code>
                    <span aria-hidden="true"> → </span>
                    <code>{change.newName || '尚未预留'}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </label>
        {!detailsOnly && (
          <>
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
          </>
        )}
        <label className="field">
          <span>{detailsOnly ? '样品备注（同一件样品共用）' : '这一件的备注'}</span>
          <textarea
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              setNotesChanged(true);
            }}
            rows={3}
            placeholder={group.notes?.trim() || '留空则沿用样品组'}
          />
          <small>留空则沿用样品组的计划备注。</small>
        </label>
        {!detailsOnly && (group.mode !== '未定' || protocol.trim() || group.protocol?.trim()) && (
          <label className="field protocol-card">
            <span>这一件的实验制度</span>
            <textarea
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
              rows={4}
              placeholder={group.protocol?.trim() || PROTOCOL_PLACEHOLDER}
            />
            <small>
              {group.protocol?.trim()
                ? `留空则沿用样品组：${group.protocol.trim()}`
                : '只写与样品组不同的部分；留空表示沿用样品组。'}
            </small>
          </label>
        )}
        <FieldInputs
          immediate
          fields={experiment.fields}
          values={values}
          save={async (patch) => {
            setValues((old) => ({ ...old, ...patch }));
            setValueChanges((old) => ({ ...old, ...patch }));
          }}
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
            {detailsOnly ? '保存更多信息' : '保存样品参数'}
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
  const repeatingRecent = useRef(false);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.altKey &&
        event.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]') &&
        !(target instanceof Element && target.closest('input, textarea, select'))
      ) {
        event.preventDefault();
        quickAddTrigger.current?.focus();
        setQuickAdd(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const [managementOpen, setManagementOpen] = useState(false);
  const [sampleDetailsOnly, setSampleDetailsOnly] = useState(false);
  const [search, setSearch] = useState(''),
    [expanded, setExpanded] = useState(new Set<string>()),
    [selected, setSelected] = useState(new Set<string>());
  useEffect(() => {
    const apply = () => {
      const id = consumePendingGroup();
      if (!id) return;
      setManagementOpen(true);
      setExpanded((old) => new Set(old).add(id));
    };
    window.addEventListener('labrecord-focus-group', apply);
    return () => window.removeEventListener('labrecord-focus-group', apply);
  }, []);
  const [editing, setEditing] = useState<Group | 'new' | 'bulk' | null>(null),
    [arranging, setArranging] = useState<Group | null>(null),
    [sample, setSample] = useState<Sample | null>(null);
  const [fieldMeasurementItem, setFieldMeasurementItem] = useState<string | null>(null);
  const [paste, setPaste] = useState(false),
    [text, setText] = useState(''),
    [preview, setPreview] = useState<TablePreview | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const { open: openMenu, menu } = useContextMenu();
  function askDelete(request: DeleteRequest, ids: string[] = []) {
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
  const visible = groups.filter((group) => {
    const text = `${group.name || ''} ${group.material || ''} ${group.state} ${materialSummary(group)} ${group.preparation} ${group.notes}`;
    return (
      textIncludes(text, search) ||
      textIncludes(groupOperationText(snapshot, group.id), search) ||
      matchesGroupIdentity(snapshot, group.id, search)
    );
  });
  const insights = reportInsights(snapshot, experimentId);
  const next = nextPending(snapshot, experimentId);
  const brief = next ? nextOperationBrief(snapshot, experimentId) : null;
  const recent = latestRecorded(snapshot, experimentId);
  const firstGap = followUpRoster(snapshot, experimentId)[0];
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
  function editFieldSheetSample(sampleId: string) {
    void workspace
      .flush()
      .then(() => {
        const current = workspace.getSnapshot().samples.find((entry) => entry.id === sampleId);
        if (!current) throw new Error('样品计划已变化，请刷新后重试。');
        setSampleDetailsOnly(true);
        setSample(current);
      })
      .catch((failure) =>
        notify(failure instanceof Error ? failure.message : '无法打开样品编辑。', true),
      );
  }
  function editFieldSheetMeasurement(itemId: string) {
    void workspace
      .flush()
      .then(() => {
        const current = workspace.getSnapshot().items.find((entry) => entry.id === itemId);
        if (!current) throw new Error('测量计划已变化，请刷新后重试。');
        if (
          current.status === 'running' ||
          current.status === 'completed' ||
          current.status === 'interrupted'
        )
          throw new Error('这项测量已有记录，不能修改开始时计划。');
        setFieldMeasurementItem(current.id);
      })
      .catch((failure) =>
        notify(failure instanceof Error ? failure.message : '无法打开测量编辑。', true),
      );
  }
  function viewFieldSheetOperation(itemId: string, status: string) {
    void workspace
      .flush()
      .then(() => {
        const current = workspace.getSnapshot().items.find((entry) => entry.id === itemId);
        if (!current) throw new Error('测量计划已变化，请刷新后重试。');
        setItemId(current.id);
        setPage(status === 'running' ? 'live' : 'review');
      })
      .catch((failure) =>
        notify(failure instanceof Error ? failure.message : '无法打开测量记录。', true),
      );
  }
  return (
    <div className="page plan-page">
      <div className="page-heading">
        <div>
          <h1>实验规划</h1>
          <p>填写样品和测量条件，核对后打印带到现场。</p>
        </div>
        <button
          className="button"
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
      <FieldSheetCard
        onAddSample={() => setQuickAdd(true)}
        addSampleButtonRef={quickAddTrigger}
        onEditSample={editFieldSheetSample}
        onEditMeasurement={editFieldSheetMeasurement}
        onViewOperation={viewFieldSheetOperation}
      />
      <details
        className="card plan-management"
        open={managementOpen}
        onToggle={(event) => setManagementOpen(event.currentTarget.open)}
      >
        <summary>样品准备与批量管理</summary>
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
          <div className="stat" title="已知准备数量，含尚未启用的备样">
            <Package size={20} />
            <div>
              <strong>
                {preparationUnknown ? '未知' : insights.preparedKnown}
                {!preparationUnknown && <small>个</small>}
              </strong>
              <span>准备</span>
              {insights.unknownPreparation > 0 && (
                <small className="stat-unknown">{insights.unknownPreparation} 组准备数量未知</small>
              )}
            </div>
          </div>
          <div className="stat accent" title="不同物理样品，重测不另计">
            <span className="stat-icon">↗</span>
            <div>
              <strong>
                {insights.plannedSamples}
                <small>个</small>
              </strong>
              <span>计划样品</span>
            </div>
          </div>
          <div className="stat" title="每次测量各计一项，含重测">
            <TrendingUp size={20} />
            <div>
              <strong>
                {insights.plannedOperations}
                <small>项</small>
              </strong>
              <span>计划操作</span>
            </div>
          </div>
          <div className="stat" title="尚未启用，不计入计划样品">
            <Boxes size={20} />
            <div>
              <strong>
                {preparationUnknown ? '未知' : insights.spareKnown}
                {!preparationUnknown && <small>个</small>}
              </strong>
              <span>备样</span>
              {insights.unknownPreparation > 0 && (
                <small className="stat-unknown">{insights.unknownPreparation} 组备样数量未知</small>
              )}
            </div>
          </div>
        </div>
        <section className="plan-progress" aria-label="计划进度">
          <OperationMix
            completed={insights.completed}
            running={insights.running}
            pending={insights.pending}
            skipped={insights.skipped}
            interrupted={insights.interrupted}
          />
          {next ? (
            <div className="next-step" role="region" aria-label="下一项待测">
              <div>
                <strong>下一项 {next.sampleCode}</strong>
                <span>
                  {[
                    brief?.measurement || next.operation,
                    brief?.preparation,
                    brief?.protocol,
                    brief?.repeat,
                    brief?.sourceIssue,
                    brief?.folder || next.plannedName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {canCopyName(brief?.folder || next.plannedName) && (
                <button
                  type="button"
                  className="button small"
                  aria-label={`复制下一项文件夹 ${next.sampleCode}`}
                  onClick={() => {
                    void workspace
                      .flush()
                      .then(async () => {
                        const fresh = nextOperationBrief(workspace.getSnapshot(), experimentId);
                        const name = fresh?.folder || '';
                        if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
                        await unwrap(window.labrecord.copyName(name));
                        notify('下一项数据文件夹名已复制。');
                      })
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  复制文件夹
                </button>
              )}
              {canCopyProtocol(brief?.protocol) && (
                <button
                  type="button"
                  className="button small"
                  aria-label={`复制下一项实验制度 ${next.sampleCode}`}
                  onClick={() => {
                    void workspace
                      .flush()
                      .then(async () => {
                        const fresh = nextOperationBrief(workspace.getSnapshot(), experimentId);
                        const text = protocolCopyText(fresh?.protocol);
                        if (!canCopyProtocol(text)) throw new Error('还没有可复制的实验制度。');
                        await unwrap(window.labrecord.copyText(text));
                        notify('下一项实验制度已复制。');
                      })
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  复制制度
                </button>
              )}
              {brief?.sourceIssue &&
                repeatSource(
                  snapshot,
                  snapshot.items.find((item) => item.id === next.itemId)!,
                ) && (
                  <button
                    type="button"
                    className="button small"
                    aria-label={`查看下一项的原操作 ${next.sampleCode}`}
                    onClick={() => {
                      void workspace
                        .flush()
                        .then(() => {
                          const fresh = workspace.getSnapshot();
                          const item = fresh.items.find((entry) => entry.id === next.itemId);
                          const source = item && repeatSource(fresh, item);
                          if (!source) throw new Error('原操作已不存在。');
                          setItemId(source.itemId);
                          setPage('live');
                        })
                        .catch((error) => notify(error.message, true));
                    }}
                  >
                    查看原操作
                  </button>
                )}
              <button
                type="button"
                className="button small"
                aria-label={`去现场查看下一项 ${next.sampleCode}`}
                onClick={() => {
                  void workspace
                    .flush()
                    .then(() => {
                      setItemId(next.itemId);
                      setPage('live');
                    })
                    .catch((error) => notify(error.message, true));
                }}
              >
                去现场查看
              </button>
            </div>
          ) : (
            insights.plannedOperations > 0 &&
            insights.pending === 0 &&
            insights.running === 0 && <p className="hint">没有待测操作。</p>
          )}
          {firstGap && (
            <div className="next-step" role="region" aria-label="先核对">
              <div>
                <strong>先核对 {firstGap.sampleCode}</strong>
                <span>{firstGap.gaps.join('、')}</span>
              </div>
              <button
                type="button"
                className="button small"
                aria-label={`去核对 ${firstGap.sampleCode}`}
                onClick={() => {
                  void workspace
                    .flush()
                    .then(() => {
                      setItemId(firstGap.itemId);
                      setPage('live');
                    })
                    .catch((error) => notify(error.message, true));
                }}
              >
                去核对
              </button>
            </div>
          )}
          {recent && (
            <div className="next-step" role="region" aria-label="最近记录">
              <div>
                <strong>
                  {recent.status === 'interrupted' ? '最近中断' : '最近完成'} {recent.sampleCode}
                </strong>
                <span>
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
                </span>
              </div>
              {canCopyName(recent.folder) && (
                <button
                  type="button"
                  className="button small"
                  aria-label={`复制最近记录文件夹 ${recent.sampleCode}`}
                  onClick={() => {
                    void workspace
                      .flush()
                      .then(async () => {
                        const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
                        const name = fresh?.folder || '';
                        if (!canCopyName(name)) throw new Error('还没有可复制的数据文件夹名。');
                        await unwrap(window.labrecord.copyName(name));
                        notify('最近记录的数据文件夹名已复制。');
                      })
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  复制文件夹
                </button>
              )}
              {canCopyName(recent.scanId) && (
                <button
                  type="button"
                  className="button small"
                  aria-label={`复制最近记录扫描编号 ${recent.sampleCode}`}
                  onClick={() => {
                    void workspace
                      .flush()
                      .then(async () => {
                        const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
                        const name = fresh?.scanId || '';
                        if (!canCopyName(name)) throw new Error('还没有可复制的扫描编号。');
                        await unwrap(window.labrecord.copyName(name));
                        notify('最近记录的扫描编号已复制。');
                      })
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  复制扫描编号
                </button>
              )}
              {canCopyName(recent.filename) && (
                <button
                  type="button"
                  className="button small"
                  aria-label={`复制最近记录文件名 ${recent.sampleCode}`}
                  onClick={() => {
                    void workspace
                      .flush()
                      .then(async () => {
                        const fresh = latestRecorded(workspace.getSnapshot(), experimentId);
                        const name = fresh?.filename || '';
                        if (!canCopyName(name)) throw new Error('还没有可复制的实际文件名。');
                        await unwrap(window.labrecord.copyName(name));
                        notify('最近记录的实际文件名已复制。');
                      })
                      .catch((error) => notify(error.message, true));
                  }}
                >
                  复制文件名
                </button>
              )}
              <button
                type="button"
                className="button small"
                aria-label={`安排最近记录的重测 ${recent.sampleCode}`}
                onClick={() => {
                  if (repeatingRecent.current) return;
                  repeatingRecent.current = true;
                  void workspace
                    .flush()
                    .then(() => execute({ type: 'repeat', itemId: recent.itemId }, false))
                    .catch((error) => notify(error.message, true))
                    .finally(() => {
                      repeatingRecent.current = false;
                    });
                }}
              >
                安排重测
              </button>
              <button
                type="button"
                className="button small"
                aria-label={`查看最近记录 ${recent.sampleCode}`}
                onClick={() => {
                  void workspace
                    .flush()
                    .then(() => {
                      setItemId(recent.itemId);
                      setPage('live');
                    })
                    .catch((error) => notify(error.message, true));
                }}
              >
                查看
              </button>
            </div>
          )}
        </section>
        <section className="card planning-card">
          <div className="card-toolbar">
            <div className="toolbar-title">
              <h2>样品准备</h2>
              <span>
                {search ? `${visible.length} / ${groups.length}` : groups.length} 个样品组
              </span>
            </div>
            <div className="toolbar-actions">
              <SearchField
                label="搜索样品组"
                placeholder="材料、样品 ID、工艺或备注"
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
            </div>
          </div>
          {selected.size > 0 && (
            <div className="selection-bar">
              <span>已选 {selected.size} 组</span>
              <button className="button small" onClick={() => setEditing('bulk')}>
                <SlidersHorizontal size={14} />
                批量设置参数
              </button>
              <button
                type="button"
                className="button small danger"
                disabled={!!groupsDeleteReason(snapshot, [...selected])}
                title={groupsDeleteReason(snapshot, [...selected]) || '删除所选样品组'}
                onClick={() => {
                  const chosen = groups.filter((group) => selected.has(group.id));
                  if (!chosen.length) return;
                  askDelete(
                    groupDeleteRequest(chosen),
                    chosen.map((group) => group.id),
                  );
                }}
              >
                <Trash2 size={14} />
                删除所选样品组
              </button>
              <button className="text-button" onClick={() => setSelected(new Set())}>
                取消选择
              </button>
            </div>
          )}
          {groups.length === 0 ? (
            <Empty
              title="添加第一份实验样品"
              description="使用上方现场规划表中的“新增样品”按钮，或导入已有表格。"
            />
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
                      <span>材料 / 制备状态</span>
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
                        <Empty title="没有找到样品" description="换一个名称、状态或备注。">
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
                        onSample={(current) => {
                          setSampleDetailsOnly(false);
                          setSample(current);
                        }}
                        openMenu={openMenu}
                        askDelete={askDelete}
                        selectedIds={selected.has(group.id) ? [...selected] : [group.id]}
                        onLive={(sampleId, itemId) => {
                          void workspace
                            .flush()
                            .then(() => {
                              const sampleItems = workspace
                                .getSnapshot()
                                .items.filter((item) => item.sampleId === sampleId)
                                .sort((a, b) => a.order - b.order);
                              const item =
                                sampleItems.find((entry) => entry.id === itemId) ||
                                sampleItems.find((entry) => entry.status === 'running') ||
                                sampleItems.find((entry) => entry.status === 'pending') ||
                                sampleItems.at(-1);
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
            <span>右键可编辑、复制、安排或删除 · Alt + N 添加样品</span>
          </div>
        </section>
        <MeasurementPlanner />
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
      </details>
      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} />}
      {editing && (
        <GroupForm
          group={typeof editing === 'object' ? editing : undefined}
          ids={editing === 'bulk' ? [...selected] : undefined}
          onClose={() => setEditing(null)}
        />
      )}
      {arranging && <ArrangeDialog group={arranging} onClose={() => setArranging(null)} />}
      {sample && (
        <SampleEditor
          sample={sample}
          detailsOnly={sampleDetailsOnly}
          onClose={() => setSample(null)}
        />
      )}
      {fieldMeasurementItem && (
        <MeasurementDialog
          items={workspace.getSnapshot().items.filter((entry) => entry.id === fieldMeasurementItem)}
          onClose={() => setFieldMeasurementItem(null)}
        />
      )}
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
      {menu}
      <DeleteConfirm pending={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}
function groupSizeText(group: Group, samples: Sample[]) {
  const own = samples.filter((sample) =>
    (['thickness', 'width', 'height'] as const).some((key) => key in sample.parameters),
  );
  if (samples.length > 0 && own.length === samples.length) {
    const labels = own.map((sample) =>
      filledSize({
        thickness: sample.parameters.thickness ?? '',
        thicknessUnit: sample.parameters.thicknessUnit ?? '',
        width: sample.parameters.width ?? '',
        height: sample.parameters.height ?? '',
        dimensionUnit: sample.parameters.dimensionUnit ?? '',
      }),
    );
    if (new Set(labels).size === 1) {
      return (
        <>
          <span>{labels[0] || '安排测试时按每一件填写'}</span>
          {labels[0] && <small>{samples.length} 件各自保存</small>}
        </>
      );
    }
    return <span>尺寸各不相同，见下面每一件</span>;
  }
  const inherited = filledSize(group);
  if (inherited) return <span>尚未单独填写的样品沿用：{inherited}</span>;
  return <span>安排测试时按每一件填写</span>;
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
  openMenu,
  askDelete,
  selectedIds,
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
  openMenu: (event: MouseEvent, entries: MenuEntry[]) => void;
  askDelete: (request: DeleteRequest, ids?: string[]) => void;
  selectedIds: string[];
  onLive: (sampleId: string, itemId?: string) => void;
}) {
  const { execute, snapshot, flush, notify } = useWorkspace();
  const repeating = useRef(new Set<string>());
  const title = sampleName(group);
  const sampleIds = new Set(samples.map((sample) => sample.id));
  const groupItems = snapshot.items.filter((item) => sampleIds.has(item.sampleId));
  const interruptedCount = groupItems.filter((item) => item.status === 'interrupted').length;
  const skippedCount = groupItems.filter((item) => item.status === 'skipped').length;
  const runningCount = groupItems.filter((item) => item.status === 'running').length;
  const pendingCount = groupItems.filter((item) => item.status === 'pending').length;
  const operationStatus = [
    runningCount ? `进行中 ${runningCount}` : '',
    counts.completed ? `完成 ${counts.completed}` : '',
    interruptedCount ? `中断 ${interruptedCount}` : '',
    skippedCount ? `跳过 ${skippedCount}` : '',
    pendingCount ? `待测 ${pendingCount}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const recorded = recordedDuration(
    snapshot.runs.filter((run) => groupItems.some((item) => item.id === run.itemId)),
  );
  const recordedLabel = [
    recorded.completeCount ? `已记录 ${formatRecordedDuration(recorded.milliseconds)}` : '',
    recorded.incompleteCount ? `${recorded.incompleteCount} 次未计入` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const overrideCount = samples.filter((sample) => {
    const state = sample.parameters.state?.trim();
    const notes = sample.parameters.notes?.trim();
    return (
      sampleOverrideLabel(group, sample.parameters) ||
      (!!state && state !== group.state.trim()) ||
      (!!notes && notes !== (group.notes || '').trim())
    );
  }).length;
  const driftCount = groupItems.filter((item) => operationPlanDrift(snapshot, item)).length;
  const firstDrift = groupItems
    .filter((item) => operationPlanDrift(snapshot, item))
    .sort((a, b) => a.order - b.order)[0];
  const groupReason = groupsDeleteReason(snapshot, selectedIds);
  function saveSpecimen(id: string, parameters: GroupPatch) {
    return execute({ type: 'updateSamples', ids: [id], parameters }, false);
  }
  function removeGroups() {
    const chosen = selectedIds
      .map((id) => snapshot.groups.find((entry) => entry.id === id))
      .filter((entry): entry is Group => !!entry);
    if (chosen.length) askDelete(groupDeleteRequest(chosen), selectedIds);
  }
  return (
    <>
      <tr
        className={selected ? 'selected-row' : ''}
        onContextMenu={(event) =>
          openMenu(event, [
            { kind: 'item', label: '编辑', onSelect: onEdit },
            { kind: 'item', label: '复制样品组', onSelect: onCopy },
            { kind: 'item', label: '安排测试', onSelect: onArrange },
            { kind: 'separator' },
            {
              kind: 'item',
              label: groupReason
                ? '删除样品组（已有记录）'
                : selectedIds.length > 1
                  ? `删除所选 ${selectedIds.length} 个样品组`
                  : '删除样品组',
              disabled: !!groupReason,
              danger: true,
              title: groupReason || undefined,
              onSelect: removeGroups,
            },
          ])
        }
      >
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
              label={`${title} 样品统称`}
              value={group.name || ''}
              onSave={(name) => save({ name })}
              placeholder={group.state}
            />
            <MaterialPreparationSummary value={group} compact />
            <small className="sample-state-caption">
              {group.state === '未指定' ? '每件样品连续编号' : `原始状态：${group.state}`}
            </small>
            {overrideCount > 0 && (
              <small className="group-sample-overrides">{overrideCount} 件不同于本组</small>
            )}
            {firstDrift && (
              <button
                type="button"
                className="text-button group-plan-drift"
                aria-label="查看开始后计划已变的操作"
                onClick={() => onLive(firstDrift.sampleId, firstDrift.id)}
              >
                {driftCount} 件开始后计划已变
              </button>
            )}
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
              onSave={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return save({ preparedCount: null });
                if (!/^\d+$/.test(trimmed) || Number(trimmed) > 10000)
                  return Promise.reject(new Error('准备数量应为 0–10000 的整数。'));
                return save({ preparedCount: Number(trimmed) });
              }}
              type="number"
              min={0}
              step={1}
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
          {operationStatus && <small className="group-operation-status">{operationStatus}</small>}
          {recordedLabel && <small className="group-recorded-duration">{recordedLabel}</small>}
        </td>
        <td className="size-cell">{groupSizeText(group, samples)}</td>
        <td>
          <AutoInput
            label={`${group.state} 实验方式`}
            value={group.mode}
            onSave={(mode) => save({ mode: mode as Mode })}
            options={MODE_OPTIONS}
          />
          {group.mode !== '未定' ? (
            <small className="protocol-summary" title={group.protocol || '尚未填写实验制度'}>
              {group.protocol?.trim() ? group.protocol.trim().split('\n')[0] : '尚未填写实验制度'}
            </small>
          ) : (
            group.protocol?.trim() && (
              <details className="protocol-kept">
                <summary>仍保留实验制度</summary>
                <p>{group.protocol}</p>
              </details>
            )
          )}
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
            <button
              type="button"
              className="icon-button danger"
              aria-label={`删除样品组 ${title}`}
              title={groupsDeleteReason(snapshot, [group.id]) || '删除样品组'}
              disabled={!!groupsDeleteReason(snapshot, [group.id])}
              onClick={() => askDelete(groupDeleteRequest([group]), [group.id])}
            >
              <Trash2 size={14} />
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
                  {interruptedCount ? ` · 中断 ${interruptedCount}` : ''}
                  {skippedCount ? ` · 跳过 ${skippedCount}` : ''}
                </span>
              </div>
              <MaterialPreparationSummary value={group} />
              {(group.mode !== '未定' || group.protocol?.trim()) && (
                <div className="protocol-card">
                  {group.mode !== '未定' ? (
                    <>
                      <span>实验制度</span>
                      <AutoInput
                        multiline
                        label={`${group.state} 实验制度`}
                        value={group.protocol ?? ''}
                        onSave={(protocol) => save({ protocol })}
                        placeholder={PROTOCOL_PLACEHOLDER}
                      />
                      <small>组内样品留空时沿用这里。已开始的操作仍显示开始时写下的制度。</small>
                    </>
                  ) : (
                    <details open>
                      <summary>仍保留实验制度</summary>
                      <p>{group.protocol}</p>
                    </details>
                  )}
                </div>
              )}
              {fields.length > 0 && (
                <FieldInputs
                  fields={fields}
                  values={group.values}
                  save={(values) => save({ values })}
                />
              )}
              {samples.length ? (
                samples.map((sample) => {
                  const showProtocol =
                    group.mode !== '未定' ||
                    !!(sample.parameters.protocol?.trim() || group.protocol?.trim());
                  const operations = groupItems
                    .filter((item) => item.sampleId === sample.id)
                    .sort((a, b) => a.order - b.order);
                  return (
                    <div
                      className="sample-strip"
                      key={sample.id}
                      onContextMenu={(event) => {
                        const reason = sampleDeleteReason(snapshot, sample);
                        openMenu(event, [
                          { kind: 'item', label: '编辑样品参数', onSelect: () => onSample(sample) },
                          { kind: 'item', label: '现场记录', onSelect: () => onLive(sample.id) },
                          { kind: 'separator' },
                          {
                            kind: 'item',
                            label: reason ? '移出计划（已有记录）' : '移出计划',
                            disabled: !!reason,
                            danger: true,
                            title: reason || '移出后准备数量不变，这件回到备样',
                            onSelect: () => askDelete(sampleDeleteRequest(sample)),
                          },
                        ]);
                      }}
                    >
                      <div>
                        <code>{sample.code}</code>
                        <small className="sample-note">
                          {dimensions({ ...group, ...sample.parameters })}
                        </small>
                        {sample.parameters.state?.trim() &&
                          sample.parameters.state.trim() !== group.state.trim() && (
                            <small className="sample-note">
                              状态 {sample.parameters.state.trim()}
                            </small>
                          )}
                        {sampleOverrideLabel(group, sample.parameters) && (
                          <small className="sample-override">
                            本样品 {sampleOverrideLabel(group, sample.parameters)}
                          </small>
                        )}
                        {operations.length > 0 && (
                          <div
                            className="sample-operations"
                            role="group"
                            aria-label={`${sample.code} 的操作`}
                          >
                            {operations.map((item) => {
                              const reason = operationStatusReason(snapshot, item);
                              const run = snapshot.runs.find((entry) => entry.itemId === item.id);
                              const ended = recordedEndLabel(run);
                              const started = recordedStartLabel(run);
                              const fileLabel = actualFilenameLabel(run);
                              const protocolLabel = operationProtocolLabel(snapshot, item);
                              return (
                                <span key={item.id}>
                                  <button
                                    type="button"
                                    className="text-button"
                                    aria-label={`查看 ${sample.code} 操作 ${item.order + 1} ${STATUS_LABEL[item.status]}`}
                                    onClick={() => onLive(sample.id, item.id)}
                                  >
                                    操作 {String(item.order + 1).padStart(2, '0')} ·{' '}
                                    {STATUS_LABEL[item.status]}
                                    {run ? ` · 用时 ${runDurationLabel(run)}` : ''}
                                    {started ? ` · ${started}` : ''}
                                    {ended ? ` · ${ended}` : ''}
                                    {fileLabel ? ` · ${fileLabel}` : ''}
                                    {reason ? ` · 原因：${reason}` : ''}
                                  </button>
                                  {protocolLabel && (
                                    <small className="operation-protocol" title={protocolLabel}>
                                      {protocolLabel}
                                    </small>
                                  )}
                                  {item.status === 'skipped' && (
                                    <button
                                      type="button"
                                      className="text-button"
                                      aria-label={`恢复 ${sample.code} 操作 ${item.order + 1}`}
                                      onClick={() => {
                                        void flush()
                                          .then(() =>
                                            execute({ type: 'unskip', itemId: item.id }, false),
                                          )
                                          .catch((error) => notify(error.message, true));
                                      }}
                                    >
                                      恢复待测
                                    </button>
                                  )}
                                  {(item.status === 'completed' ||
                                    item.status === 'interrupted') && (
                                    <button
                                      type="button"
                                      className="text-button"
                                      aria-label={`安排重测 ${sample.code} 操作 ${item.order + 1}`}
                                      onClick={() => {
                                        if (repeating.current.has(item.id)) return;
                                        repeating.current.add(item.id);
                                        void flush()
                                          .then(() =>
                                            execute({ type: 'repeat', itemId: item.id }, false),
                                          )
                                          .catch((error) => notify(error.message, true))
                                          .finally(() => repeating.current.delete(item.id));
                                      }}
                                    >
                                      安排重测
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div className="specimen-fields">
                        <AutoInput
                          label={`${sample.code} 样品名`}
                          value={sample.parameters.name || ''}
                          placeholder={`不填则显示 ${sample.code}`}
                          onSave={(name) => saveSpecimen(sample.id, { name: name.trim() })}
                        />
                        <AutoInput
                          label={`${sample.code} 样品状态`}
                          value={sample.parameters.state || group.state}
                          placeholder={group.state || '本组状态'}
                          onSave={(state) =>
                            saveSpecimen(sample.id, { state: state.trim() || group.state })
                          }
                        />
                        <AutoInput
                          label={`${sample.code} 备注`}
                          value={sample.parameters.notes || ''}
                          placeholder={group.notes?.trim() || '留空则沿用样品组'}
                          onSave={(notes) => saveSpecimen(sample.id, { notes })}
                        />
                        {showProtocol && (
                          <AutoInput
                            label={`${sample.code} 实验制度`}
                            value={sample.parameters.protocol || ''}
                            placeholder={group.protocol?.trim() || '留空则沿用样品组'}
                            onSave={(protocol) =>
                              saveSpecimen(sample.id, {
                                protocol:
                                  protocol.trim() === (group.protocol ?? '').trim() ? '' : protocol,
                              })
                            }
                          />
                        )}
                      </div>
                      <div className="strip-actions">
                        <button className="text-button" onClick={() => onSample(sample)}>
                          编辑样品参数
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`打开 ${sample.code} 的当前操作`}
                          onClick={() => onLive(sample.id)}
                        >
                          现场记录 <ArrowRight size={13} />
                        </button>
                        <button
                          type="button"
                          className="text-button danger"
                          aria-label={`移出计划 ${sample.code}`}
                          title={
                            sampleDeleteReason(snapshot, sample) ||
                            '移出后准备数量不变，这件回到备样'
                          }
                          disabled={!!sampleDeleteReason(snapshot, sample)}
                          onClick={() => askDelete(sampleDeleteRequest(sample))}
                        >
                          移出计划
                        </button>
                      </div>
                    </div>
                  );
                })
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
