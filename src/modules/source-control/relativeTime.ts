/** 返回与提交图一致的紧凑相对时间；时间线可按界面语言显示本地化单位。 */
export function relativeTime(timestampSecs: number, language?: string): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - timestampSecs);
  const [value, unit, suffix]: [number, Intl.RelativeTimeFormatUnit, string] =
    delta < 60
      ? [0, "second", ""]
      : delta < 3600
        ? [Math.floor(delta / 60), "minute", "m"]
        : delta < 86400
          ? [Math.floor(delta / 3600), "hour", "h"]
          : delta < 86400 * 30
            ? [Math.floor(delta / 86400), "day", "d"]
            : delta < 86400 * 365
              ? [Math.floor(delta / (86400 * 30)), "month", "mo"]
              : [Math.floor(delta / (86400 * 365)), "year", "y"];
  if (language) {
    return new Intl.RelativeTimeFormat(language, {
      style: "narrow",
      numeric: "auto",
    }).format(-value, unit);
  }
  return value === 0 ? "now" : `${value}${suffix}`;
}
