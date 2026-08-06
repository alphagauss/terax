/**
 * 本文件定义资源管理器 Git 状态的文件名颜色。
 * 仅负责状态到主题语义色的映射，不绑定具体主题配色。
 */

import type { GitStatusCode } from "./gitStatusUtils";

/** 返回 Git 状态对应的主题语义文字颜色类。 */
export function explorerGitTextClass(code: GitStatusCode): string {
  switch (code) {
    case "M":
      return "text-git-modified";
    case "A":
      return "text-git-added";
    case "U":
      return "text-git-untracked";
    case "R":
      return "text-git-renamed";
    case "D":
      return "text-git-deleted";
  }
}
