import { useState } from 'react';
import { useWorkspace } from './context';
import { Modal } from './components';
import { focusGroup, searchWorkspace } from './workspaceSearch';

export function WorkspaceSearchDialog({ onClose }: { onClose: () => void }) {
  const { snapshot, flush, notify, setExperimentId, setItemId, setPage } = useWorkspace();
  const [query, setQuery] = useState('');
  const hits = searchWorkspace(snapshot, query);
  function choose(index: number) {
    const hit = hits[index];
    if (!hit) return;
    void flush()
      .then(() => {
        if (hit.kind === 'item' && !hit.itemId) focusGroup(hit.groupId);
        setExperimentId(hit.experimentId);
        if (hit.itemId) setItemId(hit.itemId);
        setPage(hit.kind === 'experiment' || !hit.itemId ? 'plan' : 'live');
        if (hit.kind === 'item' && !hit.itemId) {
          window.setTimeout(() => window.dispatchEvent(new Event('labrecord-focus-group')), 0);
        }
        onClose();
      })
      .catch((error) =>
        notify(error instanceof Error ? error.message : '请先保存当前输入。', true),
      );
  }
  return (
    <Modal title="全库搜索" onClose={onClose}>
      <label className="field">
        <span>样品编号、样品名、文件夹名或实验</span>
        <input
          id="workspace-search"
          autoFocus
          aria-label="全库搜索"
          placeholder="例如 S01 或实验编号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              choose(0);
            }
          }}
        />
      </label>
      {query.trim() && !hits.length && <p className="hint">没有匹配的样品或实验</p>}
      {!!hits.length && (
        <div className="workspace-hits" role="listbox" aria-label="搜索结果">
          {hits.map((hit, index) => (
            <button key={hit.key} type="button" role="option" onClick={() => choose(index)}>
              <strong>{hit.title}</strong>
              <small>
                {hit.kind === 'experiment' ? '实验' : '打开现场'} · {hit.detail}
              </small>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
