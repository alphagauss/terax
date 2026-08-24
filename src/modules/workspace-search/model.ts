/**
 * 本文件实现工作区搜索的纯前端模型。
 * 负责解析筛选输入和按文件归组，不参与原生调用或 React 状态管理。
 */

import type { ContentSearchHit } from "./api";

export type ContentSearchGroup = {
  path: string;
  rel: string;
  hits: ContentSearchHit[];
};

/**
 * 解析逗号分隔的 glob，同时保留花括号和字符组内部的逗号。
 */
export function parseGlobInput(value: string): string[] {
  const patterns: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = false;

  const append = (end: number) => {
    const pattern = value.slice(start, end).trim();
    if (pattern) patterns.push(pattern);
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "{" && bracketDepth === 0) braceDepth += 1;
    else if (character === "}" && bracketDepth === 0 && braceDepth > 0)
      braceDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (character === "," && braceDepth === 0 && bracketDepth === 0) {
      append(index);
      start = index + 1;
    }
  }
  append(value.length);
  return patterns;
}

/** 将后端扁平结果转换为稳定的文件分组。 */
export function groupContentHits(
  hits: readonly ContentSearchHit[],
): ContentSearchGroup[] {
  const groups = new Map<string, ContentSearchGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.rel);
    if (!group) {
      group = { path: hit.path, rel: hit.rel, hits: [] };
      groups.set(hit.rel, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}
