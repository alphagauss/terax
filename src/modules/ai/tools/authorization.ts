/**
 * 本文件为 AI 工具提供请求批准模式下的轻量风险分类。
 * 分类只决定是否展示审批，Rust 仍负责路径 canonical 校验和最终执行边界。
 */

import type { AgentPermissionMode } from "../lib/native";
import { resolvePath } from "./context";

const SENSITIVE_COMPONENTS = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".terraform.d",
  ".ssh",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  "_netrc",
  "authorized_keys",
  "credentials",
  "htpasswd",
  "known_hosts",
]);

const SYSTEM_ROOT_COMPONENTS = new Set([
  "etc",
  "proc",
  "sys",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
]);

const SENSITIVE_BASENAME_PREFIXES = [
  "credentials",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  "known_hosts",
  "authorized_keys",
  "htpasswd",
] as const;

const PROTECTED_SEQUENCES = [
  ["var", "db"],
  ["var", "root"],
  ["private", "etc"],
  ["private", "var", "db"],
  ["private", "var", "root"],
  ["library", "keychains"],
  ["library", "cookies"],
  ["appdata", "roaming", "microsoft", "credentials"],
  ["appdata", "local", "microsoft", "credentials"],
  ["appdata", "roaming", "gcloud"],
] as const;

/** 判断模型提供的路径是否需要一次性审批。 */
export function pathNeedsApproval(path: string, cwd: string): boolean {
  const normalized = normalizePath(resolvePath(path, cwd));
  const root = normalizePath(cwd);
  return !isWithin(normalized, root) || isSensitivePath(normalized);
}

type FileOperationApprovalInput = {
  operation: "move" | "copy" | "delete" | "create_directory";
  path: string;
  destination?: string;
  recursive?: boolean;
};

/** 判断结构化文件操作是否需要一次性审批。 */
export function fileOperationNeedsApproval(
  input: FileOperationApprovalInput,
  cwd: string,
): boolean {
  return (
    (input.operation === "delete" && input.recursive === true) ||
    ((input.operation === "delete" || input.operation === "move") &&
      pathsEqual(input.path, cwd)) ||
    pathNeedsApproval(input.path, cwd) ||
    (input.destination !== undefined &&
      pathNeedsApproval(input.destination, cwd))
  );
}

/**
 * 将本次工具调用映射为原生访问级别。
 * AI SDK 按请求级 `toolApproval` 策略，仅在无需审批或用户已批准后进入 execute，需要审批的
 * 调用到达这里时已经取得一次性授权。
 */
export function accessModeForCall(
  mode: AgentPermissionMode,
  needsApproval: boolean,
): AgentPermissionMode {
  return mode === "full-access" || needsApproval ? "full-access" : "ask";
}

