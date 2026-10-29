import { useEffect, useRef, useState, type Ref } from 'react';
import {
  CODE_PATTERN_HYPHEN,
  CODE_PATTERN_PAD,
  MODE_LABEL,
  STATUS_LABEL,
  codePatternError,
  type Command,
} from '../shared/model';
import { fieldSheetRows, type FieldSheetRow } from '../shared/fieldSheet';
import { measurementFor, plannedGroup, regimeLabel } from '../shared/measurement';
import { actualFieldSource, actualSpecimenName, actualSpecimenNameField } from '../shared/planChanges';
import { AutoInput } from './components';
import { useWorkspace, unwrap } from './context';

/** An unrecorded actual field stays empty; plan values are shown only as references. */
function actualValue(values: Record<string, unknown> | undefined, key: string, fallback: string) {
  return values && Object.prototype.hasOwnProperty.call(values, key)
    ? String(values[key] ?? '')
    : fallback;
}

interface FieldSheetCardProps {
  onAddSample: () => void;
  addSampleButtonRef: Ref<HTMLButtonElement>;
  onEditSample: (sampleId: string) => void;
  onEditMeasurement: (itemId: string) => void;
  onViewOperation: (itemId: string, status: string) => void;
}

type FieldRowCommand = Extract<Command, { type: 'updateFieldRow' }>;

