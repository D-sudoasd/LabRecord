const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f{}]/;
const INVALID_PROTOCOL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function canCopyName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !INVALID_NAME.test(name);
}

/** Heating protocols may contain slashes, degrees and line breaks. Names stay on canCopyName. */
export function canCopyProtocol(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && text.length <= 4000 && !INVALID_PROTOCOL.test(text);
}

export function protocolCopyText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Saved actual file name. File references and blank names stay out. */
export function actualFilenameLabel(run: { actual?: { filename?: unknown } } | null | undefined) {
  const name = String(run?.actual?.filename || '').trim();
  return name ? `文件 ${name}` : '';
}

/** Saved scan id. Blank ids stay out. */
export function actualScanLabel(run: { actual?: { scanId?: unknown } } | null | undefined) {
  const name = String(run?.actual?.scanId || '').trim();
  return name ? `扫描 ${name}` : '';
}
