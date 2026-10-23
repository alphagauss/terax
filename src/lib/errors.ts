/**
 * 窗口内错误报告入口。只管理展示与有限诊断历史，不取消任务、不修改业务状态。
 * 每个 WebView 拥有独立实例；运行时可以报告错误而不依赖 React 或原生窗口。
 */
import { createStore } from "zustand/vanilla";

export type ErrorOptions = {
  error?: unknown;
  description?: string;
  source?: string;
  /** 一次操作或任务运行的身份；不同身份不按相同文案合并。 */
  identity?: string;
  /** 主动查看原位详情时仅加入历史，不触发浮层。 */
  overlay?: boolean;
};

export type ErrorReport = {
  id: string;
  identity?: string;
  title: string;
  source: string;
  details: string;
  timestamp: number;
  count: number;
  visible: boolean;
};

// 倒计时不是展示数据，只有到期收起时才通知订阅者。
const remainingById = new Map<string, number>();

type ErrorNoticeState = "reported" | "dismissed";

export const errorStore = createStore<{
  reports: ErrorReport[];
  historyOpen: boolean;
  historyTarget: { id: string } | null;
  notices: ReadonlyMap<string, ErrorNoticeState>;
}>(() => ({
  reports: [],
  historyOpen: false,
  historyTarget: null,
  // 只保存窗口内的运行身份和关闭状态，不保存诊断；清空历史不能让旧提示复活。
  notices: new Map(),
}));

/** 历史只属于当前窗口内存；清空不改变任何运行任务。 */
export function clearErrors(): void {
  remainingById.clear();
  errorStore.setState({ reports: [], historyOpen: false, historyTarget: null });
}

export function setErrorHistoryOpen(
  historyOpen: boolean,
  targetId?: string,
): void {
  if (historyOpen) remainingById.clear();
  errorStore.setState(({ reports }) => ({
    historyOpen,
    // 每次主动查看都生成定位请求，即使目标未变也重新展开并滚动。
    historyTarget:
      historyOpen && targetId !== undefined ? { id: targetId } : null,
    ...(historyOpen && {
      reports: reports.map((report) =>
        report.visible ? { ...report, visible: false } : report,
      ),
    }),
  }));
}

/** 忽略只移除当前诊断记录；运行身份和原位错误继续由业务拥有。 */
export function ignoreError(id: string): void {
  remainingById.delete(id);
  errorStore.setState((state) => {
    const identity = state.reports.find((report) => report.id === id)?.identity;
    const reports = state.reports.filter((report) => report.id !== id);
    return {
      reports,
      historyOpen: state.historyOpen && reports.length > 0,
      historyTarget:
        state.historyTarget?.id === id ? null : state.historyTarget,
      ...(identity !== undefined &&
        !state.notices.has(identity) && {
          notices: new Map(state.notices).set(identity, "reported" as const),
        }),
    };
  });
}

function setNotice(identity: string, notice: ErrorNoticeState): void {
  errorStore.setState(({ notices }) => ({
    notices: new Map(notices).set(identity, notice),
  }));
}

/** 同一次失败只主动提醒一次，清空或淘汰历史后也不由轮询恢复。 */
export function reportErrorNotice(
  identity: string,
  title: string,
  options: ErrorOptions,
): void {
  const { notices, reports } = errorStore.getState();
  if (notices.has(identity)) return;
  if (!reports.some((report) => report.identity === identity))
    reportError(title, { ...options, identity });
  setNotice(identity, "reported");
}

/** 只隐藏本次提示并收起关联浮层，不修改业务错误，也不删除诊断。 */
export function dismissErrorNotice(identity: string): void {
  const { notices, reports } = errorStore.getState();
  const reportId = reports.find((report) => report.identity === identity)?.id;
  if (reportId) dismissError(reportId);
  if (notices.get(identity) !== "dismissed") setNotice(identity, "dismissed");
}

/** 恢复只收起已知的错误，不把尚未失败的运行提前标记为已关闭。 */
export function resolveErrorNotice(identity: string): void {
  const { notices, reports } = errorStore.getState();
  if (
    notices.has(identity) ||
    reports.some((report) => report.identity === identity)
  )
    dismissErrorNotice(identity);
}

/** 原位详情复用已有记录；缺失时仅恢复历史，不弹窗、不累计查看次数。 */
export function showErrorNoticeDetails(
  identity: string,
  title: string,
  options: ErrorOptions,
): void {
  const { notices, reports } = errorStore.getState();
  const notice = notices.get(identity);
  const reportId =
    reports.find((report) => report.identity === identity)?.id ??
    reportError(title, { ...options, identity, overlay: false });
  if (!notice) setNotice(identity, "reported");
  setErrorHistoryOpen(true, reportId);
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
  const { reports, historyOpen } = errorStore.getState();
  const previous = reports.find((report) =>
    options.identity !== undefined
      ? report.identity === options.identity
      : report.identity === undefined &&
        report.title === safeTitle &&
        report.source === source &&
        report.details === details &&
        timestamp - report.timestamp < 10000,
  );
  const report: ErrorReport = {
    id: previous?.id ?? crypto.randomUUID(),
    identity: options.identity,
    title: safeTitle,
    source,
    details,
    timestamp,
    count: (previous?.count ?? 0) + 1,
    visible:
      previous?.visible ??
      (options.overlay !== false &&
        !historyOpen &&
        reports.filter((item) => item.visible).length < 3),
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
