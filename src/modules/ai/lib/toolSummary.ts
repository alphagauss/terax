/**
 * 本文件统一工具调用的有界展示摘要。
 * 摘要只保留操作标记和脱敏对象，翻译在 UI 中完成，不进入模型请求或保存完整参数。
 */

import type { TFunction } from "i18next";
import { redactSensitive } from "@/modules/ai/lib/redact";

const LABELS = [
  "list",
  "recursive",
  "hidden",
  "directories",
  "filesOnly",
  "create",
  "rewrite",
  "move",
  "copy",
  "delete",
  "deleteRecursive",
  "createDirectory",
  "poll",
  "writeInput",
  "closeStdin",
  "terminate",
  "exited",
  "literal",
  "files",
  "counts",
  "caseInsensitive",
  "wait",
  "background",
  "send",
  "moreFiles",
  "moreAttachments",
  "attachments",
  "lines",
  "lineRange",
  "fromLine",
] as const;

type SummaryLabel = (typeof LABELS)[number];
export type ToolSummary = Array<
  string | { label: SummaryLabel; values?: Record<string, number> }
>;
const SUMMARY_LIMIT = 160;

/** 从已知参数提取摘要；流式未完成时不推断省略参数的默认值。 */
export function describeToolCall(
  toolName: string,
  input: unknown,
  complete = true,
): ToolSummary {
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : "";
  const number = (key: string) =>
    typeof value[key] === "number" &&
    Number.isSafeInteger(value[key]) &&
    value[key] > 0
      ? (value[key] as number)
      : undefined;
  const parts: ToolSummary = [];
  const label = (name: SummaryLabel, values?: Record<string, number>) => {
    parts.push(values ? { label: name, values } : { label: name });
  };
  switch (toolName) {
    case "read_file": {
      parts.push(text("path"));
      const start = number("start_line");
      const count = number("line_count");
      const end = (start ?? 1) + ((count ?? 1) - 1);
      if (
        count !== undefined &&
        Number.isSafeInteger(end) &&
        (start !== undefined || complete)
      ) {
        label("lineRange", {
          start: start ?? 1,
          end,
        });
      } else if (start !== undefined) {
        label("fromLine", { start });
      }
      break;
    }
    case "find_files":
      if (
        typeof value.recursive === "boolean" ||
        (complete && value.recursive === undefined)
      )
        label(value.recursive === true ? "recursive" : "list");
      parts.push(text("path") || (complete ? "." : ""), text("glob"));
      if (value.include_hidden === true) label("hidden");
      if (value.include_directories === true && value.recursive === true)
        label("directories");
      if (
        value.include_directories === false &&
        (value.recursive === false ||
          (complete && value.recursive === undefined))
      )
        label("filesOnly");
      break;
    case "grep":
      if (value.syntax === "literal") label("literal");
      if (value.output === "files") label("files");
      if (value.output === "count") label("counts");
      parts.push(text("pattern"), text("path") || (complete ? "." : ""));
      if (Array.isArray(value.include))
        parts.push(
          value.include
            .filter((item): item is string => typeof item === "string")
            .slice(0, 3)
            .join(", "),
        );
      if (value.case_insensitive === true) label("caseInsensitive");
      break;
    case "write_file":
      if (
        value.mode === "create" ||
        value.mode === "rewrite" ||
        (complete && value.mode === undefined)
      )
        label(value.mode === "rewrite" ? "rewrite" : "create");
      parts.push(text("path"));
      break;
    case "apply_patch": {
      const files = Array.isArray(value.files) ? value.files : [];
      const first = files.find(
        (file) =>
          file && typeof file === "object" && typeof file.path === "string",
      );
      if (first) parts.push(first.path);
      if (files.length > 1) label("moreFiles", { count: files.length - 1 });
      break;
    }
    case "file_operation": {
      const operation = text("operation");
      if (operation === "move" || operation === "copy") label(operation);
      if (operation === "delete")
        label(value.recursive === true ? "deleteRecursive" : "delete");
      if (operation === "create_directory") label("createDirectory");
      const path = text("path");
      const destination = text("destination");
      parts.push(
        path && destination ? `${path} → ${destination}` : path || destination,
      );
      break;
    }
    case "shell_exec":
      parts.push(text("command"), text("cwd"));
      if (text("shell") !== "default") parts.push(text("shell"));
      break;
    case "shell_process": {
      const action = text("action");
      if (action === "poll" || action === "terminate") label(action);
      if (action === "write") label("writeInput");
      if (action === "close_stdin") label("closeStdin");
      if (value.action === "write" && value.close_stdin === true)
        label("closeStdin");
      parts.push(text("process_id"));
      break;
    }
    case "shell_list":
      if (value.include_exited === true) label("exited");
      break;
    case "get_terminal_output":
      if (number("lines") !== undefined || complete)
        label("lines", { count: number("lines") ?? 80 });
      break;
    case "run_subagent":
      if (
        typeof value.wait === "boolean" ||
        (complete && value.wait === undefined)
      )
        label(value.wait === true ? "wait" : "background");
      parts.push(text("label") || text("task"));
      break;
    case "message": {
      label("send");
      const attachments = Array.isArray(value.attachments)
        ? value.attachments
        : [];
      if (attachments.length) {
        label("attachments");
        if (typeof attachments[0]?.path === "string")
          parts.push(attachments[0].path);
        if (attachments.length > 1)
          label("moreAttachments", { count: attachments.length - 1 });
      } else {
        parts.push(text("text"));
      }
      break;
    }
  }
  // 只处理对象的短前缀，避免文件正文或长命令拖慢流式标题。
  const normalized = parts
    .map((part) =>
      typeof part === "string"
        ? redactSensitive(part.slice(0, 1024)).replace(/\s+/g, " ").trim()
        : part,
    )
    .filter((part) => part !== "");
  const textCount = normalized.filter(
    (part) => typeof part === "string",
  ).length;
  const limit = Math.floor(SUMMARY_LIMIT / Math.max(1, textCount));
  return normalized.map((part) =>
    typeof part === "string" ? shorten(part, limit) : part,
  );
}

