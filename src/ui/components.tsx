import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X, Check, AlertCircle, ChevronDown, Search, Timer } from 'lucide-react';
import type { Field, Value, Values, Status } from '../shared/model';
import { STATUS_LABEL } from '../shared/model';
import { useWorkspace } from './context';

export function useModalDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return ref;
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  closeDisabled = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
  className?: string;
}) {
  const ref = useModalDialog(),
    id = useId();
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''} ${className}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <header className="modal-head">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭对话框"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
  className = '',
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={`search-input ${className}`}>
      <Search size={16} aria-hidden="true" />
      <input
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label={`清除${label}`}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function ElapsedTime({
  startedAt,
  endedAt,
  running,
}: {
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !startedAt || endedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt, endedAt]);
  // The display is derived from recorded timestamps, including across midnight and restarts.
  const seconds =
    startedAt && (endedAt || running)
      ? Math.max(
          0,
          Math.floor(((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000),
        )
      : null;
  const duration =
    seconds === null
      ? '—'
      : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
          .map((part) => String(part).padStart(2, '0'))
          .join(':');
  return (
    <div className={`elapsed-strip ${running ? 'is-running' : ''}`} aria-live="off">
      <Timer size={18} aria-hidden="true" />
      <span>本次用时</span>
      <output aria-label="本次操作用时" aria-live="off">
        {duration}
      </output>
      <small>
        {running ? '正在计时' : endedAt ? '已结束' : startedAt ? '时间待补全' : '开始后自动计时'}
      </small>
    </div>
  );
}
export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status-pill ${status}`}>
      {status === 'completed' && <Check size={12} />}
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}
export function PriorityPill({ value }: { value: string }) {
  return <span className={`priority ${value.toLowerCase()}`}>{value}</span>;
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">↗</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function timeText(time: string | null, full = false) {
  if (!time) return '尚未记录';
  return new Date(time).toLocaleString('zh-CN', {
    ...(full ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
export function localInput(time: string | null) {
  if (!time) return '';
  const date = new Date(time);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export function AutoInput({
  value,
  onSave,
  label,
  multiline = false,
  type = 'text',
  placeholder,
  className = '',
  inputMode,
  options,
}: {
  value: string;
  onSave: (value: string) => Promise<unknown>;
  label: string;
  multiline?: boolean;
  type?: string;
  placeholder?: string;
  className?: string;
  inputMode?: 'decimal' | 'numeric';
  options?: { value: string; label: string }[];
}) {
  const workspace = useWorkspace();
  const [draft, setDraft] = useState(value),
    [error, setError] = useState('');
  const refs = useRef({
    draft: value,
    dirty: false,
    save: onSave,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    promise: undefined as Promise<void> | undefined,
  });
  refs.current.save = onSave;
  const key = useId();
  const save = useRef<() => Promise<void>>(async () => {});
  save.current = async () => {
    const state = refs.current;
    if (state.timer) clearTimeout(state.timer);
    if (state.promise) {
      await state.promise;
      if (state.dirty) return save.current();
      return;
    }
    if (!state.dirty) return;
    const submitted = state.draft;
    const operation = (async () => {
      try {
        await state.save(submitted);
        setError('');
        if (state.draft === submitted) {
          state.dirty = false;
          workspace.clearDraft(key);
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        workspace.registerDraft(key, () => save.current(), true);
        throw failure;
      }
    })();
    state.promise = operation;
    try {
      await operation;
    } finally {
      state.promise = undefined;
    }
    if (state.dirty) await save.current();
  };
  useEffect(() => {
    if (!refs.current.dirty) {
      refs.current.draft = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(
    () => () => {
      if (refs.current.timer) clearTimeout(refs.current.timer);
      if (refs.current.dirty) void save.current().catch(() => {});
      else workspace.clearDraft(key);
    },
    [key, workspace.clearDraft],
  );
  function change(value: string) {
    setDraft(value);
    refs.current.draft = value;
    refs.current.dirty = true;
    setError('');
    workspace.registerDraft(key, () => save.current());
    if (refs.current.timer) clearTimeout(refs.current.timer);
    refs.current.timer = setTimeout(
      () => {
        void save.current().catch(() => {});
      },
      options ? 50 : 500,
    );
  }
  const props = {
    value: draft,
    'aria-label': label,
    placeholder,
    className: `${className} ${error ? 'input-error' : ''}`,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => change(event.target.value),
    onBlur: () => {
      void save.current().catch(() => {});
    },
  };
  return (
    <div className={`auto-input ${error ? 'has-error' : ''}`}>
      {options ? (
        <select {...props}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea {...props} rows={4} />
      ) : (
        <input {...props} type={type} inputMode={inputMode} />
      )}{' '}
      {error && (
        <span className="field-error" role="alert">
          <AlertCircle size={12} />
          {error}
          <button
            onClick={() => {
              void save.current().catch(() => {});
            }}
          >
            重试
          </button>
        </span>
      )}
    </div>
  );
}
export function FieldInputs({
  fields,
  values,
  save,
  compact = false,
  immediate = false,
}: {
  fields: Field[];
  values: Values;
  save: (patch: Values) => Promise<unknown>;
  compact?: boolean;
  immediate?: boolean;
}) {
  return (
    <div className={compact ? 'custom-fields compact' : 'custom-fields'}>
      {fields.map((field) => (
        <label className="field" key={field.id}>
          <span>
            {field.label}
            {field.unit && <small>{field.unit}</small>}
          </span>
          {field.type === 'select' ? (
            immediate ? (
              <select
                aria-label={field.label}
                value={String(values[field.id] ?? '')}
                onChange={(event) => {
                  void save({ [field.id]: event.target.value || null });
                }}
              >
                <option value="">未填写</option>
                {field.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : (
              <AutoInput
                label={field.label}
                value={String(values[field.id] ?? '')}
                onSave={(value) => save({ [field.id]: value || null })}
                options={[
                  { value: '', label: '未填写' },
                  ...field.options.map((value) => ({ value, label: value })),
                ]}
              />
            )
          ) : immediate ? (
            <input
              aria-label={field.label}
              type={field.type === 'number' ? 'number' : 'text'}
              value={String(values[field.id] ?? '')}
              onChange={(event) => {
                void save({
                  [field.id]:
                    field.type === 'number'
                      ? event.target.value.trim()
                        ? Number(event.target.value)
                        : null
                      : event.target.value,
                });
              }}
            />
          ) : (
            <AutoInput
              label={field.label}
              value={String(values[field.id] ?? '')}
              onSave={(value) =>
                save({
                  [field.id]:
                    field.type === 'number' ? (value.trim() ? Number(value) : null) : value,
                })
              }
              type={field.type === 'number' ? 'number' : 'text'}
              placeholder="未填写"
            />
          )}
        </label>
      ))}
    </div>
  );
}
export function SectionTitle({ children, detail }: { children: ReactNode; detail?: string }) {
  return (
    <div className="section-title">
      <h3>{children}</h3>
      {detail && <span>{detail}</span>}
    </div>
  );
}
export function Details({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="details" open={open}>
      <summary>
        {title}
        <ChevronDown size={15} />
      </summary>
      {children}
    </details>
  );
}
export function eventLabel(type: string) {
  return (
    (
      {
        start: '开始',
        finish: '完成',
        interrupt: '中断',
        correction: '时间修正',
        issue: '问题',
        note: '记录',
        edit: '备注',
        actual: '实际参数',
        attachment: '图片',
        plan: '计划',
        import: '导入',
      } as Record<string, string>
    )[type] || type
  );
}
