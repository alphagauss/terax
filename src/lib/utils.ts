import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function normalizePathForIdentity(
  path: string,
  ignoreCase = false,
): string {
  const slashed = path.replace(/\\/g, "/");
  const normalized = slashed.startsWith("//")
    ? `//${slashed
        .slice(2)
        .replace(/^\/+/, "")
        .replace(/\/{2,}/g, "/")}`
    : slashed.replace(/\/{2,}/g, "/");
  const driveNormalized = normalized.replace(
    /^([A-Z]):/,
    (_, drive: string) => `${drive.toLowerCase()}:`,
  );
  return ignoreCase ? driveNormalized.toLowerCase() : driveNormalized;
}

export function titleFromUrl(url: string, fallback = ""): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || fallback;
  }
}
