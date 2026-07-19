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

export function normalizePathForIdentity(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.replace(
    /^([A-Z]):/,
    (_, drive: string) => `${drive.toLowerCase()}:`,
  );
}

export function titleFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "Web Preview";
  }
}
