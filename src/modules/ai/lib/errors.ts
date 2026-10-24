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
  if (toolInputError) return sanitizeErrorMessage(toolInputError);
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
  const issues = validationIssues(validation.cause);
  if (!issues.length) return null;
  const details = issues
    .slice(0, 3)
    .map((issue) => formatValidationIssue(issue, validation.value));
  const encodedStructure = issues.some(
    (issue) =>
      typeof valueAtPath(
        validation.value,
        Array.isArray(issue.path) ? issue.path : [],
      ) === "string" &&
      (issue.expected === "array" || issue.expected === "object"),
  );
  const hint = encodedStructure
    ? " Pass JSON arrays and objects directly, not as JSON-encoded strings."
    : toolInputHint(input.toolName, issues);
  return `Invalid input for tool ${input.toolName}: ${details.join("; ")}.${hint} Call the tool again with input that matches the schema. The tool was not executed.`;
}

function formatValidationIssue(issue: ValidationIssue, value: unknown): string {
  const path = Array.isArray(issue.path) ? issue.path : [];
  const actual = valueAtPath(value, path);
  let detail =
    issue.code === "invalid_type" && typeof issue.expected === "string"
      ? `${formatIssuePath(path)}: expected ${issue.expected}, received ${valueType(actual)}`
      : `${formatIssuePath(path)}: ${typeof issue.message === "string" ? issue.message : "invalid value"}`;
  const bound = issue.code === "too_big" ? issue.maximum : issue.minimum;
  if (
    (issue.code === "too_big" || issue.code === "too_small") &&
    issue.origin === "number" &&
    typeof bound === "number" &&
    typeof actual === "number"
  ) {
    const comparison = issue.code === "too_big" ? "<" : ">";
    detail = `${formatIssuePath(path)}: expected number ${comparison}${issue.inclusive ? "=" : ""} ${bound}, received ${actual}`;
  }
  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    detail = `${formatIssuePath(path)}: unexpected field(s) ${issue.keys
      .filter((key): key is string => typeof key === "string")
      .slice(0, 5)
      .map((key) => key.slice(0, 80))
      .join(", ")}`;
  }
  return detail;
}

function toolInputHint(toolName: string, issues: ValidationIssue[]): string {
  if (
    toolName === "apply_patch" &&
    issues.some(
      (issue) =>
        Array.isArray(issue.path) &&
        issue.path[issue.path.length - 1] === "expected_replacements",
    )
  ) {
    return " expected_replacements must be a positive integer matching the exact occurrence count. To replace multiple matches, also set replace_all=true.";
  }
  if (
    toolName === "apply_patch" &&
    issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" ||
        (issue.code === "invalid_type" &&
          Array.isArray(issue.path) &&
          (issue.path[0] === "files" ||
            (issue.path[0] === "edits" &&
              (issue.path.length <= 2 ||
                issue.path[issue.path.length - 1] === "path")))),
    )
  ) {
    return ' Put path, old_text, and new_text inside each edits[] entry. Example: {"edits":[{"path":"a.py","old_text":"old","new_text":"new"}]}.';
  }
  if (
    toolName === "write_file" &&
    issues.some(
      (issue) => Array.isArray(issue.path) && issue.path[0] === "mode",
    )
  ) {
    return ' Specify mode="create" for a missing target or mode="rewrite" for an existing file whose complete current content is known.';
  }
  return "";
}

/** 在 SDK 生成工具回执前压缩参数错误；返回 null 保持拒绝，不修复或执行输入。 */
export async function reportInvalidToolInput({
  error,
}: {
  error: Error;
}): Promise<null> {
  const message = formatInvalidToolInput(error);
  if (message) error.message = sanitizeErrorMessage(message);
  return null;
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

type ValidationIssue = {
  code?: unknown;
  origin?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  inclusive?: unknown;
  expected?: unknown;
  message?: unknown;
  path?: unknown;
  keys?: unknown;
};

function validationIssues(value: unknown): ValidationIssue[] {
  if (!value || typeof value !== "object") return [];
  const issues = (value as { issues?: unknown }).issues;
  return Array.isArray(issues)
    ? issues.filter((issue) => issue && typeof issue === "object")
    : [];
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
