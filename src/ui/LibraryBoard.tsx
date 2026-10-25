import type { Snapshot } from '../shared/model';
import {
  boardActions,
  knownQuantity,
  libraryBoard,
  nextOperationBrief,
  runningOperationSummary,
} from '../shared/library';

const MIX = [
  ['completed', '已完成', 'mix-completed'],
  ['running', '进行中', 'mix-running'],
  ['pending', '待测', 'mix-pending'],
  ['skipped', '已跳过', 'mix-skipped'],
  ['interrupted', '已中断', 'mix-interrupted'],
] as const;

export function OperationMix({
  completed,
  running,
  pending,
  skipped,
  interrupted,
}: {
  completed: number;
  running: number;
  pending: number;
  skipped: number;
  interrupted: number;
}) {
  const counts = { completed, running, pending, skipped, interrupted };
  const total = completed + running + pending + skipped + interrupted;
  if (!total) return <p className="hint">尚未安排操作</p>;
  const parts = MIX.filter(([key]) => counts[key] > 0);
  const label = parts.map(([key, text]) => `${text} ${counts[key]}`).join('，');
  return (
    <div className="operation-mix">
      <div className="mix" role="img" aria-label={label}>
        {parts.map(([key, , className]) => (
          <span key={key} className={className} style={{ flex: `${counts[key]} 1 0` }} />
        ))}
      </div>
      <p className="mix-legend">{label}</p>
    </div>
  );
}

function Quantity({
  label,
  known,
  unknown,
  groups,
}: {
  label: string;
  known: number;
  unknown: number;
  groups: number;
}) {
  const allUnknown = groups > 0 && unknown === groups;
  return (
    <span className="library-count">
      <span className="library-count-label">{label}</span>{' '}
      <b>{knownQuantity(known, unknown, groups)}</b>
      {!allUnknown && unknown > 0 && <small>，{unknown} 组未知</small>}
    </span>
  );
}

