import { useState } from 'react';
import type { TablePreview, ImportKey } from '../shared/model';
import { useWorkspace, unwrap } from './context';
import { Modal } from './components';
const fields: [ImportKey, string][] = [
  ['state', '样品状态'],
  ['name', '样品名称'],
  ['width', '宽度'],
  ['height', '高度（可选）'],
  ['dimensionUnit', '宽高单位'],
  ['preparedCount', '准备数量'],
  ['mode', 'In situ / Ex situ'],
  ['priority', '优先级'],
  ['thickness', '厚度'],
  ['thicknessUnit', '厚度单位'],
  ['preparation', '制备 / 试剂名称'],
  ['notes', '备注'],
  ['legacyCompleted', '原表完成标记'],
  ['legacyTime', '原表实验时间'],
];
export function ImportDialog({ preview, onClose }: { preview: TablePreview; onClose: () => void }) {
  const { experimentId, replace, notify } = useWorkspace();
  const [mapping, setMapping] = useState(preview.mapping),
    [extras, setExtras] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    try {
      const snapshot = await unwrap(
        window.labrecord.importTable({
          experimentId,
          table: preview,
          mapping,
          keepOtherColumns: extras,
        }),
      );
      replace(snapshot);
      notify(`已导入 ${preview.rows.length} 行规划记录；请另外安排待测样品。`);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="核对导入字段" wide onClose={onClose}>
      <p className="hint">
        {preview.name} · {preview.rows.length} 行 · {preview.headers.length} 列
      </p>
      <div className="import-mapping">
        {fields.map(([key, title]) => (
          <label className="field" key={key}>
            <span>{title}</span>
            <select
              aria-label={`映射 ${title}`}
              value={mapping[key] ?? ''}
              onChange={(event) =>
                setMapping((old) => {
                  const next = { ...old };
                  if (event.target.value === '') delete next[key];
                  else next[key] = Number(event.target.value);
                  return next;
                })
              }
            >
              <option value="">不导入此字段</option>
              {preview.headers.map((header, index) => (
                <option key={index} value={index}>
                  {header}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={extras}
          onChange={(event) => setExtras(event.target.checked)}
        />
        其余列作为自定义文本字段保留
      </label>
      <div className="import-preview table-wrap">
        <table>
          <thead>
            <tr>
              {preview.headers.map((h, index) => (
                <th key={index}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.slice(0, 5).map((row, index) => (
              <tr key={index}>
                {preview.headers.map((_, column) => (
                  <td key={column}>{row[column] || <span className="muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="callout">
        {preview.warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-actions">
        <button className="button" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || (mapping.state === undefined && mapping.name === undefined)}
          onClick={submit}
        >
          {busy ? '导入中…' : '确认导入规划'}
        </button>
      </footer>
    </Modal>
  );
}
