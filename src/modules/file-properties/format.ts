/**
 * 本文件提供文件属性页的纯格式化函数。
 * 字节单位使用 1024 进制，POSIX 权限同时保留特殊执行位语义。
 */

const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB", "EB"];

/** 使用当前语言格式化字节数和紧凑单位。 */
export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }
  let value = bytes;
  let index = -1;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)} ${BYTE_UNITS[index]}`;
}

/** 将 POSIX mode 显示为八进制和包含 setuid、setgid、sticky 位的 rwx 形式。 */
export function formatPosixMode(mode: number): string {
  const execute = (
    executeBit: number,
    specialBit: number,
    enabled: string,
    disabled: string,
  ) => {
    if (mode & specialBit) return mode & executeBit ? enabled : disabled;
    return mode & executeBit ? "x" : "-";
  };
  const symbolic = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    execute(0o100, 0o4000, "s", "S"),
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    execute(0o010, 0o2000, "s", "S"),
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    execute(0o001, 0o1000, "t", "T"),
  ].join("");
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")} (${symbolic})`;
}
