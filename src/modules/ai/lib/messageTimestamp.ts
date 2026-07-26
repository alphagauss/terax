/**
 * 本文件统一 AI 消息和会话列表的本地时间展示规则。
 * 仅根据已持久化的时间戳格式化，不推断相对时间，保证会话排序和展示可追溯到同一时间来源。
 */

/**
 * 根据与当前日期的关系生成消息时间格式。
 *
 * 今天仅显示时分，同年补充月日，更早的记录补充年份。调用方传入当前时间，便于保持渲染与测试稳定。
 */
export function messageTimestampFormatOptions(
  timestamp: number,
  now = new Date(),
): Intl.DateTimeFormatOptions {
  const date = new Date(timestamp);
  const time: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (isSameCalendarDate(date, now)) return time;
  if (date.getFullYear() === now.getFullYear()) {
    return { month: "numeric", day: "numeric", ...time };
  }
  return { year: "numeric", month: "numeric", day: "numeric", ...time };
}

/**
 * 将有效时间戳格式化为本地可读文本。
 *
 * 非法时间不会显示占位内容，避免损坏的历史记录干扰消息或会话列表。
 */
export function formatMessageTimestamp(
  timestamp: number,
  locale: string,
  now = new Date(),
): string {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(
    locale,
    messageTimestampFormatOptions(timestamp, now),
  ).format(new Date(timestamp));
}

/** 比较本地日历日期，不能用 24 小时差值处理跨夏令时的相邻日期。 */
function isSameCalendarDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
