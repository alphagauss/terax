/** 归一化并校验 Alpha 内部的 `代码.交易所` 标的格式。 */
export function normalizeAlphaVtSymbol(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[^.\s]+\.[^.\s]+$/.test(normalized) ? normalized : null;
}
