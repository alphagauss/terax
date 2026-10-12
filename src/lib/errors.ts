/**
 * 窗口内错误报告入口。只管理展示与有限诊断历史，不取消任务、不修改业务状态。
 * 每个 WebView 拥有独立实例；运行时可以报告错误而不依赖 React 或原生窗口。
 */
import { createStore } from "zustand/vanilla";

export type ErrorOptions = {
  error?: unknown;
  description?: string;
  source?: string;
};

export type ErrorReport = {
  id: string;
  title: string;
  source: string;
  details: string;
  timestamp: number;
  count: number;
  visible: boolean;
};

// 倒计时不是展示数据，只有到期收起时才通知订阅者。
const remainingById = new Map<string, number>();

export const errorStore = createStore<{
  reports: ErrorReport[];
  historyOpen: boolean;
}>(() => ({
  reports: [],
  historyOpen: false,
}));

/** 历史只属于当前窗口内存；清空不改变任何运行任务。 */
export function clearErrors(): void {
  remainingById.clear();
  errorStore.setState({ reports: [], historyOpen: false });
}

export function setErrorHistoryOpen(historyOpen: boolean): void {
  errorStore.setState({ historyOpen });
}

/** 提取有限的诊断字段，保留原因链和换行，不复制请求正文或任意业务对象。 */
export function errorDetails(value: unknown): string {
  const seen = new Set<object>();
  const extract = (input: unknown, depth: number): string => {
    if (depth > 5 || input == null) return "";
    if (typeof input === "string") return input;
    if (typeof input !== "object") return String(input);
    if (seen.has(input)) return "";
    seen.add(input);
    let values: unknown[];
    try {
      const { code, stack, message, cause, error } = input as Record<
        string,
        unknown
      >;
      // Error.stack 通常已包含类型与消息，避免复制内容重复三遍。
      values = [
        code,
        typeof stack === "string" ? stack : message,
        cause,
        error,
      ];
    } catch {
      // 外部错误对象可能带有抛错的 getter，报告失败不能再制造未处理异常。
      return "";
    }
    return values
      .map((field) => extract(field, depth + 1))
      .filter(Boolean)
      .join("\n");
  };
  return redactErrorText(extract(value, 0));
}

/** 展示和复制共用脱敏结果，限制单条记录体积。 */
export function redactErrorText(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(
      /\b(?:sk-(?:ant-|proj-)?|xai-|gsk_)[A-Za-z0-9_-]{8,}\b/g,
      "[redacted]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .slice(0, 16000)
    .trim();
}

/** 相同操作和原因在短时间内合并，已关闭的重复轮询错误不重新刷屏。 */
export function reportError(title: string, options: ErrorOptions = {}): string {
  const timestamp = Date.now();
  const safeTitle = redactErrorText(title);
  const source = redactErrorText(options.source ?? "");
  const details = [
    options.description && redactErrorText(options.description),
    errorDetails(options.error),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 16000);
  const reports = errorStore.getState().reports;
  const previous = reports.find(
    (report) =>
      report.title === safeTitle &&
      report.source === source &&
      report.details === details &&
      timestamp - report.timestamp < 10000,
  );
  const report: ErrorReport = {
    id: previous?.id ?? crypto.randomUUID(),
    title: safeTitle,
    source,
    details,
    timestamp,
    count: (previous?.count ?? 0) + 1,
    visible:
      previous?.visible ?? reports.filter((item) => item.visible).length < 3,
  };
  if (!previous && report.visible) remainingById.set(report.id, 8000);
  const next = [report, ...reports.filter((item) => item.id !== report.id)];
  let historySlots = 50 - next.filter((item) => item.visible).length;
  errorStore.setState({
    reports: next.filter((item) => item.visible || historySlots-- > 0),
  });
  return report.id;
}

/** 关闭仅收起提示；恢复动作和业务状态由调用方拥有。 */
export function dismissError(id: string): void {
  remainingById.delete(id);
  errorStore.setState(({ reports }) => ({
    reports: reports.map((report) =>
      report.id === id ? { ...report, visible: false } : report,
    ),
  }));
}

/** 只扣除用户实际可见且没有交互的时间，重挂载不会重新开始计时。 */
export function elapseErrors(
  milliseconds: number,
  paused: ReadonlySet<string>,
): void {
  const expired = new Set<string>();
  for (const [id, remaining] of remainingById) {
    if (paused.has(id)) continue;
    if (remaining > milliseconds)
      remainingById.set(id, remaining - milliseconds);
    else {
      remainingById.delete(id);
      expired.add(id);
    }
  }
  if (expired.size)
    errorStore.setState(({ reports }) => ({
      reports: reports.map((report) =>
        expired.has(report.id) ? { ...report, visible: false } : report,
      ),
    }));
}

export function copyableError(report: ErrorReport): string {
  return [
    new Date(report.timestamp).toISOString(),
    report.source,
    report.title,
    report.details,
  ]
    .filter(Boolean)
    .join("\n\n");
}