export function LibraryBoard({
  snapshot,
  currentExperimentId,
  active,
  onOpen,
  onHover,
}: {
  snapshot: Snapshot;
  currentExperimentId: string;
  active: number;
  onOpen: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const cards = libraryBoard(snapshot);
  const actions = boardActions(snapshot);
  const indexOf = (key: string) => actions.findIndex((action) => action.key === key);
  return (
    <div className="library-board" role="listbox" id="workspace-results" aria-label="实验库">
      {cards.map((card) => {
        const openIndex = indexOf(`open:${card.experimentId}`);
        const runningIndex = card.runningItem ? indexOf(`running:${card.runningItem.itemId}`) : -1;
        const nextIndex = card.next ? indexOf(`next:${card.next.itemId}`) : -1;
        const recentIndex = card.recent ? indexOf(`recent:${card.recent.itemId}`) : -1;
        const checkAction = actions.find(
          (action) => action.kind === 'check' && action.experimentId === card.experimentId,
        );
        const checkIndex = checkAction ? indexOf(checkAction.key) : -1;
        const brief = nextOperationBrief(snapshot, card.experimentId);
        const nextBrief = brief && card.next && brief.itemId === card.next.itemId ? brief : null;
        return (
          <article
            key={card.experimentId}
            className={`library-card${card.runningItem ? ' has-running' : ''}`}
          >
            <button
              type="button"
              id={`workspace-hit-${openIndex}`}
              role="option"
              aria-selected={active === openIndex}
              aria-labelledby={`library-title-${card.experimentId}`}
              aria-describedby={`library-detail-${card.experimentId}`}
              className={`card-open${active === openIndex ? ' is-active' : ''}`}
              onMouseEnter={() => onHover(openIndex)}
              onClick={() => onOpen(openIndex)}
            >
              <span className="library-title" id={`library-title-${card.experimentId}`}>
                <strong>{card.name}</strong>
                <small>{card.code}</small>
                {card.experimentId === currentExperimentId && (
                  <span className="library-current">当前实验</span>
                )}
                <small className="library-open-label">打开规划</small>
              </span>
              {card.description.trim() && (
                <small className="library-description">{card.description}</small>
              )}
              <OperationMix
                completed={card.completed}
                running={card.running}
                pending={card.pending}
                skipped={card.skipped}
                interrupted={card.interrupted}
              />
              <span className="library-counts" id={`library-detail-${card.experimentId}`}>
                <Quantity
                  label="准备"
                  known={card.preparedKnown}
                  unknown={card.unknownPreparation}
                  groups={card.groupCount}
                />
                <span className="library-count">
                  <span className="library-count-label">计划样品</span> <b>{card.plannedSamples}</b>
                </span>
                <span className="library-count">
                  <span className="library-count-label">计划操作</span>{' '}
                  <b>{card.plannedOperations}</b>
                </span>
                <Quantity
                  label="备样"
                  known={card.spareKnown}
                  unknown={card.unknownPreparation}
                  groups={card.groupCount}
                />
                {card.repeats > 0 && (
                  <span className="library-count">重测 {card.repeats} 项，样品不另计</span>
                )}
                {card.unresolvedIssues > 0 && (
                  <span className="library-count">未处理问题 {card.unresolvedIssues}</span>
                )}
                {card.missingTimes > 0 && (
                  <span className="library-count">
                    <span className="library-count-label">时间不完整</span>{' '}
                    <b>{card.missingTimes}</b>
                  </span>
                )}
                {card.missingFiles > 0 && (
                  <span className="library-count">
                    <span className="library-count-label">文件未关联</span>{' '}
                    <b>{card.missingFiles}</b>
                  </span>
                )}
                {card.recordedLabel && (
                  <span className="library-count">已记录 {card.recordedLabel}</span>
                )}
                {card.incompleteCount > 0 && (
                  <span className="library-count">未计入 {card.incompleteCount} 次</span>
                )}
                {card.actualChanged > 0 && (
                  <span className="library-count">实际已改 {card.actualChanged}</span>
                )}
              </span>
            </button>
            {(runningIndex >= 0 || nextIndex >= 0 || recentIndex >= 0 || checkIndex >= 0) && (
              <div className="library-actions">
                {card.runningItem && runningIndex >= 0 && (
                  <button
                    type="button"
                    id={`workspace-hit-${runningIndex}`}
                    role="option"
                    aria-selected={active === runningIndex}
                    className={`button small library-next${active === runningIndex ? ' is-active' : ''}`}
                    aria-label={`返回进行中 ${card.runningItem.sampleCode}`}
                    onMouseEnter={() => onHover(runningIndex)}
                    onClick={() => onOpen(runningIndex)}
                  >
                    <span>返回进行中 {card.runningItem.sampleCode}</span>
                    {(runningOperationSummary(snapshot, card.experimentId) ||
                      card.runningItem.plannedName) && (
                      <small>
                        {[
                          runningOperationSummary(snapshot, card.experimentId),
                          card.runningItem.plannedName,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    )}
                  </button>
                )}
                {card.next && nextIndex >= 0 && (
                  <button
                    type="button"
                    id={`workspace-hit-${nextIndex}`}
                    role="option"
                    aria-selected={active === nextIndex}
                    className={`button small library-next${active === nextIndex ? ' is-active' : ''}`}
                    aria-label={`查看下一项 ${card.next.sampleCode}`}
                    onMouseEnter={() => onHover(nextIndex)}
                    onClick={() => onOpen(nextIndex)}
                  >
                    <span>查看下一项 {card.next.sampleCode}</span>
                    {nextBrief && (
                      <small title={nextBrief.protocol || undefined}>
                        {[
                          nextBrief.measurement,
                          nextBrief.preparation,
                          nextBrief.repeat,
                          nextBrief.sourceIssue,
                          nextBrief.folder,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    )}
                  </button>
                )}
                {card.recent && recentIndex >= 0 && (
                  <button
                    type="button"
                    id={`workspace-hit-${recentIndex}`}
                    role="option"
                    aria-selected={active === recentIndex}
                    className={`button small library-next${active === recentIndex ? ' is-active' : ''}`}
                    aria-label={`查看最近记录 ${card.recent.sampleCode}`}
                    onMouseEnter={() => onHover(recentIndex)}
                    onClick={() => onOpen(recentIndex)}
                  >
                    <span>查看最近记录 {card.recent.sampleCode}</span>
                    <small>
                      {[
                        card.recent.status === 'interrupted' ? '最近中断' : '最近完成',
                        card.recent.duration ? `用时 ${card.recent.duration}` : '',
                        card.recent.endedClock,
                        card.recent.scanId ? `扫描 ${card.recent.scanId}` : '',
                        card.recent.fileLabel,
                        card.recent.folder,
                        card.recent.openIssue,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </button>
                )}
                {checkAction && checkIndex >= 0 && (
                  <button
                    type="button"
                    id={`workspace-hit-${checkIndex}`}
                    role="option"
                    aria-selected={active === checkIndex}
                    className={`button small${active === checkIndex ? ' is-active' : ''}`}
                    aria-label={`去核对 ${checkAction.title}`}
                    onMouseEnter={() => onHover(checkIndex)}
                    onClick={() => onOpen(checkIndex)}
                  >
                    去核对 {checkAction.title}
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
