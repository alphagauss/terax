export type FileFingerprint = { size: number; mtime: number };

export function fileFingerprintChanged(
  knownMtime: number | null,
  knownSize: number | null,
  current: FileFingerprint,
): boolean {
  if (knownMtime === null) return false;
  return (
    current.mtime !== knownMtime ||
    (knownSize !== null && current.size !== knownSize)
  );
}
