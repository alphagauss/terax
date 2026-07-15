import type { MarkdownDocumentHeading } from "@/modules/markdown/lib/document";

export type MarkdownOutlineItem = MarkdownDocumentHeading;

export function findActiveOutlineId(
  items: readonly MarkdownOutlineItem[],
  sourceLine: number,
): string | null {
  let active: string | null = null;
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = items[middle];
    if (item.sourceLine <= sourceLine) {
      active = item.id;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}
