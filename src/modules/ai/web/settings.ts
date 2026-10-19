/** 搜索与抓取分别选择服务；普通共享设置只保存选择，不保存凭据。 */
export const WEB_SERVICE_KEYS = {
  search: "web.searchProvider",
  fetch: "web.fetchProvider",
} as const;
export type WebProvider = "disabled" | "deepseek";
export function readWebProviders(
  values: Record<string, unknown>,
): Record<"search" | "fetch", WebProvider> {
  return {
    search:
      values[WEB_SERVICE_KEYS.search] === "deepseek" ? "deepseek" : "disabled",
    fetch:
      values[WEB_SERVICE_KEYS.fetch] === "deepseek" ? "deepseek" : "disabled",
  };
}
