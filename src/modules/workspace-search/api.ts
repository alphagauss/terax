/**
 * 本文件定义工作区内容搜索的前端公共调用边界。
 * 搜索面板与 AI grep 共用同一请求模型，不在此层持有查询状态或调用者安全策略。
 */

import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type ContentSearchSyntax = "literal" | "regex";
export type ContentSearchCaseMode = "sensitive" | "insensitive";

export type ContentSearchRange = {
  start: number;
  end: number;
};

export type ContentSearchHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
  ranges: ContentSearchRange[];
};

export type ContentSearchResponse = {
  hits: ContentSearchHit[];
  truncated: boolean;
  filesScanned: number;
};

export type ContentSearchInput = {
  root: string;
  pattern: string;
  syntax: ContentSearchSyntax;
  caseMode: ContentSearchCaseMode;
  wholeWord: boolean;
  includes?: string[];
  excludes?: string[];
  maxResults?: number;
  cancelPrevious?: boolean;
};

/** 调用统一原生引擎搜索工作区文件内容。 */
export function searchContent(
  input: ContentSearchInput,
): Promise<ContentSearchResponse> {
  return invoke<ContentSearchResponse>("fs_content_search", {
    request: {
      ...input,
      includes: input.includes ?? [],
      excludes: input.excludes ?? [],
      workspace: currentWorkspaceEnv(),
    },
  });
}

/** 通过同一原生命令取消搜索面板正在执行的扫描。 */
export function cancelContentSearch(root: string): Promise<void> {
  return searchContent({
    root,
    pattern: "",
    syntax: "literal",
    caseMode: "insensitive",
    wholeWord: false,
    cancelPrevious: true,
  }).then(() => undefined);
}
