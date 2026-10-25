import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useWorkspace } from './context';
import { Modal } from './components';
import { LibraryBoard } from './LibraryBoard';
import { focusGroup, searchWorkspace } from './workspaceSearch';
import { boardActions } from '../shared/library';

const RESULT_BATCH_SIZE = 8;

export function WorkspaceSearchDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: () => void;
}) {
  const { snapshot, experimentId, flush, notify, setExperimentId, setItemId, setPage } =
    useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [visibleCount, setVisibleCount] = useState(RESULT_BATCH_SIZE);
  const browsing = !query.trim();
  const allHits = useMemo(
    () => searchWorkspace(snapshot, query, Number.POSITIVE_INFINITY),
    [snapshot, query],
  );
  const hits = allHits.slice(0, visibleCount);
  const actions = useMemo(() => boardActions(snapshot), [snapshot]);
  const rows = browsing ? actions : hits;
  const index = rows.length ? Math.min(active, rows.length - 1) : 0;

  useEffect(() => {
    input.current?.focus();
  }, []);

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

  function changeQuery(value: string) {
    setQuery(value);
    setActive(0);
    setVisibleCount(RESULT_BATCH_SIZE);
  }

  return (
    <Modal title="全库搜索" onClose={onClose} wide className="workbench-modal">
      <div className="workspace-search-controls">
        <label className="field" htmlFor="workspace-search">
          <span>样品、文件夹、制度、制备或实验</span>
        </label>
        <div className="search-input workspace-search-input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            id="workspace-search"
            role="combobox"
            aria-label="全库搜索"
            aria-autocomplete="list"
            aria-expanded={rows.length > 0}
            aria-controls="workspace-results"
            aria-describedby="workspace-search-hint workspace-result-count"
            aria-activedescendant={rows.length ? `workspace-hit-${index}` : undefined}
            placeholder="例如 S01、循环加载或实验编号"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
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
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="清除全库搜索"
              title="清除搜索，返回实验库"
              onClick={() => {
                changeQuery('');
                input.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="hint" id="workspace-search-hint">
          方向键选择，回车打开。查看不会开始操作。可搜索扫描编号、文件引用和尺寸，不搜索备注和自定义值。
        </p>
        <p className="workspace-result-count" id="workspace-result-count" role="status">
          {browsing
            ? `实验库 · ${snapshot.experiments.length} 个实验`
            : `显示 ${hits.length} / ${allHits.length} 项结果`}
        </p>
      </div>
      <div className="workspace-search-content">
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
            <LibraryBoard
              snapshot={snapshot}
              currentExperimentId={experimentId}
              active={index}
              onOpen={openRow}
              onHover={setActive}
            />
            <div className="library-create">
              <button type="button" className="button" onClick={createExperiment}>
                新建实验
              </button>
            </div>
          </>
        )}
        {!browsing && !hits.length && <p className="hint">没有匹配的样品或实验</p>}
        {!browsing && !!hits.length && (
          <div
            className="workspace-hits"
            role="listbox"
            id="workspace-results"
            aria-label="搜索结果"
          >
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
                  {hit.itemId
                    ? '查看现场'
                    : hit.kind === 'experiment'
                      ? '打开规划'
                      : '在规划中查看样品'}{' '}
                  · {hit.detail}
                </small>
              </button>
            ))}
          </div>
        )}
        {!browsing && hits.length < allHits.length && (
          <button
            type="button"
            className="button workspace-more-results"
            onClick={() => {
              setActive(hits.length);
              setVisibleCount((count) => count + RESULT_BATCH_SIZE);
              input.current?.focus();
            }}
          >
            显示更多结果
          </button>
        )}
      </div>
    </Modal>
  );
}
