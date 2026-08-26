/**
 * 本文件实现 AI Shell 工具的审批前安全检查。
 * 文件路径安全已经统一下沉到 Rust Agent 文件后端，此处只提供 Shell 的快速反馈。
 */

export type SafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * 在审批前拒绝不可可靠审阅或明显会破坏主机的 Shell 命令。
 * Rust IPC 仍会独立执行同类校验，本函数不解析完整 Shell 语法。
 */
export function checkShellCommand(cmd: string): SafetyResult {
  const c = cmd.trim();
  if (c.length === 0) {
    return { ok: false, reason: "Refused: empty command." };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c)) {
    return {
      ok: false,
      reason: "Refused: command contains unsafe control characters.",
    };
  }
  if (/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(c)) {
    return {
      ok: false,
      reason:
        "Refused: command contains Unicode bidirectional override characters.",
    };
  }
  if (
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\s+(['"]?\/(?:\*|\.\*)?['"]?\s*($|;|&|\|))/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason:
        "Refused: command attempts to recursively delete the filesystem root.",
    };
  }
  if (
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(['"]?(~(\/[^\s'"]*)?|\$\{?HOME\}?(\/[^\s'"]*)?)['"]?)(\s|$|;|&|\|)/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason:
        "Refused: command attempts to recursively delete the home directory.",
    };
  }
  if (/--no-preserve-root/.test(c)) {
    return { ok: false, reason: "Refused: --no-preserve-root is not allowed." };
  }
  if (/\bdd\b[^|]*\bof=\/dev\/(disk|sd|nvme|hd)/i.test(c)) {
    return {
      ok: false,
      reason: "Refused: dd to a block device is not allowed.",
    };
  }
  if (
    /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/.test(c) ||
    /\bdiskutil\s+erase/i.test(c)
  ) {
    return {
      ok: false,
      reason: "Refused: disk-formatting commands are not allowed.",
    };
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(c)) {
    return { ok: false, reason: "Refused: fork-bomb pattern detected." };
  }
  if (/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|k|d|fi|c)?sh\b/.test(c)) {
    return {
      ok: false,
      reason:
        "Refused: piping a network download directly into a shell is blocked. Download first, inspect, then run.",
    };
  }
  return { ok: true };
}
