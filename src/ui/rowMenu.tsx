import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Command, Experiment, Group, PlanItem, Sample, Snapshot } from '../shared/model';
import { sampleName } from '../shared/model';
import { useWorkspace } from './context';
import { Modal } from './components';

export type MenuEntry =
  | { kind: 'separator' }
  | {
      kind: 'item';
      label: string;
      disabled?: boolean;
      danger?: boolean;
      title?: string;
      onSelect: () => void;
    };

export type DeleteRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  done: string;
  command: Command;
};

export type PendingDelete = DeleteRequest & { onDone?: () => void };

const blockedInput = new Set([
  'checkbox',
  'radio',
  'file',
  'button',
  'submit',
  'reset',
  'hidden',
  'range',
  'color',
]);

function editableField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return null;
  const field = target.closest('input, textarea');
  if (field instanceof HTMLTextAreaElement) return field;
  if (!(field instanceof HTMLInputElement) || blockedInput.has(field.type)) return null;
  return field;
}

function textEditEntries(field: HTMLInputElement | HTMLTextAreaElement): MenuEntry[] {
  const changeable = !field.readOnly && !field.disabled;
  const run = (name: 'cut' | 'copy' | 'paste' | 'selectAll') => () => {
    field.focus();
    document.execCommand(name);
  };
  return [
    { kind: 'item', label: '剪切文字', disabled: !changeable, onSelect: run('cut') },
    { kind: 'item', label: '复制文字', onSelect: run('copy') },
    { kind: 'item', label: '粘贴文字', disabled: !changeable, onSelect: run('paste') },
    { kind: 'item', label: '全选', onSelect: run('selectAll') },
    { kind: 'separator' },
  ];
}

function listed(names: string[], unit: string) {
  if (names.length <= 3) return names.join('、');
  return `${names.slice(0, 3).join('、')} 等 ${names.length} ${unit}`;
}

export function groupsDeleteReason(snapshot: Snapshot, ids: string[]) {
  const blocked = ids.some((id) => {
    const group = snapshot.groups.find((entry) => entry.id === id);
    if (!group) return true;
    const sampleIds = new Set(
      snapshot.samples.filter((sample) => sample.groupId === group.id).map((sample) => sample.id),
    );
    return snapshot.runs.some((run) => sampleIds.has(run.sampleId));
  });
  if (!blocked) return null;
  return ids.length > 1
    ? '所选样品组里已有实际记录，不能一起删除。'
    : '这一组已有实际记录，不能整组删除。';
}

export function groupDeleteRequest(groups: Group[]): DeleteRequest {
  const one = groups.length === 1;
  const names = groups.map((group) => sampleName(group));
  return {
    title: one ? '删除样品组' : '删除所选样品组',
    body: one
      ? `删除「${names[0]}」。这一组里还没开始的样品和测量会一起去掉，准备数量也不保留。已经开始的记录不能删除。`
      : `删除 ${listed(names, '组')}。这些组里还没开始的样品和测量会一起去掉。只要其中已有实际记录，这次删除就不会进行。`,
    confirmLabel: one ? '删除样品组' : '删除所选样品组',
    done: one ? '样品组已删除。' : '所选样品组已删除。',
    command: { type: 'deleteGroups', ids: groups.map((group) => group.id) },
  };
}

export function sampleDeleteReason(snapshot: Snapshot, sample: Sample) {
  return snapshot.runs.some((run) => run.sampleId === sample.id)
    ? '这件样品已有实际记录，不能移出计划。'
    : null;
}

export function sampleDeleteRequest(sample: Sample): DeleteRequest {
  return {
    title: '移出计划',
    body: `把 ${sample.code} 移出计划。它还没开始的测量会去掉，样品组的准备数量不变，这件回到备样。已经有实际记录的样品不能移出。`,
    confirmLabel: '移出计划',
    done: '样品已移出计划。',
    command: { type: 'deleteSamples', ids: [sample.id] },
  };
}

export function itemsDeleteReason(snapshot: Snapshot, ids: string[]) {
  const items = ids.map((id) => snapshot.items.find((item) => item.id === id));
  if (items.some((item) => !item)) return '测量计划已变化，请重新选择。';
  if (items.some((item) => item!.status === 'running'))
    return '进行中的测量不能删除。请先完成或中断。';
  if (
    items.some(
      (item) =>
        snapshot.runs.some((run) => run.itemId === item!.id) ||
        !['pending', 'skipped'].includes(item!.status),
    )
  )
    return '已经开始的测量保留记录，不能删除。';
  return null;
}