/** 用当前界面语言格式化原始摘要标记，各展示入口共用同一顺序和长度限制。 */
export function formatToolSummary(
  summary: ToolSummary | undefined,
  t: TFunction<"ai">,
): string {
  const parts = summary ?? [];
  const labels = parts.map((part) =>
    typeof part === "string"
      ? ""
      : t(`chat.toolSummary.${part.label}`, part.values),
  );
  const textCount = parts.filter((part) => typeof part === "string").length;
  // 为操作说明预留空间，长路径和命令不能挤掉递归删除等关键语义。
  const limit = Math.max(
    1,
    Math.floor(
      (SUMMARY_LIMIT -
        labels.join("").length -
        Math.max(0, parts.length - 1) * 3) /
        Math.max(1, textCount),
    ),
  );
  const text = parts
    .map((part, index) =>
      typeof part === "string" ? shorten(part, limit) : labels[index],
    )
    .join(" · ");
  return shorten(text, SUMMARY_LIMIT);
}

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 校验持久化展示摘要，拒绝正文、额外字段和无界数据。 */
export function isToolSummary(value: unknown): value is ToolSummary {
  if (!Array.isArray(value) || value.length > 8) return false;
  let textLength = 0;
  return value.every((part) => {
    if (typeof part === "string") {
      textLength += part.length;
      return textLength <= SUMMARY_LIMIT;
    }
    if (
      !part ||
      typeof part !== "object" ||
      !LABELS.includes(part.label) ||
      Object.keys(part).some((key) => key !== "label" && key !== "values")
    )
      return false;
    const keys =
      part.label === "lineRange"
        ? ["start", "end"]
        : part.label === "fromLine"
          ? ["start"]
          : ["moreFiles", "moreAttachments", "lines"].includes(part.label)
            ? ["count"]
            : [];
    if (keys.length === 0) return part.values === undefined;
    return Boolean(
      part.values &&
        typeof part.values === "object" &&
        !Array.isArray(part.values) &&
        Object.keys(part.values).length === keys.length &&
        keys.every(
          (key) =>
            typeof part.values[key] === "number" &&
            Number.isSafeInteger(part.values[key]) &&
            part.values[key] > 0,
        ),
    );
  });
}
