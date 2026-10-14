import { useState, type FormEvent } from 'react';
import { useWorkspace } from './context';
import { Modal } from './components';

export function EventTextDialog({
  eventId,
  kind,
  onClose,
}: {
  eventId: string;
  kind: 'issue' | 'note';
  onClose: () => void;
}) {
  const { snapshot, execute } = useWorkspace();
  const record = snapshot.events.find((entry) => entry.id === eventId && entry.type === kind);
  const [text, setText] = useState(record?.text || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const title = kind === 'issue' ? '修改问题' : '修改时间线记录';
  const label = kind === 'issue' ? '问题内容' : '记录内容';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!record || busy || !text.trim()) return;
    setBusy(true);
    try {
      await execute(
        kind === 'issue'
          ? { type: 'editIssue', eventId: record.id, text }
          : { type: 'editNote', eventId: record.id, text },
        false,
      );
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} closeDisabled={busy}>
      <form onSubmit={submit} className="form-stack">
        <p className="hint">
          {kind === 'issue'
            ? '只改正这条问题的文字。不改变记录时间和处理状态，也不改开始时的计划。'
            : '只改正这条时间线记录的文字。不改变记录时间，也不改现场备注或开始时的计划。'}
        </p>
        {!record && (
          <p className="error-text" role="alert">
            这条记录已不存在，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>{label}</span>
          <textarea
            aria-label={label}
            value={text}
            disabled={busy || !record}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy || !record || !text.trim()}>
            {kind === 'issue' ? '保存问题' : '保存记录'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function IssueEditDialog({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  return <EventTextDialog eventId={eventId} kind="issue" onClose={onClose} />;
}