function FieldSheetEditableRow({
  row,
  update,
  copyFolder,
  repeat,
  onEditSample,
  onEditMeasurement,
  onViewOperation,
}: {
  row: FieldSheetRow;
  update: (command: FieldRowCommand) => Promise<unknown>;
  copyFolder: (itemId: string) => Promise<void>;
  repeat: (itemId: string) => Promise<void>;
  onEditSample: (sampleId: string) => void;
  onEditMeasurement: (itemId: string) => void;
  onViewOperation: (itemId: string, status: string) => void;
}) {
  const { snapshot } = useWorkspace();
  const item = snapshot.items.find((entry) => entry.id === row.itemId);
  const sample = snapshot.samples.find((entry) => entry.id === row.sampleId);
  const storedGroup = sample && snapshot.groups.find((entry) => entry.id === sample.groupId);
  if (!item || !sample || !storedGroup) return null;
  const run = snapshot.runs.find((entry) => entry.itemId === item.id);
  const group = run?.snapshot.group ?? plannedGroup(storedGroup, sample, item);
  const recordedSample = run?.actualSample as Record<string, unknown> | undefined;
  const originalSample = run?.snapshot.sample ?? sample;
  const measurement = measurementFor(snapshot, item);
  const code = row.code || `${sample.code} 操作 ${item.order + 1}`;
  const groupName = run
    ? run.snapshot.sampleGroupName !== undefined
      ? (run.snapshot.sampleGroupName ?? '')
      : Object.prototype.hasOwnProperty.call(originalSample.parameters, 'name')
        ? ''
        : (group.name ?? '')
    : (storedGroup.name ?? '');
  const name = run ? (actualSpecimenName(run) ?? '') : (originalSample.parameters.name ?? '');
  const state = actualValue(recordedSample, 'state', run ? '' : group.state);
  const thickness = actualValue(run?.actual, 'thickness', run ? '' : (group.thickness ?? ''));
  const thicknessUnit = actualValue(run?.actual, 'thicknessUnit', run ? '' : (group.thicknessUnit ?? ''));
  const width = actualValue(recordedSample, 'width', run ? '' : (group.width ?? ''));
  const height = actualValue(recordedSample, 'height', run ? '' : (group.height ?? ''));
  const dimensionUnit = actualValue(recordedSample, 'dimensionUnit', run ? '' : (group.dimensionUnit ?? ''));
  const protocol = actualValue(run?.actual, 'protocol', run ? '' : (measurement.protocol ?? ''));
  const mode = actualValue(run?.actual, 'mode', measurement.mode ?? '');
  const missingSample = (key: string) => !!run && (!recordedSample || !Object.prototype.hasOwnProperty.call(recordedSample, key));
  const missingActual = (key: string) => !!run && !Object.prototype.hasOwnProperty.call(run.actual, key);
  const plannedName = Object.prototype.hasOwnProperty.call(originalSample.parameters, 'name')
    ? originalSample.parameters.name ?? '' : group.name ?? '';
  const context = [
    mode && mode !== '未定' ? (MODE_LABEL[mode as keyof typeof MODE_LABEL] ?? mode) : '',
    measurement.technique ?? '',
    measurement.regime ? regimeLabel(measurement.regime) : '',
    measurement.batch ? `批次：${measurement.batch}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const saveSample = (patch: NonNullable<FieldRowCommand['sample']>) =>
    update({ type: 'updateFieldRow', itemId: item.id, sample: patch });

  return (
    <tr>
      <td>
        <code>{row.code || '尚未预留'}</code>
        {row.status !== 'pending' && (
          <span className="field-sheet-status">状态：{STATUS_LABEL[row.status]}</span>
        )}
        <div className="field-sheet-row-actions">
          {row.code && (
            <button
              type="button"
              className="text-button"
              aria-label={`复制文件夹名 ${code}`}
              onClick={() => void copyFolder(item.id)}
            >
              复制
            </button>
          )}
          <button
            type="button"
            className="text-button"
            aria-label={`再测一次 ${code}`}
            onClick={() => void repeat(item.id)}
          >
            再测一次
          </button>
        </div>
      </td>
      <td>
        <div className="field-sheet-dimensions">
          <div className="field-sheet-dimension">
            <span aria-hidden="true">厚</span>
            <AutoInput
              label={`${code} 厚度`}
              value={thickness}
              placeholder={missingActual('thickness') ? '未记录' : undefined}
              onSave={(v) => saveSample({ thickness: v })}
            />
          </div>
          <AutoInput
            label={`${code} 厚度单位`}
            value={thicknessUnit}
            placeholder={missingActual('thicknessUnit') ? '未记录' : '单位'}
            onSave={(v) => saveSample({ thicknessUnit: v })}
          />
          <div className="field-sheet-dimension">
            <span aria-hidden="true">宽</span>
            <AutoInput
              label={`${code} 宽度`}
              value={width}
              placeholder={missingSample('width') ? '未记录' : undefined}
              onSave={(v) => saveSample({ width: v })}
            />
          </div>
          <div className="field-sheet-dimension">
            <span aria-hidden="true">高</span>
            <AutoInput
              label={`${code} 高度`}
              value={height}
              placeholder={missingSample('height') ? '未记录' : undefined}
              onSave={(v) => saveSample({ height: v })}
            />
          </div>
          <div className="field-sheet-dimension field-sheet-dimension-unit">
            <span aria-hidden="true">宽高单位</span>
            <AutoInput
              label={`${code} 宽高单位`}
              value={dimensionUnit}
              placeholder={missingSample('dimensionUnit') ? '未记录' : '单位'}
              onSave={(v) => saveSample({ dimensionUnit: v })}
            />
          </div>
        </div>
        {run && (row.size.startsWith('实际 ') || row.size.startsWith('开始时 ')) && (
          <small className="field-sheet-history">{row.size}</small>
        )}
      </td>
      <td>
        {context && <small className="field-sheet-group-name">{context}</small>}
        <AutoInput
          label={`${code} 原位参数`}
          value={protocol}
          multiline
          placeholder={run && !Object.prototype.hasOwnProperty.call(run.actual, 'protocol')
            ? `未记录（开始时：${measurement.protocol || '未填写'}）`
            : '填写本次测量条件'}
          onSave={(v) => update({ type: 'updateFieldRow', itemId: item.id, protocol: v })}
        />
        {run && protocol !== (measurement.protocol ?? '') && (
          <small className="field-sheet-history">开始时：{measurement.protocol || '未填写'}</small>
        )}
      </td>
      <td>
        {groupName && groupName !== name && (
          <small className="field-sheet-group-name">{groupName}</small>
        )}
        <div className="field-sheet-identity-inputs">
          <AutoInput
            label={`${code} 原始编号或名称`}
            value={name}
            placeholder={run && !actualSpecimenNameField(run) ? '未记录' : '原始编号或名称'}
            onSave={(v) => saveSample({ name: v })}
          />
          <AutoInput
            label={`${code} 样品状态`}
            value={state}
            placeholder={missingSample('state') ? '未记录' : '样品状态'}
            onSave={(v) => saveSample({ state: v })}
          />
        </div>
        {run && (
          <small className="field-sheet-history">
            名称：{actualFieldSource(run, actualSpecimenNameField(run))}；状态：{actualFieldSource(run, 'actualSample.state')}
          </small>
        )}
        {run && (missingSample('state') || !actualSpecimenNameField(run)) && (
          <small className="field-sheet-history">
            未记录的实际信息留空；开始时：{plannedName || '未填写'} · {group.state || '未填写'}
          </small>
        )}
        <details className="field-sheet-more">
          <summary aria-label={`更多信息 ${code}`}>更多</summary>
          {row.identity && <p className="field-sheet-history">{row.identity}</p>}
          {row.protocol && <p className="field-sheet-history">{row.protocol}</p>}
          <div className="field-sheet-row-actions">
            <button
              type="button"
              className="text-button"
              aria-label={`更多样品信息 ${code}`}
              onClick={() => onEditSample(sample.id)}
            >
              更多样品信息
            </button>
            {run ? (
              <button
                type="button"
                className="text-button"
                aria-label={`查看记录 ${code}`}
                onClick={() => onViewOperation(item.id, item.status)}
              >
                查看记录
              </button>
            ) : (
              <button
                type="button"
                className="text-button"
                aria-label={`更多测量设置 ${code}`}
                onClick={() => onEditMeasurement(item.id)}
              >
                更多测量设置
              </button>
            )}
          </div>
        </details>
      </td>
      <td>
        {row.noteSource === 'legacy-run' && (
          <small className="field-sheet-note-source">原现场备注</small>
        )}
        <AutoInput
          label={`${code} 备注`}
          value={row.note}
          multiline
          placeholder="记录本次实际情况"
          onSave={(v) => update({ type: 'updateFieldRow', itemId: item.id, fieldNote: v })}
        />
        {row.legacyNotes && <div className="field-sheet-legacy-notes">{row.legacyNotes}</div>}
      </td>
    </tr>
  );
}

export function FieldSheetCard({
  onAddSample,
  addSampleButtonRef,
  onEditSample,
  onEditMeasurement,
  onViewOperation,
}: FieldSheetCardProps) {
  const workspace = useWorkspace();
  const { snapshot, experimentId, execute, notify, flush, getSnapshot, refresh } = workspace;
  const experiment = snapshot.experiments.find((entry) => entry.id === experimentId);
  const pattern = experiment?.sampleCodePattern ?? '';
  const [choice, setChoice] = useState<'pad' | 'hyphen' | 'custom' | null>(null);
  const savedCustom =
    pattern && pattern !== CODE_PATTERN_PAD && pattern !== CODE_PATTERN_HYPHEN
      ? pattern
      : '{prefix}-{n}';
  const [customDraft, setCustomDraft] = useState({ experimentId, value: savedCustom });
  const custom = customDraft.experimentId === experimentId ? customDraft.value : savedCustom;
  const [patternError, setPatternError] = useState('');
  const [patternSaving, setPatternSaving] = useState(false);
  const savingPattern = useRef(false);
  const currentExperimentId = useRef(experimentId);
  currentExperimentId.current = experimentId;
  const [busy, setBusy] = useState(false);
  const writingRow = useRef<Promise<unknown>>(Promise.resolve());
  const repeating = useRef(new Set<string>());

  useEffect(() => {
    setChoice(null);
    if (pattern && pattern !== CODE_PATTERN_PAD && pattern !== CODE_PATTERN_HYPHEN)
      setCustomDraft({ experimentId, value: pattern });
  }, [pattern, experimentId]);

  useEffect(() => {
    setPatternError('');
  }, [experimentId]);

  if (!experiment) return null;
  const rows = fieldSheetRows(snapshot, experimentId);
  const selected =
    choice ??
    (pattern === CODE_PATTERN_HYPHEN
      ? 'hyphen'
      : pattern && pattern !== CODE_PATTERN_PAD
        ? 'custom'
        : 'pad');

  async function savePattern(next: string) {
    const trimmed = next.trim();
    const error = trimmed ? codePatternError(trimmed) : '';
    setPatternError(error);
    if (error || !experiment || savingPattern.current) return;
    savingPattern.current = true;
    setPatternSaving(true);
    const targetExperimentId = experiment.id;
    try {
      await execute(
        { type: 'updateExperiment', id: targetExperimentId, sampleCodePattern: trimmed },
        false,
      );
      if (currentExperimentId.current === targetExperimentId) {
        setChoice(null);
        setPatternError('');
      }
    } catch (failure) {
      // A lost reply may follow a successful write. Read the saved pattern before
      // reverting the optimistic choice so the displayed value is not guessed.
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }
      if (currentExperimentId.current === targetExperimentId) {
        setChoice(null);
        const message = failure instanceof Error ? failure.message : '编号格式更新失败。';
        setPatternError(refreshed ? message : `${message}；无法确认当前编号格式，请刷新后重试。`);
      }
    } finally {
      savingPattern.current = false;
      setPatternSaving(false);
    }
  }

  async function copyFolder(itemId: string) {
    try {
      await flush();
      const current = getSnapshot();
      const row = fieldSheetRows(current, experimentId).find((entry) => entry.itemId === itemId);
      if (!row?.code.trim()) throw new Error('这项测量还没有预留文件夹名。');
      await unwrap(window.labrecord.copyName(row.code));
      notify(`文件夹名已复制：${row.code}`);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : '文件夹名没有复制。', true);
    }
  }

  async function addSample() {
    try {
      await flush();
      onAddSample();
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : '请先保存表格中的输入。', true);
    }
  }

  function updateRow(command: FieldRowCommand) {
    // Serialise separate field saves so their returned snapshots cannot arrive out of order.
    const operation = writingRow.current.catch(() => {}).then(() => execute(command, false));
    writingRow.current = operation;
    return operation;
  }

  async function repeatItem(itemId: string) {
    if (repeating.current.has(itemId)) return;
    repeating.current.add(itemId);
    try {
      await flush();
      const result = await execute({ type: 'repeat', itemId }, false);
      const created = result.snapshot.items.find((item) => item.id === result.itemId);
      notify(created?.plannedName ? `已安排再次测量：${created.plannedName}` : '已安排再次测量。');
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : '再次测量没有安排。', true);
    } finally {
      repeating.current.delete(itemId);
    }
  }

  async function saveSheet(format: 'xlsx' | 'pdf') {
    if (!rows.length || busy) return;
    setBusy(true);
    try {
      await flush();
      if (!fieldSheetRows(getSnapshot(), experimentId).length) {
        notify('还没有已安排的测量。', true);
        return;
      }
      const path = await unwrap(window.labrecord.exportFieldSheet(experimentId, format));
      if (path)
        notify(format === 'pdf' ? `PDF 打印表已保存：${path}` : `Excel 现场规划表已导出：${path}`);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : '现场规划表没有保存。', true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card field-sheet-card" aria-label="现场规划表">
      <div className="field-sheet-heading">
        <div>
          <h2>现场规划表</h2>
          <p className="hint">
            一行一次测量。尺寸和样品信息同步到同一件样品的待测行，条件和备注各自记录；编号可用作数据文件夹名。
          </p>
        </div>
      </div>
      <div className="field-sheet-primary-actions">
        <button
          ref={addSampleButtonRef}
          type="button"
          className="button"
          onClick={() => void addSample()}
        >
          新增样品
        </button>
        <div className="field-sheet-export-actions">
          <button
            type="button"
            className="button"
            disabled={!rows.length || busy}
            onClick={() => void saveSheet('xlsx')}
          >
            导出 Excel
          </button>
          <button
            type="button"
            className="button primary"
            aria-label="保存 PDF 打印表"
            disabled={!rows.length || busy}
            onClick={() => void saveSheet('pdf')}
          >
            保存 PDF 打印表
          </button>
        </div>
      </div>

      <details className="field-sheet-numbering">
        <summary>编号格式</summary>
        <div className="field-sheet-numbering-body">
          <label className="field">
            <span>新安排样品的编号</span>
            <select
              aria-label="新样品编号格式"
              value={selected}
              disabled={patternSaving}
              onChange={(event) => {
                if (savingPattern.current) return;
                const value = event.target.value as 'pad' | 'hyphen' | 'custom';
                setChoice(value);
                setPatternError('');
                if (value === 'pad') void savePattern('');
                if (value === 'hyphen') void savePattern(CODE_PATTERN_HYPHEN);
              }}
            >
              <option value="hyphen">连字符，如 G-1</option>
              <option value="pad">两位序号，如 G01</option>
              <option value="custom">自定义</option>
            </select>
            <small>只影响之后新安排的样品，不更改已经预留的文件夹名。</small>
          </label>
          {selected === 'custom' && (
            <div className="field-sheet-custom">
              <label className="field">
                <span>自定义编号格式</span>
                <input
                  aria-label="自定义编号格式"
                  value={custom}
                  disabled={patternSaving}
                  onChange={(event) => setCustomDraft({ experimentId, value: event.target.value })}
                  placeholder="{prefix}-{n}"
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={patternSaving}
                onClick={() => void savePattern(custom)}
              >
                使用此格式
              </button>
              <p className="hint">
                写一个 {'{prefix}'}，再写一个 {'{n}'} 或 {'{n:02}'} 到 {'{n:09}'}。
              </p>
            </div>
          )}
        </div>
        {patternError && (
          <p role="alert" className="error-text">
            {patternError}
          </p>
        )}
      </details>

      <div className="field-sheet-table-wrap">
        <table className="field-sheet">
          <thead>
            <tr>
              <th>简写编号</th>
              <th>尺寸</th>
              <th>原位参数</th>
              <th>实际样品信息</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <FieldSheetEditableRow
                  key={row.itemId}
                  row={row}
                  update={updateRow}
                  copyFolder={copyFolder}
                  repeat={repeatItem}
                  onEditSample={onEditSample}
                  onEditMeasurement={onEditMeasurement}
                  onViewOperation={onViewOperation}
                />
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  还没有已安排的测量。添加样品后，桌面预览和 PDF/Excel 会显示同一份现场表。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
