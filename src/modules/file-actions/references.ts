/** 解析 Markdown 文件引用；只处理绝对路径，文件状态在用户操作时查询。 */
export type FileReference = {
  path: string;
  line?: number;
  literalPath: string;
};

const PREFIX = "terax-file:";

export function parseFileReference(value: string): FileReference | null {
  if (
    (!(value.startsWith("/") && !value.startsWith("//")) &&
      !/^[a-z]:\//i.test(value)) ||
    /[\u0000-\u001f]/.test(value)
  )
    return null;
  const match = /:([1-9]\d*)$/.exec(value);
  const line = match ? Number(match[1]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return null;
  return {
    path: match ? value.slice(0, match.index) : value,
    line,
    literalPath: value,
  };
}

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

/** 在 sanitizer 前封装路径，避免 Windows 盘符被作为未知协议删除。 */
export function rehypeFileReferences() {
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
        if (parseFileReference(decoded))
          properties.href = PREFIX + encodeURIComponent(decoded);
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
