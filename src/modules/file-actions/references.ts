/** Markdown 文件引用的规范化结果；文件状态在用户操作时查询。 */
export type FileReference = {
  path: string;
  line?: number;
  literalPath: string;
};

const FILE_REFERENCE_PROTOCOL = "terax-file";
const PREFIX = `${FILE_REFERENCE_PROTOCOL}:`;

/** 在既有 sanitizer 协议白名单中加入内部文件引用协议。 */
export function withFileReferenceProtocol<T>(
  protocols: T[] | undefined,
): Array<T | string> {
  return [...(protocols ?? []), FILE_REFERENCE_PROTOCOL];
}

function splitFileLine(value: string): { path: string; line?: number } | null {
  const match = /:([1-9]\d*)$/.exec(value);
  const line = match ? Number(match[1]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return null;
  return { path: match ? value.slice(0, match.index) : value, line };
}

export function parseFileReference(value: string): FileReference | null {
  if (
    (!(value.startsWith("/") && !value.startsWith("//")) &&
      !/^[a-z]:\//i.test(value)) ||
    /[\u0000-\u001f]/.test(value)
  )
    return null;
  const target = splitFileLine(value);
  if (!target) return null;
  return {
    path: target.path,
    line: target.line,
    literalPath: value,
  };
}

/** 相对文件引用按固定基准目录解析，结果统一为绝对正斜杠路径。 */
export function parseRelativeFileReference(
  baseDirectory: string,
  value: string,
): FileReference | null {
  const absolute = parseFileReference(value);
  if (absolute) return absolute;

  const source = value.split(/[?#]/, 1)[0];
  if (
    !source ||
    source.startsWith("/") ||
    source.startsWith("\\") ||
    /[\u0000-\u001f]/.test(source) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(source)
  ) {
    return null;
  }
  const target = splitFileLine(source);
  if (!target) return null;
  const normalizedBase = baseDirectory.replace(/\\/g, "/");
  if (!parseFileReference(normalizedBase)) return null;
  const path = joinNormalizedPath(
    normalizedBase,
    target.path.replace(/\\/g, "/"),
  );
  if (!parseFileReference(path)) return null;
  return {
    path,
    line: target.line,
    literalPath: target.line === undefined ? path : `${path}:${target.line}`,
  };
}

/** 返回文档所在目录，供 Markdown 与会话共用同一套相对引用解析。 */
export function fileReferenceBaseDirectory(
  documentPath: string,
): string | null {
  const normalizedDocument = documentPath.replace(/\\/g, "/");
  const separator = normalizedDocument.lastIndexOf("/");
  if (separator === 2 && /^[A-Za-z]:\//.test(normalizedDocument))
    return normalizedDocument.slice(0, 3);
  return separator < 0
    ? null
    : normalizedDocument.slice(0, Math.max(1, separator));
}

function joinNormalizedPath(baseDir: string, relative: string): string {
  const unc = baseDir.startsWith("//");
  const unixRoot = !unc && baseDir.startsWith("/");
  const output = baseDir.split("/").filter(Boolean);
  const minimumDepth = unc
    ? Math.min(2, output.length)
    : /^[A-Za-z]:$/.test(output[0] ?? "")
      ? 1
      : 0;

  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length > minimumDepth) output.pop();
      continue;
    }
    output.push(part);
  }
  const prefix = unc ? "//" : unixRoot ? "/" : "";
  return `${prefix}${output.join("/")}`;
}

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

/** 在 sanitizer 前封装路径，避免 Windows 盘符被作为未知协议删除。 */
export function rehypeFileReferences({
  baseDirectory,
}: {
  baseDirectory?: string;
} = {}) {
  return (tree: Node) => {
    const visit = (node: Node) => {
      const properties = node.properties;
      const href = properties?.href;
      if (node.tagName === "a" && properties && typeof href === "string") {
        // Markdown 解析器已对空格编码；只还原一次，再封装到内部协议。
        let decoded = href;
        try {
          decoded = decodeURIComponent(href);
        } catch {
          /* 合法文件名可以包含裸百分号。 */
        }
        const reference = baseDirectory
          ? parseRelativeFileReference(baseDirectory, decoded)
          : parseFileReference(decoded);
        if (reference)
          properties.href = PREFIX + encodeURIComponent(reference.literalPath);
        else if (href.startsWith(PREFIX)) delete properties.href;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function decodeFileReference(href: string): FileReference | null {
  if (!href.startsWith(PREFIX)) return null;
  try {
    return parseFileReference(decodeURIComponent(href.slice(PREFIX.length)));
  } catch {
    return null;
  }
}
