/** 拖动预览仅复制证券标识，在页内浮层跟随指针，不复制行情图表或参与命中。 */
import type { WatchlistItem } from "@/modules/alpha/watchlist/api";

export function createWatchlistDragPreview(
  container: HTMLElement,
  item: WatchlistItem,
) {
  const document = container.ownerDocument;
  const preview = document.createElement("div");
  preview.className = "alpha-watchlist-drag-preview shadow-md";
  preview.setAttribute("aria-hidden", "true");
  preview.dataset.allowed = "false";
  const labels = document.createElement("div");
  labels.className = "min-w-0 flex-1";
  const name = document.createElement("div");
  name.className = "truncate text-xs font-medium";
  name.textContent = item.name;
  const symbol = document.createElement("div");
  symbol.className = "truncate font-mono text-[10px] text-muted-foreground";
  symbol.textContent = item.vt_symbol;
  const forbidden = document.createElement("span");
  forbidden.className = "alpha-watchlist-drag-forbidden";
  labels.append(name, symbol);
  preview.append(labels, forbidden);
  container.append(preview);
  // 尺寸在创建时读取一次，跟随期间只更新位移与可放置状态。
  const { width, height } = preview.getBoundingClientRect();
  return {
    move(clientX: number, clientY: number, allowed: boolean) {
      const bounds = container.getBoundingClientRect();
      const x = clientX - bounds.left;
      const y = clientY - bounds.top;
      const left = x + 12 + width > bounds.width ? x - width - 12 : x + 12;
      const top = y + 12 + height > bounds.height ? y - height - 12 : y + 12;
      preview.style.transform = `translate3d(${Math.max(0, Math.min(left, bounds.width - width))}px, ${Math.max(0, Math.min(top, bounds.height - height))}px, 0)`;
      preview.dataset.allowed = String(allowed);
    },
    remove() {
      preview.remove();
    },
  };
}
