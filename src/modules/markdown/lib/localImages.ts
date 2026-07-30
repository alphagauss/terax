/**
 * 本文件处理 Markdown 相对图片路径。
 *
 * 解析阶段只写入内部协议，实际文件访问由接近视口的图片组件按工作区环境执行。
 */

const INTERNAL_IMAGE_PREFIX = "terax-relative-image:";
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const PROTECTED_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
]);

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** 判断图片 URL 是否需要相对当前 Markdown 文档解析。 */
export function isRelativeMarkdownImageSource(src: string): boolean {
  if (
    !src ||
    src.startsWith("/") ||
    src.startsWith("\\") ||
    src.startsWith("#")
  ) {
    return false;
  }
  return !/^[A-Za-z][A-Za-z\d+.-]*:/.test(src);
}

/** 将相对图片 URL 编码为只在 Markdown 渲染器内部识别的协议。 */
export function encodeRelativeMarkdownImage(src: string): string {
  return `${INTERNAL_IMAGE_PREFIX}${encodeURIComponent(src)}`;
}

/** 从内部协议还原原始相对图片 URL。 */
export function decodeRelativeMarkdownImage(src: string): string | null {
  if (!src.startsWith(INTERNAL_IMAGE_PREFIX)) return null;
  try {
    return decodeURIComponent(src.slice(INTERNAL_IMAGE_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * 相对 Markdown 文件目录解析图片路径。
 *
 * 只接受常见图片扩展，并拒绝敏感目录和文件名；返回路径统一使用正斜杠。
 */
export function resolveMarkdownImagePath(
  documentPath: string,
  relativeSource: string,
): string | null {
  const source = relativeSource.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    return null;
  }
  if (
    !isRelativeMarkdownImageSource(decoded) ||
    /[\u0000-\u001f]/.test(decoded)
  ) {
    return null;
  }

  const normalizedDocument = documentPath.replace(/\\/g, "/");
  const separator = normalizedDocument.lastIndexOf("/");
  const baseDir =
    separator < 0 ? "" : normalizedDocument.slice(0, Math.max(1, separator));
  const joined = joinNormalizedPath(baseDir, decoded.replace(/\\/g, "/"));
  const segments = joined.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";
  const extension = basename.includes(".")
    ? (basename.split(".").pop()?.toLowerCase() ?? "")
    : "";
  if (
    !IMAGE_EXTENSIONS.has(extension) ||
    /^\.env(?:\.|$)/i.test(basename) ||
    segments.some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))
  ) {
    return null;
  }
  return joined;
}

/**
 * 将相对图片节点改写为 sanitizer 可审计的内部协议。
 *
 * picture 的 source 无法经过 React 图片组件控制，因此移除其候选源并使用 img 回退。
 */
export function rehypeRelativeMarkdownImages() {
  return (tree: unknown) => visitImages(tree as HastNode, false);
}

function visitImages(node: HastNode, insidePicture: boolean): void {
  const picture =
    insidePicture || (node.type === "element" && node.tagName === "picture");
  if (picture && node.type === "element" && node.tagName === "source") {
    const properties = { ...node.properties };
    delete properties.src;
    delete properties.srcSet;
    delete properties.srcset;
    node.properties = properties;
  }
  if (node.type === "element" && node.tagName === "img") {
    const src = node.properties?.src;
    if (typeof src === "string" && isRelativeMarkdownImageSource(src)) {
      const properties: Record<string, unknown> = {
        ...node.properties,
        src: encodeRelativeMarkdownImage(src),
      };
      delete properties.srcSet;
      node.properties = properties;
    }
  }
  for (const child of node.children ?? []) visitImages(child, picture);
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