/** 判断 Shell 调用是否可以在请求批准模式下自动执行。 */
export function shellNeedsApproval(
  command: string,
  requestedCwd: string | null | undefined,
  sessionCwd: string,
): boolean {
  if (isClearlyCatastrophic(command)) return false;
  if (
    /\brm\s+(?:-[a-z]*r[a-z]*|--recursive)\b|\brmdir\s+\/s\b|\bremove-item\b[^\r\n;|&]*\s-(?:recurse|force)\b|\bgit\s+(?:clean\s+(?:-[a-z]*f[a-z]*|--force)|reset\s+--hard)\b/i.test(
      command,
    )
  ) {
    return true;
  }
  if (requestedCwd && pathNeedsApproval(requestedCwd, sessionCwd)) return true;
  if (/\.\.[\\/]/.test(command)) return true;
  if (
    /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|Test-NetConnection|ssh|scp|sftp|ftp|telnet|nc|ncat|netcat|ping|traceroute|tracert|nslookup|dig|gh|glab)\b/i.test(
      command,
    )
  ) {
    return true;
  }
  if (
    /\bgit\s+(?:clone|fetch|pull|push|ls-remote|submodule\s+(?:update|sync))\b/i.test(
      command,
    )
  )
    return true;
  if (/\b(?:npx|bunx|uvx)\b|\b(?:pnpm|yarn)\s+dlx\b/i.test(command))
    return true;
  if (
    /\b(?:pnpm|npm|yarn|bun|pip3?|uv|cargo|go)\s+(?:add|install|update|fetch|get|download)\b/i.test(
      command,
    )
  ) {
    return true;
  }
  if (/https?:\/\/|file:\/\//i.test(command)) return true;
  if (/(?:^|\s)~(?:[^\s'";|&<>]*)/.test(command)) return true;
  if (
    /(?:^|[\\/\s'";|&<>])(?:\.aws|\.azure|\.docker|\.git|\.gnupg|\.kube|\.ssh|\.terraform\.d|\.config[\\/](?:gh|git|gcloud|op))(?=$|[\\/\s'";|&<>])/i.test(
      command,
    ) ||
    /(?:^|[\\/\s'";|&<>])(?:\.env(?:\.[^\s'";|&<>]+)?|\.netrc|_netrc|\.npmrc|\.pgpass|\.pypirc|authorized_keys|known_hosts|credentials|htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-][^\s'";|&<>]+)?|(?:secret|service-account|service_account)[^\s'";|&<>]*\.(?:json|ya?ml|toml|env)|[^\s'";|&<>]+\.(?:pem|key|p12|pfx|asc|gpg|keystore|jks))(?=$|[\s'";|&<>])/i.test(
      command,
    )
  ) {
    return true;
  }
  if (
    /\b(?:eval|sh|bash|zsh|cmd|powershell|pwsh|python|node)\s+(?:-[a-z]*c|\/c|-[a-z]*e)/i.test(
      command,
    )
  ) {
    return true;
  }
  if (/`|\$\(|\$\{|\$(?:env:)?[a-z_][\w]*|%[a-z_][\w]*%/i.test(command)) {
    return true;
  }
  return extractAbsolutePaths(command).some((path) =>
    pathNeedsApproval(path, sessionCwd),
  );
}

function isClearlyCatastrophic(command: string): boolean {
  const compact = command.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\brm\b(?=[^\r\n;|&]*\s(?:-[a-z]*r[a-z]*|--recursive)\b)[^\r\n;|&]*\s(?:--\s+)?['"]?(?:\/|\/\*|\/\.\*|~|~\/|\$home|\$\{home\})(?:['"]|\s|$)/i.test(
      compact,
    ) ||
    /--no-preserve-root|\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b|diskutil erase/i.test(
      compact,
    ) ||
    /\bdd\b[^|;&]*\bof=\/?dev\/(?:disk|sd|nvme|hd)/i.test(compact) ||
    /(?:^|[\r\n;|&])\s*(?:(?:sudo|doas)\s+)?(?:["']?[^\s"';|&]*[\\/])?(?:diskpart|shutdown(?:\.exe)?|reboot|poweroff|halt|stop-computer|restart-computer)\b/i.test(
      compact,
    ) ||
    /\b(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-(?:c|command)|pwsh\s+-(?:c|command)|(?:ba|z|k|d|fi|c)?sh\s+-c)\s+["']?(?:diskpart|shutdown(?:\.exe)?|reboot|poweroff|halt|stop-computer|restart-computer)\b/i.test(
      compact,
    ) ||
    /\b(?:remove-item|rmdir|rd|rm)\b(?=[^\r\n;|&]*(?:-recurse|-r\b|\/s\b))(?=[^\r\n;|&]*(?:[a-z]:[\\/](?:\*|\.\*)?|\\\\[^\\\s]+\\[^\\\s]+[\\/]?)(?:\s|$))/i.test(
      compact,
    ) ||
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(compact)
  );
}

function pathsEqual(path: string, cwd: string): boolean {
  const candidate = normalizePath(resolvePath(path, cwd));
  const root = normalizePath(cwd);
  const windows = isWindowsPath(root);
  return windows
    ? candidate.toLowerCase() === root.toLowerCase()
    : candidate === root;
}

function normalizePath(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const prefix = slash.startsWith("//")
    ? "//"
    : (slash.match(/^[A-Za-z]:/)?.[0].toLowerCase() ??
      (slash.startsWith("/") ? "/" : ""));
  const body =
    prefix === "/"
      ? slash.slice(1)
      : slash.slice(prefix.length).replace(/^\//, "");
  const components: string[] = [];
  for (const component of body.split("/")) {
    if (!component || component === ".") continue;
    if (component === "..") components.pop();
    else components.push(component);
  }
  const joined = components.join("/");
  return prefix === "/"
    ? `/${joined}`
    : prefix === "//"
      ? `//${joined}`
      : `${prefix}${joined ? `/${joined}` : "/"}`;
}

function isWithin(path: string, root: string): boolean {
  const windows = isWindowsPath(root);
  const candidate = windows ? path.toLowerCase() : path;
  const boundary = windows ? root.toLowerCase() : root;
  return (
    candidate === boundary ||
    candidate.startsWith(`${boundary.replace(/\/$/, "")}/`)
  );
}

function isWindowsPath(path: string): boolean {
  return /^[a-z]:\//i.test(path) || path.startsWith("//");
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const components = lower.split("/").filter(Boolean);
  const rootIndex = /^[a-z]:\//.test(lower) ? 1 : 0;
  if (SYSTEM_ROOT_COMPONENTS.has(components[rootIndex] ?? "")) return true;
  if (components.some((component) => SENSITIVE_COMPONENTS.has(component)))
    return true;
  if (
    components.some(
      (component, index) =>
        component === ".config" &&
        ["gh", "git", "gcloud", "op"].includes(components[index + 1] ?? ""),
    ) ||
    PROTECTED_SEQUENCES.some((sequence) =>
      components.some((_, index) =>
        sequence.every(
          (component, offset) => components[index + offset] === component,
        ),
      ),
    )
  ) {
    return true;
  }
  const basename = components[components.length - 1] ?? "";
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    SENSITIVE_BASENAME_PREFIXES.some(
      (prefix) => basename === prefix || basename.startsWith(`${prefix}.`),
    ) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[._-])/.test(basename) ||
    /\.(?:pem|key|p12|pfx|asc|gpg|keystore|jks|kdbx)(?:\.|$)/.test(basename) ||
    /^(?:secret|service-account|service_account).*\.(?:json|ya?ml|toml|env)(?:\.|$)/.test(
      basename,
    )
  );
}

function extractAbsolutePaths(command: string): string[] {
  return (
    command.match(/(?:[A-Za-z]:[\\/][^\s'";|&<>]+|\/(?!\/)[^\s'";|&<>]+)/g) ??
    []
  );
}
