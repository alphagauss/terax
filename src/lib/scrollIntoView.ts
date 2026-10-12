/** 将目标行滚入指定列表视口，预留吸顶标题遮挡，避免原生 scrollIntoView 连带滚动侧栏祖先。 */
export function scrollListRowIntoView(
  container: HTMLElement | null,
  rowId: string,
  topInset = 0,
) {
  if (!container || container.clientHeight <= 0) return;
  const row = container.querySelector<HTMLElement>(`#${CSS.escape(rowId)}`);
  if (!row) return;
  const viewport = container.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  const top = viewport.top + container.clientTop;
  const bottom = top + container.clientHeight;
  if (bounds.top < top + topInset)
    container.scrollTop += bounds.top - top - topInset;
  else if (bounds.bottom > bottom)
    container.scrollTop += bounds.bottom - bottom;
}
