const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function readMotionDurationMs(
  customProperty: `--${string}`,
  fallbackMs: number,
): number {
  if (prefersReducedMotion()) return 0;
  if (typeof window === "undefined") return fallbackMs;

  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(customProperty)
    .trim();
  const match = /^([0-9]*\.?[0-9]+)(ms|s)$/.exec(raw);
  if (!match) return fallbackMs;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return fallbackMs;
  return match[2] === "s" ? value * 1000 : value;
}

function readMotionEasing(
  customProperty: `--${string}`,
  fallback: string,
): string {
  if (typeof window === "undefined") return fallback;
  return (
    window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(customProperty)
      .trim() || fallback
  );
}

export { prefersReducedMotion, readMotionDurationMs, readMotionEasing };
