import { useEffect, useId, useRef, useState, type Ref } from 'react';
import {
  CODE_PATTERN_HYPHEN,
  CODE_PATTERN_PAD,
  STATUS_LABEL,
  codePatternError,
} from '../shared/model';
import { fieldSheetRows } from '../shared/fieldSheet';
import { useWorkspace, unwrap } from './context';

const FIELD_PREVIEW_CHAR_LIMIT = 220;
const FIELD_PREVIEW_LINE_LIMIT = 6;

function needsFullText(value: string) {
  return (
    value.length > FIELD_PREVIEW_CHAR_LIMIT ||
    value.split(/\r\n|\r|\n/).length > FIELD_PREVIEW_LINE_LIMIT
  );
}

function protocolForScreen(value: string, status: keyof typeof STATUS_LABEL) {
  if (status === 'pending') return value;
  const statusLine = `状态：${STATUS_LABEL[status]}`;
  if (value === statusLine) return '';
  const suffix = `\n${statusLine}`;
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function CollapsibleFieldText({ value, className }: { value: string; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = `field-sheet-text-${useId()}`;
  const collapsible = needsFullText(value);

  useEffect(() => {
    setExpanded(false);
  }, [value]);

  return (
    <div className={`field-sheet-text ${className}`}>
      <div
        id={contentId}
        className={
          collapsible && !expanded
            ? 'field-sheet-text-content field-sheet-text-content-collapsed'
            : 'field-sheet-text-content'
        }
      >
        {value}
      </div>
      {collapsible && (
        <button
          type="button"
          className="text-button field-sheet-expand"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? '收起' : '展开全文'}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  );
}

interface FieldSheetCardProps {
  onAddSample: () => void;
  addSampleButtonRef: Ref<HTMLButtonElement>;
  onEditSample: (sampleId: string) => void;
  onEditMeasurement: (itemId: string) => void;
  onViewOperation: (itemId: string, status: string) => void;
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
            一行一次测量。简写编号同时用作两台电脑上的数据文件夹名；同一样品再次测量会使用带序号的编号。
          </p>
        </div>
      </div>
      <div className="field-sheet-primary-actions">
        <button ref={addSampleButtonRef} type="button" className="button" onClick={onAddSample}>
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
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.itemId}>
                  <td>
                    <code>{row.code || '尚未预留'}</code>
                  </td>
                  <td>
                    <CollapsibleFieldText
                      value={row.size || '—'}
                      className="field-sheet-size-text"
                    />
                  </td>
                  <td>
                    {row.status !== 'pending' && (
                      <span className="field-sheet-status">状态：{STATUS_LABEL[row.status]}</span>
                    )}
                    <CollapsibleFieldText
                      value={protocolForScreen(row.protocol, row.status) || '—'}
                      className="field-sheet-protocol-text"
                    />
                  </td>
                  <td>
                    <CollapsibleFieldText
                      value={row.identity || '—'}
                      className="field-sheet-identity-text"
                    />
                    <div className="field-sheet-row-actions">
                      {row.code && (
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`复制文件夹名 ${row.code}`}
                          onClick={() => void copyFolder(row.itemId)}
                        >
                          复制文件夹名
                        </button>
                      )}
                      {row.status === 'running' ||
                      row.status === 'completed' ||
                      row.status === 'interrupted' ? (
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`现场查看 ${row.code || row.itemId}`}
                          onClick={() => onViewOperation(row.itemId, row.status)}
                        >
                          现场查看
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`编辑样品 ${row.code || row.itemId}`}
                            onClick={() => onEditSample(row.sampleId)}
                          >
                            编辑样品
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            aria-label={`编辑本次测量 ${row.code || row.itemId}`}
                            onClick={() => onEditMeasurement(row.itemId)}
                          >
                            编辑本次测量
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>
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
