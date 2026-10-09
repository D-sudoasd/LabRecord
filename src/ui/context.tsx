import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { Snapshot, Command, CommandResult, Reply, DesktopApi } from '../shared/model';
declare global {
  interface Window {
    labrecord: DesktopApi;
  }
}
export class DesktopReplyError extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}
export async function unwrap<T>(promise: Promise<Reply<T>>): Promise<T> {
  const reply = await promise;
  if (!reply.ok) throw new DesktopReplyError(reply.error, reply.rejected === true);
  return reply.data;
}
const EMPTY: Snapshot = {
  schemaVersion: 1,
  experiments: [],
  groups: [],
  samples: [],
  items: [],
  runs: [],
  events: [],
  attachments: [],
};
export interface EventTarget {
  itemId: string;
  experimentId: string;
  runId?: string;
}
export interface EventDraft {
  target: EventTarget;
  text: string;
  category: string;
  template: string;
  intent?: { command: Extract<Command, { type: 'addEvent' }>; requestId: string };
}
interface Workspace {
  snapshot: Snapshot;
  getSnapshot: () => Snapshot;
  experimentId: string;
  setExperimentId: (id: string) => void;
  itemId: string;
  setItemId: (id: string) => void;
  page: 'plan' | 'live' | 'review';
  setPage: (page: 'plan' | 'live' | 'review') => void;
  execute: (command: Command, follow?: boolean, requestId?: string) => Promise<CommandResult>;
  replace: (snapshot: Snapshot) => void;
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  alert: { message: string; error: boolean } | null;
  dismissAlert: () => void;
  busy: number;
  dirtyCount: number;
  failedCount: number;
  registerDraft: (key: string, save: () => Promise<void>, failed?: boolean) => void;
  clearDraft: (key: string) => void;
  flush: () => Promise<void>;
  // Unsubmitted dialog text stays in this window only; it is never a save callback.
  eventDrafts: Map<string, EventDraft>;
  loading: boolean;
}
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(EMPTY),
    [experimentId, setExperiment] = useState(''),
    [itemId, setItemId] = useState('');
  const [page, setPage] = useState<Workspace['page']>('plan'),
    [busy, setBusy] = useState(0),
    [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<Workspace['alert']>(null),
    [draftVersion, setDraftVersion] = useState(0);
  const [lastWriteFailed, setLastWriteFailed] = useState(false);
  const drafts = useRef(new Map<string, { save: () => Promise<void>; failed: boolean }>());
  const eventDrafts = useRef(new Map<string, EventDraft>());
  const savedSnapshot = useRef(EMPTY);
  const flushing = useRef<Promise<void> | null>(null);
  const currentExperiment = useRef('');
  const setExperimentId = useCallback((id: string) => {
    currentExperiment.current = id;
    setExperiment(id);
    setItemId('');
  }, []);
  const notify = useCallback((message: string, error = false) => setAlert({ message, error }), []);
  const replace = useCallback(
    (data: Snapshot) => {
      savedSnapshot.current = data;
      setSnapshot(data);
      if (!data.experiments.some((e) => e.id === currentExperiment.current)) {
        const running = data.items.find((i) => i.status === 'running');
        const id = running?.experimentId || data.experiments[0]?.id || '';
        setExperimentId(id);
        if (running) {
          setItemId(running.id);
          setPage('live');
        }
      }
    },
    [setExperimentId],
  );
  const execute = useCallback(
    async (command: Command, follow = true, requestId?: string) => {
      setBusy((n) => n + 1);
      try {
        const result = await unwrap(
          window.labrecord.command(command, requestId || crypto.randomUUID()),
        );
        setLastWriteFailed(false);
        setAlert((current) => (current?.error ? null : current));
        replace(result.snapshot);
        if (follow && result.experimentId) {
          currentExperiment.current = result.experimentId;
          setExperiment(result.experimentId);
        }
        if (follow && result.itemId) setItemId(result.itemId);
        return result;
      } catch (error) {
        setLastWriteFailed(true);
        notify(error instanceof Error ? error.message : String(error), true);
        throw error;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [replace, notify],
  );
  const refresh = useCallback(async () => {
    replace(await unwrap(window.labrecord.snapshot()));
    setLastWriteFailed(false);
  }, [replace]);
  const registerDraft = useCallback((key: string, save: () => Promise<void>, failed = false) => {
    drafts.current.set(key, { save, failed });
    setDraftVersion((n) => n + 1);
  }, []);
  const clearDraft = useCallback((key: string) => {
    if (drafts.current.delete(key)) setDraftVersion((n) => n + 1);
  }, []);
  const flush = useCallback(() => {
    if (flushing.current) return flushing.current;
    const operation = (async () => {
      while (drafts.current.size) {
        for (const [key, draft] of [...drafts.current.entries()]) {
          if (drafts.current.get(key) !== draft) continue;
          await draft.save();
          if (drafts.current.get(key) === draft)
            throw new Error('仍有未保存的输入，请重试保存后再继续。');
        }
      }
    })();
    flushing.current = operation;
    void operation
      .finally(() => {
        if (flushing.current === operation) flushing.current = null;
      })
      .catch(() => {});
    return operation;
  }, []);
  useEffect(() => {
    unwrap(window.labrecord.snapshot())
      .then(replace)
      .catch((error) => notify(error.message, true))
      .finally(() => setLoading(false));
    return window.labrecord.onClosing?.(flush);
  }, [replace, notify, flush]);
  useEffect(() => {
    if (!alert || alert.error) return;
    const timer = setTimeout(() => setAlert(null), 5000);
    return () => clearTimeout(timer);
  }, [alert]);
  const dirtyCount = drafts.current.size,
    failedCount =
      [...drafts.current.values()].filter((d) => d.failed).length + (lastWriteFailed ? 1 : 0);
  void draftVersion;
  return (
    <Context.Provider
      value={{
        snapshot,
        getSnapshot: () => savedSnapshot.current,
        experimentId,
        setExperimentId,
        itemId,
        setItemId,
        page,
        setPage,
        execute,
        replace,
        refresh,
        notify,
        alert,
        dismissAlert: () => setAlert(null),
        busy,
        dirtyCount,
        failedCount,
        registerDraft,
        clearDraft,
        flush,
        eventDrafts: eventDrafts.current,
        loading,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error('Workspace provider missing');
  return value;
}
