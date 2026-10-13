/**
 * 提取可读的会话错误并脱敏；启动恢复也使用本模块，不加载模型 SDK。
 * 工具参数错误按公开名称与字段识别，同样支持跨边界传递的普通对象。
 */

type ErrorDetails = {
  code: string | null;
  message: string;
};

const MAX_ERROR_LENGTH = 800;
const FALLBACK_ERROR =
  "The AI provider rejected the request. Check the selected model and provider settings, then try again.";

export function formatAiError(error: unknown): string {
  const toolInputError = formatInvalidToolInput(error);
  if (toolInputError) return toolInputError;
  const details = extractErrorDetails(error);
  if (!details) return FALLBACK_ERROR;
  const message = sanitizeErrorMessage(details.message);
  if (!message) return FALLBACK_ERROR;
  const prefix = errorPrefix(details.code, message);
  return prefix ? `${prefix}: ${message}` : message;
}

/** 压缩工具 schema 错误，避免长参数正文遮蔽真正的字段问题。 */
function formatInvalidToolInput(error: unknown): string | null {
  const input = errorRecord(error);
  if (
    input?.name !== "AI_InvalidToolInputError" ||
    typeof input.toolName !== "string"
  )
    return null;
  const validation = errorRecord(input.cause);
  if (validation?.name === "AI_JSONParseError") {
    const cause = errorRecord(validation.cause);
    const position =
      typeof cause?.message === "string"
        ? cause.message.match(/\bposition \d+/)?.[0]
        : undefined;
    return `Invalid input for tool ${input.toolName}: input is not valid JSON${position ? ` at ${position}` : ""}. Call the tool again with complete JSON matching the schema. The tool was not executed.`;
  }
  if (validation?.name !== "AI_TypeValidationError" || !("value" in validation))
    return null;
  const issue = firstValidationIssue(validation.cause);
  if (!issue) return null;
  const path = Array.isArray(issue.path) ? issue.path : [];
  const actual = valueAtPath(validation.value, path);
  const detail =
    issue.code === "invalid_type" && typeof issue.expected === "string"
      ? `${formatIssuePath(path)}: expected ${issue.expected}, received ${valueType(actual)}`
      : `${formatIssuePath(path)}: ${typeof issue.message === "string" ? issue.message : "invalid value"}`;
  const encodedStructure =
    typeof actual === "string" &&
    (issue.expected === "array" || issue.expected === "object");
  const retryHint = encodedStructure
    ? " Pass JSON arrays and objects directly, not as JSON-encoded strings."
    : "";
  return `Invalid input for tool ${input.toolName}: ${detail}.${retryHint} Call the tool again with input that matches the schema. The tool was not executed.`;
}

/** 在 SDK 生成工具回执前压缩参数错误；返回 null 保持拒绝，不修复或执行输入。 */
export async function reportInvalidToolInput({
  error,
}: {
  error: Error;
}): Promise<null> {
  const message = formatInvalidToolInput(error);
  if (message) error.message = message;
  return null;
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

type ValidationIssue = {
  code?: unknown;
  expected?: unknown;
  message?: unknown;
  path?: unknown;
};

function firstValidationIssue(value: unknown): ValidationIssue | null {
  if (!value || typeof value !== "object") return null;
  const issues = (value as { issues?: unknown }).issues;
  const issue = Array.isArray(issues) ? issues[0] : undefined;
  return issue && typeof issue === "object" ? issue : null;
}

function formatIssuePath(path: unknown[]): string {
  if (!path.length) return "input";
  return path
    .map((part, index) =>
      typeof part === "number"
        ? `[${part}]`
        : `${index === 0 ? "" : "."}${part}`,
    )
    .join("");
}

function valueAtPath(value: unknown, path: unknown[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part !== "string" && typeof part !== "number") return undefined;
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function extractErrorDetails(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): ErrorDetails | null {
  if (depth > 5 || value == null || seen.has(value)) return null;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== null) return extractErrorDetails(parsed, depth + 1, seen);
    return { code: null, message: value };
  }
  if (typeof value !== "object") return null;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const code = stringValue(record.code);
  for (const key of ["error", "responseBody", "body", "data", "cause"]) {
    const nested = extractErrorDetails(record[key], depth + 1, seen);
    if (nested) return { code: nested.code ?? code, message: nested.message };
  }
  const message = stringValue(record.message);
  return message ? { code, message } : null;
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sanitizeErrorMessage(message: string): string {
  const redacted = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk-(?:ant-|proj-)?|xai-|gsk_)[A-Za-z0-9_-]{8,}\b/g,
      "[redacted]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= MAX_ERROR_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}

function errorPrefix(code: string | null, message: string): string | null {
  switch (code?.toLowerCase()) {
    case "model_not_found":
    case "not_found_error":
      return "Model unavailable";
    case "invalid_api_key":
    case "authentication_error":
      return "Authentication failed";
    case "insufficient_quota":
      return "Quota exceeded";
    case "rate_limit_exceeded":
    case "rate_limit_error":
      return "Rate limit reached";
  }
  return /\bmodel\b.*\b(?:limited preview|not available|not found)\b/i.test(
    message,
  )
    ? "Model unavailable"
    : null;
}
