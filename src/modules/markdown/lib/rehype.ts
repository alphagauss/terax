/**
 * 本文件集中定义 Markdown 预览的 rehype 安全管线。
 *
 * 功能插件必须在 sanitizer 前运行，受控的源码定位属性在安全处理完成后添加。
 */

import {
  fileReferenceBaseDirectory,
  rehypeFileReferences,
  withFileReferenceProtocol,
} from "@/modules/file-actions/references";
import { IS_WINDOWS } from "@/lib/platform";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { rehypeMarkdownSourcePositions } from "@/modules/markdown/lib/anchor";
import { rehypeGithubAlerts } from "@/modules/markdown/lib/githubAlerts";
import { rehypeRelativeMarkdownImages } from "@/modules/markdown/lib/localImages";
import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins } from "streamdown";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

const [rehypeSanitize, defaultSanitizeSchema] =
  defaultRehypePlugins.sanitize as [
    unknown,
    {
      attributes?: Record<string, unknown[]>;
      protocols?: Record<string, unknown[]>;
    },
  ];

/** 仅开放 Alerts 所需的固定类名，不接受任意 Markdown class。 */
export const markdownSanitizeSchema = {
  ...defaultSanitizeSchema,
  protocols: {
    ...defaultSanitizeSchema.protocols,
    href: withFileReferenceProtocol(defaultSanitizeSchema.protocols?.href),
    src: [
      ...(defaultSanitizeSchema.protocols?.src ?? []),
      "terax-relative-image",
    ],
  },
  attributes: {
    ...defaultSanitizeSchema.attributes,
    div: [
      ...(defaultSanitizeSchema.attributes?.div ?? []),
      [
        "className",
        "markdown-alert",
        "markdown-alert-note",
        "markdown-alert-tip",
        "markdown-alert-important",
        "markdown-alert-warning",
        "markdown-alert-caution",
      ],
    ],
    p: [
      ...(defaultSanitizeSchema.attributes?.p ?? []),
      ["className", "markdown-alert-title"],
    ],
  },
};

/**
 * 为一个 Markdown 文档构造稳定的安全管线。
 *
 * 标题 slug 按内部标题 id 注入，保证渐进分块之间的重复标题仍然全局唯一。
 */
export function buildMarkdownRehypePlugins(
  headingSlugById: Record<string, string>,
  documentPath: string,
): RehypePlugins {
  const baseDirectory = fileReferenceBaseDirectory(documentPath) ?? undefined;
  const windowsLocal = IS_WINDOWS && currentWorkspaceEnv().kind === "local";
  return [
    defaultRehypePlugins.raw,
    [rehypeFileReferences, { baseDirectory, windowsLocal }],
    rehypeRelativeMarkdownImages,
    rehypeGithubAlerts,
    [rehypeSanitize, markdownSanitizeSchema],
    defaultRehypePlugins.harden,
    [rehypeMarkdownSourcePositions, { headingSlugById }],
  ] as RehypePlugins;
}
