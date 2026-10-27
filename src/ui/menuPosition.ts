export function menuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  let left = x + width + 8 > viewportWidth ? x - width - 1 : x;
  let top = y + height + 8 > viewportHeight ? y - height - 1 : y;
  left = Math.min(Math.max(8, left), Math.max(8, viewportWidth - width - 8));
  top = Math.min(Math.max(8, top), Math.max(8, viewportHeight - height - 8));
  return { left, top };
}

export function menuContainsPoint(
  position: { left: number; top: number },
  width: number,
  height: number,
  x: number,
  y: number,
) {
  return x > position.left && x < position.left + width && y > position.top && y < position.top + height;
}
