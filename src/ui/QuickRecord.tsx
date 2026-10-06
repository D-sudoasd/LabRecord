import { useState, useRef, useCallback } from 'react';
import { AlertCircle, Zap, RotateCcw } from 'lucide-react';
import type { Command, CommandResult } from '../shared/model';
import { useWorkspace } from './context';

export const QUICK_NOTE_TEMPLATES = [
  { label: '已装样', value: '已装样' },
  { label: '已调整位置', value: '已调整位置' },
  { label: '已更换样品', value: '已更换样品' },
  { label: '已调整参数', value: '已调整实验参数' },
  { label: '数据待检查', value: '本次数据待检查。' },
];

export const ISSUE_TEMPLATES = [
  { id: 'mount', label: '装样待检查', category: '装样问题', text: '装样位置或方向待检查。' },
  {
    id: 'equipment',
    label: '设备状态待检查',
    category: '设备异常',
    text: '设备状态异常，原因待检查。',
  },
  { id: 'signal', label: '信号待检查', category: '信号异常', text: '信号异常，原因待检查。' },
  {
    id: 'sample',
    label: '样品变化待检查',
    category: '样品变化',
    text: '观察到样品变化，具体情况待检查。',
  },
  {
    id: 'files',
    label: '数据文件待核对',
    category: '其他',
    text: '数据文件引用与操作编号待核对。',
  },
];
export type IssueTemplate = (typeof ISSUE_TEMPLATES)[number];

interface SavedIntent {
  command: Command;
  requestId: string;
  template: string;
}

export function QuickRecordBar({
  itemId,
  experimentId,
  runId,
}: {
  itemId: string;
  experimentId: string;
  runId?: string;
}) {
  const { execute, notify, registerDraft, clearDraft, flush } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [failedIntent, setFailedIntent] = useState<SavedIntent | null>(null);
  const draftKey = `quick-record-${itemId}`;
  const actionGate = useRef(0);
  const savePromiseRef = useRef<Promise<CommandResult> | null>(null);
  const intentRef = useRef<SavedIntent | null>(null);

  // 真实的持久化函数：执行已捕获的意图
  const persistIntent = useCallback(
    async (intent: SavedIntent): Promise<CommandResult> => {
      // 共享同一个 promise 如果正在保存中
      if (savePromiseRef.current) {
        return savePromiseRef.current;
      }

      setBusy(true);
      savePromiseRef.current = execute(intent.command, false, intent.requestId);
      try {
        const result = await savePromiseRef.current;
        // 成功：清除草稿和意图
        clearDraft(draftKey);
        intentRef.current = null;
        setFailedIntent(null);
        notify(`已记录：${intent.template}`);
        return result;
      } catch (error) {
        setFailedIntent(intent);
        registerDraft(
          draftKey,
          async () => {
            await persistIntent(intent);
          },
          true,
        );
        throw error;
      } finally {
        savePromiseRef.current = null;
        setBusy(false);
      }
    },
    [execute, clearDraft, draftKey, notify, registerDraft],
  );

  async function addQuickNote(template: string) {
    const now = performance.now();
    if (busy || !runId || (!intentRef.current && now < actionGate.current)) return;

    // 如果有失败意图且用户点击同一个模板则重试，否则创建新意图
    if (intentRef.current) {
      // 重试现有意图
      setBusy(true);
      try {
        await flush(); // 按原顺序重试：自由备注先，然后快记
      } catch (error) {
        notify((error as Error).message, true);
      } finally {
        setBusy(false);
      }
      return;
    }
    actionGate.current = now + 450;

    // 创建新意图
    const intent: SavedIntent = {
      command: {
        type: 'addEvent',
        experimentId,
        itemId,
        runId,
        eventType: 'note',
        text: template,
      },
      requestId: crypto.randomUUID(),
      template,
    };

    intentRef.current = intent;
    setFailedIntent(null);

    // 注册真实的保存函数，成功时 clearDraft，失败时 throw
    registerDraft(
      draftKey,
      async () => {
        await persistIntent(intent);
      },
      false,
    );

    setBusy(true);
    try {
      // 调用 flush：自由备注 draft 先在 Map 中，自动先保存
      await flush();
    } catch (error) {
      // 捕获失败：保留意图显示失败 UI
      setFailedIntent(intent);
      registerDraft(
        draftKey,
        async () => {
          await persistIntent(intent);
        },
        true,
      );
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  if (failedIntent) {
    return (
      <div className="quick-record-bar failed" role="alert">
        <div className="failure-message">
          <span>快记失败：{failedIntent.template}</span>
        </div>
        <button
          className="button small"
          onClick={() => {
            void addQuickNote(failedIntent.template);
          }}
          disabled={busy}
        >
          <RotateCcw size={14} />
          重试此记录
        </button>
      </div>
    );
  }

  return (
    <div className="quick-record-bar" role="group" aria-label="常用现场记录">
      {QUICK_NOTE_TEMPLATES.map((template) => (
        <button
          key={template.value}
          className="quick-record-button"
          disabled={busy || !runId}
          onClick={() => {
            void addQuickNote(template.value);
          }}
          title={template.label}
          aria-label={`快速记录：${template.label}`}
        >
          <Zap size={14} aria-hidden="true" />
          {template.label}
        </button>
      ))}
    </div>
  );
}

export function IssueTemplateDialog({
  onSelect,
  selected,
  disabled,
}: {
  onSelect: (template: IssueTemplate) => void;
  selected: string;
  disabled: boolean;
}) {
  return (
    <div className="issue-template-quick" role="group" aria-label="问题模板">
      <div className="template-grid">
        {ISSUE_TEMPLATES.map((template) => (
          <button
            type="button"
            key={template.id}
            className="template-card"
            aria-pressed={selected === template.id}
            disabled={disabled}
            onClick={() => onSelect(template)}
          >
            <AlertCircle size={16} aria-hidden="true" />
            <span>{template.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