export function itemsDeleteRequest(snapshot: Snapshot, ids: string[]): DeleteRequest {
  const items = ids
    .map((id) => snapshot.items.find((item) => item.id === id))
    .filter((item): item is PlanItem => !!item);
  const codes = [
    ...new Set(
      items.map(
        (item) => snapshot.samples.find((sample) => sample.id === item.sampleId)?.code || '样品',
      ),
    ),
  ];
  const one = ids.length === 1;
  return {
    title: '删除测量',
    body: one
      ? `删除 ${codes[0] || '这项'} 还没开始的测量。如果这件样品没有其他测量，它会回到备样；准备数量不变。其余文件夹名保持原样。`
      : `删除 ${ids.length} 项还没开始的测量（${listed(codes, '件')}）。如果某件样品因此不再有测量，它会回到备样；准备数量不变。其余文件夹名保持原样。`,
    confirmLabel: '删除测量',
    done: '未开始的测量已删除。',
    command: { type: 'deleteItems', ids },
  };
}

export function experimentDeleteReason(snapshot: Snapshot, experimentId: string) {
  return snapshot.runs.some((run) => run.experimentId === experimentId)
    ? '本实验已有实际记录，不能删除。'
    : null;
}

export function experimentDeleteRequest(experiment: Experiment): DeleteRequest {
  return {
    title: '删除实验',
    body: `删除实验「${experiment.name}」（${experiment.code}）。其中的样品组和还没开始的测量会一起去掉。已经有实际记录的实验不能删除。`,
    confirmLabel: '删除实验',
    done: '实验已删除。',
    command: { type: 'deleteExperiment', id: experiment.id },
  };
}

function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = entries.filter(
    (entry): entry is Extract<MenuEntry, { kind: 'item' }> => entry.kind === 'item',
  );
  const [active, setActive] = useState(() => items.findIndex((item) => !item.disabled));
  const root = (document.querySelector('dialog[open]') as HTMLElement | null) ?? document.body;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - rect.height - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onScroll(event: Event) {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    }
    function move(delta: number) {
      if (!items.length) return;
      let index = active;
      for (let step = 0; step < items.length; step += 1) {
        index = (index + delta + items.length) % items.length;
        if (!items[index].disabled) {
          setActive(index);
          return;
        }
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'F8' || event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown') move(1);
      else if (event.key === 'ArrowUp') move(-1);
      else if (event.key === 'Home') {
        const index = items.findIndex((item) => !item.disabled);
        if (index >= 0) setActive(index);
      } else if (event.key === 'End') {
        let index = -1;
        items.forEach((item, position) => {
          if (!item.disabled) index = position;
        });
        if (index >= 0) setActive(index);
      } else if (event.key === 'Enter' || event.key === ' ') {
        const item = items[active];
        if (item && !item.disabled) {
          item.onSelect();
          onClose();
        }
      }
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointer, true);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, items, onClose]);
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="操作菜单"
      tabIndex={-1}
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) =>
        entry.kind === 'separator' ? (
          <hr key={`sep-${index}`} />
        ) : (
          <button
            key={`${entry.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            title={entry.title}
            className={entry.danger ? 'danger' : ''}
            data-active={items[active] === entry ? 'true' : undefined}
            tabIndex={-1}
            onMouseEnter={() => setActive(items.indexOf(entry))}
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>,
    root,
  );
}

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const open = useCallback((event: MouseEvent, entries: MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    const field = editableField(event.target);
    setState({
      x: event.clientX,
      y: event.clientY,
      entries: field ? [...textEditEntries(field), ...entries] : entries,
    });
  }, []);
  const close = useCallback(() => setState(null), []);
  const menu = state ? (
    <ContextMenu x={state.x} y={state.y} entries={state.entries} onClose={close} />
  ) : null;
  return { open, close, menu };
}

export function DeleteConfirm({
  pending,
  onClose,
}: {
  pending: PendingDelete | null;
  onClose: () => void;
}) {
  const { execute, flush, notify } = useWorkspace();
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  return (
    <Modal title={pending.title} onClose={onClose} closeDisabled={busy}>
      <p>{pending.body}</p>
      <footer className="modal-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            let sent = false;
            void flush()
              .then(() => {
                sent = true;
                return execute(pending.command, false);
              })
              .then(() => {
                notify(pending.done);
                pending.onDone?.();
                onClose();
              })
              .catch((error) => {
                if (!sent) notify(error instanceof Error ? error.message : String(error), true);
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? '正在删除…' : pending.confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}
