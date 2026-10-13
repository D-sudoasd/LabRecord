/** Move one id before or after another. Every other id keeps its relative order. */
export function placeId(
  ids: readonly string[],
  movingId: string,
  targetId: string,
  where: 'before' | 'after',
): string[] | null {
  if (!ids.includes(movingId) || !ids.includes(targetId)) return null;
  if (movingId === targetId) return [...ids];
  const next = ids.filter((id) => id !== movingId);
  let index = next.indexOf(targetId);
  if (where === 'after') index += 1;
  next.splice(index, 0, movingId);
  return next;
}

export function swapAdjacent(
  ids: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] | null {
  const index = ids.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= ids.length) return null;
  const copy = [...ids];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  return copy;
}
