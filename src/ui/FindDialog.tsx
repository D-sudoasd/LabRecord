import { useEffect, useState } from 'react';
import { useWorkspace } from './context';
import { Modal } from './components';
import { LibraryBoard } from './LibraryBoard';
import { focusGroup, searchWorkspace } from './workspaceSearch';
import { boardActions } from '../shared/library';

export function WorkspaceSearchDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: () => void;
}) {
  const { snapshot, flush, notify, setExperimentId, setItemId, setPage } = useWorkspace();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const browsing = !query.trim();
  const hits = searchWorkspace(snapshot, query);
  const actions = boardActions(snapshot);
  const rows = browsing ? actions : hits;
  const index = rows.length ? Math.min(active, rows.length - 1) : 0;

  useEffect(() => {
    document.getElementById(`workspace-hit-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, browsing, rows.length]);

  function fail(error: unknown) {
    notify(error instanceof Error ? error.message : '请先保存当前输入。', true);
  }

  function openAction(actionIndex: number) {
    const action = actions[actionIndex];
    if (!action) return;
    void flush()
      .then(() => {
        setExperimentId(action.experimentId);
        if (action.itemId) setItemId(action.itemId);
        setPage(action.itemId ? 'live' : 'plan');
        onClose();
      })
      .catch(fail);
  }

  function openHit(hitIndex: number) {
    const hit = hits[hitIndex];
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
      .catch(fail);
  }

  function openRow(rowIndex: number) {
    if (browsing) openAction(rowIndex);
    else openHit(rowIndex);
  }

  function createExperiment() {
    void flush().then(onCreate).catch(fail);
  }

  return (
    <Modal title="全库搜索" onClose={onClose} wide className="workbench-modal">
      <label className="field">
        <span>样品、文件夹、制度、制备或实验</span>
        <input
          id="workspace-search"
          autoFocus
          role="combobox"
          aria-label="全库搜索"
          aria-autocomplete="list"
          aria-controls="workspace-results"
          aria-activedescendant={rows.length ? `workspace-hit-${index}` : undefined}
          placeholder="例如 S01、循环加载或实验编号"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' && rows.length) {
              event.preventDefault();
              setActive((current) => (Math.min(current, rows.length - 1) + 1) % rows.length);
            } else if (event.key === 'ArrowUp' && rows.length) {
              event.preventDefault();
              setActive(
                (current) => (Math.min(current, rows.length - 1) - 1 + rows.length) % rows.length,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              openRow(index);
            }
          }}
        />
      </label>
      <p className="hint">
        未输入时列出全部实验。方向键选择，回车打开。可搜索扫描编号、文件引用和尺寸，不搜索备注和自定义值。
      </p>
      {browsing && !actions.length && (
        <div className="library-empty">
          <p>还没有实验。先建立实验，再安排样品。</p>
          <button type="button" className="button primary" onClick={createExperiment}>
            新建实验
          </button>
        </div>
      )}
      {browsing && !!actions.length && (
        <>
          <LibraryBoard snapshot={snapshot} active={index} onOpen={openRow} onHover={setActive} />
          <div className="library-create">
            <button type="button" className="button" onClick={createExperiment}>
              新建实验
            </button>
          </div>
        </>
      )}
      {!browsing && !hits.length && <p className="hint">没有匹配的样品或实验</p>}
      {!browsing && !!hits.length && (
        <div className="workspace-hits" role="listbox" id="workspace-results" aria-label="搜索结果">
          {hits.map((hit, hitIndex) => (
            <button
              key={hit.key}
              id={`workspace-hit-${hitIndex}`}
              type="button"
              role="option"
              aria-selected={index === hitIndex}
              className={index === hitIndex ? 'is-active' : ''}
              onMouseEnter={() => setActive(hitIndex)}
              onClick={() => openHit(hitIndex)}
            >
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
