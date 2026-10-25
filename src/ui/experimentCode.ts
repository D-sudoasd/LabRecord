function normalizedCodes(existingCodes: Iterable<string>) {
  return new Set(Array.from(existingCodes, (code) => code.toLowerCase()));
}

export function isExperimentCodeTaken(existingCodes: Iterable<string>, candidate: string) {
  const normalized = candidate.trim().toLowerCase();
  return normalized !== '' && normalizedCodes(existingCodes).has(normalized);
}

export function suggestExperimentCode(existingCodes: Iterable<string>, date: Date) {
  const base = `EXP-${date.toLocaleDateString('sv-SE').replaceAll('-', '')}`;
  const used = normalizedCodes(existingCodes);
  if (!used.has(base.toLowerCase())) return base;

  let suffix = 2;
  let candidate = `${base}-${String(suffix).padStart(2, '0')}`;
  while (used.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${base}-${String(suffix).padStart(2, '0')}`;
  }
  return candidate;
}
