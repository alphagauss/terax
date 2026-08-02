/**
 * 本文件提供 Python 文件路径的轻量识别与显示名称处理。
 * 路径函数同时兼容前端规范路径和系统反斜杠路径。
 */

/** 判断路径是否指向扩展名大小写不敏感的 Python 源文件。 */
export function isPythonFile(path: string): boolean {
  return /\.py$/i.test(path);
}

/** 从正斜杠或反斜杠路径中提取文件名。 */
export function pythonFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 返回文件路径的父目录，并保留 POSIX 根目录与 Windows 盘符根目录。 */
export function pythonParentDirectory(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return null;
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:/.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}
