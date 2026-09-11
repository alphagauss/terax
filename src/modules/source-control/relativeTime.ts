/** 返回与提交图一致的紧凑相对时间。 */
export function relativeTime(timestampSecs: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestampSecs);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d`;
  if (delta < 86400 * 365) return `${Math.floor(delta / (86400 * 30))}mo`;
  return `${Math.floor(delta / (86400 * 365))}y`;
}
